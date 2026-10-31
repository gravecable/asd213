import type { MobKind, SkinId } from "../shared";

// Player skins as HD Minecraft skins: Minecraft's 64×64 skin layout, drawn at twice its resolution
// (an 8×8 face has 16×16 texels). Every box has all six faces painted, and the second layer (hair,
// hoods, helmets, armour plates, wraps) sits on slightly bigger boxes, as in Minecraft.

/** Texels per model pixel. */
export const SKIN_RES = 2;
const R = SKIN_RES;
const SIZE = 64 * R;

export type Part = "head" | "body" | "armR" | "armL" | "legR" | "legL";
export type Side = "top" | "bottom" | "right" | "front" | "left" | "back";
export type Layer = "base" | "over";
export const PARTS: Part[] = ["head", "body", "armR", "armL", "legR", "legL"];

/** Minecraft's skin layout: where each box (base and second layer) starts on the 64×64 sheet. */
const ORIGIN: Record<Part, Record<Layer, [number, number]>> = {
  head: { base: [0, 0], over: [32, 0] },
  body: { base: [16, 16], over: [16, 32] },
  armR: { base: [40, 16], over: [40, 32] },
  armL: { base: [32, 48], over: [48, 48] },
  legR: { base: [0, 16], over: [0, 32] },
  legL: { base: [16, 48], over: [0, 48] },
};

/** Box size in model pixels; skeletons have Minecraft's 2 px thin limbs. */
export function partSize(part: Part, thin: boolean): [number, number, number] {
  if (part === "head") return [8, 8, 8];
  if (part === "body") return [8, 12, 4];
  return thin ? [2, 12, 2] : [4, 12, 4];
}

/** A box face on the 64×64 sheet, in model pixels. Faces unfold around the box as in Minecraft:
 *  [right][front][left][back] in a row, top and bottom above the front and the left. */
export function faceRect(part: Part, layer: Layer, side: Side, thin: boolean) {
  const [u, v] = ORIGIN[part][layer];
  const [w, h, d] = partSize(part, thin);
  switch (side) {
    case "top":
      return { x: u + d, y: v, w, h: d };
    case "bottom":
      return { x: u + d + w, y: v, w, h: d };
    case "right":
      return { x: u, y: v + d, w: d, h };
    case "front":
      return { x: u + d, y: v + d, w, h };
    case "left":
      return { x: u + d + w, y: v + d, w: d, h };
    case "back":
      return { x: u + 2 * d + w, y: v + d, w, h };
  }
}

/** Second-layer boxes grow by this much on every side (model pixels): Minecraft's hat and jacket. */
export interface Inflate {
  head: number;
  body: number;
  arm: number;
  leg: number;
}
const LAYER2: Inflate = { head: 0.5, body: 0.25, arm: 0.25, leg: 0.25 };
export const INFLATE: Record<SkinId, Inflate> = {
  steve: LAYER2,
  skeleton: LAYER2,
  zombie: LAYER2,
  // Plate armour stands off further, like Minecraft's armour layer.
  knight: { head: 0.6, body: 0.35, arm: 0.5, leg: 0.35 },
  ninja: LAYER2,
  robot: { head: 0.5, body: 0.25, arm: 0.4, leg: 0.4 },
};

export const HAIRS = ["#3b2416", "#6b4423", "#1f1f1f", "#c58b3c", "#8a2f1b"];
export const hairFor = (id: number) => HAIRS[Math.abs(id) % HAIRS.length];

// ---------------------------------------------------------------- colours

const parsed = new Map<string, [number, number, number]>();

function rgb(c: string): [number, number, number] {
  let v = parsed.get(c);
  if (!v) {
    const m = /^#([0-9a-f]{6})$/i.exec(c);
    const n = m ? parseInt(m[1], 16) : 0x808080;
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    parsed.set(c, v);
  }
  return v;
}

const hex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");

/** Brightness scaled by `f`: shades and highlights of the player's colour. */
export function tint(c: string, f: number) {
  const [r, g, b] = rgb(c);
  return hex(r * f, g * f, b * f);
}

/** Lighter versions blend towards white, so dark colours still get a visible highlight. */
function lift(c: string, t: number) {
  const [r, g, b] = rgb(c);
  return hex(r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t);
}

const spread = (c: string, d = 0.06) => [c, tint(c, 1 - d), tint(c, 1 + d), c];

// ---------------------------------------------------------------- painting

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Drawing on one box face, in texels. Side faces are drawn with x = 0 at the front edge, so the
 *  same code paints the right and the left side. */
class Face {
  constructor(
    private sheet: Sheet,
    private ox: number,
    private oy: number,
    readonly w: number,
    readonly h: number,
    private flip: boolean,
    private onPaint: () => void,
  ) {}

  private each(x: number, y: number, w: number, h: number, fn: (i: number) => void) {
    if (this.flip) x = this.w - x - w;
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.w, x + w);
    const y1 = Math.min(this.h, y + h);
    for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) fn(((this.oy + j) * SIZE + this.ox + i) * 4);
  }

  rect(x: number, y: number, w: number, h: number, c: string) {
    const [r, g, b] = rgb(c);
    const d = this.sheet.data;
    this.onPaint();
    this.each(x, y, w, h, (i) => {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    });
    return this;
  }

  px(x: number, y: number, c: string) {
    return this.rect(x, y, 1, 1, c);
  }

  fill(c: string) {
    return this.rect(0, 0, this.w, this.h, c);
  }

  /** Also mirrored about the face's vertical centre line. */
  sym(x: number, y: number, w: number, h: number, c: string) {
    this.rect(x, y, w, h, c);
    return this.rect(this.w - x - w, y, w, h, c);
  }

  /** Every texel picks one of the colours: Minecraft's grainy shading. */
  noise(pal: string[], x = 0, y = 0, w = this.w, h = this.h) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.px(i, j, pal[Math.floor(this.sheet.rnd() * pal.length)]);
    return this;
  }

  /** Darkens (f < 1) or brightens (f > 1) what's already painted. */
  shade(x: number, y: number, w: number, h: number, f: number) {
    const d = this.sheet.data;
    this.each(x, y, w, h, (i) => {
      if (!d[i + 3]) return;
      d[i] *= f;
      d[i + 1] *= f;
      d[i + 2] *= f;
    });
    return this;
  }

  clear(x: number, y: number, w: number, h: number) {
    const d = this.sheet.data;
    this.each(x, y, w, h, (i) => (d[i + 3] = 0));
    return this;
  }
}

class Sheet {
  readonly data = new Uint8ClampedArray(SIZE * SIZE * 4);
  /** Parts whose second layer got painted (the others need no box), and which faces. */
  readonly layered = new Set<Part>();
  readonly faces = new Set<string>();
  readonly rnd: () => number;

  constructor(
    readonly thin: boolean,
    seed: number,
  ) {
    this.rnd = rng(seed);
  }

  face(part: Part, side: Side, layer: Layer = "base") {
    const r = faceRect(part, layer, side, this.thin);
    const flip = side === "right";
    return new Face(this, r.x * R, r.y * R, r.w * R, r.h * R, flip, () => {
      if (layer !== "over") return;
      this.layered.add(part);
      this.faces.add(`${part}.${side}`);
    });
  }

  /** The four sides, for bands that run all the way round. */
  ring(part: Part, layer: Layer, fn: (f: Face, side: Side) => void) {
    for (const s of ["front", "right", "back", "left"] as Side[]) fn(this.face(part, s, layer), s);
  }

  all(part: Part, layer: Layer, fn: (f: Face, side: Side) => void) {
    for (const s of ["top", "bottom", "front", "right", "back", "left"] as Side[]) fn(this.face(part, s, layer), s);
  }

  /** A limb's faces by role: `outer` faces away from the body, `inner` towards it. */
  limb(part: Part, layer: Layer = "base") {
    const right = part === "armR" || part === "legR";
    return {
      front: this.face(part, "front", layer),
      back: this.face(part, "back", layer),
      outer: this.face(part, right ? "right" : "left", layer),
      inner: this.face(part, right ? "left" : "right", layer),
      top: this.face(part, "top", layer),
      bottom: this.face(part, "bottom", layer),
    };
  }
}

const ARMS: Part[] = ["armR", "armL"];
const LEGS: Part[] = ["legR", "legL"];
const LIMBS: Part[] = [...ARMS, ...LEGS];

interface Look {
  color: string;
  hair: string;
  mob?: MobKind;
}

type Painter = (s: Sheet, o: Look) => void;

/** Inner limb faces and the undersides catch less light. */
function limbShading(s: Sheet) {
  for (const p of LIMBS) {
    const l = s.limb(p);
    l.inner.shade(0, 0, l.inner.w, l.inner.h, 0.9);
    l.bottom.shade(0, 0, l.bottom.w, l.bottom.h, 0.8);
  }
}

const EYE_WHITE = "#f4f4f4";

const steve: Painter = (s, { color, hair }) => {
  const SK = ["#e0ac7e", "#dca779", "#e3b183", "#ddaa7c"];
  const skShade = "#c8936a";
  const skDark = "#a8764f";
  const HR = spread(hair, 0.1);
  const hrDark = tint(hair, 0.7);
  const hrLight = lift(hair, 0.18);
  const SH = spread(color);
  const shDark = tint(color, 0.74);
  const shLight = lift(color, 0.15);
  const PA = ["#2f3a6b", "#2c3664", "#334073", "#2f3a6b"];
  const paDark = "#222a50";
  const SHOE = ["#585858", "#505050", "#5f5f5f"];

  // Head: hair on top and at the back, Steve's face.
  s.all("head", "base", (f) => f.noise(SK));
  s.face("head", "top").noise(HR);
  const face = s.face("head", "front");
  face.shade(0, 4, 16, 2, 0.88);
  face.noise(HR, 0, 0, 16, 4).rect(0, 4, 3, 1, hair).rect(13, 4, 3, 1, hair).px(0, 5, hair).px(15, 5, hair).rect(6, 4, 3, 1, hrDark);
  face.rect(2, 7, 4, 1, hrDark).rect(10, 7, 4, 1, hrDark);
  face.rect(2, 8, 2, 2, EYE_WHITE).rect(4, 8, 2, 2, "#4b3a8f").px(4, 8, "#8676dd").px(5, 9, "#2f235e");
  face.rect(12, 8, 2, 2, EYE_WHITE).rect(10, 8, 2, 2, "#4b3a8f").px(10, 8, "#8676dd").px(11, 9, "#2f235e");
  face.shade(2, 10, 4, 1, 0.93).shade(10, 10, 4, 1, 0.93);
  face.rect(7, 10, 2, 1, "#d39b6f").rect(6, 11, 4, 1, skShade);
  face.rect(5, 13, 6, 1, "#8f5440").rect(6, 13, 4, 1, "#74402f").rect(6, 14, 4, 1, "#cf9870");
  face.shade(0, 15, 16, 1, 0.94);
  for (const side of ["right", "left"] as Side[]) {
    const f = s.face("head", side);
    f.noise(HR, 0, 0, 16, 6).noise(HR, 9, 6, 7, 6).rect(0, 6, 2, 2, hair);
    for (let x = 9; x < 16; x += 2) f.px(x, 12, hair);
    f.rect(5, 8, 3, 4, skShade).rect(6, 9, 1, 2, skDark);
  }
  const back = s.face("head", "back");
  back.noise(HR, 0, 0, 16, 13);
  for (let x = 0; x < 16; x += 2) back.px(x, 13, hair);
  back.shade(0, 13, 16, 3, 0.9);
  s.face("head", "bottom").shade(0, 0, 16, 16, 0.82);

  // Second layer: hair volume and a jagged fringe.
  const top = s.face("head", "top", "over").noise(HR);
  for (const [x, y] of [[3, 4], [9, 2], [12, 9], [6, 11], [10, 13], [2, 9]]) top.px(x, y, hrLight);
  const fringe = s.face("head", "front", "over").noise(HR, 0, 0, 16, 3);
  for (const x of [0, 1, 2, 5, 6, 9, 10, 11, 14, 15]) fringe.px(x, 3, hair);
  for (const side of ["right", "left"] as Side[]) {
    const f = s.face("head", side, "over").noise(HR, 0, 0, 16, 5).noise(HR, 10, 5, 6, 7);
    for (let x = 10; x < 16; x += 2) f.px(x, 12, hair);
  }
  const nape = s.face("head", "back", "over").noise(HR, 0, 0, 16, 12);
  for (let x = 1; x < 16; x += 2) nape.px(x, 12, hair);

  // Shirt, belt and the top of the trousers.
  s.all("body", "base", (f) => f.noise(SH));
  s.ring("body", "base", (f, side) => {
    f.rect(0, 18, f.w, 1, shDark).rect(0, 19, f.w, 2, "#3b2a1c").shade(0, 19, f.w, 1, 1.15).noise(PA, 0, 21, f.w, 3);
    if (side === "right" || side === "left") f.shade(0, 0, f.w, 18, 0.94);
  });
  const chest = s.face("body", "front");
  chest.rect(6, 0, 4, 2, SK[0]).rect(7, 2, 2, 1, SK[0]);
  chest.sym(5, 0, 1, 2, shDark).sym(6, 2, 1, 1, shDark).rect(7, 3, 2, 1, shDark);
  chest.rect(2, 3, 3, 1, shLight).rect(11, 3, 3, 1, shLight);
  chest.rect(4, 12, 1, 5, shDark).rect(11, 13, 1, 4, shDark).shade(0, 14, 16, 4, 0.95);
  chest.rect(7, 19, 2, 2, "#c9a227").px(7, 19, "#f3d36a").rect(7, 21, 1, 3, paDark);
  s.face("body", "back").sym(3, 4, 3, 1, shDark).rect(7, 9, 2, 6, tint(color, 0.88));
  s.face("body", "bottom").noise(PA);

  // Arms: short sleeves, then skin; trousers and shoes.
  for (const p of ARMS) {
    s.all(p, "base", (f) => f.noise(SK));
    s.ring(p, "base", (f) => f.noise(SH, 0, 0, f.w, 8).rect(0, 8, f.w, 1, shDark).shade(0, 20, f.w, 4, 0.94));
    s.face(p, "top").noise(SH);
    s.limb(p).front.shade(2, 22, 1, 2, 0.82).shade(5, 22, 1, 2, 0.82);
    s.ring(p, "over", (f) => f.noise([shLight, color, shLight], 0, 0, f.w, 6).rect(0, 6, f.w, 1, shDark));
    s.face(p, "top", "over").noise([shLight, color]);
  }
  for (const p of LEGS) {
    s.all(p, "base", (f) => f.noise(PA));
    s.ring(p, "base", (f) => f.noise(SHOE, 0, 20, f.w, 4).rect(0, 20, f.w, 1, "#3a3a3a"));
    const l = s.limb(p);
    l.front.shade(4, 3, 1, 12, 0.85).rect(1, 21, 6, 1, "#6a6a6a").shade(0, 11, 8, 1, 1.08);
    l.bottom.fill("#303030");
  }
  limbShading(s);
};

const skeleton: Painter = (s, { color, mob }) => {
  const BONE = ["#d9d6c8", "#d2cebf", "#e2dfd2", "#d6d2c4"];
  const boneShade = "#b3af9f";
  const boneDark = "#8b877a";
  const boneLight = "#ece9de";
  const hollow = "#4d4a43";
  const socket = "#141414";
  const scarf = !mob;
  const SC = spread(color);
  const scDark = tint(color, 0.72);

  // Skull: deep sockets, a nose hole, a row of teeth, a crack and the skull seams.
  s.all("head", "base", (f) => f.noise(BONE));
  const face = s.face("head", "front");
  face.sym(1, 5, 6, 1, boneShade).sym(2, 6, 4, 4, socket).sym(2, 6, 1, 1, "#2c2b27").sym(2, 10, 4, 1, boneShade);
  face.sym(3, 7, 1, 1, "#262522");
  face.rect(7, 10, 2, 2, "#262520").px(6, 11, "#4b4a42").px(9, 11, "#4b4a42");
  face.sym(1, 11, 1, 1, boneShade);
  face.rect(2, 12, 12, 3, "#2e2d28");
  for (let x = 2; x < 14; x += 2) face.px(x, 12, BONE[0]).px(x + 1, 14, BONE[2]);
  face.shade(2, 12, 12, 1, 0.96).rect(1, 15, 14, 1, boneShade);
  face.px(12, 1, boneDark).px(12, 2, boneDark).px(13, 3, boneDark).px(13, 4, boneShade);
  for (const side of ["right", "left"] as Side[]) {
    const f = s.face("head", side);
    f.rect(0, 0, 16, 1, boneShade).shade(2, 5, 6, 4, 0.92).rect(1, 12, 5, 1, boneShade).rect(5, 11, 2, 2, boneDark);
  }
  const top = s.face("head", "top");
  for (let t = 0; t < 16; t++) top.px(7 + (t % 4 < 2 ? 0 : 1), t, boneShade);
  const back = s.face("head", "back");
  for (let t = 0; t < 12; t++) back.px(7 + (t % 4 < 2 ? 0 : 1), t, boneShade);
  back.rect(4, 6, 8, 1, boneShade).shade(0, 13, 16, 3, 0.88);
  s.face("head", "bottom").fill(boneShade).rect(4, 4, 8, 8, hollow);

  // Ribcage over a dark hollow, with spine, collarbones and pelvis.
  s.all("body", "base", (f) => f.fill(hollow));
  s.ring("body", "base", (f, side) => {
    f.noise(BONE, 0, 0, f.w, 2).shade(0, 1, f.w, 1, 0.9);
    const across = side === "right" || side === "left";
    for (const y of [4, 8, 12]) {
      if (across) f.noise(BONE, 0, y, f.w, 2);
      else f.noise(BONE, 1, y, 5, 2).noise(BONE, 10, y, 5, 2);
      f.shade(0, y + 1, f.w, 1, 0.85);
    }
    if (!across) f.noise(BONE, 3, 16, 3, 1).noise(BONE, 10, 16, 3, 1).noise(BONE, 7, 0, 2, 24);
    f.noise(BONE, 0, 20, f.w, 4).shade(0, 23, f.w, 1, 0.85);
    if (!across) f.rect(4, 21, 2, 2, hollow).rect(10, 21, 2, 2, hollow);
  });
  for (const side of ["front", "back"] as Side[]) {
    const f = s.face("body", side);
    for (let y = 2; y < 20; y += 3) f.rect(7, y, 2, 1, boneShade);
  }
  s.face("body", "top").noise(BONE);
  s.face("body", "bottom").noise(BONE).shade(0, 0, 16, 8, 0.85);

  if (scarf) {
    s.ring("body", "base", (f) => f.noise(SC, 0, 0, f.w, 4).rect(0, 3, f.w, 1, scDark));
    s.ring("body", "over", (f) => f.noise(SC, 0, 0, f.w, 3).rect(0, 3, f.w, 1, scDark));
    const tail = s.face("body", "front", "over");
    tail.noise(SC, 10, 3, 3, 7).rect(12, 3, 1, 7, scDark);
    for (let x = 10; x < 13; x += 2) tail.px(x, 10, color);
  }

  // Thin bones with knobbly elbows and knees, fingers and feet.
  for (const p of LIMBS) {
    s.all(p, "base", (f) => f.noise(BONE));
    s.ring(p, "base", (f) => {
      f.rect(0, 11, f.w, 1, boneShade).rect(0, 12, f.w, 1, boneLight).rect(0, 13, f.w, 1, boneShade);
      f.shade(0, 0, f.w, 1, 0.9);
    });
    const l = s.limb(p);
    if (ARMS.includes(p)) l.front.rect(1, 21, 1, 3, boneDark).rect(3, 21, 1, 3, boneDark);
    else {
      s.ring(p, "base", (f) => f.rect(0, 21, f.w, 1, boneShade));
      l.front.px(1, 23, boneDark).px(3, 23, boneDark);
    }
  }
  limbShading(s);

  if (mob === "target") {
    for (const side of ["front", "back"] as Side[]) {
      const f = s.face("body", side).noise(BONE);
      for (let y = 0; y < 24; y++) {
        for (let x = 0; x < 16; x++) {
          const d = Math.hypot(x + 0.5 - 8, y + 0.5 - 12);
          if (d < 8.4) f.px(x, y, d < 2.4 || (d >= 4.6 && d < 6.6) ? (d > 2 && d < 2.4 ? "#a81e1e" : "#d62828") : "#f8f4ea");
        }
      }
    }
  }
};

const zombie: Painter = (s, { color }) => {
  const GR = ["#5e9e4a", "#589848", "#65a652", "#5a9a46"];
  const grDark = "#44783a";
  const grDarker = "#2c4a22";
  const SH = spread(color);
  const shDark = tint(color, 0.7);
  const PA = ["#2a3166", "#262d5e", "#2f376f"];
  const paDark = "#1b1f40";

  // Rotting head: sunken eyes, a broken nose, two crooked teeth.
  s.all("head", "base", (f) => f.noise(GR));
  s.face("head", "top").noise([grDark, "#4a8040", grDark, "#3d6d33"]);
  const face = s.face("head", "front");
  face.noise([grDark, "#4a8040"], 0, 0, 16, 2).px(3, 2, grDark).px(11, 2, grDark);
  face.sym(1, 5, 6, 1, "#4a843f").sym(2, 6, 4, 4, "#14141c").sym(4, 8, 2, 2, "#3b4bb0").px(4, 8, "#7d8ce6").px(10, 8, "#7d8ce6");
  face.rect(6, 10, 4, 2, "#4a8038").px(6, 11, grDarker).px(9, 11, grDarker);
  face.rect(4, 12, 8, 2, grDarker).rect(5, 14, 6, 1, "#3b6630").px(5, 12, "#c9c6a8").px(9, 12, "#c9c6a8");
  face.rect(12, 2, 2, 2, "#4f7f3c").px(13, 3, "#7a2b2b").px(12, 10, "#3a6a2e").px(13, 11, "#3a6a2e");
  for (const side of ["right", "left"] as Side[]) {
    s.face("head", side).noise([grDark, "#4a8040"], 0, 0, 16, 2).rect(5, 8, 3, 4, grDark).px(6, 9, grDarker).px(11, 5, "#4f7f3c");
  }
  s.face("head", "back").noise([grDark, "#4a8040"], 0, 0, 16, 4).rect(5, 8, 3, 2, "#4f7f3c");
  s.face("head", "bottom").shade(0, 0, 16, 16, 0.8);

  // Torn shirt over a green belly, ragged trousers.
  const torn = [2, 4, 3, 5, 2, 3, 5, 4, 2, 4, 3, 2, 5, 3, 4, 2];
  s.all("body", "base", (f) => f.noise(SH));
  s.ring("body", "base", (f, side) => {
    const off = side === "front" ? 0 : side === "back" ? 7 : 3;
    for (let x = 0; x < f.w; x++) f.noise(GR, x, 20 - torn[(x + off) % 16], 1, torn[(x + off) % 16]);
    f.noise(PA, 0, 20, f.w, 4).rect(0, 20, f.w, 1, paDark);
  });
  const chest = s.face("body", "front");
  chest.rect(6, 0, 4, 2, GR[0]).sym(5, 0, 1, 2, shDark).rect(6, 2, 4, 1, shDark);
  chest.noise(GR, 3, 8, 2, 2).rect(3, 10, 2, 1, shDark).noise(GR, 11, 11, 2, 1).px(10, 11, shDark);
  chest.rect(9, 4, 1, 6, shDark).shade(0, 12, 16, 4, 0.94);
  s.face("body", "back").noise(GR, 9, 6, 2, 3).rect(9, 9, 2, 1, shDark);
  s.face("body", "bottom").noise(PA);

  for (const p of ARMS) {
    s.all(p, "base", (f) => f.noise(GR));
    s.ring(p, "base", (f, side) => {
      for (let x = 0; x < f.w; x++) f.noise(SH, x, 0, 1, 7 + ((x + side.length) % 3));
      f.shade(0, 20, f.w, 4, 0.88);
    });
    s.face(p, "top").noise(SH);
    s.limb(p).front.rect(2, 22, 1, 2, grDarker).rect(5, 22, 1, 2, grDarker);
    s.ring(p, "over", (f, side) => {
      for (let x = 0; x < f.w; x++) f.noise(SH, x, 0, 1, 4 + ((x * 3 + side.length) % 4));
    });
  }
  for (const p of LEGS) {
    s.all(p, "base", (f) => f.noise(PA));
    s.ring(p, "base", (f, side) => {
      for (let x = 0; x < f.w; x++) f.noise(GR, x, 17 + ((x + side.length) % 3), 1, 7);
      f.noise([grDark, "#3d6d33"], 0, 21, f.w, 3);
    });
    const l = s.limb(p);
    l.front.rect(1, 9, 4, 3, "#3a4280").px(2, 10, "#5a64a8").px(4, 10, "#5a64a8").px(1, 23, grDarker).px(4, 23, grDarker);
    l.bottom.fill("#3d6d33");
  }
  limbShading(s);
};

const knight: Painter = (s, { color }) => {
  const ST = ["#a6abb2", "#9fa4ab", "#adb2b9", "#a3a8af"];
  const stLight = "#cfd3d8";
  const stHi = "#e6e9ec";
  const stDark = "#6a7079";
  const stDarker = "#474c54";
  const GOLD = "#d9a92b";
  const goldLight = "#f2d06b";
  const goldDark = "#9c7417";
  const MAIL = ["#7e848c", "#6f757d", "#8b9199", "#767c84"];
  const TB = spread(color);
  const tbDark = tint(color, 0.7);
  const LEATHER = "#4a3420";

  const mail = (f: Face, x = 0, y = 0, w = f.w, h = f.h) => {
    f.noise(MAIL, x, y, w, h);
    for (let j = y; j < y + h; j++) for (let i = x + (j % 2); i < x + w; i += 2) f.shade(i, j, 1, 1, 0.78);
  };

  // Under the helmet: a face behind the visor slits.
  s.all("head", "base", (f) => f.fill("#1f2125"));
  s.face("head", "front").rect(2, 5, 12, 5, "#e0ac7e").shade(2, 5, 12, 1, 0.6).rect(3, 6, 3, 2, EYE_WHITE).rect(10, 6, 3, 2, EYE_WHITE);
  s.face("head", "front").rect(4, 6, 2, 2, "#3a4a9a").px(4, 6, "#7686d8").rect(10, 6, 2, 2, "#3a4a9a").px(10, 6, "#7686d8");

  // Great helm: centre ridge, two visor slits you can see into, breathing holes, rivets.
  s.ring("head", "over", (f) => f.noise(ST).rect(0, 0, f.w, 1, stLight).rect(0, 15, f.w, 1, stDarker));
  const helm = s.face("head", "front", "over");
  helm.rect(7, 0, 1, 15, stHi).rect(8, 0, 1, 15, stLight).rect(9, 1, 1, 14, stDark);
  helm.clear(2, 6, 5, 2).clear(10, 6, 4, 2).rect(2, 5, 5, 1, stDarker).rect(10, 5, 4, 1, stDarker).rect(2, 8, 5, 1, stLight).rect(10, 8, 4, 1, stLight);
  for (const [x, y] of [[3, 11], [5, 11], [3, 13], [5, 13], [11, 11], [13, 11], [11, 13], [13, 13]]) helm.px(x, y, "#2a2d33");
  helm.px(1, 2, stHi).px(14, 2, stHi).rect(0, 14, 16, 1, goldDark).px(7, 14, GOLD).px(8, 14, goldLight);
  for (const side of ["right", "left"] as Side[]) {
    const f = s.face("head", side, "over");
    f.rect(0, 10, 16, 1, stDark).rect(0, 11, 16, 1, stLight).rect(2, 7, 2, 2, stLight).px(3, 8, stDarker);
    f.rect(10, 12, 6, 1, stDark).rect(0, 14, 16, 1, goldDark);
  }
  const nape = s.face("head", "back", "over");
  nape.rect(7, 0, 2, 9, stLight).rect(0, 9, 16, 1, stDark).rect(0, 10, 16, 1, stLight).rect(0, 12, 16, 1, stDark).rect(0, 13, 16, 1, stLight);
  s.face("head", "top", "over").noise(ST).rect(7, 0, 2, 16, stLight).rect(9, 0, 1, 16, stDark).px(2, 2, stHi).px(13, 13, stHi);

  // Mail shirt under a tabard in the player's colour with a gold cross and a belt.
  s.all("body", "base", (f) => mail(f));
  for (const side of ["front", "back"] as Side[]) {
    const f = s.face("body", side);
    f.noise(TB, 2, 1, 12, 21).rect(2, 1, 1, 21, tbDark).rect(13, 1, 1, 21, tbDark).rect(2, 21, 12, 1, GOLD);
    mail(f, 7, 17, 2, 5);
    if (side === "front") {
      f.rect(7, 4, 2, 9, GOLD).rect(4, 7, 8, 2, GOLD).rect(8, 4, 1, 9, goldDark).rect(4, 8, 8, 1, goldDark).px(7, 4, goldLight).px(4, 7, goldLight);
    }
  }
  s.ring("body", "base", (f) => f.rect(0, 14, f.w, 2, LEATHER));
  s.face("body", "top").noise(ST);
  s.face("body", "bottom").noise(MAIL);
  // Gorget and belt stand off the body.
  s.ring("body", "over", (f, side) => {
    f.noise(ST, 0, 0, f.w, 2).rect(0, 2, f.w, 1, stDark).rect(0, 0, f.w, 1, stLight);
    if (side === "front") f.clear(5, 0, 6, 1);
    f.rect(0, 14, f.w, 2, LEATHER).shade(0, 14, f.w, 1, 1.25);
  });
  s.face("body", "front", "over").rect(7, 14, 2, 2, GOLD).px(7, 14, goldLight);

  // Pauldrons, elbow cops, gauntlets; knee cops, greaves, sabatons.
  for (const p of ARMS) {
    s.all(p, "base", (f) => mail(f));
    s.ring(p, "base", (f) => f.noise(ST, 0, 16, f.w, 8).rect(0, 16, f.w, 1, stLight).rect(0, 20, f.w, 1, stDark));
    s.limb(p).front.rect(2, 21, 1, 3, stDark).rect(5, 21, 1, 3, stDark);
    s.face(p, "bottom").noise(ST);
    const o = s.limb(p, "over");
    s.ring(p, "over", (f) => {
      f.noise(ST, 0, 0, f.w, 7).rect(0, 0, f.w, 1, stHi).rect(0, 2, f.w, 1, stDark).rect(0, 4, f.w, 1, stDark).rect(0, 6, f.w, 1, stDarker);
      f.rect(0, 16, f.w, 2, stLight).rect(0, 17, f.w, 1, ST[0]);
    });
    o.top.noise(ST).rect(0, 0, o.top.w, 1, stHi);
    o.outer.px(3, 1, GOLD).px(4, 1, goldLight).noise(ST, 1, 10, 6, 4).rect(1, 10, 6, 1, stLight).rect(1, 13, 6, 1, stDark).px(4, 11, GOLD);
  }
  for (const p of LEGS) {
    s.all(p, "base", (f) => mail(f));
    s.ring(p, "base", (f) => f.noise(ST, 0, 13, f.w, 11).rect(0, 13, f.w, 1, stLight).rect(0, 23, f.w, 1, stDarker));
    s.face(p, "bottom").fill(stDarker);
    const o = s.limb(p, "over");
    o.front.noise(ST, 1, 9, 6, 4).rect(1, 9, 6, 1, stHi).rect(1, 12, 6, 1, stDark).px(3, 10, GOLD).px(4, 10, goldLight);
    o.outer.noise(ST, 2, 10, 4, 2).rect(2, 10, 4, 1, stLight);
    s.ring(p, "over", (f) => f.noise(ST, 0, 20, f.w, 4).rect(0, 20, f.w, 1, stLight).rect(0, 22, f.w, 1, stDark));
    o.front.rect(2, 21, 4, 1, stHi);
  }
  limbShading(s);
};

const ninja: Painter = (s, { color }) => {
  const CL = ["#1b1b24", "#1f1f29", "#17171f", "#1d1d26"];
  const fold = "#2c2c3a";
  const foldLight = "#3a3a4c";
  const BD = spread(color, 0.08);
  const bdDark = tint(color, 0.68);
  const bdLight = lift(color, 0.2);
  const WRAP = ["#cfc9b8", "#c6c0ae", "#d8d2c2"];
  const wrapShade = "#a39d8c";
  const PLATE = ["#9aa3ad", "#a6aeb7"];

  const wraps = (f: Face, y: number, h: number) => {
    f.noise(WRAP, 0, y, f.w, h);
    for (let j = y; j < y + h; j++) for (let i = 0; i < f.w; i++) if ((i + j * 2) % 5 === 0) f.px(i, j, wrapShade);
    f.rect(0, y + h - 1, f.w, 1, wrapShade);
  };

  // Face under the hood: only the eyes show.
  s.all("head", "base", (f) => f.noise(CL));
  const face = s.face("head", "front");
  face.rect(1, 6, 14, 4, "#e0ac7e").shade(1, 6, 14, 1, 0.8).shade(1, 9, 14, 1, 0.9);
  face.rect(3, 7, 3, 2, EYE_WHITE).rect(10, 7, 3, 2, EYE_WHITE).rect(4, 7, 2, 2, "#1a1a22").rect(10, 7, 2, 2, "#1a1a22");
  face.px(4, 7, "#5a5a70").px(10, 7, "#5a5a70").rect(3, 6, 3, 1, "#2a1f18").rect(10, 6, 3, 1, "#2a1f18").px(6, 7, "#2a1f18").px(9, 7, "#2a1f18");

  // Hood and mask: an opening for the eyes, folds, a headband with a metal plate.
  s.all("head", "over", (f, side) => {
    if (side === "bottom") return;
    f.noise(CL);
    if (side !== "top") f.noise(BD, 0, 2, f.w, 3).rect(0, 2, f.w, 1, bdLight).rect(0, 4, f.w, 1, bdDark);
  });
  const mask = s.face("head", "front", "over");
  mask.clear(1, 6, 14, 4).rect(1, 11, 14, 1, fold).rect(2, 13, 12, 1, fold).rect(6, 12, 4, 1, foldLight).rect(0, 5, 16, 1, fold);
  mask.noise(PLATE, 5, 2, 6, 3).rect(5, 2, 6, 1, "#c8d0d8").rect(5, 4, 6, 1, "#6a727b").px(7, 3, "#4b535c").px(8, 3, "#4b535c");
  for (const side of ["right", "left"] as Side[]) {
    const f = s.face("head", side, "over");
    for (let t = 0; t < 6; t++) f.px(9 + t, 9 + t, fold).px(3 + t, 8 + t, fold);
  }
  s.face("head", "back", "over").rect(6, 1, 4, 5, bdDark).rect(7, 2, 2, 3, color).rect(0, 10, 16, 1, fold);
  s.face("head", "top", "over").rect(7, 0, 2, 16, fold);

  // Gi with crossed lapels, an obi with a knot and hanging ends.
  s.all("body", "base", (f) => f.noise(CL));
  const gi = s.face("body", "front");
  for (let y = 0; y < 10; y++) {
    const x = Math.round((y * 5) / 9);
    gi.rect(12 - x, y, 2, 1, fold).rect(2 + x, y, 2, 1, foldLight);
  }
  gi.rect(4, 18, 1, 6, fold).rect(11, 19, 1, 5, fold);
  s.ring("body", "base", (f) => f.noise(BD, 0, 14, f.w, 3).rect(0, 14, f.w, 1, bdLight).rect(0, 16, f.w, 1, bdDark));
  s.ring("body", "over", (f) => f.noise(BD, 0, 14, f.w, 3).rect(0, 14, f.w, 1, bdLight).rect(0, 16, f.w, 1, bdDark));
  s.face("body", "front", "over").rect(6, 13, 4, 5, bdDark).noise(BD, 7, 14, 2, 3).rect(6, 18, 1, 4, color).rect(9, 18, 1, 3, bdDark);
  s.face("body", "back").rect(7, 3, 2, 9, fold);

  // Sleeves with wrist wraps and dark gloves; trousers, shin wraps and split-toe tabi.
  for (const p of ARMS) {
    s.all(p, "base", (f) => f.noise(CL));
    s.ring(p, "base", (f) => {
      wraps(f, 14, 5);
      f.noise(["#26262f", "#2a2a33"], 0, 19, f.w, 5);
    });
    s.limb(p).front.rect(2, 21, 1, 3, "#15151b").rect(5, 21, 1, 3, "#15151b");
    s.ring(p, "base", (f) => f.rect(0, 7, f.w, 1, fold));
    s.ring(p, "over", (f) => wraps(f, 14, 5));
  }
  for (const p of LEGS) {
    s.all(p, "base", (f) => f.noise(CL));
    s.ring(p, "base", (f) => {
      wraps(f, 12, 7);
      f.noise(["#121218", "#16161d"], 0, 19, f.w, 5).rect(0, 5, f.w, 1, fold);
    });
    s.limb(p).front.rect(2, 21, 1, 3, foldLight);
    s.face(p, "bottom").fill("#0e0e12");
    s.ring(p, "over", (f) => wraps(f, 12, 7));
  }
  limbShading(s);
};

const robot: Painter = (s, { color }) => {
  const MT = ["#9aa3ad", "#949da7", "#a1aab4", "#97a0aa"];
  const mLight = "#cdd5dc";
  const mHi = "#e8edf1";
  const mDark = "#4b535c";
  const mDarker = "#2a2f35";
  const joint = "#6a727b";
  const LED = "#ff2a2a";
  const GREEN = "#46e08a";
  const ac = color;
  const acDark = tint(color, 0.62);
  const acLight = lift(color, 0.3);

  const bolt = (f: Face, x: number, y: number) => f.px(x, y, mHi).px(x + 1, y + 1, mDark);

  // Head: a recessed screen with glowing eyes, a speaker grille, bolts and vents.
  s.all("head", "base", (f) => f.noise(MT));
  const face = s.face("head", "front");
  face.rect(0, 0, 16, 1, mLight).rect(1, 3, 14, 8, "#1d2127");
  for (const y of [4, 6, 8, 10]) face.rect(1, y, 14, 1, "#232830");
  face.rect(3, 5, 3, 3, LED).px(3, 5, "#ffb3b3").rect(10, 5, 3, 3, LED).px(10, 5, "#ffb3b3").rect(3, 8, 3, 1, "#6a1010").rect(10, 8, 3, 1, "#6a1010");
  for (let x = 4; x < 12; x++) face.rect(x, 12, 1, 3, x % 2 ? mDark : "#aeb7c0");
  face.rect(3, 12, 1, 3, mDark).rect(12, 12, 1, 3, mDark);
  bolt(face, 1, 13);
  bolt(face, 13, 13);
  for (const side of ["right", "left"] as Side[]) s.face("head", side).rect(0, 0, 16, 1, mLight).rect(4, 4, 8, 8, mDark).rect(0, 14, 16, 1, mDark);
  const back = s.face("head", "back");
  for (const y of [3, 5, 7, 9]) back.rect(3, y, 10, 1, mDarker);
  back.rect(6, 12, 4, 2, mDark).px(7, 12, GREEN);
  s.face("head", "top").rect(3, 3, 10, 10, mDark).noise(MT, 4, 4, 8, 8).rect(7, 7, 2, 2, mDarker);
  s.face("head", "bottom").fill(mDark);

  // Second layer: a frame round the screen and the ear bolts.
  const frame = s.face("head", "front", "over");
  frame.rect(0, 2, 16, 1, mHi).rect(0, 11, 16, 1, mDark).rect(0, 2, 1, 10, mLight).rect(15, 2, 1, 10, mDark);
  for (const side of ["right", "left"] as Side[]) {
    s.face("head", side, "over").rect(5, 5, 6, 6, mLight).rect(5, 10, 6, 1, mDark).rect(10, 5, 1, 6, mDark).rect(7, 7, 2, 2, mDarker).px(7, 7, ac);
  }

  // Chest panel in the player's colour with a glowing core, status lights, a battery on the back.
  s.all("body", "base", (f) => f.noise(MT));
  const chest = s.face("body", "front");
  chest.rect(1, 1, 14, 13, acDark).noise(spread(ac), 2, 2, 12, 11).rect(2, 2, 12, 1, acLight).rect(2, 2, 1, 11, lift(ac, 0.15));
  chest.rect(2, 12, 12, 1, tint(ac, 0.78)).rect(13, 2, 1, 11, tint(ac, 0.8)).rect(6, 5, 4, 4, lift(ac, 0.55)).rect(7, 6, 2, 2, "#ffffff");
  chest.px(3, 15, GREEN).px(5, 15, "#f5c542").px(7, 15, LED);
  for (const x of [3, 6, 9, 12]) chest.rect(x, 18, 1, 5, mDark);
  s.ring("body", "base", (f) => f.rect(0, 17, f.w, 1, mDark).rect(0, 23, f.w, 1, mDarker).rect(0, 0, f.w, 1, mLight));
  const pack = s.face("body", "back");
  pack.rect(3, 2, 10, 12, mDark).rect(5, 4, 6, 8, "#20262c");
  for (const y of [5, 7, 9]) pack.rect(6, y, 4, 1, GREEN);
  pack.rect(6, 11, 4, 1, "#1f6e44");
  for (const side of ["right", "left"] as Side[]) {
    const f = s.face("body", side);
    for (const y of [4, 6, 8, 10]) f.rect(2, y, 4, 1, mDarker);
  }

  // Segmented limbs: shoulder ring, elbow and knee joints, accent stripes, heavy hands and feet.
  for (const p of ARMS) {
    s.all(p, "base", (f) => f.noise(MT));
    s.ring(p, "base", (f) => {
      f.rect(0, 0, f.w, 1, mLight).rect(0, 3, f.w, 1, mDark).rect(0, 10, f.w, 4, mDark).rect(0, 11, f.w, 2, joint);
      f.rect(0, 15, f.w, 1, ac).noise([joint, "#646c75"], 0, 20, f.w, 4).rect(0, 20, f.w, 1, mDark);
    });
    s.limb(p).front.rect(2, 21, 1, 3, mDarker).rect(5, 21, 1, 3, mDarker);
    s.face(p, "bottom").fill(joint);
    s.ring(p, "over", (f) => f.rect(0, 10, f.w, 4, mDark).rect(0, 10, f.w, 1, mLight).px(1, 11, mHi).px(f.w - 2, 11, mHi));
  }
  for (const p of LEGS) {
    s.all(p, "base", (f) => f.noise(MT));
    s.ring(p, "base", (f) => {
      f.rect(0, 0, f.w, 1, mDark).rect(0, 9, f.w, 4, mDark).rect(0, 10, f.w, 2, joint).rect(0, 15, f.w, 1, ac);
      f.noise(["#5a626b", "#545c65"], 0, 19, f.w, 5).rect(0, 19, f.w, 1, mDark).rect(0, 23, f.w, 1, mDarker);
    });
    s.face(p, "bottom").fill(mDarker);
    s.ring(p, "over", (f) => {
      f.rect(0, 9, f.w, 4, mDark).rect(0, 9, f.w, 1, mLight);
      f.noise(["#5a626b", "#606872"], 0, 20, f.w, 4).rect(0, 20, f.w, 1, mLight).rect(0, 23, f.w, 1, mDarker);
    });
    s.limb(p, "over").front.rect(1, 21, 6, 1, "#7a838c");
  }
  limbShading(s);
};

const PAINTERS: Record<SkinId, Painter> = { steve, skeleton, zombie, knight, ninja, robot };

export interface SkinSheet {
  canvas: HTMLCanvasElement;
  /** Parts with a second layer, and its painted faces ("head.top"). */
  layered: Set<Part>;
  faces: Set<string>;
  thin: boolean;
}

const cache = new Map<string, SkinSheet>();

/** The skin sheet for a look, painted once and shared. */
export function skinSheet(skin: SkinId, look: Look): SkinSheet {
  const key = `${skin}|${look.color}|${look.hair}|${look.mob ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const thin = skin === "skeleton";
  let seed = 7;
  for (const ch of key) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const s = new Sheet(thin, seed);
  for (const p of PARTS) s.all(p, "base", (f) => f.fill("#808080"));
  PAINTERS[skin](s, look);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  canvas.getContext("2d")!.putImageData(new ImageData(s.data, SIZE, SIZE), 0, 0);
  const sheet = { canvas, layered: s.layered, faces: s.faces, thin };
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  cache.set(key, sheet);
  return sheet;
}

/** The face with its second layer, for the wardrobe: a data URL of a 16×16 image. */
export function skinFaceUrl(skin: SkinId, color: string, hair: string): string {
  const { canvas, thin } = skinSheet(skin, { color, hair });
  const c = document.createElement("canvas");
  c.width = c.height = 8 * R;
  const ctx = c.getContext("2d")!;
  for (const layer of ["base", "over"] as Layer[]) {
    const r = faceRect("head", layer, "front", thin);
    ctx.drawImage(canvas, r.x * R, r.y * R, 8 * R, 8 * R, 0, 0, 8 * R, 8 * R);
  }
  return c.toDataURL();
}
