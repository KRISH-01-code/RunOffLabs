"use client";

import { useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { m3, num, pctChange, signedPct } from "@/lib/format";
import type { Design, LongTermResult, Project } from "@/lib/types";
import { niceTicks, useWidth } from "./charts/useWidth";
import { Icon } from "./ui";

const BASE_COLOR = "var(--series-baseline)";
const PROP_COLOR = "var(--series-proposed)";
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short" });
const monthLabel = (m: string) => MONTH.format(new Date(`${m}-15T00:00:00`));
const tssOf = (r: LongTermResult) => r.pollutants.find((p) => p.pollutant_id === "TSS")?.outfall_load_kg ?? 0;

/** What changes the year-long result; names and selection don't. */
const keyOf = (p: Project, d: Design | null) => JSON.stringify([p.site, p.scenario.infiltration_factor, p.long_term, d]);

/** Continuous SWMM simulation over a year of rainfall, baseline vs the simulated design. */
export default function LongTermCard({ project, design }: { project: Project; design: Design | null }) {
  const [res, setRes] = useState<{ key: string; baseline: LongTermResult; proposed: LongTermResult | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [table, setTable] = useState(false);
  const lt = project.long_term;
  const noRecord = lt.source === "imported" && !lt.record;

  async function run() {
    setLoading(true);
    setError(null);
    const key = keyOf(project, design);
    try {
      const r = await api.longTerm(project, design);
      setRes({ key, ...r });
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setLoading(false);
    }
  }

  const stale = res !== null && res.key !== keyOf(project, design);
  const label = design?.name ?? "Design";
  const source = lt.source === "synthetic" ? `a synthetic year of ${num(lt.annual_mm)} mm` : lt.record?.name ?? "the imported record";

  return (
    <section className="card" aria-labelledby="h-year-result">
      <div className="card-head" style={{ flexWrap: "wrap" }}>
        <h3 id="h-year-result"><Icon name="rain" size={16} />Over a whole year</h3>
        <span className="muted small">Every storm and dry spell in {source}</span>
        <span className="spacer" style={{ flex: 1 }} />
        {stale && <span className="stale-note"><Icon name="warn" size={14} /> Inputs changed since this run.</span>}
        <button className="btn sm" disabled={loading || noRecord} onClick={() => void run()}
                title={noRecord ? "Import a rainfall record under Storm & soil first" : undefined}>
          {loading ? <span className="spinner" /> : <Icon name="play" size={12} />} {res ? "Run again" : "Run year-long simulation"}
        </button>
      </div>
      {error && <p className="small" style={{ color: "var(--bad-ink)", padding: "10px 14px" }}>{error}</p>}
      {!res && !error && (
        <p className="small muted" style={{ padding: "12px 14px" }}>
          A design storm shows one big event. Regulators and planners also ask what share of <em>all</em> the rain in a
          year a site keeps out of the pipes. This runs SWMM continuously through a year of hourly rainfall, with soils and
          green infrastructure drying out between storms{design ? `, for the baseline and ${label}` : ""}.
          {noRecord ? " Import a rainfall record under Storm & soil first, or switch to the synthetic year." : " Takes a few seconds."}
          {" "}Rainfall is set under <strong>Storm &amp; soil → Year-long rainfall</strong>.
        </p>
      )}
      {res && <Summary res={res} label={label} table={table} setTable={setTable} stale={stale} />}
    </section>
  );
}

function Summary({ res, label, table, setTable, stale }: {
  res: { baseline: LongTermResult; proposed: LongTermResult | null }; label: string;
  table: boolean; setTable: (t: boolean) => void; stale: boolean;
}) {
  const { baseline: b, proposed: p } = res;
  const kept = (r: LongTermResult) => `${num(r.kept_on_site_pct)} %`;
  // Imported records needn't be a year long, so say what period the totals cover.
  const days = Math.round(b.hours / 24);
  const yearLong = days >= 360 && days <= 370;
  const period = yearLong ? "a year" : `over these ${num(days)} days`;
  const periodLabel = yearLong ? "in the year" : `in ${num(days)} days`;
  return (
    <div className={`whatif-body${stale ? " stale-dim" : ""}`}>
      <p className="whatif-summary">
        In {num(b.rainfall_mm)} mm of rain over {num(b.hours / 24)} days, the site keeps <strong>{kept(b)}</strong> of it out
        of the pipes today
        {p ? <> and <strong>{kept(p)}</strong> with {label}: {m3(b.runoff_m3 - p.runoff_m3)} less runoff {period}.</> : "."}
      </p>
      <div className="year-kpis">
        <YearKpi label="Rain kept on site" base={kept(b)} value={p ? kept(p) : null} delta={p ? `${p.kept_on_site_pct >= b.kept_on_site_pct ? "+" : "−"}${num(Math.abs(p.kept_on_site_pct - b.kept_on_site_pct))} points` : null} good={p ? p.kept_on_site_pct > b.kept_on_site_pct : null} />
        <YearKpi label={`Runoff ${periodLabel}`} base={m3(b.runoff_m3)} value={p ? m3(p.runoff_m3) : null} delta={p ? signedPct(pctChange(p.runoff_m3, b.runoff_m3) ?? 0) : null} good={p ? p.runoff_m3 < b.runoff_m3 : null} />
        <YearKpi label="Sediment to the creek" base={`${num(tssOf(b))} kg`} value={p ? `${num(tssOf(p))} kg` : null} delta={p ? signedPct(pctChange(tssOf(p), tssOf(b)) ?? 0) : null} good={p ? tssOf(p) < tssOf(b) : null} />
        <YearKpi label="Days water left the site" base={num(b.outflow_days)} value={p ? num(p.outflow_days) : null} delta={p ? `${p.outflow_days - b.outflow_days > 0 ? "+" : p.outflow_days < b.outflow_days ? "−" : "±"}${Math.abs(p.outflow_days - b.outflow_days)} days` : null} good={p ? p.outflow_days < b.outflow_days : null} />
      </div>
      <div className="chart-title" style={{ padding: 0 }}>
        <div>
          <h3>Runoff by month</h3>
          <span className="chart-sub">m³ running from the surfaces into the drains</span>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {p && (
            <div className="legend">
              <span><span className="swatch" style={{ background: BASE_COLOR }} />Baseline</span>
              <span><span className="swatch" style={{ background: PROP_COLOR }} />{label}</span>
            </div>
          )}
          <div className="segmented" aria-label="View">
            <button aria-pressed={!table} onClick={() => setTable(false)}>Chart</button>
            <button aria-pressed={table} onClick={() => setTable(true)}>Table</button>
          </div>
        </div>
      </div>
      {table ? <MonthTable b={b} p={p} label={label} /> : <MonthChart b={b} p={p} label={label} />}
      <p className="small muted">
        Continuous SWMM run with hourly rain, 3 mm/day evaporation and 48 h of drainage after the record ends.
        {b.record_source === "synthetic" && " The rainfall is a synthetic year, not a measured record."}
        {" "}Run time {num(b.elapsed_s + (p?.elapsed_s ?? 0), 1)} s · continuity error {num(b.continuity_error_pct, 2)} %.
      </p>
    </div>
  );
}

function YearKpi({ label, base, value, delta, good }: {
  label: string; base: string; value: string | null; delta: string | null; good: boolean | null;
}) {
  return (
    <div className="year-kpi">
      <span className="label">{label}</span>
      <span className="value num">{value ?? base}</span>
      {delta && <span className={`delta ${good ? "good" : "bad"} num`}>{delta}</span>}
      {value && <span className="base num">Baseline {base}</span>}
    </div>
  );
}

function MonthChart({ b, p, label }: { b: LongTermResult; p: LongTermResult | null; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const M = { top: 10, right: 8, bottom: 26, left: 52 };
  const H = 220;
  const months = b.months;
  const max = Math.max(...months.map((m) => m.runoff_m3), ...(p?.months.map((m) => m.runoff_m3) ?? []), 1);
  const ticks = useMemo(() => niceTicks(max, 4), [max]);
  const top = ticks.at(-1)!;
  const inner = width - M.left - M.right, ih = H - M.top - M.bottom;
  const band = inner / Math.max(months.length, 1);
  const bars = p ? 2 : 1;
  const bw = Math.max(Math.min((band - 6) / bars - 1, 22), 2);
  const y = (v: number) => M.top + ih - (v / top) * ih;
  const bar = (x: number, v: number, color: string, title: string) => {
    const h = Math.max(ih - (y(v) - M.top), 0), r = Math.min(4, h, bw / 2);
    const y0 = M.top + ih;
    return (
      <path fill={color} d={`M${x},${y0}V${y0 - h + r}Q${x},${y0 - h} ${x + r},${y0 - h}H${x + bw - r}Q${x + bw},${y0 - h} ${x + bw},${y0 - h + r}V${y0}Z`}>
        <title>{title}</title>
      </path>
    );
  };
  return (
    <div className="chart-wrap" ref={ref}>
      <svg width={width} height={H} role="img" aria-label={`Monthly runoff, baseline${p ? ` and ${label}` : ""}; see the table view for values`}>
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? "baseline" : "gridline"} x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} />
            <text className="tick" x={M.left - 6} y={y(t) + 4} textAnchor="end">{num(t)}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const x0 = M.left + i * band + (band - (bw * bars + (bars - 1) * 2)) / 2;
          const pm = p?.months[i];
          return (
            <g key={m.month}>
              {bar(x0, m.runoff_m3, BASE_COLOR, `${monthLabel(m.month)}: ${num(m.runoff_m3)} m³ today, ${num(m.rainfall_mm)} mm of rain`)}
              {pm && bar(x0 + bw + 2, pm.runoff_m3, PROP_COLOR, `${monthLabel(m.month)}: ${num(pm.runoff_m3)} m³ with ${label}`)}
              <text className="tick" x={M.left + i * band + band / 2} y={H - 8} textAnchor="middle">{monthLabel(m.month)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function MonthTable({ b, p, label }: { b: LongTermResult; p: LongTermResult | null; label: string }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>Month</th><th>Rain</th><th>Runoff, baseline</th>{p && <><th>Runoff, {label}</th><th>Change</th></>}</tr></thead>
        <tbody>
          {b.months.map((m, i) => {
            const pm = p?.months[i];
            return (
              <tr key={m.month}>
                <td>{monthLabel(m.month)} {m.month.slice(0, 4)}</td>
                <td>{num(m.rainfall_mm)} mm</td>
                <td>{m3(m.runoff_m3)}</td>
                {pm && <><td>{m3(pm.runoff_m3)}</td><td>{signedPct(pctChange(pm.runoff_m3, m.runoff_m3) ?? 0)}</td></>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
