"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { num } from "@/lib/format";
import type { Action } from "@/lib/store";
import type { Project, RainRecord } from "@/lib/types";
import { Icon, NumberField } from "./ui";

const UNITS = [
  { value: "mm", label: "mm in each reading" },
  { value: "mm/h", label: "mm/h intensity" },
  { value: "in", label: "inches in each reading" },
  { value: "in/h", label: "in/h intensity" },
];

/** Which year of rainfall the year-long simulation uses: a synthetic year or an imported record. */
export default function YearRainfall({ project, dispatch }: { project: Project; dispatch: (a: Action) => void }) {
  const lt = project.long_term;
  const set = (patch: Partial<Project["long_term"]>) => dispatch({ type: "setLongTerm", patch });
  const file = useRef<HTMLInputElement>(null);
  const [units, setUnits] = useState("mm");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function importFile(f: File) {
    setBusy(true);
    setError(null);
    try {
      const record = await api.parseRainfall(await f.text(), units, f.name.replace(/\.[^.]+$/, ""));
      set({ source: "imported", record });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section" aria-labelledby="h-year">
      <h3 id="h-year">Year-long rainfall</h3>
      <p className="muted small">Used by <strong>Over a whole year</strong> in the results: every storm and dry spell in a year, not one design storm.</p>
      <div className="segmented" role="radiogroup" aria-label="Rainfall for the year">
        <button role="radio" aria-checked={lt.source === "synthetic"} aria-pressed={lt.source === "synthetic"}
                onClick={() => set({ source: "synthetic" })}>Synthetic year</button>
        <button role="radio" aria-checked={lt.source === "imported"} aria-pressed={lt.source === "imported"}
                onClick={() => set({ source: "imported" })}>Imported record</button>
      </div>

      {lt.source === "synthetic" ? (
        <>
          <NumberField label="Rain in a year" unit="mm" value={lt.annual_mm} min={100} max={5000} step={50}
                       onChange={(v) => v !== null && set({ annual_mm: v })}
                       hint="Use your location’s average annual rainfall" />
          <div className="year-row">
            <span className="small muted">Year #{lt.seed} of the random rainfall model</span>
            <button className="btn sm" onClick={() => set({ seed: lt.seed >= 10_000 ? 1 : lt.seed + 1 })}>
              <Icon name="reset" size={13} /> Try another year
            </button>
          </div>
          <p className="ref">
            Storms arrive at random, more often in the wetter season, with random lengths and intensities, scaled to your
            annual total (a Poisson rectangular-pulse model). It’s plausible weather, not a measured record. Import
            real data for decisions.
          </p>
        </>
      ) : (
        <>
          {lt.record ? <RecordSummary record={lt.record} /> : <p className="small muted">No record imported yet.</p>}
          <div className="field">
            <label htmlFor="rain-units">Values in the file are</label>
            <select id="rain-units" className="select" value={units} onChange={(e) => setUnits(e.target.value)}>
              {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
            </select>
          </div>
          <button className="btn sm" disabled={busy} onClick={() => file.current?.click()}>
            {busy ? <span className="spinner" /> : <Icon name="upload" size={13} />} {lt.record ? "Import a different CSV" : "Import a rainfall CSV"}
          </button>
          <input ref={file} type="file" accept=".csv,text/csv,text/plain" hidden aria-label="Rainfall CSV file"
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }} />
          {error && <p className="small" style={{ color: "var(--bad-ink)" }}>{error}</p>}
          <p className="ref">
            Two columns: date/time and rainfall, one row per reading (e.g. <code>2023-05-01 13:00,2.4</code>); a header row
            is fine and missing hours count as dry. Hourly station data such as NOAA’s works well. Up to two years.
          </p>
        </>
      )}
    </section>
  );
}

function RecordSummary({ record }: { record: RainRecord }) {
  const total = record.depths_mm.reduce((a, b) => a + b, 0);
  const days: number[] = [];
  for (let h = 0; h < record.depths_mm.length; h += 24) days.push(record.depths_mm.slice(h, h + 24).reduce((a, b) => a + b, 0));
  const start = new Date(record.start);
  const end = new Date(start.getTime() + record.depths_mm.length * 3_600_000);
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  return (
    <dl className="kv">
      <dt>Record</dt><dd>{record.name}</dd>
      <dt>Period</dt><dd>{fmt(start)} – {fmt(end)}</dd>
      <dt>Total rain</dt><dd>{num(total)} mm</dd>
      <dt>Rainy days (≥ 1 mm)</dt><dd>{days.filter((d) => d >= 1).length}</dd>
      <dt>Wettest day</dt><dd>{num(Math.max(...days), 1)} mm</dd>
    </dl>
  );
}
