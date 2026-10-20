"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { api, ApiError, createUnique, newProjectId } from "@/lib/api";
import { money } from "@/lib/format";
import { area, newIntervention } from "@/lib/geometry";
import { interventionCost, LID_ORDER, LIDS } from "@/lib/lids";
import { blankProject, levelUpstream, newInlet, newPipe, newSurface, type SiteElement } from "@/lib/siteBuilder";
import { activeDesign, initState, reducer } from "@/lib/store";
import type {
  EngineInfo, Intervention, Project, Rect, Reference, SavedProject, SimulationResult, SurfaceKind, ValidateResponse,
} from "@/lib/types";
import { useAutosave, type SaveStatus } from "@/lib/useAutosave";
import DesignPanel from "./DesignPanel";
import ExplorerView from "./ExplorerView";
import GettingStarted from "./GettingStarted";
import ProjectsMenu from "./ProjectsMenu";
import ResultsPanel, { type RunOutput } from "./ResultsPanel";
import { AssumptionsPanel, ScenarioPanel } from "./SettingsPanels";
import SiteEditor, { type Layer, type Tool } from "./SiteEditor";
import SitePanel from "./SitePanel";
import { Icon, Logo } from "./ui";

// three.js is large, so the 3D view loads only when it's first opened.
const Site3D = dynamic(() => import("./Site3D"), {
  ssr: false,
  loading: () => <div className="card empty-state"><span className="spinner" /> Loading 3D view…</div>,
});

const LEGACY_KEY = "runofflab.project.v1"; // browser-only saves from before SQLite
const LAST_KEY = "runofflab.lastProject";
const OPEN_LAYER_KEY = "runofflab.openInSiteLayout"; // set when a blank site is created, read once on open
type Tab = "design" | "scenario" | "assumptions";

function storage(op: "get" | "set" | "remove", key: string, value = ""): string | null {
  try {
    if (op === "get") return localStorage.getItem(key);
    if (op === "set") localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* storage unavailable */ }
  return null;
}

function legacyProject(): Project | null {
  try {
    const raw = storage("get", LEGACY_KEY);
    return raw ? (JSON.parse(raw) as Project) : null;
  } catch {
    return null;
  }
}

export default function Workspace() {
  const [session, setSession] = useState<{ saved: SavedProject; generation: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reference, setReference] = useState<Reference | null>(null);
  const [engine, setEngine] = useState<EngineInfo | null>(null);

  /** Show a saved project, remounting the workspace so undo history starts fresh. */
  const show = useCallback((saved: SavedProject) => {
    setSession((s) => ({ saved, generation: (s?.generation ?? 0) + 1 }));
    storage("set", LAST_KEY, saved.project.id);
    const url = new URL(window.location.href);
    url.searchParams.set("project", saved.project.id);
    window.history.replaceState(null, "", url);
  }, []);

  /** Open `id`, else the project in the URL, else the last one opened, else the most recent. */
  const open = useCallback(async (id?: string) => {
    setLoadError(null);
    try {
      const list = await api.listProjects();
      if (list.length === 0) {
        // First run: keep a project saved by the browser-only version, or start from the sample.
        const saved = await createUnique(legacyProject() ?? await api.sample());
        storage("remove", LEGACY_KEY);
        return show(saved);
      }
      const wanted = id ?? new URLSearchParams(window.location.search).get("project") ?? storage("get", LAST_KEY);
      const target = list.find((p) => p.id === wanted) ?? list[0];
      show(await api.getProject(target.id));
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [show]);

  // React's dev mode runs effects twice; loading twice would seed the sample twice.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void open();
    api.reference().then(setReference).catch(() => {});
    api.health().then(setEngine).catch(() => {});
  }, [open]);

  if (!session) {
    return (
      <div className="app">
        <TopBarShell />
        <div className="card empty-state" style={{ margin: 20 }}>
          {loadError ? (
            <>
              <Icon name="alert" size={28} />
              <h2>Can’t load your projects</h2>
              <p>{loadError}</p>
              <p className="muted small">Start it with <code>cd backend && .venv/bin/uvicorn runofflab.api.app:app --reload</code></p>
              <button className="btn primary" onClick={() => void open()}>Try again</button>
            </>
          ) : (
            <><span className="spinner" /> Loading project…</>
          )}
        </div>
      </div>
    );
  }
  return <Loaded initial={session.saved} reference={reference} engine={engine} onShow={show} onOpen={open}
                 key={session.generation} />;
}

function TopBarShell({ children }: { children?: React.ReactNode }) {
  return (
    <header className="topbar">
      <div className="brand"><Logo /> <span>Runoff<span className="lab">Lab</span></span></div>
      {children}
    </header>
  );
}

function Loaded({ initial, reference, engine, onShow, onOpen }: {
  initial: SavedProject;
  reference: Reference | null;
  engine: EngineInfo | null;
  onShow: (saved: SavedProject) => void;
  onOpen: (id?: string) => Promise<void>;
}) {
  const [state, dispatchRaw] = useReducer(reducer, initial.project, initState);
  const { project, selectedId } = state;
  const design = activeDesign(state);
  const [tool, setTool] = useState<Tool>("select");
  const [layer, setLayerRaw] = useState<Layer>("design");
  const [siteSel, setSiteSel] = useState<SiteElement | null>(null);
  const [surfaceKind, setSurfaceKind] = useState<SurfaceKind>("lawn");
  const setLayer = useCallback((l: Layer) => {
    setLayerRaw(l);
    setTool("select");
    setSiteSel(null);
    dispatchRaw({ type: "select", id: null });
  }, []);
  useEffect(() => {
    if (storage("get", OPEN_LAYER_KEY) === project.id) setLayerRaw("site");
    storage("remove", OPEN_LAYER_KEY);
  }, []);
  const [tab, setTab] = useState<Tab>("design");
  const [view, setView] = useState<"editor" | "3d" | "explorer">("editor");
  const [exploreJobId, setExploreJobId] = useState<string | null>(null);
  const dispatch = dispatchRaw;

  // ── Saving ──────────────────────────────────────────────────────────────
  const save = useAutosave(project, initial.version);
  const [projectError, setProjectError] = useState<string | null>(null);

  /** Run a project-level action (switch, create, delete) after flushing unsaved edits. */
  const projectAction = useCallback(async (fn: () => Promise<void>) => {
    setProjectError(null);
    try {
      await save.saveNow();
      await fn();
    } catch (e) {
      setProjectError((e as Error).message);
    }
  }, [save]);

  // ── Live validation ─────────────────────────────────────────────────────
  const [validation, setValidation] = useState<ValidateResponse | null>(null);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    setValidating(true);
    const t = setTimeout(() => {
      api.validate(project, design, ctrl.signal)
        .then((v) => { setValidation(v); setValidationError(null); })
        .catch((e) => { if ((e as Error).name !== "AbortError") setValidationError((e as Error).message); })
        .finally(() => { if (!ctrl.signal.aborted) setValidating(false); });
    }, 200);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [project, design]);

  // ── Simulation ──────────────────────────────────────────────────────────
  const [run, setRun] = useState<RunOutput | null>(null);
  const [runKey, setRunKey] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runCount, setRunCount] = useState(0); // bumps after every run, to bring results into view

  // The Run button sits in the header, but results render below the plan, often off screen.
  useEffect(() => {
    if (runCount === 0) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById("results")?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [runCount]);
  const baselineCache = useRef(new Map<string, SimulationResult>());

  const currentKey = useMemo(
    () => JSON.stringify({ site: project.site, scenario: project.scenario, costs: project.costs, design }),
    [project.site, project.scenario, project.costs, design]);

  const scenarioLabel = useMemo(() => {
    const sc = project.scenario;
    const pattern = sc.pattern === "scs_type_ii" ? "24 h SCS Type II"
      : `${sc.duration_hr} h ${sc.pattern === "triangular" ? "triangular" : "uniform"}`;
    const soil = reference?.soils[project.site.soil]?.label.toLowerCase() ?? project.site.soil.replace(/_/g, " ");
    const factor = sc.infiltration_factor !== 1 ? ` (infiltration ×${sc.infiltration_factor})` : "";
    return `${sc.depth_mm} mm, ${pattern} storm on ${soil}${factor}`;
  }, [project.scenario, project.site.soil, reference]);

  const runSimulation = useCallback(async () => {
    setRunning(true);
    setRunError(null);
    const key = currentKey;
    const baseKey = JSON.stringify({ site: project.site, scenario: project.scenario });
    try {
      const cached = baselineCache.current.get(baseKey);
      const [baseline, proposed] = await Promise.all([
        cached ? Promise.resolve(cached) : api.simulate(project, null),
        design ? api.simulate(project, design) : Promise.resolve(null),
      ]);
      baselineCache.current.set(baseKey, baseline);
      const cost = design?.interventions.reduce((sum, i) => sum + interventionCost(i, project.costs), 0) ?? 0;
      setRun({ project, baseline, proposed, design, cost, scenarioLabel });
      setRunKey(key);
    } catch (e) {
      const err = e as ApiError;
      setRunError(err.issues?.length ? "This design breaks a constraint. Fix the errors under Checks, then run again." : err.message);
    } finally {
      setRunning(false);
      setRunCount((n) => n + 1);
    }
  }, [currentKey, project, design, scenarioLabel]);

  const infeasible = validation ? !validation.feasible : false;
  const canRun = !infeasible && !running;

  // ── Editor callbacks ────────────────────────────────────────────────────
  const onCreate = useCallback((kind: Intervention["kind"], rect: Rect) => {
    if (!design) return;
    dispatch({ type: "addIntervention", item: newIntervention(kind, rect, project.site, design, project.constraints) });
    setTool("select");
    setTab("design");
  }, [design, project.site, project.constraints, dispatch]);

  const onChangeRect = useCallback((id: string, rect: Rect) =>
    dispatch({ type: "updateIntervention", id, patch: { rect } }), [dispatch]);

  // Site layout: drawing tools stay active so several surfaces or drains can be placed in a row.
  const onCreateSurface = useCallback((rect: Rect) => {
    const surface = newSurface(project, surfaceKind, rect);
    dispatch({ type: "addSurface", surface });
    setSiteSel({ kind: "surface", id: surface.id });
  }, [project, surfaceKind, dispatch]);
  const onCreateInlet = useCallback((x: number, y: number) => {
    const inlet = newInlet(project, x, y);
    dispatch({ type: "addInlet", inlet });
    setSiteSel({ kind: "inlet", id: inlet.id });
  }, [project, dispatch]);
  const onCreatePipe = useCallback((from: string, to: string) => {
    const existing = project.site.pipes.find((p) => p.from_node === from && p.to_node === to);
    if (existing) return setSiteSel({ kind: "pipe", id: existing.id });
    const pipe = newPipe(project, from, to);
    dispatch({ type: "addPipe", pipe, fromInvert: levelUpstream(project.site, pipe) });
    setSiteSel({ kind: "pipe", id: pipe.id });
  }, [project, dispatch]);
  const onMoveNode = useCallback((id: string, x: number, y: number) => {
    if (id === project.site.outfall.id) dispatch({ type: "updateOutfall", patch: { x, y } });
    else dispatch({ type: "updateInlet", id, patch: { x, y } });
  }, [project.site.outfall.id, dispatch]);
  /** A check about the site, clicked in the Design tab: jump to it in Site layout. */
  const showSiteIssue = useCallback((id: string) => {
    const { site } = project;
    const el: SiteElement | null = site.surfaces.some((x) => x.id === id) ? { kind: "surface", id }
      : site.inlets.some((x) => x.id === id) ? { kind: "inlet", id }
      : site.pipes.some((x) => x.id === id) ? { kind: "pipe", id }
      : site.outfall.id === id ? { kind: "outfall", id } : null;
    if (!el) return;
    setLayer("site");
    setSiteSel(el);
  }, [project, setLayer]);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.closest("input, select, textarea")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
        return;
      }
      if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); dispatch({ type: "redo" }); return; }
      if (mod && e.key === "Enter") { e.preventDefault(); if (canRun) void runSimulation(); return; }
      if (mod || e.altKey) return;
      if (layer === "site") {
        const { site } = project;
        if (e.key === "Escape") { setTool("select"); setSiteSel(null); }
        else if (e.key === "v") setTool("select");
        else if (e.key === "s") setTool("surface");
        else if (e.key === "d") setTool("drain");
        else if (e.key === "c") setTool("pipe");
        else if ((e.key === "Delete" || e.key === "Backspace") && siteSel) {
          e.preventDefault();
          if (siteSel.kind === "surface" && site.surfaces.length > 1) dispatch({ type: "deleteSurface", id: siteSel.id });
          else if (siteSel.kind === "inlet" && site.inlets.length > 1) dispatch({ type: "deleteInlet", id: siteSel.id });
          else if (siteSel.kind === "pipe") dispatch({ type: "deletePipe", id: siteSel.id });
          else return;
          setSiteSel(null);
        } else if (siteSel && e.key.startsWith("Arrow")) {
          e.preventDefault();
          const d = e.shiftKey ? 5 : 1;
          const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
          const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
          const clampX = (v: number, w = 0) => Math.min(Math.max(v, 0), site.width_m - w);
          const clampY = (v: number, h = 0) => Math.min(Math.max(v, 0), site.height_m - h);
          if (siteSel.kind === "surface") {
            const sf = site.surfaces.find((x) => x.id === siteSel.id);
            if (sf) dispatch({ type: "updateSurface", id: sf.id, patch: { rect: { ...sf.rect,
              x: clampX(sf.rect.x + dx, sf.rect.width), y: clampY(sf.rect.y + dy, sf.rect.height) } } });
          } else if (siteSel.kind === "inlet") {
            const n = site.inlets.find((x) => x.id === siteSel.id);
            if (n) dispatch({ type: "updateInlet", id: n.id, patch: { x: clampX(n.x + dx), y: clampY(n.y + dy) } });
          } else if (siteSel.kind === "outfall") {
            dispatch({ type: "updateOutfall", patch: { x: clampX(site.outfall.x + dx), y: clampY(site.outfall.y + dy) } });
          }
        }
        return;
      }
      const sel = design?.interventions.find((i) => i.id === selectedId);
      if ((e.key === "Delete" || e.key === "Backspace") && sel) {
        e.preventDefault();
        dispatch({ type: "deleteIntervention", id: sel.id });
      } else if (e.key === "Escape") {
        setTool("select");
        dispatch({ type: "select", id: null });
      } else if (e.key === "v") setTool("select");
      else if (design && LID_ORDER.some((k) => LIDS[k].key === e.key)) setTool(LID_ORDER.find((k) => LIDS[k].key === e.key)!);
      else if (sel && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const d = e.shiftKey ? 5 : 1;
        const { x, y, width, height } = sel.rect;
        const nx = e.key === "ArrowLeft" ? x - d : e.key === "ArrowRight" ? x + d : x;
        const ny = e.key === "ArrowUp" ? y - d : e.key === "ArrowDown" ? y + d : y;
        const rect = {
          width, height,
          x: Math.min(Math.max(nx, 0), project.site.width_m - width),
          y: Math.min(Math.max(ny, 0), project.site.height_m - height),
        };
        if (rect.x !== x || rect.y !== y) dispatch({ type: "updateIntervention", id: sel.id, patch: { rect } });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [design, selectedId, project, layer, siteSel, dispatch, canRun, runSimulation]);

  // ── Import / export ─────────────────────────────────────────────────────
  const fileInput = useRef<HTMLInputElement>(null);

  function exportProject() {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${project.id}.runofflab.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function importProject(file: File) {
    let parsed: Project;
    try {
      parsed = JSON.parse(await file.text()) as Project;
    } catch {
      return setProjectError("That file isn’t valid JSON.");
    }
    // The backend checks the schema when the project is created.
    await projectAction(async () => onShow(await createUnique(parsed)));
  }

  const newBlankSite = () => projectAction(async () => {
    const saved = await createUnique(blankProject(await api.sample(), newProjectId()));
    storage("set", OPEN_LAYER_KEY, saved.project.id);
    onShow(saved);
  });

  const newFromSample = () => projectAction(async () => {
    const sample = await api.sample();
    onShow(await createUnique({ ...sample, id: newProjectId(), name: "Untitled project" }));
  });

  const duplicateProject = () => projectAction(async () => {
    onShow(await createUnique({ ...project, id: newProjectId(), name: `${project.name} (copy)`.slice(0, 120) }));
  });

  const deleteProject = (id: string, name: string) => {
    if (!confirm(`Delete “${name}”? This can’t be undone.`)) return;
    void projectAction(async () => {
      await api.deleteProject(id);
      if (id === project.id) await onOpen(); // falls back to the most recent project
    });
  };

  const issues = validation?.issues ?? [];
  const stale = run !== null && runKey !== currentKey;

  return (
    <div className="app">
      <TopBarShell>
        <ProjectsMenu currentId={project.id} onOpen={(id) => void projectAction(() => onOpen(id))}
                      onNew={() => void newFromSample()} onNewBlank={() => void newBlankSite()} onDuplicate={() => void duplicateProject()}
                      onImport={() => fileInput.current?.click()} onDelete={deleteProject} />
        <input className="project-name" aria-label="Project name" defaultValue={project.name} key={project.name}
               maxLength={120}
               onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== project.name) dispatch({ type: "renameProject", name: v }); }}
               onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        <div style={{ display: "flex", gap: 2 }}>
          <button className="btn icon ghost" title="Undo (⌘Z)" aria-label="Undo" disabled={!state.past.length} onClick={() => dispatch({ type: "undo" })}><Icon name="undo" /></button>
          <button className="btn icon ghost" title="Redo (⇧⌘Z)" aria-label="Redo" disabled={!state.future.length} onClick={() => dispatch({ type: "redo" })}><Icon name="redo" /></button>
        </div>
        <SaveIndicator status={save.status} onRetry={() => void save.saveNow()} />
        <div className="spacer" />
        {engine && <span className="engine-badge">SWMM {engine.swmm_version}</span>}
        <div style={{ display: "flex", gap: 2 }}>
          <button className="btn icon ghost" title="Export project JSON" aria-label="Export project" onClick={exportProject}><Icon name="download" /></button>
          <input ref={fileInput} type="file" accept="application/json,.json" hidden
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) void importProject(f); e.target.value = ""; }} />
        </div>
        <button className="btn primary" disabled={!canRun} onClick={() => void runSimulation()}
                title={infeasible ? "Fix the errors under Checks first" : "Run SWMM (⌘↵)"}>
          {running ? <span className="spinner" /> : <Icon name="play" size={14} />}
          {design ? "Run comparison" : "Run baseline"}
        </button>
      </TopBarShell>

      {save.status === "conflict" && (
        <div className="banner conflict" role="alert">
          <Icon name="warn" /> This project was changed in another tab or window, so your latest edits weren’t saved.
          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button className="btn sm" onClick={() => void onOpen(project.id)}>Load saved version</button>
            <button className="btn sm" onClick={() => void save.overwrite()}>Keep mine</button>
          </span>
        </div>
      )}
      {save.status === "error" && save.error && (
        <div className="banner" role="alert"><Icon name="alert" /> Couldn’t save: {save.error}</div>
      )}
      {(validationError || projectError) && (
        <div className="banner" role="alert"><Icon name="alert" /> {projectError ?? validationError}</div>
      )}

      <SiteStrip project={project} reference={reference} />

      <nav className="view-tabs" role="tablist" aria-label="Views">
        <button role="tab" aria-selected={view === "editor"} onClick={() => setView("editor")}>
          <Icon name="area" size={15} /> Site editor
        </button>
        <button role="tab" aria-selected={view === "3d"} onClick={() => setView("3d")}>
          <Icon name="cube" size={15} /> 3D view
        </button>
        <button role="tab" aria-selected={view === "explorer"} onClick={() => setView("explorer")}>
          <Icon name="sprout" size={15} /> Design Explorer
        </button>
      </nav>

      <div hidden={view !== "explorer"}>
        <ExplorerView project={project} onJob={setExploreJobId} onAdopt={(point) => {
          dispatch({ type: "adoptDesign", name: `Explorer: ${money(point.cost, project.costs.currency)} design`,
                     interventions: point.design.interventions });
          setView("editor");
          setTab("design");
        }} />
      </div>

      {view === "3d" && (
        <div className="view3d-wrap">
          <Site3D project={project} design={design} run={run} stale={stale} selectedId={selectedId}
                  onSelect={(id) => dispatch({ type: "select", id })} onRun={() => void runSimulation()}
                  canRun={canRun} running={running} />
        </div>
      )}

      {view === "editor" && <>
      <GettingStarted onExplore={() => setView("explorer")} />
      <main className="workspace">
        <SiteEditor site={project.site} design={design} selectedId={selectedId} issues={issues} tool={tool}
                    onToolChange={setTool} onSelect={(id) => dispatch({ type: "select", id })}
                    onCreate={onCreate} onChangeRect={onChangeRect}
                    layer={layer} onLayerChange={(l) => { setLayer(l); setTab("design"); }}
                    surfaceKind={surfaceKind} onSurfaceKindChange={setSurfaceKind}
                    siteSel={siteSel} onSiteSelect={setSiteSel} onCreateSurface={onCreateSurface}
                    onChangeSurfaceRect={(id, rect) => dispatch({ type: "updateSurface", id, patch: { rect } })}
                    onCreateInlet={onCreateInlet} onMoveNode={onMoveNode} onCreatePipe={onCreatePipe} />

        <aside className="card sidebar" aria-label="Project settings">
          <div className="tabs" role="tablist">
            {(["design", "scenario", "assumptions"] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                <Icon name={t === "design" ? (layer === "site" ? "area" : "sprout") : t === "scenario" ? "rain" : "coins"} size={15} />
                {t === "design" ? (layer === "site" ? "Site" : "Design") : t === "scenario" ? "Storm & soil" : "Costs & limits"}
                {t === "design" && issues.some((i) => i.severity === "error") && (
                  <span className="swatch" style={{ background: "var(--critical)", width: 7, height: 7, borderRadius: 99, marginLeft: 6, verticalAlign: 2 }} aria-label="has errors" />
                )}
              </button>
            ))}
          </div>
          <div className="tab-panel" role="tabpanel">
            {tab === "design" && layer === "design" && (
              <DesignPanel project={project} design={design} selectedId={selectedId}
                           validation={validation} validating={validating} dispatch={dispatch} onSiteIssue={showSiteIssue} />
            )}
            {tab === "design" && layer === "site" && (
              <SitePanel project={project} sel={siteSel} validation={validation} validating={validating}
                         dispatch={dispatch} onSelect={setSiteSel} />
            )}
            {tab === "scenario" && <ScenarioPanel project={project} reference={reference} dispatch={dispatch} />}
            {tab === "assumptions" && <AssumptionsPanel project={project} reference={reference} dispatch={dispatch} />}
          </div>
        </aside>
      </main>

      <ResultsPanel project={project} run={run} stale={stale} running={running} error={runError}
                    onRun={() => void runSimulation()} canRun={canRun} exploreJobId={exploreJobId}
                    onOpenDesign={(id) => {
                      setLayer("design");
                      setTab("design");
                      dispatch({ type: "selectDesign", id });
                      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                      window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
                    }} />
      </>}
    </div>
  );
}

function SaveIndicator({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  if (status === "error") {
    return (
      <span className="save-status error" role="status">
        <Icon name="alert" size={14} /> Not saved
        <button className="btn sm" onClick={onRetry}>Retry</button>
      </span>
    );
  }
  const text = { saved: "Saved", pending: "Unsaved changes", saving: "Saving…", conflict: "Not saved" }[status];
  return (
    <span className={`save-status ${status}`} role="status" title="Projects are saved to the local SQLite database">
      {status === "saving" ? <span className="spinner" style={{ width: 12, height: 12 }} />
        : <Icon name={status === "conflict" ? "warn" : "cloud"} size={14} />}
      {text}
    </span>
  );
}

/** One-line summary of the site and the storm being modelled. */
function SiteStrip({ project, reference }: { project: Project; reference: Reference | null }) {
  const { site, scenario } = project;
  const total = site.surfaces.reduce((sum, x) => sum + area(x.rect), 0);
  const paved = site.surfaces
    .filter((x) => (reference?.surfaces[x.kind]?.impervious_pct ?? (["lawn", "landscape"].includes(x.kind) ? 0 : 100)) > 0)
    .reduce((sum, x) => sum + area(x.rect), 0);
  const pavedPct = total ? Math.round((paved / total) * 100) : 0;
  const soil = reference?.soils[site.soil]?.label ?? site.soil.replace(/_/g, " ");
  const storm = scenario.pattern === "scs_type_ii" ? "24 h SCS Type II"
    : `${scenario.duration_hr} h ${scenario.pattern === "triangular" ? "triangular" : "uniform"}`;
  return (
    <div className="site-strip" aria-label="Site summary">
      <span className="site-title">{site.name}</span>
      <span className="fact"><Icon name="area" size={14} /><strong>{(total / 10_000).toFixed(1)} ha</strong> site</span>
      <span className="fact" title={`${pavedPct}% of the site is roofs or paving`}>
        <span className="paved-bar" aria-hidden="true"><span style={{ width: `${pavedPct}%` }} /></span>
        <strong>{pavedPct}%</strong> paved or roofed
      </span>
      <span className="fact"><Icon name="soil" size={14} /><strong>{soil}</strong> soil</span>
      <span className="fact"><Icon name="rain" size={14} /><strong>{scenario.depth_mm} mm</strong> {storm} storm</span>
    </div>
  );
}
