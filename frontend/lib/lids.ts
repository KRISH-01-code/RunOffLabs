// One place that describes every kind of green infrastructure: what to call it, how to
// draw it, where it may be built and whether it takes runoff from a nearby surface.
// Mirrors backend/runofflab/validation.py (KINDS) and models/project.py.

import type { Capturing, CostAssumptions, Intervention, InterventionKind, SurfaceKind } from "./types";

export interface LidKind {
  kind: InterventionKind;
  label: string;
  short: string; // for tight spaces such as the toolbar
  prefix: string; // id prefix: RG1, PP1, …
  key: string; // keyboard shortcut for its drawing tool
  fill: string; // CSS colour token
  stroke: string;
  pattern: string; // SVG pattern id for the plan
  hosts: ReadonlySet<SurfaceKind>;
  hostHint: string; // where it may go, for messages
  /** Takes runoff from a nearby surface: any paved one, or only a roof. */
  captures: false | "impervious" | "roof";
  blurb: string;
}

export const LIDS: Record<InterventionKind, LidKind> = {
  rain_garden: {
    kind: "rain_garden", label: "Rain garden", short: "Rain garden", prefix: "RG", key: "r",
    fill: "var(--rg-fill)", stroke: "var(--rg-stroke)", pattern: "rg-plants",
    hosts: new Set(["lawn", "landscape"]), hostHint: "a lawn or planted bed", captures: "impervious",
    blurb: "Planted basin with engineered soil that soaks up runoff from nearby paving.",
  },
  permeable_pavement: {
    kind: "permeable_pavement", label: "Permeable pavement", short: "Pavers", prefix: "PP", key: "p",
    fill: "var(--pp-fill)", stroke: "var(--pp-stroke)", pattern: "pp-hatch",
    hosts: new Set(["parking", "sidewalk"]), hostHint: "parking or a sidewalk/plaza", captures: false,
    blurb: "Pavers over a stone bed, replacing part of a lot or plaza.",
  },
  green_roof: {
    kind: "green_roof", label: "Green roof", short: "Green roof", prefix: "GR", key: "g",
    fill: "var(--gr-fill)", stroke: "var(--gr-stroke)", pattern: "gr-sedum",
    hosts: new Set(["roof"]), hostHint: "a roof", captures: false,
    blurb: "Planted growing medium on a roof; holds the rain that falls on it.",
  },
  infiltration_trench: {
    kind: "infiltration_trench", label: "Infiltration trench", short: "Trench", prefix: "IT", key: "t",
    fill: "var(--it-fill)", stroke: "var(--it-stroke)", pattern: "it-stone",
    hosts: new Set(["lawn", "landscape"]), hostHint: "a lawn or planted bed", captures: "impervious",
    blurb: "Stone-filled trench that soaks runoff from nearby paving into the ground.",
  },
  rain_barrel: {
    kind: "rain_barrel", label: "Rain barrel / cistern", short: "Barrel", prefix: "RB", key: "b",
    fill: "var(--rb-fill)", stroke: "var(--rb-stroke)", pattern: "rb-tank",
    hosts: new Set(["sidewalk", "lawn", "landscape"]), hostHint: "a sidewalk, lawn or planted bed next to a building",
    captures: "roof",
    blurb: "Tank on a downspout that stores roof runoff and empties slowly after the rain.",
  },
};

export const LID_ORDER: InterventionKind[] = ["rain_garden", "permeable_pavement", "green_roof", "infiltration_trench", "rain_barrel"];

export function isCapturing(item: Intervention): item is Capturing {
  return LIDS[item.kind].captures !== false;
}

/** Estimated cost; barrels are priced by tank volume, everything else by footprint. */
export function interventionCost(item: Intervention, costs: CostAssumptions): number {
  const a = item.rect.width * item.rect.height;
  switch (item.kind) {
    case "rain_garden": return a * costs.rain_garden_per_m2;
    case "permeable_pavement": return a * costs.permeable_pavement_per_m2;
    case "green_roof": return a * costs.green_roof_per_m2;
    case "infiltration_trench": return a * costs.infiltration_trench_per_m2;
    case "rain_barrel": return a * (item.height_mm / 1000) * costs.rain_barrel_per_m3;
  }
}
