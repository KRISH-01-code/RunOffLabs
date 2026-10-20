"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ProjectSummary } from "@/lib/types";
import { Icon } from "./ui";

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function ago(iso: string): string {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of units) if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  return "just now";
}

export default function ProjectsMenu({ currentId, onOpen, onNew, onNewBlank, onDuplicate, onImport, onDelete }: {
  currentId: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onNewBlank: () => void;
  onDuplicate: () => void;
  onImport: () => void;
  onDelete: (id: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    api.listProjects().then(setProjects).catch((e) => setError((e as Error).message));
    const close = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", esc); };
  }, [open]);

  const act = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div className="menu-root" ref={root}>
      <button className="btn sm" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="folder" size={14} /> Projects
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-actions">
            <button className="btn sm ghost" role="menuitem" onClick={act(onNew)}><Icon name="plus" size={14} /> New from sample</button>
            <button className="btn sm ghost" role="menuitem" onClick={act(onNewBlank)}><Icon name="area" size={14} /> New blank site</button>
            <button className="btn sm ghost" role="menuitem" onClick={act(onDuplicate)}><Icon name="copy" size={14} /> Duplicate</button>
            <button className="btn sm ghost" role="menuitem" onClick={act(onImport)}><Icon name="upload" size={14} /> Import JSON</button>
          </div>
          <div className="menu-list">
            {error && <p className="small" style={{ color: "var(--bad-ink)", padding: "8px 10px" }}>{error}</p>}
            {!projects && !error && <p className="muted small" style={{ padding: "8px 10px" }}>Loading…</p>}
            {projects?.map((p) => (
              <div key={p.id} className="menu-row" aria-current={p.id === currentId}>
                <button className="menu-open" role="menuitem" onClick={act(() => p.id !== currentId && onOpen(p.id))}>
                  <span className="menu-name">{p.name}</span>
                  <span className="muted small">
                    {p.design_count} design{p.design_count === 1 ? "" : "s"} · saved {ago(p.updated_at)}
                  </span>
                </button>
                <button className="btn icon ghost danger" aria-label={`Delete ${p.name}`} title="Delete project"
                        onClick={act(() => onDelete(p.id, p.name))}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
