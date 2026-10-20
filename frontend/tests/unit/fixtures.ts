import type { Design, Project } from "@/lib/types";

/** A small two-surface site: a parking lot with a lawn strip along its south edge. */
export function makeProject(): Project {
  return {
    id: "unit", name: "Unit test site",
    site: {
      id: "s", name: "Site", description: "", width_m: 100, height_m: 60, soil: "loam",
      surfaces: [
        { id: "P", name: "Lot", kind: "parking", rect: { x: 0, y: 0, width: 100, height: 40 }, slope_pct: 2, drains_to: "I1" },
        { id: "L", name: "Lawn", kind: "lawn", rect: { x: 0, y: 40, width: 100, height: 20 }, slope_pct: 2, drains_to: "I1" },
      ],
      inlets: [{ id: "I1", name: "Inlet", x: 50, y: 40, rim_elev_m: 10, invert_elev_m: 8 }],
      outfall: { id: "OF", name: "Outfall", x: 99, y: 59, invert_elev_m: 7 },
      pipes: [{ id: "C1", from_node: "I1", to_node: "OF", length_m: 50, diameter_m: 0.3 }],
    },
    costs: {
      currency: "USD", rain_garden_per_m2: 250, permeable_pavement_per_m2: 150,
      green_roof_per_m2: 180, infiltration_trench_per_m2: 200, rain_barrel_per_m3: 700,
    },
    constraints: {
      budget: 100_000, max_intervention_area_m2: null, max_rain_garden_loading_ratio: 15,
      max_pavement_runon_ratio: 2, max_contributing_gap_m: 5,
    },
    scenario: {
      id: "sc", name: "Storm", pattern: "scs_type_ii", depth_mm: 50, duration_hr: 24, peak_position: 0.375,
      infiltration_factor: 1, drain_hours: 12,
    },
    designs: [{ id: "D1", name: "First", interventions: [] }],
    long_term: { source: "synthetic", annual_mm: 1000, seed: 1, record: null },
  };
}

export const design = (p: Project): Design => p.designs[0];
