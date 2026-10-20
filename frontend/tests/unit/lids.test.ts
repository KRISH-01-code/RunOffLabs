import { describe, expect, it } from "vitest";
import { newIntervention, remainingImpervious } from "@/lib/geometry";
import { interventionCost, isCapturing, LID_ORDER, LIDS } from "@/lib/lids";
import type { Project } from "@/lib/types";
import { design, makeProject } from "./fixtures";

/** The fixture with its lot turned into a roof: a 100 × 40 roof over a 100 × 20 lawn. */
function withRoof(): Project {
  const p = makeProject();
  p.site.surfaces[0] = { ...p.site.surfaces[0], kind: "roof", name: "Roof" };
  return p;
}

describe("intervention kinds", () => {
  it("every kind has a unique id prefix and shortcut", () => {
    expect(new Set(LID_ORDER.map((k) => LIDS[k].prefix)).size).toBe(5);
    expect(new Set(LID_ORDER.map((k) => LIDS[k].key)).size).toBe(5);
  });

  it("new barrels collect from a roof, sized to fill in about 25 mm of rain", () => {
    const p = withRoof();
    const rb = newIntervention("rain_barrel", { x: 10, y: 41, width: 2, height: 2 }, p.site, design(p), p.constraints);
    expect(rb).toMatchObject({ kind: "rain_barrel", id: "RB1", contributing_surface_id: "P", height_mm: 1200 });
    expect(isCapturing(rb) && rb.captured_area_m2).toBe(192); // 4.8 m³ ÷ 0.025 m
    expect(interventionCost(rb, p.costs)).toBeCloseTo(4 * 1.2 * 700);
  });

  it("new trenches take what the loading limit allows from nearby paving", () => {
    const p = makeProject();
    const it = newIntervention("infiltration_trench", { x: 10, y: 41, width: 20, height: 2 }, p.site, design(p), p.constraints);
    expect(it).toMatchObject({ kind: "infiltration_trench", contributing_surface_id: "P", captured_area_m2: 400 }); // 10 × 40 m²
  });

  it("a green roof takes its footprint out of what the roof can send to a barrel", () => {
    const p = withRoof();
    const d = design(p);
    d.interventions.push(newIntervention("green_roof", { x: 0, y: 0, width: 50, height: 40 }, p.site, d, p.constraints));
    expect(d.interventions[0]).toMatchObject({ kind: "green_roof", id: "GR1", soil_depth_mm: 100 });
    expect(remainingImpervious(p.site, d, "P")).toBe(4000 - 2000);
    expect(interventionCost(d.interventions[0], p.costs)).toBe(2000 * 180);
  });
});
