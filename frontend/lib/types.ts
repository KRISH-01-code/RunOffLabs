// TypeScript mirrors of the backend's Pydantic models
// (backend/runofflab/models/project.py, models/results.py, validation.py).
// Lengths are metres, depths millimetres, areas m². Geometry is SVG-style:
// origin at the site's top-left corner, y increasing downwards.

export type SurfaceKind = "roof" | "parking" | "road" | "sidewalk" | "lawn" | "landscape";
export type StormPattern = "scs_type_ii" | "triangular" | "uniform";
export type SoilTexture =
  | "sand" | "loamy_sand" | "sandy_loam" | "loam" | "silt_loam" | "sandy_clay_loam"
  | "clay_loam" | "silty_clay_loam" | "sandy_clay" | "silty_clay" | "clay";

export interface Rect { x: number; y: number; width: number; height: number }

export interface Surface {
  id: string;
  name: string;
  kind: SurfaceKind;
  rect: Rect;
  slope_pct: number;
  drains_to: string;
}

export interface Inlet {
  id: string;
  name: string;
  x: number;
  y: number;
  rim_elev_m: number;
  invert_elev_m: number;
}

export interface Outfall { id: string; name: string; x: number; y: number; invert_elev_m: number }

export interface Pipe {
  id: string;
  from_node: string;
  to_node: string;
  length_m: number;
  diameter_m: number;
  roughness_n?: number;
}

export interface Site {
  id: string;
  name: string;
  description: string;
  width_m: number;
  height_m: number;
  soil: SoilTexture;
  surfaces: Surface[];
  inlets: Inlet[];
  outfall: Outfall;
  pipes: Pipe[];
}

export interface RainGarden {
  kind: "rain_garden";
  id: string;
  rect: Rect;
  contributing_surface_id: string;
  captured_area_m2: number;
  ponding_depth_mm: number;
  soil_depth_mm: number;
  gravel_depth_mm: number;
}

export interface PermeablePavement {
  kind: "permeable_pavement";
  id: string;
  rect: Rect;
  runon_area_m2: number;
  pavement_thickness_mm: number;
  storage_depth_mm: number;
}

export interface GreenRoof {
  kind: "green_roof";
  id: string;
  rect: Rect;
  soil_depth_mm: number;
  drain_mat_mm: number;
}

export interface InfiltrationTrench {
  kind: "infiltration_trench";
  id: string;
  rect: Rect;
  contributing_surface_id: string;
  captured_area_m2: number;
  storage_depth_mm: number;
}

export interface RainBarrel {
  kind: "rain_barrel";
  id: string;
  rect: Rect;
  contributing_surface_id: string;
  captured_area_m2: number;
  height_mm: number;
  drain_delay_hours: number;
}

export type Intervention = RainGarden | PermeablePavement | GreenRoof | InfiltrationTrench | RainBarrel;
export type InterventionKind = Intervention["kind"];
/** Interventions that take runoff from a nearby roof or paved surface. */
export type Capturing = RainGarden | InfiltrationTrench | RainBarrel;

export interface Design { id: string; name: string; interventions: Intervention[] }

export interface CostAssumptions {
  currency: string;
  rain_garden_per_m2: number;
  permeable_pavement_per_m2: number;
  green_roof_per_m2: number;
  infiltration_trench_per_m2: number;
  rain_barrel_per_m3: number;
}

export interface Constraints {
  budget: number;
  max_intervention_area_m2: number | null;
  max_rain_garden_loading_ratio: number;
  max_pavement_runon_ratio: number;
  max_contributing_gap_m: number;
}

export interface Scenario {
  id: string;
  name: string;
  pattern: StormPattern;
  depth_mm: number;
  duration_hr: number;
  peak_position: number;
  infiltration_factor: number;
  drain_hours: number;
}

export interface RainRecord {
  name: string;
  source: "synthetic" | "imported";
  start: string; // ISO date-time of the first hour
  step_minutes: number;
  depths_mm: number[]; // hourly
}

export interface LongTermSettings {
  source: "synthetic" | "imported";
  annual_mm: number;
  seed: number;
  record: RainRecord | null;
}

export interface Project {
  id: string;
  name: string;
  site: Site;
  costs: CostAssumptions;
  constraints: Constraints;
  scenario: Scenario;
  designs: Design[];
  long_term: LongTermSettings;
}

// ── Saved projects ──────────────────────────────────────────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  design_count: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface SavedProject { project: Project; version: number; created_at: string; updated_at: string }

// ── Design Explorer ─────────────────────────────────────────────────────────

export type ExploreObjective = "runoff_volume" | "peak_flow";

export interface ExploreMetrics { runoff_m3: number; peak_m3s: number; infiltration_m3: number; flooding_m3: number }

export interface ExplorePoint extends ExploreMetrics {
  id: number;
  cost: number;
  area_m2: number;
  design: Design;
}

export interface ExploreStatus {
  job_id: string;
  status: "running" | "done" | "cancelled" | "error";
  objective: ExploreObjective;
  evaluated: number;
  budget: number;
  rejected: number;
  slot_count: number;
  elapsed_s: number;
  baseline: ExploreMetrics | null;
  points: ExplorePoint[];
  front_ids: number[];
  error: string | null;
}

// ── What-if analysis ───────────────────────────────────────────────────────

export interface WhatIfMetrics { rainfall_m3: number; runoff_m3: number; peak_m3s: number; infiltration_m3: number; flooding_m3: number }

export interface WhatIfCase {
  id: string;
  label: string;
  description: string;
  depth_mm: number;
  infiltration_factor: number;
  baseline: WhatIfMetrics;
  proposed: WhatIfMetrics;
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface Issue {
  severity: "error" | "warning";
  code: string;
  message: string;
  target_id: string | null;
}

export interface ValidateResponse {
  feasible: boolean;
  issues: Issue[];
  cost: number;
  rain_garden_area_m2: number;
  permeable_pavement_area_m2: number;
  area_by_kind: Partial<Record<InterventionKind, number>>;
}

// ── Results ─────────────────────────────────────────────────────────────────

export interface EngineInfo { swmm_version: string; pyswmm_version: string; runofflab_version: string }

export interface WaterBalance {
  rainfall_mm: number;
  infiltration_mm: number;
  evaporation_mm: number;
  runoff_mm: number;
  storage_change_mm: number;
  continuity_error_pct: number;
  rainfall_m3: number;
  infiltration_m3: number;
  runoff_m3: number;
}

export interface SurfaceResult {
  surface_id: string;
  modelled_area_m2: number;
  runoff_m3: number;
  infiltration_m3: number;
  peak_runoff_m3s: number;
}

export interface LidResult {
  intervention_id: string;
  area_m2: number;
  inflow_mm: number;
  infiltration_mm: number;
  surface_outflow_mm: number;
  final_storage_mm: number;
  inflow_m3: number;
  infiltration_m3: number;
  surface_outflow_m3: number;
  drain_outflow_mm: number;
  drain_outflow_m3: number;
}

export interface PollutantLoad { pollutant_id: string; label: string; outfall_load_kg: number }

export interface NodeResult {
  node_id: string;
  peak_inflow_m3s: number;
  max_depth_m: number;
  flooding_m3: number;
  flooding_hours: number;
  surcharge_hours: number;
}

export interface TimeSeries {
  step_minutes: number;
  minutes: number[];
  rainfall_mm_hr: number[];
  runoff_m3s: number[];
  outfall_m3s: number[];
  flooding_m3s: number[];
  surface_runoff_m3s: Record<string, number[]>;
  node_flooding_m3s: Record<string, number[]>;
  node_depth_m: Record<string, number[]>;
  pipe_flow_m3s: Record<string, number[]>;
  pipe_capacity: Record<string, number[]>;
}

export interface SimulationResult {
  label: string;
  engine: EngineInfo;
  inp_sha256: string;
  elapsed_s: number;
  balance: WaterBalance;
  peak_outfall_m3s: number;
  outfall_volume_m3: number;
  flooding_volume_m3: number;
  routing_continuity_error_pct: number;
  surfaces: SurfaceResult[];
  lids: LidResult[];
  nodes: NodeResult[];
  series: TimeSeries;
  warnings: string[];
  pollutants: PollutantLoad[];
}

export interface Reference {
  soils: Record<SoilTexture, { label: string; ksat_mm_per_hr: number; suction_head_mm: number;
    porosity: number; field_capacity: number; wilting_point: number; initial_moisture_deficit: number }>;
  soil_reference: string;
  surfaces: Record<SurfaceKind, { label: string; impervious_pct: number; n_overland: number;
    depression_storage_mm: number }>;
  rainfall_references: Record<StormPattern, string>;
  lid_parameters: Record<string, number>;
  quality: {
    pollutants: { id: string; label: string; units: string }[];
    emc_mg_l: Record<SurfaceKind, Record<string, number>>;
    drain_removal_pct: Record<string, Record<string, number>>;
    tss_target_pct: number;
    reference: string;
  };
}

// ── Long-term simulation ────────────────────────────────────────────────────

export interface MonthResult { month: string; rainfall_mm: number; runoff_m3: number }

export interface LongTermResult {
  label: string;
  engine: EngineInfo;
  record_name: string;
  record_source: string;
  start: string;
  hours: number;
  elapsed_s: number;
  rainfall_mm: number;
  rainfall_m3: number;
  runoff_m3: number;
  infiltration_m3: number;
  evaporation_m3: number;
  outfall_volume_m3: number;
  flooding_m3: number;
  kept_on_site_pct: number;
  outflow_days: number;
  peak_outfall_m3s: number;
  continuity_error_pct: number;
  pollutants: PollutantLoad[];
  months: MonthResult[];
}
