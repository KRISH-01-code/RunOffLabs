"""Design Explorer: search for cost-effective green-infrastructure layouts.

The search space comes from the site geometry. Each *slot* is a place where
one intervention could go:

* a rain-garden strip along the edge of a lawn that faces a nearby paved
  surface, capturing runoff from that surface;
* a band of permeable pavement inside a parking lot or plaza.

Each slot is either empty or built at one of `LEVELS` sizes, so a design is a
vector of levels (a genome). The search keeps the Pareto front of
(cost, runoff metric): no design on it can be made cheaper without performing
worse, or better without costing more. New candidates are random at first,
then mutations and crossovers of front members. Every candidate is checked
with the same constraint rules as the editor before SWMM ever runs, and every
reported number comes from a SWMM run.
"""

from __future__ import annotations

import os
import random
import threading
import time
import uuid
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, Field

from runofflab.engine.simulate import simulate
from runofflab.hydrology.surfaces import IMPERVIOUS_KINDS, PERMEABLE_PAVEMENT_HOSTS, RAIN_GARDEN_HOSTS, SurfaceKind
from runofflab.models.project import Design, GreenRoof, PermeablePavement, Project, RainGarden, Rect, Surface
from runofflab.validation import check_design

LEVELS = 4  # sizes per slot, besides "not built"
EDGE_MARGIN_M = 2.0  # keep footprints this far from surface ends
RG_MAX_DEPTH_M = 6.0
GR_EDGE_M = 1.5  # roof edge kept clear of green roof (parapet, access)
PP_MAX_BAND_M = 20.0
RG_TARGET_LOADING = 10.0  # captured area : garden area, capped by the project's limit
PP_TARGET_RUNON = 1.0  # run-on area : pavement area, capped by the project's limit

Objective = Literal["runoff_volume", "peak_flow"]


# ── Search space ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Slot:
    kind: Literal["rain_garden", "permeable_pavement", "green_roof"]
    host_id: str
    source_id: str | None  # surface a rain garden captures from
    full: Rect  # footprint at the largest level
    axis: Literal["x", "y"]  # the footprint grows along this axis

    @property
    def label(self) -> str:
        if self.kind == "rain_garden":
            return f"Rain garden on {self.host_id} capturing {self.source_id}"
        if self.kind == "green_roof":
            return f"Green roof on {self.host_id}"
        return f"Permeable pavement on {self.host_id}"

    def rect(self, level: int) -> Rect:
        f = level / LEVELS
        r = self.full
        if self.axis == "x":
            w = round(r.width * f, 1)
            return Rect(x=round(r.x + (r.width - w) / 2, 1), y=r.y, width=w, height=r.height)
        h = round(r.height * f, 1)
        return Rect(x=r.x, y=round(r.y + (r.height - h) / 2, 1), width=r.width, height=h)


def _edge_strip(host: Surface, src: Surface) -> tuple[Rect, Literal["x", "y"]] | None:
    """Strip inside `host` along the edge that faces `src`, or None if they only meet at a corner."""
    h, s = host.rect, src.rect
    x0, x1 = max(h.x, s.x) + EDGE_MARGIN_M, min(h.x2, s.x2) - EDGE_MARGIN_M
    y0, y1 = max(h.y, s.y) + EDGE_MARGIN_M, min(h.y2, s.y2) - EDGE_MARGIN_M
    if x1 - x0 >= 4 and (s.y2 <= h.y + 1e-6 or s.y >= h.y2 - 1e-6):  # src above or below
        d = round(min(RG_MAX_DEPTH_M, h.height / 2), 1)
        y = h.y if s.y2 <= h.y + 1e-6 else h.y2 - d
        return Rect(x=x0, y=y, width=x1 - x0, height=d), "x"
    if y1 - y0 >= 4 and (s.x2 <= h.x + 1e-6 or s.x >= h.x2 - 1e-6):  # src left or right
        d = round(min(RG_MAX_DEPTH_M, h.width / 2), 1)
        x = h.x if s.x2 <= h.x + 1e-6 else h.x2 - d
        return Rect(x=x, y=y0, width=d, height=y1 - y0), "y"
    return None


def build_slots(project: Project, rain_gardens: bool = True, pavement: bool = True,
                green_roofs: bool = False) -> list[Slot]:
    from runofflab.validation import _gap  # same distance rule as the constraint checks

    site, gap_limit = project.site, project.constraints.max_contributing_gap_m
    slots: list[Slot] = []
    for host in site.surfaces:
        if rain_gardens and host.kind in RAIN_GARDEN_HOSTS:
            for src in site.surfaces:
                if src.kind in IMPERVIOUS_KINDS and _gap(host.rect, src.rect) <= gap_limit:
                    strip = _edge_strip(host, src)
                    if strip:
                        slots.append(Slot("rain_garden", host.id, src.id, *strip))
        if pavement and host.kind in PERMEABLE_PAVEMENT_HOSTS:
            r = host.rect
            w, h = r.width - 2 * EDGE_MARGIN_M, r.height - 2 * EDGE_MARGIN_M
            if w < 4 or h < 4:
                continue
            if w >= h:
                band = min(PP_MAX_BAND_M, h)
                full = Rect(x=r.x + EDGE_MARGIN_M, y=round(r.y + (r.height - band) / 2, 1), width=w, height=band)
                slots.append(Slot("permeable_pavement", host.id, None, full, "x"))
            else:
                band = min(PP_MAX_BAND_M, w)
                full = Rect(x=round(r.x + (r.width - band) / 2, 1), y=r.y + EDGE_MARGIN_M, width=band, height=h)
                slots.append(Slot("permeable_pavement", host.id, None, full, "y"))
        if green_roofs and host.kind is SurfaceKind.ROOF:
            # Planted from the middle out along the roof's long side, clear of a 1.5 m edge strip.
            r, m = host.rect, GR_EDGE_M
            if r.width - 2 * m >= 4 and r.height - 2 * m >= 4:
                full = Rect(x=r.x + m, y=r.y + m, width=r.width - 2 * m, height=r.height - 2 * m)
                slots.append(Slot("green_roof", host.id, None, full, "x" if r.width >= r.height else "y"))
    return slots


Genome = tuple[int, ...]


def design_from_genome(project: Project, slots: list[Slot], genome: Genome, design_id: str = "X") -> Design:
    """Build a design, routing as much runoff into each footprint as the limits and surfaces allow."""
    site, c = project.site, project.constraints
    remaining = {s.id: s.area_m2 for s in site.surfaces}
    built = [(slot, slot.rect(level)) for slot, level in zip(slots, genome) if level > 0]
    for slot, rect in built:  # paving or planting over a surface removes that area from what it can route
        if slot.kind in ("permeable_pavement", "green_roof"):
            remaining[slot.host_id] -= rect.area

    items: list[RainGarden | PermeablePavement | GreenRoof] = []
    counts = {"rain_garden": 0, "permeable_pavement": 0, "green_roof": 0}
    for slot, rect in built:
        counts[slot.kind] += 1
        if slot.kind == "rain_garden":
            want = min(RG_TARGET_LOADING, c.max_rain_garden_loading_ratio) * rect.area
            captured = max(min(want, remaining[slot.source_id]), 0)
            remaining[slot.source_id] -= captured
            items.append(RainGarden(id=f"RG{counts['rain_garden']}", rect=rect,
                                    contributing_surface_id=slot.source_id,
                                    captured_area_m2=float(int(captured))))
        elif slot.kind == "green_roof":
            items.append(GreenRoof(id=f"GR{counts['green_roof']}", rect=rect))
        else:
            want = min(PP_TARGET_RUNON, c.max_pavement_runon_ratio) * rect.area
            runon = max(min(want, remaining[slot.host_id]), 0)
            remaining[slot.host_id] -= runon
            items.append(PermeablePavement(id=f"PP{counts['permeable_pavement']}", rect=rect,
                                           runon_area_m2=float(int(runon))))
    return Design(id=design_id, name="Explorer design", interventions=items)


# ── Evaluation (runs in worker processes) ──────────────────────────────────

_worker_cache: dict[str, Project] = {}


def _evaluate(project_json: str, design_json: str) -> dict:
    project = _worker_cache.get(project_json)
    if project is None:
        _worker_cache.clear()
        project = _worker_cache[project_json] = Project.model_validate_json(project_json)
    design = Design.model_validate_json(design_json) if design_json else None
    r = simulate(project, design)
    return {"rainfall_m3": r.balance.rainfall_m3, "runoff_m3": r.balance.runoff_m3, "peak_m3s": r.peak_outfall_m3s,
            "infiltration_m3": r.balance.infiltration_m3, "flooding_m3": r.flooding_volume_m3}


_pool: ProcessPoolExecutor | None = None
_pool_lock = threading.Lock()


def _get_pool() -> ProcessPoolExecutor:
    global _pool
    with _pool_lock:
        if _pool is None:
            workers = max(1, min(4, (os.cpu_count() or 2) - 1))
            _pool = ProcessPoolExecutor(max_workers=workers)
        return _pool


def worker_count() -> int:
    return _get_pool()._max_workers


# ── Jobs ────────────────────────────────────────────────────────────────────

class ExplorePoint(BaseModel):
    id: int
    cost: float
    area_m2: float
    runoff_m3: float
    peak_m3s: float
    infiltration_m3: float
    flooding_m3: float
    design: Design


class ExploreStatus(BaseModel):
    job_id: str
    status: Literal["running", "done", "cancelled", "error"]
    objective: Objective
    evaluated: int
    budget: int
    rejected: int  # candidates refused by constraint checks (never simulated)
    slot_count: int
    elapsed_s: float
    baseline: dict | None
    points: list[ExplorePoint]
    front_ids: list[int]
    error: str | None = None


class ExploreRequest(BaseModel):
    project: Project
    objective: Objective = "runoff_volume"
    evaluations: int = Field(default=200, ge=20, le=1000)
    rain_gardens: bool = True
    permeable_pavement: bool = True
    green_roofs: bool = False  # off by default so existing API callers get the same search
    seed: int | None = None


def pareto_front(points: list[ExplorePoint], objective: Objective) -> list[int]:
    """Ids of points no other point beats on both cost and the objective."""
    key = (lambda p: p.runoff_m3) if objective == "runoff_volume" else (lambda p: p.peak_m3s)
    front, best = [], float("inf")
    for p in sorted(points, key=lambda p: (p.cost, key(p))):
        if key(p) < best - 1e-9:
            front.append(p.id)
            best = key(p)
    return front


@dataclass
class Job:
    req: ExploreRequest
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    status: str = "running"
    evaluated: int = 0
    rejected: int = 0
    slot_count: int = 0
    started: float = field(default_factory=time.perf_counter)
    finished: float | None = None
    baseline: dict | None = None
    points: list[ExplorePoint] = field(default_factory=list)
    front: list[int] = field(default_factory=list)
    error: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self, since: int = 0) -> ExploreStatus:
        with self.lock:
            end = self.finished or time.perf_counter()
            return ExploreStatus(
                job_id=self.id, status=self.status, objective=self.req.objective,
                evaluated=self.evaluated, budget=self.req.evaluations, rejected=self.rejected,
                slot_count=self.slot_count, elapsed_s=round(end - self.started, 2),
                baseline=self.baseline, points=self.points[since:], front_ids=list(self.front),
                error=self.error)


_jobs: dict[str, Job] = {}
_MAX_JOBS = 8


def start(req: ExploreRequest) -> Job:
    job = Job(req)
    _jobs[job.id] = job
    for old in list(_jobs)[:-_MAX_JOBS]:
        _jobs[old].cancel.set()
        del _jobs[old]
    threading.Thread(target=_run, args=(job,), daemon=True, name=f"explore-{job.id}").start()
    return job


def get(job_id: str) -> Job | None:
    return _jobs.get(job_id)


def _run(job: Job) -> None:
    try:
        _search(job)
        with job.lock:
            job.status = "cancelled" if job.cancel.is_set() else "done"
    except Exception as exc:  # report, don't crash the server thread
        with job.lock:
            job.status, job.error = "error", str(exc)
    finally:
        job.finished = time.perf_counter()


def _search(job: Job) -> None:
    req = job.req
    project = req.project.model_copy(update={"designs": []})
    rng = random.Random(req.seed)
    slots = build_slots(project, req.rain_gardens, req.permeable_pavement, req.green_roofs)
    job.slot_count = len(slots)
    if not slots:
        raise ValueError("No place on this site can hold the selected interventions.")

    pool = _get_pool()
    project_json = project.model_dump_json()
    job.baseline = pool.submit(_evaluate, project_json, "").result()

    seen: set[Genome] = set()
    genomes: dict[int, Genome] = {}
    n_init = max(len(slots) * LEVELS, req.evaluations // 3)
    seeds: list[Genome] = [tuple(lvl if i == j else 0 for i in range(len(slots)))
                           for j in range(len(slots)) for lvl in range(1, LEVELS + 1)]

    def random_genome() -> Genome:
        density = rng.uniform(0.15, 0.6)
        return tuple(rng.randint(1, LEVELS) if rng.random() < density else 0 for _ in slots)

    def mutate(g: Genome) -> Genome:
        out = list(g)
        for _ in range(rng.choice((1, 1, 2, 3))):
            i = rng.randrange(len(out))
            move = rng.random()
            if move < 0.6:
                out[i] = min(max(out[i] + rng.choice((-1, 1)), 0), LEVELS)
            elif move < 0.8:
                out[i] = 0
            else:
                out[i] = rng.randint(1, LEVELS)
        return tuple(out)

    def child() -> Genome:
        front = [genomes[i] for i in job.front if i in genomes] or list(genomes.values())
        if len(front) >= 2 and rng.random() < 0.35:
            a, b = rng.sample(front, 2)
            return mutate(tuple(x if rng.random() < 0.5 else y for x, y in zip(a, b)))
        return mutate(rng.choice(front))

    def propose(n: int) -> list[tuple[Genome, Design, float, float]]:
        out = []
        for _ in range(n * 60):
            if len(out) >= n:
                break
            if seeds:
                g = seeds.pop(0)
            elif len(seen) < n_init or not genomes:
                g = random_genome()
            else:
                g = child()
            if g in seen or not any(g):
                continue
            seen.add(g)
            design = design_from_genome(project, slots, g)
            check = check_design(project.site, design, project.costs, project.constraints)
            if not check.feasible:
                job.rejected += 1
                continue
            out.append((g, design, check.cost, check.total_area_m2))
        return out

    batch = pool._max_workers * 2
    stalls = 0
    while job.evaluated < req.evaluations and not job.cancel.is_set():
        cands = propose(min(batch, req.evaluations - job.evaluated))
        if not cands:
            stalls += 1
            if stalls > 5:
                break  # the reachable design space is exhausted
            continue
        stalls = 0
        futures = [pool.submit(_evaluate, project_json, d.model_dump_json()) for _, d, _, _ in cands]
        for (g, design, cost, area), fut in zip(cands, futures):
            if job.cancel.is_set():
                break
            m = fut.result()
            with job.lock:
                pid = job.evaluated
                design = design.model_copy(update={"id": f"X{pid}", "name": f"Explorer design #{pid + 1}"})
                job.points.append(ExplorePoint(id=pid, cost=round(cost, 2), area_m2=round(area, 1),
                                               design=design, **m))
                genomes[pid] = g
                job.evaluated += 1
                job.front = pareto_front(job.points, req.objective)
