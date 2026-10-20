// Storm sound for the 3D replay, synthesised with the Web Audio API (no audio files).
// Rain and the water rush follow the SWMM run; alert tones mark pipes filling and
// drains flooding; thunder is atmosphere for the heaviest rain only.

type Ctor = typeof AudioContext;

export class StormAudio {
  private ctx: AudioContext;
  private master: GainNode;
  private hiss: GainNode;
  private roar: GainNode;
  private rush: GainNode;
  private brown: AudioBuffer;
  private nextDrop = 0;
  private tap: MediaStreamAudioDestinationNode | null = null;

  /** Create the audio graph. Call from a click handler so the browser allows sound. */
  static create(): StormAudio | null {
    const AC: Ctor | undefined = typeof window === "undefined" ? undefined
      : window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
    return AC ? new StormAudio(new AC()) : null;
  }

  private constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    const white = noiseBuffer(ctx, "white"), brown = noiseBuffer(ctx, "brown");
    this.brown = brown;

    // Rain hiss: white noise kept to the 1–8 kHz band where rain on paving sits.
    this.hiss = this.loop(white, [filter(ctx, "highpass", 1000, 0.5), filter(ctx, "lowpass", 8000, 0.5)]);
    // Heavy-rain roar: low rumble that only comes up in a downpour.
    this.roar = this.loop(brown, [filter(ctx, "lowpass", 420, 0.6)]);
    // Water rushing through the drains and out of the outfall, with a slow gurgle.
    const gurgle = filter(ctx, "bandpass", 320, 1.4);
    this.rush = this.loop(brown, [filter(ctx, "highpass", 80, 0.7), gurgle]);
    const lfo = ctx.createOscillator(), depth = ctx.createGain();
    lfo.frequency.value = 0.8;
    depth.gain.value = 140;
    lfo.connect(depth).connect(gurgle.frequency);
    lfo.start();
  }

  private loop(buffer: AudioBuffer, chain: AudioNode[]): GainNode {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = Math.random() * buffer.duration * 0.5; // so layers sharing a buffer don't phase
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    [src, ...chain, gain].reduce((a, b) => (a.connect(b), b));
    gain.connect(this.master);
    src.start(0, src.loopStart);
    return gain;
  }

  get running() { return this.ctx.state === "running"; }

  async setEnabled(on: boolean) {
    const t = this.ctx.currentTime;
    if (on) await this.ctx.resume();
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(on ? 0.9 : 0, t, 0.15);
  }

  /** `rain` and `flow` are 0–1 shares of this run's peaks. */
  setLevels(rain: number, flow: number) {
    const t = this.ctx.currentTime;
    this.hiss.gain.setTargetAtTime(0.32 * Math.sqrt(rain), t, 0.25);
    this.roar.gain.setTargetAtTime(0.5 * Math.max(rain - 0.45, 0) ** 1.5, t, 0.4);
    this.rush.gain.setTargetAtTime(0.55 * Math.sqrt(flow), t, 0.35);
    // Single drops ticking on hard surfaces, clearest in light rain.
    if (rain > 0.02 && t >= this.nextDrop) {
      this.drop(0.05 + 0.08 * (1 - rain));
      this.nextDrop = t + 0.02 + Math.random() * 0.25 / (0.2 + rain);
    }
  }

  private drop(volume: number) {
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    const f = 1400 + Math.random() * 2400;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.05);
    g.gain.setValueAtTime(volume, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.07);
  }

  /** A soft two-note tone: rising for a pipe running full, falling for a drain flooding. */
  alert(kind: "pipe" | "flood") {
    const t = this.ctx.currentTime;
    const notes = kind === "pipe" ? [659.3, 880] : [523.3, 392];
    notes.forEach((f, i) => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = "triangle";
      o.frequency.value = f;
      const at = t + i * 0.16;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.16, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
      o.connect(g).connect(this.master);
      o.start(at);
      o.stop(at + 0.55);
    });
  }

  /** Rolling thunder after `delay` seconds; `near` 0–1 makes it louder and sharper. */
  thunder(delay: number, near: number) {
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource(), lp = filter(this.ctx, "lowpass", 140 + 260 * near, 0.7);
    const g = this.ctx.createGain();
    src.buffer = this.brown;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5 + 0.5 * near, t + 0.08 + 0.3 * (1 - near));
    g.gain.setTargetAtTime(0.25, t + 0.5, 0.4); // the roll
    g.gain.setTargetAtTime(0, t + 1.6, 0.9);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t, Math.random() * 2);
    src.stop(t + 6);
  }

  /** The mixed output as a stream, for recording the replay with sound. */
  stream(): MediaStream {
    if (!this.tap) {
      this.tap = this.ctx.createMediaStreamDestination();
      this.master.connect(this.tap);
    }
    return this.tap.stream;
  }

  dispose() { void this.ctx.close(); }
}

function filter(ctx: AudioContext, type: BiquadFilterType, frequency: number, Q: number) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = Q;
  return f;
}

/** Four seconds of white or brown (integrated, deeper) noise. */
function noiseBuffer(ctx: AudioContext, kind: "white" | "brown") {
  const n = ctx.sampleRate * 4, buf = ctx.createBuffer(1, n, ctx.sampleRate), data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === "white") data[i] = w;
    else { last = (last + 0.02 * w) / 1.02; data[i] = last * 3.5; }
  }
  return buf;
}
