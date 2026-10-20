"""Continuous (long-term) simulation over a year of rainfall."""

from __future__ import annotations

from collections import defaultdict
from datetime import timedelta

from runofflab.engine.inp_builder import build_inp
from runofflab.engine.runner import run_inp
from runofflab.engine.simulate import InvalidDesignError
from runofflab.hydrology.longterm import RainRecord
from runofflab.models.project import Design, Project
from runofflab.models.results import LongTermResult, MonthResult
from runofflab.validation import check_design, validate_site

OUTFLOW_DAY_M3 = 1.0  # a day "has outflow" when more than this leaves the site


def simulate_period(project: Project, design: Design | None, record: RainRecord) -> LongTermResult:
    """Run SWMM continuously over `record` and summarise the year (or years)."""
    site_issues = [i for i in validate_site(project.site) if i.severity == "error"]
    if site_issues:
        raise InvalidDesignError(site_issues)
    host_surface: dict[str, str] = {}
    if design is not None:
        check = check_design(project.site, design, project.costs, project.constraints)
        if not check.feasible:
            raise InvalidDesignError(check.issues)
        host_surface = check.host_surface
    inp, plan = build_inp(project.site, design, project.scenario, host_surface, record)
    r = run_inp(inp, plan, label=design.id if design else "baseline")

    ts, step_s = r.series, r.series.step_minutes * 60
    when = [record.start + timedelta(minutes=m) for m in ts.minutes]
    month_runoff: dict[str, float] = defaultdict(float)
    day_out: dict[str, float] = defaultdict(float)
    for t, q, o in zip(when, ts.runoff_m3s, ts.outfall_m3s):
        month_runoff[f"{t:%Y-%m}"] += q * step_s
        day_out[f"{t:%Y-%m-%d}"] += o * step_s
    month_rain: dict[str, float] = defaultdict(float)
    for h, d in enumerate(record.depths_mm):
        month_rain[f"{record.start + timedelta(hours=h):%Y-%m}"] += d
    months = sorted(month_rain)
    b = r.balance
    # Hourly reports are instantaneous flows, so their sum is only approximate. SWMM's
    # annual total is exact: use the samples to split it between months.
    sampled = sum(month_runoff.values())
    scale = b.runoff_m3 / sampled if sampled > 0 else 0.0
    return LongTermResult(
        label=r.label, engine=r.engine, record_name=record.name, record_source=record.source,
        start=record.start.isoformat(), hours=record.hours, elapsed_s=r.elapsed_s,
        rainfall_mm=round(b.rainfall_mm, 1), rainfall_m3=b.rainfall_m3, runoff_m3=b.runoff_m3,
        infiltration_m3=b.infiltration_m3, evaporation_m3=round(b.evaporation_mm * b.rainfall_m3 / max(b.rainfall_mm, 1e-9), 2),
        outfall_volume_m3=r.outfall_volume_m3, flooding_m3=r.flooding_volume_m3,
        kept_on_site_pct=round(100 * (1 - b.runoff_mm / b.rainfall_mm), 2) if b.rainfall_mm > 0 else 0.0,
        outflow_days=sum(1 for v in day_out.values() if v > OUTFLOW_DAY_M3),
        peak_outfall_m3s=r.peak_outfall_m3s, continuity_error_pct=b.continuity_error_pct,
        pollutants=r.pollutants,
        months=[MonthResult(month=m, rainfall_mm=round(month_rain[m], 1), runoff_m3=round(month_runoff[m] * scale, 1))
                for m in months],
    )
