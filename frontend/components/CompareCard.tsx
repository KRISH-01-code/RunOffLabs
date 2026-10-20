"use client";

import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { m3, money, num, pctChange, signedPct } from "@/lib/format";
import type { Design, Project, SimulationResult } from "@/lib/types";
import { Icon } from "./ui";
import { TSS_TARGET_PCT } from "./WaterQualityCard";
import { ReductionBars } from "./WhatIfCard";

const tssOf = (r: SimulationResult) => r.pollutants?.find((p) => p.pollutant_id === "TSS")?.outfall_load_kg ?? 0;

interface Row {
  design: Design;
  cost: number;
  errors: number;
  result: SimulationResult | null; // null when the design fails a check
}

interface Comparison { key: string; baseline: SimulationResult; rows: Row[] }

/** Inputs that change the comparison; anything else (names, selection) doesn't matter. */
const keyOf = (p: Project) => JSON.stringify([p.site, p.scenario, p.costs, p.constraints, p.designs]);

/** Runs every design in the project through SWMM under the same storm and ranks them. */
export default function CompareCard({ project, onOpenDesign }: { project: Project; onOpenDesign: (id: string) => void }) {
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Share of a year's rain each design keeps on site, added on request (a few seconds per design).
  const [year, setYear] = useState<{ key: string; baseline: number; byDesign: Record<string, number> } | null>(null);
  const [yearLoading, setYearLoading] = useState(false);
  const cur = project.costs.currency;
  const yearKey = keyOf(project) + JSON.stringify(project.long_term);
  const noRecord = project.long_term.source === "imported" && !project.long_term.record;

  async function addYear() {
    if (!cmp) return;
    setYearLoading(true);
    setError(null);
    try {
      const runnable = cmp.rows.filter((r) => r.result);
      const [base, ...designs] = await Promise.all([
        api.longTerm(project, null),
        ...runnable.map((r) => api.longTermDesign(project, r.design)),
      ]);
      setYear({
        key: yearKey, baseline: base.baseline.kept_on_site_pct,
        byDesign: Object.fromEntries(runnable.map((r, i) => [r.design.id, designs[i].proposed.kept_on_site_pct])),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setYearLoading(false);
    }
  }

  async function run() {
    setLoading(true);
    setError(null);
    const key = keyOf(project);
    try {
      const checks = await Promise.all(project.designs.map((d) => api.validate(project, d)));
      const [baseline, ...results] = await Promise.all([
        api.simulate(project, null),
        ...project.designs.map((d, i) => (checks[i].feasible ? api.simulate(project, d) : Promise.resolve(null))),
      ]);
      setYear(null);
      setCmp({
        key, baseline: baseline!,
        rows: project.designs.map((design, i) => ({
          design, cost: checks[i].cost, result: results[i],
          errors: checks[i].issues.filter((x) => x.severity === "error").length,
        })),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const ranked = useMemo(() => {
    if (!cmp) return null;
    const base = cmp.baseline;
    const rows = cmp.rows.map((r) => {
      const kept = r.result ? base.balance.runoff_m3 - r.result.balance.runoff_m3 : 0;
      return {
        ...r, kept,
        pct: r.result ? -(pctChange(r.result.balance.runoff_m3, base.balance.runoff_m3) ?? 0) : 0,
        peak: r.result ? pctChange(r.result.peak_outfall_m3s, base.peak_outfall_m3s) : null,
        perM3: r.result && kept > 0.5 ? r.cost / kept : null,
        tss: r.result ? -(pctChange(tssOf(r.result), tssOf(base)) ?? 0) : null,
      };
    });
    const ok = rows.filter((r) => r.result);
    const bestValue = ok.filter((r) => r.perM3 !== null).sort((a, b) => a.perM3! - b.perM3!)[0];
    const mostKept = [...ok].sort((a, b) => b.kept - a.kept)[0];
    return {
      rows: [...ok].sort((a, b) => b.pct - a.pct).concat(rows.filter((r) => !r.result)),
      bestValue: bestValue?.design.id, mostKept: mostKept && mostKept.kept > 0.5 ? mostKept.design.id : undefined,
    };
  }, [cmp]);

  const stale = cmp !== null && cmp.key !== keyOf(project);
  const yearShown = year !== null && cmp !== null && !stale;
  const yearStale = year !== null && year.key !== yearKey;
  if (project.designs.length === 0) return null;

  return (
    <section className="card" aria-labelledby="h-compare">
      <div className="card-head">
        <h3 id="h-compare"><Icon name="layers" size={16} />Compare designs</h3>
        <span className="muted small">All {project.designs.length} design{project.designs.length === 1 ? "" : "s"} in this storm, ranked</span>
        <span className="spacer" style={{ flex: 1 }} />
        {stale && <span className="stale-note"><Icon name="warn" size={14} /> Designs changed since this comparison.</span>}
        {cmp && !stale && (!year || yearStale) && (
          <button className="btn sm" disabled={yearLoading || noRecord} onClick={() => void addYear()}
                  title={noRecord ? "Import a rainfall record under Storm & soil first"
                    : "Runs every design through a year of rainfall: a few seconds per design"}>
            {yearLoading ? <span className="spinner" /> : <Icon name="rain" size={12} />} {year ? "Update the year" : "Add a year of rainfall"}
          </button>
        )}
        <button className="btn sm" disabled={loading} onClick={() => void run()}>
          {loading ? <span className="spinner" /> : <Icon name="play" size={12} />} {cmp ? "Compare again" : "Compare all designs"}
        </button>
      </div>
      {error && <p className="small" style={{ color: "var(--bad-ink)", padding: "10px 14px" }}>{error}</p>}
      {!cmp && !error && (
        <p className="small muted" style={{ padding: "12px 14px" }}>
          Runs the baseline and every design through SWMM with the same storm and soil, then ranks them by how much
          runoff they keep on site and what each cubic metre costs. Designs that fail a check are listed but not run.
        </p>
      )}
      {cmp && ranked && (
        <div className={`whatif-body${stale ? " stale-dim" : ""}`}>
          {ranked.bestValue && (
            <p className="whatif-summary">
              {(() => {
                const best = ranked.rows.find((r) => r.design.id === ranked.bestValue)!;
                const most = ranked.rows.find((r) => r.design.id === ranked.mostKept);
                return <>
                  <strong>{best.design.name}</strong> is the best value at <strong>{money(best.perM3!, cur)} per m³</strong> of
                  runoff kept on site.
                  {most && most.design.id !== best.design.id && <> <strong>{most.design.name}</strong> keeps the most water ({m3(most.kept)}).</>}
                </>;
              })()}
            </p>
          )}
          <ReductionBars rows={ranked.rows.filter((r) => r.result).map((r) => ({ id: r.design.id, label: r.design.name, pct: r.pct }))}
                         label="Runoff reduction by design" />
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Design</th><th>Features</th><th>Cost</th><th>Runoff</th><th>Change</th><th>Peak flow</th>
                  <th>Soaked in</th><th>Flooding</th><th>Sediment removed</th>
                  {yearShown && <th title="Share of a year's rain kept out of the pipes">Kept on site, year</th>}
                  <th>Cost per m³ kept</th><th />
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Baseline <span className="muted">existing site</span></td><td>–</td><td>–</td>
                  <td>{m3(cmp.baseline.balance.runoff_m3)}</td><td>–</td><td>–</td>
                  <td>{m3(cmp.baseline.balance.infiltration_m3)}</td><td>{m3(cmp.baseline.flooding_volume_m3)}</td><td>–</td>
                  {yearShown && <td className={yearStale ? "stale-dim" : undefined}>{num(year!.baseline)} %</td>}
                  <td>–</td><td />
                </tr>
                {ranked.rows.map((r) => (
                  <tr key={r.design.id}>
                    <td>
                      {r.design.name}
                      {r.design.id === ranked.bestValue && <span className="badge good">Best value</span>}
                      {r.design.id === ranked.mostKept && <span className="badge">Most water kept</span>}
                    </td>
                    <td>{r.design.interventions.length}</td>
                    <td>{money(r.cost, cur)}</td>
                    {r.result ? <>
                      <td>{m3(r.result.balance.runoff_m3)}</td>
                      <td>{signedPct(-r.pct)}</td>
                      <td>{r.peak === null ? "–" : signedPct(r.peak)}</td>
                      <td>{m3(r.result.balance.infiltration_m3)}</td>
                      <td>{m3(r.result.flooding_volume_m3)}</td>
                      <td style={r.tss !== null && r.tss >= TSS_TARGET_PCT ? { color: "var(--good-ink)", fontWeight: 600 } : undefined}>
                        {r.tss === null ? "–" : `${num(r.tss)} %`}
                      </td>
                      {yearShown && (
                        <td className={yearStale ? "stale-dim" : undefined}>
                          {year!.byDesign[r.design.id] === undefined ? "–" : `${num(year!.byDesign[r.design.id])} %`}
                        </td>
                      )}
                      <td>{r.perM3 === null ? "–" : money(r.perM3, cur)}</td>
                    </> : (
                      <td colSpan={yearShown ? 8 : 7} style={{ color: "var(--bad-ink)" }}>
                        <Icon name="alert" size={12} /> Fails {r.errors} check{r.errors === 1 ? "" : "s"}, so it wasn’t run
                      </td>
                    )}
                    <td><button className="btn sm ghost" onClick={() => onOpenDesign(r.design.id)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            Cost per m³ kept is the design’s estimated cost divided by the runoff it keeps out of the pipes in this storm,
            {" "}{num(cmp.baseline.balance.rainfall_mm, 0)} mm of rain. It’s a ranking aid, not a lifetime cost.
            {yearShown && <> Kept on site, year: the share of {project.long_term.source === "synthetic"
              ? `a synthetic ${num(project.long_term.annual_mm)} mm year` : "the imported rainfall record"} that never
              runs into the drains{yearStale ? " (rainfall or designs changed since; update it)" : ""}.</>}
          </p>
        </div>
      )}
    </section>
  );
}
