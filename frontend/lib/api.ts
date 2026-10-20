import type {
  Design, EngineInfo, ExploreObjective, ExploreStatus, Issue, LongTermResult, Project, ProjectSummary, RainRecord, Reference,
  SavedProject, Scenario, SimulationResult, ValidateResponse, WhatIfCase,
} from "./types";

/** A request the backend refused. `issues` is set when a design broke a constraint. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly issues: Issue[] = [],
              readonly kind: string | null = null) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit, signal?: AbortSignal): Promise<T> {
  const res = await send(path, init, signal);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Fetch from the backend, turning refusals into ApiErrors with readable messages. */
async function send(path: string, init?: RequestInit, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      signal,
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError("Can't reach the RunoffLab backend. Is it running on port 8000?", 0);
  }
  if (res.ok) return res;

  const body = await res.json().catch(() => null);
  const detail = body?.detail;
  if (detail?.kind === "invalid_design") {
    throw new ApiError("The design breaks a constraint.", res.status, detail.issues);
  }
  if (detail?.kind === "engine_error") {
    throw new ApiError(`SWMM failed: ${detail.message}`, res.status);
  }
  if (typeof detail?.kind === "string" && typeof detail?.message === "string") {
    throw new ApiError(detail.message, res.status, [], detail.kind);
  }
  if (res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
    // The Next proxy answers 500 when the backend is down.
    throw new ApiError("Can't reach the RunoffLab backend. Is it running on port 8000?", res.status);
  }
  if (Array.isArray(detail)) {
    // FastAPI request-validation errors (422).
    const msg = detail.map((d: { loc: unknown[]; msg: string }) => `${d.loc.slice(1).join(".")}: ${d.msg}`);
    throw new ApiError(`Invalid input — ${msg.join("; ")}`, res.status);
  }
  throw new ApiError(`Request failed (${res.status}).`, res.status);
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const api = {
  health: () => call<EngineInfo>("/health"),
  sample: () => call<Project>("/sample"),
  reference: () => call<Reference>("/reference"),
  validate: (project: Project, design: Design | null, signal?: AbortSignal) =>
    call<ValidateResponse>("/validate", post({ project, design }), signal),
  longTerm: (project: Project, design: Design | null) =>
    call<{ baseline: LongTermResult; proposed: LongTermResult | null }>("/longterm", post({ project, design })),
  /** A design's year-long result alone, for comparisons that share one baseline run. */
  longTermDesign: (project: Project, design: Design) =>
    call<{ baseline: null; proposed: LongTermResult }>("/longterm", post({ project, design, include_baseline: false })),
  parseRainfall: (text: string, units: string, name: string) =>
    call<RainRecord>("/rainfall/parse", post({ text, units, name })),
  simulate: (project: Project, design: Design | null, scenario?: Scenario) =>
    call<SimulationResult>("/simulate", post({ project, design, scenario: scenario ?? null })),

  listProjects: () => call<ProjectSummary[]>("/projects"),
  getProject: (id: string) => call<SavedProject>(`/projects/${encodeURIComponent(id)}`),
  createProject: (project: Project) => call<SavedProject>("/projects", post(project)),
  saveProject: (project: Project, baseVersion: number) =>
    call<SavedProject>(`/projects/${encodeURIComponent(project.id)}`,
      { method: "PUT", body: JSON.stringify({ project, base_version: baseVersion }) }),
  deleteProject: (id: string) => call<void>(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),

  startExplore: (req: { project: Project; objective: ExploreObjective; evaluations: number;
                        rain_gardens: boolean; permeable_pavement: boolean; green_roofs: boolean }) =>
    call<{ job_id: string; workers: number }>("/explore", post(req)),
  exploreStatus: (jobId: string, since: number) => call<ExploreStatus>(`/explore/${jobId}?since=${since}`),
  cancelExplore: (jobId: string) => call<void>(`/explore/${jobId}`, { method: "DELETE" }),
  whatIf: (project: Project, design: Design) => call<WhatIfCase[]>("/whatif", post({ project, design })),
  report: async (project: Project, designId: string, exploreJobId: string | null): Promise<Blob> =>
    (await send("/report", post({ project, design_id: designId, explore_job_id: exploreJobId }))).blob(),
};

/** A fresh project id matching the backend's id pattern. */
export function newProjectId(): string {
  return `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Create `project`, picking a new id if that one is already taken. */
export async function createUnique(project: Project): Promise<SavedProject> {
  try {
    return await api.createProject(project);
  } catch (e) {
    if ((e as ApiError).kind !== "exists") throw e;
    return api.createProject({ ...project, id: newProjectId() });
  }
}
