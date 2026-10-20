import { describe, expect, it } from "vitest";
import {
  blankProject, freeId, levelUpstream, newInlet, newPipe, newSurface, pipeLength, pipeSlope, placeSurface, subtractRect,
} from "@/lib/siteBuilder";
import { initState, reducer } from "@/lib/store";
import { makeProject } from "./fixtures";

describe("subtractRect", () => {
  it("leaves the frame around a hole as four pieces covering the rest", () => {
    const pieces = subtractRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 3, y: 4, width: 2, height: 2 });
    expect(pieces).toHaveLength(4);
    expect(pieces.reduce((a, r) => a + r.width * r.height, 0)).toBe(96);
  });
  it("returns the rectangle untouched when there is no overlap, and nothing when fully covered", () => {
    const a = { x: 0, y: 0, width: 5, height: 5 };
    expect(subtractRect(a, { x: 6, y: 0, width: 2, height: 2 })[0]).toBe(a);
    expect(subtractRect(a, { x: -1, y: -1, width: 9, height: 9 })).toEqual([]);
  });
});

describe("placeSurface", () => {
  it("cuts a new roof out of the lot below it, keeping the lot's id on one piece", () => {
    const p = makeProject(); // lot 100 × 40 over a lawn 100 × 20
    const roof = newSurface(p, "roof", { x: 0, y: 0, width: 30, height: 20 });
    const surfaces = placeSurface(p, roof);
    const total = surfaces.reduce((a, s) => a + s.rect.width * s.rect.height, 0);
    expect(total).toBe(100 * 60); // still covers the site exactly
    expect(surfaces.filter((s) => s.kind === "parking").map((s) => s.id)).toEqual(["P", "P1"]);
    expect(new Set(surfaces.map((s) => s.id)).size).toBe(surfaces.length);
    expect(roof.drains_to).toBe("I1");
  });

  it("names new pieces plainly and merges lawn pieces that line up", () => {
    const p = makeProject();
    p.site.surfaces = [{ id: "L1", name: "Lawn 1", kind: "lawn", rect: { x: 0, y: 0, width: 100, height: 60 }, slope_pct: 3, drains_to: "I1" }];
    const roof = newSurface(p, "roof", { x: 10, y: 10, width: 30, height: 20 });
    p.site.surfaces = placeSurface(p, roof);
    expect(p.site.surfaces.map((s) => s.name)).toEqual(["Lawn 1", "Lawn 2", "Lawn 3", "Lawn 4", "Roof 1"]);
    // A plaza along the roof's south side: the lawn strips beside it join those beside the roof.
    const plaza = newSurface(p, "sidewalk", { x: 10, y: 30, width: 30, height: 8 });
    const after = placeSurface(p, plaza);
    const lawns = after.filter((s) => s.kind === "lawn");
    expect(lawns).toHaveLength(4);
    expect(lawns.find((s) => s.name === "Lawn 3")!.rect).toEqual({ x: 0, y: 10, width: 10, height: 28 });
    expect(after.reduce((a, s) => a + s.rect.width * s.rect.height, 0)).toBe(6000);
  });
});

describe("drains and pipes", () => {
  it("measures pipes on the plan and reports their fall", () => {
    const p = makeProject();
    expect(pipeLength(p.site, "I1", "OF")).toBe(52.6); // (50, 40) → (99, 59)
    expect(pipeSlope(p.site, p.site.pipes[0])).toBeCloseTo(1 / 50); // inverts 8 → 7 over 50 m
  });

  it("levels a new upstream drain so its pipe falls 0.5 %", () => {
    const p = makeProject();
    const drain = { ...newInlet(p, 10, 10), invert_elev_m: 8 }; // level with I1, so a pipe to it would be flat
    p.site.inlets.push(drain);
    const pipe = newPipe(p, drain.id, "I1");
    const invert = levelUpstream(p.site, pipe);
    expect(invert).toBeCloseTo(8 + 0.005 * pipe.length_m, 2);
  });

  it("deleting a drain removes its pipes, and moving one keeps pipe lengths in step", () => {
    let s = initState(makeProject());
    s = reducer(s, { type: "updateInlet", id: "I1", patch: { x: 0, y: 59 } });
    expect(s.project.site.pipes[0].length_m).toBe(99);
    s = reducer(s, { type: "deleteInlet", id: "I1" });
    expect(s.project.site.pipes).toEqual([]);
    s = reducer(s, { type: "undo" });
    expect(s.project.site.pipes).toHaveLength(1);
  });
});

describe("blankProject and freeId", () => {
  it("starts with a lawn over the whole site piped to the outfall", () => {
    const p = blankProject(makeProject(), "new-site", 120, 80);
    expect(p.site.surfaces).toHaveLength(1);
    expect(p.site.surfaces[0].rect).toEqual({ x: 0, y: 0, width: 120, height: 80 });
    expect(p.site.pipes[0]).toMatchObject({ from_node: "I1", to_node: "OF1", length_m: 40 });
    expect(p.designs).toEqual([{ id: "D1", name: "Design 1", interventions: [] }]);
    expect(freeId("I", p)).toBe("I2");
  });
});
