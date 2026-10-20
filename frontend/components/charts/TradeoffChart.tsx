"use client";

import { useMemo, useState } from "react";
import { money, num, pctChange, signedPct } from "@/lib/format";
import type { ExploreMetrics, ExploreObjective, ExplorePoint } from "@/lib/types";
import { niceTicks, useWidth } from "./useWidth";

const M = { top: 16, right: 20, bottom: 40, left: 64 };
const HEIGHT = 360;
const HIT_PX = 24;

const metric = (o: ExploreObjective) => (p: ExploreMetrics) => (o === "runoff_volume" ? p.runoff_m3 : p.peak_m3s);

/**
 * Cost against the chosen runoff metric for every design tried. The Pareto
 * front (best trade-offs) is drawn as a connected step line; other designs
 * recede in gray, and today's site sits at zero cost.
 */
export default function TradeoffChart({ points, frontIds, baseline, objective, budget, currency, selectedId, onSelect }: {
  points: ExplorePoint[];
  frontIds: number[];
  baseline: ExploreMetrics | null;
  objective: ExploreObjective;
  budget: number;
  currency: string;
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | "baseline" | null>(null);
  const y = metric(objective);
  const front = useMemo(() => {
    const ids = new Set(frontIds);
    return points.filter((p) => ids.has(p.id)).sort((a, b) => a.cost - b.cost);
  }, [points, frontIds]);
  const isFront = useMemo(() => new Set(frontIds), [frontIds]);

  const innerW = width - M.left - M.right;
  const innerH = HEIGHT - M.top - M.bottom;
  const xTicks = niceTicks(Math.max(budget, ...points.map((p) => p.cost), 1), 5);
  const xMax = xTicks.at(-1)!;
  const ys = [...points.map(y), ...(baseline ? [y(baseline)] : [])];
  // Before the first result arrives there's nothing to scale to; show an empty 0–1 frame.
  const yHiRaw = ys.length ? Math.max(...ys) : 1;
  const yLoRaw = ys.length ? Math.min(...ys) : 0;
  // A dot plot needn't start at zero; pad the observed range instead.
  const span = Math.max(yHiRaw - yLoRaw, yHiRaw * 0.05);
  const yLo = Math.max(0, yLoRaw - span * 0.08);
  const yHi = yHiRaw + span * 0.08;
  const yTicks = ticksBetween(yLo, yHi, 5);
  const sx = (v: number) => M.left + (v / xMax) * innerW;
  const sy = (v: number) => M.top + innerH - ((v - yLo) / (yHi - yLo)) * innerH;
  const fmtY = (v: number) => (objective === "runoff_volume" ? `${num(v)} m³` : `${num(v, 3)} m³/s`);
  const unitLabel = objective === "runoff_volume" ? "Runoff volume, m³" : "Peak outfall discharge, m³/s";

  const step = front.length
    ? [`M${sx(front[0].cost)},${sy(y(front[0]))}`,
       ...front.slice(1).map((p) => `H${sx(p.cost)}V${sy(y(p))}`)].join("")
    : "";

  function nearest(e: React.MouseEvent<SVGSVGElement>): number | "baseline" | null {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    let best: number | "baseline" | null = null, bestD = HIT_PX;
    if (baseline) {
      const d = Math.hypot(sx(0) - px, sy(y(baseline)) - py);
      if (d < bestD) { best = "baseline"; bestD = d; }
    }
    for (const p of points) {
      // Favour front points slightly so they win ties with gray neighbours.
      const d = Math.hypot(sx(p.cost) - px, sy(y(p)) - py) - (isFront.has(p.id) ? 3 : 0);
      if (d < bestD) { best = p.id; bestD = d; }
    }
    return best;
  }

  const hovered = typeof hover === "number" ? points.find((p) => p.id === hover) : null;
  const tip = hover === "baseline" && baseline
    ? { x: sx(0), y: sy(y(baseline)), title: "Today’s site", rows: [["$0", "no green infrastructure"], [fmtY(y(baseline)), objective === "runoff_volume" ? "runoff" : "peak flow"]] }
    : hovered && baseline
      ? {
          x: sx(hovered.cost), y: sy(y(hovered)),
          title: `${isFront.has(hovered.id) ? "Best trade-off · " : ""}${hovered.design.interventions.length} intervention${hovered.design.interventions.length === 1 ? "" : "s"}`,
          rows: [
            [money(hovered.cost, currency), "cost"],
            [`${fmtY(y(hovered))} (${signedPct(pctChange(y(hovered), y(baseline)) ?? 0)})`, objective === "runoff_volume" ? "runoff" : "peak flow"],
            [`${num(hovered.area_m2)} m²`, "footprint"],
          ],
        }
      : null;

  return (
    <div className="chart-wrap" ref={ref}>
      <svg width={width} height={HEIGHT} role="img" style={{ cursor: hover !== null ? "pointer" : "default" }}
           aria-label={`Cost against ${unitLabel.toLowerCase()} for ${points.length} designs`}
           onPointerMove={(e) => setHover(nearest(e))} onPointerLeave={() => setHover(null)}
           onClick={(e) => { const n = nearest(e); if (typeof n === "number") onSelect(n); }}>
        {yTicks.map((t, i) => (
          <g key={`y${i}`}>
            <line className="gridline" x1={M.left} x2={width - M.right} y1={sy(t)} y2={sy(t)} />
            <text className="tick" x={M.left - 8} y={sy(t) + 4} textAnchor="end">{objective === "runoff_volume" ? num(t) : num(t, 3)}</text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={`x${t}`} className="tick" x={sx(t)} y={HEIGHT - M.bottom + 18} textAnchor="middle">
            {t >= 1000 ? `${num(t / 1000)}K` : num(t)}
          </text>
        ))}
        <line className="baseline" x1={M.left} x2={width - M.right} y1={M.top + innerH} y2={M.top + innerH} />
        <text className="axis-title" x={M.left} y={M.top - 4}>{unitLabel}</text>
        <text className="axis-title" x={width - M.right} y={HEIGHT - 6} textAnchor="end">Cost, {currency}</text>

        {budget > 0 && budget <= xMax && (
          <g>
            <line x1={sx(budget)} x2={sx(budget)} y1={M.top} y2={M.top + innerH} stroke="var(--axis)" strokeWidth={1} />
            <text className="tick" x={sx(budget) - 6} y={M.top + 12} textAnchor="end">Budget</text>
          </g>
        )}

        {points.filter((p) => !isFront.has(p.id)).map((p) => (
          <circle key={p.id} cx={sx(p.cost)} cy={sy(y(p))} r={3} fill="var(--ink-muted)" opacity={hover === p.id ? 0.9 : 0.35} />
        ))}
        {step && <path d={step} fill="none" stroke="var(--series-proposed)" strokeWidth={2} strokeLinejoin="round" />}
        {front.map((p) => (
          <circle key={p.id} cx={sx(p.cost)} cy={sy(y(p))} r={hover === p.id ? 6 : 4.5}
                  fill="var(--series-proposed)" stroke="var(--surface)" strokeWidth={2} />
        ))}
        {baseline && (
          <g>
            <circle cx={sx(0)} cy={sy(y(baseline))} r={hover === "baseline" ? 6.5 : 5} fill="var(--series-baseline)" stroke="var(--surface)" strokeWidth={2} />
            <text className="tick" x={sx(0) + 2} y={sy(y(baseline)) + 20} style={{ fill: "var(--ink-2)" }}>Today</text>
          </g>
        )}
        {selectedId !== null && (() => {
          const p = points.find((q) => q.id === selectedId);
          return p && <circle cx={sx(p.cost)} cy={sy(y(p))} r={9} fill="none" stroke="var(--ink)" strokeWidth={1.5} />;
        })()}
      </svg>
      {tip && (
        <div className="tooltip" style={{ left: tip.x > width - 220 ? tip.x - 212 : tip.x + 14, top: Math.max(tip.y - 30, 0) }}>
          <div className="t-head">{tip.title}</div>
          {tip.rows.map(([v, l]) => (
            <div className="t-row" key={l}><strong>{v}</strong><span>{l}</span></div>
          ))}
          {hovered && <div className="t-head" style={{ marginTop: 2 }}>Click to inspect</div>}
        </div>
      )}
    </div>
  );
}

function ticksBetween(lo: number, hi: number, count: number): number[] {
  const raw = (hi - lo) / count || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const decimals = Math.max(0, 1 - Math.floor(Math.log10(step)));
  const out = [];
  for (let k = Math.ceil(lo / step); k * step <= hi + step * 1e-6; k++) out.push(+(k * step).toFixed(decimals));
  return out;
}
