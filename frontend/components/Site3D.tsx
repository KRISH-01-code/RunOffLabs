"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { hhmm, num } from "@/lib/format";
import {
  BUILDING_HEIGHT_M, buildSiteScene, createRain, groundHeightAt, PIPE_SCALE, readPalette, sample,
  type Palette, type PickInfo, type Rain, type SceneLabel, type SiteScene, type StormScales, stormScales,
} from "@/lib/scene3d";
import { LID_ORDER, LIDS } from "@/lib/lids";
import { StormAudio } from "@/lib/stormAudio";
import type { Design, Project, SimulationResult, SurfaceKind, TimeSeries } from "@/lib/types";
import { activeWindow, type Series } from "./charts/StormChart";
import { PauseIcon, RainStrip } from "./PlaybackCard";
import type { RunOutput } from "./ResultsPanel";
import { KIND_LABEL } from "./SiteEditor";
import { Icon } from "./ui";

type Mode = "site" | "storm";
type ViewPreset = "orbit" | "top" | "low";
const SPEEDS = [{ label: "1×", stepsPerSec: 6 }, { label: "3×", stepsPerSec: 18 }];
const SOUND_KEY = "runofflab.sound";
/**
 * Rain on an absolute scale, so a drizzle looks and sounds like one whatever the run's peak:
 * 2 mm/h ≈ 0.18, 15 mm/h = 0.5, 60 mm/h and above = 1.
 */
const rainStrength = (mmPerHour: number) => Math.min(Math.sqrt(Math.max(mmPerHour, 0) / 60), 1);
const LIGHTNING_AT = rainStrength(25); // only in heavy, thunderstorm-strength rain
const SUN = 2.2, HEMI = 1.6; // daylight in both themes; dark mode darkens materials and sky, not the sun

/** What the render loop needs from React to play the storm; kept in a ref so the loop never restarts. */
interface Playback {
  result: SimulationResult | null;
  scales: StormScales | null;
  i0: number;
  i1: number;
  playing: boolean;
  stepsPerSec: number;
  orbit: boolean;
}

/** A replay being recorded: each frame is drawn onto `canvas` with a caption, and that is captured. */
interface Recording {
  recorder: MediaRecorder;
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  chunks: Blob[];
  title: string;
  subtitle: string;
  file: string;
}

interface Ctx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
}

/**
 * The site in 3D: the same surfaces, green infrastructure and drains as the plan,
 * plus the pipes underground. With a run, it replays the SWMM storm step by step.
 */
export default function Site3D({ project, design, run, stale, selectedId, onSelect, onRun, canRun, running }: {
  project: Project;
  design: Design | null;
  run: RunOutput | null;
  stale: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRun: () => void;
  canRun: boolean;
  running: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<Ctx | null>(null);
  const siteRef = useRef<SiteScene | null>(null);
  const rainRef = useRef<Rain | null>(null);
  const rainLevel = useRef(0);
  const labelEls = useRef(new Map<string, HTMLSpanElement>());
  const [glError, setGlError] = useState<string | null>(null);
  const [palette, setPalette] = useState<Palette | null>(null);
  const [labels, setLabels] = useState<SceneLabel[]>([]);
  const [hover, setHover] = useState<{ info: PickInfo; x: number; y: number } | null>(null);
  const [mode, setMode] = useState<Mode>("site");
  const [which, setWhich] = useState<"baseline" | "proposed">("proposed");
  const [xray, setXray] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [orbit, setOrbit] = useState(true);
  const [sound, setSound] = useState(false);
  const audioRef = useRef<StormAudio | null>(null);
  const recRef = useRef<Recording | null>(null);
  const [recording, setRecording] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const paletteRef = useRef<Palette | null>(null);

  // A run that finishes while this view is open switches straight to the replay.
  const lastRun = useRef(run);
  useEffect(() => {
    if (run && run !== lastRun.current) setMode("storm");
    lastRun.current = run;
  }, [run]);

  const storm = mode === "storm" && run !== null;
  const showProposed = storm && which === "proposed" && run.proposed !== null;
  const result: SimulationResult | null = storm ? (showProposed ? run.proposed : run.baseline) : null;
  // In replay, draw the site exactly as it was simulated, not the latest edits.
  const sceneSite = storm ? run.project.site : project.site;
  const sceneDesign = storm ? (showProposed ? run.design : null) : design;

  // ── Storm timeline ──────────────────────────────────────────────────────
  const series: Series[] = useMemo(() => run ? [
    { key: "baseline", label: "Baseline", color: "", result: run.baseline },
    ...(run.proposed ? [{ key: "proposed", label: "Proposed", color: "", result: run.proposed }] : []),
  ] : [], [run]);
  const [i0, i1] = series.length ? activeWindow(series) : [0, 0];
  const scales = useMemo(() => series.length ? stormScales(series.map((s) => s.result)) : null, [series]);
  const [step, setStep] = useState(i0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0);
  // The playhead is a fractional step advanced by the render loop, so water moves smoothly
  // between SWMM's 5-minute reports; `step` follows it for the controls and readout.
  const playhead = useRef(i0);
  const playback = useRef<Playback>({ result: null, scales: null, i0: 0, i1: 0, playing: false, stepsPerSec: 6, orbit: true });
  playback.current = { result, scales, i0, i1, playing, stepsPerSec: SPEEDS[speed].stepsPerSec, orbit };
  const seek = (t: number) => { playhead.current = t; setStep(Math.floor(t)); };

  useEffect(() => { seek(i0); setPlaying(false); }, [i0, i1, run]);

  // ── Sound ───────────────────────────────────────────────────────────────
  useEffect(() => {
    try { setSound(localStorage.getItem(SOUND_KEY) === "on"); } catch { /* storage unavailable */ }
    return () => { audioRef.current?.dispose(); audioRef.current = null; };
  }, []);
  /** Browsers only start audio from a click, so the engine is created on the first one. */
  const ensureAudio = (on: boolean) => {
    if (on && !audioRef.current) audioRef.current = StormAudio.create();
    void audioRef.current?.setEnabled(on);
  };
  const toggleSound = () => {
    const on = !sound;
    setSound(on);
    ensureAudio(on);
    try { localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch { /* storage unavailable */ }
  };
  // ── Recording ───────────────────────────────────────────────────────────
  const startRecording = () => {
    const ctx = ctxRef.current;
    setRecError(null);
    if (!ctx || !run || typeof MediaRecorder === "undefined") {
      setRecError("This browser can’t record video. Try Chrome, Edge, Firefox or Safari 14.1+.");
      return;
    }
    const src = ctx.renderer.domElement;
    const scale = Math.min(1, 1600 / src.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round((src.width * scale) / 2) * 2;
    canvas.height = Math.round((src.height * scale) / 2) * 2;
    const g = canvas.getContext("2d");
    if (!g) return setRecError("Couldn’t start the recorder.");
    const stream = canvas.captureStream(30);
    if (sound) {
      ensureAudio(true);
      audioRef.current?.stream().getAudioTracks().forEach((track) => stream.addTrack(track));
    }
    const mime = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
      .find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 8_000_000 });
    const scenario = showProposed ? run.design?.name ?? "Proposed design" : "Baseline (no green infrastructure)";
    const rec: Recording = {
      recorder, canvas, g, chunks: [],
      title: `${run.project.site.name} · ${scenario}`,
      subtitle: `${run.scenarioLabel} · EPA SWMM ${run.baseline.engine.swmm_version}`,
      file: `runofflab-${run.project.id}-${showProposed ? run.design?.id ?? "design" : "baseline"}.${(recorder.mimeType || mime).includes("mp4") ? "mp4" : "webm"}`,
    };
    recorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
    recorder.onstop = () => {
      stream.getVideoTracks().forEach((track) => track.stop()); // the audio tap is reused, so leave it running
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(rec.chunks, { type: recorder.mimeType || "video/webm" }));
      a.download = rec.file;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
    recRef.current = rec;
    seek(i0);
    setPlaying(true);
    recorder.start(250);
    setRecording(true);
  };
  const stopRecording = () => {
    const rec = recRef.current;
    recRef.current = null;
    setRecording(false);
    if (rec && rec.recorder.state !== "inactive") rec.recorder.stop();
  };
  // The recording ends with the replay (or when it's paused).
  useEffect(() => { if (recording && !playing) stopRecording(); }, [recording, playing]);
  useEffect(() => () => { if (recRef.current) stopRecording(); }, []);

  useEffect(() => {
    const onVis = () => void audioRef.current?.setEnabled(sound && !document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [sound]);

  // ── Renderer (created once) ─────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch {
      setGlError("Your browser couldn’t start WebGL, which the 3D view needs. The plan editor still works.");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.setAttribute("aria-hidden", "true");
    host.prepend(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 3000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.zoomToCursor = true; // scroll zooms toward what's under the pointer, not the centre
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.minDistance = 8;
    controls.maxDistance = 900;
    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a7a, HEMI);
    const sun = new THREE.DirectionalLight(0xffffff, SUN);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.0005;
    scene.add(hemi, sun, sun.target);
    scene.fog = new THREE.Fog(0xffffff, 400, 2000);
    ctxRef.current = { renderer, scene, camera, controls, sun, hemi };

    const resize = () => {
      const w = host.clientWidth, h = host.clientHeight;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const v = new THREE.Vector3();
    // Alert tones when a pipe starts running full or a drain starts flooding.
    const alertOnChanges = (ts: TimeSeries, from: number, to: number) => {
      const audio = audioRef.current;
      if (!audio || from < 0) return;
      const starts = (series: Record<string, number[]>, limit: number) =>
        Object.values(series).some((v) => (v[from] ?? 0) < limit && (v[to] ?? 0) >= limit);
      if (starts(ts.pipe_capacity, 0.999)) audio.alert("pipe");
      else if (starts(ts.node_flooding_m3s, 1e-6)) audio.alert("flood");
    };
    const sky = new THREE.Color(), stormSky = new THREE.Color(), white = new THREE.Color(0xffffff);
    let frame = 0, last = performance.now(), flash = 0, nextBolt = 0, lastStep = -1, lastSound = 0;
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const pb = playback.current, built = siteRef.current, pal = paletteRef.current;
      const ts = pb.result?.series;

      // Advance the storm.
      if (pb.playing && ts) {
        playhead.current = Math.min(playhead.current + dt * pb.stepsPerSec, pb.i1);
        if (playhead.current >= pb.i1) setPlaying(false);
      }
      const t = playhead.current;
      const whole = Math.floor(t);
      if (whole !== lastStep) {
        if (ts && pb.playing && whole === lastStep + 1) alertOnChanges(ts, lastStep, whole);
        lastStep = whole;
        setStep(whole);
      }
      built?.applyStep(pb.result, t, pb.scales);
      const rainNow = ts ? rainStrength(sample(ts.rainfall_mm_hr, t)) : 0;
      rainLevel.current += (rainNow - rainLevel.current) * Math.min(dt * 4, 1);
      const rain = rainLevel.current;
      const flow = ts && pb.scales ? Math.min(sample(ts.outfall_m3s, t) / pb.scales.outflow, 1) : 0;

      const motion = reduceMotion ? 0 : dt;
      built?.tick(motion, rain);
      rainRef.current?.update(motion, rain);

      // Atmosphere: the sky darkens with the rain, with lightning in the heaviest bursts.
      // A burst of heavy rain brings a strike within a moment; then at most one every 4–9 s.
      if (pb.playing && !reduceMotion && rainNow > LIGHTNING_AT && now > nextBolt) {
        flash = 1;
        nextBolt = now + 4000 + Math.random() * 5000;
        audioRef.current?.thunder(0.4 + Math.random() * 1.6, rainNow);
      }
      flash = Math.max(flash - dt * 5, 0);
      if (pal) {
        sky.set(pal.sky).lerp(stormSky.set(pal.storm), 0.75 * rain).lerp(white, 0.45 * flash);
        (scene.background as THREE.Color | null)?.copy(sky);
        scene.fog!.color.copy(sky);
      }
      const span = built ? Math.max(built.bounds.width, built.bounds.depth) : 200;
      (scene.fog as THREE.Fog).near = span * (2.5 - 1.6 * rain);
      (scene.fog as THREE.Fog).far = span * (8 - 5 * rain);
      sun.intensity = SUN * (1 - 0.6 * rain) + 4 * flash;
      hemi.intensity = HEMI * (1 - 0.35 * rain) + 2 * flash;

      if (audioRef.current && now - lastSound > 100) {
        audioRef.current.setLevels(rain, flow);
        lastSound = now;
      }
      controls.autoRotate = pb.playing && pb.orbit && !reduceMotion;
      controls.autoRotateSpeed = 0.5;
      controls.update();
      renderer.render(scene, camera);
      const rec = recRef.current;
      if (rec) drawFrame(rec, renderer.domElement, ts ? {
        clock: hhmm(Math.round(sample(ts.minutes, t))),
        rain: sample(ts.rainfall_mm_hr, t), out: sample(ts.outfall_m3s, t),
      } : null);
      // Pin the HTML labels to their 3D anchors, hiding ones that collide or fall behind the camera.
      const w = host.clientWidth, h = host.clientHeight;
      const placed: DOMRect[] = [];
      for (const label of siteRef.current?.labels ?? []) {
        const el = labelEls.current.get(label.id);
        if (!el) continue;
        v.copy(label.position).project(camera);
        const x = (v.x + 1) / 2 * w, y = (1 - v.y) / 2 * h;
        const lw = el.offsetWidth, lh = el.offsetHeight;
        const box = new DOMRect(x - lw / 2, y - lh / 2, lw, lh);
        const visible = v.z < 1 && x > 0 && x < w && y > 0 && y < h
          && !placed.some((p) => box.left < p.right && box.right > p.left && box.top < p.bottom && box.bottom > p.top);
        el.style.visibility = visible ? "visible" : "hidden";
        if (visible) {
          placed.push(box);
          el.style.transform = `translate(${box.left.toFixed(1)}px, ${box.top.toFixed(1)}px)`;
        }
      }
    };
    frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      siteRef.current?.dispose();
      siteRef.current = null;
      rainRef.current?.dispose();
      rainRef.current = null;
      renderer.dispose();
      renderer.domElement.remove();
      ctxRef.current = null;
    };
  }, []);

  // ── Theme ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const read = () => {
      if (!hostRef.current) return;
      paletteRef.current = readPalette(hostRef.current);
      setPalette(paletteRef.current);
    };
    read();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", read);
    return () => mq.removeEventListener("change", read);
  }, []);

  // ── Scene contents ──────────────────────────────────────────────────────
  const siteKey = sceneSite.width_m + "x" + sceneSite.height_m;
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx || !palette) return;
    siteRef.current?.dispose();
    if (siteRef.current) ctx.scene.remove(siteRef.current.group);
    const built = buildSiteScene(sceneSite, sceneDesign, palette);
    ctx.scene.add(built.group);
    siteRef.current = built;
    setLabels(built.labels);
    ctx.scene.background = new THREE.Color(palette.sky);
    return () => { ctx.scene.remove(built.group); };
  }, [sceneSite, sceneDesign, palette]);

  // Rain and the sun's shadow box follow the site size; the camera is framed once per size.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx || !palette) return;
    const { width_m: w, height_m: d } = sceneSite;
    const span = Math.max(w, d);
    ctx.sun.position.set(-0.35 * span, 0.9 * span, -0.55 * span);
    const cam = ctx.sun.shadow.camera;
    cam.left = cam.bottom = -1.25 * span; // wide enough for the trees around the site
    cam.right = cam.top = 1.25 * span;
    cam.near = 1;
    cam.far = 3.5 * span;
    cam.updateProjectionMatrix();
    const rain = createRain(w, d, palette.water, 7000, groundHeightAt(sceneSite));
    ctx.scene.add(rain.object);
    rainRef.current = rain;
    return () => { ctx.scene.remove(rain.object); rain.dispose(); rainRef.current = null; };
  }, [siteKey, sceneSite, palette]);

  const setView = (preset: ViewPreset) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const { width_m: w, height_m: d } = sceneSite;
    // Back off far enough that the whole site fits the frame, whichever way the stage is shaped.
    const radius = Math.hypot(w, d) / 2;
    const vFov = THREE.MathUtils.degToRad(ctx.camera.fov) / 2;
    const hFov = Math.atan(Math.tan(vFov) * ctx.camera.aspect);
    const dist = radius / Math.sin(Math.min(vFov, hFov)) * 0.74;
    const dir = preset === "top" ? new THREE.Vector3(0, 1, 0.001)
      : preset === "low" ? new THREE.Vector3(-0.55, 0.2, 0.8) : new THREE.Vector3(0.45, 0.62, 0.65);
    ctx.controls.target.set(0, preset === "low" ? 2 : 0, 0);
    ctx.camera.position.copy(dir.normalize().multiplyScalar(preset === "low" ? dist * 0.75 : dist));
    ctx.camera.updateProjectionMatrix();
  };
  useEffect(() => { setView("orbit"); }, [siteKey]);

  useEffect(() => { siteRef.current?.setXray(xray); }, [xray, labels]);


  // ── Picking ─────────────────────────────────────────────────────────────
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const pickAt = (e: React.PointerEvent): PickInfo | null => {
    const ctx = ctxRef.current, built = siteRef.current;
    if (!ctx || !built) return null;
    const r = ctx.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, ctx.camera);
    // In X-ray the ground is see-through, so let the pointer reach the pipes beneath it.
    const hit = raycaster.intersectObjects(built.pickables, false).find((h) => !(xray && h.object.userData.ground));
    return (hit?.object.userData.info as PickInfo | undefined) ?? null;
  };
  const down = useRef<{ x: number; y: number } | null>(null);

  // ── Status ──────────────────────────────────────────────────────────────
  const ts = result?.series;
  const outflow = ts?.outfall_m3s[step] ?? 0;
  const fullPipes = ts ? sceneSite.pipes.filter((p) => (ts.pipe_capacity[p.id]?.[step] ?? 0) >= 0.999) : [];
  const nearFull = ts ? sceneSite.pipes.filter((p) => { const c = ts.pipe_capacity[p.id]?.[step] ?? 0; return c >= 0.9 && c < 0.999; }) : [];
  const flooding = ts ? sceneSite.inlets.filter((i) => (ts.node_flooding_m3s[i.id]?.[step] ?? 0) > 1e-6) : [];
  const items = sceneDesign?.interventions ?? [];
  const kinds = (Object.keys(KIND_LABEL) as SurfaceKind[]).filter((k) => sceneSite.surfaces.some((s) => s.kind === k));
  const summary = storm && ts
    ? `${showProposed ? "Proposed design" : "Baseline"} at ${hhmm(ts.minutes[step])}: ${num(outflow, 3)} cubic metres per second leaving the site, ${fullPipes.length} pipes full, ${flooding.length} drains flooding.`
    : `3D model of ${sceneSite.name}: ${sceneSite.surfaces.length} surfaces, ${items.length} green infrastructure features and ${sceneSite.pipes.length} pipes.`;

  return (
    <section className="card view3d" aria-labelledby="h-3d">
      <div className="card-head view3d-toolbar">
        <h2 id="h-3d"><Icon name="cube" size={16} />3D view</h2>
        <div className="segmented" aria-label="What to show">
          <button aria-pressed={mode === "site"} onClick={() => setMode("site")}>Site</button>
          <button aria-pressed={mode === "storm"} disabled={!run} onClick={() => setMode("storm")}
                  title={run ? "Replay the last SWMM run" : "Run a simulation first"}>Storm replay</button>
        </div>
        {storm && run.proposed && (
          <div className="segmented" aria-label="Scenario">
            <button aria-pressed={which === "baseline"} onClick={() => setWhich("baseline")}>Baseline</button>
            <button aria-pressed={which === "proposed"} onClick={() => setWhich("proposed")}>{run.design?.name ?? "Proposed"}</button>
          </div>
        )}
        <span className="spacer" style={{ flex: 1 }} />
        <label className="check"><input type="checkbox" checked={xray} onChange={(e) => setXray(e.target.checked)} />X-ray (show pipes)</label>
        <label className="check"><input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />Labels</label>
        {storm && <label className="check" title="Slowly circle the site while the storm plays"><input type="checkbox" checked={orbit} onChange={(e) => setOrbit(e.target.checked)} />Auto-orbit</label>}
        <button className="btn sm" aria-pressed={sound} onClick={toggleSound} title={sound ? "Turn storm sound off" : "Turn storm sound on"}>
          <Icon name={sound ? "sound" : "mute"} size={14} /> Sound {sound ? "on" : "off"}
        </button>
        <div className="segmented" aria-label="Camera">
          <button onClick={() => setView("orbit")} title="Angled view of the whole site">Overview</button>
          <button onClick={() => setView("top")} title="Straight down, like the plan">Top</button>
          <button onClick={() => setView("low")} title="Low angle from the south-west corner">Low angle</button>
        </div>
      </div>

      {mode === "storm" && stale && (
        <div className="view3d-note" role="status">
          <Icon name="warn" size={14} /> Replaying the design as it was last run. Your newer edits aren’t in this replay.
          <button className="btn sm" disabled={!canRun} onClick={onRun}>{running ? <span className="spinner" /> : <Icon name="play" size={12} />} Run again</button>
        </div>
      )}

      <div className="view3d-stage" ref={hostRef}
           onPointerDown={(e) => { down.current = { x: e.clientX, y: e.clientY }; }}
           onPointerMove={(e) => {
             if (e.buttons) { setHover(null); return; }
             const info = pickAt(e);
             const r = hostRef.current!.getBoundingClientRect();
             setHover(info ? { info, x: e.clientX - r.left, y: e.clientY - r.top } : null);
           }}
           onPointerLeave={() => setHover(null)}
           onPointerUp={(e) => {
             const d = down.current;
             down.current = null;
             if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || storm) return;
             const info = pickAt(e);
             onSelect(info?.interventionId ?? null);
           }}>
        <div role="img" aria-label={summary} className="view3d-a11y" />
        {glError && <div className="empty-state"><Icon name="alert" size={24} /><p>{glError}</p></div>}
        {showLabels && (
          <div className="view3d-labels" aria-hidden="true">
            {labels.map((l) => (
              <span key={l.id} ref={(el) => { if (el) labelEls.current.set(l.id, el); else labelEls.current.delete(l.id); }}
                    className={`view3d-label ${l.kind}${l.id === selectedId ? " selected" : ""}`}>{l.text}</span>
            ))}
          </div>
        )}
        {hover && (
          <div className="view3d-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
            <strong>{hover.info.title}</strong>
            <span>{hover.info.detail}</span>
            {hover.info.interventionId && !storm && <span className="muted">Click to select</span>}
          </div>
        )}
        {storm && ts && (
          <div className="view3d-readout num" aria-hidden="true">
            <strong>{hhmm(ts.minutes[step])}</strong>
            <span>rain {num(ts.rainfall_mm_hr[step] ?? 0, 1)} mm/h</span>
            <span>{num(outflow, 3)} m³/s leaving</span>
          </div>
        )}
        <div className="view3d-hint small" aria-hidden="true">Drag to orbit · right-drag to pan · scroll to zoom</div>
      </div>

      {storm && ts ? (
        <div className="card-body playback">
          <div className="playback-controls view3d-controls">
            <button className="btn primary icon" aria-label={playing ? "Pause" : "Play"}
                    onClick={() => { ensureAudio(sound); if (!playing && step >= i1) seek(i0); setPlaying((p) => !p); }}>
              {playing ? <PauseIcon /> : <Icon name="play" size={14} />}
            </button>
            <div className="playback-scrub">
              <RainStrip values={ts.rainfall_mm_hr.slice(i0, i1 + 1)} cursor={step - i0} />
              <input type="range" min={i0} max={i1} value={step} aria-label="Time step"
                     aria-valuetext={`${hhmm(ts.minutes[step])} after storm start`}
                     onChange={(e) => { setPlaying(false); seek(+e.target.value); }} />
            </div>
            <div className="segmented" aria-label="Speed">
              {SPEEDS.map((s, i) => <button key={s.label} aria-pressed={speed === i} onClick={() => setSpeed(i)}>{s.label}</button>)}
            </div>
            <button className={`btn sm${recording ? " rec-on" : ""}`} onClick={recording ? stopRecording : startRecording}
                    title={recording ? "Stop and download the video" : `Record the replay from the start${sound ? ", with sound," : ""} and download it as a video`}>
              <span className="rec-dot" aria-hidden="true" />{recording ? "Stop & save" : "Record video"}
            </button>
          </div>
          {recError && <p className="small" style={{ color: "var(--bad-ink)" }}>{recError}</p>}
          <div className="small playback-status" aria-live="polite">
            {fullPipes.length > 0 && <span style={{ color: "var(--bad-ink)" }}><Icon name="alert" size={12} /> {fullPipes.map((p) => p.id).join(", ")} full</span>}
            {nearFull.length > 0 && <span><Icon name="warn" size={12} /> {nearFull.map((p) => p.id).join(", ")} over 90 % full</span>}
            {fullPipes.length === 0 && nearFull.length === 0 && <span className="muted">All pipes below 90 % full</span>}
            {flooding.length > 0 && <span style={{ color: "var(--bad-ink)" }}>· {flooding.map((i) => i.id).join(", ")} flooding</span>}
          </div>
          <div className="legend">
            <span><span className="swatch" style={{ background: "var(--water)", opacity: 0.7 }} />Runoff on a surface (fainter = less)</span>
            <span><span className="line-key" style={{ background: "var(--pipe)", height: 4 }} />Pipe flowing</span>
            <span><span className="line-key" style={{ background: "var(--warning)", height: 4 }} /><Icon name="warn" size={12} />Pipe ≥ 90 % full</span>
            <span><span className="line-key" style={{ background: "var(--critical)", height: 4 }} /><Icon name="alert" size={12} />Pipe full</span>
            <span><span className="dot" style={{ background: "var(--water)" }} />Pool at a flooding drain</span>
          </div>
        </div>
      ) : (
        <div className="card-body view3d-foot">
          <div className="legend" aria-label="3D legend">
            {kinds.map((k) => <span key={k}><span className="swatch" style={{ background: `var(--kind-${k})` }} />{KIND_LABEL[k]}</span>)}
            {LID_ORDER.filter((k) => k === "rain_garden" || k === "permeable_pavement" || items.some((i) => i.kind === k)).map((k) => (
              <span key={k}><span className="swatch" style={{ background: LIDS[k].fill }} />{LIDS[k].label}</span>
            ))}
            <span><span className="line-key" style={{ background: "var(--pipe)", height: 4 }} />Pipe</span>
          </div>
          {!run && (
            <button className="btn sm" disabled={!canRun} onClick={onRun}>
              {running ? <span className="spinner" /> : <Icon name="play" size={12} />} Run to replay the storm in 3D
            </button>
          )}
        </div>
      )}
      <p className="small muted view3d-notes">
        Buildings are drawn {BUILDING_HEIGHT_M} m tall for illustration; the model has no heights.
        Pipes are drawn {PIPE_SCALE}× their real diameter at depths from the drain elevations. Ground is shown flat.
        {" The ground, trees and channel beyond the boundary are scenery."}
        {storm && " Water, runoff paths, pipe flow and spray follow the SWMM time series of this run; the sky, lightning and thunder are atmosphere."}
      </p>
    </section>
  );
}

/** One video frame: the 3D view, a caption at the top and the storm clock in the corner. */
function drawFrame(rec: Recording, src: HTMLCanvasElement, now: { clock: string; rain: number; out: number } | null) {
  const { g, canvas } = rec;
  const w = canvas.width, h = canvas.height, u = w / 1280; // 1 unit = 1 px at 1280 wide
  g.drawImage(src, 0, 0, w, h);
  g.textBaseline = "top";
  const font = (weight: number, size: number) => `${weight} ${Math.round(size * u)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const panel = (x: number, y: number, pw: number, ph: number) => {
    g.fillStyle = "rgba(10, 24, 16, 0.62)";
    g.beginPath();
    g.roundRect(x, y, pw, ph, 10 * u);
    g.fill();
  };
  g.font = font(650, 22);
  const tw = Math.max(g.measureText(rec.title).width, (g.font = font(400, 15), g.measureText(rec.subtitle).width));
  panel(20 * u, 20 * u, tw + 36 * u, 70 * u);
  g.fillStyle = "#ffffff";
  g.font = font(650, 22);
  g.fillText(rec.title, 38 * u, 32 * u);
  g.fillStyle = "rgba(255,255,255,0.78)";
  g.font = font(400, 15);
  g.fillText(rec.subtitle, 38 * u, 62 * u);
  if (now) {
    panel(20 * u, h - 112 * u, 230 * u, 92 * u);
    g.fillStyle = "#ffffff";
    g.font = font(700, 34);
    g.fillText(now.clock, 38 * u, h - 102 * u);
    g.font = font(500, 15);
    g.fillStyle = "rgba(255,255,255,0.85)";
    g.fillText(`rain ${num(now.rain, 1)} mm/h`, 38 * u, h - 60 * u);
    g.fillText(`${num(now.out, 3)} m³/s leaving the site`, 38 * u, h - 40 * u);
  }
  g.font = font(600, 14);
  g.textAlign = "right";
  g.fillStyle = "rgba(255,255,255,0.9)";
  g.fillText("RunoffLab", w - 24 * u, h - 34 * u);
  g.textAlign = "left";
}
