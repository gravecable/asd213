import * as THREE from "three";

// A Minecraft-style sword: a 16×16 sprite extruded one pixel thick (like Minecraft's generated item
// models), held and swung with the same transforms as Minecraft Java (ItemInHandRenderer,
// item/handheld.json and HumanoidModel). The model lives in item space, the unit cube [0, 1]³ with
// the sprite in the z = 0.5 plane: texture x → +x, texture y → −y.

export type SwordKind = "wood" | "stone" | "iron" | "gold" | "diamond" | "netherite";
export const SWORD_KINDS: SwordKind[] = ["wood", "stone", "iron", "gold", "diamond", "netherite"];
export const SWORD_TITLES: Record<SwordKind, string> = {
  wood: "Деревянный",
  stone: "Каменный",
  iron: "Железный",
  gold: "Золотой",
  diamond: "Алмазный",
  netherite: "Незеритовый",
};

/** "modern": Minecraft 1.9+, the sword dips after a hit and comes back up as the cooldown runs out.
 *  "classic": Minecraft 1.8, no dip. */
export type SwingStyle = "modern" | "classic";

export interface SwordStyle {
  kind: SwordKind;
  /** Enchantment glint. */
  glint: boolean;
  swing: SwingStyle;
}

export const swordStyle: SwordStyle = { kind: "diamond", glint: false, swing: "modern" };

export function setSwordStyle(s: Partial<SwordStyle>) {
  Object.assign(swordStyle, s);
}

/** One swing lasts 6 ticks in Minecraft. */
export const SWING_MS = 300;

// ---------------------------------------------------------------- sprite

/** Pixel roles: blade edge (o), bright highlight (H), highlight (h), blade (b), shadow edge (d),
 *  guard (g, G), handle (w, W), pommel (p, P). The blade runs diagonally to the top-right corner. */
function spriteRows(): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 16; y++) {
    let row = "";
    for (let x = 0; x < 16; x++) {
      // Along the blade (towards the tip) and across it.
      const a = x - y;
      const c = x + y;
      let ch = ".";
      if (c >= 13 && c <= 16 && a >= -5) ch = y === 0 ? "o" : c === 14 && a >= 8 ? "H" : "ohbd"[c - 13];
      else if (a === -6 && c >= 10 && c <= 18) ch = "g";
      else if (a === -7 && c >= 11 && c <= 19) ch = "G";
      else if ((c === 14 || c === 15) && a >= -12 && a <= -8) ch = c === 14 ? "w" : "W";
      else if (x <= 1 && y >= 14) ch = (x + y) % 2 ? "p" : "P";
      row += ch;
    }
    rows.push(row);
  }
  return rows;
}

const SPRITE = spriteRows();

const HANDLE = { w: "#8a6a33", W: "#5e4520", p: "#6b511f", P: "#493618" };
const WOOD_GUARD = { g: "#6b4f2a", G: "#4a3420" };

const PALETTES: Record<SwordKind, Record<string, string>> = {
  wood: { o: "#3e2a12", H: "#c49a5a", h: "#a8803f", b: "#8a6534", d: "#5a3f1c", ...WOOD_GUARD, ...HANDLE },
  stone: { o: "#363636", H: "#bdbdbd", h: "#9c9c9c", b: "#7b7b7b", d: "#4a4a4a", ...WOOD_GUARD, ...HANDLE },
  iron: { o: "#464646", H: "#ffffff", h: "#ececec", b: "#c4c4c4", d: "#5e5e5e", g: "#5a5a5a", G: "#383838", ...HANDLE },
  gold: { o: "#6e4a00", H: "#fffbe0", h: "#fff07a", b: "#f2c21f", d: "#a8740a", g: "#c99312", G: "#7a5300", ...HANDLE },
  diamond: { o: "#0d4a42", H: "#e8fffb", h: "#a1fbe8", b: "#2ee6c6", d: "#127a6b", g: "#256b62", G: "#103a34", ...HANDLE },
  netherite: { o: "#171315", H: "#8a7f86", h: "#6b6067", b: "#4c4248", d: "#2a2327", g: "#3a3236", G: "#1a1618", ...HANDLE },
};

/** Each opaque pixel becomes a 1×1×1-pixel cube coloured like the pixel; faces between pixels are
 *  left out. */
function swordGeometry(kind: SwordKind): THREE.BufferGeometry {
  const pal = PALETTES[kind];
  const solid = (x: number, y: number) => x >= 0 && x < 16 && y >= 0 && y < 16 && SPRITE[y][x] !== ".";
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const color = new THREE.Color();
  const quad = (v: number[][], n: number[]) => {
    const o = pos.length / 3;
    for (const p of v) {
      pos.push(p[0], p[1], p[2]);
      nor.push(n[0], n[1], n[2]);
      col.push(color.r, color.g, color.b);
    }
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  const S = 1 / 16;
  const z0 = 7.5 * S;
  const z1 = 8.5 * S;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (!solid(x, y)) continue;
      color.set(pal[SPRITE[y][x]]);
      const x0 = x * S;
      const x1 = (x + 1) * S;
      const y0 = (15 - y) * S;
      const y1 = (16 - y) * S;
      quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]);
      quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1]);
      if (!solid(x - 1, y)) quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0]);
      if (!solid(x + 1, y)) quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0]);
      if (!solid(x, y - 1)) quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0]);
      if (!solid(x, y + 1)) quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------------- glint

/** Shared clock of every glint material (seconds). */
export const glintTime = { value: 0 };

const GLINT_VERT = `
varying vec3 vItem;
void main() {
  vItem = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** Two slanted purple bands sliding over the item, added on top like Minecraft's glint. */
const GLINT_FRAG = `
uniform float uTime;
varying vec3 vItem;
float band(float v) { return pow(0.5 + 0.5 * sin(v * 6.2831853), 6.0); }
void main() {
  float a = band(vItem.x * 1.3 - vItem.y * 0.6 + uTime * 0.35);
  float b = band(vItem.x * 0.5 + vItem.y * 1.4 - uTime * 0.23 + 0.37);
  vec3 c = vec3(0.5, 0.25, 0.85) * (0.18 + 0.9 * max(a, b));
  gl_FragColor = vec4(c, 1.0);
}`;

function glintMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: glintTime },
    vertexShader: GLINT_VERT,
    fragmentShader: GLINT_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
}

/** The sword in item space. `materials`: the Lambert material(s), for fading (invisibility). */
export function createSwordModel(style: SwordStyle = swordStyle, opts: { transparent?: boolean } = {}) {
  const geo = swordGeometry(style.kind);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: !!opts.transparent });
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geo, mat);
  group.add(mesh);
  if (style.glint) {
    const glint = new THREE.Mesh(geo, glintMaterial());
    glint.renderOrder = 1;
    group.add(glint);
  }
  return { group, mesh, materials: [mat] as THREE.Material[] };
}

// ---------------------------------------------------------------- transforms

const D2R = Math.PI / 180;

/** An item display transform from a model's "display" block (translation in pixels). */
function display(rot: [number, number, number], tr: [number, number, number], scale: number) {
  return new THREE.Matrix4()
    .makeTranslation(tr[0] / 16, tr[1] / 16, tr[2] / 16)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0] * D2R, rot[1] * D2R, rot[2] * D2R, "XYZ")))
    .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
    .multiply(new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5));
}

/** item/handheld.json: firstperson_righthand and thirdperson_righthand. */
const FIRST_PERSON = display([0, -90, 25], [1.13, 3.2, 1.13], 0.68);
const THIRD_PERSON = display([0, -90, 55], [0, 4, 0.5], 0.85);

export interface HandPose {
  /** 0..1 through the swing, 0 when not swinging. */
  swing: number;
  /** 0 = fully raised, 1 = lowered out of view. */
  equip: number;
  /** How far the view has turned ahead of the lagging hand, radians, Minecraft signs (pitch down
   *  and yaw right positive). */
  swayPitch: number;
  swayYaw: number;
  /** View bobbing: walked distance (Minecraft's walkDist) and bob amount (0..0.1). */
  walk: number;
  bob: number;
}

const tmp = new THREE.Matrix4();

/** Camera-space matrix of the sword in the right hand: Minecraft's GameRenderer.bobView,
 *  ItemInHandRenderer's sway, swing translation, applyItemArmTransform and applyItemArmAttackTransform,
 *  then the firstperson_righthand display transform. */
export function firstPersonMatrix(out: THREE.Matrix4, p: HandPose): THREE.Matrix4 {
  out.identity();
  if (p.bob > 0) {
    const f = -p.walk * Math.PI;
    out.multiply(tmp.makeTranslation(Math.sin(f) * p.bob * 0.5, -Math.abs(Math.cos(f) * p.bob), 0));
    out.multiply(tmp.makeRotationZ(Math.sin(f) * p.bob * 3 * D2R));
    out.multiply(tmp.makeRotationX(Math.abs(Math.cos(f - 0.2) * p.bob) * 5 * D2R));
  }
  out.multiply(tmp.makeRotationX(p.swayPitch * 0.1));
  out.multiply(tmp.makeRotationY(p.swayYaw * 0.1));
  const s = p.swing;
  const sq = Math.sqrt(s);
  out.multiply(tmp.makeTranslation(-0.4 * Math.sin(sq * Math.PI), 0.2 * Math.sin(sq * Math.PI * 2), -0.2 * Math.sin(s * Math.PI)));
  out.multiply(tmp.makeTranslation(0.56, -0.52 - 0.6 * p.equip, -0.72));
  const f = Math.sin(s * s * Math.PI);
  const g = Math.sin(sq * Math.PI);
  out.multiply(tmp.makeRotationY((45 - 20 * f) * D2R));
  out.multiply(tmp.makeRotationZ(-20 * g * D2R));
  out.multiply(tmp.makeRotationX(-80 * g * D2R));
  out.multiply(tmp.makeRotationY(-45 * D2R));
  return out.multiply(FIRST_PERSON);
}

/** The sword in a model's right hand, relative to the arm's pivot (Minecraft's shoulder joint):
 *  ItemInHandLayer's offsets and thirdperson_righthand. Minecraft's model space has x and y flipped
 *  against ours (a half turn about z); `scale` converts its pixels to the model's. */
export function thirdPersonMatrix(scale: number): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeScale(scale, scale, scale)
    .multiply(new THREE.Matrix4().makeRotationZ(Math.PI))
    .multiply(new THREE.Matrix4().makeRotationX(-90 * D2R))
    .multiply(new THREE.Matrix4().makeRotationY(180 * D2R))
    .multiply(new THREE.Matrix4().makeTranslation(1 / 16, 0.125, -0.625))
    .multiply(THIRD_PERSON);
}

/** Minecraft's HumanoidModel.setupAttackAnimation for the right arm, converted to our model space
 *  (rotation signs: x and y flip, z stays). `t`: 0..1 through the swing; `pitch`: head pitch, up
 *  positive. Returns the torso twist and what to add to the arms' rotations. */
export function attackPose(t: number, pitch: number) {
  // Minecraft's body.yRot.
  const body = Math.sin(Math.sqrt(t) * Math.PI * 2) * 0.2;
  let f = 1 - t;
  f *= f;
  f *= f;
  f = 1 - f;
  const f1 = Math.sin(f * Math.PI);
  const f2 = Math.sin(t * Math.PI) * (pitch + 0.7) * 0.75;
  return {
    /** Our torso rotation.y. */
    bodyY: -body,
    /** Minecraft's twist angle: arm pivots swing round the torso by it. */
    twist: body,
    right: { x: f1 * 1.2 + f2, y: -body - body * 2, z: -0.4 * Math.sin(t * Math.PI) },
    left: { x: -body, y: -body, z: 0 },
  };
}
