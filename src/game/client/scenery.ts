import * as THREE from "three";
import { ARENA_RADIUS, cellInRing } from "../shared";
import { GeometryBuilder } from "./meshing";
import { sceneryTextures } from "./textures";

// Decoration on and around the island: sky, sea, the island's rocky underside, floating islands with
// trees. Purely visual: nothing here collides or reaches the server.

const R = ARENA_RADIUS;
const SEA_Y = -70;
/** Bottom of the floor slab's dirt edge (see buildFloor); the rock hangs below it. */
const SLAB_BOTTOM = -4;
const SKY_TOP = new THREE.Color("#4f95ec");
const SKY_HORIZON = new THREE.Color("#8fc8ff");
const SUN = new THREE.Color("#fff3c4");

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 2D value noise in 0..1. */
function valueNoise(seed: number) {
  const h = (x: number, z: number) => {
    let n = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 982451653)) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  return (x: number, z: number) => {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const fx = x - x0;
    const fz = z - z0;
    const sx = fx * fx * (3 - 2 * fx);
    const sz = fz * fz * (3 - 2 * fz);
    const a = h(x0, z0);
    const b = h(x0 + 1, z0);
    const c = h(x0, z0 + 1);
    const d = h(x0 + 1, z0 + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  };
}

// ---------------------------------------------------------------- sky

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSun;
uniform vec3 uSunDir;
uniform vec3 uSunU;
uniform vec3 uSunV;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 col = mix(uHorizon, uTop, pow(clamp(d.y, 0.0, 1.0), 0.55));
  float s = dot(d, uSunDir);
  if (s > 0.0) {
    // A square, Minecraft-like sun with a soft glow around it.
    vec2 q = abs(vec2(dot(d, uSunU), dot(d, uSunV))) / s;
    float edge = max(q.x, q.y);
    col = mix(col, uSun * 1.25, 1.0 - smoothstep(0.05, 0.056, edge));
    col += uSun * (pow(s, 40.0) * 0.35 + pow(s, 6.0) * 0.08);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------- blocky meshing

type Mat = "grassTop" | "grassSide" | "dirt" | "stone" | "bark" | "leaves";

const EDGES: [number, number, number, number, number, number, number[]][] = [
  // dx, dz, a = corner offsets, b = corner offsets, normal
  [1, 0, 1, 1, 1, 0, [1, 0, 0]],
  [-1, 0, 0, 0, 0, 1, [-1, 0, 0]],
  [0, 1, 0, 1, 1, 1, [0, 0, 1]],
  [0, -1, 1, 0, 0, 0, [0, 0, -1]],
];

class Mesher {
  readonly builders = new Map<Mat, GeometryBuilder>();
  /** Vertex brightness by height, set per island (deeper rock is darker). */
  shade: (y: number) => number = () => 1;

  private b(m: Mat) {
    let b = this.builders.get(m);
    if (!b) this.builders.set(m, (b = new GeometryBuilder()));
    return b;
  }

  private quad(m: Mat, corners: number[][], n: number[], uvs: number[][]) {
    this.b(m).quad(corners, n, uvs, corners.map((c) => this.shade(c[1])));
  }

  top(m: Mat, x: number, y: number, z: number) {
    this.quad(m, [[x, y, z + 1], [x + 1, y, z + 1], [x + 1, y, z], [x, y, z]], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  }

  bottom(m: Mat, x: number, y: number, z: number) {
    this.quad(m, [[x, y, z], [x + 1, y, z], [x + 1, y, z + 1], [x, y, z + 1]], [0, -1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  }

  /** The face of cell (x, z) towards edge `e`, from `lo` up to `hi`. */
  side(m: Mat, x: number, z: number, e: (typeof EDGES)[number], lo: number, hi: number) {
    if (hi <= lo) return;
    const [, , ax, az, bx, bz, n] = e;
    const h = hi - lo;
    this.quad(
      m,
      [[x + ax, lo, z + az], [x + bx, lo, z + bz], [x + bx, hi, z + bz], [x + ax, hi, z + az]],
      n,
      [[0, 0], [1, 0], [1, h], [0, h]],
    );
  }

  /** A whole block; faces against other solid cells are skipped. */
  cube(m: Mat, x: number, y: number, z: number, solid: (x: number, y: number, z: number) => boolean) {
    if (!solid(x, y + 1, z)) this.top(m, x, y + 1, z);
    if (!solid(x, y - 1, z)) this.bottom(m, x, y, z);
    for (const e of EDGES) if (!solid(x + e[0], y, z + e[1])) this.side(m, x, z, e, y, y + 1);
  }
}

const key = (x: number, z: number) => (x + 512) * 2048 + (z + 512);

/** The rock under the arena slab: deepest in the middle, a few blocks at the rim. Cut off at `radius`
 *  as the island crumbles, so the cut shows as a cliff. */
function islandUnderside(m: Mesher, radius: number) {
  const n = valueNoise(3);
  const depth = new Map<number, number>();
  for (let x = -R - 1; x <= R; x++) {
    for (let z = -R - 1; z <= R; z++) {
      if (!cellInRing(x, z, radius)) continue;
      const t = Math.max(0, 1 - Math.hypot(x + 0.5, z + 0.5) / R);
      depth.set(key(x, z), 1 + Math.round(30 * Math.pow(t, 1.5) + 7 * t * n(x * 0.12, z * 0.12) + 2 * n(x * 0.5 + 40, z * 0.5)));
    }
  }
  m.shade = (y) => 0.45 + 0.55 * Math.max(0, Math.min(1, 1 - (SLAB_BOTTOM - y) / 36));
  for (const [k, d] of depth) {
    const x = Math.floor(k / 2048) - 512;
    const z = (k % 2048) - 512;
    const bottom = SLAB_BOTTOM - d;
    m.bottom("stone", x, bottom, z);
    for (const e of EDGES) {
      const nd = depth.get(key(x + e[0], z + e[1])) ?? 0;
      if (nd < d) m.side("stone", x, z, e, bottom, SLAB_BOTTOM - nd);
    }
  }
}

/** A small floating island with a grass top at height `cy` and a few trees. */
function floatingIsland(m: Mesher, cx: number, cy: number, cz: number, radius: number, trees: number, seed: number) {
  const n = valueNoise(seed);
  const rnd = rng(seed);
  const depth = new Map<number, number>();
  const span = Math.ceil(radius * 1.2) + 1;
  for (let dx = -span; dx <= span; dx++) {
    for (let dz = -span; dz <= span; dz++) {
      const edge = radius * (0.8 + 0.35 * n(dx * 0.3, dz * 0.3));
      const dist = Math.hypot(dx, dz);
      if (dist > edge) continue;
      const t = 1 - dist / edge;
      depth.set(key(dx, dz), 2 + Math.round(radius * 1.5 * Math.pow(t, 1.3) + 2 * n(dx * 0.6 + 9, dz * 0.6)));
    }
  }
  m.shade = (y) => 0.5 + 0.5 * Math.max(0, Math.min(1, 1 - (cy - y) / (radius * 1.6)));
  // Material bands down the side of a column.
  const bands: [Mat, number, number][] = [
    ["grassSide", cy - 1, cy],
    ["dirt", cy - 3, cy - 1],
    ["stone", -Infinity, cy - 3],
  ];
  for (const [k, d] of depth) {
    const dx = Math.floor(k / 2048) - 512;
    const dz = (k % 2048) - 512;
    const x = cx + dx;
    const z = cz + dz;
    m.top("grassTop", x, cy, z);
    m.bottom("stone", x, cy - d, z);
    for (const e of EDGES) {
      const nd = depth.get(key(dx + e[0], dz + e[1])) ?? 0;
      if (nd >= d) continue;
      const lo = cy - d;
      const hi = cy - nd;
      for (const [mat, b0, b1] of bands) m.side(mat, x, z, e, Math.max(lo, b0), Math.min(hi, b1));
    }
  }

  // Trees: a trunk and a blob of leaves, Minecraft oak style.
  const blocks = new Map<string, Mat>();
  const at = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const spots = [...depth.keys()].filter((k) => {
    const dx = Math.floor(k / 2048) - 512;
    const dz = (k % 2048) - 512;
    return Math.hypot(dx, dz) < radius * 0.55;
  });
  for (let i = 0; i < trees && spots.length; i++) {
    const k = spots.splice(Math.floor(rnd() * spots.length), 1)[0];
    const x = cx + Math.floor(k / 2048) - 512;
    const z = cz + (k % 2048) - 512;
    const h = 4 + Math.floor(rnd() * 2);
    for (let y = cy; y < cy + h; y++) blocks.set(at(x, y, z), "bark");
    for (let y = cy + h - 2; y <= cy + h + 1; y++) {
      const r = y < cy + h ? 2 : 1;
      for (let ox = -r; ox <= r; ox++) {
        for (let oz = -r; oz <= r; oz++) {
          const corner = Math.abs(ox) === r && Math.abs(oz) === r;
          if ((corner && (y === cy + h + 1 || rnd() < 0.6)) || blocks.has(at(x + ox, y, z + oz))) continue;
          blocks.set(at(x + ox, y, z + oz), "leaves");
        }
      }
    }
  }
  m.shade = () => 1;
  const solid = (x: number, y: number, z: number) => blocks.has(at(x, y, z));
  for (const [k, mat] of blocks) {
    const [x, y, z] = k.split(",").map(Number);
    m.cube(mat, x, y, z, solid);
  }
}

export class Scenery {
  readonly group = new THREE.Group();
  private readonly sky: THREE.Mesh;
  private readonly water: THREE.Texture;
  private readonly rockMat: THREE.MeshLambertMaterial;
  private underside: THREE.Mesh | null = null;
  private undersideR = -1;

  constructor(sunPos: THREE.Vector3) {
    const tex = sceneryTextures();
    this.group.name = "scenery";

    const sunDir = sunPos.clone().normalize();
    const u = new THREE.Vector3(0, 1, 0).cross(sunDir).normalize();
    const v = sunDir.clone().cross(u).normalize();
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(300, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: {
          uTop: { value: SKY_TOP },
          uHorizon: { value: SKY_HORIZON },
          uSun: { value: SUN },
          uSunDir: { value: sunDir },
          uSunU: { value: u },
          uSunV: { value: v },
        },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
        fog: false,
      }),
    );
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;

    this.water = tex.water;
    this.water.repeat.set(400, 400);
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshLambertMaterial({ map: this.water, emissive: "#0b2a4a" }));
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = SEA_Y;

    this.rockMat = new THREE.MeshLambertMaterial({ map: tex.stone, vertexColors: true });
    this.setIslandRadius(R);
    const m = new Mesher();
    const rnd = rng(2024);
    // Big islands on the horizon (hazy in the fog), small rocks floating closer and lower.
    const big = 9;
    for (let i = 0; i < big; i++) {
      const a = (i / big) * Math.PI * 2 + (rnd() - 0.5) * 0.4;
      const d = 95 + rnd() * 55;
      const radius = 5 + Math.floor(rnd() * 6);
      floatingIsland(m, Math.round(Math.cos(a) * d), Math.round(-14 + rnd() * 34), Math.round(Math.sin(a) * d), radius, 1 + Math.floor(rnd() * 3), 100 + i);
    }
    for (let i = 0; i < 6; i++) {
      const a = rnd() * Math.PI * 2;
      const d = 60 + rnd() * 22;
      floatingIsland(m, Math.round(Math.cos(a) * d), Math.round(-30 + rnd() * 18), Math.round(Math.sin(a) * d), 2 + Math.floor(rnd() * 2), rnd() < 0.5 ? 1 : 0, 200 + i);
    }
    const maps: Record<Mat, THREE.Texture> = {
      grassTop: tex.grassTop,
      grassSide: tex.grassSide,
      dirt: tex.dirt,
      stone: tex.stone,
      bark: tex.bark,
      leaves: tex.leaves,
    };
    for (const [mat, b] of m.builders) {
      const mesh = new THREE.Mesh(b.build(), new THREE.MeshLambertMaterial({ map: maps[mat], vertexColors: true }));
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }
    this.group.add(this.sky, sea);
  }

  /** Rebuilds the rock under the island for its current radius. */
  setIslandRadius(r: number) {
    if (r === this.undersideR) return;
    this.undersideR = r;
    if (this.underside) {
      this.group.remove(this.underside);
      this.underside.geometry.dispose();
      this.underside = null;
    }
    const m = new Mesher();
    islandUnderside(m, r);
    const rock = m.builders.get("stone");
    if (!rock) return;
    this.underside = new THREE.Mesh(rock.build(), this.rockMat);
    this.underside.matrixAutoUpdate = false;
    this.group.add(this.underside);
  }

  /** Buffs tint the sky (and the sun: a pale moon at night); null restores the day. */
  setSkyTint(top: THREE.Color | null, horizon: THREE.Color | null, sun: THREE.Color | null = null) {
    const u = (this.sky.material as THREE.ShaderMaterial).uniforms;
    u.uTop.value = top ?? SKY_TOP;
    u.uHorizon.value = horizon ?? SKY_HORIZON;
    u.uSun.value = sun ?? SUN;
  }

  update(now: number, eye: THREE.Vector3) {
    this.sky.position.copy(eye);
    const t = now / 1000;
    this.water.offset.set(t * 0.03, t * 0.017);
  }
}
