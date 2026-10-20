// Workspace state: the project being edited, the active design, and undo history.

import { placeSurface, syncPipeLengths } from "./siteBuilder";
import type {
  Constraints, CostAssumptions, Design, Inlet, Intervention, LongTermSettings, Outfall, Pipe, Project, Scenario, Site, SoilTexture, Surface,
} from "./types";

export interface WorkspaceState {
  project: Project;
  activeDesignId: string | null; // null = baseline (no interventions)
  selectedId: string | null; // selected intervention
  past: Project[];
  future: Project[];
}

export type Action =
  | { type: "undo" }
  | { type: "redo" }
  | { type: "select"; id: string | null }
  | { type: "selectDesign"; id: string | null }
  | { type: "addDesign"; copyFrom?: string }
  | { type: "adoptDesign"; name: string; interventions: Intervention[] }
  | { type: "renameDesign"; id: string; name: string }
  | { type: "deleteDesign"; id: string }
  | { type: "addIntervention"; item: Intervention }
  | { type: "updateIntervention"; id: string; patch: Partial<Intervention> }
  | { type: "deleteIntervention"; id: string }
  | { type: "setScenario"; patch: Partial<Scenario> }
  | { type: "setSoil"; soil: SoilTexture }
  | { type: "setCosts"; patch: Partial<CostAssumptions> }
  | { type: "setConstraints"; patch: Partial<Constraints> }
  | { type: "renameProject"; name: string }
  | { type: "setLongTerm"; patch: Partial<LongTermSettings> }
  // Site layout
  | { type: "setSite"; patch: Partial<Pick<Site, "name" | "width_m" | "height_m">> }
  | { type: "addSurface"; surface: Surface }
  | { type: "updateSurface"; id: string; patch: Partial<Surface> }
  | { type: "deleteSurface"; id: string }
  | { type: "addInlet"; inlet: Inlet }
  | { type: "updateInlet"; id: string; patch: Partial<Inlet> }
  | { type: "deleteInlet"; id: string }
  | { type: "updateOutfall"; patch: Partial<Outfall> }
  | { type: "addPipe"; pipe: Pipe; fromInvert?: number } // optionally re-level the upstream drain
  | { type: "updatePipe"; id: string; patch: Partial<Pipe> }
  | { type: "deletePipe"; id: string };

const HISTORY_LIMIT = 100;

export function initState(project: Project): WorkspaceState {
  return {
    project,
    activeDesignId: project.designs[0]?.id ?? null,
    selectedId: null,
    past: [],
    future: [],
  };
}

export function activeDesign(s: WorkspaceState): Design | null {
  return s.project.designs.find((d) => d.id === s.activeDesignId) ?? null;
}

function nextDesignId(project: Project): string {
  const taken = new Set(project.designs.map((d) => d.id));
  for (let n = 1; ; n++) if (!taken.has(`D${n}`)) return `D${n}`;
}

/** Apply an edit to the project, recording the previous version for undo. */
function commit(s: WorkspaceState, project: Project, extra: Partial<WorkspaceState> = {}): WorkspaceState {
  return { ...s, ...extra, project, past: [...s.past, s.project].slice(-HISTORY_LIMIT), future: [] };
}

function mapDesign(s: WorkspaceState, fn: (d: Design) => Design): Project {
  return {
    ...s.project,
    designs: s.project.designs.map((d) => (d.id === s.activeDesignId ? fn(d) : d)),
  };
}

export function reducer(s: WorkspaceState, a: Action): WorkspaceState {
  switch (a.type) {
    case "undo": {
      const prev = s.past.at(-1);
      if (!prev) return s;
      return fixSelection({ ...s, project: prev, past: s.past.slice(0, -1), future: [s.project, ...s.future] });
    }
    case "redo": {
      const [next, ...rest] = s.future;
      if (!next) return s;
      return fixSelection({ ...s, project: next, past: [...s.past, s.project], future: rest });
    }
    case "select":
      return { ...s, selectedId: a.id };
    case "selectDesign":
      return { ...s, activeDesignId: a.id, selectedId: null };
    case "addDesign": {
      const id = nextDesignId(s.project);
      const source = s.project.designs.find((d) => d.id === a.copyFrom);
      const design: Design = source
        ? { id, name: `${source.name} (copy)`.slice(0, 80), interventions: structuredClone(source.interventions) }
        : { id, name: `Design ${id.slice(1)}`, interventions: [] };
      return commit(s, { ...s.project, designs: [...s.project.designs, design] },
        { activeDesignId: id, selectedId: null });
    }
    case "adoptDesign": {
      const id = nextDesignId(s.project);
      const design: Design = { id, name: a.name.slice(0, 80), interventions: structuredClone(a.interventions) };
      return commit(s, { ...s.project, designs: [...s.project.designs, design] },
        { activeDesignId: id, selectedId: null });
    }
    case "renameDesign":
      return commit(s, {
        ...s.project,
        designs: s.project.designs.map((d) => (d.id === a.id ? { ...d, name: a.name } : d)),
      });
    case "deleteDesign": {
      const designs = s.project.designs.filter((d) => d.id !== a.id);
      const active = s.activeDesignId === a.id ? designs[0]?.id ?? null : s.activeDesignId;
      return commit(s, { ...s.project, designs }, { activeDesignId: active, selectedId: null });
    }
    case "addIntervention":
      return commit(s, mapDesign(s, (d) => ({ ...d, interventions: [...d.interventions, a.item] })),
        { selectedId: a.item.id });
    case "updateIntervention": {
      const rename = a.patch.id && a.patch.id !== a.id ? a.patch.id : null;
      return commit(s, mapDesign(s, (d) => ({
        ...d,
        interventions: d.interventions.map((i) => (i.id === a.id ? ({ ...i, ...a.patch } as Intervention) : i)),
      })), rename && s.selectedId === a.id ? { selectedId: rename } : {});
    }
    case "deleteIntervention":
      return commit(s, mapDesign(s, (d) => ({ ...d, interventions: d.interventions.filter((i) => i.id !== a.id) })),
        { selectedId: s.selectedId === a.id ? null : s.selectedId });
    case "setScenario":
      return commit(s, { ...s.project, scenario: { ...s.project.scenario, ...a.patch } });
    case "setSoil":
      return commit(s, { ...s.project, site: { ...s.project.site, soil: a.soil } });
    case "setCosts":
      return commit(s, { ...s.project, costs: { ...s.project.costs, ...a.patch } });
    case "setConstraints":
      return commit(s, { ...s.project, constraints: { ...s.project.constraints, ...a.patch } });
    case "renameProject":
      return commit(s, { ...s.project, name: a.name });
    case "setLongTerm":
      return commit(s, { ...s.project, long_term: { ...s.project.long_term, ...a.patch } });
    case "setSite":
      return commitSite(s, (site) => ({ ...site, ...a.patch }));
    case "addSurface": // drawn over other surfaces, it replaces them there
      return commitSite(s, (site) => ({ ...site, surfaces: placeSurface(s.project, a.surface) }));
    case "updateSurface":
      return commitSite(s, (site) => ({
        ...site, surfaces: site.surfaces.map((x) => (x.id === a.id ? { ...x, ...a.patch } : x)),
      }));
    case "deleteSurface":
      return commitSite(s, (site) => ({ ...site, surfaces: site.surfaces.filter((x) => x.id !== a.id) }));
    case "addInlet":
      return commitSite(s, (site) => ({ ...site, inlets: [...site.inlets, a.inlet] }));
    case "updateInlet":
      return commitSite(s, (site) => {
        const next = { ...site, inlets: site.inlets.map((x) => (x.id === a.id ? { ...x, ...a.patch } : x)) };
        return "x" in a.patch || "y" in a.patch ? syncPipeLengths(next, a.id) : next;
      });
    case "deleteInlet": // its pipes go with it; surfaces that drained to it are flagged by the checks
      return commitSite(s, (site) => ({
        ...site,
        inlets: site.inlets.filter((x) => x.id !== a.id),
        pipes: site.pipes.filter((p) => p.from_node !== a.id && p.to_node !== a.id),
      }));
    case "updateOutfall":
      return commitSite(s, (site) => {
        const next = { ...site, outfall: { ...site.outfall, ...a.patch } };
        return "x" in a.patch || "y" in a.patch ? syncPipeLengths(next, site.outfall.id) : next;
      });
    case "addPipe":
      return commitSite(s, (site) => ({
        ...site,
        pipes: [...site.pipes, a.pipe],
        inlets: a.fromInvert === undefined ? site.inlets
          : site.inlets.map((i) => (i.id === a.pipe.from_node ? { ...i, invert_elev_m: a.fromInvert! } : i)),
      }));
    case "updatePipe":
      return commitSite(s, (site) => ({
        ...site, pipes: site.pipes.map((x) => (x.id === a.id ? { ...x, ...a.patch } : x)),
      }));
    case "deletePipe":
      return commitSite(s, (site) => ({ ...site, pipes: site.pipes.filter((x) => x.id !== a.id) }));
  }
}

function commitSite(s: WorkspaceState, fn: (site: Site) => Site): WorkspaceState {
  return commit(s, { ...s.project, site: fn(s.project.site) });
}

/** After undo/redo the active design or selection may no longer exist. */
function fixSelection(s: WorkspaceState): WorkspaceState {
  const design = s.project.designs.find((d) => d.id === s.activeDesignId);
  const activeDesignId = s.activeDesignId === null ? null : design ? design.id : s.project.designs[0]?.id ?? null;
  const d = s.project.designs.find((x) => x.id === activeDesignId);
  const selectedId = d?.interventions.some((i) => i.id === s.selectedId) ? s.selectedId : null;
  return { ...s, activeDesignId, selectedId };
}
