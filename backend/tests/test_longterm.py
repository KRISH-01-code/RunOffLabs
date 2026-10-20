"""Year-long rainfall (synthetic and imported) and continuous simulation."""

from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from runofflab.api.app import app
from runofflab.engine.longterm import simulate_period
from runofflab.hydrology.longterm import RainfallParseError, RainRecord, parse_csv, synthetic_year


def test_synthetic_year_hits_its_total_and_is_repeatable():
    a, b, c = synthetic_year(800, seed=3), synthetic_year(800, seed=3), synthetic_year(800, seed=4)
    assert a.total_mm == pytest.approx(800, abs=0.5)
    assert a.hours == 366 * 24  # 2024 is a leap year
    assert a.depths_mm == b.depths_mm and a.depths_mm != c.depths_mm
    wet = sum(1 for d in a.depths_mm if d > 0) / a.hours
    assert 0.03 < wet < 0.15  # it rains in a few percent of hours, as in most climates


def test_csv_import_sums_to_hourly_depths():
    text = "time,rain\n2023-05-01 00:00,1.5\n2023-05-01 01:00,0\n2023-05-01 03:00,2\n"
    r = parse_csv(text)
    assert r.start == datetime(2023, 5, 1)
    assert r.depths_mm[:4] == [1.5, 0, 0, 2]  # the missing 02:00 reading counts as dry
    # 15-minute intensities: four readings of 4 mm/h make 4 mm in that hour.
    q = parse_csv("\n".join(f"2023-05-01 10:{m:02d},4" for m in (0, 15, 30, 45)), units="mm/h")
    assert q.depths_mm[0] == pytest.approx(4)
    inches = parse_csv("05/01/2023 10:00,0.1\n05/01/2023 11:00,0", units="in")
    assert inches.depths_mm[0] == pytest.approx(2.54)


@pytest.mark.parametrize("text, message", [
    ("2023-05-01 00:00,-1\n2023-05-01 01:00,0", "negative"),
    ("yesterday,1\ntoday,2", "date/time"),
    ("2023-05-01 00:00,1", "at least two rows"),
    ("2023-05-01 00:00,abc\n2023-05-01 01:00,1", "Row 1: “abc” isn’t a number"),  # data, not a header
    ("time,rain\n2023-05-01 00:00,abc\n2023-05-01 01:00,1", "Row 2: “abc” isn’t a number"),
])
def test_csv_import_explains_bad_files(text, message):
    with pytest.raises(RainfallParseError, match=message):
        parse_csv(text)


def _three_day_storm() -> RainRecord:
    depths = [0.0] * 72
    depths[10:16] = [2, 5, 10, 8, 4, 1]  # 30 mm on the first day
    return RainRecord(name="Test storm", source="imported", start=datetime(2023, 6, 1), depths_mm=depths)


def test_long_run_keeps_more_rain_on_site_with_the_design(project, design):
    rec = _three_day_storm()
    base = simulate_period(project, None, rec)
    prop = simulate_period(project, design, rec)
    assert base.rainfall_mm == pytest.approx(30, abs=0.1)
    assert prop.kept_on_site_pct > base.kept_on_site_pct + 10
    assert prop.pollutants[0].outfall_load_kg < base.pollutants[0].outfall_load_kg
    assert base.outflow_days >= 1 and abs(base.continuity_error_pct) < 1
    assert [m.month for m in base.months] == ["2023-06"]


def test_monthly_runoff_adds_up_to_the_year(project):
    year = simulate_period(project, None, synthetic_year(1000))
    assert len(year.months) == 12
    assert sum(m.rainfall_mm for m in year.months) == pytest.approx(1000, abs=1)
    assert sum(m.runoff_m3 for m in year.months) == pytest.approx(year.runoff_m3, rel=0.001)
    wettest = max(year.months, key=lambda m: m.rainfall_mm)
    assert wettest.runoff_m3 == max(m.runoff_m3 for m in year.months)  # more rain, more runoff
    assert 20 < year.kept_on_site_pct < 80


def test_api_runs_a_year_and_parses_rainfall(project, design):
    client = TestClient(app)
    p = project.model_dump(mode="json")
    p["long_term"] = {"source": "imported", "record": _three_day_storm().model_dump(mode="json")}
    r = client.post("/api/longterm", json={"project": p, "design": design.model_dump(mode="json")})
    assert r.status_code == 200
    body = r.json()
    assert body["proposed"]["kept_on_site_pct"] > body["baseline"]["kept_on_site_pct"]
    bad = client.post("/api/rainfall/parse", json={"text": "nonsense", "units": "mm"})
    assert bad.status_code == 422 and "two rows" in bad.json()["detail"]["message"]
    p["long_term"] = {"source": "imported"}  # nothing imported yet
    assert client.post("/api/longterm", json={"project": p}).json()["detail"]["kind"] == "no_rainfall"


def test_api_can_skip_the_baseline_when_comparing(project, design):
    client = TestClient(app)
    p = project.model_dump(mode="json")
    p["long_term"] = {"source": "imported", "record": _three_day_storm().model_dump(mode="json")}
    body = client.post("/api/longterm", json={"project": p, "design": design.model_dump(mode="json"),
                                               "include_baseline": False}).json()
    assert body["baseline"] is None and body["proposed"]["kept_on_site_pct"] > 0
