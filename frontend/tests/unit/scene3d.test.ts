import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildSiteScene, createRain, createRunoffFlow, groundHeightAt, createSpray, PIPE_SCALE, readPalette, sample, stormScales, undergroundLayout } from "@/lib/scene3d";
import type { SimulationResult } from "@/lib/types";
import { design, makeProject } from "./fixtures";

globalThis.getComputedStyle ??= (() => ({ getPropertyValue: () => "" })) as unknown as typeof getComputedStyle;
const palette = readPalette({} as Element); // no CSS in node, so every token falls back to the light theme

function withGarden() {
  const p = makeProject();
  design(p).interventions.push({
    kind: "rain_garden", id: "RG1", rect: { x: 40, y: 45, width: 10, height: 5 }, contributing_surface_id: "P",
    captured_area_m2: 500, ponding_depth_mm: 150, soil_depth_mm: 600, gravel_depth_mm: 300,
  });
  return p;
}

/** A two-step run where the lot runs off, the inlet floods and the pipe fills on step 1. */
function fakeResult(): SimulationResult {
  return {
    surfaces: [
      { surface_id: "P", modelled_area_m2: 4000, runoff_m3: 0, infiltration_m3: 0, peak_runoff_m3s: 0 },
      { surface_id: "L", modelled_area_m2: 2000, runoff_m3: 0, infiltration_m3: 0, peak_runoff_m3s: 0 },
    ],
    series: {
      step_minutes: 5, minutes: [0, 5], rainfall_mm_hr: [0, 40], runoff_m3s: [0, 0.04], outfall_m3s: [0, 0.03],
      flooding_m3s: [0, 0.01], surface_runoff_m3s: { P: [0, 0.04], L: [0, 0] },
      node_flooding_m3s: { I1: [0, 0.01] }, node_depth_m: {}, pipe_flow_m3s: {}, pipe_capacity: { C1: [0.2, 1] },
    },
  } as unknown as SimulationResult;
}

describe("undergroundLayout", () => {
  it("places drains at rim minus invert and pipes at their scaled radius", () => {
    const { nodes, pipes, bottom } = undergroundLayout(makeProject().site);
    expect(nodes.get("I1")!.depth).toBe(2); // rim 10 − invert 8
    expect(nodes.get("OF")!.depth).toBe(3); // lowest rim 10 − outfall invert 7
    expect(pipes).toHaveLength(1);
    expect(pipes[0].radius).toBeCloseTo((0.3 * PIPE_SCALE) / 2);
    expect(pipes[0].from.y).toBeCloseTo(-2 + pipes[0].radius);
    expect(bottom).toBeLessThan(-3); // the earth block reaches below the deepest node
  });

  it("centres the site on the origin", () => {
    const { nodes } = undergroundLayout(makeProject().site);
    expect(nodes.get("I1")).toMatchObject({ x: 0, z: 10 }); // (50, 40) on a 100 × 60 site
  });
});

describe("buildSiteScene", () => {
  it("labels features before surfaces and makes the garden pickable", () => {
    const p = withGarden();
    const scene = buildSiteScene(p.site, design(p), palette);
    expect(scene.labels.map((l) => l.id)).toEqual(["RG1", "I1", "OF", "P", "L"]);
    const garden = scene.pickables.find((o) => o.userData.info.interventionId === "RG1");
    expect(garden).toBeDefined();
    expect(garden!.userData.ground).toBe(false);
    // The basin sits ponding depth below the lawn top.
    const box = new THREE.Box3().setFromObject(garden!);
    expect(box.max.y).toBeCloseTo(0.15 - 0.15);
    scene.dispose();
  });

  it("shows a storm step and clears it again", () => {
    const p = makeProject();
    const scene = buildSiteScene(p.site, design(p), palette);
    const result = fakeResult();
    const film = (id: string) => scene.group.children.find((o) =>
      ((o as THREE.Mesh).material as THREE.Material | undefined)?.name === id) as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    const level = (id: string) => film(id).material.uniforms.uLevel.value as number;
    const puddle = film("puddle-I1");

    scene.applyStep(result, 0.5, stormScales([result]));
    expect(level("P")).toBeCloseTo(0.5); // halfway between report steps
    scene.applyStep(result, 1, stormScales([result]));
    expect(level("P")).toBe(1); // the lot's runoff is the run's peak intensity
    expect(level("L")).toBe(0);
    expect(puddle.visible).toBe(true);
    const pipe = scene.pickables.find((o) => o.userData.info.title.startsWith("C1")) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    expect(`#${pipe.material.color.getHexString()}`).toBe(palette.critical); // 100 % full

    scene.applyStep(null, 0, null);
    expect(level("P")).toBe(0);
    expect(puddle.visible).toBe(false);
    expect(`#${pipe.material.color.getHexString()}`).toBe(palette.pipe);
    scene.dispose();
  });

  it("makes ground see-through in X-ray mode", () => {
    const p = makeProject();
    const scene = buildSiteScene(p.site, design(p), palette);
    const lot = scene.pickables.find((o) => o.userData.info.title === "Lot") as THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>;
    scene.setXray(true);
    expect(lot.material[0].opacity).toBeLessThan(0.5);
    scene.setXray(false);
    expect(lot.material[0].opacity).toBe(1);
    scene.dispose();
  });
});

describe("createRain", () => {
  it("draws a share of the drops matching the intensity", () => {
    const rain = createRain(100, 60, palette.water, 1000);
    rain.update(0.016, 0.25);
    expect(rain.lines.geometry.drawRange.count).toBe(1000); // 250 drops × 4 vertices (two segments each)
    rain.update(0.016, 0);
    expect(rain.lines.visible).toBe(false);
    rain.dispose();
  });
});

describe("sample", () => {
  it("interpolates between steps and clamps at the ends", () => {
    expect(sample([0, 10, 20], 1.25)).toBeCloseTo(12.5);
    expect(sample([0, 10, 20], -3)).toBe(0);
    expect(sample([0, 10, 20], 9)).toBe(20);
    expect(sample([], 1)).toBe(0);
  });
});

describe("createSpray", () => {
  it("emits droplets only while water leaves, and they fall away", () => {
    const spray = createSpray(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), palette.water, -5);
    spray.update(0.1, 0);
    expect(spray.points.visible).toBe(false);
    spray.update(0.1, 1);
    expect(spray.points.visible).toBe(true);
    for (let i = 0; i < 40; i++) spray.update(0.1, 0); // four seconds with no flow
    expect(spray.points.visible).toBe(false);
  });
});

describe("createRunoffFlow", () => {
  it("sends droplets only from surfaces that are running off, and they reach their drain", () => {
    const p = makeProject();
    const flow = createRunoffFlow(p.site, design(p), palette);
    const glints = flow.points.children[0] as THREE.LineSegments;
    flow.update(0.1, new Map([["P", 0]]));
    expect(flow.points.visible).toBe(false);
    flow.update(0.1, new Map([["P", 1]])); // the lot runs off at the run's peak
    expect(flow.points.visible).toBe(true);
    for (let i = 0; i < 100; i++) flow.update(0.1, new Map()); // ten seconds with no runoff
    expect(flow.points.visible).toBe(false);
    expect(glints.geometry.attributes.position.count).toBe(2500 * 4);
  });
});

describe("scenery", () => {
  it("surrounds the site with ground and trees that can't be picked", () => {
    const p = makeProject();
    const scene = buildSiteScene(p.site, design(p), palette);
    const scenery = scene.group.children.filter((o) => o.userData.scenery);
    expect(scenery.length).toBeGreaterThanOrEqual(3); // ground, trunks, crowns (and a channel when the outfall is on an edge)
    expect(scene.pickables.some((o) => o.userData.scenery)).toBe(false);
    scene.dispose();
  });
});

describe("rain", () => {
  it("lands on the roof rather than falling through the building", () => {
    const p = makeProject();
    p.site.surfaces[0] = { ...p.site.surfaces[0], kind: "roof" }; // the 100 × 40 lot becomes a roof
    const at = groundHeightAt(p.site);
    expect(at(0, -10)).toBe(9); // centre of the roof, in scene coordinates
    expect(at(0, 20)).toBeCloseTo(0.15); // the lawn
    expect(at(0, 500)).toBeLessThan(0); // beyond the site
  });
});
