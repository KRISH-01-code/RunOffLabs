"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { hhmm, num } from "@/lib/format";
import type { Design, SimulationResult, Site } from "@/lib/types";
import { LIDS } from "@/lib/lids";
import { activeWindow, type Series } from "./charts/StormChart";
import { Icon } from "./ui";

const SPEEDS = [{ label: "1×", stepsPerSec: 6 }, { label: "3×", stepsPerSec: 18 }];

/**
 * Replays the storm on the site plan, one 5-minute report step at a time.
 * Every value shown is read from the SWMM time series of each run.
 */
export default function PlaybackCard({ site, baseline, proposed, design, label }: {
  site: Site;
  baseline: SimulationResult;
  proposed: SimulationResult | null;
  design: Design | null;
  label: string;
}) {
  const series: Series[] = useMemo(() => [
    { key: "baseline", label: "Baseline", color: "", result: baseline },
    ...(proposed ? [{ key: "proposed", label, color: "", result: proposed }] : []),
  ], [baseline, proposed, label]);
  const [range, setRange] = useState<"peak" | "full">("peak");
  const [i0, i1] = range === "peak" ? activeWindow(series) : [0, baseline.series.minutes.length - 1];
  const [step, setStep] = useState(i0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0);

  useEffect(() => { setStep(i0); setPlaying(false); }, [i0, i1, baseline, proposed]);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setStep((s) => Math.min(s + 1, i1)), 1000 / SPEEDS[speed].stepsPerSec);
    return () => clearInterval(t);
  }, [playing, speed, i1]);
  useEffect(() => { if (playing && step >= i1) setPlaying(false); }, [playing, step, i1]);

  // One colour scale for both maps so they compare fairly.
  const maxIntensity = useMemo(() => Math.max(1e-9, ...series.flatMap((s) => s.result.surfaces.map((sr) =>
    Math.max(...s.result.series.surface_runoff_m3s[sr.surface_id] ?? [0]) / Math.max(sr.modelled_area_m2, 1)))), [series]);

  const ts = baseline.series;
  const rain = ts.rainfall_mm_hr[step] ?? 0;

  return (
    <section className="card" aria-labelledby="h-playback">
      <div className="card-head" style={{ flexWrap: "wrap" }}>
        <h3 id="h-playback"><Icon name="rain" size={16} />Storm playback</h3>
        <span className="spacer" style={{ flex: 1 }} />
        <div className="segmented" aria-label="Time range">
          <button aria-pressed={range === "peak"} onClick={() => setRange("peak")}>Peak</button>
          <button aria-pressed={range === "full"} onClick={() => setRange("full")}>Full storm</button>
        </div>
        <div className="segmented" aria-label="Speed">
          {SPEEDS.map((s, i) => <button key={s.label} aria-pressed={speed === i} onClick={() => setSpeed(i)}>{s.label}</button>)}
        </div>
      </div>
      <div className="card-body playback">
        <div className="playback-controls">
          <button className="btn primary icon" aria-label={playing ? "Pause" : "Play"}
                  onClick={() => { if (!playing && step >= i1) setStep(i0); setPlaying((p) => !p); }}>
            {playing ? <PauseIcon /> : <Icon name="play" size={14} />}
          </button>
          <div className="playback-scrub">
            <RainStrip values={ts.rainfall_mm_hr.slice(i0, i1 + 1)} cursor={step - i0} />
            <input type="range" min={i0} max={i1} value={step} aria-label="Time step"
                   aria-valuetext={`${hhmm(ts.minutes[step])} after storm start`}
                   onChange={(e) => { setPlaying(false); setStep(+e.target.value); }} />
          </div>
          <div className="playback-clock" aria-live="off">
            <strong className="num">{hhmm(ts.minutes[step])}</strong>
            <span className="small muted num">rain {num(rain, 1)} mm/h</span>
          </div>
        </div>

        <div className={`playback-maps${proposed ? "" : " single"}`}>
          {series.map((s) => (
            <PlaybackMap key={s.key} site={site} result={s.result} step={step} maxIntensity={maxIntensity}
                         design={s.key === "proposed" ? design : null} title={s.label} />
          ))}
        </div>

        <div className="legend playback-legend">
          <span><span className="ramp" aria-hidden="true" />Runoff from each surface (light → heavy)</span>
          <span><span className="line-key" style={{ background: "var(--pipe)", height: 4 }} />Pipe flowing</span>
          <span><span className="line-key" style={{ background: "var(--warning)", height: 4 }} /><Icon name="warn" size={12} />Pipe ≥ 90 % full</span>
          <span><span className="line-key" style={{ background: "var(--critical)", height: 4 }} /><Icon name="alert" size={12} />Pipe full</span>
          <span><span className="dot" style={{ border: "2px solid var(--critical)", background: "transparent" }} />Drain flooding</span>
        </div>
      </div>
    </section>
  );
}

function PlaybackMap({ site, result, step, maxIntensity, design, title }: {
  site: Site; result: SimulationResult; step: number; maxIntensity: number; design: Design | null; title: string;
}) {
  const uid = useId().replace(/:/g, "");
  const s = result.series;
  const pad = 3;
  const nodes = new Map<string, { x: number; y: number }>([
    ...site.inlets.map((i) => [i.id, { x: i.x, y: i.y }] as const),
    [site.outfall.id, { x: site.outfall.x, y: site.outfall.y }],
  ]);
  const area = new Map(result.surfaces.map((x) => [x.surface_id, Math.max(x.modelled_area_m2, 1)]));
  const outflow = s.outfall_m3s[step] ?? 0;
  const flooding = site.inlets.filter((i) => (s.node_flooding_m3s[i.id]?.[step] ?? 0) > 1e-6);
  const fullPipes = site.pipes.filter((p) => (s.pipe_capacity[p.id]?.[step] ?? 0) >= 0.999);
  const nearFull = site.pipes.filter((p) => { const c = s.pipe_capacity[p.id]?.[step] ?? 0; return c >= 0.9 && c < 0.999; });

  return (
    <figure className="playback-map">
      <figcaption>
        <span className="playback-title">{title}</span>
        <span className="num">{num(outflow, 3)} m³/s leaving the site</span>
      </figcaption>
      <svg viewBox={`${-pad} ${-pad} ${site.width_m + 2 * pad} ${site.height_m + 2 * pad}`} role="img"
           aria-label={`${title}: ${num(outflow, 3)} cubic metres per second leaving the site; ${fullPipes.length} pipes full, ${nearFull.length} over 90 percent; ${flooding.length} drains flooding`}>
        <defs>
          <pattern id={`rg-${uid}`} patternUnits="userSpaceOnUse" width="3" height="3">
            <rect width="3" height="3" fill="var(--rg-fill)" />
            <circle cx="0.8" cy="0.9" r="0.42" fill="var(--rg-plant)" opacity="0.55" />
          </pattern>
          <pattern id={`pp-${uid}`} patternUnits="userSpaceOnUse" width="2.4" height="2.4" patternTransform="rotate(45)">
            <rect width="2.4" height="2.4" fill="var(--pp-fill)" />
            <line x1="0" y1="0" x2="0" y2="2.4" stroke="var(--pp-stroke)" strokeWidth="0.7" opacity="0.55" />
          </pattern>
        </defs>
        {site.surfaces.map((sf) => {
          const q = s.surface_runoff_m3s[sf.id]?.[step] ?? 0;
          const k = Math.min(q / (area.get(sf.id) ?? 1) / maxIntensity, 1);
          return (
            <g key={sf.id}>
              <rect x={sf.rect.x} y={sf.rect.y} width={sf.rect.width} height={sf.rect.height}
                    fill={`var(--kind-${sf.kind})`} stroke="var(--surface)" strokeWidth={0.6} />
              <rect x={sf.rect.x} y={sf.rect.y} width={sf.rect.width} height={sf.rect.height}
                    fill="var(--water)" opacity={0.85 * k} />
            </g>
          );
        })}
        {design?.interventions.map((i) => (
          <rect key={i.id} x={i.rect.x} y={i.rect.y} width={i.rect.width} height={i.rect.height}
                rx={i.kind === "rain_barrel" ? Math.min(i.rect.width, i.rect.height) / 2 : 0}
                fill={i.kind === "rain_garden" ? `url(#rg-${uid})` : i.kind === "permeable_pavement" ? `url(#pp-${uid})` : LIDS[i.kind].fill}
                stroke={LIDS[i.kind].stroke} strokeWidth={0.8} />
        ))}
        {site.pipes.map((p) => {
          const a = nodes.get(p.from_node), b = nodes.get(p.to_node);
          if (!a || !b) return null;
          const cap = s.pipe_capacity[p.id]?.[step] ?? 0;
          const color = cap >= 0.999 ? "var(--critical)" : cap >= 0.9 ? "var(--warning)" : "var(--pipe)";
          return (
            <line key={p.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeLinecap="round"
                  strokeWidth={1.5 + 5 * Math.min(cap, 1)} vectorEffect="non-scaling-stroke" />
          );
        })}
        {site.inlets.map((i) => {
          const flood = (s.node_flooding_m3s[i.id]?.[step] ?? 0) > 1e-6;
          return (
            <g key={i.id}>
              {flood && <circle cx={i.x} cy={i.y} r={5} fill="none" stroke="var(--critical)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />}
              <rect x={i.x - 1.6} y={i.y - 1.6} width={3.2} height={3.2} fill="var(--node)" stroke="var(--surface)" strokeWidth={0.6} />
            </g>
          );
        })}
        <circle cx={site.outfall.x} cy={site.outfall.y} r={2.2} fill="var(--node)" stroke="var(--surface)" strokeWidth={0.6} />
      </svg>
      <div className="small playback-status">
        {fullPipes.length > 0 && <span style={{ color: "var(--bad-ink)" }}><Icon name="alert" size={12} /> {fullPipes.map((p) => p.id).join(", ")} full</span>}
        {nearFull.length > 0 && <span><Icon name="warn" size={12} /> {nearFull.map((p) => p.id).join(", ")} over 90 % full</span>}
        {fullPipes.length === 0 && nearFull.length === 0 && <span className="muted">All pipes below 90 % full</span>}
        {flooding.length > 0 && <span style={{ color: "var(--bad-ink)" }}>· {flooding.map((i) => i.id).join(", ")} flooding</span>}
      </div>
    </figure>
  );
}

export function RainStrip({ values, cursor }: { values: number[]; cursor: number }) {
  const max = Math.max(...values, 1e-9);
  const n = values.length;
  return (
    <svg viewBox={`0 0 ${n} 20`} preserveAspectRatio="none" aria-hidden="true" className="rain-strip">
      {values.map((v, i) => (
        <rect key={i} x={i + 0.1} y={20 - (v / max) * 20} width={0.8} height={(v / max) * 20}
              fill="var(--water)" opacity={i === cursor ? 1 : i < cursor ? 0.55 : 0.25} />
      ))}
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}
