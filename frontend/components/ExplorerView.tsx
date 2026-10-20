"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { isCapturing, LIDS } from "@/lib/lids";
import { api } from "@/lib/api";
import { m2, m3, m3s, money, num, pctChange, signedPct } from "@/lib/format";
import type { ExploreObjective, ExplorePoint, ExploreStatus, Intervention, Project } from "@/lib/types";
import TradeoffChart from "./charts/TradeoffChart";
import SitePreview from "./SitePreview";
import { Icon } from "./ui";

type Job = Omit<ExploreStatus, "points"> & { points: ExplorePoint[]; inputsKey: string };

const inputsKeyOf = (p: Project) =>
  JSON.stringify({ site: p.site, costs: p.costs, constraints: p.constraints, scenario: p.scenario });

export default function ExplorerView({ project, onAdopt, onJob }: {
  project: Project;
  onAdopt: (point: ExplorePoint) => void;
  onJob: (jobId: string) => void;
}) {
  const [objective, setObjective] = useState<ExploreObjective>("runoff_volume");
  const [evaluations, setEvaluations] = useState(200);
  const [rainGardens, setRainGardens] = useState(true);
  const [pavement, setPavement] = useState(true);
  const [greenRoofs, setGreenRoofs] = useState(true);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const userPicked = useRef(false);

  const running = job?.status === "running";
  const cur = project.costs.currency;
  const jobRef = useRef(job);
  jobRef.current = job;

  async function start() {
    setError(null);
    userPicked.current = false;
    setSelectedId(null);
    try {
      const { job_id } = await api.startExplore({
        project, objective, evaluations, rain_gardens: rainGardens, permeable_pavement: pavement, green_roofs: greenRoofs,
      });
      onJob(job_id);
      setJob({
        job_id, status: "running", objective, evaluated: 0, budget: evaluations, rejected: 0, slot_count: 0,
        elapsed_s: 0, baseline: null, points: [], front_ids: [], error: null, inputsKey: inputsKeyOf(project),
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Poll while the search runs, fetching only points we don't have yet.
  const jobId = job?.job_id;
  useEffect(() => {
    if (!jobId || !running) return;
    let alive = true;
    const tick = async () => {
      try {
        const have = jobRef.current?.points.length ?? 0;
        const st = await api.exploreStatus(jobId, have);
        if (!alive) return;
        setJob((j) => j && j.job_id === jobId
          ? { ...st, inputsKey: j.inputsKey, points: [...j.points, ...st.points.filter((p) => p.id >= j.points.length)] }
          : j);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    const t = setInterval(tick, 400);
    void tick();
    return () => { alive = false; clearInterval(t); };
  }, [jobId, running]);

  // Until the user picks a point, follow the best design found so far.
  const front = useMemo(() => {
    if (!job) return [];
    const ids = new Set(job.front_ids);
    return job.points.filter((p) => ids.has(p.id)).sort((a, b) => a.cost - b.cost);
  }, [job]);
  useEffect(() => {
    if (userPicked.current || front.length === 0) return;
    setSelectedId(front.at(-1)!.id);
  }, [front]);

  const selected = job?.points.find((p) => p.id === selectedId) ?? null;
  const stale = job !== null && job.inputsKey !== inputsKeyOf(project);
  const pct = job ? Math.min(job.evaluated / job.budget, 1) * 100 : 0;
  const objectiveLabel = (job?.objective ?? objective) === "runoff_volume" ? "runoff volume" : "peak flow";

  return (
    <div className="explorer">
      <div className="explorer-top">
        <section className="card explorer-settings" aria-labelledby="h-explore">
          <div className="card-head"><h3 id="h-explore"><Icon name="sprout" size={16} />Design Explorer</h3></div>
          <div className="card-body section" style={{ gap: 14 }}>
            <p className="small muted">
              Tries hundreds of layouts of rain gardens, permeable pavement and green roofs on this site, runs each through SWMM,
              and keeps the ones that give the most benefit for the money.
            </p>
            <div className="field">
              <span className="field-label">Minimise</span>
              <div className="segmented" role="group" aria-label="Objective">
                <button aria-pressed={objective === "runoff_volume"} onClick={() => setObjective("runoff_volume")} disabled={running}>Runoff volume</button>
                <button aria-pressed={objective === "peak_flow"} onClick={() => setObjective("peak_flow")} disabled={running}>Peak flow</button>
              </div>
            </div>
            <div className="field">
              <span className="field-label">Use</span>
              <label className="check"><input type="checkbox" checked={rainGardens} disabled={running} onChange={(e) => setRainGardens(e.target.checked)} />
                <span className="swatch" style={{ background: "var(--rg-fill)" }} /> Rain gardens</label>
              <label className="check"><input type="checkbox" checked={pavement} disabled={running} onChange={(e) => setPavement(e.target.checked)} />
                <span className="swatch" style={{ background: "var(--pp-fill)" }} /> Permeable pavement</label>
              <label className="check"><input type="checkbox" checked={greenRoofs} disabled={running} onChange={(e) => setGreenRoofs(e.target.checked)} />
                <span className="swatch" style={{ background: "var(--gr-fill)" }} /> Green roofs</label>
            </div>
            <div className="field">
              <span className="field-label">Designs to try</span>
              <div className="segmented" role="group" aria-label="Designs to try">
                {[100, 200, 400].map((n) => (
                  <button key={n} aria-pressed={evaluations === n} onClick={() => setEvaluations(n)} disabled={running}>{n}</button>
                ))}
              </div>
            </div>
            <p className="small muted">
              Every design stays within your budget of <strong>{money(project.constraints.budget, cur)}</strong>
              {project.constraints.max_intervention_area_m2 !== null && <> and {m2(project.constraints.max_intervention_area_m2)} of space</>},
              and passes the same checks as the editor. Change limits under <em>Costs &amp; limits</em>.
            </p>
            {running ? (
              <button className="btn" onClick={() => job && void api.cancelExplore(job.job_id)}>Stop</button>
            ) : (
              <button className="btn primary" disabled={!rainGardens && !pavement && !greenRoofs} onClick={() => void start()}>
                <Icon name="play" size={14} /> {job ? "Explore again" : "Explore designs"}
              </button>
            )}
            {job && (
              <div className="meter" aria-live="polite">
                <div className="meter-top">
                  <span>{job.status === "running" ? "Simulating…" : job.status === "done" ? "Done" : job.status === "cancelled" ? "Stopped" : "Failed"}</span>
                  <span className="num">{num(job.evaluated)} / {num(job.budget)} designs · {num(job.elapsed_s, 1)} s</span>
                </div>
                <div className="meter-track"><div className="meter-fill" style={{ width: `${pct}%` }} /></div>
                <span className="small muted">
                  {job.slot_count} candidate spots · {num(job.rejected)} layouts skipped by constraint checks
                </span>
              </div>
            )}
            {(error || job?.error) && <p className="small" style={{ color: "var(--bad-ink)" }}>{error ?? job?.error}</p>}
          </div>
        </section>

        <section className="card chart-card explorer-chart" aria-labelledby="h-tradeoff">
          <div className="chart-title">
            <div>
              <h3 id="h-tradeoff">Cost vs {objectiveLabel}</h3>
              <span className="chart-sub">
                {job ? <>Each dot is one design simulated in SWMM. Lower and further left is better.</>
                  : <>Run the explorer to map out what each dollar can achieve.</>}
              </span>
            </div>
            <div className="legend">
              <span><span className="dot" style={{ background: "var(--series-proposed)" }} />Best trade-offs</span>
              <span><span className="dot" style={{ background: "var(--ink-muted)", opacity: 0.5 }} />Other designs</span>
              <span><span className="dot" style={{ background: "var(--series-baseline)" }} />Today</span>
            </div>
          </div>
          {stale && (
            <span className="stale-note"><Icon name="warn" size={14} /> The site, storm or limits changed since this run. Explore again to update.</span>
          )}
          {job ? (
            <div className={stale ? "stale-dim" : undefined}>
              <TradeoffChart points={job.points} frontIds={job.front_ids} baseline={job.baseline}
                             objective={job.objective} budget={project.constraints.budget} currency={cur}
                             selectedId={selectedId}
                             onSelect={(id) => { userPicked.current = true; setSelectedId(id); }} />
            </div>
          ) : (
            <div className="empty-state" style={{ minHeight: 300, alignContent: "center" }}>
              <Icon name="sprout" size={28} />
              <p>No designs explored yet.</p>
            </div>
          )}
        </section>
      </div>

      {job && selected && job.baseline && (
        <section className="card explorer-detail" aria-labelledby="h-selected">
          <div className="card-head">
            <h3 id="h-selected"><Icon name="leaf" size={16} />
              {job.front_ids.includes(selected.id) ? "Best trade-off" : "Design"} at {money(selected.cost, cur)}
            </h3>
            <span className="spacer" style={{ flex: 1 }} />
            <button className="btn sm primary" onClick={() => onAdopt(selected)}>
              <Icon name="plus" size={14} /> Add to my designs
            </button>
          </div>
          <div className="explorer-detail-body">
            <SitePreview site={project.site} design={selected.design}
                         label={`Site plan showing this design's ${selected.design.interventions.length} interventions`} />
            <div className="section">
              <dl className="kv explorer-kv">
                <Delta label="Runoff volume" value={selected.runoff_m3} base={job.baseline.runoff_m3} fmt={m3} lowerIsBetter />
                <Delta label="Peak outfall discharge" value={selected.peak_m3s} base={job.baseline.peak_m3s} fmt={m3s} lowerIsBetter />
                <Delta label="Soaked into the ground" value={selected.infiltration_m3} base={job.baseline.infiltration_m3} fmt={m3} />
                <dt>Footprint</dt><dd>{m2(selected.area_m2)}</dd>
              </dl>
              <div className="item-list">
                {selected.design.interventions.map((i) => (
                  <div key={i.id} className="item-row" style={{ cursor: "default" }}>
                    <span className="swatch" style={{ background: LIDS[i.kind].fill }} />
                    <span>{LIDS[i.kind].label}</span>
                    <span className="meta num">
                      {num(i.rect.width)} × {num(i.rect.height)} m
                      {isCapturing(i) ? ` · captures ${m2(i.captured_area_m2)}`
                        : i.kind === "permeable_pavement" && i.runon_area_m2 > 0 ? ` · run-on ${m2(i.runon_area_m2)}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {job && front.length > 0 && job.baseline && (
        <section className="card" aria-labelledby="h-front">
          <div className="card-head">
            <h3 id="h-front"><Icon name="layers" size={16} />Best trade-offs ({front.length})</h3>
            <span className="muted small">No other design tried is both cheaper and better on {objectiveLabel}.</span>
          </div>
          <div className="table-wrap" style={{ maxHeight: 340, overflowY: "auto" }}>
            <table className="data">
              <thead>
                <tr><th>Cost</th><th>Runoff</th><th>Change</th><th>Peak flow</th><th>Change</th><th>Soaked in</th><th>Rain gardens</th><th>Pavers</th><th>Green roofs</th></tr>
              </thead>
              <tbody>
                {front.map((p) => {
                  const rg = p.design.interventions.filter((i) => i.kind === "rain_garden");
                  const pp = p.design.interventions.filter((i) => i.kind === "permeable_pavement");
                  const gr = p.design.interventions.filter((i) => i.kind === "green_roof");
                  const sum = (xs: Intervention[]) => xs.reduce((a, i) => a + i.rect.width * i.rect.height, 0);
                  return (
                    <tr key={p.id} className={`clickable${p.id === selectedId ? " selected" : ""}`}
                        onClick={() => { userPicked.current = true; setSelectedId(p.id); }}>
                      <td>{money(p.cost, cur)}</td>
                      <td>{m3(p.runoff_m3)}</td>
                      <td>{signedPct(pctChange(p.runoff_m3, job.baseline!.runoff_m3) ?? 0)}</td>
                      <td>{m3s(p.peak_m3s)}</td>
                      <td>{signedPct(pctChange(p.peak_m3s, job.baseline!.peak_m3s) ?? 0)}</td>
                      <td>{m3(p.infiltration_m3)}</td>
                      <td>{rg.length ? `${rg.length} · ${m2(sum(rg))}` : "–"}</td>
                      <td>{pp.length ? `${pp.length} · ${m2(sum(pp))}` : "–"}</td>
                      <td>{gr.length ? `${gr.length} · ${m2(sum(gr))}` : "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function Delta({ label, value, base, fmt, lowerIsBetter = false }: {
  label: string; value: number; base: number; fmt: (v: number) => string; lowerIsBetter?: boolean;
}) {
  const p = pctChange(value, base);
  const better = lowerIsBetter ? value < base : value > base;
  const flat = p === null || Math.abs(p) < 0.5;
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {fmt(value)}{" "}
        <span className={`delta ${flat ? "flat" : better ? "good" : "bad"}`}>{flat ? "±0 %" : signedPct(p!)}</span>
      </dd>
    </>
  );
}
