"use client";

import { num, pctChange } from "@/lib/format";
import type { SimulationResult } from "@/lib/types";
import { Icon } from "./ui";

/** Many stormwater permits ask for about this share of sediment (TSS) to be removed (backend: quality.TSS_TARGET_PCT). */
export const TSS_TARGET_PCT = 80;

const SHORT: Record<string, string> = { TSS: "Sediment (TSS)", TP: "Phosphorus (TP)" };
const kg = (v: number) => (v < 10 ? `${num(v, 2)} kg` : `${num(v, 1)} kg`);

/** Pollutant loads leaving the site, baseline vs design, and progress towards the TSS target. */
export default function WaterQualityCard({ baseline, proposed, label }: {
  baseline: SimulationResult; proposed: SimulationResult | null; label: string;
}) {
  if (!baseline.pollutants?.length) return null;
  const rows = baseline.pollutants.map((b) => {
    const p = proposed?.pollutants.find((x) => x.pollutant_id === b.pollutant_id);
    const removed = p ? -(pctChange(p.outfall_load_kg, b.outfall_load_kg) ?? 0) : null;
    return { id: b.pollutant_id, label: b.label, base: b.outfall_load_kg, value: p?.outfall_load_kg ?? null, removed };
  });
  const tss = rows.find((r) => r.id === "TSS");
  const met = tss?.removed != null && tss.removed >= TSS_TARGET_PCT;

  return (
    <section className="card" aria-labelledby="h-quality">
      <div className="card-head">
        <h3 id="h-quality"><Icon name="drop" size={16} />Water quality</h3>
        <span className="muted small">Pollutants carried to the creek over the whole storm</span>
      </div>
      <div className="whatif-body">
        {tss && tss.removed !== null ? (
          <>
            <p className="whatif-summary">
              {label} removes <strong>{num(tss.removed)} % of the sediment</strong> (TSS) that would otherwise leave the site
              {met
                ? <> — <span style={{ color: "var(--good-ink)" }}>meeting</span> the {TSS_TARGET_PCT} % removal many stormwater permits require.</>
                : <>, short of the {TSS_TARGET_PCT} % removal many stormwater permits require.</>}
            </p>
            <div className="quality-meter" role="meter" aria-label="Sediment removed" aria-valuemin={0} aria-valuemax={100}
                 aria-valuenow={Math.round(Math.max(tss.removed, 0))}>
              <div className="quality-fill" style={{ width: `${Math.min(Math.max(tss.removed, 0), 100)}%` }} />
              <div className="quality-target" style={{ left: `${TSS_TARGET_PCT}%` }} aria-hidden="true">
                <span>{TSS_TARGET_PCT} % target</span>
              </div>
            </div>
          </>
        ) : (
          <p className="whatif-summary">The baseline sends <strong>{tss ? kg(tss.base) : "–"} of sediment</strong> to the creek in this storm. Add green infrastructure and run a comparison to see how much it removes.</p>
        )}
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Pollutant</th><th>Baseline</th>{proposed && <><th>{label}</th><th>Removed</th></>}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td title={r.label}>{SHORT[r.id] ?? r.label}</td>
                  <td>{kg(r.base)}</td>
                  {proposed && <><td>{r.value === null ? "–" : kg(r.value)}</td><td>{r.removed === null ? "–" : `${num(r.removed)} %`}</td></>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          Each surface’s runoff carries typical urban concentrations (event mean concentrations); water that green
          infrastructure soaks in or holds keeps its pollutants on site, and underdrain flow is partly treated.
          Concentrations are illustrative defaults; see the methodology.
        </p>
      </div>
    </section>
  );
}
