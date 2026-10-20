// Rectangle helpers. These mirror backend/runofflab/validation.py so the editor
// can make sensible defaults; the backend remains the authority on feasibility.

import { isCapturing, LIDS } from "./lids";
import type {
  Constraints, Design, Intervention, InterventionKind, Rect, Site, Surface, SurfaceKind,
} from "./types";

const EPS = 1e-6;

export const IMPERVIOUS: ReadonlySet<SurfaceKind> = new Set(["roof", "parking", "road", "sidewalk"]);
export const RAIN_GARDEN_HOSTS = LIDS.rain_garden.hosts;
export const PAVEMENT_HOSTS = LIDS.permeable_pavement.hosts;

export const area = (r: Rect) => r.width * r.height;

export function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x - EPS && inner.y >= outer.y - EPS
    && inner.x + inner.width <= outer.x + outer.width + EPS
    && inner.y + inner.height <= outer.y + outer.height + EPS;
}

export function overlaps(a: Rect, b: Rect): boolean {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > EPS && h > EPS;
}

/** Shortest distance between two rectangles (0 if they touch or overlap). */
export function gap(a: Rect, b: Rect): number {
  const dx = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), 0);
  const dy = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height), 0);
  return Math.hypot(dx, dy);
}

/** Rectangle spanning two corner points, snapped to `step` metres and clipped to the site. */
export function rectFromPoints(ax: number, ay: number, bx: number, by: number,
                               site: Site, step = 1): Rect {
  const snap = (v: number) => Math.round(v / step) * step;
  const clampX = (v: number) => Math.min(Math.max(v, 0), site.width_m);
  const clampY = (v: number) => Math.min(Math.max(v, 0), site.height_m);
  const x1 = clampX(snap(Math.min(ax, bx))), x2 = clampX(snap(Math.max(ax, bx)));
  const y1 = clampY(snap(Math.min(ay, by))), y2 = clampY(snap(Math.max(ay, by)));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Keep a rectangle's size but move it fully inside the site. */
export function clampInside(r: Rect, site: Site): Rect {
  return {
    ...r,
    x: Math.min(Math.max(r.x, 0), Math.max(site.width_m - r.width, 0)),
    y: Math.min(Math.max(r.y, 0), Math.max(site.height_m - r.height, 0)),
  };
}

export function hostSurface(site: Site, r: Rect): Surface | undefined {
  return site.surfaces.find((s) => contains(s.rect, r));
}

export function surfaceAt(site: Site, x: number, y: number): Surface | undefined {
  return site.surfaces.find((s) =>
    x >= s.rect.x && x <= s.rect.x + s.rect.width && y >= s.rect.y && y <= s.rect.y + s.rect.height);
}

export function nextId(prefix: string, site: Site, design: Design): string {
  const taken = new Set([...site.surfaces.map((s) => s.id), ...design.interventions.map((i) => i.id)]);
  for (let n = 1; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

/** Impervious area of `surfaceId` not yet paved over or routed into another LID. */
export function remainingImpervious(site: Site, design: Design, surfaceId: string,
                                    excludeId?: string): number {
  const surface = site.surfaces.find((s) => s.id === surfaceId);
  if (!surface) return 0;
  let left = area(surface.rect);
  for (const item of design.interventions) {
    if (item.id === excludeId) continue;
    if (isCapturing(item)) {
      if (item.contributing_surface_id === surfaceId) left -= item.captured_area_m2;
    } else if (contains(surface.rect, item.rect)) { // pavers and green roofs replace part of their host
      left -= area(item.rect) + (item.kind === "permeable_pavement" ? item.runon_area_m2 : 0);
    }
  }
  return Math.max(left, 0);
}

/** Surfaces close enough to feed an intervention placed on `host`: any paved one, or only roofs for barrels. */
export function contributingCandidates(site: Site, host: Surface | undefined,
                                       constraints: Constraints, roofOnly = false): Surface[] {
  const ok = (s: Surface) => (roofOnly ? s.kind === "roof" : IMPERVIOUS.has(s.kind));
  if (!host) return site.surfaces.filter(ok);
  return site.surfaces
    .filter((s) => ok(s) && gap(host.rect, s.rect) <= constraints.max_contributing_gap_m)
    .sort((a, b) => gap(host.rect, a.rect) - gap(host.rect, b.rect) || area(b.rect) - area(a.rect));
}

/** A new intervention with defaults that pass the loading-ratio and capture checks. */
export function newIntervention(kind: InterventionKind, rect: Rect, site: Site, design: Design,
                                constraints: Constraints): Intervention {
  const id = nextId(LIDS[kind].prefix, site, design);
  const meta = LIDS[kind];
  if (meta.captures) {
    const host = hostSurface(site, rect);
    const src = contributingCandidates(site, host, constraints, meta.captures === "roof")[0];
    const left = src ? remainingImpervious(site, design, src.id) : 0;
    // Gardens and trenches take what the loading limit allows; a barrel takes the roof area that
    // fills it in about 25 mm of rain, so it's useful in an ordinary storm.
    const want = kind === "rain_barrel"
      ? area(rect) * 1.2 / 0.025
      : Math.min(10, constraints.max_rain_garden_loading_ratio) * area(rect);
    const captured = Math.max(Math.floor(Math.min(want, left) + 1e-6), 0); // tolerate float error, e.g. 191.9999…
    const base = { id, rect, contributing_surface_id: src?.id ?? "", captured_area_m2: captured };
    if (kind === "rain_garden") return { kind, ...base, ponding_depth_mm: 150, soil_depth_mm: 600, gravel_depth_mm: 300 };
    if (kind === "infiltration_trench") return { kind, ...base, storage_depth_mm: 900 };
    return { kind: "rain_barrel", ...base, height_mm: 1200, drain_delay_hours: 12 };
  }
  if (kind === "green_roof") return { kind, id, rect, soil_depth_mm: 100, drain_mat_mm: 25 };
  return { kind: "permeable_pavement", id, rect, runon_area_m2: 0, pavement_thickness_mm: 100, storage_depth_mm: 300 };
}
