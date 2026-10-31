// Procedural WebAudio sound effects: nothing to download or license.

export interface Spatial {
  vol?: number;
  pan?: number;
}

interface ToneOpts {
  type?: OscillatorType;
  f: number;
  f2?: number;
  dur: number;
  vol?: number;
  attack?: number;
  delay?: number;
  lp?: number;
}

interface NoiseOpts {
  dur: number;
  vol?: number;
  type?: BiquadFilterType;
  f?: number;
  f2?: number;
  q?: number;
  delay?: number;
  attack?: number;
}

const MUTE_KEY = "pvp-muted";
const MASTER = 0.6;

type BuffFamily = "movement" | "damage" | "danger" | "stealth";

// Anything not listed (bounty, swap, giants, bows, builder, ...) is the "events" family.
const BUFF_FAMILY = new Map<string, BuffFamily>([
  ["gravity", "movement"],
  ["speed", "movement"],
  ["doublejump", "movement"],
  ["ice", "movement"],
  ["oneshot", "damage"],
  ["berserk", "damage"],
  ["vampire", "damage"],
  ["baseball", "damage"],
  ["lava", "danger"],
  ["meteors", "danger"],
  ["potato", "danger"],
  ["night", "stealth"],
  ["invisible", "stealth"],
]);

const semitones = (n: number) => 2 ** (n / 12);

/** The seed is picked so ids inside one family land on distinct pitch offsets. */
const idHash = (id: string) => {
  let h = 30;
  for (let i = 0; i < id.length; i++) h = (h * 37 + id.charCodeAt(i)) >>> 0;
  return h;
};

class Sfx {
  muted = typeof localStorage !== "undefined" && localStorage.getItem(MUTE_KEY) === "1";
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;

  /** Browsers only allow audio after a user gesture, so call this from input handlers. */
  unlock() {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      if (!window.AudioContext) return;
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : MASTER;
      this.master.connect(ctx.createDynamicsCompressor()).connect(ctx.destination);
      this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : MASTER, this.ctx.currentTime, 0.02);
  }

  private out(s: Spatial, delay = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted || ctx.state !== "running") return null;
    const vol = s.vol ?? 1;
    if (vol < 0.03) return null;
    let dest: AudioNode = this.master;
    if (s.pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, s.pan));
      p.connect(dest);
      dest = p;
    }
    const g = ctx.createGain();
    g.gain.value = vol;
    g.connect(dest);
    return { ctx, t: ctx.currentTime + delay, dest: g };
  }

  private envelope(ctx: AudioContext, t: number, vol: number, attack: number, dur: number) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    return g;
  }

  private tone(o: ToneOpts, s: Spatial = {}) {
    const out = this.out(s, o.delay);
    if (!out) return;
    const { ctx, t, dest } = out;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + o.dur);
    const env = this.envelope(ctx, t, o.vol ?? 0.3, o.attack ?? 0.005, o.dur);
    if (o.lp) {
      const lp = ctx.createBiquadFilter();
      lp.frequency.value = o.lp;
      osc.connect(lp).connect(env);
    } else {
      osc.connect(env);
    }
    env.connect(dest);
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
  }

  private noise(o: NoiseOpts, s: Spatial = {}) {
    const out = this.out(s, o.delay);
    if (!out || !this.noiseBuf) return;
    const { ctx, t, dest } = out;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = o.type ?? "lowpass";
    filter.frequency.setValueAtTime(o.f ?? 1000, t);
    if (o.f2) filter.frequency.exponentialRampToValueAtTime(o.f2, t + o.dur);
    filter.Q.value = o.q ?? 1;
    const env = this.envelope(ctx, t, o.vol ?? 0.3, o.attack ?? 0.003, o.dur);
    src.connect(filter).connect(env).connect(dest);
    src.loop = true;
    src.start(t, Math.random() * 0.5);
    src.stop(t + o.dur + 0.05);
  }

  swing(s?: Spatial) {
    this.noise({ dur: 0.14, vol: 0.12, type: "bandpass", f: 500, f2: 2200, q: 1.5 }, s);
  }

  hit(crit: boolean, s?: Spatial) {
    this.noise({ dur: 0.09, vol: 0.5, f: 1400, f2: 300 }, s);
    this.tone({ type: "square", f: 170, f2: 70, dur: 0.1, vol: 0.16, lp: 1200 }, s);
    if (crit) {
      this.tone({ f: 1250, f2: 1900, dur: 0.2, vol: 0.18, delay: 0.01 }, s);
      this.noise({ dur: 0.22, vol: 0.18, type: "highpass", f: 3000, delay: 0.02 }, s);
    }
  }

  hurt() {
    this.tone({ type: "triangle", f: 320, f2: 140, dur: 0.18, vol: 0.3 });
    this.noise({ dur: 0.08, vol: 0.4, f: 900 });
  }

  kill() {
    this.tone({ f: 1046, dur: 0.12, vol: 0.2 });
    this.tone({ f: 1568, dur: 0.4, vol: 0.2, delay: 0.08 });
  }

  death(s?: Spatial) {
    this.tone({ type: "square", f: 420, f2: 55, dur: 0.6, vol: 0.12, lp: 1500 }, s);
    this.noise({ dur: 0.45, vol: 0.35, f: 1800, f2: 200, delay: 0.05 }, s);
  }

  step() {
    this.noise({ dur: 0.06, vol: 0.07, f: 500 + Math.random() * 300 });
  }

  land(speed: number) {
    this.noise({ dur: 0.12, vol: Math.min(0.4, 0.1 + speed * 0.015), f: 380 });
  }

  place(s?: Spatial) {
    this.noise({ dur: 0.07, vol: 0.3, f: 650 }, s);
    this.tone({ f: 210, f2: 120, dur: 0.07, vol: 0.12 }, s);
  }

  breakBlock(s?: Spatial) {
    this.noise({ dur: 0.16, vol: 0.32, type: "bandpass", f: 900, f2: 400, q: 0.8 }, s);
    this.noise({ dur: 0.05, vol: 0.2, type: "highpass", f: 2500, delay: 0.04 }, s);
  }

  pickup() {
    [660, 880, 1175].forEach((f, i) => this.tone({ f, dur: 0.12, vol: 0.16, delay: i * 0.06 }));
  }

  rouletteTick(progress: number) {
    this.tone({ type: "square", f: 900 + progress * 400, dur: 0.03, vol: 0.05, lp: 3000 });
  }

  rouletteStop() {
    this.tone({ f: 880, dur: 0.6, vol: 0.16 });
    this.tone({ f: 1320, dur: 0.6, vol: 0.1 });
  }

  /** Brass-like fanfare with a low boom for a new buff. */
  horn() {
    const chord = (fs: number[], delay: number, dur: number) =>
      fs.forEach((f) => this.tone({ type: "sawtooth", f, dur, vol: 0.07, attack: 0.04, delay, lp: 1800 }));
    chord([196, 247, 294], 0, 0.22);
    chord([262, 330, 392], 0.2, 0.95);
    this.tone({ f: 70, f2: 38, dur: 0.8, vol: 0.45, delay: 0.2 });
    this.noise({ dur: 0.6, vol: 0.15, f: 300, delay: 0.2 });
  }

  beep(go: boolean) {
    this.tone({ type: "square", f: go ? 1046 : 523, dur: go ? 0.5 : 0.15, vol: 0.1, lp: 3000 });
  }

  tick(urgent: boolean) {
    this.tone({ type: "triangle", f: urgent ? 1400 : 1000, dur: 0.05, vol: 0.12 });
  }

  /** Rising whistle of a firework rocket. */
  fireworkLaunch(s?: Spatial) {
    this.tone({ f: 700, f2: 1900, dur: 0.7, vol: 0.035, attack: 0.05 }, s);
    this.noise({ dur: 0.25, vol: 0.08, type: "highpass", f: 3000 }, s);
  }

  /** Bang and crackle of a firework burst. */
  fireworkBurst(s?: Spatial) {
    this.noise({ dur: 0.6, vol: 0.4, f: 1400, f2: 160 }, s);
    this.tone({ f: 90, f2: 38, dur: 0.45, vol: 0.3 }, s);
    for (let i = 0; i < 6; i++) this.noise({ dur: 0.03, vol: 0.12, type: "highpass", f: 4000, delay: 0.35 + i * 0.07 + Math.random() * 0.05 }, s);
  }

  roundEnd(won: boolean) {
    const notes = won ? [523, 659, 784, 1046] : [392, 494, 587];
    notes.forEach((f, i) =>
      this.tone({ type: "triangle", f, dur: i === notes.length - 1 ? 0.9 : 0.18, vol: 0.2, delay: i * 0.13 }),
    );
  }

  /** Short jingle per buff family; pitch and rhythm shift a little per id. */
  buff(id: string) {
    const h = idHash(id);
    const k = semitones((h % 7) - 3);
    const gap = 0.07 + ((h >>> 5) % 3) * 0.015;
    switch (BUFF_FAMILY.get(id)) {
      case "movement":
        this.buffMovement(k, gap);
        break;
      case "damage":
        this.buffDamage(k, gap);
        break;
      case "danger":
        this.buffDanger(k, gap);
        break;
      case "stealth":
        this.buffStealth(k);
        break;
      default:
        this.buffEvents(k, gap);
    }
  }

  /** Rising airy arpeggio. */
  private buffMovement(k: number, gap: number) {
    [0, 4, 7, 12, 16].forEach((n, i) => {
      const f = 523 * k * semitones(n);
      this.tone({ f, dur: 0.25, vol: 0.12, attack: 0.01, delay: i * gap });
      this.tone({ f: f * 2, dur: 0.18, vol: 0.04, delay: i * gap + 0.02 });
    });
    this.noise({ dur: 0.55, vol: 0.06, type: "bandpass", f: 900, f2: 4500, q: 1.2, attack: 0.15 });
  }

  /** Low, aggressive brass stabs. */
  private buffDamage(k: number, gap: number) {
    const stab = (root: number, delay: number, dur: number) =>
      [1, 1.5, 2].forEach((m) =>
        this.tone({ type: "sawtooth", f: root * m, dur, vol: 0.09, attack: 0.02, delay, lp: 1400 }),
      );
    stab(98 * k, 0, 0.2);
    stab(98 * k * semitones(3), gap * 3, 0.4);
    this.tone({ f: 60 * k, f2: 35 * k, dur: 0.5, vol: 0.4 });
    this.noise({ dur: 0.15, vol: 0.2, f: 1200, f2: 200, delay: gap * 3 });
  }

  /** Alarm-like falling siren. */
  private buffDanger(k: number, gap: number) {
    for (let i = 0; i < 3; i++) {
      this.tone({ type: "square", f: 900 * k, f2: 450 * k, dur: gap * 3, vol: 0.07, attack: 0.01, delay: i * gap * 3, lp: 2200 });
    }
    this.tone({ type: "triangle", f: 110 * k, f2: 55 * k, dur: 0.7, vol: 0.2 });
  }

  /** Dark low pad with a soft chime. */
  private buffStealth(k: number) {
    [1, 1.2, 1.5].forEach((m) =>
      this.tone({ type: "triangle", f: 110 * k * m, dur: 0.85, vol: 0.12, attack: 0.25, lp: 500 }),
    );
    this.noise({ dur: 0.7, vol: 0.08, f: 250, attack: 0.25 });
    this.tone({ f: 1109 * k, dur: 0.5, vol: 0.07, delay: 0.3 });
    this.tone({ f: 1109 * k * 1.5, dur: 0.4, vol: 0.04, delay: 0.4 });
  }

  /** Bright major fanfare. */
  private buffEvents(k: number, gap: number) {
    [0, 4, 7, 12].forEach((n, i) => {
      const f = 392 * k * semitones(n);
      const dur = i === 3 ? 0.5 : 0.12;
      this.tone({ type: "square", f, dur, vol: 0.06, attack: 0.01, delay: i * gap, lp: 3200 });
      this.tone({ type: "triangle", f: f * 2, dur, vol: 0.08, delay: i * gap });
    });
    this.noise({ dur: 0.3, vol: 0.05, type: "highpass", f: 5000, delay: gap * 3 });
  }

  /** Two-chord sting for two buffs landing at once. */
  chaos() {
    const chord = (fs: number[], delay: number, dur: number) =>
      fs.forEach((f) => this.tone({ type: "sawtooth", f, dur, vol: 0.07, attack: 0.03, delay, lp: 2200 }));
    chord([220, 262, 311, 370], 0, 0.4);
    chord([196, 294, 392, 494], 0.4, 1.1);
    this.tone({ type: "sawtooth", f: 200, f2: 900, dur: 0.4, vol: 0.05, attack: 0.3, lp: 2000 });
    this.tone({ f: 70, f2: 35, dur: 0.9, vol: 0.45, delay: 0.4 });
    this.noise({ dur: 0.7, vol: 0.2, f: 1500, f2: 150, delay: 0.4 });
  }

  /** Punchy announcer stinger. */
  callout() {
    this.tone({ type: "square", f: 523, dur: 0.09, vol: 0.12, lp: 2500 });
    this.tone({ type: "square", f: 784, dur: 0.24, vol: 0.14, lp: 2800, delay: 0.08 });
    this.tone({ f: 120, f2: 60, dur: 0.15, vol: 0.28 });
    this.noise({ dur: 0.05, vol: 0.15, type: "highpass", f: 3000, delay: 0.08 });
  }

  /** Heavy explosion: low noise roar, crack and sub thump. */
  boom(s?: Spatial) {
    this.noise({ dur: 1.1, vol: 0.5, f: 1000, f2: 90 }, s);
    this.noise({ dur: 0.2, vol: 0.3, type: "bandpass", f: 2500, f2: 400 }, s);
    this.tone({ f: 80, f2: 30, dur: 0.8, vol: 0.4 }, s);
    this.tone({ type: "triangle", f: 150, f2: 45, dur: 0.5, vol: 0.2 }, s);
  }

  /** Descending whistle that swells as the meteor falls. */
  meteorWhoosh(s?: Spatial) {
    this.tone({ f: 1400, f2: 200, dur: 1.8, vol: 0.07, attack: 1.1 }, s);
    this.noise({ dur: 1.8, vol: 0.18, type: "bandpass", f: 3000, f2: 250, q: 2, attack: 1.1 }, s);
    this.noise({ dur: 1.8, vol: 0.12, f: 300, attack: 1.2 }, s);
  }

  /** Bow string twang with a little arrow swish. */
  bowShot(s?: Spatial) {
    this.tone({ type: "sawtooth", f: 440, f2: 330, dur: 0.25, vol: 0.12, lp: 1400 }, s);
    this.tone({ f: 520, f2: 340, dur: 0.22, vol: 0.14 }, s);
    this.noise({ dur: 0.04, vol: 0.15, type: "highpass", f: 3000 }, s);
    this.noise({ dur: 0.18, vol: 0.07, type: "bandpass", f: 1500, f2: 3500, delay: 0.02 }, s);
  }

  /** Short wooden thunk. */
  arrowHit(s?: Spatial) {
    this.tone({ type: "triangle", f: 260, f2: 110, dur: 0.08, vol: 0.25 }, s);
    this.tone({ f: 700, f2: 500, dur: 0.04, vol: 0.08 }, s);
    this.noise({ dur: 0.05, vol: 0.25, type: "bandpass", f: 1100, q: 2 }, s);
  }

  /** Whoosh-zap teleport. */
  swap() {
    this.noise({ dur: 0.35, vol: 0.2, type: "bandpass", f: 400, f2: 5000, q: 3 });
    this.tone({ f: 300, f2: 1800, dur: 0.3, vol: 0.14 });
    this.tone({ type: "square", f: 2400, f2: 300, dur: 0.12, vol: 0.07, lp: 4000, delay: 0.25 });
    this.tone({ f: 1760, dur: 0.2, vol: 0.1, delay: 0.32 });
  }

  /** Two rising chirps shortly before a swap. */
  swapWarn() {
    this.tone({ type: "triangle", f: 600, f2: 900, dur: 0.15, vol: 0.15 });
    this.tone({ type: "triangle", f: 700, f2: 1050, dur: 0.15, vol: 0.15, delay: 0.18 });
  }

  /** Fuse tick; the urgent one is higher and sharper. */
  bombTick(urgent: boolean) {
    this.tone({ type: "square", f: urgent ? 1900 : 1100, dur: urgent ? 0.04 : 0.06, vol: 0.1, lp: urgent ? 4500 : 2500 });
    this.noise({ dur: 0.03, vol: urgent ? 0.1 : 0.06, type: "highpass", f: 4000 });
  }

  /** Quick pop when the bomb changes hands. */
  bombPass(s?: Spatial) {
    this.tone({ f: 300, f2: 900, dur: 0.08, vol: 0.2 }, s);
    this.noise({ dur: 0.04, vol: 0.2, type: "bandpass", f: 1800, q: 1.5 }, s);
    this.tone({ f: 1200, dur: 0.06, vol: 0.1, delay: 0.05 }, s);
  }

  /** Zombie groan: growly noise over two detuned low tones that beat. */
  infect(s?: Spatial) {
    this.tone({ type: "sawtooth", f: 110, f2: 70, dur: 0.7, vol: 0.1, attack: 0.1, lp: 500 }, s);
    this.tone({ type: "sawtooth", f: 117, f2: 74, dur: 0.7, vol: 0.1, attack: 0.1, lp: 500 }, s);
    this.noise({ dur: 0.7, vol: 0.25, type: "bandpass", f: 300, f2: 150, q: 4, attack: 0.1 }, s);
    this.noise({ dur: 0.4, vol: 0.15, type: "bandpass", f: 700, f2: 400, q: 3, delay: 0.15 }, s);
  }

  /** Gentle rising shimmer. */
  respawn() {
    [784, 988, 1175, 1568, 1976].forEach((f, i) => this.tone({ f, dur: 0.4, vol: 0.08, delay: i * 0.07 }));
    this.tone({ f: 400, f2: 1600, dur: 0.5, vol: 0.05, attack: 0.1 });
  }

  /** Tiny soft blip for a hill point; it repeats about once a second. */
  point() {
    this.tone({ f: 988, dur: 0.1, vol: 0.06 });
    this.tone({ f: 1480, dur: 0.1, vol: 0.035, delay: 0.05 });
  }

  /** UI click with a confirming blip. */
  vote() {
    this.tone({ type: "square", f: 700, dur: 0.04, vol: 0.06, lp: 3000 });
    this.tone({ f: 1050, dur: 0.07, vol: 0.09, delay: 0.04 });
  }

  /** Low rumble with bubbling pops as the lava surges up. */
  lavaRise() {
    this.noise({ dur: 1.2, vol: 0.4, f: 140, f2: 300, attack: 0.3 });
    this.tone({ f: 45, f2: 60, dur: 1.2, vol: 0.3, attack: 0.3 });
    for (let i = 0; i < 6; i++) {
      const f = 150 + Math.random() * 100;
      this.tone({ f, f2: f * 2.2, dur: 0.1, vol: 0.12, delay: 0.1 + i * 0.15 + Math.random() * 0.1 });
    }
  }
}

export const sfx = new Sfx();
