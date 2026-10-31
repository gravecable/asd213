import * as THREE from "three";
import { ARENA_RADIUS, BUFFS, HUB, MODES, MODE_IDS, roundClock } from "../shared";
import type { BuffId } from "../shared";
import type { DailyRecords, GameMode, PlayerInfo } from "../shared";
import type { UiState } from "./store";

/** Decoration layer of the hub: floor decals, floating labels, portal, beacon and the two big boards. */

interface Fonts {
  label: string;
  pixel: string;
}

const TAU = Math.PI * 2;
const GOLD = "#ffe066";
const GREEN = "#7dff9a";
const GREY = "#9aa3b5";
const RED = "#ff6b6b";
const WHITE = "#ffffff";
const TEXT_REFRESH_MS = 250;

const pageFonts = (): Fonts => {
  const el = document.querySelector<HTMLElement>(".pvp-root") ?? document.body;
  const style = getComputedStyle(el);
  return { label: style.fontFamily || "sans-serif", pixel: style.getPropertyValue("--font-pixel").trim() || "monospace" };
};

const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// ---------------------------------------------------------------- canvas painting

interface TextOpts {
  size: number;
  color: string;
  pixel?: boolean;
  align?: CanvasTextAlign;
  /** Shrinks the font until the text fits. */
  maxW?: number;
  /** Offset of a hard black drop shadow. */
  shadow?: number;
}

class Painter {
  constructor(
    readonly ctx: CanvasRenderingContext2D,
    private fonts: Fonts,
  ) {}

  font(size: number, pixel = false) {
    return pixel ? `${size.toFixed(1)}px ${this.fonts.pixel}` : `bold ${size.toFixed(1)}px ${this.fonts.label}`;
  }

  width(str: string, size: number, pixel = false) {
    this.ctx.font = this.font(size, pixel);
    return this.ctx.measureText(str).width;
  }

  fit(str: string, size: number, maxW: number, pixel = false) {
    const w = this.width(str, size, pixel);
    return w > maxW ? Math.max(9, (size * maxW) / w) : size;
  }

  text(str: string, x: number, y: number, o: TextOpts): number {
    const { ctx } = this;
    const size = o.maxW ? this.fit(str, o.size, o.maxW, o.pixel) : o.size;
    ctx.font = this.font(size, o.pixel);
    ctx.textAlign = o.align ?? "left";
    ctx.textBaseline = "middle";
    if (o.shadow) {
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillText(str, x + o.shadow, y + o.shadow);
    }
    ctx.fillStyle = o.color;
    ctx.fillText(str, x, y);
    return ctx.measureText(str).width;
  }

  /** Coloured pieces on one line, left aligned and shrunk as a whole to fit. */
  segments(parts: [string, string][], x: number, y: number, size: number, maxW: number) {
    const { ctx } = this;
    const total = parts.reduce((s, [t]) => s + this.width(t, size), 0);
    const k = total > maxW ? maxW / total : 1;
    ctx.font = this.font(size * k);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    let cx = x;
    for (const [t, c] of parts) {
      ctx.fillStyle = c;
      ctx.fillText(t, cx, y);
      cx += ctx.measureText(t).width;
    }
  }

  ellipsize(str: string, size: number, maxW: number) {
    if (this.width(str, size) <= maxW) return str;
    let s = str;
    while (s.length > 1 && this.width(`${s}…`, size) > maxW) s = s.slice(0, -1);
    return `${s}…`;
  }
}

/** Cobble frame around a dark panel, like a sign made of stone. */
function drawFrame(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const cell = 8;
  const f = 24;
  const shades = ["#5d6068", "#6b6e77", "#53565d", "#7a7e88", "#4a4d54"];
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      if (x >= f && x < w - f && y >= f && y < h - f) continue;
      ctx.fillStyle = shades[((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0) % shades.length];
      ctx.fillRect(x, y, cell, cell);
    }
  }
  const g = ctx.createLinearGradient(0, f, 0, h - f);
  g.addColorStop(0, "#1b2132");
  g.addColorStop(1, "#0d1018");
  ctx.fillStyle = g;
  ctx.fillRect(f, f, w - 2 * f, h - 2 * f);
  ctx.fillStyle = "#06070a";
  ctx.fillRect(f, f, w - 2 * f, 4);
  ctx.fillRect(f, f, 4, h - 2 * f);
  ctx.fillStyle = "#2e3750";
  ctx.fillRect(f, h - f - 4, w - 2 * f, 4);
  ctx.fillRect(w - f - 4, f, 4, h - 2 * f);
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, w - 6, h - 6);
}

const panelBox = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
  ctx.fillStyle = "rgba(255,255,255,0.045)";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 10);
  ctx.fill();
};

// ---------------------------------------------------------------- floating labels

interface LabelLine {
  text: string;
  color: string;
  size: number;
  pixel?: boolean;
}

const line = (text: string, color: string, size: number, pixel = false): LabelLine => ({ text, color, size, pixel });

const LABEL_W = 640;
/** Horizontal distance (blocks) at which floating labels start to fade in, and are fully shown. */
const FADE_NEAR = 4;
const FADE_FAR = 7;

class Label {
  readonly sprite: THREE.Sprite;
  private readonly canvas = document.createElement("canvas");
  private readonly tex: THREE.CanvasTexture;
  private readonly mat: THREE.SpriteMaterial;
  private readonly paint: Painter;
  private key = "";

  /** `sizes`: nominal font size of every line the label may show, to size its canvas. */
  constructor(fonts: Fonts, x: number, y: number, z: number, unit: number, sizes: number[]) {
    this.canvas.width = LABEL_W;
    this.canvas.height = Math.ceil(sizes.reduce((s, v) => s + v * 1.3, 0) + 32);
    this.paint = new Painter(this.canvas.getContext("2d") as CanvasRenderingContext2D, fonts);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mat = new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthWrite: false, fog: false });
    this.sprite = new THREE.Sprite(this.mat);
    this.sprite.scale.set(LABEL_W * unit, this.canvas.height * unit, 1);
    this.sprite.position.set(x, y, z);
    this.sprite.renderOrder = 10;
  }

  set(lines: LabelLine[], epoch: number) {
    const key = epoch + lines.map((l) => `${l.text}|${l.color}`).join("\n");
    if (key === this.key) return;
    this.key = key;
    const { ctx } = this.paint;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, LABEL_W, h);
    if (!lines.length) {
      this.tex.needsUpdate = true;
      return;
    }
    const sizes = lines.map((l) => this.paint.fit(l.text, l.size, LABEL_W - 64, l.pixel));
    const widths = lines.map((l, i) => this.paint.width(l.text, sizes[i], l.pixel));
    const total = sizes.reduce((s, v) => s + v * 1.3, 0);
    const pw = Math.min(LABEL_W - 8, Math.max(...widths) + 44);
    const ph = total + 20;
    const top = (h - ph) / 2;
    ctx.fillStyle = "rgba(10,12,20,0.74)";
    ctx.strokeStyle = `${lines[0].color}99`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect((LABEL_W - pw) / 2, top, pw, ph, 14);
    ctx.fill();
    ctx.stroke();
    let y = top + 10;
    lines.forEach((l, i) => {
      const cy = y + sizes[i] * 0.65;
      ctx.font = this.paint.font(sizes[i], l.pixel);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.lineWidth = sizes[i] * 0.2;
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      ctx.strokeText(l.text, LABEL_W / 2, cy);
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, LABEL_W / 2, cy);
      y += sizes[i] * 1.3;
    });
    this.tex.needsUpdate = true;
  }

  /** Fades the label out up close, where it would cover the player's view. */
  fadeFor(eye: THREE.Vector3) {
    const p = this.sprite.position;
    const d = Math.hypot(p.x - eye.x, p.z - eye.z);
    const k = Math.min(1, Math.max(0, (d - FADE_NEAR) / (FADE_FAR - FADE_NEAR)));
    this.mat.opacity = k * k * (3 - 2 * k);
    this.sprite.visible = k > 0;
  }

  dispose() {
    this.tex.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------- boards

interface Board {
  canvas: HTMLCanvasElement;
  paint: Painter;
  tex: THREE.CanvasTexture;
  key: string;
}

// ---------------------------------------------------------------- flat geometry

const flatDisc = (r: number) => new THREE.CircleGeometry(r, 48).rotateX(-Math.PI / 2);
const flatRing = (r0: number, r1: number) => new THREE.RingGeometry(r0, r1, 64).rotateX(-Math.PI / 2);
const flatRect = (w: number, d: number) => new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);

/** Ring cut into dashes; `keep` gets the offset from the centre of every dash and may drop it. */
function dashedRing(r: number, width: number, count: number, fill: number, keep?: (dx: number, dz: number) => boolean) {
  const pos: number[] = [];
  const r0 = r - width / 2;
  const r1 = r + width / 2;
  const step = TAU / count;
  for (let i = 0; i < count; i++) {
    const a0 = i * step;
    const a1 = a0 + step * fill;
    const am = (a0 + a1) / 2;
    if (keep && !keep(Math.cos(am) * r, Math.sin(am) * r)) continue;
    const [c0, s0, c1, s1] = [Math.cos(a0), Math.sin(a0), Math.cos(a1), Math.sin(a1)];
    pos.push(c0 * r0, 0, s0 * r0, c0 * r1, 0, s0 * r1, c1 * r1, 0, s1 * r1);
    pos.push(c0 * r0, 0, s0 * r0, c1 * r1, 0, s1 * r1, c1 * r0, 0, s1 * r0);
  }
  return new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
}

/** Rectangular outline of thickness `t`, origin at the corner. */
function rectFrame(w: number, d: number, t: number) {
  const quad = (x0: number, z0: number, x1: number, z1: number) => [x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z0, x1, 0, z1, x0, 0, z1];
  const pos = [...quad(0, 0, w, t), ...quad(0, d - t, w, d), ...quad(0, t, t, d - t), ...quad(w - t, t, w, d - t)];
  return new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
}

function beamGeometry(radius: number, height: number, r: number, g: number, b: number) {
  const geo = new THREE.CylinderGeometry(radius, radius, height, 16, 1, true).translate(0, height / 2, 0);
  const y = geo.getAttribute("position");
  const col = new Float32Array(y.count * 3);
  for (let i = 0; i < y.count; i++) {
    // Additive blending: fading to black is fading to transparent.
    const k = Math.pow(1 - y.getY(i) / height, 1.6);
    col.set([r * k, g * k, b * k], i * 3);
  }
  return geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
}

const PORTAL_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const PORTAL_FRAG = `
varying vec2 vUv;
uniform float uTime;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return v;
}
void main() {
  vec2 p = (vUv - 0.5) * vec2(5.0, 8.0);
  float r = length(p);
  float a = atan(p.y, p.x);
  float sw = a + r * 0.9 - uTime * 0.8;
  vec2 q = vec2(cos(sw), sin(sw)) * r * 0.55;
  float n = fbm(q + vec2(uTime * 0.12, -uTime * 0.07));
  float arms = 0.5 + 0.5 * sin(a * 3.0 + r * 2.2 - uTime * 1.5 + n * 4.0);
  float g = clamp(n * 0.9 + arms * 0.55, 0.0, 1.0);
  vec3 col = mix(vec3(0.16, 0.02, 0.36), vec3(0.58, 0.2, 0.98), g);
  col = mix(col, vec3(0.93, 0.78, 1.0), pow(clamp(arms * n * 1.7, 0.0, 1.0), 3.0));
  col += vec3(0.5, 0.3, 0.9) * exp(-r * r * 0.35) * 0.35;
  vec2 e = min(vUv, 1.0 - vUv) * vec2(5.0, 8.0);
  float d = min(e.x, e.y);
  col += vec3(0.7, 0.4, 1.0) * (1.0 - smoothstep(0.0, 0.5, d)) * 0.4;
  gl_FragColor = vec4(col, (0.62 + 0.3 * g) * smoothstep(0.0, 0.12, d));
}`;

interface Pad {
  fill: THREE.MeshBasicMaterial;
  ring: THREE.MeshBasicMaterial;
  halo: THREE.MeshBasicMaterial;
  haloMesh: THREE.Mesh;
}

const PORTAL_Y0 = 0.02;
const PORTAL_H = 8 - PORTAL_Y0;
const PARTICLES = 36;

export class HubScene {
  readonly group = new THREE.Group();

  private readonly fonts: Fonts;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly statics: [Label, LabelLine[]][] = [];
  private readonly labels: Label[] = [];
  private readonly t0 = typeof performance !== "undefined" ? performance.now() : 0;

  private fontEpoch = 0;
  private staticEpoch = -1;
  private lastText = -Infinity;
  private prevNow = 0;
  private readyGlow = 0;

  private readonly readyFill: THREE.MeshBasicMaterial;
  private readonly readyRing: THREE.MeshBasicMaterial;
  private readonly readySpin: THREE.Mesh;
  private readonly readyLabel: Label;
  private readonly votePads = {} as Record<GameMode, Pad>;
  private readonly voteLabels = {} as Record<GameMode, Label>;
  private readonly padMats: THREE.MeshBasicMaterial[] = [];
  private readonly champLabel: Label;
  private readonly beams: THREE.MeshBasicMaterial[] = [];
  private readonly portalMat: THREE.ShaderMaterial;
  private readonly particles: THREE.Points;
  private readonly particleSeed = new Float32Array(PARTICLES * 4);
  private readonly arena: Board;
  private readonly records: Board;

  constructor(fonts?: { label?: string; pixel?: string }) {
    const page = typeof document !== "undefined" ? pageFonts() : { label: "sans-serif", pixel: "monospace" };
    this.fonts = { label: fonts?.label?.trim() || page.label, pixel: fonts?.pixel?.trim() || page.pixel };
    this.group.name = "hub-scene";

    this.readyFill = this.decalMat(GREEN, 0.18);
    this.readyRing = this.decalMat(GREEN, 0.9);
    const readyDash = this.decalMat("#d6ffe0", 0.7);
    const rc = HUB.ready;
    this.flat(flatDisc(rc.r), this.readyFill, rc.x, rc.z, 0.03);
    this.flat(flatRing(rc.r - 0.4, rc.r), this.readyRing, rc.x, rc.z, 0.04);
    this.flat(flatRing(rc.r - 0.75, rc.r - 0.68), readyDash, rc.x, rc.z, 0.04);
    this.readySpin = this.flat(dashedRing(rc.r - 1.5, 0.22, 24, 0.5), readyDash, rc.x, rc.z, 0.045);

    for (const m of MODE_IDS) {
      const c = HUB.votes[m];
      const color = MODES[m].color;
      const pad: Pad = { fill: this.decalMat(color, 0.25), ring: this.decalMat(color, 0.85), halo: this.decalMat(WHITE, 0), haloMesh: undefined as unknown as THREE.Mesh };
      this.flat(flatDisc(c.r), pad.fill, c.x, c.z, 0.03);
      this.flat(flatRing(c.r - 0.28, c.r), pad.ring, c.x, c.z, 0.04);
      this.flat(flatRing(c.r * 0.45, c.r * 0.45 + 0.12), pad.ring, c.x, c.z, 0.04);
      pad.haloMesh = this.flat(flatRing(c.r + 0.15, c.r + 0.45), pad.halo, c.x, c.z, 0.04);
      this.votePads[m] = pad;
      // Pads stand in rows one behind another: further rows get higher signs, so from the spawn
      // they don't cover each other.
      this.voteLabels[m] = this.makeLabel(c.x, 2.9 + Math.max(0, (-13.5 - c.z) / 6) * 1.5, c.z, 0.014, [46, 34, 28]);
    }

    this.simplePad(HUB.wardrobe, "#c084fc", 1.6);
    const w = HUB.wardrobe;
    // The wardrobe's plank wall sits just north of the pad: keep the outer ring on the open side.
    this.flat(dashedRing(w.r, 0.25, 40, 0.55, (dx, dz) => w.z + dz > 6), this.decalMat("#c084fc", 0.7), w.x, w.z, 0.04);
    this.simplePad(HUB.rangeStart, "#fbbf24", HUB.rangeStart.r);
    this.simplePad(HUB.parkourStart, "#22d3ee", HUB.parkourStart.r);

    const b = HUB.build;
    const bw = b.x1 - b.x0 + 1;
    const bd = b.z1 - b.z0 + 1;
    this.flat(flatRect(bw, bd), this.decalMat("#c8a165", 0.16), b.x0 + bw / 2, b.z0 + bd / 2, 0.03);
    this.flat(rectFrame(bw, bd, 0.2), this.decalMat("#e6bd7c", 0.85), b.x0, b.z0, 0.04);

    const az = HUB.archerZone;
    this.flat(
      dashedRing(az.r, 0.6, 48, 0.6, (dx, dz) => Math.hypot(az.x + dx, az.z + dz) < ARENA_RADIUS - 0.6),
      this.decalMat("#ef4444", 0.8),
      az.x,
      az.z,
      0.04,
    );

    this.portalMat = this.track(
      new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 } }, vertexShader: PORTAL_VERT, fragmentShader: PORTAL_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    const portal = new THREE.Mesh(this.track(new THREE.PlaneGeometry(5, PORTAL_H)), this.portalMat);
    portal.position.set(0.5, PORTAL_Y0 + PORTAL_H / 2, -26.5);
    portal.renderOrder = 3;
    this.group.add(portal);

    const pgeo = this.track(new THREE.BufferGeometry());
    pgeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(PARTICLES * 3), 3));
    for (let i = 0; i < PARTICLES; i++) {
      this.particleSeed.set([-1.8 + Math.random() * 4.6, Math.random() * 7.4, 0.35 + Math.random() * 0.9, Math.random() * TAU], i * 4);
    }
    this.particles = new THREE.Points(
      pgeo,
      this.track(new THREE.PointsMaterial({ color: 0xe9d5ff, size: 0.16, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })),
    );
    this.particles.frustumCulled = false;
    this.particles.renderOrder = 4;
    this.group.add(this.particles);

    const beam = (radius: number, color: [number, number, number], opacity: number) => {
      const mat = this.track(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      const mesh = new THREE.Mesh(this.track(beamGeometry(radius, 40, ...color)), mat);
      mesh.position.set(rc.x, 0, rc.z);
      mesh.renderOrder = 2;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.beams.push(mat);
    };
    beam(0.42, [0.25, 1, 0.45], 0.45);
    beam(0.13, [0.8, 1, 0.85], 0.8);

    this.readyLabel = this.makeLabel(rc.x, 3.9, rc.z, 0.015, [46, 34, 36]);

    const d = HUB.duel;
    const dc = { x: (d.x0 + d.x1 + 1) / 2, z: (d.z0 + d.z1 + 1) / 2 };
    const pn = HUB.pen;
    const cl = HUB.cliff;
    const bc = { x: b.x0 + bw / 2, z: b.z0 + bd / 2 };
    const f = HUB.parkourFinish;
    this.makeLabel(w.x, 3.5, w.z, 0.015, [44], [line("ГАРДЕРОБ [E]", "#e0b3ff", 44, true)]);
    this.makeLabel(HUB.rangeStart.x, 3, HUB.rangeStart.z, 0.015, [44, 34], [line("ТИР · 30 СЕКУНД", "#fcd34d", 44, true), line("встань на круг", WHITE, 34)]);
    this.makeLabel(HUB.parkourStart.x, 3, HUB.parkourStart.z, 0.015, [44], [line("ПАРКУР · СТАРТ", "#67e8f9", 44, true)]);
    this.makeLabel((f.x0 + f.x1 + 1) / 2, f.h + 2, (f.z0 + f.z1 + 1) / 2, 0.018, [48], [line("ФИНИШ", GOLD, 48, true)]);
    this.makeLabel(bc.x, 3.8, bc.z, 0.016, [46, 34], [line("СТРОЙКА", "#f0c987", 46, true), line("блоки исчезают через минуту", WHITE, 34)]);
    this.makeLabel(dc.x, 4, dc.z, 0.016, [46, 34], [line("ДУЭЛИ", "#fca5a5", 46, true), line("наведись на игрока и нажми F", WHITE, 34)]);
    const dm = HUB.dummies;
    this.makeLabel(dm[0].x, 3.2, dm.reduce((s, m) => s + m.z, 0) / dm.length, 0.015, [44], [line("МАНЕКЕНЫ", "#fde68a", 44, true)]);
    this.makeLabel((pn.x0 + pn.x1 + 1) / 2, 3.6, (pn.z0 + pn.z1 + 1) / 2, 0.016, [46], [line("СКЕЛЕТЫ", "#e5e7eb", 46, true)]);
    this.makeLabel(HUB.archer.x, HUB.archer.y + 3.6, HUB.archer.z, 0.016, [44, 34], [line("ЛУЧНИК", "#fca5a5", 44, true), line("уклоняйся от стрел", WHITE, 34)]);
    this.makeLabel((cl.x0 + cl.x1 + 1) / 2, cl.h + 2.8, (cl.z0 + cl.z1 + 1) / 2, 0.016, [46], [line("СБЕЙ С ОБРЫВА", "#fdba74", 46, true)]);
    this.champLabel = this.makeLabel(HUB.pedestal.x, HUB.pedestal.y + 3.3, HUB.pedestal.z, 0.012, [46, 40]);

    this.arena = this.makeBoard(HUB.boards.arena, 1280);
    this.records = this.makeBoard(HUB.boards.records, 1152);

    if (typeof document !== "undefined" && document.fonts) {
      document.fonts.addEventListener("loadingdone", this.onFonts);
      const p = this.painter();
      void Promise.all([document.fonts.load(p.font(28, true), "Аа"), document.fonts.load(p.font(28), "Аа")]).then(this.onFonts, () => {});
    }
  }

  /** `eye`: camera position, to fade out labels the player is standing right under. */
  update(ui: UiState, now: number, eye?: THREE.Vector3) {
    const dt = this.prevNow ? Math.min(0.1, Math.max(0, (now - this.prevNow) / 1000)) : 0;
    this.prevNow = now;
    const t = (now - this.t0) / 1000;
    this.animate(ui, t, dt);
    if (eye) for (const l of this.labels) l.fadeFor(eye);
    if (Math.abs(now - this.lastText) >= TEXT_REFRESH_MS) {
      this.lastText = now;
      this.refresh(ui, now);
    }
  }

  dispose() {
    if (typeof document !== "undefined" && document.fonts) document.fonts.removeEventListener("loadingdone", this.onFonts);
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
    this.statics.length = 0;
    this.group.clear();
  }

  // ---------------------------------------------------------------- building

  private readonly onFonts = () => {
    this.fontEpoch++;
    this.lastText = -Infinity;
  };

  private painter() {
    return new Painter(document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D, this.fonts);
  }

  private track<T extends { dispose(): void }>(o: T): T {
    this.disposables.push(o);
    return o;
  }

  private decalMat(color: string, opacity: number) {
    return this.track(
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, fog: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
  }

  private flat(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, z: number, y: number) {
    const mesh = new THREE.Mesh(this.track(geo), mat);
    mesh.position.set(x, y, z);
    mesh.renderOrder = 1;
    this.group.add(mesh);
    return mesh;
  }

  private simplePad(c: { x: number; z: number; r: number }, color: string, r: number) {
    const fill = this.decalMat(color, 0.25);
    const ring = this.decalMat(color, 0.9);
    this.padMats.push(fill);
    this.flat(flatDisc(r), fill, c.x, c.z, 0.03);
    this.flat(flatRing(r - 0.2, r), ring, c.x, c.z, 0.04);
  }

  private makeLabel(x: number, y: number, z: number, unit: number, sizes: number[], lines?: LabelLine[]) {
    const label = this.track(new Label(this.fonts, x, y, z, unit, sizes));
    this.group.add(label.sprite);
    this.labels.push(label);
    if (lines) {
      label.set(lines, 0);
      this.statics.push([label, lines]);
    }
    return label;
  }

  private makeBoard(cfg: { x: number; y: number; z: number; rotY: number; w: number; h: number }, px: number): Board {
    const canvas = document.createElement("canvas");
    canvas.width = px;
    canvas.height = Math.round((px * cfg.h) / cfg.w);
    const paint = new Painter(canvas.getContext("2d") as CanvasRenderingContext2D, this.fonts);
    const tex = this.track(new THREE.CanvasTexture(canvas));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const mat = this.track(new THREE.MeshBasicMaterial({ map: tex, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    const mesh = new THREE.Mesh(this.track(new THREE.PlaneGeometry(cfg.w, cfg.h)), mat);
    mesh.position.set(cfg.x, cfg.y, cfg.z);
    mesh.rotation.y = cfg.rotY;
    this.group.add(mesh);
    const board = { canvas, paint, tex, key: "" };
    drawFrame(paint.ctx, canvas.width, canvas.height);
    return board;
  }

  // ---------------------------------------------------------------- per frame

  private animate(ui: UiState, t: number, dt: number) {
    const hub = ui.hub;
    this.readyGlow += (((hub?.ready ?? 0) > 0 ? 1 : 0) - this.readyGlow) * Math.min(1, dt * 6);
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
    this.readyFill.opacity = 0.14 + 0.06 * pulse + 0.2 * this.readyGlow;
    this.readyRing.opacity = 0.65 + 0.2 * pulse + 0.15 * this.readyGlow;
    this.readySpin.rotation.y = -t * 0.5;
    this.beams[0].opacity = 0.3 + 0.1 * pulse + 0.3 * this.readyGlow;
    this.beams[1].opacity = 0.6 + 0.2 * pulse + 0.2 * this.readyGlow;

    this.padMats.forEach((m, i) => (m.opacity = 0.2 + 0.08 * Math.sin(t * 2 + i * 1.7)));

    const maxVotes = Math.max(0, ...MODE_IDS.map((m) => hub?.votes[m] ?? 0));
    for (const m of MODE_IDS) {
      const pad = this.votePads[m];
      const votes = hub?.votes[m] ?? 0;
      const mine = hub?.myVote === m;
      const leader = maxVotes > 0 && votes === maxVotes;
      pad.fill.opacity = (mine ? 0.5 : 0.22) + 0.06 * Math.sin(t * 2.6 + MODE_IDS.indexOf(m));
      pad.ring.opacity = mine ? 1 : 0.8;
      pad.halo.color.set(mine ? WHITE : GOLD);
      pad.halo.opacity = mine ? 0.75 + 0.2 * Math.sin(t * 4) : leader ? 0.35 + 0.25 * pulse : 0;
      pad.haloMesh.visible = pad.halo.opacity > 0.01;
    }

    this.portalMat.uniforms.uTime.value = t;
    const pos = this.particles.geometry.getAttribute("position") as THREE.BufferAttribute;
    const s = this.particleSeed;
    for (let i = 0; i < PARTICLES; i++) {
      const [x, y, speed, phase] = [s[i * 4], s[i * 4 + 1], s[i * 4 + 2], s[i * 4 + 3]];
      pos.setXYZ(i, x + Math.sin(t * 0.8 + phase) * 0.35, PORTAL_Y0 + 0.3 + ((y + t * speed) % 7.4), -26.5 + Math.sin(t * 0.6 + phase * 2) * 0.6);
    }
    pos.needsUpdate = true;
  }

  private refresh(ui: UiState, now: number) {
    const e = this.fontEpoch;
    if (this.staticEpoch !== e) {
      this.staticEpoch = e;
      for (const [label, lines] of this.statics) label.set(lines, e);
    }
    const hub = ui.hub;
    const ready = hub?.ready ?? 0;
    const active = hub?.active ?? 0;
    this.readyLabel.set(
      [line("ГОТОВ К БОЮ", GREEN, 46, true), line("встань в круг", WHITE, 34), line(`Готовы ${ready}/${active}`, ready > 0 ? GOLD : GREY, 36)],
      e,
    );

    const maxVotes = Math.max(0, ...MODE_IDS.map((m) => hub?.votes[m] ?? 0));
    for (const m of MODE_IDS) {
      const votes = hub?.votes[m] ?? 0;
      const tags = [hub?.myVote === m ? "ВАШ ВЫБОР" : "", maxVotes > 0 && votes === maxVotes ? "ЛИДЕР" : ""].filter(Boolean).join(" · ");
      const lines = [line(MODES[m].title, MODES[m].color, 46), line(`голосов: ${votes}`, WHITE, 34)];
      if (tags) lines.push(line(tags, GOLD, 28));
      this.voteLabels[m].set(lines, e);
    }

    const champ = ui.players.find((p) => p.crown);
    this.champLabel.set(champ ? [line("ЧЕМПИОН", GOLD, 46, true), line(champ.name, champ.color, 40)] : [line("ЧЕМПИОН", GOLD, 46, true)], e);

    this.drawBoard(this.arena, this.arenaKey(ui, now), (p, w, h) => drawArena(p, w, h, ui, now));
    this.drawBoard(this.records, this.recordsKey(ui.records), (p, w) => drawRecords(p, w, ui.records));
  }

  private drawBoard(board: Board, key: string, draw: (p: Painter, w: number, h: number) => void) {
    if (key === board.key) return;
    board.key = key;
    drawFrame(board.paint.ctx, board.canvas.width, board.canvas.height);
    draw(board.paint, board.canvas.width, board.canvas.height);
    board.tex.needsUpdate = true;
  }

  private arenaKey(ui: UiState, now: number) {
    const parts: (string | number)[] = [this.fontEpoch, ui.phase];
    if (ui.phase === "countdown" || ui.phase === "playing") {
      parts.push(ui.mode, ui.buffs.join("+"), Math.ceil(roundLeft(ui, now) / 1000), JSON.stringify(ui.score));
      for (const p of participants(ui)) parts.push(`${p.id},${p.name},${p.color},${p.alive ? 1 : 0},${p.kills}`);
      for (const f of ui.feed.slice(-4)) parts.push(f.key);
    } else if (ui.phase === "ended") {
      parts.push(ui.winnerName ?? "", ui.pointsWin ? 1 : 0, ui.winTeam ?? -1, ui.mode, ui.players.find((p) => p.id === ui.winnerId)?.color ?? "");
    } else {
      const hub = ui.hub;
      parts.push(hub?.startAt == null ? "wait" : Math.ceil((hub.startAt - now) / 1000), hub?.need ?? 0, hub?.active ?? 0, hub?.ready ?? 0);
      for (const m of MODE_IDS) parts.push(hub?.votes[m] ?? 0);
      const r = ui.results;
      if (r) parts.push(r.winnerName ?? "", ...r.awards.map((a) => `${a.title},${a.name},${a.value}`));
    }
    return parts.join("|");
  }

  private recordsKey(r: DailyRecords | null) {
    return r ? [this.fontEpoch, r.day, ...(["wins", "kills", "range", "parkour"] as const).map((k) => r[k].slice(0, 5).join(","))].join("|") : `${this.fontEpoch}`;
  }
}

// ---------------------------------------------------------------- board contents

const participants = (ui: UiState): PlayerInfo[] =>
  ui.players.filter((p) => p.role === "player").sort((a, b) => Number(b.alive) - Number(a.alive) || b.kills - a.kills || a.id - b.id);

const roundLeft = (ui: UiState, now: number) => {
  const elapsed = now - ui.phaseStartedAt;
  return ui.phase === "countdown" ? ui.timings.countdownMs - elapsed : roundClock(elapsed, ui.timings).left;
};

function drawArena(p: Painter, w: number, h: number, ui: UiState, now: number) {
  p.text("АРЕНА", 56, 74, { size: 40, color: GOLD, pixel: true, shadow: 4 });
  if (ui.phase === "countdown" || ui.phase === "playing") drawLive(p, w, ui, now);
  else if (ui.phase === "ended") drawEnded(p, w, h, ui);
  else drawLobby(p, w, ui, now);
}

function drawLive(p: Painter, w: number, ui: UiState, now: number) {
  const { ctx } = p;
  const mode = MODES[ui.mode];
  const left = roundLeft(ui, now);
  const countdown = ui.phase === "countdown";
  const overtime = !countdown && roundClock(now - ui.phaseStartedAt, ui.timings).overtime;
  p.text(countdown ? String(Math.ceil(Math.max(0, left) / 1000)) : fmtClock(left), w - 56, 74, { size: 48, color: WHITE, pixel: true, align: "right", shadow: 4 });
  p.text(mode.title, 300, 74, { size: 26, color: mode.color, pixel: true, maxW: 640, shadow: 3 });
  p.text(countdown ? "старт через" : overtime ? "овертайм" : "до конца раунда", w - 56, 120, { size: 28, color: overtime ? RED : GREY, align: "right" });

  const bw = p.text("Баф:", 56, 168, { size: 30, color: GREY });
  const buff = ui.buffs.length ? { title: ui.buffs.map((b: BuffId) => BUFFS[b].title).join(" + "), color: BUFFS[ui.buffs[0]].color } : null;
  p.text(buff ? buff.title : "—", 56 + bw + 14, 168, { size: 32, color: buff?.color ?? GREY, maxW: 520 });
  ctx.fillStyle = "#2c3447";
  ctx.fillRect(48, 196, w - 96, 3);

  const list = participants(ui).slice(0, 12);
  const alive = list.filter((q) => q.alive).length;
  p.text(`ИГРОКИ · жив ${alive} из ${list.length}`, 56, 232, { size: 28, color: GREY });
  list.forEach((q, i) => {
    const x = 56 + Math.floor(i / 6) * 390;
    const y = 284 + (i % 6) * 56;
    ctx.globalAlpha = q.alive ? 1 : 0.4;
    ctx.fillStyle = "#000";
    ctx.fillRect(x - 3, y - 18, 36, 36);
    ctx.fillStyle = q.color;
    ctx.fillRect(x, y - 15, 30, 30);
    ctx.globalAlpha = 1;
    const color = q.alive ? WHITE : "#7c8190";
    const nw = p.text(q.name, x + 46, y, { size: 36, color, maxW: 240 });
    if (!q.alive) {
      ctx.fillStyle = color;
      ctx.fillRect(x + 46, y + 1, nw, 3);
    }
    p.text(String(q.kills), x + 366, y, { size: 36, color: q.alive ? GOLD : "#7c8190", align: "right" });
  });
  if (!list.length) p.text("—", 56, 284, { size: 32, color: GREY });

  ctx.fillStyle = "#2c3447";
  ctx.fillRect(842, 216, 3, 372);
  p.text("ХОД БОЯ", 872, 232, { size: 28, color: GREY });
  const feed = ui.feed.slice(-4).reverse();
  feed.forEach((f, i) => {
    const y = 284 + i * 56;
    if (f.reason === "leave") p.segments([[f.victim.name, f.victim.color], [" вышел", GREY]], 872, y, 30, 340);
    else if (f.killer) p.segments([[f.killer.name, f.killer.color], [f.reason === "fall" ? " ⤓ " : " → ", GOLD], [f.victim.name, f.victim.color]], 872, y, 30, 340);
    else p.segments([[f.victim.name, f.victim.color], [f.reason === "fall" ? " упал" : " погиб", GREY]], 872, y, 30, 340);
  });
  if (!feed.length) p.text("—", 872, 284, { size: 32, color: GREY });
}

function drawEnded(p: Painter, w: number, h: number, ui: UiState) {
  const cx = w / 2;
  const winner = ui.players.find((q) => q.id === ui.winnerId);
  p.text(ui.winnerName ? "ПОБЕДИТЕЛЬ" : "ПОБЕДИТЕЛЯ НЕТ", cx, h * 0.34, { size: 44, color: GOLD, pixel: true, align: "center", shadow: 4, maxW: w - 160 });
  if (ui.winnerName) p.text(ui.winnerName, cx, h * 0.52, { size: 76, color: winner?.color ?? WHITE, pixel: true, align: "center", shadow: 6, maxW: w - 160 });
  const team = ui.winTeam !== null ? MODES[ui.mode].teams?.[ui.winTeam] : undefined;
  if (team) p.text(`${team.name} победили`, cx, h * 0.68, { size: 38, color: team.color, align: "center" });
  else if (ui.pointsWin) p.text("победа по очкам в овертайме", cx, h * 0.68, { size: 34, color: GREY, align: "center" });
  p.text(MODES[ui.mode].title, cx, h * 0.8, { size: 30, color: MODES[ui.mode].color, pixel: true, align: "center", maxW: w - 160 });
}

function drawLobby(p: Painter, w: number, ui: UiState, now: number) {
  const { ctx } = p;
  const hub = ui.hub;
  const active = hub?.active ?? 0;
  const ready = hub?.ready ?? 0;
  p.text("Следующий раунд", 56, 150, { size: 32, color: GREY });
  if (hub?.startAt != null) {
    p.text(fmtClock(hub.startAt - now), 56, 226, { size: 76, color: WHITE, pixel: true, shadow: 6 });
  } else {
    p.text("ждём игроков", 56, 210, { size: 46, color: WHITE, maxW: 560 });
    const need = Math.max(0, (hub?.need ?? 0) - active);
    if (need > 0) p.text(`(нужно ещё ${need})`, 56, 258, { size: 32, color: GOLD });
  }
  p.text(`готовы ${ready} из ${active}`, 56, 316, { size: 38, color: ready > 0 ? GREEN : GREY });

  p.text("ГОЛОСА ЗА РЕЖИМ", 56, 378, { size: 26, color: GREY });
  const max = Math.max(1, ...MODE_IDS.map((m) => hub?.votes[m] ?? 0));
  MODE_IDS.forEach((m, i) => {
    const y = 414 + i * 25;
    const votes = hub?.votes[m] ?? 0;
    p.text(MODES[m].title, 56, y, { size: 21, color: MODES[m].color, maxW: 270 });
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(344, y - 8, 220, 16);
    ctx.fillStyle = MODES[m].color;
    ctx.fillRect(344, y - 8, (220 * votes) / max, 16);
    p.text(String(votes), 610, y, { size: 22, color: WHITE, align: "right" });
  });

  ctx.fillStyle = "#2c3447";
  ctx.fillRect(668, 124, 3, 464);
  const r = ui.results;
  if (!r) {
    p.text("КАК ИГРАТЬ", 704, 150, { size: 26, color: GREY });
    ["Голосуй за режим", "на цветных площадках.", "", "Встань в зелёный круг —", "раунд начнётся раньше."].forEach((t, i) => p.text(t, 704, 230 + i * 50, { size: 32, color: i < 2 ? WHITE : GREEN, maxW: w - 704 - 56 }));
    return;
  }
  p.text("Прошлый раунд", 704, 150, { size: 32, color: GREY });
  const wc = r.rows.find((row) => row.id === r.winner)?.color ?? GOLD;
  p.text("Победитель", 704, 206, { size: 28, color: GREY });
  p.text(r.winnerName ?? "—", 704, 252, { size: 44, color: wc, pixel: true, maxW: w - 704 - 56, shadow: 4 });
  r.awards.slice(0, 3).forEach((a, i) => {
    const y = 338 + i * 82;
    panelBox(ctx, 696, y - 34, w - 696 - 48, 72);
    p.text(a.title, 712, y - 12, { size: 24, color: GREY, maxW: 480 });
    p.text(a.name, 712, y + 17, { size: 30, color: a.color, maxW: 330 });
    p.text(a.value, w - 64, y + 17, { size: 30, color: WHITE, align: "right", maxW: 200 });
  });
}

const RANK_COLORS = [GOLD, "#d1d5db", "#d89a5a", GREY, GREY];

function drawRecords(p: Painter, w: number, rec: DailyRecords | null) {
  const { ctx } = p;
  p.text("РЕКОРДЫ ДНЯ", w / 2, 84, { size: 48, color: GOLD, pixel: true, align: "center", shadow: 5, maxW: w - 160 });
  if (rec) {
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rec.day);
    p.text(day ? `${day[3]}.${day[2]}.${day[1]}` : rec.day, w / 2, 130, { size: 24, color: GREY, align: "center" });
  }
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)} с`;
  const sections: { title: string; color: string; rows: [string, number][]; limit: number; fmt: (v: number) => string }[] = [
    { title: "ПОБЕДЫ", color: GOLD, rows: rec?.wins ?? [], limit: 5, fmt: String },
    { title: "УБИЙСТВА", color: "#fb7185", rows: rec?.kills ?? [], limit: 5, fmt: String },
    { title: "ТИР", color: "#fbbf24", rows: rec?.range ?? [], limit: 3, fmt: String },
    { title: "ПАРКУР", color: "#67e8f9", rows: rec?.parkour ?? [], limit: 3, fmt: secs },
  ];
  const colW = (w - 96 - 32) / 2;
  const rowH = 52;
  sections.forEach((s, i) => {
    const x = 48 + (i % 2) * (colW + 32);
    const y = i < 2 ? 168 : 168 + 50 + 5 * rowH + 36;
    panelBox(ctx, x, y, colW, 50 + s.limit * rowH + 14);
    p.text(s.title, x + 24, y + 30, { size: 24, color: s.color, pixel: true, shadow: 3 });
    ctx.fillStyle = `${s.color}66`;
    ctx.fillRect(x + 16, y + 52, colW - 32, 3);
    const rows = s.rows.slice(0, s.limit);
    if (!rows.length) p.text("—", x + colW / 2, y + 50 + rowH / 2 + 8, { size: 32, color: GREY, align: "center" });
    rows.forEach(([name, value], k) => {
      const cy = y + 50 + k * rowH + rowH / 2 + 8;
      p.text(String(k + 1), x + 24, cy, { size: 28, color: RANK_COLORS[k], pixel: true });
      const vw = p.text(s.fmt(value), x + colW - 24, cy, { size: 32, color: s.color, align: "right" });
      p.text(p.ellipsize(name, 32, colW - 24 - 76 - vw - 16), x + 76, cy, { size: 32, color: WHITE });
    });
  });
}
