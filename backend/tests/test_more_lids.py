"""Green roofs, infiltration trenches and rain barrels: checks, SWMM input and behaviour."""

import pytest

from runofflab.engine.inp_builder import build_inp
from runofflab.engine.simulate import InvalidDesignError, simulate
from runofflab.models.project import GreenRoof, InfiltrationTrench, RainBarrel, Rect
from runofflab.validation import check_design

from conftest import with_items

ROOF = GreenRoof(id="GR1", rect=Rect(x=5, y=5, width=40, height=30))  # on the Science Hall roof
TRENCH = InfiltrationTrench(id="IT1", rect=Rect(x=150, y=76, width=40, height=3),  # median, beside Lot A
                            contributing_surface_id="P1", captured_area_m2=600)
BARREL = RainBarrel(id="RB1", rect=Rect(x=2, y=51, width=2, height=2),  # on the plaza by the roof
                    contributing_surface_id="R1", captured_area_m2=500)


def codes(project, design):
    return {i.code for i in check_design(project.site, design, project.costs, project.constraints).issues
            if i.severity == "error"}


def test_new_types_pass_checks_and_are_priced(project, design):
    d = with_items(design, ROOF, TRENCH, BARREL)
    check = check_design(project.site, d, project.costs, project.constraints)
    assert check.feasible, check.issues
    assert check.host_surface == {"GR1": "R1", "IT1": "L2", "RB1": "S1"}
    c = project.costs
    assert check.cost == pytest.approx(1200 * c.green_roof_per_m2 + 120 * c.infiltration_trench_per_m2
                                       + 4 * 1.2 * c.rain_barrel_per_m3)  # barrel: 2 × 2 m × 1.2 m tank
    assert check.area_by_kind == {"green_roof": 1200, "infiltration_trench": 120, "rain_barrel": 4}


def test_each_type_is_only_allowed_where_it_belongs(project, design):
    on_lawn = GreenRoof(id="GR9", rect=Rect(x=10, y=70, width=10, height=10))
    from_lot = RainBarrel(id="RB9", rect=Rect(x=72, y=76, width=2, height=2), contributing_surface_id="P1",
                          captured_area_m2=100)
    in_lot = InfiltrationTrench(id="IT9", rect=Rect(x=80, y=40, width=10, height=2), contributing_surface_id="P1",
                                captured_area_m2=100)
    assert "wrong_host_surface" in codes(project, with_items(design, on_lawn))
    assert "contributing_not_roof" in codes(project, with_items(design, from_lot))
    assert "wrong_host_surface" in codes(project, with_items(design, in_lot))
    greedy = TRENCH.model_copy(update={"captured_area_m2": 120 * 16})  # 16× its area, the limit is 15×
    assert "loading_ratio" in codes(project, with_items(design, greedy))


def test_green_roof_area_is_taken_out_of_what_the_roof_can_route(project, design):
    whole_roof = GreenRoof(id="GR2", rect=Rect(x=0, y=0, width=70, height=40))  # leaves 70 × 10 = 700 m²
    too_much = BARREL.model_copy(update={"captured_area_m2": 800})
    assert "over_capture" in codes(project, with_items(design, whole_roof, too_much))


def test_inp_has_the_swmm_layers_for_each_type(project, design):
    check = check_design(project.site, with_items(design, ROOF, TRENCH, BARREL), project.costs, project.constraints)
    inp, plan = build_inp(project.site, with_items(design, ROOF, TRENCH, BARREL), project.scenario, check.host_surface)
    for line in ["LID_GR1  GR", "LID_GR1  DRAINMAT", "LID_IT1  IT", "LID_RB1  RB", "LID_RB1  DRAIN"]:
        assert line in inp
    subs = {p.intervention_id: p.subcatchment for p in plan.lids}
    assert subs == {"GR1": "R1", "IT1": "P1", "RB1": "R1"}  # capturing units sit with their source


@pytest.mark.parametrize("item", [ROOF, TRENCH], ids=lambda i: i.kind)
def test_each_type_reduces_runoff(project, design, item):
    base = simulate(project, None)
    res = simulate(project, with_items(design, item))
    assert res.balance.runoff_m3 < base.balance.runoff_m3 - 5
    lid = res.lids[0]
    assert lid.intervention_id == item.id and lid.inflow_m3 > 0
    assert abs(res.balance.continuity_error_pct) < 1


def test_full_rain_barrel_keeps_its_own_volume_out_of_the_pipes(project, design):
    base = simulate(project, None)
    res = simulate(project, with_items(design, BARREL))  # 500 m² of roof fills 4.8 m³ in the first ~10 mm
    assert base.balance.runoff_m3 - res.balance.runoff_m3 == pytest.approx(4.8, rel=0.05)


def test_rain_barrel_holds_water_until_its_drain_opens(project, design):
    # 4 m² × 1.2 m = 4.8 m³ of tank. With the drain held shut past the end of the run, it ends full.
    held = simulate(project, with_items(design, BARREL.model_copy(update={"drain_delay_hours": 72})))
    lid = held.lids[0]
    assert lid.final_storage_mm == pytest.approx(1200, rel=0.02)
    assert lid.drain_outflow_m3 == pytest.approx(0, abs=0.01)
    # Opened promptly, it empties some of that back into the pipes during the run.
    quick = simulate(project, with_items(design, BARREL.model_copy(update={"drain_delay_hours": 0})))
    assert quick.lids[0].drain_outflow_m3 > 0.5


def test_infeasible_new_type_is_never_simulated(project, design):
    with pytest.raises(InvalidDesignError):
        simulate(project, with_items(design, GreenRoof(id="GR9", rect=Rect(x=10, y=70, width=10, height=10))))


def test_api_reports_area_by_kind_and_report_lists_every_type(project, design):
    from fastapi.testclient import TestClient

    from runofflab.api.app import app
    client = TestClient(app)
    d = with_items(design, ROOF, TRENCH, BARREL)
    p = project.model_copy(update={"designs": [d]}).model_dump(mode="json")
    v = client.post("/api/validate", json={"project": p, "design": d.model_dump(mode="json")}).json()
    assert v["feasible"] and v["area_by_kind"] == {"green_roof": 1200, "infiltration_trench": 120, "rain_barrel": 4}
    r = client.post("/api/report", json={"project": p, "design_id": "D1", "include_year": False, "include_whatif": False})
    assert r.status_code == 200 and r.content.startswith(b"%PDF")


def test_explorer_can_plant_green_roofs(project):
    from runofflab.optimize import build_slots, design_from_genome

    assert not any(s.kind == "green_roof" for s in build_slots(project))  # off unless asked for
    slots = build_slots(project, rain_gardens=False, pavement=False, green_roofs=True)
    assert [s.kind for s in slots] == ["green_roof"]
    d = design_from_genome(project, slots, (4,))
    roof = d.interventions[0]
    assert isinstance(roof, GreenRoof) and roof.rect.area == pytest.approx(67 * 47)  # 70 × 50 roof less a 1.5 m edge
    issues = check_design(project.site, d, project.costs, project.constraints).issues
    # A whole planted roof is over the sample's budget, which the Explorer handles; it breaks no site rule.
    assert {i.code for i in issues if i.severity == "error"} <= {"over_budget", "over_area"}


# ── Water quality ────────────────────────────────────────────────────────────

def test_outfall_sediment_matches_runoff_times_concentration(project):
    from runofflab.hydrology.quality import EMC_MG_L

    base = simulate(project, None)
    loads = {p.pollutant_id: p.outfall_load_kg for p in base.pollutants}
    kinds = {s.id: s.kind for s in project.site.surfaces}
    expected = sum(r.runoff_m3 * EMC_MG_L[kinds[r.surface_id]]["TSS"] / 1000 for r in base.surfaces)  # m³ × mg/L = g
    assert loads["TSS"] == pytest.approx(expected, rel=0.03)
    assert loads["TP"] > 0


def test_green_infrastructure_removes_pollutants(project, design):
    base = {p.pollutant_id: p.outfall_load_kg for p in simulate(project, None).pollutants}
    res = {p.pollutant_id: p.outfall_load_kg for p in simulate(project, design).pollutants}
    assert res["TSS"] < base["TSS"] * 0.8  # the sample design removes over 20 % of sediment
    assert res["TP"] < base["TP"]


def test_underdrain_treatment_is_written_for_lids_with_drains(project, design):
    check = check_design(project.site, with_items(design, TRENCH, BARREL), project.costs, project.constraints)
    inp, _ = build_inp(project.site, with_items(design, TRENCH, BARREL), project.scenario, check.host_surface)
    assert "LID_IT1  REMOVALS  TSS  80  TP  50" in inp
    assert "[WASHOFF]" in inp and "parking  TSS  EMC  85" in inp
