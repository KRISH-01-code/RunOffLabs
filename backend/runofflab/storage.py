"""SQLite persistence for projects.

Each project is stored whole, as the JSON of the `Project` model, so the
saved file and the API body are the same document. A `version` counter
supports optimistic concurrency: a save must name the version it was based
on, so two browser tabs editing one project cannot silently overwrite each
other.
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from pydantic import BaseModel

from runofflab.models.project import Project

SCHEMA_VERSION = 1
DEFAULT_DB = "runofflab.db"  # relative to the working directory; override with RUNOFFLAB_DB


class ProjectSummary(BaseModel):
    id: str
    name: str
    design_count: int
    version: int
    created_at: str
    updated_at: str


class SavedProject(BaseModel):
    project: Project
    version: int
    created_at: str
    updated_at: str


class ProjectNotFound(KeyError):
    pass


class ProjectExists(ValueError):
    pass


class VersionConflict(ValueError):
    """The stored project changed since the version the caller started from."""

    def __init__(self, current_version: int):
        super().__init__(f"project is at version {current_version}")
        self.current_version = current_version


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class ProjectStore:
    def __init__(self, path: str | Path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._migrate()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        # A short-lived connection per operation keeps this safe to call from
        # FastAPI's worker threads.
        with closing(sqlite3.connect(self.path, timeout=10)) as conn:
            conn.row_factory = sqlite3.Row
            with conn:  # commits on success, rolls back on error
                yield conn

    def _migrate(self) -> None:
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            current = conn.execute("PRAGMA user_version").fetchone()[0]
            if current > SCHEMA_VERSION:
                raise RuntimeError(f"{self.path} was written by a newer RunoffLab (schema {current}).")
            if current < 1:
                conn.execute("""
                    CREATE TABLE projects (
                        id           TEXT PRIMARY KEY,
                        name         TEXT NOT NULL,
                        data         TEXT NOT NULL,
                        design_count INTEGER NOT NULL,
                        version      INTEGER NOT NULL,
                        created_at   TEXT NOT NULL,
                        updated_at   TEXT NOT NULL
                    )""")
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def list(self) -> list[ProjectSummary]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, name, design_count, version, created_at, updated_at "
                "FROM projects ORDER BY updated_at DESC, name").fetchall()
        return [ProjectSummary(**dict(r)) for r in rows]

    def get(self, project_id: str) -> SavedProject:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if row is None:
            raise ProjectNotFound(project_id)
        return SavedProject(project=Project.model_validate_json(row["data"]), version=row["version"],
                            created_at=row["created_at"], updated_at=row["updated_at"])

    def create(self, project: Project) -> SavedProject:
        now = _now()
        try:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO projects (id, name, data, design_count, version, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, 1, ?, ?)",
                    (project.id, project.name, project.model_dump_json(), len(project.designs), now, now))
        except sqlite3.IntegrityError:
            raise ProjectExists(project.id) from None
        return SavedProject(project=project, version=1, created_at=now, updated_at=now)

    def save(self, project: Project, base_version: int) -> SavedProject:
        now = _now()
        with self._connect() as conn:
            row = conn.execute("SELECT version, created_at FROM projects WHERE id = ?",
                               (project.id,)).fetchone()
            if row is None:
                raise ProjectNotFound(project.id)
            if row["version"] != base_version:
                raise VersionConflict(row["version"])
            version = base_version + 1
            updated = conn.execute(
                "UPDATE projects SET name = ?, data = ?, design_count = ?, version = ?, updated_at = ? "
                "WHERE id = ? AND version = ?",
                (project.name, project.model_dump_json(), len(project.designs), version, now,
                 project.id, base_version)).rowcount
            if updated == 0:  # another writer got in between the read and the update
                raise VersionConflict(base_version + 1)
        return SavedProject(project=project, version=version, created_at=row["created_at"], updated_at=now)

    def delete(self, project_id: str) -> None:
        with self._connect() as conn:
            if conn.execute("DELETE FROM projects WHERE id = ?", (project_id,)).rowcount == 0:
                raise ProjectNotFound(project_id)


_store: ProjectStore | None = None


def get_store() -> ProjectStore:
    """The process-wide store (a FastAPI dependency, overridden in tests)."""
    global _store
    if _store is None:
        _store = ProjectStore(os.environ.get("RUNOFFLAB_DB", DEFAULT_DB))
    return _store
