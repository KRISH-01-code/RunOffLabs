import { describe, expect, it } from "vitest";
import {
  clampInside, contains, contributingCandidates, gap, hostSurface, newIntervention, nextId, overlaps,
  rectFromPoints, remainingImpervious,
} from "@/lib/geometry";
import type { RainGarden } from "@/lib/types";
import { design, makeProject } from "./fixtures";

describe("rectangle helpers", () => {
  it("treats shared edges as touching, not overlapping", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(overlaps(a, { x: 10, y: 0, width: 5, height: 5 })).toBe(false);
    expect(overlaps(a, { x: 9, y: 9, width: 5, height: 5 })).toBe(true);
    expect(gap(a, { x: 10, y: 0, width: 5, height: 5 })).toBe(0);
    expect(gap(a, { x: 13, y: 14, width: 1, height: 1 })).toBe(5);
    expect(contains(a, { x: 0, y: 0, width: 10, height: 10 })).toBe(true);
    expect(contains(a, { x: 1, y: 1, width: 10, height: 1 })).toBe(false);
  });

  it("builds snapped rectangles from a drag in any direction, clipped to the site", () => {
    const { site } = makeProject();
    expect(rectFromPoints(30.4, 20.6, 10.2, 5.1, site)).toEqual({ x: 10, y: 5, width: 20, height: 16 });
    expect(rectFromPoints(-5, -5, 300, 300, site)).toEqual({ x: 0, y: 0, width: 100, height: 60 });
  });

  it("keeps a moved rectangle's size and pulls it back inside the site", () => {
    const { site } = makeProject();
    expect(clampInside({ x: 95, y: -3, width: 10, height: 4 }, site)).toEqual({ x: 90, y: 0, width: 10, height: 4 });
  });
});

describe("site rules", () => {
  it("finds the surface hosting a footprint", () => {
    const { site } = makeProject();
    expect(hostSurface(site, { x: 10, y: 45, width: 20, height: 5 })?.id).toBe("L");
    expect(hostSurface(site, { x: 10, y: 35, width: 20, height: 10 })).toBeUndefined(); // straddles two surfaces
  });

  it("offers only nearby impervious surfaces as runoff sources", () => {
    const p = makeProject();
    const lawn = p.site.surfaces[1];
    expect(contributingCandidates(p.site, lawn, p.constraints).map((s) => s.id)).toEqual(["P"]);
  });

  it("counts paving and capture against what a surface can still route", () => {
    const p = makeProject();
    const d = design(p);
    expect(remainingImpervious(p.site, d, "P")).toBe(4000);
    d.interventions.push({ kind: "permeable_pavement", id: "PP1", rect: { x: 0, y: 0, width: 10, height: 10 },
                           runon_area_m2: 50, pavement_thickness_mm: 100, storage_depth_mm: 300 });
    d.interventions.push({ kind: "rain_garden", id: "RG1", rect: { x: 0, y: 45, width: 10, height: 5 },
                           contributing_surface_id: "P", captured_area_m2: 300, ponding_depth_mm: 150,
                           soil_depth_mm: 600, gravel_depth_mm: 300 });
    expect(remainingImpervious(p.site, d, "P")).toBe(4000 - 100 - 50 - 300);
    expect(remainingImpervious(p.site, d, "P", "RG1")).toBe(4000 - 100 - 50);
  });
});

describe("new interventions", () => {
  it("gives a new rain garden a nearby source and a capture within the loading limit", () => {
    const p = makeProject();
    const rg = newIntervention("rain_garden", { x: 10, y: 40, width: 20, height: 4 }, p.site, design(p), p.constraints) as RainGarden;
    expect(rg.id).toBe("RG1");
    expect(rg.contributing_surface_id).toBe("P");
    expect(rg.captured_area_m2).toBe(800); // 10× its 80 m² footprint
    expect(rg.captured_area_m2 / 80).toBeLessThanOrEqual(p.constraints.max_rain_garden_loading_ratio);
  });

  it("never captures more than the source has left", () => {
    const p = makeProject();
    p.site.surfaces[0].rect = { x: 0, y: 0, width: 10, height: 40 }; // 400 m² lot
    p.site.surfaces[1].rect = { x: 0, y: 40, width: 100, height: 20 };
    const rg = newIntervention("rain_garden", { x: 0, y: 40, width: 20, height: 5 }, p.site, design(p), p.constraints) as RainGarden;
    expect(rg.captured_area_m2).toBe(400);
  });

  it("picks ids that clash with neither surfaces nor other interventions", () => {
    const p = makeProject();
    p.site.surfaces[0].id = "PP1";
    expect(nextId("PP", p.site, design(p))).toBe("PP2");
  });
});
