// Builds the three.js scene for the 3D view from the same Site and Design the
// plan editor uses, and applies one step of a SWMM run to it. Nothing here
// touches the renderer, so it runs (and is tested) without WebGL.
//
// Axes: site x → world x, site y (down the plan, i.e. south) → world z, world y is up.
// The site is centred on the origin. Ground level for paving is y = 0.

import * as THREE from "three";
import { contains, surfaceAt } from "./geometry";
import { isCapturing } from "./lids";
import type { Design, Intervention, Rect, SimulationResult, Site, Surface, SurfaceKind } from "./types";

/** The model stores no building heights, so every roof is drawn at this illustrative height. */
export const BUILDING_HEIGHT_M = 9;
/** Pipes are drawn wider than their real diameter so they stay visible at site scale. */
export const PIPE_SCALE = 2;

const SLAB_BOTTOM = -0.4; // underside of the paving and topsoil layer
const CUT_INTO_SURFACE = new Set(["rain_garden", "permeable_pavement", "infiltration_trench"]);
const TOP: Record<SurfaceKind, number> = {
  roof: BUILDING_HEIGHT_M, parking: 0, road: 0, sidewalk: 0.15, lawn: 0.15, landscape: 0.15,
};

// ── Colours ──────────────────────────────────────────────────────────────

export interface Palette {
  sky: string; storm: string; ground: string; tree: string; soil: string; wall: string;
  kind: Record<SurfaceKind, string>;
  rgFill: string; rgPlant: string; ppFill: string; ppStroke: string;
  grFill: string; grPlant: string; itFill: string; itStroke: string; rbFill: string; rbStroke: string;
  pipe: string; node: string; water: string; warning: string; critical: string;
}

const LIGHT: Palette = {
  sky: "#dfe9e3", storm: "#7f8b8e", ground: "#c3d4a6", tree: "#4f7f45", soil: "#8b6b4a", wall: "#d7d3c8",
  kind: { roof: "#9aa3a0", parking: "#6c716e", road: "#5d625f", sidewalk: "#d9d1bf", lawn: "#a9cc8a", landscape: "#7fae62" },
  rgFill: "#2f9e6b", rgPlant: "#c6efd5", ppFill: "#d6a46c", ppStroke: "#946232",
  grFill: "#8fbf4d", grPlant: "#d9ec9a", itFill: "#a9b8c6", itStroke: "#5d7590", rbFill: "#4a6fa5", rbStroke: "#2c4870",
  pipe: "#2a78d6", node: "#1c5cab", water: "#2a78d6", warning: "#b77900", critical: "#d03b3b",
};

/** Read the theme's CSS tokens, so the 3D view follows light and dark mode like the rest of the app. */
export function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const kind = Object.fromEntries(Object.entries(LIGHT.kind)
    .map(([k, c]) => [k, v(`--kind-${k}`, c)])) as Record<SurfaceKind, string>;
  return {
    sky: v("--scene-sky", LIGHT.sky), storm: v("--scene-storm", LIGHT.storm),
    ground: v("--scene-ground", LIGHT.ground), tree: v("--scene-tree", LIGHT.tree), soil: v("--scene-soil", LIGHT.soil),
    wall: v("--scene-wall", LIGHT.wall), kind,
    rgFill: v("--rg-fill", LIGHT.rgFill), rgPlant: v("--rg-plant", LIGHT.rgPlant),
    grFill: v("--gr-fill", LIGHT.grFill), grPlant: v("--gr-plant", LIGHT.grPlant),
    itFill: v("--it-fill", LIGHT.itFill), itStroke: v("--it-stroke", LIGHT.itStroke),
    rbFill: v("--rb-fill", LIGHT.rbFill), rbStroke: v("--rb-stroke", LIGHT.rbStroke),
    ppFill: v("--pp-fill", LIGHT.ppFill), ppStroke: v("--pp-stroke", LIGHT.ppStroke),
    pipe: v("--pipe", LIGHT.pipe), node: v("--node", LIGHT.node), water: v("--water", LIGHT.water),
    warning: v("--warning", LIGHT.warning), critical: v("--critical", LIGHT.critical),
  };
}

// ── Underground layout ───────────────────────────────────────────────────

export interface NodeLayout { id: string; x: number; z: number; depth: number; centerY: number; maxDiameter: number }
export interface PipeLayout { id: string; from: THREE.Vector3; to: THREE.Vector3; radius: number; diameter: number }

/**
 * Where drains and pipes sit below the flat ground. Each drain's depth is its rim
 * minus its invert; the outfall is measured from the lowest drain rim.
 */
export function undergroundLayout(site: Site): { nodes: Map<string, NodeLayout>; pipes: PipeLayout[]; bottom: number } {
  const cx = site.width_m / 2, cz = site.height_m / 2;
  const widest = new Map<string, number>();
  for (const p of site.pipes) {
    for (const n of [p.from_node, p.to_node]) widest.set(n, Math.max(widest.get(n) ?? 0, p.diameter_m));
  }
  const nodes = new Map<string, NodeLayout>();
  const add = (id: string, x: number, y: number, depth: number) => {
    const d = widest.get(id) ?? 0.3;
    nodes.set(id, { id, x: x - cx, z: y - cz, depth, centerY: -depth + (d * PIPE_SCALE) / 2, maxDiameter: d });
  };
  for (const i of site.inlets) add(i.id, i.x, i.y, Math.max(i.rim_elev_m - i.invert_elev_m, 0.5));
  const groundRef = site.inlets.length ? Math.min(...site.inlets.map((i) => i.rim_elev_m)) : site.outfall.invert_elev_m + 1.5;
  add(site.outfall.id, site.outfall.x, site.outfall.y, Math.max(groundRef - site.outfall.invert_elev_m, 0.5));

  const pipes: PipeLayout[] = [];
  for (const p of site.pipes) {
    const a = nodes.get(p.from_node), b = nodes.get(p.to_node);
    if (!a || !b) continue;
    const r = (p.diameter_m * PIPE_SCALE) / 2;
    pipes.push({
      id: p.id, diameter: p.diameter_m, radius: r,
      from: new THREE.Vector3(a.x, -a.depth + r, a.z), to: new THREE.Vector3(b.x, -b.depth + r, b.z),
    });
  }
  const deepest = Math.max(1.5, ...[...nodes.values()].map((n) => n.depth));
  return { nodes, pipes, bottom: -(deepest + 0.8) };
}

// ── Scene ────────────────────────────────────────────────────────────────

export interface PickInfo { title: string; detail: string; interventionId?: string }
export interface SceneLabel { id: string; text: string; position: THREE.Vector3; kind: "surface" | "item" | "node" }

export interface SiteScene {
  group: THREE.Group;
  /** Meshes the pointer can hover; each carries `userData.info: PickInfo`. */
  pickables: THREE.Object3D[];
  labels: SceneLabel[];
  bounds: { width: number; depth: number; height: number };
  /** Materials that turn see-through in X-ray mode, revealing the pipes. */
  setXray(on: boolean): void;
  /**
   * Show a SWMM run at report step `t`, or clear the storm with `null`. `t` may fall
   * between steps; values are interpolated, so playback moves smoothly.
   */
  applyStep(result: SimulationResult | null, t: number, scales: StormScales | null): void;
  /** Advance the animations (ripples, flow in pipes, outfall spray) by `dt` seconds. */
  tick(dt: number, rain: number): void;
  dispose(): void;
}

export interface StormScales { intensity: number; flooding: number; outflow: number; pipeFlow: number }

/** Shared colour scales, so baseline and proposed compare fairly. */
export function stormScales(results: SimulationResult[]): StormScales {
  let intensity = 1e-9, flooding = 1e-9, outflow = 1e-9, pipeFlow = 1e-9;
  for (const r of results) {
    for (const s of r.surfaces) {
      const q = r.series.surface_runoff_m3s[s.surface_id] ?? [];
      intensity = Math.max(intensity, ...q.map((v) => v / Math.max(s.modelled_area_m2, 1)));
    }
    for (const q of Object.values(r.series.node_flooding_m3s)) flooding = Math.max(flooding, ...q);
    outflow = Math.max(outflow, ...r.series.outfall_m3s);
    for (const q of Object.values(r.series.pipe_flow_m3s)) pipeFlow = Math.max(pipeFlow, ...q.map(Math.abs));
  }
  return { intensity, flooding, outflow, pipeFlow };
}

const KIND_NAME: Record<SurfaceKind, string> = {
  roof: "Roof", parking: "Parking", road: "Road", sidewalk: "Sidewalk / plaza", lawn: "Lawn", landscape: "Planted bed",
};

export function buildSiteScene(site: Site, design: Design | null, pal: Palette): SiteScene {
  const group = new THREE.Group();
  const pickables: THREE.Object3D[] = [];
  const labels: SceneLabel[] = [];
  const xrayMats: THREE.Material[] = [];
  const cx = site.width_m / 2, cz = site.height_m / 2;
  const items = design?.interventions ?? [];
  const under = undergroundLayout(site);

  const mat = (color: string, opts: THREE.MeshStandardMaterialParameters = {}, xray = true) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0, ...opts });
    if (xray) xrayMats.push(m);
    return m;
  };
  const shade = (color: string, k: number) => `#${new THREE.Color(color).multiplyScalar(k).getHexString()}`;
  const pick = (obj: THREE.Object3D, info: PickInfo, ground = false) => {
    obj.userData.info = info;
    obj.userData.ground = ground; // surfaces and buildings, see-through in X-ray
    pickables.push(obj);
  };

  // Earth block under the site: its cut faces show soil, and it hides the pipes until X-ray is on.
  const earthH = SLAB_BOTTOM - under.bottom;
  const earth = new THREE.Mesh(new THREE.BoxGeometry(site.width_m, earthH, site.height_m), mat(pal.soil));
  earth.position.set(0, under.bottom + earthH / 2, 0);
  earth.receiveShadow = true;
  group.add(earth);

  // Surfaces: slabs with holes cut where interventions sit, so rain gardens can be sunken.
  const ripples: THREE.ShaderMaterial[] = [];
  const waterMat = (name: string, cell = 1.6) => {
    const m = rippleMaterial(pal.water, cell);
    m.name = name;
    ripples.push(m);
    return m;
  };
  const films = new Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>>();
  for (const s of site.surfaces) {
    const top = TOP[s.kind];
    if (s.kind === "roof") {
      const h = top - SLAB_BOTTOM;
      const walls = mat(pal.wall), roof = mat(pal.kind.roof);
      const b = new THREE.Mesh(new THREE.BoxGeometry(s.rect.width, h, s.rect.height), [walls, walls, roof, walls, walls, walls]);
      b.position.set(s.rect.x + s.rect.width / 2 - cx, SLAB_BOTTOM + h / 2, s.rect.y + s.rect.height / 2 - cz);
      b.castShadow = true;
      b.receiveShadow = true;
      group.add(b);
      addWindows(group, s.rect, cx, cz, pal, xrayMats);
      pick(b, { title: s.name, detail: `${KIND_NAME.roof} · ${fmt(area(s.rect))} m² · drains to ${s.drains_to}` }, true);
    } else {
      const shape = rectShape(s.rect, cx, cz);
      // Sunken or flush features are cut into the surface; barrels just stand on it.
      for (const i of items) if (CUT_INTO_SURFACE.has(i.kind) && contains(s.rect, i.rect)) shape.holes.push(rectPath(i.rect, cx, cz));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: top - SLAB_BOTTOM, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, SLAB_BOTTOM, 0);
      const m = new THREE.Mesh(geo, [mat(pal.kind[s.kind]), mat(shade(pal.kind[s.kind], 0.72))]);
      m.receiveShadow = true;
      group.add(m);
      pick(m, { title: s.name, detail: `${KIND_NAME[s.kind]} · ${fmt(area(s.rect))} m² · ${s.slope_pct}% slope · drains to ${s.drains_to}` }, true);
      if (s.kind === "parking" || s.kind === "road") addStripes(group, s, items, cx, cz, pal, xrayMats);
    }
    // Runoff film, faded in during storm playback.
    const film = new THREE.Mesh(flatGeometry(rectShape(s.rect, cx, cz)), waterMat(s.id));
    film.position.y = top + 0.03;
    film.renderOrder = 2;
    group.add(film);
    films.set(s.id, film);
    labels.push({ id: s.id, text: s.name, kind: "surface",
      position: new THREE.Vector3(s.rect.x + s.rect.width / 2 - cx, top + 0.5, s.rect.y + s.rect.height / 2 - cz) });
  }

  // Interventions.
  for (const i of items) {
    const host = site.surfaces.find((s) => contains(s.rect, i.rect));
    const hostTop = host ? TOP[host.kind] : 0;
    const c = new THREE.Vector3(i.rect.x + i.rect.width / 2 - cx, 0, i.rect.y + i.rect.height / 2 - cz);
    const takes = isCapturing(i) ? ` · takes runoff from ${fmt(i.captured_area_m2)} m² of ${i.contributing_surface_id || "—"}` : "";
    if (i.kind === "rain_garden") {
      const top = hostTop - i.ponding_depth_mm / 1000;
      const h = Math.max(top - SLAB_BOTTOM, 0.05);
      const basin = new THREE.Mesh(new THREE.BoxGeometry(i.rect.width, h, i.rect.height), mat(shade(pal.rgFill, 0.8)));
      basin.position.set(c.x, SLAB_BOTTOM + h / 2, c.z);
      basin.receiveShadow = true;
      group.add(basin);
      addPlants(group, i, top, cx, cz, pal.rgFill, pal.rgPlant);
      pick(basin, { interventionId: i.id, title: `${i.id} · Rain garden`,
        detail: `${fmt(area(i.rect))} m² · ${i.ponding_depth_mm} mm ponding${takes}` });
      labels.push({ id: i.id, text: i.id, kind: "item", position: new THREE.Vector3(c.x, hostTop + 1.4, c.z) });
    } else if (i.kind === "permeable_pavement") {
      const top = hostTop + 0.02;
      const h = top - SLAB_BOTTOM;
      const paverTex = paverTexture(pal, i.rect);
      const topMat = mat(pal.ppFill, paverTex ? { map: paverTex } : {});
      const side = mat(shade(pal.ppFill, 0.7));
      const pp = new THREE.Mesh(new THREE.BoxGeometry(i.rect.width, h, i.rect.height), [side, side, topMat, side, side, side]);
      pp.position.set(c.x, SLAB_BOTTOM + h / 2, c.z);
      pp.receiveShadow = true;
      group.add(pp);
      pick(pp, { interventionId: i.id, title: `${i.id} · Permeable pavement`,
        detail: `${fmt(area(i.rect))} m² · ${i.storage_depth_mm} mm gravel storage${i.runon_area_m2 ? ` · ${fmt(i.runon_area_m2)} m² run-on` : ""}` });
      labels.push({ id: i.id, text: i.id, kind: "item", position: new THREE.Vector3(c.x, top + 1, c.z) });
    } else if (i.kind === "green_roof") {
      // A planted layer on the roof, as thick as its growing medium and drainage mat.
      const h = (i.soil_depth_mm + i.drain_mat_mm) / 1000 + 0.05;
      const tex = speckleTexture(pal.grFill, pal.grPlant, i.rect, 1.5);
      const side = mat(shade(pal.grFill, 0.6));
      const layer = new THREE.Mesh(new THREE.BoxGeometry(i.rect.width, h, i.rect.height),
        [side, side, mat(pal.grFill, tex ? { map: tex } : {}), side, side, side]);
      layer.position.set(c.x, hostTop + h / 2, c.z);
      layer.receiveShadow = true;
      layer.castShadow = true;
      group.add(layer);
      addPlants(group, i, hostTop + h, cx, cz, pal.grFill, pal.grPlant, 0.35, 2.4);
      pick(layer, { interventionId: i.id, title: `${i.id} · Green roof`,
        detail: `${fmt(area(i.rect))} m² · ${i.soil_depth_mm} mm growing medium · holds the rain that falls on it` });
      labels.push({ id: i.id, text: i.id, kind: "item", position: new THREE.Vector3(c.x, hostTop + 1.4, c.z) });
    } else if (i.kind === "infiltration_trench") {
      // Stone fill a little below the surrounding ground.
      const top = hostTop - 0.06;
      const h = top - SLAB_BOTTOM;
      const tex = speckleTexture(pal.itFill, pal.itStroke, i.rect, 0.6);
      const side = mat(shade(pal.itFill, 0.7));
      const trench = new THREE.Mesh(new THREE.BoxGeometry(i.rect.width, h, i.rect.height),
        [side, side, mat(pal.itFill, tex ? { map: tex } : {}), side, side, side]);
      trench.position.set(c.x, SLAB_BOTTOM + h / 2, c.z);
      trench.receiveShadow = true;
      group.add(trench);
      pick(trench, { interventionId: i.id, title: `${i.id} · Infiltration trench`,
        detail: `${fmt(area(i.rect))} m² · ${i.storage_depth_mm} mm of stone${takes}` });
      labels.push({ id: i.id, text: i.id, kind: "item", position: new THREE.Vector3(c.x, hostTop + 1.2, c.z) });
    } else {
      // Round tanks standing on the ground, as many as fit along the footprint's long side.
      const long = Math.max(i.rect.width, i.rect.height), short = Math.min(i.rect.width, i.rect.height);
      const n = Math.max(1, Math.round(long / short));
      const r = Math.min(short, long / n) * 0.45, h = i.height_mm / 1000;
      const tankMat = mat(pal.rbFill, { roughness: 0.55, metalness: 0.15 });
      const lidMat = mat(pal.rbStroke, { roughness: 0.6 });
      for (let k = 0; k < n; k++) {
        const f = (k + 0.5) / n - 0.5;
        const x = c.x + (i.rect.width >= i.rect.height ? f * long : 0);
        const z = c.z + (i.rect.width >= i.rect.height ? 0 : f * long);
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 28), tankMat);
        tank.position.set(x, hostTop + h / 2, z);
        tank.castShadow = true;
        tank.receiveShadow = true;
        const lid = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.03, r * 1.03, 0.05, 28), lidMat);
        lid.position.set(x, hostTop + h + 0.025, z);
        group.add(tank, lid);
        pick(tank, { interventionId: i.id, title: `${i.id} · Rain barrel / cistern`,
          detail: `${fmt(area(i.rect) * h, 1)} m³ tank · empties ${fmt(i.drain_delay_hours)} h after the rain stops${takes}` });
      }
      labels.push({ id: i.id, text: i.id, kind: "item", position: new THREE.Vector3(c.x, hostTop + h + 0.9, c.z) });
    }
  }

  // Drains: a grate at the surface and a shaft down to the pipes (seen in X-ray).
  const shaftMat = new THREE.MeshStandardMaterial({ color: pal.wall, roughness: 0.8 });
  const grateMat = new THREE.MeshStandardMaterial({ color: pal.node, roughness: 0.5, metalness: 0.3 });
  const puddles = new Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>>();
  for (const inlet of site.inlets) {
    const n = under.nodes.get(inlet.id)!;
    const s = surfaceAt(site, inlet.x, inlet.y);
    const ground = s && s.kind !== "roof" ? TOP[s.kind] : 0;
    const r = Math.max(0.6, n.maxDiameter * PIPE_SCALE * 0.8);
    const shaftTop = ground - 0.02; // just under the surface, so the two don't flicker
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r, n.depth + shaftTop, 20), shaftMat);
    shaft.position.set(n.x, (shaftTop - n.depth) / 2, n.z);
    group.add(shaft);
    const grate = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 1.4), grateMat);
    grate.position.set(n.x, ground + 0.04, n.z);
    group.add(grate);
    pick(grate, { title: `${inlet.id} · ${inlet.name}`,
      detail: `Drain · rim ${inlet.rim_elev_m} m, invert ${inlet.invert_elev_m} m (${fmt(n.depth, 1)} m deep)` });
    const puddle = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), waterMat(`puddle-${inlet.id}`, 0.9));
    puddle.position.set(n.x, ground + 0.05, n.z);
    puddle.visible = false;
    puddle.renderOrder = 3;
    group.add(puddle);
    puddles.set(inlet.id, puddle);
    labels.push({ id: inlet.id, text: inlet.id, kind: "node", position: new THREE.Vector3(n.x, ground + 1.2, n.z) });
  }

  // Pipes.
  // Each pipe is a glassy shell with a core of water inside: the core's height follows how full
  // the pipe is, and bands slide along it, downstream, faster as the flow rises.
  const pipeMats = new Map<string, THREE.MeshStandardMaterial>();
  const cores = new Map<string, { mesh: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>; radius: number; mid: THREE.Vector3; phase: number; speed: number }>();
  for (const p of under.pipes) {
    const len = p.from.distanceTo(p.to);
    const mid = p.from.clone().add(p.to).multiplyScalar(0.5);
    const along = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), p.to.clone().sub(p.from).normalize());
    const m = new THREE.MeshStandardMaterial({ color: pal.pipe, roughness: 0.25, emissive: pal.pipe, emissiveIntensity: 0.15,
      transparent: true, opacity: 0.45, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(p.radius, p.radius, len, 24, 1, true), m);
    mesh.position.copy(mid);
    mesh.quaternion.copy(along);
    mesh.renderOrder = 6;
    group.add(mesh);
    pipeMats.set(p.id, m);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, len, 16), flowMaterial(pal.pipe, len));
    core.position.copy(mid);
    core.quaternion.copy(along);
    core.renderOrder = 5;
    core.visible = false;
    group.add(core);
    cores.set(p.id, { mesh: core, radius: p.radius * 0.92, mid, phase: 0, speed: 0 });
    const src = site.pipes.find((x) => x.id === p.id)!;
    pick(mesh, { title: `${p.id} · Pipe`, detail: `${src.from_node} → ${src.to_node} · ${fmt(src.length_m)} m · ${fmt(p.diameter * 1000)} mm diameter` });
  }

  // Outfall: a headwall at the site edge, with a stream leaving it during the storm.
  const of = under.nodes.get(site.outfall.id)!;
  const head = new THREE.Mesh(new THREE.BoxGeometry(2.4, of.depth + 0.4, 2.4), shaftMat);
  head.position.set(of.x, (0.4 - of.depth) / 2, of.z);
  group.add(head);
  pick(head, { title: `${site.outfall.id} · ${site.outfall.name}`, detail: `Outfall · invert ${site.outfall.invert_elev_m} m` });
  labels.push({ id: site.outfall.id, text: site.outfall.id, kind: "node", position: new THREE.Vector3(of.x, 1.4, of.z) });
  // Water leaves straight out from the nearest site edge, into a shallow channel when the outfall sits on that edge.
  const gaps = [site.width_m / 2 + of.x, site.width_m / 2 - of.x, site.height_m / 2 + of.z, site.height_m / 2 - of.z];
  const edge = gaps.indexOf(Math.min(...gaps));
  const dir = [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1)][edge];
  const onEdge = gaps[edge] <= 4;
  const exit = new THREE.Vector3(of.x, 0, of.z).addScaledVector(dir, gaps[edge]); // where the boundary is
  let channel: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  const channelLength = Math.max(site.width_m, site.height_m) * 0.7;
  if (onEdge) {
    channel = new THREE.Mesh(new THREE.PlaneGeometry(3.2, channelLength).rotateX(-Math.PI / 2), waterMat("channel", 1.2));
    channel.position.copy(exit).addScaledVector(dir, channelLength / 2 + 0.2).setY(-0.01);
    channel.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    channel.material.uniforms.uLevel.value = 1;
    channel.renderOrder = 2;
    channel.userData.scenery = true;
    group.add(channel);
  }
  addSurroundings(group, site, pal, onEdge ? { from: exit, dir, length: channelLength } : null);
  const spray = createSpray(new THREE.Vector3(of.x, 0.35, of.z).addScaledVector(dir, gaps[edge] + 0.6), dir, pal.water, -0.05);
  group.add(spray.points);
  let outflowLevel = 0;

  // Runoff running across each surface to its drain, or into the rain garden that captures it.
  const flow = createRunoffFlow(site, design, pal);
  group.add(flow.points);
  const levels = new Map<string, number>();

  const setXray = (on: boolean) => {
    for (const m of xrayMats) {
      m.transparent = on;
      m.opacity = on ? 0.16 : 1;
      m.depthWrite = !on;
      m.needsUpdate = true;
    }
    // Draw pipes after the see-through layers and over them, so their status colours stay true.
    for (const m of pipeMats.values()) m.depthTest = !on;
    for (const c of cores.values()) c.mesh.material.depthTest = !on;
  };

  const applyStep = (result: SimulationResult | null, t: number, scales: StormScales | null) => {
    const ts = result?.series;
    const at = (values: number[] | undefined) => (values ? sample(values, t) : 0);
    const areas = new Map(result?.surfaces.map((s) => [s.surface_id, Math.max(s.modelled_area_m2, 1)]) ?? []);
    for (const [id, film] of films) {
      const q = at(ts?.surface_runoff_m3s[id]);
      const k = ts && scales ? Math.min(q / (areas.get(id) ?? 1) / scales.intensity, 1) : 0;
      film.material.uniforms.uLevel.value = k;
      levels.set(id, k);
    }
    for (const [id, m] of pipeMats) {
      const cap = at(ts?.pipe_capacity[id]);
      const color = !ts ? pal.pipe : cap >= 0.999 ? pal.critical : cap >= 0.9 ? pal.warning : pal.pipe;
      m.color.set(color);
      m.emissive.set(color);
      m.emissiveIntensity = ts ? 0.15 + 0.6 * Math.min(cap, 1) : 0.15;
      const core = cores.get(id)!;
      const flow = Math.abs(at(ts?.pipe_flow_m3s[id]));
      core.mesh.visible = !!ts && cap > 0.01;
      // Water sits at the bottom of a part-full pipe.
      const r = core.radius * Math.sqrt(Math.min(Math.max(cap, 0.05), 1));
      core.mesh.scale.set(r, 1, r);
      core.mesh.position.copy(core.mid).setY(core.mid.y - (core.radius - r));
      core.mesh.material.uniforms.uColor.value.set(color);
      core.speed = scales ? 1.5 + 9 * Math.min(flow / scales.pipeFlow, 1) : 0;
    }
    for (const [id, puddle] of puddles) {
      const q = at(ts?.node_flooding_m3s[id]);
      puddle.visible = q > 1e-6;
      const r = 2 + 10 * Math.sqrt(q / (scales?.flooding ?? 1));
      puddle.scale.set(r, 1, r);
      puddle.material.uniforms.uLevel.value = 1;
    }
    const out = at(ts?.outfall_m3s);
    outflowLevel = scales && out > 1e-5 ? Math.sqrt(Math.min(out / scales.outflow, 1)) : 0;
  };

  const tick = (dt: number, rain: number) => {
    for (const m of ripples) {
      m.uniforms.uTime.value += dt;
      m.uniforms.uRain.value = rain;
    }
    for (const c of cores.values()) {
      c.phase += dt * c.speed;
      c.mesh.material.uniforms.uPhase.value = c.phase;
    }
    spray.update(dt, outflowLevel);
    flow.update(dt, levels);
  };

  // Labels are placed in this order and later ones hide when they collide, so features win over surfaces.
  const rank = { item: 0, node: 1, surface: 2 } as const;
  labels.sort((a, b) => rank[a.kind] - rank[b.kind]);

  return {
    group, pickables, labels, setXray, applyStep, tick,
    bounds: { width: site.width_m, depth: site.height_m, height: Math.max(...site.surfaces.map((s) => TOP[s.kind]), 1) },
    dispose: () => group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const m of mats) {
        (m as THREE.MeshStandardMaterial).map?.dispose();
        m.dispose();
      }
    }),
  };
}

// ── Rain, spray and water shaders ────────────────────────────────────────

export interface Rain {
  /** The falling streaks and the splashes where they land; add both to the scene. */
  object: THREE.Group;
  lines: THREE.LineSegments;
  update(dt: number, intensity: number): void;
  dispose(): void;
}

/** Height of whatever a raindrop would land on at plan position (x, z), in scene coordinates. */
export function groundHeightAt(site: Site): (x: number, z: number) => number {
  const cx = site.width_m / 2, cz = site.height_m / 2;
  return (x, z) => {
    const s = surfaceAt(site, x + cx, z + cz);
    return s ? TOP[s.kind] : -0.03;
  };
}

/**
 * Rain falling from above: thin, pale streaks of varying length that fade at both ends (as a
 * camera's motion blur would show them), landing on roofs and the ground with a small splash.
 * `intensity` 0–1 sets how many fall and how much the wind slants them.
 */
export function createRain(width: number, depth: number, color: string, count = 7000,
                           heightAt: (x: number, z: number) => number = () => 0): Rain {
  const margin = 30; // rain beyond the boundary too, so the edge of the storm isn't visible
  const w = width + 2 * margin, d = depth + 2 * margin;
  const ceiling = 60;
  const seed = rng(7);
  const tint = new THREE.Color(color).lerp(new THREE.Color("#ffffff"), 0.55);
  // Three vertices per drop as two segments: faint top, brightest just above the bottom, faint bottom.
  const pos = new Float32Array(count * 12);
  const col = new Float32Array(count * 16);
  const len = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = 0.32 + seed() * 0.3;
    col.set([tint.r, tint.g, tint.b, 0, tint.r, tint.g, tint.b, a, tint.r, tint.g, tint.b, a, tint.r, tint.g, tint.b, a * 0.2], i * 16);
    len[i] = 0.9 + seed() * 1.1;
  }
  const heads = Array.from({ length: count }, () => {
    const x = (seed() - 0.5) * w, z = (seed() - 0.5) * d;
    return { x, z, y: heightAt(x, z) + seed() * ceiling, floor: heightAt(x, z), v: 26 + seed() * 8 };
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 4));
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;

  // Splashes: a few tiny droplets thrown up where a drop lands, falling back within a moment.
  const SPLASH = 3500;
  const sPos = new Float32Array(SPLASH * 3).fill(-1e4), sVel = new Float32Array(SPLASH * 3);
  const sFloor = new Float32Array(SPLASH), sLife = new Float32Array(SPLASH);
  const sGeo = new THREE.BufferGeometry();
  sGeo.setAttribute("position", new THREE.BufferAttribute(sPos, 3));
  const sprite = dotTexture();
  const splashes = new THREE.Points(sGeo, new THREE.PointsMaterial({
    color: tint, size: 0.16, transparent: true, opacity: 0.75, depthWrite: false,
    ...(sprite ? { map: sprite, alphaTest: 0.05 } : {}),
  }));
  splashes.frustumCulled = false;
  let nextSplash = 0;
  const splash = (x: number, y: number, z: number) => {
    for (let k = 0; k < 3; k++) {
      const i = nextSplash;
      nextSplash = (nextSplash + 1) % SPLASH;
      const ang = seed() * Math.PI * 2, out = 0.6 + seed() * 0.9;
      sPos.set([x, y + 0.02, z], i * 3);
      sVel.set([Math.cos(ang) * out, 1.2 + seed() * 1.3, Math.sin(ang) * out], i * 3);
      sFloor[i] = y;
      sLife[i] = 0.35;
    }
  };

  const object = new THREE.Group();
  object.add(lines, splashes);
  let slant = 0.05;
  const write = (n: number) => {
    for (let i = 0; i < n; i++) {
      const h = heads[i], l = len[i];
      // bottom at the drop, top trailing behind it up the slant
      const tx = h.x - slant * l, ty = h.y + l;
      const mx = h.x - slant * l * 0.25, my = h.y + l * 0.25;
      pos.set([tx, ty, h.z, mx, my, h.z, mx, my, h.z, h.x, h.y, h.z], i * 12);
    }
    geo.attributes.position.needsUpdate = true;
  };
  write(count);
  return {
    object, lines,
    update(dt, intensity) {
      const k = Math.min(Math.max(intensity, 0), 1);
      const n = Math.round(count * k);
      geo.setDrawRange(0, n * 4);
      lines.visible = n > 0;
      if (dt > 0) {
        slant = 0.04 + 0.22 * k; // heavier rain, stronger gusts
        for (let i = 0; i < n; i++) {
          const h = heads[i];
          h.y -= h.v * dt;
          h.x += slant * h.v * dt;
          if (h.y <= h.floor) {
            if (seed() < 0.5) splash(h.x, h.floor, h.z);
            h.x = (seed() - 0.5) * w;
            h.z = (seed() - 0.5) * d;
            h.floor = heightAt(h.x, h.z);
            h.y = h.floor + ceiling * (0.85 + seed() * 0.15);
          }
        }
        if (n) write(n);
        let live = 0;
        for (let i = 0; i < SPLASH; i++) {
          if (sLife[i] <= 0) continue;
          sLife[i] -= dt;
          sVel[i * 3 + 1] -= 9.8 * dt;
          sPos[i * 3] += sVel[i * 3] * dt;
          sPos[i * 3 + 1] = Math.max(sPos[i * 3 + 1] + sVel[i * 3 + 1] * dt, sFloor[i]);
          sPos[i * 3 + 2] += sVel[i * 3 + 2] * dt;
          if (sLife[i] <= 0) sPos[i * 3 + 1] = -1e4;
          else live++;
        }
        sGeo.attributes.position.needsUpdate = true;
        splashes.visible = live > 0;
      }
    },
    dispose() {
      geo.dispose(); mat.dispose(); sGeo.dispose();
      (splashes.material as THREE.PointsMaterial).map?.dispose();
      (splashes.material as THREE.Material).dispose();
    },
  };
}

export interface Spray { points: THREE.Points; update(dt: number, level: number): void }

/** Droplets thrown out of the outfall and falling off the site edge; `level` 0–1 sets the flow. */
export function createSpray(origin: THREE.Vector3, dir: THREE.Vector3, color: string, floor: number, count = 900): Spray {
  const pos = new Float32Array(count * 3).fill(-1e4);
  const vel = new Float32Array(count * 3);
  const alive = new Uint8Array(count);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({
    color, size: 0.32, transparent: true, opacity: 0.85, depthWrite: false,
  }));
  points.frustumCulled = false;
  points.visible = false;
  const side = new THREE.Vector3(-dir.z, 0, dir.x);
  const rand = rng(11);
  let next = 0, carry = 0, live = 0;
  return {
    points,
    update(dt, level) {
      if (dt <= 0) return;
      carry += dt * level * 700; // droplets per second at the run's peak outflow
      while (carry >= 1) {
        carry -= 1;
        const i = next;
        next = (next + 1) % count;
        if (!alive[i]) live++;
        alive[i] = 1;
        const spread = (rand() - 0.5) * 0.6, speed = 2.5 + 5 * level * (0.8 + rand() * 0.4);
        pos.set([origin.x + side.x * spread, origin.y + (rand() - 0.5) * 0.3, origin.z + side.z * spread], i * 3);
        vel.set([dir.x * speed + side.x * (rand() - 0.5), 0.8 + rand() * 1.2, dir.z * speed + side.z * (rand() - 0.5)], i * 3);
      }
      for (let i = 0; i < count; i++) {
        if (!alive[i]) continue;
        vel[i * 3 + 1] -= 9.8 * dt;
        pos[i * 3] += vel[i * 3] * dt;
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        if (pos[i * 3 + 1] < floor) { alive[i] = 0; live--; pos[i * 3 + 1] = -1e4; }
      }
      geo.attributes.position.needsUpdate = true;
      points.visible = live > 0;
    },
  };
}

/**
 * Sheet water: a tint whose strength is `uLevel` (runoff 0–1), with raindrop rings that
 * appear only where water is running off, and more of them as `uRain` rises.
 */
function rippleMaterial(color: string, cell: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) }, uLevel: { value: 0 }, uTime: { value: 0 },
      uRain: { value: 0 }, uCell: { value: cell },
    },
    vertexShader: /* glsl */ `
      varying vec2 vXZ;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vXZ = w.xz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uLevel, uTime, uRain, uCell;
      varying vec2 vXZ;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        if (uLevel < 0.002) discard;
        vec2 p = vXZ / uCell;
        float rings = 0.0;
        for (int i = -1; i <= 1; i++) {
          for (int j = -1; j <= 1; j++) {
            vec2 cell = floor(p) + vec2(float(i), float(j));
            float h = hash(cell);
            if (h > uRain) continue;
            float phase = fract(uTime * 0.85 + h * 7.0);
            vec2 c = cell + 0.5 + (vec2(hash(cell + 3.1), hash(cell + 7.7)) - 0.5) * 0.7;
            float d = length(p - c);
            rings += smoothstep(0.08, 0.0, abs(d - phase * 0.9)) * (1.0 - phase) * (1.0 - phase);
          }
        }
        rings = min(rings, 1.0);
        float sheen = 0.5 + 0.5 * sin(vXZ.x * 0.3 + vXZ.y * 0.2 + uTime * 0.7);
        float a = uLevel * (0.28 + 0.1 * sheen) + rings * 0.6 * sqrt(uLevel);
        gl_FragColor = vec4(mix(uColor, vec3(1.0), rings * 0.65), min(a, 0.95));
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
}

/** Water inside a pipe: bands that slide downstream as `uPhase` (metres travelled) grows. */
function flowMaterial(color: string, length: number) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uPhase: { value: 0 }, uLen: { value: length } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uPhase, uLen;
      varying vec2 vUv;
      void main() {
        float s = fract((vUv.y * uLen - uPhase) / 3.0);
        float band = smoothstep(0.0, 0.2, s) * smoothstep(0.7, 0.35, s);
        gl_FragColor = vec4(mix(uColor * 0.7, mix(uColor, vec3(1.0), 0.6), band), 0.95);
        #include <colorspace_fragment>
      }`,
    transparent: true,
  });
}

// ── Surroundings and runoff paths ────────────────────────────────────────

/**
 * Scenery around the site: meadow ground that fades into the horizon, with trees in a band
 * around the boundary, leaving the outfall channel clear. None of it is part of the model,
 * and it is never pickable.
 */
function addSurroundings(group: THREE.Group, site: Site, pal: Palette,
                         channel: { from: THREE.Vector3; dir: THREE.Vector3; length: number } | null) {
  const w = site.width_m, d = site.height_m, span = Math.max(w, d);
  const R = span * 3;
  // A disc with a hole the size of the site, just below paving level so the site sits flush.
  const shape = new THREE.Shape().absarc(0, 0, R, 0, Math.PI * 2, false);
  shape.holes.push(new THREE.Path().moveTo(-w / 2, -d / 2).lineTo(-w / 2, d / 2).lineTo(w / 2, d / 2).lineTo(w / 2, -d / 2).closePath());
  const geo = new THREE.ShapeGeometry(shape, 64);
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + R) / (2 * R), (pos.getY(i) + R) / (2 * R));
  geo.rotateX(-Math.PI / 2);
  const fade = radialFade();
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: pal.ground, roughness: 1, ...(fade ? { alphaMap: fade, transparent: true, depthWrite: true } : {}),
  }));
  ground.position.y = -0.03;
  ground.receiveShadow = true;
  ground.userData.scenery = true;
  group.add(ground);

  // Low-poly trees, scattered deterministically in a band 4 m to ~0.45 × span outside the boundary.
  const rand = rng(hash(site.id) + 3);
  const spots: THREE.Vector3[] = [];
  const reach = Math.max(span * 0.45, 25);
  for (let tries = 0; spots.length < 140 && tries < 3000; tries++) {
    const x = (rand() - 0.5) * (w + 2 * reach), z = (rand() - 0.5) * (d + 2 * reach);
    const gap = Math.max(Math.abs(x) - w / 2, Math.abs(z) - d / 2);
    if (gap < 4 || gap > reach) continue;
    if (spots.some((p) => Math.hypot(p.x - x, p.z - z) < 5)) continue;
    if (channel) { // keep the banks clear
      const rx = x - channel.from.x, rz = z - channel.from.z;
      const t = rx * channel.dir.x + rz * channel.dir.z;
      if (t > -4 && t < channel.length && Math.abs(rx * channel.dir.z - rz * channel.dir.x) < 6) continue;
    }
    spots.push(new THREE.Vector3(x, 0, z));
  }
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.28, 1, 6),
    new THREE.MeshStandardMaterial({ color: "#6b4f37", roughness: 1 }), spots.length);
  const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), spots.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color(), base = new THREE.Color(pal.tree);
  spots.forEach((p, i) => {
    const h = 3.5 + rand() * 4, r = 1.6 + rand() * 1.8;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2);
    m.compose(new THREE.Vector3(p.x, h * 0.35, p.z), q, new THREE.Vector3(1, h * 0.7, 1));
    trunk.setMatrixAt(i, m);
    m.compose(new THREE.Vector3(p.x, h * 0.7 + r * 0.6, p.z), q, new THREE.Vector3(r, r * (1 + rand() * 0.4), r));
    crown.setMatrixAt(i, m);
    // Vary brightness by scaling, not offsetting: dark-theme greens are near zero and would clip to black.
    crown.setColorAt(i, c.copy(base).offsetHSL((rand() - 0.5) * 0.05, (rand() - 0.5) * 0.1, 0).multiplyScalar(0.75 + rand() * 0.5));
  });
  for (const t of [trunk, crown]) {
    t.castShadow = true;
    t.userData.scenery = true;
    group.add(t);
  }
}

/** White in the middle fading to black at the rim, used as an alpha map; skipped outside the browser. */
function radialFade(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  if (!g) return null;
  const grad = g.createRadialGradient(128, 128, 30, 128, 128, 128);
  grad.addColorStop(0, "#fff");
  grad.addColorStop(0.45, "#fff");
  grad.addColorStop(1, "#000");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

export interface RunoffFlow { points: THREE.Group; update(dt: number, levels: Map<string, number>): void }

/**
 * Droplets that run from random points on each surface to where its runoff goes: its drain,
 * or, for the share a rain garden captures, that garden. Roof water runs to the roof edge
 * nearest the drain and drops to the ground first. The spawn rate follows each surface's
 * SWMM runoff (`levels`, 0–1).
 */
export function createRunoffFlow(site: Site, design: Design | null, pal: Palette, count = 2500): RunoffFlow {
  const cx = site.width_m / 2, cz = site.height_m / 2;
  const drains = new Map(site.inlets.map((i) => {
    const s = surfaceAt(site, i.x, i.y);
    return [i.id, new THREE.Vector3(i.x - cx, (s && s.kind !== "roof" ? TOP[s.kind] : 0) + 0.12, i.y - cz)];
  }));
  const captures = new Map<string, { share: number; to: THREE.Vector3; spout: boolean }[]>();
  for (const i of design?.interventions ?? []) {
    if (!isCapturing(i)) continue;
    const src = site.surfaces.find((s) => s.id === i.contributing_surface_id);
    const host = site.surfaces.find((s) => contains(s.rect, i.rect));
    if (!src) continue;
    // A barrel is fed by a downspout into its lid; gardens and trenches at ground level.
    const lift = i.kind === "rain_barrel" ? i.height_mm / 1000 : 0.05;
    const to = new THREE.Vector3(i.rect.x + i.rect.width / 2 - cx, (host ? TOP[host.kind] : 0) + lift, i.rect.y + i.rect.height / 2 - cz);
    captures.set(src.id, [...(captures.get(src.id) ?? []), { share: i.captured_area_m2 / area(src.rect), to, spout: i.kind === "rain_barrel" }]);
  }

  const MAX_PTS = 4;
  const way = new Float32Array(count * MAX_PTS * 3); // each droplet's waypoints
  // Float64: with Float32, small steps near the end of a long segment round away and never finish it.
  const nPts = new Uint8Array(count), seg = new Uint8Array(count), along = new Float64Array(count);
  const speed = new Float32Array(count), alive = new Uint8Array(count);
  const pos = new Float32Array(count * 3).fill(-1e4); // each droplet's current position
  const tint = new THREE.Color(pal.water).lerp(new THREE.Color("#ffffff"), 0.35);
  // Each droplet is drawn only as a short glint of moving water, faded at both ends: no dot, no head.
  const trail = new Float32Array(count * 12).fill(-1e4);
  const trailCol = new Float32Array(count * 16);
  for (let i = 0; i < count; i++) {
    trailCol.set([tint.r, tint.g, tint.b, 0, tint.r, tint.g, tint.b, 0.55, tint.r, tint.g, tint.b, 0.55, tint.r, tint.g, tint.b, 0], i * 16);
  }
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trail, 3));
  trailGeo.setAttribute("color", new THREE.BufferAttribute(trailCol, 4));
  const streaks = new THREE.LineSegments(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
  streaks.frustumCulled = false;
  streaks.renderOrder = 4;
  const points = new THREE.Group();
  points.add(streaks);
  points.visible = false;
  const TRAIL = 1.8; // metres
  const rand = rng(23);
  const carry = new Map<string, number>();
  let next = 0, live = 0;

  const spawn = (s: Surface) => {
    const i = next;
    next = (next + 1) % count;
    if (!alive[i]) live++;
    alive[i] = 1;
    const top = TOP[s.kind] + 0.06;
    const start = new THREE.Vector3(s.rect.x + rand() * s.rect.width - cx, top, s.rect.y + rand() * s.rect.height - cz);
    let end = drains.get(s.drains_to) ?? start;
    let spout = false;
    let roll = rand();
    for (const c of captures.get(s.id) ?? []) {
      if (roll < c.share) { end = c.to; spout = c.spout; break; }
      roll -= c.share;
    }
    const pts = [start];
    if (s.kind === "roof") {
      // To the roof edge nearest the destination, then straight down.
      const x0 = s.rect.x - cx, x1 = x0 + s.rect.width, z0 = s.rect.y - cz, z1 = z0 + s.rect.height;
      const ex = Math.min(Math.max(end.x, x0), x1), ez = Math.min(Math.max(end.z, z0), z1);
      const dx = Math.min(ex - x0, x1 - ex), dz = Math.min(ez - z0, z1 - ez);
      const edge = dx < dz ? new THREE.Vector3(ex - x0 < x1 - ex ? x0 : x1, top, start.z)
        : new THREE.Vector3(start.x, top, ez - z0 < z1 - ez ? z0 : z1);
      // Down the wall to the ground, or down a downspout to just above a barrel's lid.
      pts.push(edge, new THREE.Vector3(edge.x, spout ? end.y + 0.3 : 0.1, edge.z));
    }
    pts.push(end);
    pts.forEach((p, k) => way.set([p.x, p.y, p.z], (i * MAX_PTS + k) * 3));
    nPts[i] = pts.length;
    seg[i] = 0;
    along[i] = 0;
    speed[i] = 5 + rand() * 4;
    pos.set([start.x, start.y, start.z], i * 3);
    trail.fill(0, i * 12, i * 12 + 12);
    for (let v = 0; v < 4; v++) trail.set([start.x, start.y, start.z], i * 12 + v * 3);
  };

  return {
    points,
    update(dt, levels) {
      if (dt <= 0) return;
      for (const s of site.surfaces) {
        const k = levels.get(s.id) ?? 0;
        if (k <= 0.01) continue;
        const rate = k * Math.min(Math.sqrt(area(s.rect)) * 6, 360); // droplets per second
        let c = (carry.get(s.id) ?? 0) + rate * dt;
        for (; c >= 1; c--) spawn(s);
        carry.set(s.id, c);
      }
      for (let i = 0; i < count; i++) {
        if (!alive[i]) continue;
        let left = speed[i] * dt;
        while (left > 0 && seg[i] < nPts[i] - 1) {
          const a = (i * MAX_PTS + seg[i]) * 3, b = a + 3;
          const len = Math.hypot(way[b] - way[a], way[b + 1] - way[a + 1], way[b + 2] - way[a + 2]) || 1e-6;
          const step = Math.min(left, len - along[i]);
          along[i] += step;
          left -= step;
          const f = along[i] / len;
          pos.set([way[a] + (way[b] - way[a]) * f, way[a + 1] + (way[b + 1] - way[a + 1]) * f, way[a + 2] + (way[b + 2] - way[a + 2]) * f], i * 3);
          const back = Math.min(TRAIL, along[i]) / len;
          const hx = pos[i * 3], hy = pos[i * 3 + 1], hz = pos[i * 3 + 2];
          const tx = hx - (way[b] - way[a]) * back, ty = hy - (way[b + 1] - way[a + 1]) * back, tz = hz - (way[b + 2] - way[a + 2]) * back;
          const mx = (hx + tx) / 2, my = (hy + ty) / 2, mz = (hz + tz) / 2;
          trail.set([tx, ty, tz, mx, my, mz, mx, my, mz, hx, hy, hz], i * 12);
          if (along[i] >= len - 1e-4) { seg[i]++; along[i] = 0; }
        }
        if (seg[i] >= nPts[i] - 1) {
          alive[i] = 0;
          live--;
          pos[i * 3 + 1] = -1e4;
          for (let v = 1; v < 12; v += 3) trail[i * 12 + v] = -1e4;
        }
      }
      trailGeo.attributes.position.needsUpdate = true;
      points.visible = live > 0;
    },
  };
}

/** A soft round dot for point sprites; skipped outside the browser. */
function dotTexture(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  if (!g) return null;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.6, "rgba(255,255,255,0.8)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

/** Linear interpolation into a time series at fractional step `t`. */
export function sample(values: number[], t: number): number {
  if (!values.length) return 0;
  const i = Math.min(Math.max(Math.floor(t), 0), values.length - 1);
  const j = Math.min(i + 1, values.length - 1);
  const f = Math.min(Math.max(t - i, 0), 1);
  return values[i] + (values[j] - values[i]) * f;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const area = (r: Rect) => r.width * r.height;
const fmt = (v: number, digits = 0) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v);

/** Deterministic random numbers, so plants and rain don't jump around between rebuilds. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const hash = (text: string) => [...text].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 17);

// Shapes live in the XY plane with y = −z; rotating −90° about X lays them flat with depth going up.
function rectShape(r: Rect, cx: number, cz: number) {
  const s = new THREE.Shape();
  s.moveTo(r.x - cx, -(r.y - cz));
  s.lineTo(r.x + r.width - cx, -(r.y - cz));
  s.lineTo(r.x + r.width - cx, -(r.y + r.height - cz));
  s.lineTo(r.x - cx, -(r.y + r.height - cz));
  s.closePath();
  return s;
}
function rectPath(r: Rect, cx: number, cz: number) {
  const p = new THREE.Path();
  p.moveTo(r.x - cx, -(r.y - cz));
  p.lineTo(r.x - cx, -(r.y + r.height - cz));
  p.lineTo(r.x + r.width - cx, -(r.y + r.height - cz));
  p.lineTo(r.x + r.width - cx, -(r.y - cz));
  p.closePath();
  return p;
}
function flatGeometry(shape: THREE.Shape) {
  return new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
}

function addPlants(group: THREE.Group, rg: Intervention, top: number, cx: number, cz: number,
                   fill: string, plant: string, size = 0.45, spacing = 1.6) {
  const r = rg.rect;
  const cols = Math.max(1, Math.floor(r.width / spacing)), rows = Math.max(1, Math.floor(r.height / spacing));
  const n = Math.min(cols * rows, 600);
  const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(size, 0),
    new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), n);
  const rand = rng(hash(rg.id));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
  const a = new THREE.Color(fill), b = new THREE.Color(plant);
  for (let k = 0; k < n; k++) {
    const col = k % cols, row = Math.floor(k / cols);
    const x = r.x + (col + 0.5 + (rand() - 0.5) * 0.6) * (r.width / cols) - cx;
    const z = r.y + (row + 0.5 + (rand() - 0.5) * 0.6) * (r.height / rows) - cz;
    const s = 0.6 + rand() * 0.6;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI);
    m.compose(new THREE.Vector3(x, top + size * 0.55 * s, z), q, new THREE.Vector3(s, s * (0.8 + rand() * 0.6), s));
    mesh.setMatrixAt(k, m);
    mesh.setColorAt(k, c.copy(a).lerp(b, 0.15 + rand() * 0.45));
  }
  mesh.castShadow = true;
  group.add(mesh);
}

/** Parking bay lines along the long side, skipping any permeable pavement on top. */
function addStripes(group: THREE.Group, s: Surface, items: Intervention[], cx: number, cz: number,
                    pal: Palette, xray: THREE.Material[]) {
  const r = s.rect;
  if (r.height < 12 || r.width < 12) return;
  const m = new THREE.MeshBasicMaterial({ color: pal.wall });
  xray.push(m);
  const geo = new THREE.PlaneGeometry(0.12, 5).rotateX(-Math.PI / 2);
  const rowsAt = [r.y + 0.5 + 2.5, r.y + r.height - 0.5 - 2.5];
  const placed: THREE.Matrix4[] = [];
  for (const z of rowsAt) {
    for (let x = r.x + 2.6; x < r.x + r.width - 1; x += 2.6) {
      const stripe = { x: x - 0.06, y: z - 2.5, width: 0.12, height: 5 };
      if (items.some((i) => overlapsRect(i.rect, stripe))) continue;
      placed.push(new THREE.Matrix4().makeTranslation(x - cx, TOP[s.kind] + 0.01, z - cz));
    }
  }
  if (!placed.length) return;
  const mesh = new THREE.InstancedMesh(geo, m, placed.length);
  placed.forEach((p, i) => mesh.setMatrixAt(i, p));
  group.add(mesh);
}

function overlapsRect(a: Rect, b: Rect) {
  return Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x)
    && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
}

/** Two rows of window bands on each wall, so the building reads at a glance. */
function addWindows(group: THREE.Group, r: Rect, cx: number, cz: number, pal: Palette, xray: THREE.Material[]) {
  const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(pal.water).lerp(new THREE.Color(pal.wall), 0.55), roughness: 0.3 });
  xray.push(m);
  const x0 = r.x - cx, z0 = r.y - cz, x1 = x0 + r.width, z1 = z0 + r.height;
  for (const y of [2.4, 6.2]) {
    const along = (len: number) => new THREE.BoxGeometry(Math.max(len - 3, 0.5), 1.3, 0.06);
    const n = new THREE.Mesh(along(r.width), m); n.position.set((x0 + x1) / 2, y, z0 - 0.03);
    const s = new THREE.Mesh(along(r.width), m); s.position.set((x0 + x1) / 2, y, z1 + 0.03);
    const e = new THREE.Mesh(along(r.height), m); e.rotation.y = Math.PI / 2; e.position.set(x1 + 0.03, y, (z0 + z1) / 2);
    const w = new THREE.Mesh(along(r.height), m); w.rotation.y = Math.PI / 2; w.position.set(x0 - 0.03, y, (z0 + z1) / 2);
    group.add(n, s, e, w);
  }
}

/** A speckled texture (planting, stone) repeating every `tile` metres; skipped outside the browser. */
function speckleTexture(base: string, dot: string, r: Rect, tile: number): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (!g) return null;
  g.fillStyle = base;
  g.fillRect(0, 0, 64, 64);
  const rand = rng(5);
  for (let k = 0; k < 70; k++) {
    g.fillStyle = k % 3 ? dot : "rgba(255,255,255,0.35)";
    g.globalAlpha = 0.35 + rand() * 0.4;
    g.beginPath();
    g.arc(rand() * 64, rand() * 64, 1.5 + rand() * 3, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(r.width / tile, r.height / tile);
  return t;
}

/** A paver grid drawn on a canvas; skipped outside the browser. */
function paverTexture(pal: Palette, r: Rect): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (!g) return null;
  g.fillStyle = pal.ppFill;
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = pal.ppStroke;
  g.globalAlpha = 0.55;
  g.lineWidth = 3;
  g.strokeRect(0, 0, 64, 32);
  g.strokeRect(-32, 32, 64, 32);
  g.strokeRect(32, 32, 64, 32);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(r.width / 1.2, r.height / 1.2); // one 1.2 m × 0.6 m paver pair per tile
  return t;
}
