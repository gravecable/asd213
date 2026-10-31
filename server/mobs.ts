// Hub mobs: training skeletons simulated on the server with the players' own physics, and the
// archer's arrows. Pure game logic; the server wires hits, messages and stats around it.
import {
  ARENA_RADIUS,
  EYE_HEIGHT,
  HUB,
  MAX_HP,
  MOB_ID_BASE,
  MOB_KINDS,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  buffModifiers,
  inCircle,
  segmentClear,
  stepBody,
  yawTowards,
} from "../src/game/shared.ts";
import type { Body, MobKind, MoveInput, Spot, Vec3, Voxels } from "../src/game/shared.ts";

export const MOB_STEP_S = 0.05;
const NO_MODS = buffModifiers(null);
const DUMMY_RESET_MS = 3000;
const WALKER_RESPAWN_MS = 2000;
const CLIFF_RESPAWN_MS = 1500;
const CLIFF_KNOCKBACK = 1.3;
/** A skeleton that falls below this was knocked off the cliff. */
const CLIFF_FALLEN_Y = 1;
const ARCHER_PERIOD_MS = 2200;
const ARROW_SPEED = 13;
const ARROW_GRAVITY = 8;
const ARROW_LIFE_MS = 4000;
/** Arrows hit a player's box grown by this much. */
const ARROW_PAD = 0.1;

export interface Mob {
  id: number;
  kind: MobKind;
  /** Range targets belong to one player and only they see them. */
  owner: number | null;
  body: Body;
  yaw: number;
  hp: number;
  maxHp: number;
  home: Spot;
  dead: boolean;
  respawnAt: number;
  /** Range targets vanish (a miss) at this time. */
  expiresAt: number;
  lastHitAt: number;
  lastHitBy: number | null;
  input: MoveInput;
  nextThinkAt: number;
  nextShotAt: number;
  /** Positions as sent in recent ticks, to rewind hits to what the attacker saw. */
  seenAt: { s: number; x: number; y: number; z: number }[];
}

export interface Arrow {
  id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** The player it was shot at: a miss counts as a dodge for them. */
  target: number;
  bornAt: number;
}

/** A player as the mobs see it. */
export interface Walker extends Vec3 {
  id: number;
}

export type MobEvent =
  | { t: "knocked"; mob: Mob; by: number }
  | { t: "arrowHit"; arrow: Arrow; player: number }
  | { t: "dodged"; arrow: Arrow; player: number };

function newMob(id: number, kind: MobKind, home: Spot, maxHp = MAX_HP, owner: number | null = null): Mob {
  return {
    id,
    kind,
    owner,
    body: { pos: { x: home.x, y: home.y, z: home.z }, vel: { x: 0, y: 0, z: 0 }, onGround: false, jumpsLeft: 0, jumpHeld: false },
    yaw: home.yaw,
    hp: maxHp,
    maxHp,
    home,
    dead: false,
    respawnAt: 0,
    expiresAt: Infinity,
    lastHitAt: 0,
    lastHitBy: null,
    input: { forward: 0, strafe: 0, jump: false, yaw: home.yaw },
    nextThinkAt: 0,
    nextShotAt: 0,
    seenAt: [],
  };
}

/** Interior of the walker pen, as limits for a skeleton's centre. */
function penLimits() {
  const p = HUB.pen;
  const m = PLAYER_HALF_WIDTH + 0.01;
  return { x0: p.x0 + 1 + m, x1: p.x1 - m, z0: p.z0 + 1 + m, z1: p.z1 - m };
}

function randomPenSpot(rnd: () => number): Spot {
  const l = penLimits();
  return { x: l.x0 + rnd() * (l.x1 - l.x0), y: 0, z: l.z0 + rnd() * (l.z1 - l.z0), yaw: rnd() * Math.PI * 2 };
}

export class MobWorld {
  readonly mobs = new Map<number, Mob>();
  readonly arrows = new Map<number, Arrow>();
  private nextMobId = MOB_ID_BASE;
  private nextArrowId = 1;
  private readonly world: Voxels;
  private readonly rnd: () => number;

  constructor(world: Voxels, rnd: () => number = Math.random) {
    this.world = world;
    this.rnd = rnd;
    for (const d of HUB.dummies) this.add(newMob(this.nextMobId++, "dummy", d));
    for (let i = 0; i < 2; i++) this.add(newMob(this.nextMobId++, "walker", randomPenSpot(rnd)));
    for (const c of HUB.cliffMobs) this.add(newMob(this.nextMobId++, "cliff", c));
    this.add(newMob(this.nextMobId++, "archer", HUB.archer));
  }

  private add(m: Mob): Mob {
    this.mobs.set(m.id, m);
    return m;
  }

  /** A shooting-range target for one player; dies from a single hit. */
  spawnTarget(owner: number, spot: Spot, ttlMs: number, now: number): Mob {
    const m = this.add(newMob(this.nextMobId++, "target", spot, 1, owner));
    m.expiresAt = now + ttlMs;
    return m;
  }

  remove(id: number): void {
    this.mobs.delete(id);
  }

  /** Flat tick row: [id, kindIndex, x, y, z, yaw, hp, maxHp]. */
  static row(m: Mob): number[] {
    const p = m.body.pos;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return [m.id, MOB_KINDS.indexOf(m.kind), r2(p.x), r2(p.y), r2(p.z), r2(m.yaw), m.hp, m.maxHp];
  }

  /** Applies a validated hit. Returns what happened to the mob. */
  hit(m: Mob, by: number, dmg: number, kx: number, ky: number, kz: number, now: number): "hurt" | "reset" | "killed" | "immune" {
    m.lastHitAt = now;
    m.lastHitBy = by;
    const v = m.body.vel;
    // Cliff skeletons are light: a clean hit sends them over the edge.
    const k = m.kind === "cliff" ? CLIFF_KNOCKBACK : 1;
    v.x += kx * k;
    v.z += kz * k;
    v.y = Math.max(v.y, ky);
    m.body.onGround = false;
    if (m.kind === "cliff" || m.kind === "archer") return "immune";
    m.hp -= dmg;
    if (m.hp > 0) return "hurt";
    if (m.kind === "dummy") {
      m.hp = m.maxHp;
      return "reset";
    }
    m.hp = 0;
    m.dead = true;
    m.respawnAt = m.kind === "walker" ? now + WALKER_RESPAWN_MS : Infinity;
    return "killed";
  }

  /** One server tick: AI, physics, respawns, arrows. */
  step(walkers: Walker[], now: number): MobEvent[] {
    const events: MobEvent[] = [];
    for (const m of this.mobs.values()) {
      if (m.dead) {
        if (now >= m.respawnAt) this.respawn(m);
        continue;
      }
      this.think(m, walkers, now);
      stepBody(this.world, m.body, m.input, MOB_STEP_S, NO_MODS, ARENA_RADIUS);
      if (m.kind === "walker") this.keepInPen(m);
      if (m.kind === "cliff" && m.body.pos.y < CLIFF_FALLEN_Y && m.body.onGround) {
        if (m.lastHitBy !== null && now - m.lastHitAt < 6000) events.push({ t: "knocked", mob: m, by: m.lastHitBy });
        m.dead = true;
        m.respawnAt = now + CLIFF_RESPAWN_MS;
      }
      if (m.kind === "archer") this.shoot(m, walkers, now);
    }
    this.stepArrows(walkers, now, events);
    return events;
  }

  private respawn(m: Mob): void {
    const home = m.kind === "walker" ? randomPenSpot(this.rnd) : m.home;
    Object.assign(m.body.pos, { x: home.x, y: home.y, z: home.z });
    Object.assign(m.body.vel, { x: 0, y: 0, z: 0 });
    m.yaw = home.yaw;
    m.hp = m.maxHp;
    m.dead = false;
    m.lastHitBy = null;
    m.seenAt = [];
  }

  private nearest(m: Mob, walkers: Walker[], range: number): Walker | null {
    let best: Walker | null = null;
    let bestD = range;
    const p = m.body.pos;
    for (const w of walkers) {
      const d = Math.hypot(w.x - p.x, w.z - p.z);
      if (d < bestD) {
        bestD = d;
        best = w;
      }
    }
    return best;
  }

  private turnTowards(m: Mob, yaw: number, rate: number): void {
    let d = yaw - m.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    m.yaw += Math.max(-rate, Math.min(rate, d));
  }

  private think(m: Mob, walkers: Walker[], now: number): void {
    const p = m.body.pos;
    const inp = m.input;
    inp.jump = false;
    const watch = this.nearest(m, walkers, m.kind === "walker" ? 10 : 8);
    if (m.kind === "dummy" || m.kind === "cliff") {
      if (m.kind === "dummy" && m.hp < m.maxHp && now - m.lastHitAt > DUMMY_RESET_MS) m.hp = m.maxHp;
      // Shuffle back to the post after being knocked away.
      const away = Math.hypot(m.home.x - p.x, m.home.z - p.z);
      const onPost = m.kind === "dummy" || p.y >= m.home.y - 0.1;
      if (away > 0.35 && onPost && now - m.lastHitAt > 400) {
        inp.yaw = yawTowards(p.x, p.z, m.home.x, m.home.z);
        inp.forward = away > 1 ? 1 : 0.5;
        inp.strafe = 0;
        m.yaw = inp.yaw;
      } else {
        inp.forward = 0;
        inp.strafe = 0;
        if (watch) this.turnTowards(m, yawTowards(p.x, p.z, watch.x, watch.z), 0.15);
        inp.yaw = m.yaw;
      }
      return;
    }
    if (m.kind === "walker") {
      if (now >= m.nextThinkAt) {
        m.nextThinkAt = now + 500 + this.rnd() * 700;
        inp.strafe = [-1, 0, 1][Math.floor(this.rnd() * 3)];
        inp.forward = watch ? [0, 0, 1, -1][Math.floor(this.rnd() * 4)] : this.rnd() < 0.6 ? 1 : 0;
        if (this.rnd() < 0.3) inp.jump = true;
        if (!watch) m.yaw = this.rnd() * Math.PI * 2;
      }
      if (watch) this.turnTowards(m, yawTowards(p.x, p.z, watch.x, watch.z), 0.25);
      inp.yaw = m.yaw;
      return;
    }
    if (m.kind === "archer") {
      inp.forward = inp.strafe = 0;
      const target = this.archerTarget(m, walkers);
      if (target) this.turnTowards(m, yawTowards(p.x, p.z, target.x, target.z), 0.3);
      inp.yaw = m.yaw;
      return;
    }
    // Range target: stands still facing its owner.
    inp.forward = inp.strafe = 0;
    const owner = walkers.find((w) => w.id === m.owner);
    if (owner) m.yaw = yawTowards(p.x, p.z, owner.x, owner.z);
    inp.yaw = m.yaw;
  }

  private keepInPen(m: Mob): void {
    const l = penLimits();
    const p = m.body.pos;
    const x = Math.max(l.x0, Math.min(l.x1, p.x));
    const z = Math.max(l.z0, Math.min(l.z1, p.z));
    if (x !== p.x) m.body.vel.x = 0;
    if (z !== p.z) m.body.vel.z = 0;
    p.x = x;
    p.z = z;
  }

  private eye(m: Mob): Vec3 {
    const p = m.body.pos;
    return { x: p.x, y: p.y + EYE_HEIGHT, z: p.z };
  }

  private archerTarget(m: Mob, walkers: Walker[]): Walker | null {
    const eye = this.eye(m);
    let best: Walker | null = null;
    let bestD = Infinity;
    for (const w of walkers) {
      if (!inCircle(w.x, w.z, HUB.archerZone)) continue;
      const chest = { x: w.x, y: w.y + 1.2, z: w.z };
      if (!segmentClear(this.world, eye, chest, -999, -999, -999)) continue;
      const d = Math.hypot(w.x - eye.x, w.z - eye.z);
      if (d < bestD) {
        bestD = d;
        best = w;
      }
    }
    return best;
  }

  private shoot(m: Mob, walkers: Walker[], now: number): void {
    if (now < m.nextShotAt) return;
    const target = this.archerTarget(m, walkers);
    if (!target) return;
    m.nextShotAt = now + ARCHER_PERIOD_MS;
    const eye = this.eye(m);
    const dx = target.x - eye.x;
    const dy = target.y + 1.2 - eye.y;
    const dz = target.z - eye.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    const flight = dist / ARROW_SPEED;
    const a: Arrow = {
      id: this.nextArrowId++,
      x: eye.x,
      y: eye.y,
      z: eye.z,
      vx: (dx / dist) * ARROW_SPEED,
      vy: (dy / dist) * ARROW_SPEED + 0.5 * ARROW_GRAVITY * flight,
      vz: (dz / dist) * ARROW_SPEED,
      target: target.id,
      bornAt: now,
    };
    this.arrows.set(a.id, a);
  }

  private stepArrows(walkers: Walker[], now: number, events: MobEvent[]): void {
    const dt = MOB_STEP_S;
    for (const a of this.arrows.values()) {
      const from = { x: a.x, y: a.y, z: a.z };
      a.vy -= ARROW_GRAVITY * dt;
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.z += a.vz * dt;
      let hit: Walker | null = null;
      for (let k = 1; k <= 4 && !hit; k++) {
        const t = k / 4;
        const q = { x: from.x + (a.x - from.x) * t, y: from.y + (a.y - from.y) * t, z: from.z + (a.z - from.z) * t };
        for (const w of walkers) {
          const hw = PLAYER_HALF_WIDTH + ARROW_PAD;
          if (Math.abs(q.x - w.x) <= hw && Math.abs(q.z - w.z) <= hw && q.y >= w.y - ARROW_PAD && q.y <= w.y + PLAYER_HEIGHT + ARROW_PAD) {
            hit = w;
            break;
          }
        }
      }
      const stuck = this.world.solid(Math.floor(a.x), Math.floor(a.y), Math.floor(a.z));
      if (hit) {
        events.push({ t: "arrowHit", arrow: a, player: hit.id });
        if (hit.id !== a.target) events.push({ t: "dodged", arrow: a, player: a.target });
        this.arrows.delete(a.id);
      } else if (stuck || now - a.bornAt > ARROW_LIFE_MS) {
        events.push({ t: "dodged", arrow: a, player: a.target });
        this.arrows.delete(a.id);
      }
    }
  }

  /** Flat tick row: [id, x, y, z, vx, vy, vz]. */
  static arrowRow(a: Arrow): number[] {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return [a.id, r2(a.x), r2(a.y), r2(a.z), r2(a.vx), r2(a.vy), r2(a.vz)];
  }
}
