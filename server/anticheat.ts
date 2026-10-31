// Server-side anticheat. The browser client is entirely under the player's control, so nothing it
// reports is taken on trust: every move is replayed against the shared physics (src/game/shared.ts),
// every action is re-checked against server state, and repeated violations end in a kick and a
// temporary IP ban. Runs under Node type stripping: erasable TypeScript only.
import type { IncomingMessage } from "node:http";
import {
  AIR_ACCEL,
  CLOSE_BANNED,
  CLOSE_FULL,
  CLOSE_TOO_MANY,
  JUMP_SPEED,
  MAX_FALL_SPEED,
  MAX_HEIGHT,
  MAX_STEP_DT,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  SPRINT_JUMP_BOOST,
  SPRINT_SPEED,
} from "../src/game/shared.ts";
import type { Vec3, Voxels } from "../src/game/shared.ts";

// ------------------------------------------------------------------ configuration

export interface AcConfig {
  /** false: still correct positions and drop invalid actions, but never kick or ban. */
  kick: boolean;
  /** Violation level that gets a player kicked (points halve every minute). */
  kickVl: number;
  /** Ban length after BAN_AFTER_KICKS kicks within BAN_WINDOW_MS; 0 disables bans. */
  banMinutes: number;
  /** Simultaneous connections per IP; 0 = unlimited. */
  maxConnPerIp: number;
  maxClients: number;
  /** Accepted Origin headers; empty = any (the static site may live on another host). */
  allowedOrigins: string[];
  /** Header with the real client IP behind a proxy/CDN, e.g. "cf-connecting-ip". */
  ipHeader: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AcConfig {
  const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    kick: env.PVP_AC_KICK !== "0",
    kickVl: num(env.PVP_AC_KICK_VL, 30),
    banMinutes: num(env.PVP_AC_BAN_MINUTES, 15),
    maxConnPerIp: num(env.PVP_MAX_CONN_PER_IP, 4),
    maxClients: num(env.PVP_MAX_CLIENTS, 100),
    allowedOrigins: (env.PVP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    ipHeader: (env.PVP_CLIENT_IP_HEADER ?? "").trim().toLowerCase(),
  };
}

const VL_HALF_LIFE_MS = 60_000;
const BAN_AFTER_KICKS = 2;
const BAN_WINDOW_MS = 30 * 60_000;
/** Connection attempts per IP: enough for a classroom or carrier-grade NAT behind one address,
 *  while still stopping reconnect floods. */
const CONNECT_BURST = 30;
const CONNECTS_PER_SEC = 3;
/** Messages per second a client may send (≈20 moves + actions), with a burst allowance. */
export const MSG_BURST = 200;
export const MSG_PER_SEC = 100;

/** Short reasons shown to a kicked player (WebSocket close reasons are capped at 123 bytes). */
export const CHECK_LABELS: Record<string, string> = {
  speed: "скорость",
  fly: "полёт",
  noclip: "сквозь блоки",
  timer: "ускорение времени",
  ring: "за границей арены",
  reach: "дальность удара",
  aim: "удар без прицела",
  wall: "удар сквозь стену",
  hitrate: "частота ударов",
  build: "стройка",
  velocity: "игнор отбрасывания",
  flood: "флуд",
  packet: "неверные данные",
};

// ------------------------------------------------------------------ small utilities

export function decayVl(vl: number, elapsedMs: number): number {
  return vl * Math.pow(0.5, Math.max(0, elapsedMs) / VL_HALF_LIFE_MS);
}

export class TokenBucket {
  private tokens: number;
  private at: number;
  private readonly cap: number;
  private readonly perSec: number;

  constructor(cap: number, perSec: number, now: number) {
    this.cap = cap;
    this.perSec = perSec;
    this.tokens = cap;
    this.at = now;
  }

  take(now: number): boolean {
    this.tokens = Math.min(this.cap, this.tokens + ((now - this.at) / 1000) * this.perSec);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  full(now: number): boolean {
    return this.tokens + ((now - this.at) / 1000) * this.perSec >= this.cap;
  }
}

// ------------------------------------------------------------------ connections

function isPrivate(ip: string): boolean {
  return ip === "::1" || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cd]|fe80:)/i.test(ip);
}

export interface ClientAddr {
  ip: string;
  /** False when players can't be told apart by address: a local proxy that doesn't pass
   *  X-Forwarded-For, or a game on a LAN. Per-IP limits and bans then stay off for them. */
  known: boolean;
}

/** Client address. X-Forwarded-For is only believed from a local proxy, and then only the hop that
 *  proxy appended (the leftmost entries are whatever the client chose to send). */
export function clientIp(req: IncomingMessage, header: string): ClientAddr {
  const remote = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim();
  if (header) {
    const v = first(req.headers[header]);
    if (v) return { ip: v.split(",")[0].trim(), known: true };
  }
  if (!isPrivate(remote)) return { ip: remote, known: true };
  const xff = first(req.headers["x-forwarded-for"]);
  const hop = xff?.split(",").at(-1)?.trim().replace(/^::ffff:/, "");
  return hop ? { ip: hop, known: true } : { ip: remote, known: false };
}

export function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  return !allowed.length || (!!origin && allowed.includes(origin));
}

export class IpGuard {
  private readonly cfg: AcConfig;
  private conns = new Map<string, number>();
  private attempts = new Map<string, TokenBucket>();
  private bans = new Map<string, number>();
  private kicks = new Map<string, number[]>();

  constructor(cfg: AcConfig) {
    this.cfg = cfg;
  }

  /** Cheap gate before the WebSocket upgrade, against reconnect floods. */
  allowAttempt({ ip, known }: ClientAddr, now: number): boolean {
    if (!known) return true;
    let b = this.attempts.get(ip);
    if (!b) this.attempts.set(ip, (b = new TokenBucket(CONNECT_BURST, CONNECTS_PER_SEC, now)));
    return b.take(now);
  }

  /** Why a new connection must be closed right away, or null to admit it. */
  refuse({ ip, known }: ClientAddr, total: number, now: number): { code: number; reason: string } | null {
    const until = known ? (this.bans.get(ip) ?? 0) : 0;
    if (until > now) return { code: CLOSE_BANNED, reason: `ещё ${Math.ceil((until - now) / 60_000)} мин` };
    if (total >= this.cfg.maxClients) return { code: CLOSE_FULL, reason: "" };
    if (known && this.cfg.maxConnPerIp > 0 && (this.conns.get(ip) ?? 0) >= this.cfg.maxConnPerIp) return { code: CLOSE_TOO_MANY, reason: "" };
    return null;
  }

  opened(ip: string): void {
    this.conns.set(ip, (this.conns.get(ip) ?? 0) + 1);
  }

  closed(ip: string): void {
    const n = (this.conns.get(ip) ?? 1) - 1;
    if (n > 0) this.conns.set(ip, n);
    else this.conns.delete(ip);
  }

  /** Records a kick; returns the ban length in minutes when this kick earns a ban. */
  kicked(ip: string, now: number): number {
    if (!this.cfg.banMinutes) return 0;
    const recent = (this.kicks.get(ip) ?? []).filter((t) => now - t < BAN_WINDOW_MS);
    recent.push(now);
    if (recent.length < BAN_AFTER_KICKS) {
      this.kicks.set(ip, recent);
      return 0;
    }
    this.kicks.delete(ip);
    this.bans.set(ip, now + this.cfg.banMinutes * 60_000);
    return this.cfg.banMinutes;
  }

  sweep(now: number): void {
    for (const [ip, until] of this.bans) if (until <= now) this.bans.delete(ip);
    for (const [ip, list] of this.kicks) if (list.every((t) => now - t >= BAN_WINDOW_MS)) this.kicks.delete(ip);
    for (const [ip, b] of this.attempts) if (b.full(now)) this.attempts.delete(ip);
  }
}

// ------------------------------------------------------------------ movement

/** Velocity and position slack: the physics is replayed exactly, this only absorbs float noise. */
const EV = 0.01;
const EY = 0.01;
const SPEED_SLACK = 1.02;
/** How far the client's physics clock may run ahead of real time, and how much lag it may bank. */
const DRIFT_MAX_MS = 250;
const DRIFT_FLOOR_MS = -1000;
const MAX_GAP_MS = 1000;
/** Silence this long means the network held the client's moves back; they then arrive in a burst
 *  that looks like a fast clock. The floor caps how much of the silence is remembered, so a long
 *  stall can still trip the timer check: within the grace period that costs a correction, no points. */
const STALL_GAP_MS = 500;
const STALL_GRACE_MS = 1000;
/** Physics budget for a first move that doesn't acknowledge the teleport exactly. */
const FIRST_MOVE_S = 0.25;
/** Path samples may cut corners a little: straight lines between reports, curved real paths. */
const PATH_STEP = 0.1;
const PATH_SHRINK_XZ = 0.15;
const PATH_SHRINK_Y = 0.1;
/** Knockback velocity has decayed away after this much client time. */
const KB_SIM_MS = 3000;
/** Knockback the client hasn't acknowledged after this long (+RTT) counts as ignored. */
export const KB_ACK_MS = 5000;
/** After a sprint ends, the client's velocity decays to walking speed; in the air that takes about a
 *  second. Sprint speed stays allowed this long (client clock), but credits don't pile up, so
 *  toggling the flag never gives more than sprint speed. */
const SPRINT_TAIL_MS = 1500;
/** One sprint-jump push per move at most, and only a few still in flight: even bouncing off a ceiling
 *  right above the head at a high frame rate (a jump every ~0.14 s), four cover the overlap. */
const SPRINT_JUMP_GAP_MS = 50;
const SPRINT_JUMP_CREDITS = 4;

/** Extra velocity the server handed out: knockback, or the tail of a speed buff that just ended. */
export interface KbCredit {
  /** Knockback number the client echoes in `move.k` once applied; 0 = nothing to acknowledge. */
  seq: number;
  at: number;
  /** Upward launch speed (0 for buff tails). */
  ky: number;
  /** Extra horizontal speed, and the extra distance it can still explain. */
  speed: number;
  pool: number;
  /** Client clock of the move that first included it; null until acknowledged. */
  ackTs: number | null;
  /** The push of a sprint-jump. */
  jump?: boolean;
}

export function knockbackCredit(now: number, seq: number, kx: number, ky: number, kz: number): KbCredit {
  const speed = Math.hypot(kx, kz);
  // In the air the extra velocity decays at AIR_ACCEL per second, so it adds at most speed/AIR_ACCEL blocks.
  return { seq, at: now, ky, speed, pool: (speed / AIR_ACCEL) * 1.25, ackTs: null };
}

/** Velocity from a speed buff that just ended decays gradually on the client. */
export function speedCredit(now: number, clientTs: number, extraSpeed: number): KbCredit {
  return { seq: 0, at: now, ky: 0, speed: extraSpeed, pool: (extraSpeed / AIR_ACCEL) * 1.25, ackTs: clientTs };
}

export interface Motion {
  /** False right after a teleport: the next move re-anchors the client clock. */
  synced: boolean;
  /** Client physics clock and server clock at the last accepted move. */
  ts: number;
  srvAt: number;
  /** How far (ms) the client clock has run ahead of the server's. */
  drift: number;
  /** When the last move arrived, and when the last burst after a silence began. */
  recvAt: number;
  burstAt: number;
  vy: number;
  /** Resting on a surface at the last move: the client may still jump from there next frame,
   *  even if it has just walked off the edge. */
  grounded: boolean;
  airJumpUsed: boolean;
  credits: KbCredit[];
  /** Sprinting at the last move (the client's word; it only buys sprint speed), when the last
   *  sprint ended (client clock), and when the last sprint-jump push was credited. */
  sprint: boolean;
  sprintEnd: number;
  sprintJumpTs: number;
}

export function newMotion(): Motion {
  return {
    synced: false,
    ts: 0,
    srvAt: 0,
    drift: 0,
    recvAt: 0,
    burstAt: -Infinity,
    vy: 0,
    grounded: false,
    airJumpUsed: false,
    credits: [],
    sprint: false,
    sprintEnd: -Infinity,
    sprintJumpTs: -Infinity,
  };
}

/** The server ended the sprint (a sprint hit); its speed fades out like when the client stops. */
export function endSprint(mo: Motion): void {
  if (!mo.sprint) return;
  mo.sprint = false;
  mo.sprintEnd = mo.ts;
}

export interface MoveSample {
  x: number;
  y: number;
  z: number;
  vy: number;
  ts: number;
  k: number;
  sp?: boolean;
}

export interface MoveCtx {
  world: Voxels;
  /** What the player may stand on: `world`, or the same blocks over the floor the client may still
   *  have known (the arena's island may have just crumbled under it). Collisions use `world`. */
  ground?: Voxels;
  now: number;
  /** Gravity range in effect (two values right after a gravity buff starts or ends). */
  gLo: number;
  gHi: number;
  maxSpeed: number;
  airJump: boolean;
  /** The hub's wall; Infinity in the arena, whose edge is a drop (the world's floorRadius). */
  ringRadius: number;
  /** Largest ring the client may still have been using: its view lags behind the server's. */
  ringLimit: number;
  /** How fast the shrinking ring can push a player inwards. */
  ringSpeed: number;
  /** A block near the path changed so recently that the client may not know about it yet. */
  freshBlocks: (a: Vec3, b: Vec3) => boolean;
}

export interface Flag {
  check: string;
  points: number;
  detail: string;
}

/** `drop`: the player was flying, so the setback puts them on the ground. `flag`: a violation that
 *  doesn't invalidate the move itself. */
export type Verdict = { ok: true; idle?: boolean; flag?: Flag } | ({ ok: false; drop?: boolean } & Flag);

const fail = (check: string, points: number, detail: string, drop = false): Verdict => ({ ok: false, check, points, detail, drop });
const f2 = (n: number) => n.toFixed(2);

/** Validates one reported position against the last accepted one and, on success, commits the
 *  motion state. The caller applies the position, or sets the player back on failure. */
export function checkMove(pos: Vec3, mo: Motion, m: MoveSample, ctx: MoveCtx): Verdict {
  if (mo.recvAt && ctx.now - mo.recvAt > STALL_GAP_MS) mo.burstAt = ctx.now;
  mo.recvAt = ctx.now;
  // Sprinting at any point since the last move, or still slowing down from it.
  const sp = m.sp === true;
  if (mo.sprint && !sp) mo.sprintEnd = mo.ts;
  mo.sprint = sp;
  const sprinting = sp || m.ts - mo.sprintEnd <= SPRINT_TAIL_MS;
  if (sprinting) ctx = { ...ctx, maxSpeed: ctx.maxSpeed * SPRINT_SPEED };
  if (!mo.synced) return firstMove(pos, mo, m, ctx);
  const gap = m.ts - mo.ts;
  if (gap === 0) {
    // A view-only update (sent right before an action): nothing may have moved.
    return m.x === pos.x && m.y === pos.y && m.z === pos.z ? { ok: true, idle: true } : fail("timer", 2, "moved while the clock stood still");
  }
  if (!(gap > 0) || gap > MAX_GAP_MS) return fail("timer", 1, `clock step ${gap.toFixed(0)}ms`);
  const drift = Math.max(DRIFT_FLOOR_MS, mo.drift + gap - (ctx.now - mo.srvAt));
  if (drift > DRIFT_MAX_MS) {
    const stalled = ctx.now - mo.burstAt < STALL_GRACE_MS;
    return fail("timer", stalled ? 0 : 2, `clock ${drift.toFixed(0)}ms ahead of the server${stalled ? " (after a network stall)" : ""}`);
  }
  const D = gap / 1000;

  // Knockback the client reports to have applied since its previous move.
  const applied = mo.credits.filter((c) => c.ackTs === null && c.seq <= m.k);

  const dh = Math.hypot(m.x - pos.x, m.z - pos.z);
  const passed = Math.max(0, Math.hypot(pos.x, pos.z) - (ctx.ringRadius - PLAYER_HALF_WIDTH));
  const ringPush = ctx.ringSpeed * D + Math.min(passed + 0.3, ctx.ringSpeed * Math.max(D, (ctx.now - mo.srvAt) / 1000));

  // Vertical: gravity, except for jumps, knockback launches, landings and head bumps. Worked out
  // first because a sprint-jump also pushes the player forward; failures are reported below.
  const launch = applied.reduce((v, c) => Math.max(v, c.ky), 0);
  const extraSpeed = mo.credits.reduce((v, c) => (c.ackTs !== null || applied.includes(c) ? v + c.speed : v), 0) + (sprinting ? SPRINT_JUMP_BOOST : 0);
  const wander = wanderOf((ctx.maxSpeed * SPEED_SLACK + extraSpeed) * D + ringPush, dh);
  const v = checkVertical(pos, mo, m, D, ctx, launch, wander);
  let credits = mo.credits;
  const pushes = credits.filter((c) => c.jump && c.pool > EY).length;
  if (v?.jump && sprinting && m.ts - mo.sprintJumpTs >= SPRINT_JUMP_GAP_MS && pushes < SPRINT_JUMP_CREDITS) {
    credits = [...credits, { ...speedCredit(ctx.now, mo.ts, SPRINT_JUMP_BOOST), jump: true }];
  }

  // Horizontal: walking speed (buffs and sprint included) plus whatever extra velocity is still in
  // flight. The client's ring follows the wall clock: after a hitch or a hidden tab the shrinking
  // ring may already have passed the player, and drags them back inside in one step.
  let excess = dh - (ctx.maxSpeed * D * SPEED_SLACK + ringPush + EY);
  const spent: [KbCredit, number][] = [];
  for (const c of credits) {
    if (excess <= 0) break;
    if (c.ackTs === null && !applied.includes(c)) continue;
    const take = Math.min(c.pool, c.speed * D + EY, excess);
    if (take <= 0) continue;
    spent.push([c, take]);
    excess -= take;
  }
  if (excess > 0) {
    const kb = credits.map((c) => `${f2(c.speed)}/${f2(c.pool)}${c.ackTs === null ? "?" : ""}`).join(",");
    return fail("speed", Math.min(5, 1 + excess * 4), `${f2(dh / D)} b/s, limit ${f2(ctx.maxSpeed)} (${f2(dh)} in ${gap.toFixed(1)}ms; kb ${kb || "-"})`);
  }
  if (!v) {
    const fresh = ctx.freshBlocks(pos, m);
    return fail("fly", fresh ? 0 : 3, `y ${f2(pos.y)}→${f2(m.y)}, vy ${f2(mo.vy)}→${f2(m.vy)} in ${gap.toFixed(0)}ms${fresh ? " (blocks just changed)" : ""}`, true);
  }

  if (!pathClear(ctx.world, pos, m) && !atRingEdge(m, ctx)) return fail("noclip", ctx.freshBlocks(pos, m) ? 0 : 2, "moved through a block");
  if (Math.hypot(m.x, m.z) > ctx.ringLimit - PLAYER_HALF_WIDTH + 0.3) return fail("ring", 1, `r ${f2(Math.hypot(m.x, m.z))}, ring ${f2(ctx.ringLimit)}`);

  // A knockback launch must show up in the move that acknowledges it, unless it couldn't:
  // already rising faster, a jump replaced it, or a ceiling stopped it.
  let flag: Flag | undefined;
  if (launch > 0 && !v.kb) {
    const reach = (launch * launch) / (2 * ctx.gLo) + 0.1;
    const head = Math.min(pos.y, m.y) + PLAYER_HEIGHT;
    const capped = ceilingLevels(ctx.world, footprint(pos, m, wander), head - EY, Math.max(pos.y, m.y) + PLAYER_HEIGHT + reach).length > 0;
    if (mo.vy < launch - EV && m.vy < launch - ctx.gHi * D - EV && !capped) {
      flag = { check: "velocity", points: 3, detail: `knockback launch ${launch} missing (vy ${f2(mo.vy)}→${f2(m.vy)})` };
    }
  }

  for (const [c, take] of spent) c.pool -= take;
  for (const c of applied) c.ackTs = m.ts;
  if (credits !== mo.credits) mo.sprintJumpTs = m.ts;
  mo.credits = credits.filter((c) => c.ackTs === null || m.ts <= c.ackTs + KB_SIM_MS);
  if (v.airJump) mo.airJumpUsed = true;
  if (v.contact) mo.airJumpUsed = false;
  mo.grounded = !!v.rest;
  mo.ts = m.ts;
  mo.srvAt = ctx.now;
  mo.drift = drift;
  mo.vy = m.vy;
  return { ok: true, flag };
}

/** The ring pushes players inwards straight through blocks (it must win over walls, or players
 *  could shelter outside it), so blocks entered on the ring's edge don't count. */
function atRingEdge(p: Vec3, ctx: MoveCtx): boolean {
  return Math.hypot(p.x, p.z) >= ctx.ringRadius - PLAYER_HALF_WIDTH - 0.05;
}

/** True when `m` is the client reporting the teleport spot it was just sent to. */
export function isTeleportAck(pos: Vec3, m: MoveSample): boolean {
  return m.x === pos.x && m.y === pos.y && m.z === pos.z && Math.abs(m.vy) <= EV;
}

function firstMove(pos: Vec3, mo: Motion, m: MoveSample, ctx: MoveCtx): Verdict {
  const anchor = (): Verdict => {
    // The client clock runs on through a teleport, so its balance carries over (an acknowledgement
    // delayed by a stall must not leave the moves queued behind it looking early). It never resumes
    // ahead of the server: after a timer correction this re-syncs the clocks instead of leaving the
    // balance on the threshold, where ordinary jitter would trip it again and again.
    const drift = mo.srvAt ? mo.drift + (m.ts - mo.ts) - (ctx.now - mo.srvAt) : 0;
    mo.synced = true;
    mo.ts = m.ts;
    mo.srvAt = ctx.now;
    mo.drift = Math.min(0, Math.max(DRIFT_FLOOR_MS, drift));
    mo.vy = m.vy;
    mo.grounded = false;
    mo.airJumpUsed = false;
    return { ok: true };
  };
  if (isTeleportAck(pos, m)) return anchor();
  // A client that didn't acknowledge right away restarted from rest at the spot some time ago:
  // it may have fallen, landed, jumped or been launched since.
  const T = FIRST_MOVE_S;
  const { gHi } = ctx;
  const dh = Math.hypot(m.x - pos.x, m.z - pos.z);
  if (dh > ctx.maxSpeed * T + 0.1) return fail("speed", 1, `${f2(dh)} blocks right after a teleport`);
  const rise = m.y - pos.y;
  const resting = m.vy <= EV && m.vy >= -gHi * T - EV;
  const levels = supportLevels(ctx.ground ?? ctx.world, footprint(pos, m, wanderOf(ctx.maxSpeed * T, dh)), pos.y - gHi * T * T - EY, pos.y + EY);
  const launched = (v0: number, from: number) => m.vy <= v0 + EV && m.vy >= v0 - gHi * T - EV && m.y - from >= -EY && m.y - from <= v0 * T + EY;
  const ok =
    (resting && fallFits(-rise, m.vy, ctx)) ||
    (resting && levels.some((L) => fallFits(L - m.y, m.vy, ctx))) ||
    levels.some((L) => launched(JUMP_SPEED, L)) ||
    (ctx.airJump && launched(JUMP_SPEED, pos.y + Math.min(0, rise))) ||
    mo.credits.some((c) => c.seq <= m.k && c.ky > 0 && launched(c.ky, pos.y + Math.min(0, rise)));
  if (!ok) return fail("fly", ctx.freshBlocks(pos, m) ? 0 : 2, `y ${f2(pos.y)}→${f2(m.y)}, vy ${f2(m.vy)} right after a teleport`, true);
  if (!pathClear(ctx.world, pos, m) && !atRingEdge(m, ctx)) return fail("noclip", ctx.freshBlocks(pos, m) ? 0 : 2, "moved through a block");
  return anchor();
}

/** Drop of a body that started from rest `drop` blocks higher and now moves at `vy` (≤ 0).
 *  Free fall gives vy = -g·t and drop = g(t² + Σdt²)/2, where every step dt ≤ MAX_STEP_DT. */
function fallFits(drop: number, vy: number, ctx: MoveCtx): boolean {
  const v2 = vy * vy;
  return drop >= v2 / (2 * ctx.gHi) - EY && drop <= v2 / (2 * ctx.gLo) + (MAX_STEP_DT * Math.abs(vy)) / 2 + EY;
}

interface Vertical {
  /** Touched the ground during the interval (refills the air jump). */
  contact: boolean;
  /** Resting on a surface at the end of it (may still jump from there next frame). */
  rest?: boolean;
  airJump?: boolean;
  kb?: boolean;
  /** Jumped off the ground during the interval. */
  jump?: boolean;
}

/** `launch`: upward speed of knockback applied during this interval (0 if none). */
function checkVertical(p: Vec3, mo: Motion, n: MoveSample, D: number, ctx: MoveCtx, launch: number, wander: number): Vertical | null {
  const { world, gLo, gHi } = ctx;
  const pvy = mo.vy;
  const dy = n.y - p.y;
  // Free flight: vy falls by g·D exactly; y lies between the two extreme ways to split D into steps.
  const vLo = Math.max(-MAX_FALL_SPEED, pvy - gHi * D);
  const vHi = Math.max(-MAX_FALL_SPEED, pvy - gLo * D);
  if (n.vy >= vLo - EV && n.vy <= vHi + EV) {
    const capped = pvy - gHi * D < -MAX_FALL_SPEED;
    const yLo = capped ? -MAX_FALL_SPEED * D : pvy * D - (gHi * (D * D + MAX_STEP_DT * D)) / 2;
    const yHi = pvy * D - (gLo * D * D) / 2;
    if (dy >= yLo - EY && dy <= yHi + EY) return { contact: false };
  }
  const cols = footprint(p, n, wander);
  const top = p.y + Math.max(pvy, 0) * D;
  // Lowest point reachable: a head bump can stop a rise at any moment, then gravity takes over.
  const bottom = p.y + Math.min(0, pvy) * D - (gHi * (D * D + MAX_STEP_DT * D)) / 2;
  const supports = supportLevels(ctx.ground ?? world, cols, bottom - EY, top + EY);
  if (mo.grounded) supports.push(p.y);
  if (n.vy <= EV && n.vy >= -gHi * D - EV) {
    // Touched a surface (landed, stood, or walked off an edge), then fell from rest.
    for (const L of supports) if (fallFits(L - n.y, n.vy, ctx)) return { contact: true, rest: Math.abs(n.vy) <= EV && Math.abs(L - n.y) <= EY };
    // Bumped the head, then fell from rest. Only something moving up reaches a ceiling: a rise
    // already under way, or a jump or launch during the interval.
    const canRise = pvy > EV || launch > 0 || (ctx.airJump && !mo.airJumpUsed) || supports.length > 0;
    const headTop = p.y + Math.max(pvy, JUMP_SPEED, launch) * D + PLAYER_HEIGHT + EY;
    if (canRise) {
      for (const C of ceilingLevels(world, cols, bottom + PLAYER_HEIGHT - EY, headTop)) {
        if (fallFits(C - PLAYER_HEIGHT - 1e-4 - n.y, n.vy, ctx)) {
          // Nothing else was moving up: the rise came from a jump off the ground.
          return { contact: supports.length > 0, kb: launch > 0, jump: supports.length > 0 && pvy <= EV && launch <= 0 };
        }
      }
    }
  }
  if (n.vy <= JUMP_SPEED + EV && n.vy >= JUMP_SPEED - gHi * D - EV) {
    // Touched the ground and jumped.
    for (const L of supports) if (n.y - L >= -EY && n.y - L <= JUMP_SPEED * D + EY) return { contact: true, jump: true };
  }
  // Air jump (double-jump buff) or a knockback launch, possibly right after touching the ground
  // (which refills the air jump).
  const touched = supports.length > 0;
  // Several impulses can share an interval (jump, head bump, then a launch): rise at most this fast.
  const vUp = Math.max(pvy, launch, touched || (ctx.airJump && !mo.airJumpUsed) ? JUMP_SPEED : 0);
  const launched = (v0: number) => n.vy <= v0 + EV && n.vy >= v0 - gHi * D - EV && dy <= Math.max(v0, vUp) * D + EY && n.y >= bottom - EY;
  if (launch > 0 && launched(launch)) return { contact: touched, kb: true };
  if (ctx.airJump && (!mo.airJumpUsed || touched) && launched(JUMP_SPEED)) return { contact: false, airJump: true };
  return null;
}

type Col = [number, number];

/** Block columns under a player's footprint, or under everything it may have swept on the way
 *  from a to b (a landing or head bump can happen anywhere along the way). The path between two
 *  reports needn't be straight: `wander` is how far it can stray from the straight line. */
function footprint(a: Vec3, b: Vec3 = a, wander = 0): Col[] {
  const out: Col[] = [];
  const r = PLAYER_HALF_WIDTH + wander;
  const x1 = Math.floor(Math.max(a.x, b.x) + r - 1e-6);
  const z1 = Math.floor(Math.max(a.z, b.z) + r - 1e-6);
  for (let x = Math.floor(Math.min(a.x, b.x) - r); x <= x1; x++)
    for (let z = Math.floor(Math.min(a.z, b.z) - r); z <= z1; z++) out.push([x, z]);
  return out;
}

/** A path of length ≤ maxLen between points `chord` apart strays at most this far from the line. */
const wanderOf = (maxLen: number, chord: number) => Math.max(0, (maxLen - chord) / 2) + 1e-3;

/** Heights in [lo, hi] a player could stand at over these columns: the floor (where the island
 *  still is) or a block top. */
function supportLevels(world: Voxels, cols: Col[], lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let L = Math.max(0, Math.ceil(lo)); L <= Math.min(MAX_HEIGHT, Math.floor(hi)); L++) {
    if (cols.some(([x, z]) => world.solid(x, L - 1, z))) out.push(L);
  }
  return out;
}

/** Heights in [lo, hi] of a ceiling over these columns: a block's bottom face or the arena ceiling. */
function ceilingLevels(world: Voxels, cols: Col[], lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let C = Math.max(1, Math.ceil(lo)); C <= Math.min(MAX_HEIGHT, Math.floor(hi)); C++) {
    if (C === MAX_HEIGHT || cols.some(([x, z]) => world.solid(x, C, z))) out.push(C);
  }
  return out;
}

/** Highest spot below `p` a player would fall onto. */
export function dropToGround(world: Voxels, p: Vec3): number {
  const cols = footprint(p);
  for (let L = Math.floor(p.y + EY); L > 0; L--) if (cols.some(([x, z]) => world.solid(x, L - 1, z))) return L;
  // Past the island's edge there is nothing to land on: the fall goes on from here.
  return p.y >= 0 && cols.some(([x, z]) => world.solid(x, -1, z)) ? 0 : Math.min(p.y, 0);
}

const cellKey = (x: number, y: number, z: number) => ((y + 2) * 128 + (z + 64)) * 128 + (x + 64);

/** Solid cells inside the player's box at `p`, shrunk by the given margins: collected into `into`,
 *  or reports whether there is one outside `skip`. */
function solidCells(world: Voxels, p: Vec3, sxz: number, sy: number, into?: Set<number>, skip?: Set<number>): boolean {
  const x0 = Math.floor(p.x - PLAYER_HALF_WIDTH + sxz);
  const x1 = Math.floor(p.x + PLAYER_HALF_WIDTH - sxz - 1e-9);
  const y0 = Math.floor(p.y + sy);
  const y1 = Math.floor(p.y + PLAYER_HEIGHT - sy - 1e-9);
  const z0 = Math.floor(p.z - PLAYER_HALF_WIDTH + sxz);
  const z1 = Math.floor(p.z + PLAYER_HALF_WIDTH - sxz - 1e-9);
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++) {
        if (!world.solid(x, y, z)) continue;
        const k = cellKey(x, y, z);
        if (into) into.add(k);
        else if (!skip?.has(k)) return true;
      }
  return false;
}

const AXIS_ORDERS = [
  ["y", "x", "z"],
  ["y", "z", "x"],
  ["x", "z", "y"],
  ["z", "x", "y"],
  ["x", "y", "z"],
  ["z", "y", "x"],
] as const;

/** No solid cell outside `start` along a→b (sampled every PATH_STEP, end point included). */
function segmentFree(world: Voxels, a: Vec3, b: Vec3, sxz: number, sy: number, start: Set<number>): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / PATH_STEP));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
    if (solidCells(world, q, sxz, sy, undefined, start)) return false;
  }
  return true;
}

/** The player's box could get from a to b without entering a solid cell: along the straight line,
 *  or one axis at a time in some order (client physics moves axis by axis, so real paths bend around
 *  corners). Cells the box already overlapped at `a` are ignored: a block may be placed onto a player. */
function pathClear(world: Voxels, a: Vec3, b: Vec3): boolean {
  const start = new Set<number>();
  solidCells(world, a, 0, 0, start);
  if (solidCells(world, b, 0.005, 0.005, undefined, start)) return false;
  if (segmentFree(world, a, b, PATH_SHRINK_XZ, PATH_SHRINK_Y, start)) return true;
  return AXIS_ORDERS.some((order) => {
    let cur = { ...a };
    for (const k of order) {
      const next = { ...cur, [k]: b[k] };
      if (!segmentFree(world, cur, next, 0.02, 0.02, start)) return false;
      cur = next;
    }
    return true;
  });
}
