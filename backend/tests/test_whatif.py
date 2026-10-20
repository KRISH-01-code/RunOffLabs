from fastapi.testclient import TestClient

from runofflab.api.app import app

client = TestClient(app)


def _cases(project, design):
    r = client.post("/api/whatif", json={"project": project, "design": design})
    assert r.status_code == 200, r.text
    return {c["id"]: c for c in r.json()}


def test_whatif_cases_respond_the_way_hydrology_says_they_should():
    project = client.get("/api/sample").json()
    cases = _cases(project, project["designs"][0])
    assert set(cases) == {"design", "small", "big", "extreme", "compacted", "clogged", "worst"}

    design = cases["design"]
    # The design-storm case reproduces the documented sample result.
    assert round(design["baseline"]["runoff_m3"]) == 826 and round(design["proposed"]["runoff_m3"]) == 576

    # Bigger storms make more runoff; worse infiltration makes more runoff.
    assert cases["small"]["baseline"]["runoff_m3"] < design["baseline"]["runoff_m3"] < cases["big"]["baseline"]["runoff_m3"]
    assert cases["big"]["baseline"]["runoff_m3"] < cases["extreme"]["baseline"]["runoff_m3"]
    assert design["proposed"]["runoff_m3"] < cases["compacted"]["proposed"]["runoff_m3"] < cases["clogged"]["proposed"]["runoff_m3"]
    assert cases["extreme"]["depth_mm"] == 2 * design["depth_mm"]
    assert cases["worst"]["infiltration_factor"] == 0.5

    # The design helps in every case.
    for c in cases.values():
        assert c["proposed"]["runoff_m3"] < c["baseline"]["runoff_m3"], c["id"]


def test_whatif_refuses_an_infeasible_design():
    project = client.get("/api/sample").json()
    project["constraints"]["budget"] = 10
    r = client.post("/api/whatif", json={"project": project, "design": project["designs"][0]})
    assert r.status_code == 422 and r.json()["detail"]["kind"] == "invalid_design"
