// Shared harness for the server tests: a real PvpServer on a random port, and scripted clients
// ("bots") that run the browser's physics and protocol.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after } from "node:test";
import { WebSocket } from "ws";
import {
  ARENA_RADIUS,
  BUILD_REACH,
  EYE_HEIGHT,
  HIT_COOLDOWN_MS,
  HIT_REACH,
  MAX_STEP_DT,
  MOB_KINDS,
  PLAYER_HALF_WIDTH as HW,
  PLAYER_HEIGHT as PH,
  PROTOCOL_VERSION,
  Voxels,
  buffModifiers,
  cellInRing,
  lookDir,
  makeTimings,
  rayBox,
  raycastVoxels,
  stepBody,
  yawTowards,
} from "../src/game/shared.ts";
import type {
  Body,
  BuffId,
  ClientMsg,
  DailyRecords,
  GameMode,
  MobKind,
  MoveInput,
  Phase,
  PlayerInfo,
  RoundResult,
  ServerMsg,
  Timings,
  TrainStats,
  Vec3,
  View,
} from "../src/game/shared.ts";
import { PvpServer } from "./game.ts";
import type { ServerOptions, Violation } from "./game.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

export function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TestServer {
  url: string;
  violations: Violation[];
  close(): void;
}

const servers: TestServer[] = [];
after(() => servers.forEach((s) => s.close()));

export async function startServer(opts: ServerOptions = {}): Promise<TestServer> {
  const violations: Violation[] = [];
  const game = new PvpServer({ timeScale: 0.05, recordsFile: null, buffPlan: [], ...opts, anticheat: { maxConnPerIp: 0, ...opts.anticheat }, onViolation: (v) => violations.push(v) });
  const http = createServer();
  http.on("upgrade", (req, socket, head) => {
    if (!game.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  let open = true;
  const srv = {
    url: `ws://127.0.0.1:${port}/game-ws`,
    violations,
    close: () => {
      if (!open) return;
      open = false;
      game.close();
      http.close();
    },
  };
  servers.push(srv);
  return srv;
}

/** Extra one-way delay per message; order is always kept, like TCP. */
export type Net = () => number;
export const LAN: Net = () => 0;
/** Steady latency; `ctl.until` freezes delivery both ways until then (a TCP stall), then everything
 *  held back arrives at once. */
export function stallableNet(oneWayMs: number) {
  const ctl = { until: 0 };
  const net: Net = () => Math.max(0, ctl.until - Date.now()) + oneWayMs;
  return { ctl, net };
}
/** A poor mobile link: 60–140 ms one way with jitter, and now and then a 1.2–3 s stall. */
export function mobileNet(rnd: () => number): Net {
  let stallUntil = 0;
  return () => {
    const now = Date.now();
    if (now > stallUntil && rnd() < 0.002) stallUntil = now + 1200 + rnd() * 1800;
    return Math.max(0, stallUntil - now) + 60 + rnd() * 80;
  };
}
export function jitteryNet(rnd: () => number): Net {
  let stallUntil = 0;
  return () => {
    const now = Date.now();
    if (now > stallUntil && rnd() < 0.003) stallUntil = now + 150 + rnd() * 600;
    return Math.max(0, stallUntil - now) + 10 + rnd() * 50;
  };
}

export const aimAt = (from: Vec3, to: Vec3) => {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(to.y - from.y, Math.hypot(dx, dz)) };
};

/** A client doing what src/game/client/engine.ts does, minus rendering. */
export class Bot {
  readonly ws: WebSocket;
  id = 0;
  world = new Voxels();
  /** Which world the server put us in. */
  worldView: View = "hub";
  watching = false;
  mode: GameMode = "classic";
  /** Mobs as drawn (hub only): interpolated like players. */
  mobs = new Map<number, { kind: MobKind; pos: Vec3; target: Vec3; hp: number; maxHp: number }>();
  arrows = 0;
  hub: Extract<ServerMsg, { t: "hub" }> | null = null;
  train: TrainStats | null = null;
  hints: string[] = [];
  notices: string[] = [];
  rangeMsgs: Extract<ServerMsg, { t: "range" }>[] = [];
  parkourMsgs: Extract<ServerMsg, { t: "parkour" }>[] = [];
  duelMsgs: Extract<ServerMsg, { t: "duel" }>[] = [];
  invites: number[] = [];
  records: DailyRecords | null = null;
  results: RoundResult | null = null;
  roster: PlayerInfo[] = [];
  arrowHits = 0;
  blocks: Extract<ServerMsg, { t: "block" }>[] = [];
  kills: Extract<ServerMsg, { t: "kill" }>[] = [];
  callouts: string[] = [];
  /** The arena island's radius, as the server last said. */
  floor = ARENA_RADIUS;
  body: Body = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, onGround: false, jumpsLeft: 0, jumpHeld: false };
  yaw = 0;
  pitch = 0;
  simTime = 0;
  tpSeq = 0;
  kbSeq = 0;
  lastTick = 0;
  teleports = 0;
  phase: Phase = "lobby";
  phaseAt = 0;
  timings: Timings = makeTimings();
  buffs: BuffId[] = [];
  maxHp = 20;
  /** Bow arrows left (bows buff). */
  ammo = 0;
  respawnIn = 0;
  bombHolder: number | null = null;
  bounty: number | null = null;
  lava = -1;
  booms = 0;
  score: Extract<ServerMsg, { t: "score" }> | null = null;
  vote: Extract<ServerMsg, { t: "buffVote" }> | null = null;
  alive = false;
  hp = 20;
  dirt = 0;
  /** Other players as the browser draws them: interpolated tick positions. */
  view = new Map<number, { pos: Vec3; target: Vec3; hp: number }>();
  ticks: number[][] = [];
  hurts: Extract<ServerMsg, { t: "hurt" }>[] = [];
  blocksPlaced = 0;
  /** Timestamped teleports and knockback received, to explain a failure. */
  log: string[] = [];
  closed: { code: number; reason: string } | null = null;
  /** Anti-knockback cheats: drop the velocity but still acknowledge it, or don't even acknowledge. */
  ignoreKnockback: false | "ack" | "silent" = false;
  /** Reported with every move (the browser's sprint state): sprinting now or since the last move. */
  sprint = false;
  /** Cheat: sprints but never says so. */
  hideSprint = false;
  private sprintedSince = false;
  private sent = { ts: -1, yaw: 0, pitch: 0, sp: false };
  private lastSend = 0;
  private queues = { in: [] as { at: number; fn: () => void }[], out: [] as { at: number; fn: () => void }[] };
  private net: Net;

  constructor(url: string, net: Net, ip?: string) {
    this.net = net;
    this.ws = new WebSocket(url, { autoPong: false, ...(ip ? { headers: { "x-test-ip": ip } } : {}) });
    this.ws.on("message", (data) => this.later("in", () => this.onMessage(JSON.parse(String(data)))));
    // Pongs travel the same delayed path, so the server's RTT estimate is realistic.
    this.ws.on("ping", (data) => this.later("in", () => this.later("out", () => this.ws.readyState === WebSocket.OPEN && this.ws.pong(data))));
    this.ws.on("close", (code, reason) => (this.closed = { code, reason: String(reason) }));
    this.ws.on("error", () => {});
  }

  static async join(url: string, name: string, net: Net = LAN, ip?: string, version = PROTOCOL_VERSION): Promise<Bot> {
    const bot = new Bot(url, net, ip);
    await new Promise<void>((resolve, reject) => {
      bot.ws.once("open", () => resolve());
      bot.ws.once("unexpected-response", () => reject(new Error("upgrade refused")));
    });
    bot.ws.send(JSON.stringify({ t: "hello", name, v: version }));
    return bot;
  }

  get playing() {
    return this.phase === "playing" && this.alive && this.worldView === "arena" && !this.closed;
  }

  /** Walking around the hub (after the server placed us there). */
  get inHub() {
    return this.worldView === "hub" && !this.watching && this.tpSeq > 0 && !this.closed;
  }

  /** Delivers in order after the simulated delay (separate timers could fire out of order). */
  private later(dir: "in" | "out", fn: () => void) {
    const q = this.queues[dir];
    const at = Math.max(Date.now() + this.net(), q.at(-1)?.at ?? 0);
    q.push({ at, fn });
    if (q.length === 1) this.pump(dir);
  }

  private pump(dir: "in" | "out") {
    const q = this.queues[dir];
    while (q.length && q[0].at <= Date.now()) q.shift()?.fn();
    if (q.length) setTimeout(() => this.pump(dir), q[0].at - Date.now());
  }

  send(msg: ClientMsg) {
    this.later("out", () => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    });
  }

  private onMessage(m: ServerMsg) {
    switch (m.t) {
      case "welcome":
        this.id = m.id;
        break;
      case "phase":
        this.phase = m.phase;
        this.mode = m.mode;
        this.phaseAt = Date.now() - m.elapsed;
        this.timings = m.timings;
        this.buffs = m.buffs;
        this.setFloor(m.floor);
        break;
      case "floor":
        if (m.next === null) this.setFloor(m.r);
        break;
      case "kill":
        this.kills.push(m);
        break;
      case "callout":
        this.callouts.push(m.text);
        break;
      case "buff":
        this.buffs = m.buffs;
        break;
      case "bomb":
        this.bombHolder = m.holder;
        break;
      case "bounty":
        this.bounty = m.id;
        break;
      case "lava":
        this.lava = m.y;
        break;
      case "boom":
        this.booms++;
        break;
      case "score":
        this.score = m;
        break;
      case "buffVote":
        this.vote = m;
        break;
      case "world":
        this.world.clear();
        for (let i = 0; i < m.blocks.length; i += 4) this.world.set(m.blocks[i], m.blocks[i + 1], m.blocks[i + 2], m.blocks[i + 3]);
        this.worldView = m.w;
        this.setFloor(this.floor);
        this.view.clear();
        this.mobs.clear();
        break;
      case "block":
        this.blocks.push(m);
        if (m.w === this.worldView) this.world.set(m.x, m.y, m.z, m.v);
        break;
      case "roster":
        this.roster = m.players;
        break;
      case "hub":
        this.hub = m;
        break;
      case "train":
        this.train = m.s;
        break;
      case "hint":
        this.hints.push(m.text);
        break;
      case "notice":
        this.notices.push(m.text);
        break;
      case "range":
        this.rangeMsgs.push(m);
        break;
      case "parkour":
        this.parkourMsgs.push(m);
        break;
      case "duel":
        this.duelMsgs.push(m);
        break;
      case "duelInvite":
        this.invites.push(m.from);
        break;
      case "records":
        this.records = m.r;
        break;
      case "results":
        this.results = m.r;
        break;
      case "arrowHit":
        this.arrowHits++;
        break;
      case "tick": {
        this.lastTick = m.s;
        this.ticks.push(m.p);
        const seen = new Set<number>();
        for (let i = 0; i < m.p.length; i += 7) {
          const id = m.p[i];
          if (id === this.id) continue;
          seen.add(id);
          const target = { x: m.p[i + 1], y: m.p[i + 2], z: m.p[i + 3] };
          const v = this.view.get(id);
          if (v) Object.assign(v, { target, hp: m.p[i + 6] });
          else this.view.set(id, { pos: { ...target }, target, hp: m.p[i + 6] });
        }
        for (const id of this.view.keys()) if (!seen.has(id)) this.view.delete(id);
        const mseen = new Set<number>();
        const mm = m.m ?? [];
        for (let i = 0; i < mm.length; i += 8) {
          const id = mm[i];
          mseen.add(id);
          const target = { x: mm[i + 2], y: mm[i + 3], z: mm[i + 4] };
          const v = this.mobs.get(id);
          if (v) Object.assign(v, { target, hp: mm[i + 6], maxHp: mm[i + 7] });
          else this.mobs.set(id, { kind: MOB_KINDS[mm[i + 1]], pos: { ...target }, target, hp: mm[i + 6], maxHp: mm[i + 7] });
        }
        for (const id of this.mobs.keys()) if (!mseen.has(id)) this.mobs.delete(id);
        this.arrows = (m.a ?? []).length / 7;
        break;
      }
      case "you":
        this.hp = m.hp;
        this.maxHp = m.maxHp;
        this.dirt = m.dirt;
        this.ammo = m.arrows;
        this.alive = m.alive;
        this.watching = m.watching;
        this.respawnIn = m.respawnIn;
        break;
      case "tp":
        this.log.push(`${Date.now()} tp n=${m.n} ${m.x.toFixed(2)},${m.y.toFixed(2)},${m.z.toFixed(2)}`);
        this.tpSeq = m.n;
        this.teleports++;
        Object.assign(this.body.pos, { x: m.x, y: m.y, z: m.z });
        Object.assign(this.body.vel, { x: 0, y: 0, z: 0 });
        this.body.onGround = false;
        if (m.yaw !== undefined) {
          this.yaw = m.yaw;
          this.pitch = 0;
        }
        this.sendMove(Date.now());
        break;
      case "hurt":
        this.hurts.push(m);
        if (m.id === this.id) this.log.push(`${Date.now()} hurt kn=${m.kn} k=${m.kx},${m.ky},${m.kz}`);
        if (m.id === this.id && m.kn && this.ignoreKnockback !== "silent") this.kbSeq = m.kn;
        if (m.id === this.id && !this.ignoreKnockback) {
          this.body.vel.x += m.kx;
          this.body.vel.z += m.kz;
          if (m.ky) this.body.vel.y = Math.max(this.body.vel.y, m.ky);
        }
        break;
    }
  }

  /** The browser's onFloor: blocks past the island's edge fall with it. */
  private setFloor(r: number) {
    this.floor = r;
    this.world.floorRadius = this.worldView !== "arena" ? Infinity : this.mode === "spleef" ? 0 : r;
    if (this.worldView !== "arena") return;
    for (const i of [...this.world.filled]) {
      const [x, y, z] = Voxels.decode(i);
      if (!cellInRing(x, z, r)) this.world.set(x, y, z, 0);
    }
  }

  /** The hub's wall; the arena has none, its edge is a drop. */
  ringRadius() {
    return this.worldView === "arena" ? Infinity : ARENA_RADIUS;
  }

  /** Where the ground ends. */
  edge() {
    return this.worldView === "arena" ? this.floor : ARENA_RADIUS;
  }

  mods() {
    return this.worldView === "arena" ? buffModifiers(this.buffs, this.mode, this.sizeOf()) : buffModifiers(null);
  }

  step(dt: number, input: MoveInput, clockScale = 1) {
    if (input.sprint) this.sprintedSince = true;
    stepBody(this.world, this.body, input, dt, this.mods(), this.ringRadius());
    this.simTime += dt * 1000 * clockScale;
  }

  interp(dt: number) {
    const k = 1 - Math.exp(-dt * 14);
    for (const v of [...this.view.values(), ...this.mobs.values()]) {
      v.pos.x += (v.target.x - v.pos.x) * k;
      v.pos.y += (v.target.y - v.pos.y) * k;
      v.pos.z += (v.target.z - v.pos.z) * k;
    }
  }

  sendMove(now: number) {
    this.lastSend = now;
    const sp = !this.hideSprint && (this.sprint || this.sprintedSince);
    this.sprintedSince = false;
    this.sent = { ts: this.simTime, yaw: this.yaw, pitch: this.pitch, sp };
    const p = this.body.pos;
    this.send({ t: "move", x: p.x, y: p.y, z: p.z, yaw: this.yaw, pitch: this.pitch, vy: this.body.vel.y, ts: this.simTime, n: this.tpSeq, k: this.kbSeq, tk: this.lastTick, sp });
  }

  maybeSendMove(now: number) {
    if (now - this.lastSend >= 50) this.sendMove(now);
  }

  flushMove() {
    const sp = !this.hideSprint && (this.sprint || this.sprintedSince);
    if (this.sent.ts !== this.simTime || this.sent.yaw !== this.yaw || this.sent.pitch !== this.pitch || this.sent.sp !== sp) this.sendMove(Date.now());
  }

  /** Body size (giants buff), as the roster says. */
  sizeOf(id = this.id): number {
    return this.worldView === "arena" ? (this.roster.find((p) => p.id === id)?.size ?? 1) : 1;
  }

  eye(): Vec3 {
    const p = this.body.pos;
    return { x: p.x, y: p.y + EYE_HEIGHT * this.sizeOf(), z: p.z };
  }

  private lastHitSim = -Infinity;
  private lastHitReal = 0;

  /** The browser's cooldown check: on both the wall clock and the physics clock. */
  canHit(): boolean {
    return this.simTime - this.lastHitSim >= HIT_COOLDOWN_MS + 10 && Date.now() - this.lastHitReal >= HIT_COOLDOWN_MS + 10;
  }

  hit(id: number) {
    this.lastHitSim = this.simTime;
    this.lastHitReal = Date.now();
    const v = this.view.get(id);
    const p = this.body.pos;
    this.log.push(`${Date.now()} hit #${id} tk=${this.lastTick} me ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} yaw ${this.yaw.toFixed(2)} pitch ${this.pitch.toFixed(2)} sees ${v ? `${v.pos.x.toFixed(2)},${v.pos.y.toFixed(2)},${v.pos.z.toFixed(2)}` : "-"}`);
    this.flushMove();
    this.send({ t: "hit", id, yaw: this.yaw, pitch: this.pitch, tk: this.lastTick });
  }

  place(x: number, y: number, z: number) {
    this.flushMove();
    this.send({ t: "place", x, y, z });
  }

  breakBlock(x: number, y: number, z: number) {
    this.flushMove();
    this.send({ t: "break", x, y, z });
  }

  /** The browser's pickPlayer: nearest drawn player under the crosshair. */
  pick(): { id: number; t: number; hp: number } | null {
    const o = this.eye();
    const d = lookDir(this.yaw, this.pitch);
    let best: { id: number; t: number; hp: number } | null = null;
    for (const [id, v] of this.view) {
      const p = v.pos;
      const k = this.sizeOf(id);
      const t = rayBox(o, d, { x: p.x - HW * k - 0.1, y: p.y - 0.1, z: p.z - HW * k - 0.1 }, { x: p.x + HW * k + 0.1, y: p.y + PH * k + 0.1, z: p.z + HW * k + 0.1 }, HIT_REACH);
      if (t !== null && (!best || t < best.t)) best = { id, t, hp: v.hp };
    }
    return best;
  }

  /** The browser's secondaryAction checks. */
  tryPlace(): boolean {
    const hit = raycastVoxels(this.world, this.eye(), lookDir(this.yaw, this.pitch), BUILD_REACH);
    if (!hit || this.dirt <= 0) return false;
    const x = hit.x + hit.nx;
    const y = hit.y + hit.ny;
    const z = hit.z + hit.nz;
    if (!Voxels.inBounds(x, y, z) || this.world.get(x, y, z) || !cellInRing(x, z, this.edge())) return false;
    const p = this.body.pos;
    if (p.x + HW > x && p.x - HW < x + 1 && p.z + HW > z && p.z - HW < z + 1 && p.y + PH > y && p.y < y + 1) return false;
    this.place(x, y, z);
    this.blocksPlaced++;
    return true;
  }
}

/** Calls `frame(dt, now)` like requestAnimationFrame until `done()` or the deadline. */
export function run(bot: Bot, frame: (dt: number, now: number) => void, ms: number, done: () => boolean = () => false, frameMs: () => number = () => 16): Promise<void> {
  const end = Date.now() + ms;
  return new Promise((resolve) => {
    let last = Date.now();
    const loop = () => {
      const now = Date.now();
      if (now > end || done() || bot.closed) return resolve();
      const dt = Math.min(MAX_STEP_DT, (now - last) / 1000);
      last = now;
      frame(dt, now);
      setTimeout(loop, frameMs());
    };
    setTimeout(loop, frameMs());
  });
}

/** Two players `d` blocks apart along z, facing each other. */
export const facing = (d: number) => (i: number) => (i === 0 ? { x: 0.5, z: 0.5, yaw: 0 } : { x: 0.5, z: 0.5 - d, yaw: Math.PI });

export async function match(opts: ServerOptions, n = 2, net: Net = LAN) {
  const srv = await startServer(opts);
  const bots: Bot[] = [];
  for (let i = 0; i < n; i++) bots.push(await Bot.join(srv.url, `p${i}`, net));
  await waitFor(() => bots.every((b) => b.id > 0), 3000, "welcome");
  await waitFor(() => bots.every((b) => b.playing), 20_000, "round start");
  return { srv, bots };
}

export const flagged = (srv: TestServer, check: string, id?: number) => srv.violations.some((v) => v.check === check && v.points > 0 && (id === undefined || v.id === id));

/** Stands still like an idle browser tab that still reports its position. */
export const idle = (bot: Bot) => (dt: number, now: number) => {
  if (!bot.playing && !bot.inHub) return;
  bot.step(dt, { forward: 0, strafe: 0, jump: false, yaw: bot.yaw });
  bot.maybeSendMove(now);
};

/** A few idle frames: real clients never act twice within the same frame. */
export const frames = (bot: Bot, ms = 150) => run(bot, idle(bot), ms);


/** Walks in circles like a player strafing around. */
export const walker = (bot: Bot) => (dt: number, now: number) => {
  bot.interp(dt);
  if (!bot.playing) return;
  bot.yaw += dt * 0.8;
  bot.step(dt, { forward: 1, strafe: 0, jump: false, yaw: bot.yaw });
  bot.maybeSendMove(now);
};


/** The browser's pickPlayer, for mobs: nearest drawn mob under the crosshair. */
export function pickMob(bot: Bot): { id: number; t: number; kind: MobKind } | null {
  const o = bot.eye();
  const d = lookDir(bot.yaw, bot.pitch);
  let best: { id: number; t: number; kind: MobKind } | null = null;
  for (const [id, v] of bot.mobs) {
    const p = v.pos;
    const t = rayBox(o, d, { x: p.x - HW - 0.1, y: p.y - 0.1, z: p.z - HW - 0.1 }, { x: p.x + HW + 0.1, y: p.y + PH + 0.1, z: p.z + HW + 0.1 }, HIT_REACH);
    if (t !== null && (!best || t < best.t)) best = { id, t, kind: v.kind };
  }
  return best;
}

/** Points the bot's view at a spot (yaw and pitch from the eye). */
export function lookAt(bot: Bot, to: Vec3): void {
  const a = aimAt(bot.eye(), to);
  bot.yaw = a.yaw;
  bot.pitch = a.pitch;
}

/** Walks through waypoints like a player holding W, hopping onto 1-block steps when it bumps into them. */
export async function walkPath(bot: Bot, points: { x: number; z: number }[], ms = 40_000): Promise<boolean> {
  let i = 0;
  let stuckSince = 0;
  await run(
    bot,
    (dt, now) => {
      bot.interp(dt);
      if (!bot.inHub && !bot.playing) return;
      const p = bot.body.pos;
      const goal = points[i];
      const d = Math.hypot(goal.x - p.x, goal.z - p.z);
      if (d < 0.35) {
        i++;
        bot.step(dt, { forward: 0, strafe: 0, jump: false, yaw: bot.yaw });
        bot.maybeSendMove(now);
        return;
      }
      bot.yaw = yawTowards(p.x, p.z, goal.x, goal.z);
      bot.pitch = 0;
      const slow = Math.hypot(bot.body.vel.x, bot.body.vel.z) < 0.5;
      if (slow && !stuckSince) stuckSince = now;
      if (!slow) stuckSince = 0;
      const jump = !!stuckSince && now - stuckSince > 120 && bot.body.onGround;
      bot.step(dt, { forward: d > 0.6 ? 1 : 0.4, strafe: 0, jump, yaw: bot.yaw });
      bot.maybeSendMove(now);
    },
    ms,
    () => i >= points.length,
  );
  return i >= points.length;
}

/** Idles in place until `done()` (keeps reporting position like a real tab). */
export const idleUntil = (bot: Bot, done: () => boolean, ms: number) =>
  run(
    bot,
    (dt, now) => {
      bot.interp(dt);
      if (!bot.inHub && !bot.playing) return;
      bot.step(dt, { forward: 0, strafe: 0, jump: false, yaw: bot.yaw });
      bot.maybeSendMove(now);
    },
    ms,
    done,
  );
