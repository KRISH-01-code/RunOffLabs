import re
import time

from fastapi.testclient import TestClient

from runofflab.api.app import app

client = TestClient(app)


def _pages(pdf: bytes) -> int:
    return len(re.findall(rb"/Type /Page[^s]", pdf))


def test_report_is_a_multi_page_pdf_named_after_the_design():
    project = client.get("/api/sample").json()
    r = client.post("/api/report", json={"project": project, "design_id": "D1", "include_year": False})
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert 'filename="runofflab-northfield-campus-D1.pdf"' in r.headers["content-disposition"]
    assert r.content.startswith(b"%PDF") and r.content.rstrip().endswith(b"%%EOF")
    assert _pages(r.content) >= 3


def test_report_without_whatif_is_shorter():
    project = client.get("/api/sample").json()
    full = client.post("/api/report", json={"project": project, "design_id": "D1", "include_year": False}).content
    short = client.post("/api/report", json={"project": project, "design_id": "D1", "include_year": False, "include_whatif": False}).content
    assert len(short) < len(full)


def test_report_includes_explorer_results_only_for_matching_inputs():
    project = client.get("/api/sample").json()
    job = client.post("/api/explore", json={"project": project, "evaluations": 20, "seed": 1}).json()["job_id"]
    deadline = time.time() + 60
    while client.get(f"/api/explore/{job}?since=999").json()["status"] == "running":
        assert time.time() < deadline
        time.sleep(0.2)
    base = client.post("/api/report", json={"project": project, "design_id": "D1", "include_year": False, "include_whatif": False}).content
    with_explore = client.post("/api/report", json={"project": project, "design_id": "D1", "include_year": False, "include_whatif": False,
                                                    "explore_job_id": job}).content
    assert len(with_explore) > len(base) + 2000  # chart + table added

    changed = {**project, "scenario": {**project["scenario"], "depth_mm": 60}}
    stale = client.post("/api/report", json={"project": changed, "design_id": "D1", "include_year": False, "include_whatif": False,
                                             "explore_job_id": job}).content
    assert abs(len(stale) - len(base)) < 2000  # explorer section left out


def test_report_errors():
    project = client.get("/api/sample").json()
    assert client.post("/api/report", json={"project": project, "design_id": "nope", "include_year": False}).status_code == 404
    project["constraints"]["budget"] = 10
    r = client.post("/api/report", json={"project": project, "design_id": "D1", "include_year": False})
    assert r.status_code == 422 and r.json()["detail"]["kind"] == "invalid_design"


def test_report_handles_text_outside_the_pdf_font():
    project = client.get("/api/sample").json()
    project["name"] = "Café & “Plaza” <North> − test ≥ 2"
    project["designs"][0]["name"] = "Design → A"
    r = client.post("/api/report", json={"project": project, "design_id": "D1", "include_year": False, "include_whatif": False})
    assert r.status_code == 200 and r.content.startswith(b"%PDF")


def test_report_includes_a_year_of_rainfall_when_asked():
    project = client.get("/api/sample").json()
    project["long_term"] = {"source": "synthetic", "annual_mm": 600, "seed": 2}
    without = client.post("/api/report", json={"project": project, "design_id": "D1", "include_whatif": False,
                                               "include_year": False}).content
    with_year = client.post("/api/report", json={"project": project, "design_id": "D1", "include_whatif": False}).content
    assert with_year.startswith(b"%PDF") and len(with_year) > len(without) + 1500  # the extra section and chart
    # Imported chosen but nothing imported: the report still builds, without the section.
    project["long_term"] = {"source": "imported"}
    r = client.post("/api/report", json={"project": project, "design_id": "D1", "include_whatif": False})
    assert r.status_code == 200 and abs(len(r.content) - len(without)) < 1500
