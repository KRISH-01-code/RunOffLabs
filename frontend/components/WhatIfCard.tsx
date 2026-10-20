"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { m3, m3s, num, pctChange, signedPct } from "@/lib/format";
import type { Design, Project, WhatIfCase } from "@/lib/types";
import { niceTicks, useWidth } from "./charts/useWidth";
import { Icon } from "./ui";

/** Stress-tests the simulated design under bigger storms and degraded infiltration. */
export default function WhatIfCard({ project, design }: { project: Project; design: Design }) {
  const [cases, setCases] = useState<WhatIfCase[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      setCases(await api.whatIf(project, design));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const reductions = cases?.map((c) => ({ c, pct: -(pctChange(c.proposed.runoff_m3, c.baseline.runoff_m3) ?? 0) }));
  const weakest = reductions && [...reductions].sort((a, b) => a.pct - b.pct)[0];
  const strongest = reductions && [...reductions].sort((a, b) => b.pct - a.pct)[0];

  return (
    <section className="card" aria-labelledby="h-whatif">
      <div className="card-head">
        <h3 id="h-whatif"><Icon name="warn" size={16} />What if?</h3>
        <span className="muted small">How {design.name} holds up beyond the design storm</span>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn sm" disabled={loading} onClick={() => void run()}>
          {loading ? <span className="spinner" /> : <Icon name="play" size={12} />} {cases ? "Run again" : "Stress-test this design"}
        </button>
      </div>
      {error && <p className="small" style={{ color: "var(--bad-ink)", padding: "10px 14px" }}>{error}</p>}
      {!cases && !error && (
        <p className="small muted" style={{ padding: "12px 14px" }}>
          Runs the baseline and this design under smaller and bigger storms, and with soil and green
          infrastructure that soak up water more slowly than designed (compaction, clogging). 14 SWMM runs.
        </p>
      )}
      {cases && reductions && weakest && strongest && (
        <div className="whatif-body">
          <p className="whatif-summary">
            Runoff reduction ranges from <strong>{num(weakest.pct)} %</strong> ({weakest.c.label.toLowerCase()}) to{" "}
            <strong>{num(strongest.pct)} %</strong> ({strongest.c.label.toLowerCase()}).
            {cases.some((c) => c.proposed.flooding_m3 > 0.5) && " Some cases still flood a drain; see the table."}
          </p>
          <ReductionBars rows={reductions.map(({ c, pct }) => ({ id: c.id, label: c.label, pct }))} />
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Case</th><th>Rain</th><th>Seepage</th><th>Runoff, baseline</th><th>Runoff, design</th>
                  <th>Change</th><th>Peak, baseline</th><th>Peak, design</th><th>Change</th><th>Flooding, design</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id}>
                    <td title={c.description}>{c.label}</td>
                    <td>{num(c.depth_mm)} mm</td>
                    <td>×{num(c.infiltration_factor, 2)}</td>
                    <td>{m3(c.baseline.runoff_m3)}</td>
                    <td>{m3(c.proposed.runoff_m3)}</td>
                    <td>{signedPct(pctChange(c.proposed.runoff_m3, c.baseline.runoff_m3) ?? 0)}</td>
                    <td>{m3s(c.baseline.peak_m3s)}</td>
                    <td>{m3s(c.proposed.peak_m3s)}</td>
                    <td>{signedPct(pctChange(c.proposed.peak_m3s, c.baseline.peak_m3s) ?? 0)}</td>
                    <td>{m3(c.proposed.flooding_m3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

const BAR = 16;
const GAP = 10;
const LABEL_W = 200;

export function ReductionBars({ rows, caption = "Runoff reduction compared with the baseline, %", label = "Runoff reduction by case" }: {
  rows: { id: string; label: string; pct: number }[];
  caption?: string;
  label?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const ticks = niceTicks(Math.max(...rows.map((r) => r.pct), 1), 4);
  const max = ticks.at(-1)!;
  const inner = width - LABEL_W - 48;
  const x = (v: number) => (Math.max(v, 0) / max) * inner;
  const height = rows.length * (BAR + GAP) + 24;
  return (
    <div className="chart-wrap" ref={ref}>
      <div className="chart-sub" style={{ marginBottom: 6 }}>{caption}</div>
      <svg width={width} height={height} role="img" aria-label={label}>
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? "baseline" : "gridline"} x1={LABEL_W + x(t)} x2={LABEL_W + x(t)} y1={0} y2={height - 20} />
            <text className="tick" x={LABEL_W + x(t)} y={height - 4} textAnchor="middle">{num(t)}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const y = i * (BAR + GAP) + GAP / 2;
          const w = x(r.pct);
          const rad = Math.min(4, w);
          return (
            <g key={r.id}>
              <title>{`${r.label}: ${num(r.pct, 1)} % less runoff`}</title>
              <text x={0} y={y + BAR / 2 + 4} fontSize={12} fill="var(--ink-2)">{r.label}</text>
              {w > 0.5 && (
                <path fill="var(--series-proposed)"
                      d={`M${LABEL_W},${y}H${LABEL_W + w - rad}Q${LABEL_W + w},${y} ${LABEL_W + w},${y + rad}V${y + BAR - rad}Q${LABEL_W + w},${y + BAR} ${LABEL_W + w - rad},${y + BAR}H${LABEL_W}Z`} />
              )}
              <text x={LABEL_W + w + 6} y={y + BAR / 2 + 4} fontSize={11.5} fill="var(--ink)" className="num">{num(r.pct)} %</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
