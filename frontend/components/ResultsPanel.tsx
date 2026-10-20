"use client";

import { useState } from "react";
import { m3, m3s, money, num, pctChange, signedPct } from "@/lib/format";
import type { Design, Project, SimulationResult } from "@/lib/types";
import BalanceChart from "./charts/BalanceChart";
import CompareCard from "./CompareCard";
import LongTermCard from "./LongTermCard";
import PlaybackCard from "./PlaybackCard";
import WaterQualityCard from "./WaterQualityCard";
import WhatIfCard from "./WhatIfCard";
import StormChart, { StormTable, type Series } from "./charts/StormChart";
import { api } from "@/lib/api";
import { LIDS } from "@/lib/lids";
import { Icon, type IconName } from "./ui";

export interface RunOutput {
  project: Project; // the project as it was simulated
  baseline: SimulationResult;
  proposed: SimulationResult | null;
  design: Design | null; // the design as it was simulated
  cost: number;
  scenarioLabel: string;
}

const BASE_COLOR = "var(--series-baseline)";
const PROP_COLOR = "var(--series-proposed)";

export default function ResultsPanel({ project, run, stale, running, error, onRun, canRun, exploreJobId, onOpenDesign }: {
  project: Project;
  onOpenDesign: (id: string) => void;
  exploreJobId: string | null;
  run: RunOutput | null;
  stale: boolean;
  running: boolean;
  error: string | null;
  onRun: () => void;
  canRun: boolean;
}) {
  const [tableView, setTableView] = useState(false);
  const [zoom, setZoom] = useState<"peak" | "full">("peak");

  if (!run) {
    return (
      <section className="results" id="results" aria-labelledby="h-results">
        <div className="card empty-state">
          <RainIllustration />
          <h2 id="h-results">See where the rain goes</h2>
          <p>Run EPA SWMM to compare today’s site with your design: how much runs off, how much soaks in, and how high the peak flow gets.</p>
          {error && <p style={{ color: "var(--bad-ink)" }}>{error}</p>}
          <button className="btn primary" disabled={!canRun || running} onClick={onRun}>
            {running ? <span className="spinner" /> : <Icon name="play" size={14} />} Run simulation
          </button>
        </div>
      </section>
    );
  }

  const { baseline, proposed } = run;
  const label = run.design?.name ?? "Proposed";
  const series: Series[] = [
    { key: "baseline", label: "Baseline", color: BASE_COLOR, result: baseline },
    ...(proposed ? [{ key: "proposed", label, color: PROP_COLOR, result: proposed }] : []),
  ];
  const cur = project.costs.currency;

  return (
    <section className="results" id="results" aria-labelledby="h-results">
      <div className="results-head">
        <h2 id="h-results">Results</h2>
        <span className="muted">{run.scenarioLabel}{proposed ? ` · Baseline vs ${label}` : " · Baseline only"}</span>
        {stale && (
          <span className="stale-note"><Icon name="warn" size={14} /> Inputs changed since this run.
            <button className="btn sm" style={{ height: 22, marginLeft: 4 }} disabled={!canRun || running} onClick={onRun}>Re-run</button>
          </span>
        )}
        {error && <span className="stale-note" style={{ background: "var(--error-wash)" }}>{error}</span>}
        {proposed && run.design && <ReportButton project={run.project} designId={run.design.id} exploreJobId={exploreJobId} />}
      </div>

      <div className={`results-body${stale ? " stale" : ""}`}>
        {proposed && <Impact baseline={baseline} proposed={proposed} label={label} />}
        <div className="kpis">
          <Kpi icon="drop" water label="Runoff volume" base={baseline.balance.runoff_m3} value={proposed?.balance.runoff_m3} fmt={m3} lowerIsBetter />
          <Kpi icon="wave" water label="Peak outfall discharge" base={baseline.peak_outfall_m3s} value={proposed?.peak_outfall_m3s} fmt={m3s} lowerIsBetter />
          <Kpi icon="sprout" label="Soaked into the ground" base={baseline.balance.infiltration_m3} value={proposed?.balance.infiltration_m3} fmt={m3} />
          <Kpi icon="warn" water label="Node flooding" base={baseline.flooding_volume_m3} value={proposed?.flooding_volume_m3} fmt={m3} lowerIsBetter />
          <div className="card kpi">
            <span className="label"><span className="kpi-icon"><Icon name="coins" size={14} /></span>Intervention cost</span>
            <span className="value">{money(run.cost, cur)}</span>
            <span className="base">Budget {money(project.constraints.budget, cur)}</span>
          </div>
        </div>

        <div className="charts">
          <div className="card chart-card">
            <div className="chart-title">
              <div>
                <h3>Storm response at the outfall</h3>
                <span className="chart-sub">Rainfall (top) and discharge leaving the site (bottom)</span>
              </div>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                {series.length > 1 && (
                  <div className="legend">
                    {series.map((s) => (
                      <span key={s.key}><span className="line-key" style={{ background: s.color }} />{s.label}</span>
                    ))}
                  </div>
                )}
                {!tableView && (
                  <div className="segmented" aria-label="Time range">
                    <button aria-pressed={zoom === "peak"} onClick={() => setZoom("peak")}>Peak</button>
                    <button aria-pressed={zoom === "full"} onClick={() => setZoom("full")}>Full storm</button>
                  </div>
                )}
                <div className="segmented" aria-label="View">
                  <button aria-pressed={!tableView} onClick={() => setTableView(false)}>Chart</button>
                  <button aria-pressed={tableView} onClick={() => setTableView(true)}>Table</button>
                </div>
              </div>
            </div>
            {tableView ? <StormTable series={series} /> : <StormChart series={series} zoom={zoom} />}
          </div>

          <div className="card chart-card">
            <div className="chart-title">
              <div>
                <h3>Where the rain went</h3>
                <span className="chart-sub">Depth over the whole site, mm · {num(baseline.balance.rainfall_mm, 1)} mm fell</span>
              </div>
              {series.length > 1 && (
                <div className="legend">
                  {series.map((s) => (
                    <span key={s.key}><span className="swatch" style={{ background: s.color }} />{s.label}</span>
                  ))}
                </div>
              )}
            </div>
            <BalanceChart entries={series.map((s) => ({ key: s.key, label: s.label, color: s.color, balance: s.result.balance }))} />
          </div>
        </div>

        <WaterQualityCard baseline={baseline} proposed={proposed} label={label} />

        <PlaybackCard site={project.site} baseline={baseline} proposed={proposed} design={run.design} label={label} />

        {proposed && run.design && <WhatIfCard key={baseline.inp_sha256 + proposed.inp_sha256} project={run.project} design={run.design} />}

        {/* The year uses the site and design as simulated, with the current rainfall settings. */}
        <LongTermCard project={{ ...run.project, long_term: project.long_term }} design={run.design} />

        <CompareCard project={project} onOpenDesign={onOpenDesign} />

        {proposed && proposed.lids.length > 0 && (
          <div className="card">
            <div className="card-head"><h3><Icon name="leaf" size={16} />Green infrastructure performance</h3></div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Intervention</th><th>Area</th><th>Inflow</th><th>Infiltrated</th><th>Overflow</th><th title="Through an underdrain or a barrel’s tap, to the pipes">Drained</th><th>Stored at end</th><th>Share infiltrated</th></tr>
                </thead>
                <tbody>
                  {proposed.lids.map((l) => {
                    const item = run.design?.interventions.find((i) => i.id === l.intervention_id);
                    return (
                      <tr key={l.intervention_id}>
                        <td>
                          <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                            <span className="swatch" style={{ background: item ? LIDS[item.kind].fill : "var(--rg-fill)" }} />
                            {l.intervention_id} <span className="muted">{item ? LIDS[item.kind].label : ""}</span>
                          </span>
                        </td>
                        <td>{num(l.area_m2)} m²</td>
                        <td>{m3(l.inflow_m3)}</td>
                        <td>{m3(l.infiltration_m3)}</td>
                        <td>{m3(l.surface_outflow_m3)}</td>
                        <td>{m3(l.drain_outflow_m3 ?? 0)}</td>
                        <td>{num(l.final_storage_mm, 0)} mm</td>
                        <td>{l.inflow_m3 > 0 ? `${num((l.infiltration_m3 / l.inflow_m3) * 100)} %` : "–"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-head"><h3><Icon name="layers" size={16} />Drainage network</h3></div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                {proposed && (
                  <tr className="group">
                    <th /><th colSpan={2}>Peak inflow</th><th colSpan={2}>Flooding</th><th colSpan={2}>Time surcharged</th>
                  </tr>
                )}
                <tr>
                  <th>Node</th>
                  {proposed
                    ? [0, 1, 2].flatMap((k) => [<th key={`b${k}`}>Baseline</th>, <th key={`p${k}`}>Proposed</th>])
                    : <><th>Peak inflow</th><th>Flooding</th><th>Time surcharged</th></>}
                </tr>
              </thead>
              <tbody>
                {baseline.nodes.map((nb) => {
                  const np = proposed?.nodes.find((x) => x.node_id === nb.node_id);
                  const name = project.site.inlets.find((i) => i.id === nb.node_id)?.name
                    ?? (project.site.outfall.id === nb.node_id ? project.site.outfall.name : "");
                  return (
                    <tr key={nb.node_id}>
                      <td>{nb.node_id} <span className="muted">{name}</span></td>
                      <td>{m3s(nb.peak_inflow_m3s)}</td>{proposed && <td>{np ? m3s(np.peak_inflow_m3s) : "–"}</td>}
                      <td>{m3(nb.flooding_m3)}</td>{proposed && <td>{np ? m3(np.flooding_m3) : "–"}</td>}
                      <td>{num(nb.surcharge_hours, 1)} h</td>{proposed && <td>{np ? `${num(np.surcharge_hours, 1)} h` : "–"}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {[...baseline.warnings, ...(proposed?.warnings ?? [])].length > 0 && (
          <div className="issues">
            {[...new Set([...baseline.warnings, ...(proposed?.warnings ?? [])])].map((w) => (
              <div key={w} className="issue warning"><Icon name="warn" /><span>{w}</span></div>
            ))}
          </div>
        )}

        <div className="provenance">
          <span>EPA SWMM {baseline.engine.swmm_version} via PySWMM {baseline.engine.pyswmm_version}</span>
          <span>Continuity error {num(baseline.balance.continuity_error_pct, 2)} %{proposed && ` / ${num(proposed.balance.continuity_error_pct, 2)} %`}</span>
          <span className="mono" title="SHA-256 of the exact SWMM input files">
            inp {baseline.inp_sha256.slice(0, 10)}{proposed && ` / ${proposed.inp_sha256.slice(0, 10)}`}
          </span>
          <span>Run time {num(baseline.elapsed_s + (proposed?.elapsed_s ?? 0), 2)} s</span>
        </div>
      </div>
    </section>
  );
}

function Kpi({ icon, water = false, label, base, value, fmt, lowerIsBetter = false }: {
  icon: IconName; water?: boolean; label: string; base: number; value: number | undefined;
  fmt: (v: number) => string; lowerIsBetter?: boolean;
}) {
  const head = (
    <span className="label">
      <span className={`kpi-icon${water ? " water" : ""}`}><Icon name={icon} size={14} /></span>{label}
    </span>
  );
  if (value === undefined) {
    return (
      <div className="card kpi">
        {head}
        <span className="value">{fmt(base)}</span>
        <span className="base">Baseline</span>
      </div>
    );
  }
  const p = pctChange(value, base);
  const tol = Math.abs(value - base) < 1e-6 || (p !== null && Math.abs(p) < 0.5);
  const better = lowerIsBetter ? value < base : value > base;
  const cls = tol ? "flat" : better ? "good" : "bad";
  return (
    <div className="card kpi">
      {head}
      <span className="value">{fmt(value)}</span>
      <span className={`delta ${cls}`}>
        {tol ? "No change" : p === null ? `${value > base ? "+" : "−"}${fmt(Math.abs(value - base))}` : signedPct(p)}
        {!tol && <span className="sr-only">{better ? " (improvement)" : " (worse)"}</span>}
      </span>
      <span className="base">Baseline {fmt(base)}</span>
    </div>
  );
}

/** One plain-language sentence on what the design achieves in this storm. */
function Impact({ baseline, proposed, label }: { baseline: SimulationResult; proposed: SimulationResult; label: string }) {
  const kept = baseline.balance.runoff_m3 - proposed.balance.runoff_m3;
  const runoffPct = pctChange(proposed.balance.runoff_m3, baseline.balance.runoff_m3);
  const peakPct = pctChange(proposed.peak_outfall_m3s, baseline.peak_outfall_m3s);
  if (Math.abs(kept) < 0.5) {
    return (
      <div className="impact">
        <span className="impact-icon"><Icon name="leaf" size={20} /></span>
        <p>{label} doesn’t change how much water runs off in this storm.</p>
      </div>
    );
  }
  const better = kept > 0;
  return (
    <div className="impact">
      <span className="impact-icon"><Icon name="leaf" size={20} /></span>
      <p>
        With <strong>{label}</strong>, <strong>{m3(Math.abs(kept))} {better ? "less" : "more"} stormwater</strong> leaves
        the site in this storm
        {runoffPct !== null && <> ({signedPct(runoffPct)} runoff</>}
        {peakPct !== null && <>, {signedPct(peakPct)} peak flow</>}
        {runoffPct !== null && <>)</>}.
        {better && " That water soaks in or is held on site instead of flowing to the creek."}
      </p>
    </div>
  );
}

function RainIllustration() {
  return (
    <svg width="120" height="72" viewBox="0 0 120 72" aria-hidden="true">
      <path d="M38 30a11 11 0 01-1.4-21.9A15 15 0 0165 9a10 10 0 01-1 21z" fill="var(--surface-sunken)" stroke="var(--axis)" />
      {[42, 50, 58].map((x, i) => (
        <path key={x} d={`M${x} ${36 + (i % 2) * 4}l-2 6`} stroke="var(--water)" strokeWidth="2" strokeLinecap="round" />
      ))}
      <path d="M8 64c20-6 36-6 52 0s34 6 52 0" stroke="var(--kind-lawn)" strokeWidth="5" fill="none" strokeLinecap="round" />
      <path d="M80 62v-12M80 52c0-5 4-8 9-8 0 5-4 8-9 8zM80 55c0-4-3-6-7-6 0 4 3 6 7 6" stroke="var(--accent)" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <path d="M92 62v-8M92 56c0-3.5 2.5-5.5 6-5.5 0 3.5-2.5 5.5-6 5.5z" stroke="var(--accent)" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/** Builds the PDF on the backend from the project exactly as it was simulated. */
function ReportButton({ project, designId, exploreJobId }: { project: Project; designId: string; exploreJobId: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function download() {
    setBusy(true);
    setError(null);
    try {
      const blob = await api.report(project, designId, exploreJobId);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `runofflab-${project.id}-${designId}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="report-action">
      {error && <span className="small" style={{ color: "var(--bad-ink)" }}>{error}</span>}
      <button className="btn sm" onClick={() => void download()} disabled={busy}
              title="A PDF with the results, what-if cases, Design Explorer trade-offs and all assumptions">
        {busy ? <span className="spinner" /> : <Icon name="download" size={14} />} {busy ? "Building report…" : "PDF report"}
      </button>
    </span>
  );
}
