"use client";

import { useEffect, useState } from "react";
import { area } from "@/lib/geometry";
import { m2, num } from "@/lib/format";
import {
  DRAIN_DEPTH_M, MIN_FALL, pipeLength, pipeSlope, type SiteElement,
} from "@/lib/siteBuilder";
import type { Action } from "@/lib/store";
import type { Inlet, Pipe, Project, Surface, SurfaceKind, ValidateResponse } from "@/lib/types";
import { IssueList } from "./DesignPanel";
import { KIND_LABEL } from "./SiteEditor";
import { Icon, NumberField } from "./ui";

/** Sidebar for the Site layout layer: site size, checks, and the selected surface, drain, pipe or outfall. */
export default function SitePanel({ project, sel, validation, validating, dispatch, onSelect }: {
  project: Project;
  sel: SiteElement | null;
  validation: ValidateResponse | null;
  validating: boolean;
  dispatch: (a: Action) => void;
  onSelect: (el: SiteElement | null) => void;
}) {
  const { site } = project;
  const issues = validation?.issues ?? [];
  const errorIds = new Set(issues.filter((i) => i.severity === "error").map((i) => i.target_id));
  const surface = sel?.kind === "surface" ? site.surfaces.find((s) => s.id === sel.id) : undefined;
  const inlet = sel?.kind === "inlet" ? site.inlets.find((i) => i.id === sel.id) : undefined;
  const pipe = sel?.kind === "pipe" ? site.pipes.find((p) => p.id === sel.id) : undefined;
  const outfall = sel?.kind === "outfall";
  const select = (id: string) => {
    if (site.surfaces.some((s) => s.id === id)) onSelect({ kind: "surface", id });
    else if (site.inlets.some((i) => i.id === id)) onSelect({ kind: "inlet", id });
    else if (site.pipes.some((p) => p.id === id)) onSelect({ kind: "pipe", id });
    else if (site.outfall.id === id) onSelect({ kind: "outfall", id });
  };
  const done = <button className="btn sm ghost" onClick={() => onSelect(null)}>Done</button>;

  return (
    <>
      <section className="section" aria-labelledby="h-site">
        <h3 id="h-site">Site</h3>
        <TextField label="Site name" value={site.name} maxLength={120}
                   onCommit={(name) => dispatch({ type: "setSite", patch: { name } })} />
        <div className="grid-2">
          <NumberField label="Width (east–west)" unit="m" value={site.width_m} min={10} max={5000}
                       onChange={(v) => v !== null && dispatch({ type: "setSite", patch: { width_m: v } })} />
          <NumberField label="Depth (north–south)" unit="m" value={site.height_m} min={10} max={5000}
                       onChange={(v) => v !== null && dispatch({ type: "setSite", patch: { height_m: v } })} />
        </div>
        <p className="muted small">Soil type is under <strong>Storm &amp; soil</strong>. Every edit here can be undone with ⌘Z.</p>
      </section>

      <section className="section" aria-labelledby="h-site-checks">
        <div className="section-head">
          <h3 id="h-site-checks">Checks</h3>
          {validating && <span className="spinner muted" aria-label="Checking" />}
        </div>
        <IssueList issues={issues} validation={validation} onSelect={select} />
      </section>

      {surface && <SurfaceInspector key={surface.id} project={project} surface={surface} dispatch={dispatch} done={done}
                                    onDelete={() => { dispatch({ type: "deleteSurface", id: surface.id }); onSelect(null); }} />}
      {inlet && <InletInspector key={inlet.id} project={project} inlet={inlet} dispatch={dispatch} done={done} onSelect={onSelect}
                                onDelete={() => { dispatch({ type: "deleteInlet", id: inlet.id }); onSelect(null); }} />}
      {pipe && <PipeInspector key={pipe.id} project={project} pipe={pipe} dispatch={dispatch} done={done}
                              onDelete={() => { dispatch({ type: "deletePipe", id: pipe.id }); onSelect(null); }} />}
      {outfall && <OutfallInspector project={project} dispatch={dispatch} done={done} />}

      {!sel && (
        <>
          <section className="section" aria-labelledby="h-surfaces">
            <h3 id="h-surfaces">Surfaces</h3>
            <div className="item-list">
              {site.surfaces.map((s) => (
                <button key={s.id} className={`item-row${errorIds.has(s.id) ? " has-error" : ""}`}
                        onClick={() => onSelect({ kind: "surface", id: s.id })}>
                  <span className="swatch" style={{ background: `var(--kind-${s.kind})` }} />
                  <span className="id">{s.name}</span>
                  <span className="muted small">→ {s.drains_to}</span>
                  <span className="meta num">{m2(area(s.rect))}</span>
                </button>
              ))}
            </div>
          </section>
          <section className="section" aria-labelledby="h-network">
            <h3 id="h-network">Drains &amp; pipes</h3>
            <div className="item-list">
              {site.inlets.map((i) => (
                <button key={i.id} className={`item-row${errorIds.has(i.id) ? " has-error" : ""}`}
                        onClick={() => onSelect({ kind: "inlet", id: i.id })}>
                  <span className="swatch" style={{ background: "var(--node)", borderRadius: 2 }} />
                  <span className="id">{i.id}</span>
                  <span className="muted small">{i.name}</span>
                  <span className="meta num">{num(i.rim_elev_m - i.invert_elev_m, 1)} m deep</span>
                </button>
              ))}
              {site.pipes.map((p) => (
                <button key={p.id} className={`item-row${errorIds.has(p.id) ? " has-error" : ""}`}
                        onClick={() => onSelect({ kind: "pipe", id: p.id })}>
                  <span className="swatch" style={{ background: "var(--pipe)", height: 4, alignSelf: "center" }} />
                  <span className="id">{p.id}</span>
                  <span className="muted small">{p.from_node} → {p.to_node}</span>
                  <span className="meta num">{num(p.diameter_m * 1000)} mm</span>
                </button>
              ))}
              <button className="item-row" onClick={() => onSelect({ kind: "outfall", id: site.outfall.id })}>
                <span className="swatch" style={{ background: "var(--node)", borderRadius: 99 }} />
                <span className="id">{site.outfall.id}</span>
                <span className="muted small">{site.outfall.name}</span>
              </button>
            </div>
            <p className="muted small">
              Draw with <strong>Surface</strong>, <strong>Drain</strong> and <strong>Pipe</strong> above the plan.
              Each surface drains to one drain; pipes carry water from drain to drain and on to the outfall.
            </p>
          </section>
        </>
      )}
    </>
  );
}

function Head({ swatch, title, done, onDelete }: {
  swatch: React.CSSProperties; title: string; done: React.ReactNode; onDelete?: () => void;
}) {
  return (
    <div className="section-head">
      <h3 id="h-site-inspector" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="swatch" style={swatch} />{title}
      </h3>
      <div style={{ display: "flex", gap: 4 }}>
        {done}
        {onDelete && (
          <button className="btn sm ghost danger" onClick={onDelete}><Icon name="trash" size={14} /> Delete</button>
        )}
      </div>
    </div>
  );
}

function SurfaceInspector({ project, surface, dispatch, done, onDelete }: {
  project: Project; surface: Surface; dispatch: (a: Action) => void; done: React.ReactNode; onDelete: () => void;
}) {
  const { site } = project;
  const update = (patch: Partial<Surface>) => dispatch({ type: "updateSurface", id: surface.id, patch });
  const setRect = (k: keyof Surface["rect"]) => (v: number | null) => v !== null && update({ rect: { ...surface.rect, [k]: v } });
  const hosted = project.designs.reduce((n, d) => n + d.interventions.filter((i) =>
    i.rect.x >= surface.rect.x && i.rect.y >= surface.rect.y
    && i.rect.x + i.rect.width <= surface.rect.x + surface.rect.width
    && i.rect.y + i.rect.height <= surface.rect.y + surface.rect.height).length, 0);
  return (
    <section className="section" aria-labelledby="h-site-inspector">
      <Head swatch={{ background: `var(--kind-${surface.kind})` }} title={`${surface.id} · ${KIND_LABEL[surface.kind]}`}
            done={done} onDelete={site.surfaces.length > 1 ? onDelete : undefined} />
      <TextField label="Name" value={surface.name} maxLength={80} onCommit={(name) => update({ name })} />
      <div className="grid-2">
        <div className="field">
          <label htmlFor="sf-kind">Type</label>
          <select id="sf-kind" className="select" value={surface.kind} onChange={(e) => update({ kind: e.target.value as SurfaceKind })}>
            {(Object.keys(KIND_LABEL) as SurfaceKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sf-drain">Drains to</label>
          <select id="sf-drain" className="select" value={surface.drains_to} onChange={(e) => update({ drains_to: e.target.value })}>
            {!site.inlets.some((i) => i.id === surface.drains_to) && <option value={surface.drains_to}>Choose a drain…</option>}
            {site.inlets.map((i) => <option key={i.id} value={i.id}>{i.id} · {i.name}</option>)}
          </select>
        </div>
      </div>
      <NumberField label="Slope" unit="%" value={surface.slope_pct} min={0.1} max={30} step={0.5}
                   onChange={(v) => v !== null && update({ slope_pct: v })} />
      <div className="grid-4">
        <NumberField label="x" unit="m" value={surface.rect.x} min={0} max={site.width_m - surface.rect.width} onChange={setRect("x")} />
        <NumberField label="y" unit="m" value={surface.rect.y} min={0} max={site.height_m - surface.rect.height} onChange={setRect("y")} />
        <NumberField label="Width" unit="m" value={surface.rect.width} min={1} max={site.width_m - surface.rect.x} onChange={setRect("width")} />
        <NumberField label="Height" unit="m" value={surface.rect.height} min={1} max={site.height_m - surface.rect.y} onChange={setRect("height")} />
      </div>
      <dl className="kv">
        <dt>Area</dt><dd>{m2(area(surface.rect))}</dd>
        {hosted > 0 && <><dt>Green infrastructure</dt><dd>{hosted} feature{hosted === 1 ? "" : "s"} in your designs sit here</dd></>}
      </dl>
    </section>
  );
}

function InletInspector({ project, inlet, dispatch, done, onDelete, onSelect }: {
  project: Project; inlet: Inlet; dispatch: (a: Action) => void; done: React.ReactNode; onDelete: () => void;
  onSelect: (el: SiteElement | null) => void;
}) {
  const { site } = project;
  const update = (patch: Partial<Inlet>) => dispatch({ type: "updateInlet", id: inlet.id, patch });
  const depth = inlet.rim_elev_m - inlet.invert_elev_m;
  const pipes = site.pipes.filter((p) => p.from_node === inlet.id || p.to_node === inlet.id);
  const draining = site.surfaces.filter((s) => s.drains_to === inlet.id);
  return (
    <section className="section" aria-labelledby="h-site-inspector">
      <Head swatch={{ background: "var(--node)", borderRadius: 2 }} title={`${inlet.id} · Drain`} done={done}
            onDelete={site.inlets.length > 1 ? () => {
              if (!pipes.length || confirm(`Delete ${inlet.id} and its ${pipes.length} pipe${pipes.length === 1 ? "" : "s"}?`)) onDelete();
            } : undefined} />
      <TextField label="Name" value={inlet.name} maxLength={80} onCommit={(name) => update({ name })} />
      <div className="grid-2">
        <NumberField label="x" unit="m" value={inlet.x} min={0} max={site.width_m} onChange={(v) => v !== null && update({ x: v })} />
        <NumberField label="y" unit="m" value={inlet.y} min={0} max={site.height_m} onChange={(v) => v !== null && update({ y: v })} />
        <NumberField label="Rim elevation" unit="m" value={inlet.rim_elev_m} step={0.1}
                     onChange={(v) => v !== null && update({ rim_elev_m: v, invert_elev_m: round2(v - depth) })}
                     hint="Ground level at the grate" />
        <NumberField label="Depth to invert" unit="m" value={round2(depth)} min={0.3} max={10} step={0.1}
                     onChange={(v) => v !== null && update({ invert_elev_m: round2(inlet.rim_elev_m - v) })}
                     hint={`Invert ${num(inlet.invert_elev_m, 2)} m · new drains use ${DRAIN_DEPTH_M} m`} />
      </div>
      <dl className="kv">
        <dt>Takes runoff from</dt><dd>{draining.length ? draining.map((s) => s.name).join(", ") : "No surfaces yet"}</dd>
        <dt>Pipes</dt>
        <dd>{pipes.length ? pipes.map((p, n) => (
          <span key={p.id}>{n > 0 && ", "}<button className="link-btn" onClick={() => onSelect({ kind: "pipe", id: p.id })}>{p.id}</button></span>
        )) : "None. Use the Pipe tool to connect it."}</dd>
      </dl>
    </section>
  );
}

function PipeInspector({ project, pipe, dispatch, done, onDelete }: {
  project: Project; pipe: Pipe; dispatch: (a: Action) => void; done: React.ReactNode; onDelete: () => void;
}) {
  const { site } = project;
  const update = (patch: Partial<Pipe>) => dispatch({ type: "updatePipe", id: pipe.id, patch });
  const slope = pipeSlope(site, pipe);
  const drawn = pipeLength(site, pipe.from_node, pipe.to_node);
  const nodes = [...site.inlets.map((i) => ({ id: i.id, name: i.name })), { id: site.outfall.id, name: site.outfall.name }];
  const upInvert = site.inlets.find((i) => i.id === pipe.from_node)?.invert_elev_m;
  /** Lower the downstream end so the pipe falls at least 0.5 %. */
  const fixFall = () => {
    if (upInvert === undefined) return;
    const invert = round2(upInvert - Math.max(MIN_FALL * pipe.length_m, 0.01));
    if (pipe.to_node === site.outfall.id) dispatch({ type: "updateOutfall", patch: { invert_elev_m: invert } });
    else dispatch({ type: "updateInlet", id: pipe.to_node, patch: { invert_elev_m: invert } });
  };
  return (
    <section className="section" aria-labelledby="h-site-inspector">
      <Head swatch={{ background: "var(--pipe)", height: 4, alignSelf: "center" }} title={`${pipe.id} · Pipe`} done={done} onDelete={onDelete} />
      <div className="grid-2">
        <div className="field">
          <label htmlFor="pipe-from">From (upstream)</label>
          <select id="pipe-from" className="select" value={pipe.from_node}
                  onChange={(e) => update({ from_node: e.target.value, length_m: pipeLength(site, e.target.value, pipe.to_node) })}>
            {site.inlets.map((i) => <option key={i.id} value={i.id}>{i.id} · {i.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pipe-to">To (downstream)</label>
          <select id="pipe-to" className="select" value={pipe.to_node}
                  onChange={(e) => update({ to_node: e.target.value, length_m: pipeLength(site, pipe.from_node, e.target.value) })}>
            {nodes.filter((n) => n.id !== pipe.from_node).map((n) => <option key={n.id} value={n.id}>{n.id} · {n.name}</option>)}
          </select>
        </div>
        <NumberField label="Diameter" unit="mm" value={Math.round(pipe.diameter_m * 1000)} min={60} max={3000} step={25}
                     onChange={(v) => v !== null && update({ diameter_m: v / 1000 })} />
        <NumberField label="Length" unit="m" value={pipe.length_m} min={1} max={5000}
                     onChange={(v) => v !== null && update({ length_m: v })}
                     hint={pipe.length_m !== drawn ? <button className="link-btn" onClick={() => update({ length_m: drawn })}>Use drawn {num(drawn, 1)} m</button> : "Matches the plan"} />
      </div>
      <NumberField label="Manning’s n" value={pipe.roughness_n ?? 0.013} min={0.009} max={0.05} step={0.001}
                   onChange={(v) => v !== null && update({ roughness_n: v })} hint="0.013 for concrete, 0.011 for plastic" />
      <dl className="kv">
        <dt>Fall</dt>
        <dd>
          {slope === null ? "—" : <span style={slope <= 0 ? { color: "var(--bad-ink)" } : undefined}>{num(slope * 100, 2)} %{slope <= 0 && " (runs uphill)"}</span>}
          {slope !== null && slope < MIN_FALL && upInvert !== undefined && (
            <> · <button className="link-btn" onClick={fixFall}>Give it a {MIN_FALL * 100} % fall</button></>
          )}
        </dd>
      </dl>
    </section>
  );
}

function OutfallInspector({ project, dispatch, done }: {
  project: Project; dispatch: (a: Action) => void; done: React.ReactNode;
}) {
  const { site } = project;
  const o = site.outfall;
  const update = (patch: Partial<typeof o>) => dispatch({ type: "updateOutfall", patch });
  return (
    <section className="section" aria-labelledby="h-site-inspector">
      <Head swatch={{ background: "var(--node)", borderRadius: 99 }} title={`${o.id} · Outfall`} done={done} />
      <TextField label="Name" value={o.name} maxLength={80} onCommit={(name) => update({ name })} />
      <div className="grid-2">
        <NumberField label="x" unit="m" value={o.x} min={0} max={site.width_m} onChange={(v) => v !== null && update({ x: v })} />
        <NumberField label="y" unit="m" value={o.y} min={0} max={site.height_m} onChange={(v) => v !== null && update({ y: v })} />
      </div>
      <NumberField label="Invert elevation" unit="m" value={o.invert_elev_m} step={0.1}
                   onChange={(v) => v !== null && update({ invert_elev_m: v })}
                   hint="Where the pipe network discharges, e.g. to a creek or a street sewer. It flows freely." />
    </section>
  );
}

function TextField({ label, value, maxLength, onCommit }: {
  label: string; value: string; maxLength: number; onCommit: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const id = `t-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input" value={text} maxLength={maxLength} onChange={(e) => setText(e.target.value)}
             onBlur={() => { const v = text.trim(); if (v && v !== value) onCommit(v); else setText(value); }}
             onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
    </div>
  );
}

const round2 = (v: number) => Math.round(v * 100) / 100;
