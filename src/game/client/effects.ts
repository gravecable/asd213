import * as THREE from "three";
import { numberTexture } from "./textures";

interface Particle {
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
  size: number;
  spin: number;
}

export class Particles {
  readonly mesh: THREE.InstancedMesh;
  private items: Particle[] = [];
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private next = 0;

  constructor(private max = 400) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), max);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < max; i++) {
      this.items.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, size: 0.1, spin: 0 });
      this.mesh.setColorAt(i, this.color);
    }
  }

  burst(at: THREE.Vector3, colors: string[], count: number, speed: number, size = 0.1) {
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      const it = this.items[i];
      it.p.set(at.x + (Math.random() - 0.5) * 0.5, at.y + (Math.random() - 0.5) * 0.5, at.z + (Math.random() - 0.5) * 0.5);
      it.v.set((Math.random() - 0.5) * speed, Math.random() * speed, (Math.random() - 0.5) * speed);
      it.life = 0.5 + Math.random() * 0.4;
      it.size = size * (0.7 + Math.random() * 0.6);
      it.spin = (Math.random() - 0.5) * 12;
      this.mesh.setColorAt(i, this.color.set(colors[n % colors.length]));
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** dt = 0 freezes particles in place (hit-stop). */
  update(dt: number) {
    if (dt === 0) return;
    this.items.forEach((it, i) => {
      if (it.life > 0) {
        it.life -= dt;
        it.v.y -= 18 * dt;
        it.p.addScaledVector(it.v, dt);
        if (it.p.y < 0.05) {
          it.p.y = 0.05;
          it.v.set(it.v.x * 0.5, 0, it.v.z * 0.5);
        }
      }
      this.dummy.position.copy(it.p);
      this.dummy.rotation.set(it.spin * it.life, it.spin * it.life * 0.7, 0);
      this.dummy.scale.setScalar(it.life > 0 ? it.size * Math.min(1, it.life / 0.15) : 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

interface FloatingNumber {
  sprite: THREE.Sprite;
  born: number;
  base: THREE.Vector3;
  drift: number;
  height: number;
}

const NUMBER_MS = 900;

/** Damage numbers that pop above the victim, float up and fade. */
export class DamageNumbers {
  readonly group = new THREE.Group();
  private items: FloatingNumber[] = [];
  private cache = new Map<string, THREE.CanvasTexture>();

  spawn(at: THREE.Vector3, text: string, color: string, big: boolean, now: number) {
    const key = `${text}|${color}`;
    let tex = this.cache.get(key);
    if (!tex) {
      tex = numberTexture(text, color);
      this.cache.set(key, tex);
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    sprite.renderOrder = 1000;
    sprite.center.set(0.5, 0);
    this.group.add(sprite);
    this.items.push({ sprite, born: now, base: at.clone(), drift: (Math.random() - 0.5) * 0.8, height: big ? 0.42 : 0.3 });
  }

  update(now: number) {
    this.items = this.items.filter((n) => {
      const t = (now - n.born) / NUMBER_MS;
      if (t >= 1) {
        this.group.remove(n.sprite);
        n.sprite.material.dispose();
        return false;
      }
      const img = n.sprite.material.map!.image as HTMLCanvasElement;
      const h = n.height * (t < 0.15 ? 1.5 - (t / 0.15) * 0.5 : 1);
      n.sprite.scale.set((h * img.width) / img.height, h, 1);
      n.sprite.position.set(n.base.x + n.drift * t, n.base.y + 0.9 * (1 - (1 - t) * (1 - t)), n.base.z);
      n.sprite.material.opacity = t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1;
      return true;
    });
  }

  dispose() {
    for (const n of this.items) n.sprite.material.dispose();
    for (const t of this.cache.values()) t.dispose();
  }
}

interface Spark {
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
  max: number;
  size: number;
  /** Gravity (negative: drifts up) and air drag per second. */
  g: number;
  drag: number;
  color: THREE.Color;
}

interface Rocket {
  p: THREE.Vector3;
  v: THREE.Vector3;
  fuse: number;
  colors: string[];
}

/** Celebration fireworks and crown sparkles: glowing cubes that hang in the air and fade. Fogged like
 *  everything else, so the fog buff hides a crowned player's sparkles along with the player. */
export class Fireworks {
  readonly mesh: THREE.InstancedMesh;
  /** Called at every burst (for the bang). */
  onBurst: ((at: THREE.Vector3) => void) | null = null;
  private sparks: Spark[] = [];
  private rockets: Rocket[] = [];
  private next = 0;
  private idle = true;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();

  constructor(private max = 1200) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), max);
    this.mesh.frustumCulled = false;
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < max; i++) {
      this.sparks.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, max: 1, size: 0.1, g: 0, drag: 0, color: new THREE.Color() });
      this.mesh.setColorAt(i, this.color);
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
  }

  launch(from: THREE.Vector3, colors: string[]) {
    const v = new THREE.Vector3((Math.random() - 0.5) * 2, 17 + Math.random() * 5, (Math.random() - 0.5) * 2);
    this.rockets.push({ p: from.clone(), v, fuse: 0.8 + Math.random() * 0.35, colors });
    this.idle = false;
  }

  /** A single slow glint drifting upwards. */
  sparkle(at: THREE.Vector3, color: string) {
    const v = new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.5 + Math.random() * 0.5, (Math.random() - 0.5) * 0.4);
    this.spawn(at, v, 0.6 + Math.random() * 0.4, 0.06, -0.3, 1, color);
  }

  clear() {
    this.rockets = [];
    for (const s of this.sparks) s.life = Math.min(s.life, 0.001);
  }

  private spawn(p: THREE.Vector3, v: THREE.Vector3, life: number, size: number, g: number, drag: number, color: string) {
    const s = this.sparks[this.next];
    this.next = (this.next + 1) % this.max;
    s.p.copy(p);
    s.v.copy(v);
    s.life = s.max = life;
    s.size = size;
    s.g = g;
    s.drag = drag;
    s.color.set(color);
    this.idle = false;
  }

  private burst(at: THREE.Vector3, colors: string[]) {
    const dir = new THREE.Vector3();
    for (let i = 0; i < 90; i++) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      dir.set(r * Math.cos(a), u, r * Math.sin(a)).multiplyScalar(7.5 + Math.random() * 2.5);
      this.spawn(at, dir, 1.2 + Math.random() * 0.6, 0.2, 4.5, 1.6, colors[i % colors.length]);
    }
    for (let i = 0; i < 12; i++) {
      dir.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(6);
      this.spawn(at, dir, 0.25, 0.35, 0, 3, "#ffffff");
    }
    this.onBurst?.(at);
  }

  /** dt = 0 freezes everything (hit-stop). */
  update(dt: number) {
    if (dt === 0 || this.idle) return;
    const trail = new THREE.Vector3();
    this.rockets = this.rockets.filter((r) => {
      r.v.y -= 9 * dt;
      r.p.addScaledVector(r.v, dt);
      r.fuse -= dt;
      trail.set((Math.random() - 0.5) * 1.2, -1 - Math.random(), (Math.random() - 0.5) * 1.2);
      this.spawn(r.p, trail, 0.35 + Math.random() * 0.2, 0.11, 2, 2, Math.random() < 0.5 ? "#ffd27a" : "#fff2c4");
      if (r.fuse > 0) return true;
      this.burst(r.p, r.colors);
      return false;
    });
    let alive = false;
    this.sparks.forEach((s, i) => {
      if (s.life > 0) {
        s.life -= dt;
        s.v.multiplyScalar(Math.exp(-s.drag * dt));
        s.v.y -= s.g * dt;
        s.p.addScaledVector(s.v, dt);
      }
      const k = Math.max(0, s.life / s.max);
      // Dying sparks twinkle before they go out.
      const twinkle = k < 0.3 && Math.sin(s.life * 50) < 0 ? 0.35 : 1;
      this.dummy.position.copy(s.p);
      this.dummy.scale.setScalar(s.life > 0 ? s.size * Math.min(1, k * 3) * twinkle : 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      if (s.life > 0) {
        alive = true;
        this.mesh.setColorAt(i, this.color.copy(s.color).multiplyScalar(0.55 + 0.45 * Math.min(1, k * 2)));
      }
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.idle = !alive && !this.rockets.length;
  }
}

const PRINT_MS = 4000;
const PRINT_ALPHA = 0.7;

/** Dark prints left on the ground by walking players; each one fades out over three seconds. */
export class Footprints {
  readonly mesh: THREE.InstancedMesh;
  private born: number[];
  private alpha: THREE.InstancedBufferAttribute;
  private next = 0;
  private side = 1;
  private idle = true;
  private dummy = new THREE.Object3D();

  constructor(private max = 160) {
    // Bigger than a Minecraft sole: they must be spotted from a few blocks away.
    const geo = new THREE.PlaneGeometry(0.26, 0.42).rotateX(-Math.PI / 2);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aAlpha", this.alpha);
    const mat = new THREE.MeshBasicMaterial({
      color: "#0d0a08",
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    // MeshBasicMaterial has no per-instance opacity: fade through an instanced attribute.
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float aAlpha;\nvarying float vAlpha;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvAlpha = aAlpha;");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vAlpha;")
        .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.a *= vAlpha;");
    };
    mat.customProgramCacheKey = () => "footprints";
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.born = new Array<number>(max).fill(-1e9);
  }

  /** `y` is the ground height under the feet, `yaw` the walking direction (0 faces -Z). */
  add(x: number, y: number, z: number, yaw: number, now: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.side = -this.side;
    const off = this.side * 0.12;
    this.dummy.position.set(x + Math.cos(yaw) * off, y + 0.02, z - Math.sin(yaw) * off);
    this.dummy.rotation.set(0, yaw, 0);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.born[i] = now;
    this.alpha.setX(i, PRINT_ALPHA);
    this.alpha.needsUpdate = true;
    this.idle = false;
  }

  update(now: number) {
    if (this.idle) return;
    let alive = false;
    for (let i = 0; i < this.max; i++) {
      if (this.alpha.getX(i) <= 0) continue;
      const k = (now - this.born[i]) / PRINT_MS;
      if (k >= 1) this.alpha.setX(i, 0);
      else {
        this.alpha.setX(i, PRINT_ALPHA * (1 - Math.max(0, k)));
        alive = true;
      }
    }
    this.alpha.needsUpdate = true;
    this.idle = !alive;
  }

  clear() {
    this.alpha.array.fill(0);
    this.alpha.needsUpdate = true;
    this.next = 0;
    this.idle = true;
  }
}

const METEOR_HEIGHT = 45;
/** Glowing cubes behind the falling meteor, `TRAIL_LAG` ms apart along its path. */
const TRAIL = 6;
const TRAIL_LAG = 45;

interface Meteor {
  root: THREE.Group;
  rock: THREE.Group;
  trail: THREE.Mesh[];
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  discMat: THREE.MeshBasicMaterial;
  start: number;
  impactAt: number;
  /** Horizontal offset of the meteor's starting point from the impact. */
  slant: THREE.Vector3;
}

/** Warnings for incoming meteors: a pulsing ring on the ground and the rock itself, falling along a slanted
 *  line so it lands on the ring exactly at `impactAt`. */
export class MeteorMarks {
  readonly group = new THREE.Group();
  private items = new Map<number, Meteor>();
  private ringGeo = new THREE.RingGeometry(0.88, 1, 48).rotateX(-Math.PI / 2);
  private discGeo = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
  private cubeGeo = new THREE.BoxGeometry(1, 1, 1);
  private rockMat = new THREE.MeshBasicMaterial({ color: "#ffb02e", fog: false, toneMapped: false });
  private glowMat = new THREE.MeshBasicMaterial({
    color: "#ff7a1a",
    fog: false,
    toneMapped: false,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  /** Additive, so a darker colour is a fainter cube. */
  private trailMats = Array.from({ length: TRAIL }, (_, k) => {
    const color = new THREE.Color("#ff8a20").multiplyScalar(0.9 * (1 - k / TRAIL));
    return new THREE.MeshBasicMaterial({ color, fog: false, toneMapped: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  });

  /** Times are performance.now() ms; the rock starts falling now. `y` is the ground height. */
  warn(id: number, x: number, y: number, z: number, r: number, impactAt: number) {
    this.remove(id);
    const flat = { transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
    const ringMat = new THREE.MeshBasicMaterial({ color: "#ff2a1a", ...flat });
    const discMat = new THREE.MeshBasicMaterial({ color: "#ff3a20", ...flat });
    const root = new THREE.Group();
    root.position.set(x, y, z);
    const ring = new THREE.Mesh(this.ringGeo, ringMat);
    const disc = new THREE.Mesh(this.discGeo, discMat);
    ring.scale.setScalar(r);
    disc.scale.setScalar(r);
    ring.position.y = disc.position.y = 0.03;
    const rock = new THREE.Group();
    const core = new THREE.Mesh(this.cubeGeo, this.rockMat);
    core.scale.setScalar(0.9);
    const glow = new THREE.Mesh(this.cubeGeo, this.glowMat);
    glow.scale.setScalar(1.5);
    rock.add(core, glow);
    const trail = this.trailMats.map((m, k) => {
      const cube = new THREE.Mesh(this.cubeGeo, m);
      cube.scale.setScalar(0.7 - 0.085 * k);
      return cube;
    });
    root.add(disc, ring, rock, ...trail);
    this.group.add(root);
    const a = id * 2.399;
    this.items.set(id, {
      root,
      rock,
      trail,
      ring,
      ringMat,
      discMat,
      start: performance.now(),
      impactAt,
      slant: new THREE.Vector3(Math.cos(a) * 7, 0, Math.sin(a) * 7),
    });
  }

  private place(m: Meteor, obj: THREE.Object3D, t: number) {
    const p = Math.max(0, Math.min(1, (t - m.start) / Math.max(1, m.impactAt - m.start)));
    const e = 1 - p * p; // accelerating fall
    obj.position.set(m.slant.x * e, METEOR_HEIGHT * e, m.slant.z * e);
  }

  update(now: number) {
    for (const [id, m] of this.items) {
      if (now >= m.impactAt) {
        this.remove(id);
        continue;
      }
      const total = Math.max(1, m.impactAt - m.start);
      const u = Math.max(0, Math.min(1, (now - m.start) / total));
      // Pulse rate climbs from 1.2 Hz to 9.2 Hz over the warning.
      const t = Math.max(0, now - m.start) / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(Math.PI * 2 * (1.2 * t + (4 * t * t) / (total / 1000)));
      m.ringMat.opacity = Math.min(1, 0.35 + 0.35 * u + 0.3 * pulse);
      m.discMat.opacity = (0.08 + 0.18 * pulse) * (0.4 + 0.6 * u);
      this.place(m, m.rock, now);
      m.rock.rotation.set(now / 260, now / 350, 0);
      m.trail.forEach((c, k) => this.place(m, c, now - (k + 1) * TRAIL_LAG));
    }
  }

  remove(id: number) {
    const m = this.items.get(id);
    if (!m) return;
    this.items.delete(id);
    this.group.remove(m.root);
    m.ringMat.dispose();
    m.discMat.dispose();
  }

  clear() {
    for (const id of [...this.items.keys()]) this.remove(id);
  }

  dispose() {
    this.clear();
    for (const g of [this.ringGeo, this.discGeo, this.cubeGeo]) g.dispose();
    for (const m of [this.rockMat, this.glowMat, ...this.trailMats]) m.dispose();
  }
}

const FIRE_GROW = 0.35;
const FIRE_LIFE = 0.5;
const WAVE_LIFE = 0.5;
const FIRE_HOT = new THREE.Color("#ffd45a");
const FIRE_FLAME = new THREE.Color("#ff6a10");
const FIRE_ASH = new THREE.Color("#2a1208");

interface Blast {
  fire: THREE.Mesh;
  wave: THREE.Mesh;
  fireMat: THREE.MeshBasicMaterial;
  waveMat: THREE.MeshBasicMaterial;
  born: number;
  r: number;
  base: THREE.Vector3;
}

/** Explosions: a fireball that swells and darkens, and a white shockwave ring racing across the ground. */
export class Explosions {
  readonly group = new THREE.Group();
  private items: Blast[] = [];
  private sphereGeo = new THREE.SphereGeometry(1, 16, 12);
  private ringGeo = new THREE.RingGeometry(0.85, 1, 40).rotateX(-Math.PI / 2);
  private color = new THREE.Color();

  /** `y` is the ground height: the ring lies there and the fireball rises from it. */
  spawn(x: number, y: number, z: number, r: number, now: number) {
    const fireMat = new THREE.MeshBasicMaterial({ color: FIRE_HOT, transparent: true, depthWrite: false, fog: false, toneMapped: false });
    const waveMat = new THREE.MeshBasicMaterial({
      color: "#ffffff",
      transparent: true,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const fire = new THREE.Mesh(this.sphereGeo, fireMat);
    const wave = new THREE.Mesh(this.ringGeo, waveMat);
    fire.scale.setScalar(0.01);
    wave.scale.setScalar(0.01);
    wave.position.set(x, y + 0.05, z);
    this.group.add(fire, wave);
    this.items.push({ fire, wave, fireMat, waveMat, born: now, r, base: new THREE.Vector3(x, y, z) });
  }

  update(now: number) {
    this.items = this.items.filter((b) => {
      const age = Math.max(0, (now - b.born) / 1000);
      if (age >= Math.max(FIRE_LIFE, WAVE_LIFE)) {
        this.group.remove(b.fire, b.wave);
        b.fireMat.dispose();
        b.waveMat.dispose();
        return false;
      }
      const grow = Math.min(1, age / FIRE_GROW);
      const e = 1 - (1 - grow) ** 3;
      const u = Math.min(1, age / FIRE_LIFE);
      b.fire.scale.setScalar(Math.max(0.01, b.r * e));
      b.fire.position.set(b.base.x, b.base.y + 0.4 * b.r * e, b.base.z);
      if (u < 0.45) this.color.lerpColors(FIRE_HOT, FIRE_FLAME, u / 0.45);
      else this.color.lerpColors(FIRE_FLAME, FIRE_ASH, (u - 0.45) / 0.55);
      b.fireMat.color.copy(this.color);
      b.fireMat.opacity = u < 0.3 ? 0.95 : 0.95 * (1 - (u - 0.3) / 0.7);
      const v = Math.min(1, age / WAVE_LIFE);
      b.wave.scale.setScalar(Math.max(0.01, b.r * 1.6 * (1 - (1 - v) ** 2)));
      b.waveMat.opacity = 0.85 * (1 - v);
      return true;
    });
  }

  clear() {
    for (const b of this.items) {
      this.group.remove(b.fire, b.wave);
      b.fireMat.dispose();
      b.waveMat.dispose();
    }
    this.items = [];
  }

  dispose() {
    this.clear();
    this.sphereGeo.dispose();
    this.ringGeo.dispose();
  }
}
