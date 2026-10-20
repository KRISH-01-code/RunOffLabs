import sqlite3

import pytest
from fastapi.testclient import TestClient

from runofflab.api.app import app
from runofflab.storage import (
    SCHEMA_VERSION,
    ProjectExists,
    ProjectNotFound,
    ProjectStore,
    VersionConflict,
    get_store,
)


@pytest.fixture
def store(tmp_path) -> ProjectStore:
    return ProjectStore(tmp_path / "projects.db")


@pytest.fixture
def client(store):
    app.dependency_overrides[get_store] = lambda: store
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_create_get_round_trips_the_whole_project(store, project):
    saved = store.create(project)
    assert saved.version == 1
    loaded = store.get(project.id)
    assert loaded.project == project and loaded.version == 1


def test_save_bumps_version_and_rejects_stale_base(store, project):
    store.create(project)
    renamed = project.model_copy(update={"name": "Renamed"})
    assert store.save(renamed, base_version=1).version == 2
    with pytest.raises(VersionConflict) as exc:
        store.save(project, base_version=1)
    assert exc.value.current_version == 2
    assert store.get(project.id).project.name == "Renamed"


def test_duplicate_ids_and_missing_projects(store, project):
    store.create(project)
    with pytest.raises(ProjectExists):
        store.create(project)
    with pytest.raises(ProjectNotFound):
        store.get("nope")
    with pytest.raises(ProjectNotFound):
        store.save(project.model_copy(update={"id": "nope"}), base_version=1)
    store.delete(project.id)
    with pytest.raises(ProjectNotFound):
        store.delete(project.id)


def test_list_is_most_recent_first_with_design_counts(store, project):
    store.create(project)
    store.create(project.model_copy(update={"id": "second", "name": "Second", "designs": []}))
    store.save(project.model_copy(update={"name": "Touched"}), base_version=1)
    summaries = store.list()
    assert {s.id for s in summaries} == {project.id, "second"}
    first = next(s for s in summaries if s.id == project.id)
    assert first.design_count == 1 and first.version == 2 and first.name == "Touched"


def test_data_survives_reopening_and_schema_is_versioned(tmp_path, project):
    path = tmp_path / "projects.db"
    ProjectStore(path).create(project)
    assert ProjectStore(path).get(project.id).project == project
    with sqlite3.connect(path) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION


def test_project_endpoints_full_lifecycle(client):
    sample = client.get("/api/sample").json()
    assert client.get("/api/projects").json() == []

    r = client.post("/api/projects", json=sample)
    assert r.status_code == 201 and r.json()["version"] == 1
    assert client.post("/api/projects", json=sample).status_code == 409

    sample["name"] = "Edited"
    r = client.put(f"/api/projects/{sample['id']}", json={"project": sample, "base_version": 1})
    assert r.status_code == 200 and r.json()["version"] == 2
    stale = client.put(f"/api/projects/{sample['id']}", json={"project": sample, "base_version": 1})
    assert stale.status_code == 409 and stale.json()["detail"]["current_version"] == 2

    listed = client.get("/api/projects").json()
    assert [p["name"] for p in listed] == ["Edited"]
    assert client.get(f"/api/projects/{sample['id']}").json()["project"]["name"] == "Edited"

    assert client.delete(f"/api/projects/{sample['id']}").status_code == 204
    assert client.get(f"/api/projects/{sample['id']}").status_code == 404


def test_save_rejects_id_change_and_invalid_schema(client):
    sample = client.get("/api/sample").json()
    client.post("/api/projects", json=sample)
    moved = {**sample, "id": "other"}
    assert client.put(f"/api/projects/{sample['id']}", json={"project": moved, "base_version": 1}).status_code == 422
    sample["site"]["surfaces"][0]["rect"]["width"] = -5
    assert client.put(f"/api/projects/{sample['id']}", json={"project": sample, "base_version": 1}).status_code == 422


def test_infeasible_drafts_can_still_be_saved(client):
    sample = client.get("/api/sample").json()
    sample["constraints"]["budget"] = 10  # the design now breaks the budget
    assert client.post("/api/projects", json=sample).status_code == 201
