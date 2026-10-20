import { describe, expect, it } from "vitest";
import { activeDesign, initState, reducer, type Action, type WorkspaceState } from "@/lib/store";
import type { Intervention } from "@/lib/types";
import { makeProject } from "./fixtures";

const rg = (id: string): Intervention => ({
  kind: "rain_garden", id, rect: { x: 10, y: 45, width: 10, height: 4 }, contributing_surface_id: "P",
  captured_area_m2: 100, ponding_depth_mm: 150, soil_depth_mm: 600, gravel_depth_mm: 300,
});
const run = (s: WorkspaceState, ...actions: Action[]) => actions.reduce(reducer, s);

describe("workspace reducer", () => {
  it("adds, edits and deletes interventions in the active design", () => {
    let s = run(initState(makeProject()), { type: "addIntervention", item: rg("RG1") });
    expect(activeDesign(s)?.interventions.map((i) => i.id)).toEqual(["RG1"]);
    expect(s.selectedId).toBe("RG1");
    s = run(s, { type: "updateIntervention", id: "RG1", patch: { rect: { x: 0, y: 40, width: 5, height: 5 } } });
    expect(activeDesign(s)?.interventions[0].rect.x).toBe(0);
    s = run(s, { type: "deleteIntervention", id: "RG1" });
    expect(activeDesign(s)?.interventions).toEqual([]);
    expect(s.selectedId).toBeNull();
  });

  it("undoes and redoes every edit, and a new edit clears redo", () => {
    let s = run(initState(makeProject()), { type: "addIntervention", item: rg("RG1") },
      { type: "setScenario", patch: { depth_mm: 80 } });
    s = run(s, { type: "undo" });
    expect(s.project.scenario.depth_mm).toBe(50);
    s = run(s, { type: "undo" });
    expect(activeDesign(s)?.interventions).toEqual([]);
    s = run(s, { type: "redo" });
    expect(activeDesign(s)?.interventions).toHaveLength(1);
    s = run(s, { type: "setSoil", soil: "clay" });
    expect(s.future).toEqual([]);
    expect(run(s, { type: "redo" })).toBe(s);
  });

  it("selection changes are not undo steps", () => {
    const s = run(initState(makeProject()), { type: "select", id: "x" }, { type: "selectDesign", id: null });
    expect(s.past).toEqual([]);
  });

  it("creates, duplicates, adopts and deletes designs, keeping a sensible active design", () => {
    let s = run(initState(makeProject()), { type: "addIntervention", item: rg("RG1") },
      { type: "addDesign", copyFrom: "D1" });
    expect(s.activeDesignId).toBe("D2");
    expect(activeDesign(s)?.name).toBe("First (copy)");
    expect(activeDesign(s)?.interventions).toHaveLength(1);
    s = run(s, { type: "adoptDesign", name: "From explorer", interventions: [rg("RG9")] });
    expect(s.activeDesignId).toBe("D3");
    s = run(s, { type: "deleteDesign", id: "D3" });
    expect(s.activeDesignId).toBe("D1");
    expect(s.project.designs.map((d) => d.id)).toEqual(["D1", "D2"]);
  });

  it("drops a selection that no longer exists after undo", () => {
    let s = run(initState(makeProject()), { type: "addIntervention", item: rg("RG1") });
    s = run(s, { type: "undo" });
    expect(s.selectedId).toBeNull();
  });
});
