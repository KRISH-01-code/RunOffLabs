"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ApiError } from "./api";
import type { Project } from "./types";

export type SaveStatus = "saved" | "pending" | "saving" | "error" | "conflict";

/**
 * Save `project` to the backend shortly after each edit.
 *
 * Saves run one at a time, each based on the version the previous one
 * returned. If the server reports a version conflict (the project changed in
 * another tab), autosave stops until the user chooses to overwrite or reload.
 */
export function useAutosave(project: Project, initialVersion: number, delayMs = 700) {
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [error, setError] = useState<string | null>(null);
  const version = useRef(initialVersion);
  const saved = useRef(project); // the last project the server confirmed
  const latest = useRef(project);
  const inFlight = useRef<Promise<void> | null>(null);
  const blocked = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  latest.current = project;

  const saveNow = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    while (inFlight.current) await inFlight.current;
    const target = latest.current;
    if (blocked.current || target === saved.current) return;
    const run = (async () => {
      setStatus("saving");
      try {
        const res = await api.saveProject(target, version.current);
        version.current = res.version;
        saved.current = target;
        setError(null);
        setStatus(latest.current === target ? "saved" : "pending");
      } catch (e) {
        const err = e as ApiError;
        if (err.kind === "version_conflict") {
          blocked.current = true;
          setStatus("conflict");
        } else {
          setStatus("error");
        }
        setError(err.message);
      }
    })();
    inFlight.current = run;
    await run;
    inFlight.current = null;
  }, []);

  useEffect(() => {
    if (project === saved.current || blocked.current) return;
    setStatus((s) => (s === "saving" ? s : "pending"));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveNow(), delayMs);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [project, delayMs, saveNow]);

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    if (status === "saved") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [status]);

  /** Resolve a conflict by replacing the server copy with this one. */
  const overwrite = useCallback(async () => {
    try {
      const current = await api.getProject(latest.current.id);
      version.current = current.version;
      saved.current = current.project;
      blocked.current = false;
      await saveNow();
    } catch (e) {
      setStatus("error");
      setError((e as Error).message);
    }
  }, [saveNow]);

  return { status, error, saveNow, overwrite };
}
