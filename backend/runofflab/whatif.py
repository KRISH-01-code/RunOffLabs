"""What-if analysis: how a design holds up beyond the single design storm.

Each case changes the scenario (storm depth and/or the infiltration factor)
and runs both the baseline and the design through SWMM, in parallel on the
optimizer's worker pool.
"""

from __future__ import annotations

from pydantic import BaseModel

from runofflab.models.project import Design, Project, Scenario
from runofflab.optimize import _evaluate, _get_pool


class WhatIfMetrics(BaseModel):
    rainfall_m3: float
    runoff_m3: float
    peak_m3s: float
    infiltration_m3: float
    flooding_m3: float


class WhatIfCase(BaseModel):
    id: str
    label: str
    description: str
    depth_mm: float
    infiltration_factor: float
    baseline: WhatIfMetrics
    proposed: WhatIfMetrics


# (id, label, description, depth multiplier, infiltration multiplier)
CASES = [
    ("design", "Design storm", "The storm and soil as configured.", 1.0, 1.0),
    ("small", "Smaller storm", "Half the design-storm depth.", 0.5, 1.0),
    ("big", "Bigger storm", "1.5× the design-storm depth.", 1.5, 1.0),
    ("extreme", "Much bigger storm", "Twice the design-storm depth.", 2.0, 1.0),
    ("compacted", "Compacted or partly clogged",
     "Native soil and green-infrastructure seepage at half rate, e.g. compacted soil or silted pavers.", 1.0, 0.5),
    ("clogged", "Badly clogged", "Seepage at a quarter of the rate, e.g. years without maintenance.", 1.0, 0.25),
    ("worst", "Bigger storm, compacted soil", "1.5× depth with seepage at half rate.", 1.5, 0.5),
]


def run_cases(project: Project, design: Design) -> list[WhatIfCase]:
    base = project.model_copy(update={"designs": []})
    pool = _get_pool()
    jobs = []
    for cid, label, desc, depth_k, infil_k in CASES:
        sc: Scenario = base.scenario.model_copy(update={
            "depth_mm": round(min(base.scenario.depth_mm * depth_k, 500), 2),
            "infiltration_factor": round(max(base.scenario.infiltration_factor * infil_k, 0.01), 4),
        })
        pj = base.model_copy(update={"scenario": sc}).model_dump_json()
        jobs.append((cid, label, desc, sc,
                     pool.submit(_evaluate, pj, ""), pool.submit(_evaluate, pj, design.model_dump_json())))
    return [WhatIfCase(id=cid, label=label, description=desc, depth_mm=sc.depth_mm,
                       infiltration_factor=sc.infiltration_factor,
                       baseline=WhatIfMetrics(**b.result()), proposed=WhatIfMetrics(**p.result()))
            for cid, label, desc, sc, b, p in jobs]
