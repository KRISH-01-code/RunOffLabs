import time

from fastapi.testclient import TestClient

from runofflab.api.app import app
from runofflab.optimize import (
    LEVELS,
    ExplorePoint,
    build_slots,
    design_from_genome,
    pareto_front,
)
from runofflab.validation import check_design

client = TestClient(app)


def test_slots_follow_the_site_rules(project):
    slots = build_slots(project)
    surfaces = {s.id: s for s in project.site.surfaces}
    assert {s.kind for s in slots} == {"rain_garden", "permeable_pavement"}
    for slot in slots:
        host, full = surfaces[slot.host_id], slot.full
        assert host.rect.x <= full.x and full.x2 <= host.rect.x2 and host.rect.y <= full.y and full.y2 <= host.rect.y2
        if slot.kind == "rain_garden":
            assert host.kind.value in ("lawn", "landscape")
            assert surfaces[slot.source_id].kind.value in ("roof", "parking", "road", "sidewalk")
        else:
            assert host.kind.value in ("parking", "sidewalk")
    assert all(s.kind == "rain_garden" for s in build_slots(project, pavement=False))
    assert build_slots(project, rain_gardens=False, pavement=False) == []


def test_every_single_slot_design_is_feasible_without_budget_limits(project):
    roomy = project.model_copy(update={"constraints": project.constraints.model_copy(
        update={"budget": 10_000_000, "max_intervention_area_m2": None})})
    slots = build_slots(roomy)
    for i in range(len(slots)):
        for level in range(1, LEVELS + 1):
            genome = tuple(level if j == i else 0 for j in range(len(slots)))
            design = design_from_genome(roomy, slots, genome)
            check = check_design(roomy.site, design, roomy.costs, roomy.constraints)
            assert check.feasible, (slots[i].label, level, [x.message for x in check.issues])


def test_capture_never_exceeds_what_a_surface_has(project):
    roomy = project.model_copy(update={"constraints": project.constraints.model_copy(
        update={"budget": 10_000_000, "max_intervention_area_m2": None})})
    slots = build_slots(roomy)
    everything = design_from_genome(roomy, slots, tuple(LEVELS for _ in slots))
    issues = check_design(roomy.site, everything, roomy.costs, roomy.constraints).issues
    assert not [i for i in issues if i.code == "over_capture"]


def _pt(i, cost, runoff, peak):
    return ExplorePoint(id=i, cost=cost, area_m2=1, runoff_m3=runoff, peak_m3s=peak, infiltration_m3=0,
                        flooding_m3=0, design={"id": f"X{i}", "name": "x"})


def test_pareto_front_keeps_only_non_dominated_points():
    pts = [_pt(0, 100, 50, 1.0), _pt(1, 50, 80, 0.5), _pt(2, 120, 60, 0.4), _pt(3, 200, 40, 0.9)]
    assert pareto_front(pts, "runoff_volume") == [1, 0, 3]
    assert pareto_front(pts, "peak_flow") == [1, 2]


def test_explore_job_runs_and_beats_baseline():
    project = client.get("/api/sample").json()
    r = client.post("/api/explore", json={"project": project, "evaluations": 24, "seed": 3})
    assert r.status_code == 202
    job_id = r.json()["job_id"]
    deadline = time.time() + 60
    while (st := client.get(f"/api/explore/{job_id}").json())["status"] == "running":
        assert time.time() < deadline
        time.sleep(0.2)
    assert st["status"] == "done" and st["evaluated"] == 24
    budget = project["constraints"]["budget"]
    assert all(p["cost"] <= budget for p in st["points"])
    best = min(st["points"], key=lambda p: p["runoff_m3"])
    assert best["runoff_m3"] < st["baseline"]["runoff_m3"]
    assert set(st["front_ids"]) <= {p["id"] for p in st["points"]}
    assert client.get(f"/api/explore/{job_id}?since=20").json()["points"][0]["id"] == 20


def test_explore_rejects_empty_choice_and_unknown_job():
    project = client.get("/api/sample").json()
    r = client.post("/api/explore", json={"project": project, "rain_gardens": False, "permeable_pavement": False})
    assert r.status_code == 422
    assert client.get("/api/explore/nope").status_code == 404
