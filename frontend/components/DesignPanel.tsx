"use client";

import { Fragment, useEffect, useState } from "react";
import { area, contributingCandidates, hostSurface, remainingImpervious } from "@/lib/geometry";
import { m2, money, num } from "@/lib/format";
import type { Action } from "@/lib/store";
import { interventionCost, isCapturing, LID_ORDER, LIDS } from "@/lib/lids";
import type { Design, Intervention, Issue, Project, ValidateResponse } from "@/lib/types";
import { Icon, Meter, NumberField } from "./ui";
import { KIND_LABEL } from "./SiteEditor";

export default function DesignPanel({ project, design, selectedId, validation, validating, dispatch, onSiteIssue }: {
  project: Project;
  design: Design | null;
  selectedId: string | null;
  validation: ValidateResponse | null;
  validating: boolean;
  dispatch: (a: Action) => void;
  onSiteIssue: (id: string) => void;
}) {
  const selected = design?.interventions.find((i) => i.id === selectedId) ?? null;
  const issues = validation?.issues ?? [];
  const errorIds = new Set(issues.filter((i) => i.severity === "error").map((i) => i.target_id));

  return (
    <>
      <DesignList project={project} design={design} dispatch={dispatch} />

      {design && (
        <section className="section" aria-labelledby="h-summary">
          <h3 id="h-summary">Budget &amp; space</h3>
          <Meter label="Estimated cost" value={validation?.cost ?? 0} max={project.constraints.budget}
                 format={(v) => money(v, project.costs.currency)} />
          <Meter label="Intervention area"
                 value={Object.values(validation?.area_by_kind ?? {}).reduce((a, b) => a + (b ?? 0), 0)}
                 max={project.constraints.max_intervention_area_m2} format={m2} />
          <dl className="kv">
            {LID_ORDER.filter((k) => (validation?.area_by_kind?.[k] ?? 0) > 0 || k === "rain_garden" || k === "permeable_pavement").map((k) => (
              <Fragment key={k}><dt>{LIDS[k].label}</dt><dd>{m2(validation?.area_by_kind?.[k] ?? 0)}</dd></Fragment>
            ))}
          </dl>
        </section>
      )}

      <section className="section" aria-labelledby="h-checks">
        <div className="section-head">
          <h3 id="h-checks">Checks</h3>
          {validating && <span className="spinner muted" aria-label="Checking" />}
        </div>
        <IssueList issues={issues} validation={validation} onSelect={(id) => {
          if (design?.interventions.some((i) => i.id === id)) dispatch({ type: "select", id });
          else onSiteIssue(id);
        }} />
      </section>

      {design && selected && (
        <Inspector key={selected.id} project={project} design={design} item={selected} dispatch={dispatch} />
      )}

      {design && !selected && (
        <section className="section" aria-labelledby="h-items">
          <h3 id="h-items">Interventions</h3>
          {design.interventions.length === 0 ? (
            <p className="muted small">None yet. Pick a type above the plan (rain garden, pavers, green roof, trench or barrel) and drag on the site to add one.</p>
          ) : (
            <div className="item-list">
              {design.interventions.map((i) => (
                <button key={i.id} className={`item-row${errorIds.has(i.id) ? " has-error" : ""}`}
                        onClick={() => dispatch({ type: "select", id: i.id })}>
                  <span className="swatch" style={{ background: LIDS[i.kind].fill }} />
                  <span className="id">{i.id}</span>
                  <span className="muted small">{LIDS[i.kind].label}</span>
                  <span className="meta num">{m2(area(i.rect))}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}

function DesignList({ project, design, dispatch }: {
  project: Project; design: Design | null; dispatch: (a: Action) => void;
}) {
  const [name, setName] = useState(design?.name ?? "");
  useEffect(() => setName(design?.name ?? ""), [design?.id, design?.name]);

  return (
    <section className="section" aria-labelledby="h-designs">
      <div className="section-head">
        <h3 id="h-designs">Designs</h3>
        <div style={{ display: "flex", gap: 4 }}>
          <button className="btn sm ghost" onClick={() => dispatch({ type: "addDesign" })}><Icon name="plus" size={14} /> New</button>
          {design && (
            <button className="btn sm ghost" onClick={() => dispatch({ type: "addDesign", copyFrom: design.id })} title="Duplicate this design">
              <Icon name="copy" size={14} /> Duplicate
            </button>
          )}
        </div>
      </div>
      <div className="design-list">
        <button className="design-row" aria-current={design === null} onClick={() => dispatch({ type: "selectDesign", id: null })}>
          <span>Baseline</span><span className="count">existing site</span>
        </button>
        {project.designs.map((d) => (
          <button key={d.id} className="design-row" aria-current={design?.id === d.id}
                  onClick={() => dispatch({ type: "selectDesign", id: d.id })}>
            <span>{d.name}</span>
            <span className="count">{d.interventions.length} item{d.interventions.length === 1 ? "" : "s"}</span>
          </button>
        ))}
      </div>
      {design && (
        <div style={{ display: "flex", gap: 6, alignItems: "end" }}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="design-name">Design name</label>
            <input id="design-name" className="input" value={name} maxLength={80}
                   onChange={(e) => setName(e.target.value)}
                   onBlur={() => name.trim() && name !== design.name
                     ? dispatch({ type: "renameDesign", id: design.id, name: name.trim() }) : setName(design.name)}
                   onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          </div>
          <button className="btn icon danger" title="Delete design" aria-label="Delete design"
                  onClick={() => { if (confirm(`Delete “${design.name}”?`)) dispatch({ type: "deleteDesign", id: design.id }); }}>
            <Icon name="trash" />
          </button>
        </div>
      )}
    </section>
  );
}

export function IssueList({ issues, validation, onSelect }: {
  issues: Issue[]; validation: ValidateResponse | null; onSelect: (id: string) => void;
}) {
  if (!validation) return <p className="muted small">Waiting for the backend…</p>;
  if (issues.length === 0) {
    return <div className="ok-line"><Icon name="check" /> All constraints pass. Ready to simulate.</div>;
  }
  const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return (
    <div className="issues">
      {sorted.map((i, n) => (
        <button key={n} className={`issue ${i.severity}${i.target_id ? " clickable" : ""}`}
                onClick={() => i.target_id && onSelect(i.target_id)}>
          <Icon name={i.severity === "error" ? "alert" : "warn"} />
          <span><span className="sr-only">{i.severity}: </span>{i.message}</span>
        </button>
      ))}
    </div>
  );
}

function Inspector({ project, design, item, dispatch }: {
  project: Project; design: Design; item: Intervention; dispatch: (a: Action) => void;
}) {
  const { site, constraints, costs } = project;
  const host = hostSurface(site, item.rect);
  const meta = LIDS[item.kind];
  const update = (patch: Partial<Intervention>) => dispatch({ type: "updateIntervention", id: item.id, patch });
  const setRect = (k: keyof Intervention["rect"]) => (v: number | null) =>
    v !== null && update({ rect: { ...item.rect, [k]: v } });
  const itemArea = area(item.rect);
  const field = (label: string, key: string, unit: string, min: number, max: number, hint?: React.ReactNode, step = 1) => (
    <NumberField label={label} unit={unit} value={(item as unknown as Record<string, number>)[key]} min={min} max={max} step={step}
                 hint={hint} onChange={(v) => v !== null && update({ [key]: v } as Partial<Intervention>)} />
  );

  return (
    <section className="section" aria-labelledby="h-inspector">
      <div className="section-head">
        <h3 id="h-inspector" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="swatch" style={{ background: meta.fill }} />
          {item.id} · {meta.label}
        </h3>
        <div style={{ display: "flex", gap: 4 }}>
          <button className="btn sm ghost" onClick={() => dispatch({ type: "select", id: null })}>Done</button>
          <button className="btn sm ghost danger" onClick={() => dispatch({ type: "deleteIntervention", id: item.id })}>
            <Icon name="trash" size={14} /> Delete
          </button>
        </div>
      </div>
      <p className="muted small">{meta.blurb}</p>

      <dl className="kv">
        <dt>Location</dt><dd>{host ? `${host.name} (${KIND_LABEL[host.kind]})` : "Not inside a single surface"}</dd>
        <dt>Area</dt><dd>{m2(itemArea)}</dd>
        <dt>Cost</dt><dd>{money(interventionCost(item, costs), costs.currency)}</dd>
      </dl>

      <div className="grid-4">
        <NumberField label="x" unit="m" value={item.rect.x} min={0} max={site.width_m - item.rect.width} onChange={setRect("x")} />
        <NumberField label="y" unit="m" value={item.rect.y} min={0} max={site.height_m - item.rect.height} onChange={setRect("y")} />
        <NumberField label="Width" unit="m" value={item.rect.width} min={1} max={site.width_m - item.rect.x} onChange={setRect("width")} />
        <NumberField label="Height" unit="m" value={item.rect.height} min={1} max={site.height_m - item.rect.y} onChange={setRect("height")} />
      </div>

      {isCapturing(item) && (() => {
        const roofOnly = meta.captures === "roof";
        const candidates = contributingCandidates(site, host, constraints, roofOnly);
        const current = site.surfaces.find((s) => s.id === item.contributing_surface_id);
        const options = current && !candidates.includes(current) ? [current, ...candidates] : candidates;
        const left = item.contributing_surface_id
          ? remainingImpervious(site, design, item.contributing_surface_id, item.id) : 0;
        let hint: React.ReactNode;
        if (item.kind === "rain_barrel") {
          const volume = itemArea * item.height_mm / 1000;
          const fillsAt = item.captured_area_m2 > 0 ? (volume / item.captured_area_m2) * 1000 : null;
          hint = <>Tank holds {num(volume, 1)} m³{fillsAt !== null && <>, full after {num(fillsAt, 1)} mm of rain on that roof</>} · {m2(left)} available</>;
        } else {
          const ratio = item.captured_area_m2 / itemArea;
          hint = <>Loading ratio {num(ratio, 1)}× (max {num(constraints.max_rain_garden_loading_ratio)}× = {m2(constraints.max_rain_garden_loading_ratio * itemArea)}) · {m2(left)} available</>;
        }
        return (
          <>
            <div className="field">
              <label htmlFor="rg-src">{roofOnly ? "Collects from the roof" : "Captures runoff from"}</label>
              <select id="rg-src" className="select" value={item.contributing_surface_id}
                      onChange={(e) => update({ contributing_surface_id: e.target.value } as Partial<Intervention>)}>
                {!current && <option value="">Choose a surface…</option>}
                {options.map((s) => <option key={s.id} value={s.id}>{s.name} ({KIND_LABEL[s.kind]})</option>)}
              </select>
              {candidates.length === 0 && (
                <span className="hint">No {roofOnly ? "roof" : "paved surface"} is within {num(constraints.max_contributing_gap_m)} m of this location.</span>
              )}
            </div>
            {field(roofOnly ? "Roof area piped to it" : "Captured impervious area", "captured_area_m2", "m²", 0, 1e6, hint)}
          </>
        );
      })()}

      {item.kind === "rain_garden" && (
        <div className="grid-2" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          {field("Ponding", "ponding_depth_mm", "mm", 50, 450)}
          {field("Soil", "soil_depth_mm", "mm", 300, 1200)}
          {field("Gravel", "gravel_depth_mm", "mm", 0, 900)}
        </div>
      )}
      {item.kind === "infiltration_trench" && field("Stone depth", "storage_depth_mm", "mm", 300, 3000,
        <>Holds about {num(itemArea * item.storage_depth_mm / 1000 * 0.43, 1)} m³ in the stone’s voids</>)}
      {item.kind === "rain_barrel" && (
        <div className="grid-2">
          {field("Tank height", "height_mm", "mm", 300, 4000)}
          {field("Starts emptying after", "drain_delay_hours", "h", 0, 72, "Hours after the rain stops; it then drains over about a day")}
        </div>
      )}
      {item.kind === "green_roof" && (
        <div className="grid-2">
          {field("Growing medium", "soil_depth_mm", "mm", 50, 300, "Extensive roofs: 50–150 mm")}
          {field("Drainage mat", "drain_mat_mm", "mm", 10, 75)}
        </div>
      )}
      {item.kind === "permeable_pavement" && (() => {
        const left = host ? remainingImpervious(site, design, host.id, item.id) - itemArea : 0;
        return (
          <>
            {field("Run-on from surrounding pavement", "runon_area_m2", "m²", 0, 1e6,
              <>Ratio {num(item.runon_area_m2 / itemArea, 1)}× (max {num(constraints.max_pavement_runon_ratio)}×){host && <> · {m2(Math.max(left, 0))} of {host.name} available</>}</>)}
            <div className="grid-2">
              {field("Pavement thickness", "pavement_thickness_mm", "mm", 50, 300)}
              {field("Stone storage", "storage_depth_mm", "mm", 100, 900)}
            </div>
          </>
        );
      })()}
    </section>
  );
}
