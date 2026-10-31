import * as THREE from "three";
import { EYE_HEIGHT, MAX_HP, type MobKind, type SkinId } from "../shared";
import { SWING_MS, attackPose, createSwordModel, thirdPersonMatrix } from "./sword";
import { INFLATE, faceRect, hairFor, partSize, skinSheet, tint } from "./skins";
import type { Layer, Part, Side } from "./skins";
import { labelTexture } from "./textures";

const PX = 1.8 / 32; // Minecraft proportions: a player is 32 "pixels" tall

const SKIN = "#e0ac7e";
const BONE = ["#d9d6c8", "#b9b5a3", "#f0ede0", "#8d8979"];
/** Keeps nearest sampling at a face's edge off the next face's texels (model pixels). */
const UV_INSET = 0.01;
const MOB_WEAPON: Record<MobKind, "sword" | "bow" | "none"> = {
  dummy: "none",
  walker: "sword",
  archer: "bow",
  cliff: "none",
  target: "none",
};
/** Archers hold the bow out in front of them, like Minecraft skeletons. */
const BOW_AIM = 1.35;
/** Minecraft's arm joint sits 5 px out from the middle and 2 px below the shoulder top. */
const ARM_X = 5;
const ARM_Y = 22;
/** The sword in hand, relative to that joint (our model is 0.9 the size of Minecraft's). */
const SWORD_IN_HAND = thirdPersonMatrix(PX * 16);
const ZOMBIE_TINT = new THREE.Color("#8fd47a");
/** A faint green glow on top: a multiply alone only darkens a tan skin into olive. */
const ZOMBIE_GLOW = 0.08;
/** Zombies reach out in front of them, like Minecraft's. */
const ZOMBIE_ARMS = 1.45;
const MARK_RED = new THREE.Color("#ff2a1a");
const MARK_GOLD = new THREE.Color("#ffd23f");
/** Above every world-space overlay (damage numbers use 1000). */
const TOP_ORDER = 1001;

export interface AvatarOpts {
  skin?: SkinId;
  weapon?: "sword" | "bow" | "none";
  mob?: MobKind;
  /** Name label colour; defaults to the body colour. */
  labelColor?: string;
  /** No name tag (your own model in third person). */
  noLabel?: boolean;
}

function box(w: number, h: number, d: number, mat: THREE.Material | THREE.Material[]) {
  const g = new THREE.BoxGeometry(w * PX, h * PX, d * PX);
  g.translate(0, (-h * PX) / 2, 0); // pivot at the top (shoulder / hip)
  return new THREE.Mesh(g, mat);
}

/** A body part on the skin sheet, mapped like Minecraft's model boxes; the second layer is the same
 *  box grown by `grow` pixels on every side. Pivot at the top. */
function skinBox(part: Part, layer: Layer, thin: boolean, grow: number) {
  const [w, h, d] = partSize(part, thin);
  const g = new THREE.BoxGeometry((w + 2 * grow) * PX, (h + 2 * grow) * PX, (d + 2 * grow) * PX);
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const nx = nor.getX(i);
    const ny = nor.getY(i);
    const nz = nor.getZ(i);
    const side: Side = nx > 0.5 ? "right" : nx < -0.5 ? "left" : ny > 0.5 ? "top" : ny < -0.5 ? "bottom" : nz > 0.5 ? "back" : "front";
    const x = pos.getX(i) > 0 ? 1 : 0;
    const y = pos.getY(i) > 0 ? 1 : 0;
    const z = pos.getZ(i) > 0 ? 1 : 0;
    // Where the corner lands on the face's texture (0..1 from its top-left): the model faces -Z, +X is
    // its right, and the faces unfold around the box as on a Minecraft skin.
    const [s, t] =
      side === "right" ? [1 - z, 1 - y] : side === "left" ? [z, 1 - y] : side === "front" ? [1 - x, 1 - y] : side === "back" ? [x, 1 - y] : side === "top" ? [1 - x, 1 - z] : [1 - x, z];
    const r = faceRect(part, layer, side, thin);
    const u = r.x + UV_INSET + s * (r.w - 2 * UV_INSET);
    const v = r.y + UV_INSET + t * (r.h - 2 * UV_INSET);
    uv.setXY(i, u / 64, 1 - v / 64);
  }
  g.translate(0, (-h * PX) / 2, 0);
  return g;
}

/** A face of the TNT block on the head: red sticks with a white band, or the tan top. */
function tntTexture(cap: boolean) {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  if (cap) {
    g.fillStyle = "#a08a5c";
    g.fillRect(0, 0, 32, 32);
    g.fillStyle = "#d8c493";
    g.fillRect(1, 1, 30, 30);
    g.fillStyle = "#7a6a48";
    g.fillRect(12, 12, 8, 8);
    g.fillStyle = "#111111";
    g.fillRect(15, 15, 2, 2);
  } else {
    g.fillStyle = "#c62828";
    g.fillRect(0, 0, 32, 32);
    g.fillStyle = "#a31d1d";
    for (let x = 3; x < 32; x += 8) g.fillRect(x, 0, 1, 32);
    g.fillStyle = "#f2f2ee";
    g.fillRect(0, 10, 32, 12);
    g.fillStyle = "#111111";
    g.font = "bold 11px monospace";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("TNT", 16, 16.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Bow centred on its grip: limbs run along Y, the string side faces +Z (towards the archer). */
export function createBow(depthTest = true) {
  const g = new THREE.Group();
  const mk = (color: string) => new THREE.MeshLambertMaterial({ color, depthTest });
  const limbs = [mk("#8a5a2b"), mk("#7a4f26"), mk("#6b4423")];
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.06), mk("#4a2f17"));
  g.add(grip);
  const len = 0.14;
  for (const s of [1, -1]) {
    let y = 0.08;
    let z = 0;
    [0.1, 0.35, 0.7].forEach((a, i) => {
      const seg = new THREE.Mesh(new THREE.BoxGeometry(0.05, len, 0.05), limbs[i]);
      seg.position.set(0, s * (y + (Math.cos(a) * len) / 2), z + (Math.sin(a) * len) / 2);
      seg.rotation.x = s * a;
      g.add(seg);
      y += Math.cos(a) * len;
      z += Math.sin(a) * len;
    });
    if (s === 1) {
      const string = new THREE.Mesh(new THREE.BoxGeometry(0.012, 2 * y, 0.012), mk("#f0ede0"));
      string.position.z = z;
      g.add(string);
    }
  }
  if (!depthTest) g.traverse((o) => (o.renderOrder = 999));
  return g;
}

export class Avatar {
  readonly group = new THREE.Group();
  readonly pos = new THREE.Vector3();
  readonly target = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  targetYaw = 0;
  targetPitch = 0;
  hp = MAX_HP;
  maxHp = MAX_HP;
  /** How fast the model catches up with its target (1/s); Infinity puts it there at once. */
  followRate = 14;
  /** Horizontal speed of the drawn model, blocks/s. */
  moveSpeed = 0;
  private showLabel: boolean;
  /** Everything but the label: scaled as a whole (giant / small buffs). */
  private pivot = new THREE.Group();
  private head = new THREE.Group();
  private crown = new THREE.Group();
  /** Antenna or plume: hidden under a crown. */
  private headgear = new THREE.Group();
  /** A ninja's headband tails. */
  private tails: THREE.Mesh[] = [];
  private armL: THREE.Group;
  private armR: THREE.Group;
  private legL: THREE.Group;
  private legR: THREE.Group;
  private label: THREE.Sprite;
  private body: THREE.Group;
  private materials: THREE.MeshLambertMaterial[] = [];
  private weaponMaterials: THREE.Material[] = [];
  private sword = false;
  private walk = 0;
  private swingAt = -1e9;
  private hurtAt = -1e9;
  private initialized = false;
  private dyingSince = 0;
  private fallDir = 1;
  private bow = false;
  private labelCol: string;
  private headTop = 8;
  private scaleTarget = 1;
  private scaleNow = 1;
  private ticked = false;
  private zombie = false;
  /** Meshes that cast a shadow, switched off while their player is invisible. */
  private shadowCasters: THREE.Object3D[] | null = null;
  private zombieOrig = new Map<THREE.MeshLambertMaterial, THREE.Color>();
  private noTint = new Set<THREE.Material>();
  private marked = false;
  private marker?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  private labelOnTop = false;
  private bomb?: THREE.Mesh;
  private bombMats: THREE.MeshLambertMaterial[] = [];
  private bombTextures: THREE.Texture[] = [];
  private bombOn = false;
  private bombFuse = 1;
  private bombPhase = 0;
  readonly skin: SkinId;
  readonly mob?: MobKind;
  /** Body colours, used for the death burst. */
  readonly palette: string[];

  constructor(
    readonly id: number,
    readonly name: string,
    readonly color: string,
    opts: AvatarOpts = {},
  ) {
    this.mob = opts.mob;
    this.showLabel = !opts.noLabel;
    this.skin = opts.mob ? "skeleton" : (opts.skin ?? "steve");
    this.labelCol = opts.labelColor ?? color;
    const weapon = opts.weapon ?? (opts.mob ? MOB_WEAPON[opts.mob] : "sword");
    const hair = hairFor(id);
    this.palette = this.paletteFor(hair);

    const sheet = skinSheet(this.skin, { color, hair, mob: this.mob });
    const thin = sheet.thin;
    const lw = thin ? 2 : 4;
    // Crisp at any distance, like Minecraft's entity textures: no mipmaps.
    const map = new THREE.CanvasTexture(sheet.canvas);
    map.magFilter = THREE.NearestFilter;
    map.minFilter = THREE.NearestFilter;
    map.generateMipmaps = false;
    map.colorSpace = THREE.SRGBColorSpace;
    const baseMat = this.mat({ map });
    // The second layer is cut out and seen from inside through its gaps, like Minecraft's hat layer.
    const overMat = this.mat({ map, alphaTest: 0.01, side: THREE.DoubleSide });
    const grow = INFLATE[this.skin];
    const part = (p: Part, by: number, x = 0, y = 0) => {
      const g = new THREE.Group();
      for (const layer of ["base", "over"] as Layer[]) {
        if (layer === "over" && !sheet.layered.has(p)) continue;
        const m = new THREE.Mesh(skinBox(p, layer, thin, layer === "over" ? by : 0), layer === "over" ? overMat : baseMat);
        m.position.set(x * PX, y * PX, 0);
        m.castShadow = layer === "base";
        g.add(m);
      }
      return g;
    };

    this.head.add(part("head", grow.head, 0, 8));
    this.head.position.y = 24 * PX;
    const headTop = sheet.faces.has("head.top") ? 8 + grow.head : 8;
    this.headTop = headTop;
    this.buildCrown(headTop);
    this.head.add(this.crown, this.headgear);
    if (this.skin === "robot") this.buildAntenna();
    if (this.skin === "knight") this.buildPlume(headTop);
    if (this.skin === "ninja") this.buildTails(8 + grow.head);

    const body = part("body", grow.body);
    body.position.y = 24 * PX;
    this.body = body;
    // Arms turn about Minecraft's joint, so the swing and the sword in hand line up with it.
    const out = 4 + lw / 2 - ARM_X;
    this.armL = part("armL", grow.arm, -out, 24 - ARM_Y);
    this.armL.position.set(-ARM_X * PX, ARM_Y * PX, 0);
    this.armR = part("armR", grow.arm, out, 24 - ARM_Y);
    this.armR.position.set(ARM_X * PX, ARM_Y * PX, 0);
    this.armL.rotation.order = this.armR.rotation.order = "ZYX";
    this.legL = part("legL", grow.leg);
    this.legL.position.set(-2 * PX, 12 * PX, 0);
    this.legR = part("legR", grow.leg);
    this.legR.position.set(2 * PX, 12 * PX, 0);

    if (weapon === "sword") {
      const { group } = createSwordModel(undefined, { transparent: true });
      group.matrixAutoUpdate = false;
      group.matrix.copy(SWORD_IN_HAND);
      this.armR.add(group);
      this.trackWeapon(group);
      this.sword = true;
    } else if (weapon === "bow") {
      const bow = createBow();
      bow.scale.setScalar(0.8);
      bow.position.set(out * PX, -9 * PX, 0);
      bow.rotation.x = -Math.PI / 2; // upright once the arm is raised forward
      this.armR.add(bow);
      this.trackWeapon(bow);
      this.bow = true;
    }

    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(name, this.labelCol, 1), transparent: true }));
    this.label.scale.set(1.6, 0.45, 1);
    this.label.position.y = 2.2;

    this.pivot.add(this.head, body, this.armL, this.armR, this.legL, this.legR);
    this.group.add(this.pivot, this.label);
    this.group.rotation.order = "YXZ"; // yaw first, so a death roll tips the body sideways
  }

  private mat(o: THREE.MeshLambertMaterialParameters) {
    const m = new THREE.MeshLambertMaterial({ ...o, transparent: true });
    this.materials.push(m);
    return m;
  }

  private trackWeapon(w: THREE.Object3D) {
    w.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const m = o.material as THREE.Material;
      this.weaponMaterials.push(m);
      // Additive overlays (the glint) fade by themselves with the base; the rest fades like the body.
      if (m.blending === THREE.NormalBlending) m.transparent = true;
    });
  }

  private paletteFor(hair: string) {
    const { color } = this;
    switch (this.skin) {
      case "skeleton":
        return this.mob ? BONE : [BONE[0], BONE[1], BONE[2], color];
      case "zombie":
        return [color, "#5e9e4a", "#2a3166", "#3f6f33"];
      case "knight":
        return ["#a9aeb5", color, "#6a7079", "#cfd3d8"];
      case "ninja":
        return ["#1b1b24", color, "#2e2e3a", SKIN];
      case "robot":
        return ["#9aa3ad", color, "#4b535c", "#ff3b3b"];
      default:
        return [color, SKIN, "#2f3a6b", hair];
    }
  }

  private buildAntenna() {
    const metal = this.mat({ color: "#4b535c" });
    const tip = this.mat({ color: "#ff3b3b" });
    const stick = box(1, 2, 1, metal);
    stick.position.y = 10 * PX;
    const bulb = box(2, 2, 2, tip);
    bulb.position.y = 12 * PX;
    stick.castShadow = bulb.castShadow = true;
    this.headgear.add(stick, bulb);
  }

  /** A crest along the top of the helmet in the player's colour, trailing down the back. */
  private buildPlume(top: number) {
    const segs: [number, number, number, number, number][] = [
      // height, depth, z, top above the helmet, brightness
      [1.5, 2.5, -2.2, 1.5, 1],
      [2.5, 3, 0.4, 2.5, 1.18],
      [2, 2.5, 3.1, 2, 0.92],
      [3.5, 1.5, 4.8, 1.7, 0.78],
    ];
    for (const [h, d, z, up, f] of segs) {
      const m = box(1.5, h, d, this.mat({ color: tint(this.color, f) }));
      m.position.set(0, (top + up) * PX, z * PX);
      m.castShadow = true;
      this.headgear.add(m);
    }
  }

  /** Two headband tails from the knot at the back of the hood; they stream back at speed. */
  private buildTails(back: number) {
    const m = this.mat({ color: tint(this.color, 0.85) });
    for (const s of [-1, 1]) {
      const g = new THREE.BoxGeometry(1 * PX, 0.8 * PX, 4.5 * PX);
      g.translate(0, 0, 2.25 * PX);
      const tail = new THREE.Mesh(g, m);
      tail.position.set(s * 0.8 * PX, 6.8 * PX, back * 0.5 * PX + 2 * PX);
      tail.rotation.set(0.9, s * 0.25, 0);
      tail.castShadow = true;
      this.head.add(tail);
      this.tails.push(tail);
    }
  }

  /** Gold band with four corner points and a ruby, resting on top of the head (or helmet). */
  private buildCrown(top: number) {
    const gold = this.mat({ color: "#e8b422" });
    const bright = this.mat({ color: "#ffd23f" });
    const ruby = this.mat({ color: "#d93030" });
    const part = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material) => {
      const mesh = box(w, h, d, m);
      mesh.position.set(x * PX, y * PX, z * PX);
      this.crown.add(mesh);
    };
    part(9, 2, 1, 0, 1, -4, gold);
    part(9, 2, 1, 0, 1, 4, gold);
    part(1, 2, 7, -4, 1, 0, gold);
    part(1, 2, 7, 4, 1, 0, gold);
    for (const x of [-4, 4]) for (const z of [-4, 4]) part(1, 2, 1, x, 3, z, bright);
    part(2, 1, 1, 0, 0.5, -4.6, ruby);
    this.crown.position.y = top * PX;
    this.crown.scale.setScalar(top > 8 ? 1.15 : 1);
    this.crown.visible = false;
    for (const m of [gold, bright, ruby]) this.noTint.add(m);
  }

  get crowned() {
    return this.crown.visible;
  }

  get labelColor() {
    return this.labelCol;
  }

  /** Target size of the model; the drawn size follows it over ~0.4 s. */
  get scale() {
    return this.scaleTarget;
  }

  setScale(scale: number) {
    this.scaleTarget = Math.max(0.05, scale);
    if (!this.ticked) {
      this.scaleNow = this.scaleTarget;
      this.applyScale();
    }
  }

  /** The label stays above the head at any size (and above a bomb); its text size doesn't change. */
  private applyScale() {
    const s = this.scaleNow;
    this.pivot.scale.setScalar(s);
    this.label.position.y = (1.8 + (this.bombOn ? 0.4 : 0)) * s + 0.4;
  }

  setLabelColor(color: string) {
    if (color === this.labelCol) return;
    this.labelCol = color;
    if (this.showLabel) this.rebuildLabel();
  }

  private rebuildLabel() {
    const mat = this.label.material;
    mat.map?.dispose();
    mat.map = labelTexture(this.name, this.labelCol, Math.max(0, Math.min(1, this.hp / this.maxHp)));
    mat.needsUpdate = true;
  }

  /** Infection: green-grey skin and clothes, arms out in front. */
  setZombie(on: boolean) {
    if (on === this.zombie) return;
    this.zombie = on;
    for (const m of this.materials) {
      if (this.noTint.has(m)) continue;
      if (on) {
        this.zombieOrig.set(m, m.color.clone());
        m.color.multiply(ZOMBIE_TINT);
      } else {
        const c = this.zombieOrig.get(m);
        if (c) m.color.copy(c);
      }
    }
    if (!on) this.zombieOrig.clear();
  }

  /** Bounty target: a pulsing marker over the head and the name drawn through walls. */
  setMarked(on: boolean) {
    if (on === this.marked) return;
    this.marked = on;
    if (on && !this.marker) {
      const g = new THREE.ConeGeometry(0.2, 0.45, 4);
      g.rotateX(Math.PI); // point down
      const m = new THREE.MeshLambertMaterial({ color: MARK_GOLD, emissive: MARK_RED, fog: false, depthTest: false, depthWrite: false, transparent: true });
      this.marker = new THREE.Mesh(g, m);
      this.marker.renderOrder = TOP_ORDER;
      this.group.add(this.marker);
    }
    if (this.marker) this.marker.visible = on;
    this.applyLabelOnTop();
  }

  /** Night buff: the name is seen through walls and fog. */
  setLabelOnTop(on: boolean) {
    if (on === this.labelOnTop) return;
    this.labelOnTop = on;
    this.applyLabelOnTop();
  }

  private applyLabelOnTop() {
    const on = this.labelOnTop || this.marked;
    const mat = this.label.material;
    if (mat.depthTest === !on) return;
    mat.depthTest = !on;
    mat.depthWrite = !on;
    mat.fog = !on;
    mat.needsUpdate = true;
    this.label.renderOrder = on ? TOP_ORDER : 0;
  }

  /** Hot potato: a TNT block on the head, blinking faster as the fuse (fraction left) burns down. */
  setBomb(on: boolean, fuse = 1) {
    this.bombFuse = Math.max(0, Math.min(1, fuse));
    if (on === this.bombOn) return;
    this.bombOn = on;
    if (on && !this.bomb) {
      const side = tntTexture(false);
      const cap = tntTexture(true);
      this.bombTextures.push(side, cap);
      const sideMat = new THREE.MeshLambertMaterial({ map: side });
      const capMat = new THREE.MeshLambertMaterial({ map: cap });
      this.bombMats.push(sideMat, capMat);
      const size = 7 * PX;
      this.bomb = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), [sideMat, sideMat, capMat, capMat, sideMat, sideMat]);
      this.bomb.castShadow = true;
      this.head.add(this.bomb);
      this.placeBomb();
    }
    if (this.bomb) this.bomb.visible = on;
    if (!on) for (const m of this.bombMats) m.emissive.setRGB(0, 0, 0);
    this.applyScale();
  }

  setCrown(on: boolean) {
    this.crown.visible = on;
    this.headgear.visible = !on;
  }

  setTarget(x: number, y: number, z: number, yaw: number, pitch: number) {
    this.target.set(x, y, z);
    this.targetYaw = yaw;
    this.targetPitch = pitch;
    if (!this.initialized) {
      this.initialized = true;
      this.pos.copy(this.target);
      this.yaw = yaw;
      this.pitch = pitch;
    }
  }

  /** `max`: mobs have their own maximum (a range target has 1 hp). */
  setHp(hp: number, max = this.maxHp) {
    if (hp === this.hp && max === this.maxHp) return;
    this.hp = hp;
    this.maxHp = max;
    this.rebuildLabel();
  }

  swing(now: number) {
    this.swingAt = now;
  }

  hurt(now: number) {
    this.hurtAt = now;
  }

  get eye() {
    return new THREE.Vector3(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z);
  }

  update(dt: number, now: number, invisible: boolean) {
    const k = 1 - Math.exp(-dt * this.followRate);
    const before = this.pos.clone();
    this.pos.lerp(this.target, k);
    let dy = this.targetYaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * k;
    this.pitch += (this.targetPitch - this.pitch) * k;

    const speed = Math.hypot(this.pos.x - before.x, this.pos.z - before.z) / Math.max(dt, 1e-3);
    this.moveSpeed = speed;
    const amp = Math.min(1, speed / 4) * 0.9;
    this.walk += dt * speed * 2.2;
    const s = Math.sin(this.walk) * amp;
    this.legL.rotation.x = s;
    this.legR.rotation.x = -s;
    // Minecraft holds an item with the arm a little forward and swinging half as far.
    this.armL.rotation.set(-s, 0, 0);
    this.armR.rotation.set(this.sword ? s * 0.5 + Math.PI / 10 : s, 0, 0);
    this.armL.position.set(-ARM_X * PX, ARM_Y * PX, 0);
    this.armR.position.set(ARM_X * PX, ARM_Y * PX, 0);
    this.body.rotation.y = 0;
    // Idle arm sway (Minecraft's AnimationUtils.bobArms).
    const age = now / 50;
    const sway = Math.cos(age * 0.09) * 0.05 + 0.05;
    const lift = Math.sin(age * 0.067) * 0.05;
    this.armR.rotation.z += sway;
    this.armL.rotation.z -= sway;
    this.armR.rotation.x -= lift;
    this.armL.rotation.x += lift;

    const st = (now - this.swingAt) / SWING_MS;
    if (this.bow) {
      // Drawing the bow: the aiming arm kicks up a little on every shot.
      const kick = st < 1 ? Math.sin(st * Math.PI) * 0.3 : 0;
      this.armR.rotation.set(BOW_AIM + s * 0.1 + kick, 0, 0);
      this.armL.rotation.set(BOW_AIM - 0.2 - s * 0.1, 0, 0);
    } else if (st >= 0 && st < 1) {
      // Minecraft's swing: the torso twists, the arm comes up and sweeps down across the body.
      const p = attackPose(st, this.pitch);
      this.body.rotation.y = p.bodyY;
      const c = Math.cos(p.twist) * ARM_X * PX;
      const z = Math.sin(p.twist) * ARM_X * PX;
      this.armR.position.set(c, ARM_Y * PX, z);
      this.armL.position.set(-c, ARM_Y * PX, -z);
      this.armR.rotation.x += p.right.x;
      this.armR.rotation.y += p.right.y;
      this.armR.rotation.z += p.right.z;
      this.armL.rotation.x += p.left.x;
      this.armL.rotation.y += p.left.y;
    } else if (this.zombie) {
      this.armR.rotation.x = ZOMBIE_ARMS - lift;
      this.armL.rotation.x = ZOMBIE_ARMS + lift;
    }

    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    this.head.rotation.x = this.pitch;
    const run = Math.min(1, speed / 6);
    this.tails.forEach((t, i) => (t.rotation.x = 0.95 - run * 0.7 + Math.sin(now / 90 + i * 1.7) * 0.06 * (0.3 + run)));

    // Invisibility: a hit reveals the attacker for a second.
    const revealed = now - this.swingAt < 1000;
    // A shadow would give an invisible player away: only footprints may.
    const ghost = invisible && !revealed;
    if (ghost !== (this.shadowCasters !== null)) {
      if (ghost) {
        const casters: THREE.Object3D[] = [];
        this.group.traverse((o) => {
          if (!o.castShadow) return;
          casters.push(o);
          o.castShadow = false;
        });
        this.shadowCasters = casters;
      } else {
        for (const o of this.shadowCasters ?? []) o.castShadow = true;
        this.shadowCasters = null;
      }
    }
    const opacity = invisible && !revealed ? 0.04 : invisible ? 0.5 : 1;
    const hurt = now - this.hurtAt < 250;
    for (const m of this.materials) {
      m.opacity = opacity;
      m.depthWrite = opacity === 1;
      m.emissive.setRGB(hurt ? 0.7 : 0, this.zombie && !this.noTint.has(m) ? ZOMBIE_GLOW : 0, 0);
    }
    for (const m of this.weaponMaterials) {
      m.opacity = opacity;
      if (m.blending === THREE.NormalBlending) m.depthWrite = opacity === 1;
      // The glint can't fade: it would give an invisible player away.
      else m.visible = opacity === 1;
    }
    this.label.visible = this.showLabel && (!invisible || revealed);

    this.ticked = true;
    if (this.scaleNow !== this.scaleTarget) {
      const d = this.scaleTarget - this.scaleNow;
      this.scaleNow = Math.abs(d) < 1e-3 ? this.scaleTarget : this.scaleNow + d * (1 - Math.exp(-dt * 8));
      this.applyScale();
    }
    // Outside the opacity loop: the marker and the bomb stay visible on an invisible player.
    if (this.marked && this.marker) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 160);
      const m = this.marker;
      m.material.color.lerpColors(MARK_RED, MARK_GOLD, pulse);
      m.material.emissive.copy(m.material.color).multiplyScalar(0.6);
      m.scale.setScalar(0.9 + 0.2 * pulse);
      m.rotation.y = now / 500;
      m.position.y = this.label.position.y + 0.55 + Math.sin(now / 240) * 0.05;
    }
    if (this.bomb && this.bombOn) {
      this.bombPhase += dt * (1.5 + (1 - this.bombFuse) * 10.5) * Math.PI * 2;
      const lit = Math.sin(this.bombPhase) > 0 ? 0.9 : 0;
      for (const m of this.bombMats) m.emissive.setRGB(lit, lit, lit);
      this.placeBomb();
    }
  }

  /** Sits on the head, above a crown, antenna or plume. */
  private placeBomb() {
    if (!this.bomb) return;
    const top = this.crown.visible ? this.headTop + 3.5 : this.skin === "robot" ? 12 : this.skin === "knight" ? this.headTop + 2.5 : this.headTop;
    this.bomb.position.y = (top + 3.5) * PX;
  }

  die(now: number) {
    this.dyingSince = now;
    this.fallDir = Math.random() < 0.5 ? 1 : -1;
    this.label.visible = false;
    if (this.marker) this.marker.visible = false;
    if (this.bomb) this.bomb.visible = false;
  }

  /** Death animation: flash red and topple sideways. Returns false once finished. */
  updateDying(now: number) {
    const t = (now - this.dyingSince) / 1000;
    const fall = Math.min(1, t / 0.35);
    this.group.rotation.set(0, this.yaw, fall * fall * (Math.PI / 2) * this.fallDir);
    this.group.position.copy(this.pos);
    const flash = 0.45 + 0.25 * Math.sin(t * 30);
    for (const m of this.materials) {
      m.opacity = 1;
      m.depthWrite = true;
      m.emissive.setRGB(flash, 0, 0);
    }
    for (const m of this.weaponMaterials) {
      m.opacity = 1;
      m.visible = true;
      if (m.blending === THREE.NormalBlending) m.depthWrite = true;
    }
    return t < 0.9;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of this.materials) {
      m.map?.dispose();
      m.dispose();
    }
    for (const m of this.weaponMaterials) m.dispose();
    this.label.material.map?.dispose();
    this.label.material.dispose();
    this.marker?.material.dispose();
    for (const m of this.bombMats) m.dispose();
    for (const t of this.bombTextures) t.dispose();
  }
}
