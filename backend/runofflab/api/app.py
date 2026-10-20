"""FastAPI application exposing validation, simulation and reference data.

Run locally with:  uvicorn runofflab.api.app:app --reload
"""

from __future__ import annotations

from dataclasses import asdict

from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from runofflab import optimize, report, whatif
from runofflab.engine import lid_params
from runofflab.engine import longterm
from runofflab.engine.runner import SimulationError, engine_info
from runofflab.engine.simulate import InvalidDesignError, simulate
from runofflab.hydrology import longterm as rainfall_longterm
from runofflab.hydrology import quality
from runofflab.hydrology.longterm import RainRecord
from runofflab.hydrology.rainfall import RAINFALL_REFERENCES
from runofflab.hydrology.soils import SOIL_REFERENCE, SOILS
from runofflab.hydrology.surfaces import SURFACE_DEFAULTS
from runofflab.models.project import Design, Project, Scenario
from runofflab.models.results import EngineInfo, LongTermResult, SimulationResult
from runofflab.sample import load_sample_project
from runofflab.storage import (
    ProjectExists,
    ProjectNotFound,
    ProjectStore,
    ProjectSummary,
    SavedProject,
    VersionConflict,
    get_store,
)
from runofflab.validation import Issue, check_design, validate_site

app = FastAPI(title="RunoffLab API", version=engine_info().runofflab_version)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["*"],
    allow_headers=["*"],
)


class ValidateRequest(BaseModel):
    project: Project
    design: Design | None = None


class ValidateResponse(BaseModel):
    feasible: bool
    issues: list[Issue]
    cost: float
    rain_garden_area_m2: float
    permeable_pavement_area_m2: float
    area_by_kind: dict[str, float] = {}  # footprint m² for every intervention kind in the design


class SaveRequest(BaseModel):
    project: Project
    base_version: int  # the version this edit started from


class SimulateRequest(BaseModel):
    project: Project
    design: Design | None = None  # None = baseline
    scenario: Scenario | None = None  # None = project.scenario


@app.get("/api/health", response_model=EngineInfo)
def health() -> EngineInfo:
    return engine_info()


@app.get("/api/sample", response_model=Project)
def sample() -> Project:
    return load_sample_project()


@app.get("/api/reference")
def reference() -> dict:
    """Every built-in assumption, with sources, for the UI's assumptions panel."""
    return {
        "soils": {k.value: {**asdict(v), "initial_moisture_deficit": v.initial_moisture_deficit}
                  for k, v in SOILS.items()},
        "soil_reference": SOIL_REFERENCE,
        "surfaces": {k.value: asdict(v) for k, v in SURFACE_DEFAULTS.items()},
        "rainfall_references": {k.value: v for k, v in RAINFALL_REFERENCES.items()},
        "lid_parameters": {k: v for k, v in vars(lid_params).items() if k.isupper()},
        "quality": {
            "pollutants": [asdict(p) for p in quality.POLLUTANTS],
            "emc_mg_l": {k.value: v for k, v in quality.EMC_MG_L.items()},
            "drain_removal_pct": quality.DRAIN_REMOVAL_PCT,
            "tss_target_pct": quality.TSS_TARGET_PCT,
            "reference": quality.QUALITY_REFERENCE,
        },
    }


@app.post("/api/validate", response_model=ValidateResponse)
def validate(req: ValidateRequest) -> ValidateResponse:
    issues = validate_site(req.project.site)
    design = req.design or Design(id="baseline", name="Baseline")
    check = check_design(req.project.site, design, req.project.costs, req.project.constraints)
    issues += check.issues
    return ValidateResponse(
        feasible=not any(i.severity == "error" for i in issues), issues=issues,
        cost=round(check.cost, 2), rain_garden_area_m2=round(check.rain_garden_area_m2, 2),
        permeable_pavement_area_m2=round(check.permeable_pavement_area_m2, 2),
        area_by_kind={k: round(v, 2) for k, v in check.area_by_kind.items()})


class LongTermRequest(BaseModel):
    project: Project
    design: Design | None = None
    include_baseline: bool = True  # False when comparing designs that share one baseline run


class LongTermResponse(BaseModel):
    baseline: LongTermResult | None
    proposed: LongTermResult | None


@app.post("/api/longterm", response_model=LongTermResponse)
def run_long_term(req: LongTermRequest) -> LongTermResponse:
    """Simulate the baseline and (optionally) a design over the project's year of rainfall."""
    try:
        record = req.project.long_term.rainfall()
        baseline = longterm.simulate_period(req.project, None, record) if req.include_baseline else None
        proposed = longterm.simulate_period(req.project, req.design, record) if req.design else None
    except InvalidDesignError as exc:
        raise HTTPException(422, {"kind": "invalid_design", "issues": [i.model_dump() for i in exc.issues]})
    except ValueError as exc:
        raise HTTPException(422, {"kind": "no_rainfall", "message": str(exc)})
    except SimulationError as exc:
        raise HTTPException(500, {"kind": "engine_error", "message": str(exc), "details": exc.details})
    return LongTermResponse(baseline=baseline, proposed=proposed)


class RainfallParseRequest(BaseModel):
    text: str = Field(max_length=20_000_000)
    units: str = "mm"
    name: str = "Imported rainfall"


@app.post("/api/rainfall/parse", response_model=RainRecord)
def parse_rainfall(req: RainfallParseRequest) -> RainRecord:
    """Turn a time,value CSV into an hourly record the project can store."""
    try:
        return rainfall_longterm.parse_csv(req.text, req.units, req.name)
    except rainfall_longterm.RainfallParseError as exc:
        raise HTTPException(422, {"kind": "bad_rainfall", "message": str(exc)})


@app.post("/api/simulate", response_model=SimulationResult)
def run_simulation(req: SimulateRequest) -> SimulationResult:
    try:
        return simulate(req.project, req.design, req.scenario)
    except InvalidDesignError as exc:
        raise HTTPException(422, {"kind": "invalid_design",
                                  "issues": [i.model_dump() for i in exc.issues]})
    except SimulationError as exc:
        raise HTTPException(500, {"kind": "engine_error", "message": str(exc),
                                  "details": exc.details})


# ── Saved projects ──────────────────────────────────────────────────────────
# Drafts are saved as-is: a project may hold designs that break constraints,
# since validation runs before simulation, not before saving.

def _not_found(project_id: str) -> HTTPException:
    return HTTPException(404, {"kind": "not_found", "message": f"No saved project '{project_id}'."})


@app.get("/api/projects", response_model=list[ProjectSummary])
def list_projects(store: ProjectStore = Depends(get_store)) -> list[ProjectSummary]:
    return store.list()


@app.post("/api/projects", response_model=SavedProject, status_code=201)
def create_project(project: Project, store: ProjectStore = Depends(get_store)) -> SavedProject:
    try:
        return store.create(project)
    except ProjectExists:
        raise HTTPException(409, {"kind": "exists", "message": f"A project with id '{project.id}' already exists."})


@app.get("/api/projects/{project_id}", response_model=SavedProject)
def get_project(project_id: str, store: ProjectStore = Depends(get_store)) -> SavedProject:
    try:
        return store.get(project_id)
    except ProjectNotFound:
        raise _not_found(project_id)


@app.put("/api/projects/{project_id}", response_model=SavedProject)
def save_project(project_id: str, req: SaveRequest, store: ProjectStore = Depends(get_store)) -> SavedProject:
    if req.project.id != project_id:
        raise HTTPException(422, {"kind": "id_mismatch", "message": "The project id can't be changed."})
    try:
        return store.save(req.project, req.base_version)
    except ProjectNotFound:
        raise _not_found(project_id)
    except VersionConflict as exc:
        raise HTTPException(409, {"kind": "version_conflict", "current_version": exc.current_version,
                                  "message": "This project was changed somewhere else since you opened it."})


@app.delete("/api/projects/{project_id}", status_code=204)
def delete_project(project_id: str, store: ProjectStore = Depends(get_store)) -> Response:
    try:
        store.delete(project_id)
    except ProjectNotFound:
        raise _not_found(project_id)
    return Response(status_code=204)


# ── Design Explorer ─────────────────────────────────────────────────────────

class ExploreStarted(BaseModel):
    job_id: str
    workers: int


@app.post("/api/explore", response_model=ExploreStarted, status_code=202)
def start_explore(req: optimize.ExploreRequest) -> ExploreStarted:
    site_errors = [i for i in validate_site(req.project.site) if i.severity == "error"]
    if site_errors:
        raise HTTPException(422, {"kind": "invalid_design", "issues": [i.model_dump() for i in site_errors]})
    if not (req.rain_gardens or req.permeable_pavement or req.green_roofs):
        raise HTTPException(422, {"kind": "nothing_to_explore", "message": "Choose at least one intervention type."})
    job = optimize.start(req)
    return ExploreStarted(job_id=job.id, workers=optimize.worker_count())


@app.get("/api/explore/{job_id}", response_model=optimize.ExploreStatus)
def explore_status(job_id: str, since: int = 0) -> optimize.ExploreStatus:
    """Progress so far. `since` skips points the client already has."""
    job = optimize.get(job_id)
    if job is None:
        raise HTTPException(404, {"kind": "not_found", "message": "That exploration has expired."})
    return job.snapshot(since)


@app.delete("/api/explore/{job_id}", status_code=204)
def cancel_explore(job_id: str) -> Response:
    job = optimize.get(job_id)
    if job is None:
        raise HTTPException(404, {"kind": "not_found", "message": "That exploration has expired."})
    job.cancel.set()
    return Response(status_code=204)


# ── What-if analysis ────────────────────────────────────────────────────────

class WhatIfRequest(BaseModel):
    project: Project
    design: Design


@app.post("/api/whatif", response_model=list[whatif.WhatIfCase])
def run_whatif(req: WhatIfRequest) -> list[whatif.WhatIfCase]:
    """Baseline and design under bigger storms and degraded infiltration."""
    issues = [i for i in validate_site(req.project.site) if i.severity == "error"]
    check = check_design(req.project.site, req.design, req.project.costs, req.project.constraints)
    issues += [i for i in check.issues if i.severity == "error"]
    if issues:
        raise HTTPException(422, {"kind": "invalid_design", "issues": [i.model_dump() for i in issues]})
    try:
        return whatif.run_cases(req.project, req.design)
    except SimulationError as exc:
        raise HTTPException(500, {"kind": "engine_error", "message": str(exc), "details": exc.details})


# ── PDF report ──────────────────────────────────────────────────────────────

class ReportRequest(BaseModel):
    project: Project
    design_id: str
    include_whatif: bool = True
    include_year: bool = True  # a year-long run, when the project has rainfall for it
    explore_job_id: str | None = None  # include Design Explorer results, if they match this project


def _same_inputs(a: Project, b: Project) -> bool:
    keys = ("site", "costs", "constraints", "scenario")
    return all(getattr(a, k) == getattr(b, k) for k in keys)


@app.post("/api/report", response_class=Response,
          responses={200: {"content": {"application/pdf": {}}, "description": "The report as a PDF."}})
def make_report(req: ReportRequest) -> Response:
    design = next((d for d in req.project.designs if d.id == req.design_id), None)
    if design is None:
        raise HTTPException(404, {"kind": "not_found", "message": f"No design '{req.design_id}' in this project."})
    try:
        baseline = simulate(req.project, None)
        proposed = simulate(req.project, design)
        cases = whatif.run_cases(req.project, design) if req.include_whatif else None
        year = None
        if req.include_year:
            try:
                record = req.project.long_term.rainfall()
            except ValueError:
                record = None  # "imported" chosen but nothing imported yet: leave the section out
            if record is not None:
                year = (longterm.simulate_period(req.project, None, record),
                        longterm.simulate_period(req.project, design, record))
    except InvalidDesignError as exc:
        raise HTTPException(422, {"kind": "invalid_design", "issues": [i.model_dump() for i in exc.issues]})
    except SimulationError as exc:
        raise HTTPException(500, {"kind": "engine_error", "message": str(exc), "details": exc.details})
    explore = None
    job = optimize.get(req.explore_job_id) if req.explore_job_id else None
    if job and job.status != "running" and _same_inputs(job.req.project, req.project):
        explore = job.snapshot()
    pdf = report.build_report(req.project, design, baseline, proposed, cases, explore, year=year)
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in f"{req.project.id}-{design.id}")
    return Response(pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="runofflab-{safe}.pdf"'})
