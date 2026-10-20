"""Simulation result models. Every number here is read from SWMM output."""

from __future__ import annotations

from pydantic import BaseModel


class EngineInfo(BaseModel):
    swmm_version: str
    pyswmm_version: str
    runofflab_version: str


class WaterBalance(BaseModel):
    """Site-wide runoff continuity, in mm over the modelled area and m³."""
    rainfall_mm: float
    infiltration_mm: float
    evaporation_mm: float
    runoff_mm: float
    storage_change_mm: float  # final - initial surface & LID storage
    continuity_error_pct: float
    rainfall_m3: float
    infiltration_m3: float
    runoff_m3: float


class SurfaceResult(BaseModel):
    surface_id: str
    modelled_area_m2: float
    runoff_m3: float
    infiltration_m3: float
    peak_runoff_m3s: float


class LidResult(BaseModel):
    intervention_id: str
    area_m2: float
    inflow_mm: float  # over LID area, rain + captured runoff
    infiltration_mm: float
    surface_outflow_mm: float
    final_storage_mm: float
    inflow_m3: float
    infiltration_m3: float
    surface_outflow_m3: float
    drain_outflow_mm: float = 0.0  # through an underdrain or a barrel's tap, to the pipes
    drain_outflow_m3: float = 0.0


class PollutantLoad(BaseModel):
    pollutant_id: str
    label: str
    outfall_load_kg: float  # mass leaving the site at the outfall over the whole run


class NodeResult(BaseModel):
    node_id: str
    peak_inflow_m3s: float
    max_depth_m: float
    flooding_m3: float
    flooding_hours: float
    surcharge_hours: float


class TimeSeries(BaseModel):
    """Values at each report step, used for charts and storm playback."""
    step_minutes: int
    minutes: list[int]
    rainfall_mm_hr: list[float]
    runoff_m3s: list[float]  # total surface runoff entering the network
    outfall_m3s: list[float]
    flooding_m3s: list[float]
    surface_runoff_m3s: dict[str, list[float]]
    node_flooding_m3s: dict[str, list[float]]
    node_depth_m: dict[str, list[float]]
    pipe_flow_m3s: dict[str, list[float]]
    pipe_capacity: dict[str, list[float]]  # depth / full depth


class SimulationResult(BaseModel):
    label: str  # "baseline" or design id
    engine: EngineInfo
    inp_sha256: str
    elapsed_s: float
    balance: WaterBalance
    peak_outfall_m3s: float
    outfall_volume_m3: float
    flooding_volume_m3: float
    routing_continuity_error_pct: float
    surfaces: list[SurfaceResult]
    lids: list[LidResult]
    nodes: list[NodeResult]
    series: TimeSeries
    warnings: list[str]
    pollutants: list[PollutantLoad] = []


class MonthResult(BaseModel):
    month: str  # "2024-01"
    rainfall_mm: float
    runoff_m3: float


class LongTermResult(BaseModel):
    """A continuous simulation over a rainfall record, summarised for the year."""
    label: str
    engine: EngineInfo
    record_name: str
    record_source: str
    start: str  # ISO date of the first hour
    hours: int
    elapsed_s: float
    rainfall_mm: float
    rainfall_m3: float
    runoff_m3: float  # from the surfaces into the drains
    infiltration_m3: float
    evaporation_m3: float
    outfall_volume_m3: float
    flooding_m3: float
    kept_on_site_pct: float  # share of the rain that never became runoff
    outflow_days: int  # days on which more than 1 m³ left the site
    peak_outfall_m3s: float
    continuity_error_pct: float
    pollutants: list[PollutantLoad]
    months: list[MonthResult]
