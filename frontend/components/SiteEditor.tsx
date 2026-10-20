"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  area, clampInside, hostSurface, overlaps, rectFromPoints, surfaceAt,
} from "@/lib/geometry";
import { isCapturing, LID_ORDER, LIDS } from "@/lib/lids";
import { m2, num } from "@/lib/format";
import { nodePositions, type SiteElement } from "@/lib/siteBuilder";
import type { Design, Intervention, InterventionKind, Issue, Rect, Site, SurfaceKind } from "@/lib/types";
import { Icon } from "./ui";

export type Layer = "design" | "site";
export type Tool = "select" | InterventionKind | "surface" | "drain" | "pipe";
const isLidTool = (t: Tool): t is InterventionKind => t in LIDS;

type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
type Target = "item" | "surface"; // what a move or resize applies to

type Drag =
  | { mode: "draw"; kind: Intervention["kind"] | "surface"; x0: number; y0: number; rect: Rect }
  | { mode: "move"; target: Target; id: string; dx: number; dy: number; rect: Rect; moved: boolean }
  | { mode: "resize"; target: Target; id: string; handle: Handle; orig: Rect; rect: Rect }
  | { mode: "node"; id: string; x: number; y: number; moved: boolean }
  | { mode: "pipe"; from: string; x: number; y: number };

const PAD = 4; // metres of margin around the site
const MIN_SIZE = 1; // metres

export const KIND_LABEL: Record<SurfaceKind, string> = {
  roof: "Roof", parking: "Parking", road: "Road", sidewalk: "Sidewalk / plaza",
  lawn: "Lawn", landscape: "Planted bed",
};
const DARK_KINDS = new Set<SurfaceKind>(["parking", "road"]);

export default function SiteEditor({
  site, design, selectedId, issues, tool, onToolChange, onSelect, onCreate, onChangeRect,
  layer, onLayerChange, surfaceKind, onSurfaceKindChange, siteSel, onSiteSelect,
  onCreateSurface, onChangeSurfaceRect, onCreateInlet, onMoveNode, onCreatePipe,
}: {
  site: Site;
  design: Design | null;
  selectedId: string | null;
  issues: Issue[];
  tool: Tool;
  onToolChange: (t: Tool) => void;
  onSelect: (id: string | null) => void;
  onCreate: (kind: Intervention["kind"], rect: Rect) => void;
  onChangeRect: (id: string, rect: Rect) => void;
  layer: Layer;
  onLayerChange: (l: Layer) => void;
  surfaceKind: SurfaceKind;
  onSurfaceKindChange: (k: SurfaceKind) => void;
  siteSel: SiteElement | null;
  onSiteSelect: (el: SiteElement | null) => void;
  onCreateSurface: (rect: Rect) => void;
  onChangeSurfaceRect: (id: string, rect: Rect) => void;
  onCreateInlet: (x: number, y: number) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
  onCreatePipe: (from: string, to: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [pxPerM, setPxPerM] = useState(4);
  const siteMode = layer === "site";

  const vbW = site.width_m + 2 * PAD;
  const vbH = site.height_m + 2 * PAD;

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPxPerM(el.clientWidth / vbW));
    ro.observe(el);
    return () => ro.disconnect();
  }, [vbW]);

  // Sizes that should stay constant on screen, expressed in metres.
  const px = (n: number) => n / pxPerM;

  const errorTargets = useMemo(() => {
    const m = new Map<string, Issue["severity"]>();
    for (const i of issues) {
      if (!i.target_id) continue;
      if (i.severity === "error" || !m.has(i.target_id)) m.set(i.target_id, i.severity);
    }
    return m;
  }, [issues]);

  const items = design?.interventions ?? [];
  const selected = siteMode ? null : items.find((i) => i.id === selectedId) ?? null;
  const selSurface = siteSel?.kind === "surface" ? site.surfaces.find((s) => s.id === siteSel.id) ?? null : null;
  const nodes = useMemo(() => {
    const m = nodePositions(site);
    if (drag?.mode === "node") m.set(drag.id, { x: drag.x, y: drag.y });
    return m;
  }, [site, drag]);

  function toSite(e: React.PointerEvent): { x: number; y: number } {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  }

  function rectOf(target: Target, id: string, rect: Rect): Rect {
    if (drag && (drag.mode === "move" || drag.mode === "resize") && drag.target === target && drag.id === id) return drag.rect;
    return rect;
  }

  const clampToSite = (p: { x: number; y: number }) => ({
    x: Math.round(Math.min(Math.max(p.x, 0), site.width_m)),
    y: Math.round(Math.min(Math.max(p.y, 0), site.height_m)),
  });

  /** The drain or outfall within reach of a point, for connecting pipes. */
  function nodeNear(p: { x: number; y: number }, except?: string): string | null {
    let best: string | null = null, bestD = px(14);
    for (const [id, n] of nodes) {
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (id !== except && d < bestD) { best = id; bestD = d; }
    }
    return best;
  }

  // ── Pointer handling ─────────────────────────────────────────────────────

  function onBackgroundDown(e: React.PointerEvent<SVGSVGElement>) {
    if (e.button !== 0) return;
    const p = toSite(e);
    if (siteMode) {
      if (tool === "drain") {
        const c = clampToSite(p);
        onCreateInlet(c.x, c.y);
      } else if (tool === "surface") {
        svgRef.current!.setPointerCapture(e.pointerId);
        setDrag({ mode: "draw", kind: "surface", x0: p.x, y0: p.y, rect: rectFromPoints(p.x, p.y, p.x, p.y, site) });
      } else if (tool === "select") onSiteSelect(null);
      return;
    }
    if (!design) return;
    if (tool === "select") {
      onSelect(null);
      return;
    }
    if (!isLidTool(tool)) return;
    svgRef.current!.setPointerCapture(e.pointerId);
    setDrag({ mode: "draw", kind: tool, x0: p.x, y0: p.y, rect: rectFromPoints(p.x, p.y, p.x, p.y, site) });
  }

  function startMove(e: React.PointerEvent, target: Target, id: string, rect: Rect) {
    e.stopPropagation();
    const p = toSite(e);
    svgRef.current!.setPointerCapture(e.pointerId);
    setDrag({ mode: "move", target, id, dx: p.x - rect.x, dy: p.y - rect.y, rect, moved: false });
  }

  function onItemDown(e: React.PointerEvent, item: Intervention) {
    if (siteMode || tool !== "select" || e.button !== 0) return; // drawing tools draw over items
    onSelect(item.id);
    startMove(e, "item", item.id, item.rect);
  }

  function onSurfaceDown(e: React.PointerEvent, id: string, rect: Rect) {
    if (!siteMode || tool !== "select" || e.button !== 0) return; // other tools act on the background
    onSiteSelect({ kind: "surface", id });
    startMove(e, "surface", id, rect);
  }

  function onNodeDown(e: React.PointerEvent, id: string) {
    if (!siteMode || e.button !== 0) return;
    if (tool === "surface") return;
    e.stopPropagation();
    if (tool === "drain") return; // don't stack a new drain on an existing one
    const n = nodes.get(id)!;
    svgRef.current!.setPointerCapture(e.pointerId);
    if (tool === "pipe") {
      if (id !== site.outfall.id) setDrag({ mode: "pipe", from: id, x: n.x, y: n.y }); // water leaves at the outfall
      return;
    }
    onSiteSelect({ kind: id === site.outfall.id ? "outfall" : "inlet", id });
    setDrag({ mode: "node", id, x: n.x, y: n.y, moved: false });
  }

  function onPipeDown(e: React.PointerEvent, id: string) {
    if (!siteMode || tool !== "select" || e.button !== 0) return;
    e.stopPropagation();
    onSiteSelect({ kind: "pipe", id });
  }

  function onHandleDown(e: React.PointerEvent, target: Target, id: string, rect: Rect, handle: Handle) {
    if (e.button !== 0) return;
    e.stopPropagation();
    svgRef.current!.setPointerCapture(e.pointerId);
    setDrag({ mode: "resize", target, id, handle, orig: rect, rect });
  }

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const p = toSite(e);
    setPointer(p);
    if (!drag) return;
    if (drag.mode === "draw") {
      setDrag({ ...drag, rect: rectFromPoints(drag.x0, drag.y0, p.x, p.y, site) });
    } else if (drag.mode === "move") {
      const r = clampInside({ ...drag.rect, x: Math.round(p.x - drag.dx), y: Math.round(p.y - drag.dy) }, site);
      if (r.x !== drag.rect.x || r.y !== drag.rect.y) setDrag({ ...drag, rect: r, moved: true });
    } else if (drag.mode === "resize") {
      setDrag({ ...drag, rect: resizeRect(drag.orig, drag.handle, p, site) });
    } else if (drag.mode === "node") {
      const c = clampToSite(p);
      if (c.x !== drag.x || c.y !== drag.y) setDrag({ ...drag, ...c, moved: true });
    } else {
      setDrag({ ...drag, x: p.x, y: p.y });
    }
  }

  function onUp() {
    if (!drag) return;
    if (drag.mode === "draw") {
      if (drag.rect.width >= MIN_SIZE && drag.rect.height >= MIN_SIZE) {
        if (drag.kind === "surface") onCreateSurface(drag.rect);
        else onCreate(drag.kind, drag.rect);
      }
    } else if (drag.mode === "move" || drag.mode === "resize") {
      const changed = drag.mode === "move" ? drag.moved : !sameRect(drag.rect, drag.orig);
      if (changed) (drag.target === "item" ? onChangeRect : onChangeSurfaceRect)(drag.id, drag.rect);
    } else if (drag.mode === "node") {
      if (drag.moved) onMoveNode(drag.id, drag.x, drag.y);
    } else {
      const to = nodeNear(drag, drag.from);
      if (to) onCreatePipe(drag.from, to);
    }
    setDrag(null);
  }

  // ── Status line ──────────────────────────────────────────────────────────

  const status = (() => {
    if (drag?.mode === "draw") {
      if (drag.kind === "surface") {
        const r = drag.rect;
        return <span><strong>{KIND_LABEL[surfaceKind]}</strong> · {num(r.width)} × {num(r.height)} m · {m2(area(r))}</span>;
      }
      return drawStatus(drag.kind, drag.rect, site);
    }
    if (drag?.mode === "pipe") {
      const to = nodeNear(drag, drag.from);
      return <span>Pipe from <strong>{drag.from}</strong> {to ? <>to <strong>{to}</strong>. Release to connect.</> : "· drop it on another drain or the outfall"}</span>;
    }
    if (drag?.mode === "node") return <span className="num">{drag.id} at ({num(drag.x)}, {num(drag.y)})</span>;
    if (drag) {
      const r = drag.rect;
      return <span className="num">{drag.id}: {num(r.width)} × {num(r.height)} m · {m2(area(r))} · at ({num(r.x)}, {num(r.y)})</span>;
    }
    const hovered = items.find((i) => i.id === hoverId);
    if (hovered && !siteMode) {
      const host = hostSurface(site, hovered.rect);
      return <span>{hovered.id} · {LIDS[hovered.kind].label} · {m2(area(hovered.rect))}{host && ` · on ${host.name}`}</span>;
    }
    if (siteMode) {
      if (tool === "surface") return <span className="muted">Drag to draw a {KIND_LABEL[surfaceKind].toLowerCase()}. It replaces whatever it’s drawn over.</span>;
      if (tool === "drain") return <span className="muted">Click to place a drain. New surfaces drain to the nearest one.</span>;
      if (tool === "pipe") return <span className="muted">Drag from one drain to the next one downstream, ending at the outfall.</span>;
    }
    const s = pointer && surfaceAt(site, pointer.x, pointer.y);
    if (s) {
      return <span>{s.name} · {KIND_LABEL[s.kind]} · {m2(area(s.rect))} · {s.slope_pct}% slope · drains to {s.drains_to}</span>;
    }
    if (siteMode) return <span className="muted">Select a surface, drain, pipe or the outfall to move or edit it.</span>;
    if (!design) return <span className="muted">Baseline: the site as it is today. Pick or create a design to add green infrastructure.</span>;
    if (isLidTool(tool)) {
      const m = LIDS[tool];
      return <span className="muted">Drag on {m.hostHint} to place a {m.label.toLowerCase()}. {m.blurb}</span>;
    }
    return <span className="muted">Select an intervention to move or resize it. Arrow keys nudge by 1 m.</span>;
  })();

  // ── Render ───────────────────────────────────────────────────────────────

  const contributing = selected && isCapturing(selected)
    ? site.surfaces.find((s) => s.id === selected.contributing_surface_id) : undefined;
  const drainOfSelected = selSurface ? nodes.get(selSurface.drains_to) : undefined;
  const labelSize = px(12);
  const smallSize = px(10.5);
  const isSel = (kind: SiteElement["kind"], id: string) => siteSel?.kind === kind && siteSel.id === id;
  const nodeColor = (id: string) => errorTargets.get(id) === "error" ? "var(--critical)" : "var(--node)";

  // Selection handles for whichever rectangle is selected in this layer.
  const handleFor: { target: Target; id: string; rect: Rect } | null = siteMode
    ? (selSurface && tool === "select" ? { target: "surface", id: selSurface.id, rect: rectOf("surface", selSurface.id, selSurface.rect) } : null)
    : (selected && tool === "select" ? { target: "item", id: selected.id, rect: rectOf("item", selected.id, selected.rect) } : null);

  return (
    <div className="card editor">
      <div className="card-head editor-toolbar">
        <div className="segmented" role="radiogroup" aria-label="Editing layer">
          <button role="radio" aria-checked={!siteMode} aria-pressed={!siteMode} onClick={() => onLayerChange("design")} title="Add rain gardens and permeable pavement">
            <Icon name="sprout" size={14} /> Green infrastructure
          </button>
          <button role="radio" aria-checked={siteMode} aria-pressed={siteMode} onClick={() => onLayerChange("site")} title="Draw the site: surfaces, drains and pipes">
            <Icon name="area" size={14} /> Site layout
          </button>
        </div>
        <div className="segmented" role="toolbar" aria-label="Editor tools">
          <button aria-pressed={tool === "select"} onClick={() => onToolChange("select")} title="Select (V)">
            <Icon name="cursor" size={14} /> Select
          </button>
          {siteMode ? <>
            <button aria-pressed={tool === "surface"} onClick={() => onToolChange("surface")} title="Draw a surface (S)">
              <span className="swatch" style={{ background: `var(--kind-${surfaceKind})` }} /> Surface
            </button>
            <button aria-pressed={tool === "drain"} onClick={() => onToolChange("drain")} title="Place a drain (D)">
              <span className="swatch" style={{ background: "var(--node)", borderRadius: 2 }} /> Drain
            </button>
            <button aria-pressed={tool === "pipe"} onClick={() => onToolChange("pipe")} title="Connect a pipe (C)">
              <svg width="14" height="10" aria-hidden="true"><line x1="0" y1="5" x2="14" y2="5" stroke="var(--pipe)" strokeWidth="2.5" /></svg> Pipe
            </button>
          </> : LID_ORDER.map((k) => (
            <button key={k} aria-pressed={tool === k} disabled={!design} onClick={() => onToolChange(k)}
                    title={`${LIDS[k].label} (${LIDS[k].key.toUpperCase()}): ${LIDS[k].blurb}`} aria-label={LIDS[k].label}>
              <span className="swatch" style={{ background: LIDS[k].fill }} /> {LIDS[k].short}
            </button>
          ))}
        </div>
        {siteMode && tool === "surface" && (
          <select className="select sm" aria-label="Surface type" value={surfaceKind}
                  onChange={(e) => onSurfaceKindChange(e.target.value as SurfaceKind)}>
            {(Object.keys(KIND_LABEL) as SurfaceKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        )}
        <div className="spacer" style={{ flex: 1 }} />
        <div className="legend" aria-label="Surface legend">
          {(Object.keys(KIND_LABEL) as SurfaceKind[])
            .filter((k) => site.surfaces.some((s) => s.kind === k))
            .map((k) => (
              <span key={k}><span className="swatch" style={{ background: `var(--kind-${k})` }} />{KIND_LABEL[k]}</span>
            ))}
          <span><svg width="14" height="10" aria-hidden="true"><line x1="0" y1="5" x2="14" y2="5" stroke="var(--pipe)" strokeWidth="2" /></svg>Pipe</span>
        </div>
      </div>

      <div className="editor-canvas">
        <svg ref={svgRef} viewBox={`${-PAD} ${-PAD} ${vbW} ${vbH}`} role="application"
             aria-label={`Site plan of ${site.name}, ${site.width_m} by ${site.height_m} metres`}
             style={{ cursor: tool === "select" ? "default" : "crosshair" }}
             onPointerDown={onBackgroundDown} onPointerMove={onMove} onPointerUp={onUp}
             onPointerCancel={() => setDrag(null)} onPointerLeave={() => !drag && setPointer(null)}>
          <defs>
            <pattern id="pp-hatch" patternUnits="userSpaceOnUse" width="2.4" height="2.4" patternTransform="rotate(45)">
              <rect width="2.4" height="2.4" fill="var(--pp-fill)" />
              <line x1="0" y1="0" x2="0" y2="2.4" stroke="var(--pp-stroke)" strokeWidth="0.7" opacity="0.55" />
            </pattern>
            <pattern id="rg-plants" patternUnits="userSpaceOnUse" width="3" height="3">
              <rect width="3" height="3" fill="var(--rg-fill)" />
              <circle cx="0.8" cy="0.9" r="0.42" fill="var(--rg-plant)" opacity="0.55" />
              <circle cx="2.3" cy="2.2" r="0.32" fill="var(--rg-plant)" opacity="0.45" />
            </pattern>
            <pattern id="gr-sedum" patternUnits="userSpaceOnUse" width="2" height="2">
              <rect width="2" height="2" fill="var(--gr-fill)" />
              <circle cx="0.5" cy="0.6" r="0.28" fill="var(--gr-plant)" opacity="0.7" />
              <circle cx="1.5" cy="1.5" r="0.22" fill="var(--gr-stroke)" opacity="0.45" />
            </pattern>
            <pattern id="it-stone" patternUnits="userSpaceOnUse" width="1.6" height="1.6">
              <rect width="1.6" height="1.6" fill="var(--it-fill)" />
              <circle cx="0.4" cy="0.5" r="0.3" fill="var(--it-stroke)" opacity="0.45" />
              <circle cx="1.2" cy="1.2" r="0.25" fill="var(--surface)" opacity="0.5" />
            </pattern>
            <pattern id="rb-tank" patternUnits="userSpaceOnUse" width="1" height="1">
              <rect width="1" height="1" fill="var(--rb-fill)" />
            </pattern>
            <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" fill="var(--accent)" />
            </marker>
            <marker id="flow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M1 1L9 5L1 9z" fill="var(--pipe)" />
            </marker>
          </defs>

          {/* 10 m grid */}
          <g aria-hidden="true">
            {Array.from({ length: Math.floor(site.width_m / 10) + 1 }, (_, i) => (
              <line key={`gx${i}`} x1={i * 10} y1={0} x2={i * 10} y2={site.height_m} stroke="var(--map-grid)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
            {Array.from({ length: Math.floor(site.height_m / 10) + 1 }, (_, i) => (
              <line key={`gy${i}`} x1={0} y1={i * 10} x2={site.width_m} y2={i * 10} stroke="var(--map-grid)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
          </g>

          {/* Surfaces */}
          <g>
            {site.surfaces.map((s) => {
              const sev = errorTargets.get(s.id);
              const isSource = contributing?.id === s.id;
              const r = rectOf("surface", s.id, s.rect);
              const picked = isSel("surface", s.id);
              return (
                <rect key={s.id} x={r.x} y={r.y} width={r.width} height={r.height}
                      fill={`var(--kind-${s.kind})`}
                      stroke={sev === "error" ? "var(--critical)" : isSource || picked ? "var(--accent)" : "var(--surface)"}
                      strokeWidth={sev === "error" || isSource || picked ? 2.5 : 1} vectorEffect="non-scaling-stroke"
                      onPointerDown={(e) => onSurfaceDown(e, s.id, s.rect)}
                      style={siteMode && tool === "select" ? { cursor: "move" } : undefined}>
                  <title>{`${s.name} (${KIND_LABEL[s.kind]}), ${num(area(s.rect))} m²`}</title>
                </rect>
              );
            })}
          </g>

          {/* Pipes (underground, so drawn beneath interventions); arrows show the flow direction in site layout */}
          <g aria-hidden={!siteMode}>
            {site.pipes.map((p) => {
              const a = nodes.get(p.from_node), b = nodes.get(p.to_node);
              if (!a || !b) return null;
              const sev = errorTargets.get(p.id);
              const picked = isSel("pipe", p.id);
              const color = sev === "error" ? "var(--critical)" : picked ? "var(--accent)" : sev === "warning" ? "var(--warning)" : "var(--pipe)";
              const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
              return (
                <g key={p.id} onPointerDown={(e) => onPipeDown(e, p.id)} style={siteMode && tool === "select" ? { cursor: "pointer" } : undefined}>
                  <polyline points={`${a.x},${a.y} ${mx},${my} ${b.x},${b.y}`} fill="none" stroke={color}
                            strokeWidth={picked ? 3.5 : 2} strokeLinecap="round" vectorEffect="non-scaling-stroke" opacity={0.9}
                            markerMid={siteMode ? "url(#flow)" : undefined} />
                  {siteMode && <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={12} vectorEffect="non-scaling-stroke" />}
                </g>
              );
            })}
          </g>

          {/* Surface labels */}
          <g aria-hidden="true">
            {site.surfaces.map((s) => {
              const sr = rectOf("surface", s.id, s.rect);
              const fits = sr.width > s.name.length * labelSize * 0.58 && sr.height > labelSize * 2.6;
              if (!fits) return null;
              const cx = sr.x + sr.width / 2, cy = sr.y + sr.height / 2;
              const halfW = s.name.length * labelSize * 0.3;
              const labelBox = { x: cx - halfW, y: cy - labelSize, width: 2 * halfW, height: labelSize * 2.4 };
              if (!siteMode && items.some((i) => overlaps(rectOf("item", i.id, i.rect), labelBox))) return null;
              const onDark = DARK_KINDS.has(s.kind);
              return (
                <g key={s.id} pointerEvents="none">
                  <text x={cx} y={cy - labelSize * 0.15} textAnchor="middle" fontSize={labelSize} className="map-label"
                        style={onDark ? { fill: "var(--map-label-on-dark)", stroke: "rgba(0,0,0,0.35)" } : undefined}>{s.name}</text>
                  <text x={cx} y={cy + labelSize * 1.05} textAnchor="middle" fontSize={smallSize} className="map-sublabel"
                        style={onDark ? { fill: "var(--map-label-on-dark)", stroke: "rgba(0,0,0,0.35)" } : undefined}>{num(area(sr))} m²{siteMode && ` · → ${s.drains_to}`}</text>
                </g>
              );
            })}
          </g>

          {/* Site boundary */}
          <rect x={0} y={0} width={site.width_m} height={site.height_m} fill="none" stroke="var(--border-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />

          {/* Interventions (faded and inert while editing the site layout) */}
          <g opacity={siteMode ? 0.4 : 1} pointerEvents={siteMode ? "none" : undefined}>
            {items.map((item) => {
              const r = rectOf("item", item.id, item.rect);
              const sev = errorTargets.get(item.id);
              const picked = item.id === selectedId && !siteMode;
              const meta = LIDS[item.kind];
              return (
                <g key={item.id} onPointerDown={(e) => onItemDown(e, item)}
                   onPointerEnter={() => setHoverId(item.id)} onPointerLeave={() => setHoverId(null)}
                   style={{ cursor: tool === "select" && !siteMode ? "move" : undefined }}>
                  <rect x={r.x} y={r.y} width={r.width} height={r.height}
                        rx={item.kind === "rain_barrel" ? Math.min(r.width, r.height) / 2 : 0}
                        fill={`url(#${meta.pattern})`}
                        stroke={sev === "error" ? "var(--critical)" : meta.stroke}
                        strokeWidth={sev === "error" ? 2.5 : picked ? 2 : 1.25} vectorEffect="non-scaling-stroke" />
                  {r.width > px(30) && r.height > px(14) && (
                    <text x={r.x + r.width / 2} y={r.y + r.height / 2 + smallSize * 0.35} textAnchor="middle" fontSize={smallSize}
                          className="map-label" style={{ fill: "#fff", stroke: "rgba(0,0,0,0.35)" }}>{item.id}</text>
                  )}
                  {sev === "error" && !siteMode && (
                    <g transform={`translate(${r.x + r.width}, ${r.y})`} pointerEvents="none">
                      <circle r={px(7)} fill="var(--critical)" stroke="var(--surface)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                      <text y={px(3.6)} textAnchor="middle" fontSize={px(10)} fontWeight={700} fill="#fff">!</text>
                    </g>
                  )}
                </g>
              );
            })}
          </g>

          {/* Where the selected surface drains */}
          {selSurface && drainOfSelected && (
            <line x1={selSurface.rect.x + selSurface.rect.width / 2} y1={selSurface.rect.y + selSurface.rect.height / 2}
                  x2={drainOfSelected.x} y2={drainOfSelected.y} stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="4 3"
                  vectorEffect="non-scaling-stroke" markerEnd="url(#arrow)" pointerEvents="none" />
          )}

          {/* Drains and outfall stay visible above interventions; in site layout they can be dragged */}
          <g aria-hidden="true" pointerEvents={siteMode ? undefined : "none"}>
            {site.inlets.map((i) => {
              const n = nodes.get(i.id)!;
              const s = siteMode ? px(10) : px(8);
              return (
                <g key={i.id} onPointerDown={(e) => onNodeDown(e, i.id)}
                   style={siteMode ? { cursor: tool === "pipe" ? "crosshair" : "move" } : undefined}>
                  {siteMode && <circle cx={n.x} cy={n.y} r={px(12)} fill="transparent" />}
                  {isSel("inlet", i.id) && <circle cx={n.x} cy={n.y} r={px(10)} fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
                  <rect x={n.x - s / 2} y={n.y - s / 2} width={s} height={s} fill={nodeColor(i.id)} stroke="var(--surface)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                  <text x={n.x + px(7)} y={n.y - px(6)} fontSize={smallSize} className="map-label">{i.id}</text>
                </g>
              );
            })}
            {(() => {
              const o = nodes.get(site.outfall.id)!;
              return (
                <g onPointerDown={(e) => onNodeDown(e, site.outfall.id)}
                   style={siteMode ? { cursor: tool === "pipe" ? "crosshair" : "move" } : undefined}>
                  {siteMode && <circle cx={o.x} cy={o.y} r={px(12)} fill="transparent" />}
                  {isSel("outfall", site.outfall.id) && <circle cx={o.x} cy={o.y} r={px(10)} fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
                  <circle cx={o.x} cy={o.y} r={siteMode ? px(6) : px(5)} fill={nodeColor(site.outfall.id)} stroke="var(--surface)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                  <text x={o.x - px(8)} y={o.y - px(8)} fontSize={smallSize} textAnchor="end" className="map-label">{site.outfall.id}</text>
                </g>
              );
            })()}
          </g>

          {/* Pipe being connected */}
          {drag?.mode === "pipe" && (() => {
            const a = nodes.get(drag.from)!;
            const to = nodeNear(drag, drag.from);
            const b = to ? nodes.get(to)! : drag;
            return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={to ? "var(--accent)" : "var(--pipe)"} strokeWidth={2.5}
                         strokeDasharray={to ? undefined : "5 4"} vectorEffect="non-scaling-stroke" markerEnd="url(#arrow)" pointerEvents="none" />;
          })()}

          {/* Runoff routing arrow for the selected rain garden */}
          {selected && isCapturing(selected) && contributing && (() => {
            const r = rectOf("item", selected.id, selected.rect);
            const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
            const sx = clamp(cx, contributing.rect.x, contributing.rect.x + contributing.rect.width);
            const sy = clamp(cy, contributing.rect.y, contributing.rect.y + contributing.rect.height);
            const fromX = sx === cx && sy === cy ? contributing.rect.x + contributing.rect.width / 2 : sx;
            const fromY = sx === cx && sy === cy ? contributing.rect.y + contributing.rect.height / 2 : sy;
            const ox = Math.sign(fromX - cx) * Math.min(Math.abs(fromX - cx), px(16));
            const oy = Math.sign(fromY - cy) * Math.min(Math.abs(fromY - cy), px(16));
            return (
              <line x1={fromX + ox} y1={fromY + oy} x2={cx} y2={cy} stroke="var(--accent)" strokeWidth={2}
                    vectorEffect="non-scaling-stroke" markerEnd="url(#arrow)" pointerEvents="none" />
            );
          })()}

          {/* Selection handles */}
          {handleFor && (() => {
            const { target, id, rect: r } = handleFor;
            const h = px(9);
            const pts: [Handle, number, number][] = [
              ["nw", r.x, r.y], ["n", r.x + r.width / 2, r.y], ["ne", r.x + r.width, r.y],
              ["e", r.x + r.width, r.y + r.height / 2], ["se", r.x + r.width, r.y + r.height],
              ["s", r.x + r.width / 2, r.y + r.height], ["sw", r.x, r.y + r.height], ["w", r.x, r.y + r.height / 2],
            ];
            const orig = target === "item" ? selected!.rect : selSurface!.rect;
            return (
              <g>
                <rect x={r.x} y={r.y} width={r.width} height={r.height} fill="none" stroke="var(--accent)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" pointerEvents="none" />
                {pts.map(([name, x, y]) => (
                  <rect key={name} x={x - h / 2} y={y - h / 2} width={h} height={h} rx={px(2)}
                        fill="var(--surface)" stroke="var(--accent)" strokeWidth={1.5} vectorEffect="non-scaling-stroke"
                        style={{ cursor: `${name}-resize` }} onPointerDown={(e) => onHandleDown(e, target, id, orig, name)} />
                ))}
              </g>
            );
          })()}

          {/* Drawing preview */}
          {drag?.mode === "draw" && drag.rect.width > 0 && drag.rect.height > 0 && (() => {
            const isSurface = drag.kind === "surface";
            const ok = isSurface || drawHostOk(drag.kind as Intervention["kind"], drag.rect, site);
            const fill = isSurface ? `var(--kind-${surfaceKind})` : LIDS[drag.kind as InterventionKind].fill;
            return (
              <rect x={drag.rect.x} y={drag.rect.y} width={drag.rect.width} height={drag.rect.height}
                    fill={fill} fillOpacity={isSurface ? 0.8 : 0.55}
                    stroke={ok ? "var(--accent)" : "var(--critical)"} strokeWidth={2} vectorEffect="non-scaling-stroke" pointerEvents="none" />
            );
          })()}
        </svg>
        <MapFurniture pxPerM={pxPerM} />
      </div>

      <div className="editor-status" aria-live="polite">
        {status}
        {pointer && pointer.x >= 0 && pointer.y >= 0 && pointer.x <= site.width_m && pointer.y <= site.height_m && (
          <span className="coords num">x {num(pointer.x)} m · y {num(pointer.y)} m</span>
        )}
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi);
}

function sameRect(a: Rect, b: Rect) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function resizeRect(o: Rect, handle: Handle, p: { x: number; y: number }, site: Site): Rect {
  let x1 = o.x, y1 = o.y, x2 = o.x + o.width, y2 = o.y + o.height;
  const px = clamp(Math.round(p.x), 0, site.width_m);
  const py = clamp(Math.round(p.y), 0, site.height_m);
  if (handle.includes("w")) x1 = Math.min(px, x2 - MIN_SIZE);
  if (handle.includes("e")) x2 = Math.max(px, x1 + MIN_SIZE);
  if (handle.includes("n")) y1 = Math.min(py, y2 - MIN_SIZE);
  if (handle.includes("s")) y2 = Math.max(py, y1 + MIN_SIZE);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function drawHostOk(kind: Intervention["kind"], r: Rect, site: Site): boolean {
  const host = hostSurface(site, r);
  return !!host && LIDS[kind].hosts.has(host.kind);
}

function drawStatus(kind: Intervention["kind"], r: Rect, site: Site) {
  const host = hostSurface(site, r);
  const label = LIDS[kind].label;
  const size = `${num(r.width)} × ${num(r.height)} m · ${m2(area(r))}`;
  if (!host) return <span><strong>{label}</strong> · {size} · <span style={{ color: "var(--bad-ink)" }}>must sit inside a single surface</span></span>;
  if (!drawHostOk(kind, r, site)) {
    const need = LIDS[kind].hostHint;
    return <span><strong>{label}</strong> · {size} · <span style={{ color: "var(--bad-ink)" }}>{host.name} isn’t allowed; use {need}</span></span>;
  }
  return <span><strong>{label}</strong> · {size} · on {host.name}</span>;
}

/** Scale bar and north arrow, drawn in screen pixels over the plan. */
function MapFurniture({ pxPerM }: { pxPerM: number }) {
  const meters = [5, 10, 20, 25, 50, 100].find((m) => m * pxPerM >= 70) ?? 100;
  const w = meters * pxPerM;
  return (
    <>
      <div className="map-scale" aria-label={`Scale bar: ${meters} metres`}>
        <svg width={w + 2} height="10" aria-hidden="true">
          <rect x="1" y="3" width={w / 2} height="4" fill="var(--map-label)" />
          <rect x={1 + w / 2} y="3" width={w / 2} height="4" fill="var(--surface)" stroke="var(--map-label)" strokeWidth="1" />
        </svg>
        <span>{meters} m</span>
      </div>
      <div className="map-north" aria-label="North is up">
        <svg width="18" height="22" viewBox="0 0 18 22" aria-hidden="true">
          <path d="M9 1l6 16-6-4-6 4z" fill="var(--map-label)" />
          <path d="M9 1v12l-6 4z" fill="var(--surface)" stroke="var(--map-label)" strokeWidth="0.8" />
        </svg>
        <span>N</span>
      </div>
    </>
  );
}
