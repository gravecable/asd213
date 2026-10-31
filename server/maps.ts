// Arena maps: every round a fresh layout of one of the MAPS themes, built out of the game's blocks
// on top of the island's floor (hills, trees, ruins, towers…), plus holes knocked out of the floor
// (a ravine with bridges, sinkholes). Pure: the same seed gives the same map.
import { ARENA_RADIUS, BLOCK, FINAL_RING_RADIUS, GRID, HILL_RADIUS, MAX_HEIGHT, SPAWN_RADIUS, Voxels, cellInRing } from "../src/game/shared.ts";
import type { MapId } from "../src/game/shared.ts";

export interface MapOptions {
  /** Island radius at the start of the round. */
  radius?: number;
  /** Radius of the circle the players start on: nothing but low hills there. */
  spawnR?: number;
  /** King of the Hill: the hill in the centre stays flat and open. */
  hill?: boolean;
}

/** Nothing is built this high: room to jump on top of everything without touching the ceiling. */
export const MAP_TOP = MAX_HEIGHT - 4;
/** Holes stay out of the final ring, so the last fights never split over a chasm. */
export const HOLE_MIN_R = FINAL_RING_RADIUS + 2;
/** Half-width of the start circle's band that is kept clear. */
export const SPAWN_BAND = 2.5;

export function seededRandom(seed: number): () => number {
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
function valueNoise(rnd: () => number) {
  const n = 64;
  const table = Float32Array.from({ length: n * n }, () => rnd());
  const at = (x: number, z: number) => table[(((x % n) + n) % n) * n + (((z % n) + n) % n)];
  const fade = (t: number) => t * t * (3 - 2 * t);
  return (x: number, z: number) => {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const fx = fade(x - x0);
    const fz = fade(z - z0);
    const a = at(x0, z0);
    const b = at(x0 + 1, z0);
    const c = at(x0, z0 + 1);
    const d = at(x0 + 1, z0 + 1);
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  };
}

const N4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

interface HillStyle {
  amp: number;
  scale: number;
  /** Noise below this stays flat floor. */
  bias: number;
  max: number;
  top: (x: number, z: number) => number;
  fill: number;
}

class Builder {
  /** Ground height per cell: the top of the hill there, 0 on the floor. */
  readonly ground = new Int8Array(GRID * GRID);
  /** Cells claimed by a structure. */
  readonly used = new Uint8Array(GRID * GRID);
  /** Upper bound on the hills per cell (flat approaches to the bridges). */
  readonly cap = new Int8Array(GRID * GRID).fill(MAP_TOP);

  readonly vox: Voxels;
  readonly rnd: () => number;
  readonly radius: number;
  readonly spawnR: number;
  readonly hill: boolean;

  constructor(vox: Voxels, rnd: () => number, radius: number, spawnR: number, hill: boolean) {
    this.vox = vox;
    this.rnd = rnd;
    this.radius = radius;
    this.spawnR = spawnR;
    this.hill = hill;
  }

  int(lo: number, hi: number): number {
    return lo + Math.floor(this.rnd() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.rnd() < p;
  }

  dist(x: number, z: number): number {
    return Math.hypot(x + 0.5, z + 0.5);
  }

  inside(x: number, z: number, margin = 0): boolean {
    return cellInRing(x, z, this.radius - margin);
  }

  hole(x: number, z: number): boolean {
    return this.vox.holes.has(Voxels.cell(x, z));
  }

  g(x: number, z: number): number {
    return this.inside(x, z) ? this.ground[Voxels.cell(x, z)] : 0;
  }

  /** The start circle and the hill: kept free of everything but low hills. */
  reserved(x: number, z: number): boolean {
    const d = this.dist(x, z);
    return Math.abs(d - this.spawnR) < SPAWN_BAND + 0.5 || (this.hill && d < HILL_RADIUS + 3);
  }

  set(x: number, y: number, z: number, type: number): void {
    if (y >= 0 && y < MAP_TOP && this.inside(x, z, 0.5)) this.vox.set(x, y, z, type);
  }

  /** Sets a block where there is none yet. */
  put(x: number, y: number, z: number, type: number): void {
    if (!this.vox.get(x, y, z)) this.set(x, y, z, type);
  }

  /** A solid column from `from` up to (not including) `to`. */
  column(x: number, z: number, from: number, to: number, type: number): void {
    for (let y = from; y < to; y++) this.set(x, y, z, type);
  }

  /** Claims a rectangle of cells when it is free with `pad` cells around it: on the island, over
   *  floor, off the start circle and the hill, and not taken by another structure. */
  claim(x0: number, z0: number, x1: number, z1: number, pad = 1): boolean {
    for (let x = x0 - pad; x <= x1 + pad; x++)
      for (let z = z0 - pad; z <= z1 + pad; z++) {
        if (!this.inside(x, z, 2) || this.hole(x, z) || this.used[Voxels.cell(x, z)] || this.reserved(x, z)) return false;
      }
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) this.used[Voxels.cell(x, z)] = 1;
    return true;
  }

  /** A random cell `minR`..`maxR` from the centre (or from cx, cz). */
  spot(minR: number, maxR: number, cx = 0, cz = 0): [number, number] {
    const a = this.rnd() * Math.PI * 2;
    const d = Math.sqrt(minR * minR + this.rnd() * (maxR * maxR - minR * minR));
    return [Math.floor(cx + Math.cos(a) * d), Math.floor(cz + Math.sin(a) * d)];
  }

  /** Tries `place` at random spots until it succeeded `count` times (or ran out of tries). */
  scatter(count: number, minR: number, maxR: number, place: (x: number, z: number) => boolean, tries = count * 12): number {
    let made = 0;
    for (let i = 0; i < tries && made < count; i++) {
      const [x, z] = this.spot(minR, maxR);
      if (place(x, z)) made++;
    }
    return made;
  }

  // ---------------------------------------------------------------- ground

  /** Rolling hills out of noise. Neighbouring columns differ by a block at most, so every slope can
   *  be walked up; only holes make sheer drops. Low by the start circle, flat on the hill and at
   *  the island's rim. */
  hills(s: HillStyle): void {
    const n1 = valueNoise(this.rnd);
    const n2 = valueNoise(this.rnd);
    const cells: number[] = [];
    const R = ARENA_RADIUS;
    for (let x = -R - 1; x <= R; x++)
      for (let z = -R - 1; z <= R; z++) {
        if (!this.inside(x, z)) continue;
        const i = Voxels.cell(x, z);
        cells.push(i);
        if (this.hole(x, z)) continue;
        const d = this.dist(x, z);
        const v = 0.65 * n1(x * s.scale, z * s.scale) + 0.35 * n2(x * s.scale * 2.1 + 17, z * s.scale * 2.1 - 9);
        let cap = Math.min(s.max, this.cap[i]);
        if (Math.abs(d - this.spawnR) < SPAWN_BAND + 1) cap = Math.min(cap, 1);
        if (this.hill && d < HILL_RADIUS + 3) cap = 0;
        this.ground[i] = Math.max(0, Math.min(cap, Math.floor((v - s.bias) * s.amp)));
      }
    for (let changed = true; changed; ) {
      changed = false;
      for (const i of cells) {
        const h = this.ground[i];
        if (!h) continue;
        const [x, , z] = Voxels.decode(i);
        let low = h;
        for (const [dx, dz] of N4) {
          const nx = x + dx;
          const nz = z + dz;
          if (this.inside(nx, nz) && this.hole(nx, nz)) continue;
          low = Math.min(low, this.g(nx, nz));
        }
        if (h > low + 1) {
          this.ground[i] = low + 1;
          changed = true;
        }
      }
    }
    for (const i of cells) {
      const h = this.ground[i];
      if (!h) continue;
      const [x, , z] = Voxels.decode(i);
      this.column(x, z, 0, h - 1, s.fill);
      this.set(x, h - 1, z, s.top(x, z));
    }
  }

  // ---------------------------------------------------------------- holes

  /** Cells with no floor; they also keep structures away. */
  dig(x: number, z: number): void {
    if (!this.inside(x, z, 1) || this.dist(x, z) < HOLE_MIN_R || (this.hill && this.dist(x, z) < HILL_RADIUS + 4)) return;
    this.vox.holes.add(Voxels.cell(x, z));
  }

  /** A round pit with a ragged edge. */
  sinkhole(x: number, z: number, r: number): boolean {
    const span = Math.ceil(r) + 1;
    const d = this.dist(x, z);
    if (d < HOLE_MIN_R + r || d > this.radius - r - 4) return false;
    if (!this.claim(x - span, z - span, x + span, z + span, 1)) return false;
    for (let dx = -span; dx <= span; dx++)
      for (let dz = -span; dz <= span; dz++) {
        const k = Math.hypot(dx, dz) / r;
        if (k <= 0.75 || (k <= 1 && this.chance(0.6))) this.dig(x + dx, z + dz);
      }
    return true;
  }

  /** A chasm across the island, clear of the final ring, with `bridges` plank bridges over it. Dug
   *  before the hills, which then stay flat where the bridges land. */
  ravine(bridges: number): void {
    const theta = this.rnd() * Math.PI * 2;
    const ux = Math.cos(theta);
    const uz = Math.sin(theta);
    const nx = -uz;
    const nz = ux;
    const off = 17 + this.rnd() * 7;
    const amp = 1 + this.rnd() * 2.5;
    const freq = 0.06 + this.rnd() * 0.05;
    const phase = this.rnd() * Math.PI * 2;
    const width = valueNoise(this.rnd);
    const centre = (t: number) => off + amp * Math.sin(freq * t + phase);
    const half = (t: number) => 1.6 + 1.2 * width(t * 0.15, 3.7);
    const R = ARENA_RADIUS;
    for (let x = -R - 1; x <= R; x++)
      for (let z = -R - 1; z <= R; z++) {
        if (!this.inside(x, z)) continue;
        const px = x + 0.5;
        const pz = z + 0.5;
        const t = px * ux + pz * uz;
        const s = px * nx + pz * nz - centre(t);
        if (Math.abs(s) < half(t)) this.dig(x, z);
      }
    // Bridges spread along the chord, the middle one nearest the centre.
    const chord = Math.sqrt(Math.max(0, this.radius * this.radius - off * off)) - 6;
    for (let b = 0; b < bridges; b++) {
      const t = bridges === 1 ? 0 : -chord + ((2 * chord) / (bridges - 1)) * b + (this.rnd() - 0.5) * 4;
      // Across the chasm: the normal of its centre line at t.
      const slope = amp * freq * Math.cos(freq * t + phase);
      let ax = nx - slope * ux;
      let az = nz - slope * uz;
      const len = Math.hypot(ax, az);
      ax /= len;
      az /= len;
      const c = centre(t);
      const cx = t * ux + c * nx;
      const cz = t * uz + c * nz;
      const reach = half(t) + 2.5;
      this.bridge(cx, cz, ax, az, reach, this.chance(0.5) ? 1.6 : 1.1);
    }
  }

  /** Planks over the holes along a line, from bank to bank, a block above the floor, with log posts
   *  on both banks. The hills stay low where it lands. */
  bridge(cx: number, cz: number, ax: number, az: number, reach: number, halfWidth: number): void {
    const span = Math.ceil(reach) + 3;
    const deck: [number, number][] = [];
    for (let x = Math.floor(cx) - span; x <= Math.floor(cx) + span; x++)
      for (let z = Math.floor(cz) - span; z <= Math.floor(cz) + span; z++) {
        if (!this.inside(x, z)) continue;
        const rx = x + 0.5 - cx;
        const rz = z + 0.5 - cz;
        const across = rx * ax + rz * az;
        const along = rx * -az + rz * ax;
        if (Math.abs(along) > halfWidth + 1.5 || Math.abs(across) > reach + 3) continue;
        const i = Voxels.cell(x, z);
        this.cap[i] = 0;
        this.used[i] = 1;
        if (Math.abs(along) <= halfWidth && Math.abs(across) <= reach && this.hole(x, z)) deck.push([x, z]);
      }
    if (!deck.length) return;
    for (const [x, z] of deck) this.set(x, 0, z, BLOCK.planks);
    // A log post beside the deck on each bank, at the first floor cell out from the middle.
    for (const sa of [-1, 1])
      for (const sb of [-1, 1])
        for (let d = 0; d < reach + 3; d += 0.5) {
          const px = Math.floor(cx + ax * sa * d - az * sb * (halfWidth + 1));
          const pz = Math.floor(cz + az * sa * d + ax * sb * (halfWidth + 1));
          if (!this.inside(px, pz, 2)) break;
          if (this.hole(px, pz)) continue;
          if (d > 0.5 && !this.vox.get(px, 0, pz)) this.column(px, pz, 0, 2, BLOCK.log);
          break;
        }
  }

  // ---------------------------------------------------------------- plants

  /** An oak: a log trunk under a round crown of leaves. */
  oak(x: number, z: number, big = false): boolean {
    const r = big ? 3 : 2;
    if (!this.claim(x - r, z - r, x + r, z + r, big ? 1 : 0)) return false;
    const base = this.g(x, z);
    const trunk = big ? 6 : this.int(4, 5);
    const top = base + trunk;
    this.column(x, z, base, top, BLOCK.log);
    for (let dy = -2; dy <= 1; dy++) {
      const rr = dy < 0 ? r : r - 1;
      for (let dx = -rr; dx <= rr; dx++)
        for (let dz = -rr; dz <= rr; dz++) {
          const corner = Math.abs(dx) === rr && Math.abs(dz) === rr;
          if (corner && (dy >= 0 || this.chance(0.5))) continue;
          if (dy === 1 && Math.abs(dx) + Math.abs(dz) > rr) continue;
          this.put(x + dx, top + dy, z + dz, BLOCK.leaves);
        }
    }
    return true;
  }

  /** A spruce: a tall trunk, a cone of leaves, snow on top in winter. */
  spruce(x: number, z: number, snowy: boolean, big = false): boolean {
    if (!this.claim(x - 2, z - 2, x + 2, z + 2, big ? 1 : 0)) return false;
    const base = this.g(x, z);
    const trunk = big ? 8 : this.int(5, 7);
    const top = base + trunk;
    this.column(x, z, base, top, BLOCK.log);
    const layers: [number, (dx: number, dz: number) => boolean][] = [
      [top, (dx, dz) => dx === 0 && dz === 0],
      [top - 1, (dx, dz) => Math.abs(dx) + Math.abs(dz) <= 1],
      [top - 2, (dx, dz) => Math.abs(dx) <= 1 && Math.abs(dz) <= 1],
      [top - 3, (dx, dz) => Math.abs(dx) + Math.abs(dz) <= 1],
      [top - 4, (dx, dz) => Math.abs(dx) + Math.abs(dz) <= 2],
      [top - 5, (dx, dz) => Math.abs(dx) + Math.abs(dz) <= 3 && Math.abs(dx) < 3 && Math.abs(dz) < 3],
    ];
    if (big) layers.push([top - 6, (dx, dz) => Math.abs(dx) + Math.abs(dz) <= 2], [top - 7, (dx, dz) => Math.abs(dx) + Math.abs(dz) <= 3 && Math.abs(dx) < 3 && Math.abs(dz) < 3]);
    for (const [y, inLayer] of layers) {
      if (y <= base + 1) continue;
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (inLayer(dx, dz)) this.put(x + dx, y, z + dz, BLOCK.leaves);
    }
    if (snowy) {
      for (let dx = -2; dx <= 2; dx++)
        for (let dz = -2; dz <= 2; dz++) {
          for (let y = top; y > base; y--) {
            if (this.vox.get(x + dx, y, z + dz) !== BLOCK.leaves) continue;
            if (!this.vox.get(x + dx, y + 1, z + dz)) this.set(x + dx, y + 1, z + dz, BLOCK.snow);
            break;
          }
        }
    }
    return true;
  }

  /** A low wall of leaves. */
  hedge(x: number, z: number): boolean {
    const len = this.int(4, 8);
    const alongX = this.chance(0.5);
    const [x1, z1] = alongX ? [x + len - 1, z] : [x, z + len - 1];
    if (!this.claim(x, z, x1, z1, 1)) return false;
    const h = this.int(1, 2);
    for (let i = 0; i < len; i++) {
      const cx = alongX ? x + i : x;
      const cz = alongX ? z : z + i;
      if (i > 0 && i < len - 1 && this.chance(0.12)) continue;
      const g = this.g(cx, cz);
      this.column(cx, cz, g, g + (this.chance(0.25) ? 1 : h), BLOCK.leaves);
    }
    return true;
  }

  // ---------------------------------------------------------------- stone

  /** A half-buried lump of rock. */
  boulder(x: number, z: number, type: number = BLOCK.rock): boolean {
    const r = 1.2 + this.rnd() * 1.1;
    const span = Math.ceil(r);
    if (!this.claim(x - span, z - span, x + span, z + span, 1)) return false;
    const base = this.g(x, z);
    for (let dx = -span; dx <= span; dx++)
      for (let dz = -span; dz <= span; dz++)
        for (let dy = 0; dy <= span; dy++) {
          const k = (dx * dx + dz * dz) / (r * r) + (dy * dy) / (r * r * 0.7);
          if (k <= 1 && (k < 0.6 || this.chance(0.7))) this.put(x + dx, base + dy, z + dz, type);
        }
    return true;
  }

  /** A broken wall, following the ground. */
  wall(x: number, z: number, type: number, maxLen = 9, maxH = 4): boolean {
    const len = this.int(4, maxLen);
    const alongX = this.chance(0.5);
    const [x1, z1] = alongX ? [x + len - 1, z] : [x, z + len - 1];
    if (!this.claim(x, z, x1, z1, 1)) return false;
    const h = this.int(2, maxH);
    for (let i = 0; i < len; i++) {
      const cx = alongX ? x + i : x;
      const cz = alongX ? z : z + i;
      const ch = this.chance(0.12) ? 0 : this.chance(0.35) ? Math.max(1, h - this.int(1, 2)) : h;
      const g = this.g(cx, cz);
      this.column(cx, cz, g, g + ch, type);
    }
    return true;
  }

  /** A column, sometimes broken off, sometimes lying on the ground. */
  pillar(x: number, z: number, type: number, h = this.int(3, 6)): boolean {
    if (this.chance(0.2)) {
      // Fallen: a log-like row of drums.
      const len = this.int(3, 5);
      const alongX = this.chance(0.5);
      const [x1, z1] = alongX ? [x + len - 1, z] : [x, z + len - 1];
      if (!this.claim(x, z, x1, z1, 1)) return false;
      for (let i = 0; i < len; i++) {
        const cx = alongX ? x + i : x;
        const cz = alongX ? z : z + i;
        this.set(cx, this.g(cx, cz), cz, type);
      }
      return true;
    }
    if (!this.claim(x, z, x, z, 1)) return false;
    const g = this.g(x, z);
    this.column(x, z, g, g + h, type);
    return true;
  }

  /** A row of columns with what is left of the beams on top. */
  colonnade(x: number, z: number, type: number): boolean {
    const n = this.int(3, 5);
    const gap = 3;
    const len = (n - 1) * gap + 1;
    const alongX = this.chance(0.5);
    const [x1, z1] = alongX ? [x + len - 1, z] : [x, z + len - 1];
    if (!this.claim(x, z, x1, z1, 1)) return false;
    let base = 0;
    for (let i = 0; i < len; i++) base = Math.max(base, alongX ? this.g(x + i, z) : this.g(x, z + i));
    const top = base + this.int(3, 4);
    for (let i = 0; i < len; i++) {
      const cx = alongX ? x + i : x;
      const cz = alongX ? z : z + i;
      if (i % gap === 0) {
        if (this.chance(0.25) && i > 0) this.column(cx, cz, this.g(cx, cz), base + this.int(1, 2), type);
        else this.column(cx, cz, this.g(cx, cz), top + 1, type);
      } else if (this.chance(0.6)) {
        this.set(cx, top, cz, type);
      }
    }
    // Beams only rest on standing columns.
    for (let i = 0; i < len; i++) {
      const cx = alongX ? x + i : x;
      const cz = alongX ? z : z + i;
      if (i % gap === 0) continue;
      const lo = alongX ? this.vox.get(cx - (i % gap), top, cz) : this.vox.get(cx, top, cz - (i % gap));
      const hi = alongX ? this.vox.get(cx + gap - (i % gap), top, cz) : this.vox.get(cx, top, cz + gap - (i % gap));
      if (!lo && !hi) this.set(cx, top, cz, 0);
    }
    return true;
  }

  /** Four walls with door gaps and windows, partly fallen in, maybe half a plank roof. A rubble heap
   *  by one wall leads up onto it. */
  house(x: number, z: number): boolean {
    const w = this.int(5, 7);
    const d = this.int(5, 7);
    if (!this.claim(x - 1, z - 1, x + w, z + d, 1)) return false;
    const type = this.chance(0.5) ? BLOCK.bricks : BLOCK.stone;
    let base = 0;
    for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) base = Math.max(base, this.g(x + i, z + j));
    const top = base + 3;
    const doors = new Set<string>();
    const sides = [0, 1, 2, 3].sort(() => this.rnd() - 0.5).slice(0, this.int(1, 2));
    for (const side of sides) {
      const along = side < 2 ? w : d;
      const at = this.int(1, along - 3);
      for (let k = at; k < at + 2; k++) doors.add(side === 0 ? `${x + k},${z}` : side === 1 ? `${x + k},${z + d - 1}` : side === 2 ? `${x},${z + k}` : `${x + w - 1},${z + k}`);
    }
    for (let i = 0; i < w; i++)
      for (let j = 0; j < d; j++) {
        const edge = i === 0 || j === 0 || i === w - 1 || j === d - 1;
        if (!edge) continue;
        const cx = x + i;
        const cz = z + j;
        const g = this.g(cx, cz);
        const corner = (i === 0 || i === w - 1) && (j === 0 || j === d - 1);
        let h = top + (corner ? 1 : 0);
        if (!corner && this.chance(0.25)) h = Math.max(g + 1, top - this.int(1, 2));
        for (let y = g; y < h; y++) {
          if (doors.has(`${cx},${cz}`) && y < g + 2) continue;
          if (!corner && y === g + 1 && this.chance(0.15)) continue;
          this.set(cx, y, cz, type);
        }
      }
    if (this.chance(0.6)) {
      const fallen = valueNoise(this.rnd);
      for (let i = 1; i < w - 1; i++) for (let j = 1; j < d - 1; j++) if (fallen(i * 0.6, j * 0.6) > 0.4) this.set(x + i, top - 1, z + j, BLOCK.planks);
    }
    // Rubble against a wall without a door: steps of one block up to the top.
    const side = [0, 1, 2, 3].find((s) => !sides.includes(s)) ?? 0;
    const mid = side < 2 ? x + Math.floor(w / 2) : z + Math.floor(d / 2);
    const steps = top - base - 1;
    for (let k = 1; k <= steps; k++) {
      const out = steps - k + 1;
      const [cx, cz] = side === 0 ? [mid, z - out] : side === 1 ? [mid, z + d - 1 + out] : side === 2 ? [x - out, mid] : [x + w - 1 + out, mid];
      const g = this.g(cx, cz);
      this.column(cx, cz, g, Math.max(g, base + k), BLOCK.stone);
    }
    return true;
  }

  /** A plank platform on log posts with a stair of blocks up to it: high ground. */
  tower(x: number, z: number): boolean {
    const east = this.chance(0.5);
    // Platform x..x+2, z..z+2; stair three cells off one side.
    const [x0, z0, x1, z1] = east ? [x, z, x + 5, z + 2] : [x, z, x + 2, z + 5];
    if (!this.claim(x0, z0, x1, z1, 1)) return false;
    let base = 0;
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) base = Math.max(base, this.g(i, j));
    const deck = base + 3;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const cx = x + i;
        const cz = z + j;
        if ((i === 0 || i === 2) && (j === 0 || j === 2)) {
          this.column(cx, cz, this.g(cx, cz), deck, BLOCK.log);
          this.set(cx, deck + 1, cz, BLOCK.log);
        }
        this.set(cx, deck, cz, BLOCK.planks);
      }
    for (let k = 1; k <= 3; k++) {
      // Step k (from the platform outwards) is deck - k + 1 high.
      const cx = east ? x + 2 + k : x + 1;
      const cz = east ? z + 1 : z + 2 + k;
      const g = this.g(cx, cz);
      this.column(cx, cz, g, Math.max(g, deck - k + 1), BLOCK.planks);
    }
    return true;
  }

  /** Two legs and a lintel. */
  arch(x: number, z: number, type: number): boolean {
    const alongX = this.chance(0.5);
    const len = 5;
    const [x1, z1] = alongX ? [x + len - 1, z] : [x, z + len - 1];
    if (!this.claim(x, z, x1, z1, 1)) return false;
    let base = 0;
    for (let i = 0; i < len; i++) base = Math.max(base, alongX ? this.g(x + i, z) : this.g(x, z + i));
    const top = base + this.int(3, 4);
    for (let i = 0; i < len; i++) {
      const cx = alongX ? x + i : x;
      const cz = alongX ? z : z + i;
      if (i === 0 || i === len - 1) this.column(cx, cz, this.g(cx, cz), top + 1, type);
      else this.set(cx, top, cz, type);
    }
    return true;
  }

  /** A jagged 2×2 spire of rock. */
  spire(x: number, z: number): boolean {
    if (!this.claim(x, z, x + 1, z + 1, 1)) return false;
    const h = this.int(4, 7);
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 2; j++) {
        const g = this.g(x + i, z + j);
        this.column(x + i, z + j, g, g + h - this.int(0, 2), BLOCK.rock);
      }
    return true;
  }

  /** Claims the middle of the island for a centrepiece (never in King of the Hill). */
  centre(r: number): boolean {
    for (let x = -r - 1; x <= r; x++) for (let z = -r - 1; z <= r; z++) if (this.used[Voxels.cell(x, z)]) return false;
    for (let x = -r - 1; x <= r; x++) for (let z = -r - 1; z <= r; z++) this.used[Voxels.cell(x, z)] = 1;
    return true;
  }
}

const grassTop = () => BLOCK.grass;

function meadow(b: Builder): void {
  b.hills({ amp: 10, scale: 0.07, bias: 0.45, max: 5, top: grassTop, fill: BLOCK.rock });
  if (!b.hill) b.oak(0, 0, true);
  for (let grove = 0; grove < 6; grove++) {
    const [gx, gz] = b.spot(10, b.radius - 6);
    b.scatter(b.int(2, 4), 0, 6, (x, z) => b.oak(gx + x, gz + z), 30);
  }
  b.scatter(b.int(6, 9), 8, b.radius - 3, (x, z) => b.oak(x, z));
  b.scatter(b.int(5, 8), 6, b.radius - 3, (x, z) => b.hedge(x, z));
  b.scatter(b.int(6, 9), 6, b.radius - 3, (x, z) => b.boulder(x, z));
}

function ruins(b: Builder): void {
  b.scatter(b.int(1, 2), HOLE_MIN_R, b.radius - 8, (x, z) => b.sinkhole(x, z, 1.6 + b.rnd() * 0.8));
  b.hills({ amp: 7, scale: 0.06, bias: 0.5, max: 3, top: grassTop, fill: BLOCK.rock });
  if (!b.hill && b.centre(6)) {
    // A ring of marble columns round an altar.
    const n = 8;
    const top = 4;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const x = Math.floor(Math.cos(a) * 5.5);
      const z = Math.floor(Math.sin(a) * 5.5);
      const broken = b.chance(0.3);
      b.column(x, z, b.g(x, z), broken ? top - b.int(1, 2) : top + 1, BLOCK.bone);
    }
    b.column(-1, -1, 0, 1, BLOCK.stone);
    b.set(-1, 1, -1, BLOCK.gold);
  }
  b.scatter(b.int(3, 5), 10, b.radius - 6, (x, z) => b.house(x, z));
  b.scatter(2, 12, b.radius - 6, (x, z) => b.tower(x, z));
  b.scatter(b.int(2, 3), 8, b.radius - 5, (x, z) => b.colonnade(x, z, b.chance(0.6) ? BLOCK.bone : BLOCK.stone));
  b.scatter(b.int(8, 11), 6, b.radius - 3, (x, z) => b.wall(x, z, b.chance(0.5) ? BLOCK.bricks : BLOCK.stone));
  b.scatter(b.int(8, 12), 6, b.radius - 3, (x, z) => b.pillar(x, z, b.chance(0.5) ? BLOCK.bone : BLOCK.stone));
  b.scatter(b.int(2, 4), 8, b.radius - 3, (x, z) => b.oak(x, z));
}

function canyon(b: Builder): void {
  b.ravine(3);
  b.scatter(b.int(1, 2), HOLE_MIN_R, b.radius - 8, (x, z) => b.sinkhole(x, z, 1.5 + b.rnd()));
  const moss = valueNoise(b.rnd);
  b.hills({ amp: 12, scale: 0.085, bias: 0.47, max: 6, top: (x, z) => (moss(x * 0.15, z * 0.15) > 0.55 ? BLOCK.grass : BLOCK.rock), fill: BLOCK.rock });
  if (!b.hill && b.centre(2)) b.column(-1, -1, 0, 3, BLOCK.rock);
  b.scatter(b.int(6, 9), 6, b.radius - 3, (x, z) => b.spire(x, z));
  b.scatter(b.int(2, 3), 8, b.radius - 4, (x, z) => b.arch(x, z, BLOCK.rock));
  b.scatter(b.int(5, 8), 6, b.radius - 3, (x, z) => b.boulder(x, z));
  b.scatter(1, 12, b.radius - 6, (x, z) => b.tower(x, z));
  b.scatter(b.int(2, 4), 8, b.radius - 3, (x, z) => b.oak(x, z));
}

function winter(b: Builder): void {
  b.scatter(b.int(3, 4), HOLE_MIN_R, b.radius - 8, (x, z) => b.sinkhole(x, z, 1.5 + b.rnd() * 1.3));
  b.hills({ amp: 10, scale: 0.08, bias: 0.44, max: 5, top: () => BLOCK.snow, fill: BLOCK.rock });
  if (!b.hill) b.spruce(0, 0, true, true);
  b.scatter(b.int(14, 20), 6, b.radius - 3, (x, z) => b.spruce(x, z, true));
  b.scatter(b.int(4, 6), 6, b.radius - 3, (x, z) => b.wall(x, z, BLOCK.stone, 7, 3));
  b.scatter(b.int(2, 3), 8, b.radius - 3, (x, z) => b.pillar(x, z, BLOCK.obsidian, b.int(2, 3)));
  b.scatter(b.int(4, 6), 6, b.radius - 3, (x, z) => b.boulder(x, z));
  // Snow on the stone that stands in the open.
  for (const i of [...b.vox.filled]) {
    const [x, y, z] = Voxels.decode(i);
    const stone = b.vox.data[i] === BLOCK.stone || b.vox.data[i] === BLOCK.rock;
    if (stone && y + 1 < MAP_TOP && !b.vox.get(x, y + 1, z) && b.chance(0.7)) b.set(x, y + 1, z, BLOCK.snow);
  }
}

const THEMES: Record<MapId, (b: Builder) => void> = { meadow, ruins, canyon, winter };

/** Builds map `id` into `vox` (expected empty: blocks and holes). */
export function generateMap(vox: Voxels, id: MapId, opts: MapOptions = {}, rnd: () => number = Math.random): void {
  const b = new Builder(vox, rnd, opts.radius ?? ARENA_RADIUS, opts.spawnR ?? SPAWN_RADIUS, opts.hill ?? false);
  THEMES[id](b);
}
