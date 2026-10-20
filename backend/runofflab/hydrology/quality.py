"""Stormwater quality: what washes off each surface, and what green infrastructure removes.

Pollutants are modelled with event mean concentrations (EMCs): every litre of
runoff from a surface carries a fixed concentration of each pollutant. Green
infrastructure reduces the load leaving the site in two ways, both computed by
SWMM:

* water it soaks into the ground or keeps takes its pollutants with it;
* water leaving through an underdrain is treated by the percentage in
  `DRAIN_REMOVAL_PCT` (SWMM's LID "REMOVALS").

EMCs are typical urban values of the order reported by the National Stormwater
Quality Database (Pitt, Maestre & Morquecho 2004) and similar summaries; they
are illustrative defaults, not measurements of any site.
"""

from __future__ import annotations

from dataclasses import dataclass

from runofflab.hydrology.surfaces import SurfaceKind


@dataclass(frozen=True)
class Pollutant:
    id: str
    label: str
    units: str  # concentration units in SWMM: MG/L


POLLUTANTS = (
    Pollutant("TSS", "Total suspended solids (sediment)", "MG/L"),
    Pollutant("TP", "Total phosphorus", "MG/L"),
)

# Event mean concentration of each pollutant in runoff from each surface, mg/L.
EMC_MG_L: dict[SurfaceKind, dict[str, float]] = {
    SurfaceKind.ROOF: {"TSS": 20, "TP": 0.10},
    SurfaceKind.PARKING: {"TSS": 85, "TP": 0.25},
    SurfaceKind.ROAD: {"TSS": 100, "TP": 0.25},
    SurfaceKind.SIDEWALK: {"TSS": 50, "TP": 0.20},
    SurfaceKind.LAWN: {"TSS": 50, "TP": 0.35},  # fertilised turf is a phosphorus source
    SurfaceKind.LANDSCAPE: {"TSS": 40, "TP": 0.30},
}

# Treatment of water that leaves an LID through its underdrain, %.
DRAIN_REMOVAL_PCT: dict[str, dict[str, float]] = {
    "permeable_pavement": {"TSS": 80, "TP": 40},
    "infiltration_trench": {"TSS": 80, "TP": 50},
    "rain_barrel": {"TSS": 30, "TP": 10},  # settling in the tank
}

# Many stormwater permits ask new development to remove about this share of TSS.
TSS_TARGET_PCT = 80.0

QUALITY_REFERENCE = ("Event mean concentrations: typical urban values (cf. Pitt, Maestre & Morquecho 2004, "
                     "National Stormwater Quality Database). Illustrative, not site measurements.")
