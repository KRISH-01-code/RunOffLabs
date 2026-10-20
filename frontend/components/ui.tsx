"use client";

import { useEffect, useState } from "react";

export type IconName = "cursor" | "garden" | "paver" | "play" | "undo" | "redo" | "trash" | "plus" | "copy"
  | "alert" | "warn" | "check" | "drop" | "download" | "upload" | "reset" | "folder" | "cloud"
  | "leaf" | "sprout" | "rain" | "wave" | "coins" | "layers" | "area" | "soil" | "cube" | "sound" | "mute";

const PATHS: Record<IconName, React.ReactNode> = {
  cursor: <path d="M4 3l6.5 15 2.2-6.3L19 9.5z" />,
  garden: <><path d="M12 20v-8" /><path d="M12 12c0-4 3-6 7-6 0 4-3 6-7 6z" /><path d="M12 14c0-3-2.5-5-6-5 0 3 2.5 5 6 5z" /><path d="M4 20h16" /></>,
  paver: <><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M3 9.3h18M3 14.6h18M9 4v5.3M15 9.3v5.3M9 14.6V20" /></>,
  play: <path d="M7 4.5v15l12-7.5z" />,
  undo: <><path d="M9 7L4 12l5 5" /><path d="M4 12h11a5 5 0 010 10h-2" /></>,
  redo: <><path d="M15 7l5 5-5 5" /><path d="M20 12H9a5 5 0 000 10h2" /></>,
  trash: <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5v.01" /></>,
  warn: <><path d="M12 3.5L2.5 20h19z" /><path d="M12 10v4.5M12 17.5v.01" /></>,
  check: <><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.7 2.7L16 10" /></>,
  drop: <path d="M12 3s6.5 7 6.5 11.5a6.5 6.5 0 01-13 0C5.5 10 12 3 12 3z" />,
  download: <><path d="M12 4v11M7 10l5 5 5-5" /><path d="M4 19h16" /></>,
  upload: <><path d="M12 15V4M7 9l5-5 5 5" /><path d="M4 19h16" /></>,
  folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  cloud: <path d="M7 18a4.5 4.5 0 01-.6-8.96A6 6 0 0118 9.5a4 4 0 01-.5 8.5z" />,
  leaf: <><path d="M5 19c0-8 5-13 14-14 0 9-5 14-13 14z" /><path d="M5 19c3-4 6-7 10-9" /></>,
  sprout: <><path d="M12 20v-7" /><path d="M12 13c0-4.5 3-7 8-7 0 4.5-3 7-8 7z" /><path d="M12 15c0-3.5-2.5-5.5-7-5.5 0 3.5 2.5 5.5 7 5.5z" /></>,
  rain: <><path d="M7 15a4.5 4.5 0 01-.6-8.96A6 6 0 0118 6.5a4 4 0 01-.5 8.5z" /><path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5" /></>,
  wave: <><path d="M3 9c3 0 3-2 6-2s3 2 6 2 3-2 6-2" /><path d="M3 15c3 0 3-2 6-2s3 2 6 2 3-2 6-2" /></>,
  coins: <><ellipse cx="9" cy="7" rx="6" ry="2.5" /><path d="M3 7v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V7" /><path d="M9 13.5V17c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-4c0-1.4-2.7-2.5-6-2.5" /></>,
  layers: <><path d="M12 4l9 4.5-9 4.5-9-4.5z" /><path d="M3 13l9 4.5 9-4.5" /></>,
  area: <><path d="M4 4h16v16H4z" /><path d="M4 9h16M9 4v16" /></>,
  soil: <><path d="M3 9h18" /><path d="M6 13h.01M11 12h.01M16 14h.01M8 17h.01M14 18h.01M19 17h.01" /><path d="M12 9V4M12 6c1.5-1.5 3-2 5-2" /></>,
  cube: <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></>,
  sound: <><path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z" /><path d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11" /></>,
  mute: <><path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z" /><path d="M16 9.5l5 5M21 9.5l-5 5" /></>,
  reset: <><path d="M4 12a8 8 0 108-8 8.5 8.5 0 00-6 2.5L4 8.5" /><path d="M4 4v4.5h4.5" /></>,
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const filled = name === "play" || name === "cursor";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
         fill={filled ? "currentColor" : "none"} stroke="currentColor"
         strokeWidth={filled ? 1.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
      {PATHS[name]}
    </svg>
  );
}

/**
 * A number field that keeps its own text while typing and commits a clamped
 * value on blur or Enter, so half-typed numbers never reach the project.
 */
export function NumberField({ label, value, onChange, unit, min, max, step = 1, hint, id, disabled }: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  hint?: React.ReactNode;
  id?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => setText(value === null ? "" : String(value)), [value]);

  const parsed = text.trim() === "" ? null : Number(text);
  const invalid = parsed !== null && (Number.isNaN(parsed)
    || (min !== undefined && parsed < min) || (max !== undefined && parsed > max));

  function commit() {
    if (parsed === null) {
      if (value === null) return;
      setText(value === null ? "" : String(value));
      return;
    }
    if (Number.isNaN(parsed)) return setText(value === null ? "" : String(value));
    let v = parsed;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    setText(String(v));
    if (v !== value) onChange(v);
  }

  const fieldId = id ?? `f-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="field">
      <label htmlFor={fieldId}>{label}</label>
      <div className="unit-input">
        <input id={fieldId} className={`input num${invalid ? " invalid" : ""}`} inputMode="decimal"
               value={text} disabled={disabled} step={step}
               onChange={(e) => setText(e.target.value)} onBlur={commit}
               onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        {unit && <span className="unit">{unit}</span>}
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Meter({ label, value, max, format }: {
  label: string; value: number; max: number | null; format: (v: number) => string;
}) {
  const pct = max ? Math.min(value / max, 1) * 100 : 0;
  const over = max !== null && value > max + 1e-6;
  return (
    <div className="meter">
      <div className="meter-top">
        <span>{label}</span>
        <span className="num">{format(value)}{max !== null && <span className="muted"> / {format(max)}</span>}</span>
      </div>
      {max !== null && (
        <div className="meter-track" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
          <div className={`meter-fill${over ? " over" : ""}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/** The RunoffLab mark: a leaf holding a water drop. */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M5 27C5 14 12 6 27 5c0 15-8 22-22 22z" fill="var(--sprout)" />
      <path d="M5 27c5-6 10-11 17-15" stroke="var(--band)" strokeWidth="1.6" fill="none" strokeLinecap="round" opacity="0.55" />
      <path d="M17.5 13.5s4 4.3 4 7a4 4 0 01-8 0c0-2.7 4-7 4-7z" fill="#5aa6e8" stroke="var(--band)" strokeWidth="1.2" />
    </svg>
  );
}
