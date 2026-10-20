// Helpers for editing the site itself: surfaces, drains, pipes and the outfall.
// The backend (validation.validate_site) remains the authority on what is valid.

import type { Inlet, Pipe, Project, Rect, Site, Surface, SurfaceKind } from "./types";

export type SiteElement =
  | { kind: "surface"; id: string }
  | { kind: "inlet"; id: string }
  | { kind: "pipe"; id: string }
  | { kind: "outfall"; id: string };

export const DRAIN_DEPTH_M = 1.5; // rim to invert for a new drain
export const MIN_FALL = 0.005; // 0.5 % slope, a common minimum for storm sewers
export const DEFAULT_PIPE_DIAMETER_M = 0.375;

/** An id not used anywhere in the project (site elements and every design's interventions). */
export function freeId(prefix: string, project: Project, taken = usedIds(project)): string {
  for (let n = 1; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

function usedIds(project: Project): Set<string> {
  const { site } = project;
  return new Set([
    ...site.surfaces.map((s) => s.id), ...site.inlets.map((i) => i.id), ...site.pipes.map((p) => p.id),
    site.outfall.id, ...project.designs.flatMap((d) => d.interventions.map((i) => i.id)),
  ]);
}

/** The parts of `a` outside `b`, as up to four rectangles (top and bottom bands, then left and right). */
export function subtractRect(a: Rect, b: Rect): Rect[] {
  const x1 = Math.max(a.x, b.x), x2 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y, b.y), y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return [a];
  return [
    { x: a.x, y: a.y, width: a.width, height: y1 - a.y },
    { x: a.x, y: y2, width: a.width, height: a.y + a.height - y2 },
    { x: a.x, y: y1, width: x1 - a.x, height: y2 - y1 },
    { x: x2, y: y1, width: a.x + a.width - x2, height: y2 - y1 },
  ].filter((r) => r.width > 1e-6 && r.height > 1e-6);
}

/**
 * Place `surface` on the site, cutting it out of any surfaces it covers: drawing a roof on a
 * lawn leaves the lawn around it. Cut surfaces keep their id and settings; extra pieces get
 * new ids and names, and lawn or planted pieces that line up are merged back together.
 */
export function placeSurface(project: Project, surface: Surface): Surface[] {
  const taken = usedIds(project);
  taken.add(surface.id);
  const names = new Set([...project.site.surfaces.map((s) => s.name), surface.name]);
  const out: Surface[] = [], extra: Surface[] = []; // new pieces go last, so merges keep existing ids
  for (const s of project.site.surfaces) {
    const pieces = subtractRect(s.rect, surface.rect);
    if (pieces.length === 1 && pieces[0] === s.rect) { out.push(s); continue; }
    pieces.forEach((rect, n) => {
      if (n === 0) return out.push({ ...s, rect });
      const id = freeId(s.id.replace(/\d+$/, "") || "S", project, taken);
      taken.add(id);
      let k = 1;
      while (names.has(`${SURFACE_LABEL[s.kind]} ${k}`)) k++;
      const name = `${SURFACE_LABEL[s.kind]} ${k}`;
      names.add(name);
      extra.push({ ...s, id, rect, name });
    });
  }
  return [...mergePervious([...out, ...extra]), surface];
}

const PERVIOUS = new Set<SurfaceKind>(["lawn", "landscape"]);

/**
 * Join lawn or planted surfaces that share a whole edge and drain the same way. Only pervious
 * surfaces are merged, since rain gardens refer to the paved surfaces they capture from by id.
 */
export function mergePervious(surfaces: Surface[]): Surface[] {
  const list = [...surfaces];
  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < list.length && !merged; i++) {
      for (let j = i + 1; j < list.length && !merged; j++) {
        const a = list[i], b = list[j];
        if (a.kind !== b.kind || !PERVIOUS.has(a.kind) || a.drains_to !== b.drains_to || a.slope_pct !== b.slope_pct) continue;
        const r = a.rect, q = b.rect;
        let rect: Rect | null = null;
        if (eq(r.x, q.x) && eq(r.width, q.width) && (eq(r.y + r.height, q.y) || eq(q.y + q.height, r.y))) {
          rect = { x: r.x, y: Math.min(r.y, q.y), width: r.width, height: r.height + q.height };
        } else if (eq(r.y, q.y) && eq(r.height, q.height) && (eq(r.x + r.width, q.x) || eq(q.x + q.width, r.x))) {
          rect = { x: Math.min(r.x, q.x), y: r.y, width: r.width + q.width, height: r.height };
        }
        if (rect) {
          list[i] = { ...a, rect };
          list.splice(j, 1);
          merged = true;
        }
      }
    }
  }
  return list;
}

/** Drain and outfall positions by id. */
export function nodePositions(site: Site): Map<string, { x: number; y: number }> {
  return new Map([
    ...site.inlets.map((i) => [i.id, { x: i.x, y: i.y }] as const),
    [site.outfall.id, { x: site.outfall.x, y: site.outfall.y }],
  ]);
}

export function invertOf(site: Site, id: string): number | undefined {
  return id === site.outfall.id ? site.outfall.invert_elev_m : site.inlets.find((i) => i.id === id)?.invert_elev_m;
}

/** Plan distance between two nodes, rounded to 0.1 m (at least 1 m, as SWMM needs a length). */
export function pipeLength(site: Site, from: string, to: string): number {
  const nodes = nodePositions(site);
  const a = nodes.get(from), b = nodes.get(to);
  if (!a || !b) return 1;
  return Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) * 10) / 10);
}

/** Fall per metre from upstream to downstream invert (negative means the pipe runs uphill). */
export function pipeSlope(site: Site, pipe: Pipe): number | null {
  const a = invertOf(site, pipe.from_node), b = invertOf(site, pipe.to_node);
  return a === undefined || b === undefined ? null : (a - b) / pipe.length_m;
}

/** After a node moves, keep the pipes attached to it as long as they are drawn. */
export function syncPipeLengths(site: Site, nodeId: string): Site {
  return {
    ...site,
    pipes: site.pipes.map((p) => (p.from_node === nodeId || p.to_node === nodeId
      ? { ...p, length_m: pipeLength(site, p.from_node, p.to_node) } : p)),
  };
}

export const SURFACE_LABEL: Record<SurfaceKind, string> = {
  roof: "Roof", parking: "Parking", road: "Road", sidewalk: "Sidewalk", lawn: "Lawn", landscape: "Planted bed",
};

/** The drain nearest a point, which a new surface will drain to by default. */
export function nearestInlet(site: Site, x: number, y: number): Inlet | undefined {
  return [...site.inlets].sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
}

export function newSurface(project: Project, kind: SurfaceKind, rect: Rect): Surface {
  const id = freeId(kind === "roof" ? "R" : kind === "parking" || kind === "road" ? "P"
    : kind === "sidewalk" ? "S" : "L", project);
  const site = project.site;
  const drain = nearestInlet(site, rect.x + rect.width / 2, rect.y + rect.height / 2);
  const count = site.surfaces.filter((s) => s.kind === kind).length + 1;
  return {
    id, name: `${SURFACE_LABEL[kind]} ${count}`, kind, rect,
    slope_pct: kind === "roof" ? 1 : kind === "lawn" || kind === "landscape" ? 3 : 2,
    drains_to: drain?.id ?? "",
  };
}

/** A drain with its rim at the level of the nearest existing drain. */
export function newInlet(project: Project, x: number, y: number): Inlet {
  const site = project.site;
  const near = nearestInlet(site, x, y);
  const rim = near?.rim_elev_m ?? site.outfall.invert_elev_m + DRAIN_DEPTH_M + 0.5;
  const id = freeId("I", project);
  return { id, name: `Drain ${id}`, x: round1(x), y: round1(y), rim_elev_m: rim, invert_elev_m: round2(rim - DRAIN_DEPTH_M) };
}

export function newPipe(project: Project, from: string, to: string): Pipe {
  return {
    id: freeId("C", project), from_node: from, to_node: to,
    length_m: pipeLength(project.site, from, to), diameter_m: DEFAULT_PIPE_DIAMETER_M,
  };
}

/**
 * When a new pipe would run flat or uphill and its upstream drain has nothing flowing into it yet,
 * the invert that drain needs for a 0.5 % fall (if that still leaves it at least 0.5 m deep).
 */
export function levelUpstream(site: Site, pipe: Pipe): number | undefined {
  const up = site.inlets.find((i) => i.id === pipe.from_node);
  const down = invertOf(site, pipe.to_node);
  if (!up || down === undefined || site.pipes.some((p) => p.to_node === up.id)) return undefined;
  const needed = round2(down + Math.max(MIN_FALL * pipe.length_m, 0.01));
  if (up.invert_elev_m >= needed || up.rim_elev_m - needed < 0.5) return undefined;
  return needed;
}

/**
 * A new project on an empty lot: one lawn over the whole site, a drain in the middle,
 * and a pipe to an outfall on the south edge. Costs, limits and the storm come from `base`.
 */
export function blankProject(base: Project, id: string, width = 120, height = 80): Project {
  const site: Site = {
    id: "site", name: "New site", description: "", width_m: width, height_m: height, soil: base.site.soil,
    surfaces: [{ id: "L1", name: "Lawn 1", kind: "lawn", rect: { x: 0, y: 0, width, height }, slope_pct: 3, drains_to: "I1" }],
    inlets: [{ id: "I1", name: "Drain I1", x: width / 2, y: height / 2, rim_elev_m: 100, invert_elev_m: 98.5 }],
    outfall: { id: "OF1", name: "Outfall", x: width / 2, y: height, invert_elev_m: 98 },
    pipes: [],
  };
  site.pipes = [{ id: "C1", from_node: "I1", to_node: "OF1", length_m: pipeLength(site, "I1", "OF1"), diameter_m: DEFAULT_PIPE_DIAMETER_M }];
  return {
    ...structuredClone(base), id, name: "Untitled site", site,
    designs: [{ id: "D1", name: "Design 1", interventions: [] }],
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
