"use client";

import { useState } from "react";
import { hhmm, num } from "@/lib/format";
import type { SimulationResult } from "@/lib/types";
import { niceTicks, useWidth } from "./useWidth";

export interface Series { key: string; label: string; color: string; result: SimulationResult }

const M = { top: 8, right: 16, bottom: 30, left: 52 };
const RAIN_H = 72;
const GAP = 26;
const FLOW_H = 220;

/**
 * Rainfall hyetograph above outfall hydrographs, sharing one time axis.
 * Rain and flow sit on separate panels, each with its own y-axis, never on a dual axis.
 */
export default function StormChart({ series, zoom = "full" }: { series: Series[]; zoom?: "peak" | "full" }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const ts = series[0].result.series;
  const [i0, i1] = zoom === "peak" ? activeWindow(series) : [0, ts.minutes.length - 1];
  const minutes = ts.minutes.slice(i0, i1 + 1);
  const rain = ts.rainfall_mm_hr.slice(i0, i1 + 1);
  const flows = series.map((s) => s.result.series.outfall_m3s.slice(i0, i1 + 1));
  const n = minutes.length;
  const innerW = width - M.left - M.right;
  const tMin = zoom === "peak" ? minutes[0] : 0;
  const tMax = minutes[n - 1] || 1;
  const x = (min: number) => M.left + ((min - tMin) / (tMax - tMin || 1)) * innerW;

  const rainTicks = niceTicks(Math.max(...rain), 2);
  const rainMax = rainTicks.at(-1)!;
  const yRain = (v: number) => M.top + RAIN_H - (v / rainMax) * RAIN_H;

  const flowTop = M.top + RAIN_H + GAP;
  const flowMaxRaw = Math.max(...flows.flat());
  const flowTicks = niceTicks(flowMaxRaw, 4);
  const flowMax = flowTicks.at(-1)!;
  const yFlow = (v: number) => flowTop + FLOW_H - (v / flowMax) * FLOW_H;
  const height = flowTop + FLOW_H + M.bottom;

  const spanH = (tMax - tMin) / 60;
  const hourStep = spanH > 24 ? 6 : spanH > 8 ? 2 : 1;
  const firstTick = Math.ceil(tMin / 60 / hourStep) * hourStep;
  const hourTicks = Array.from({ length: Math.floor((tMax / 60 - firstTick) / hourStep) + 1 },
    (_, i) => (firstTick + i * hourStep) * 60);
  const barW = Math.max(innerW / n - 0.5, 0.5);

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = tMin + ((e.clientX - rect.left - M.left) / innerW) * (tMax - tMin);
    if (t < tMin || t > tMax) return setHover(null);
    // Report steps are evenly spaced; snap to the nearest one.
    const step = minutes[1] - minutes[0] || 1;
    setHover(Math.min(Math.max(Math.round((t - minutes[0]) / step), 0), n - 1));
  }

  const path = (vals: number[]) =>
    vals.map((v, i) => `${i ? "L" : "M"}${x(minutes[i]).toFixed(1)},${yFlow(v).toFixed(1)}`).join("");

  const hx = hover !== null ? x(minutes[hover]) : 0;
  const tipLeft = hover !== null && hx > width - 200 ? hx - 184 : hx + 12;

  return (
    <div className="chart-wrap" ref={ref}>
      <svg width={width} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)}
           role="img" aria-label="Rainfall intensity and outfall discharge over the storm">
        {/* Rain panel */}
        {rainTicks.map((t) => (
          <g key={`r${t}`}>
            <line className={t === 0 ? "baseline" : "gridline"} x1={M.left} x2={width - M.right} y1={yRain(t)} y2={yRain(t)} />
            <text className="tick" x={M.left - 8} y={yRain(t) + 4} textAnchor="end">{num(t)}</text>
          </g>
        ))}
        <text className="axis-title" x={M.left} y={M.top + 2} dx={6} dy={8}>Rainfall, mm/h</text>
        {rain.map((v, i) => v > 0 && (
          <rect key={i} x={x(minutes[i]) - barW} y={yRain(v)} width={barW} height={yRain(0) - yRain(v)}
                fill="var(--water)" opacity={hover === i ? 0.95 : 0.6} />
        ))}

        {/* Flow panel */}
        {flowTicks.map((t) => (
          <g key={`f${t}`}>
            <line className={t === 0 ? "baseline" : "gridline"} x1={M.left} x2={width - M.right} y1={yFlow(t)} y2={yFlow(t)} />
            <text className="tick" x={M.left - 8} y={yFlow(t) + 4} textAnchor="end">{num(t, flowMax < 1 ? 2 : 1)}</text>
          </g>
        ))}
        <text className="axis-title" x={M.left} y={flowTop + 2} dx={6} dy={8}>Outfall discharge, m³/s</text>
        {hourTicks.map((m) => (
          <text key={m} className="tick" x={x(m)} y={height - 10} textAnchor="middle">{m / 60} h</text>
        ))}
        {series.map((s, si) => (
          <path key={s.key} d={path(flows[si])} fill="none" stroke={s.color}
                strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}

        {/* Crosshair */}
        {hover !== null && (
          <g pointerEvents="none">
            <line className="crosshair" x1={hx} x2={hx} y1={M.top} y2={flowTop + FLOW_H} />
            {series.map((s, si) => (
              <circle key={s.key} cx={hx} cy={yFlow(flows[si][hover])} r={4}
                      fill={s.color} stroke="var(--surface)" strokeWidth={2} />
            ))}
          </g>
        )}
        <rect x={M.left} y={M.top} width={innerW} height={flowTop + FLOW_H - M.top} fill="transparent" />
      </svg>

      {hover !== null && (
        <div className="tooltip" style={{ left: tipLeft, top: flowTop }}>
          <div className="t-head num">{hhmm(minutes[hover])} after storm start</div>
          <div className="t-row"><span className="line-key" style={{ background: "var(--water)" }} />
            <strong>{num(rain[hover], 1)} mm/h</strong><span>rainfall</span></div>
          {series.map((s, si) => (
            <div className="t-row" key={s.key}><span className="line-key" style={{ background: s.color }} />
              <strong>{num(flows[si][hover], 3)} m³/s</strong><span>{s.label}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Index range where rain or outfall flow is non-negligible, padded by an hour each side. */
export function activeWindow(series: Series[]): [number, number] {
  const ts = series[0].result.series;
  const n = ts.minutes.length;
  const flowMax = Math.max(...series.flatMap((s) => s.result.series.outfall_m3s));
  const rainMax = Math.max(...ts.rainfall_mm_hr);
  const active = (i: number) => ts.rainfall_mm_hr[i] > 0.05 * rainMax
    || series.some((s) => s.result.series.outfall_m3s[i] > 0.05 * flowMax);
  let first = 0, last = n - 1;
  while (first < n - 1 && !active(first)) first++;
  while (last > first && !active(last)) last--;
  const pad = Math.round(60 / (ts.step_minutes || 5));
  return [Math.max(first - pad, 0), Math.min(last + pad, n - 1)];
}

/** Hourly table of the same series, so no value is hover-only. */
export function StormTable({ series }: { series: Series[] }) {
  const ts = series[0].result.series;
  const perHour = Math.max(Math.round(60 / ts.step_minutes), 1);
  const rows = ts.minutes.map((m, i) => ({ m, i })).filter(({ i }) => (i + 1) % perHour === 0);
  return (
    <div className="table-wrap" style={{ maxHeight: 300, overflowY: "auto" }}>
      <table className="data">
        <thead>
          <tr>
            <th>Time</th><th>Rainfall (mm/h)</th>
            {series.map((s) => <th key={s.key}>{s.label} outfall (m³/s)</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ m, i }) => (
            <tr key={m}>
              <td className="num">{hhmm(m)}</td>
              <td>{num(ts.rainfall_mm_hr[i], 1)}</td>
              {series.map((s) => <td key={s.key}>{num(s.result.series.outfall_m3s[i], 3)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
