import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  ARENA_RADIUS,
  BLOCK,
  BUFF_IDS,
  BUFFS,
  BUILD_REACH,
  BUILDER_BONUS,
  BUILDERS_BONUS,
  CHAOS_CLASH,
  CLOSE_KICKED,
  CLOSE_OUTDATED,
  CRIT_MULTIPLIER,
  EYE_HEIGHT,
  FALL_CREDIT_MS,
  FALL_OUT_Y,
  GIANT_SIZE,
  GRAVITY,
  HIT_COOLDOWN_MS,
  HIT_DAMAGE,
  HILL_RADIUS,
  HILL_TARGET,
  HIT_REACH,
  HOT_STREAK,
  HUB,
  MAX_HEIGHT,
  MAX_HP,
  MAX_PLAYERS,
  MIN_PLAYERS,
  MOB_ID_BASE,
  MODE_IDS,
  MODE_SKIPS_BUFFS,
  MODES,
  PLAYER_COLORS,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  PROTOCOL_VERSION,
  ROULETTE_MS,
  SKIN_IDS,
  SMALL_SIZE,
  SPLEEF_LAYERS,
  SPRINT_SPEED,
  SPRINT_KNOCKBACK,
  SPRINT_KNOCKBACK_UP,
  START_DIRT,
  TEAM_KILLS_PER_PLAYER,
  TICK_MS,
  Voxels,
  WALK_SPEED,
  WS_PATH,
  buffAt,
  buffCount,
  buffIndexAt,
  buffModifiers,
  cellInRing,
  crumbleSteps,
  hubBlocks,
  inCellBox,
  inCircle,
  lookDir,
  makeTimings,
  rayBox,
  raycastVoxels,
  segmentClear,
  sizeStats,
  spawnPoint,
  startRadius,
  yawTowards,
} from "../src/game/shared.ts";
import type {
  BagInfo,
  BuffId,
  BuffMods,
  ClientMsg,
  GameMode,
  KillReason,
  Phase,
  PlayerInfo,
  Role,
  RoundResult,
  ServerMsg,
  SkinId,
  Spot,
  Timings,
  TrainStats,
  Vec3,
  View,
} from "../src/game/shared.ts";
import {
  CHECK_LABELS,
  IpGuard,
  KB_ACK_MS,
  MSG_BURST,
  MSG_PER_SEC,
  TokenBucket,
  checkMove,
  clientIp,
  configFromEnv,
  decayVl,
  dropToGround,
  endSprint,
  isTeleportAck,
  knockbackCredit,
  newMotion,
  originAllowed,
  speedCredit,
} from "./anticheat.ts";
import type { AcConfig, ClientAddr, KbCredit, MoveCtx, Motion } from "./anticheat.ts";
import { MobWorld } from "./mobs.ts";
import type { Mob } from "./mobs.ts";
import { Records } from "./records.ts";

type Action = "hit" | "place" | "break";

interface RangeRun {
  state: "countdown" | "running";
  until: number;
  score: number;
  target: number | null;
  nextSpawnAt: number;
}

interface ParkourRun {
  state: "idle" | "ready" | "running";
  startedAt: number;
}

interface Client {
  id: number;
  ws: WebSocket;
  ip: string;
  /** See ClientAddr.known: per-IP limits, bans and ghost filtering only apply when true. */
  ipKnown: boolean;
  name: string | null;
  color: string;
  skin: SkinId;
  /** "player": takes part in the current round. */
  role: Role;
  /** Hub: walking around the lobby. Arena: in the current round (alive or dead). */
  loc: "hub" | "arena";
  /** In the hub, but watching the arena round. */
  watching: boolean;
  joinedAt: number;
  alive: boolean;
  hp: number;
  dirt: number;
  kills: number;
  /** Who last hit this player this round and when: a fall soon after is their kill. */
  lastHitBy: number;
  lastHitAt: number;
  lastKillAt: number;
  maxHp: number;
  /** Extra max health from vampire kills, until death. */
  bonusHp: number;
  /** Body size (giants buff). */
  size: number;
  /** Team in a team mode (Infection: 0 humans, 1 zombies). */
  team: number | null;
  /** King of the Hill points. */
  score: number;
  arrows: number;
  lastShotAt: number;
  /** When a dead player comes back (respawn modes); 0 if not. */
  respawnAt: number;
  /** Eliminated players' choice for the next buff. */
  buffVote: number | null;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  lastMoveAt: number;
  /** Horizontal speed over the last accepted move (a sprint hit needs a real run-up). */
  hspeed: number;
  isAlive: boolean;
  // anticheat
  rtt: number;
  pingAt: number;
  /** Sequence of the last teleport sent; moves made before the client applied it are dropped. */
  tpSeq: number;
  /** Knockback counter; the client echoes the last one it applied. */
  kbSeq: number;
  /** Last tick the client had seen at its last accepted move, and the buff changes already
   *  turned into speed credits. */
  lastTk: number;
  creditedTick: number;
  motion: Motion;
  /** Positions as sent in recent ticks, to rewind hits to what the attacker saw. */
  seenAt: { s: number; x: number; y: number; z: number }[];
  msgs: TokenBucket;
  /** Last use of each action on the client's physics clock. */
  cooldowns: Record<Action, { ts: number }>;
  lastAttackAt: number;
  lastDamageAt: number;
  nextRegenAt: number;
  /** When moves resumed after a gap (frozen tab, hitch, network stall): drawn players lag behind. */
  resumedAt: number;
  /** Violation level: decaying sum of points, kick at AcConfig.kickVl. */
  vl: number;
  vlAt: number;
  loggedAt: Map<string, number>;
  kicked: boolean;
  // hub
  /** Standing in the ready circle (lobby only). */
  ready: boolean;
  vote: GameMode | null;
  /** Last real input (moving, looking, acting): AFK players aren't pulled into rounds. */
  lastActiveAt: number;
  /** Left out of a full round: goes first next time. */
  queuedSince: number;
  /** Where to come back to after watching the arena. */
  hubSpot: Spot | null;
  /** This round: damage dealt, crits, blocks placed. */
  stats: { damage: number; crits: number; blocks: number };
  train: TrainStats;
  trainDirty: boolean;
  trainSentAt: number;
  lastTrainHitAt: number;
  dmgLog: [number, number][];
  nonCrits: number;
  hintAt: number;
  hintsSeen: Set<string>;
  range: RangeRun | null;
  parkour: ParkourRun;
  invite: { from: number; at: number } | null;
  invitedAt: number;
  lookAt: number;
  hubKey: string;
  hubSentAt: number;
}

export interface Violation {
  at: number;
  id: number;
  name: string;
  ip: string;
  check: string;
  points: number;
  vl: number;
  detail: string;
  kicked: boolean;
}

export interface ServerOptions {
  timeScale?: number;
  /** Overrides for the PVP_* environment settings. */
  anticheat?: Partial<AcConfig>;
  /** Fixed buff order instead of a shuffled one (tests). */
  buffPlan?: BuffId[];
  /** Fixed round mode instead of the hub vote (tests). */
  mode?: GameMode;
  /** Fixed arena spawn points instead of the circle (tests). */
  spawnPoints?: (index: number, count: number) => { x: number; z: number; yaw: number };
  onViolation?: (v: Violation) => void;
  /** Daily records file; null keeps them in memory only. Default: PVP_RECORDS_FILE or data/records.json. */
  recordsFile?: string | null;
  /** Shooting range run length (default 30 s). */
  rangeMs?: number;
  /** How long blocks placed in the hub's build area last (default 60 s). */
  buildTtlMs?: number;
  /** Duel fight time limit (default 90 s). */
  duelMs?: number;
}

const BREAK_COOLDOWN_MS = 120;
const PLACE_COOLDOWN_MS = 80;
const LAVA_INTERVAL_MS = 500;
/** The lava stops rising at this height. */
const LAVA_MAX = 3;
/** Dirt a player comes back with in the respawn modes. */
const RESPAWN_DIRT = 5;
const BOMB_RADIUS = 4;
const BOMB_DAMAGE = 14;
const BOMB_BLOCKS = 2.5;
/** The bomb can't be passed straight back to whoever just passed it. */
const BOMB_TAGBACK_MS = 1500;
const METEOR_WARN_MS = 2000;
const METEOR_RADIUS = 2.4;
const METEOR_DAMAGE = 10;
const METEOR_BLOCKS = 1.6;
const SWAP_WARN_MS = 3000;
const BOW_ARROWS = 5;
const ARROW_SPEED = 30;
/** Same as the client's, which draws the arrows in between ticks. */
const ARROW_GRAVITY = 8;
const ARROW_DAMAGE = 4;
const ARROW_LIFE_MS = 4000;
const SHOOT_COOLDOWN_MS = 600;
const BOUNTY_DIRT = 8;
const VAMPIRE_BONUS = 2;
const VAMPIRE_MAX_BONUS = 10;
const ZOMBIE_DAMAGE = 1.25;
/** The buff vote opens this long after the previous buff landed. */
const VOTE_DELAY_MS = 3000;
const REGEN_DELAY_MS = 4000; // регенерация начинается через 4 секунды без урона
const REGEN_INTERVAL_MS = 1000; // не чаще раза в секунду
const REGEN_HP = 1; // полсердца в секунду (1 сердце = 2 hp)
const DEFAULT_RTT_MS = 150;
/** A player below the floor's level who stopped reporting moves this long ago has fallen off. */
const STALE_FALL_MS = 2000;
/** A second kill this soon after the previous one is a double kill. */
const MULTI_KILL_MS = 10_000;
const STREAKS: Record<number, string> = { [HOT_STREAK]: "В УДАРЕ", 5: "НЕУДЕРЖИМ", 7: "ЛЕГЕНДА АРЕНЫ" };
/** Moves are judged by what the client had seen (`move.tk`), but never as more than 5 s behind:
 *  that bounds what lying about it can buy. */
const MAX_LAG_TICKS = 100;
const TICK_HISTORY = 256;
/** The client pads hit boxes by 0.1; the rest covers interpolation between ticks. */
const HIT_BOX_PAD = 0.35;
const HIT_REACH_SLACK = 0.3;
/** Drawn players blend the last few ticks (exponential smoothing, ~70 ms), so hits are checked
 *  against that many ticks before the last one the attacker had received. */
const HIT_BLEND_TICKS = 8;
/** Oldest tick a hit may refer to: more lag than this and hits are ignored. */
const MAX_REWIND_TICKS = 12;
/** A client further behind than this, or that just resumed after a freeze, still draws players
 *  gliding from old positions: a hit it got wrong is refused without violation points. */
const FRESH_VIEW_TICKS = 4;
const RESUME_GRACE_MS = 600;
/** A ray of BUILD_REACH plus the distance from its hit point to a cell centre (√3/2). */
const BUILD_REACH_MAX = BUILD_REACH + 1;
/** Players hidden by fog or invisibility are not sent at all (anti-ESP). Client fog is opaque at 11. */
const NIGHT_VIEW = 18;
const INVISIBLE_VIEW = 14;
/** A hit reveals an invisible attacker for a second on the client. */
const REVEAL_MS = 1200;
/** Points of a cell used to check that it can be seen (centre, face centres, corners). */
const CELL_SAMPLES: [number, number, number][] = [[0.5, 0.5, 0.5]];
for (const a of [0.05, 0.95]) CELL_SAMPLES.push([a, 0.5, 0.5], [0.5, a, 0.5], [0.5, 0.5, a]);
for (const x of [0.05, 0.95]) for (const y of [0.05, 0.95]) for (const z of [0.05, 0.95]) CELL_SAMPLES.push([x, y, z]);

/** No input for this long: AFK, left in the hub when a round starts. */
const AFK_MS = 60_000;
const HUB_REFRESH_MS = 1000;
const TRAIN_SEND_MS = 150;
const HINT_GAP_MS = 1200;
const RANGE_COUNTDOWN_MS = 3000;
const TARGET_TTL_MS = 2600;
const HUB_BLOCK_LIMIT = 800;
const DUEL_COUNTDOWN_MS = 3000;
const INVITE_MS = 15_000;
const DUEL_RANGE = 8;
const PARKOUR_MAX_MS = 5 * 60_000;
/** Falling to the floor this far from the parkour start ends the run. */
const PARKOUR_FALL_DIST = 4;

const COOLDOWN_MS: Record<Action, number> = { hit: HIT_COOLDOWN_MS, place: PLACE_COOLDOWN_MS, break: BREAK_COOLDOWN_MS };

const finite = (...v: unknown[]) => v.every((n) => typeof n === "number" && Number.isFinite(n));
const ints = (...v: unknown[]) => v.every((n) => Number.isInteger(n));
const r2 = (n: number) => Math.round(n * 100) / 100;
const clampPitch = (p: number) => Math.max(-Math.PI / 2, Math.min(Math.PI / 2, p));
const emptyTrain = (): TrainStats => ({ hits: 0, crits: 0, combo: 0, best: 0, dps: 0, kills: 0, knocked: 0, dodged: 0, arrowHits: 0 });

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
}

function boxDistance(p: Vec3, min: Vec3, max: Vec3): number {
  return Math.hypot(Math.max(min.x - p.x, 0, p.x - max.x), Math.max(min.y - p.y, 0, p.y - max.y), Math.max(min.z - p.z, 0, p.z - max.z));
}

let warnedUnknownIp = false;

function reject(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

interface GameWorld {
  w: View;
  vox: Voxels;
  /** When each cell last changed: clients may not know about very fresh blocks yet. */
  changedAt: Map<number, number>;
}

/** Something that can be hit: a player or a mob, with its recent tick positions. */
interface Hittable extends Vec3 {
  seenAt: { s: number; x: number; y: number; z: number }[];
}

export class PvpServer {
  readonly timings: Timings;
  private readonly cfg: AcConfig;
  private readonly guard: IpGuard;
  private readonly fixedBuffs: BuffId[] | null;
  private readonly fixedMode: GameMode | null;
  private readonly fixedSpawns: ServerOptions["spawnPoints"] | null;
  private readonly onViolation: ((v: Violation) => void) | null;
  private readonly rangeMs: number;
  private readonly buildTtlMs: number;
  private readonly duelMs: number;
  private wss: WebSocketServer;
  private clients = new Map<number, Client>();
  private nextId = 1;
  private phase: Phase = "lobby";
  private phaseStart = Date.now();
  private mode: GameMode = "classic";
  private arena: GameWorld = { w: "arena", vox: new Voxels(), changedAt: new Map() };
  private hub: GameWorld = { w: "hub", vox: new Voxels(), changedAt: new Map() };
  /** Player-placed blocks in the hub's build area, and when each one vanishes. */
  private hubPlaced = new Map<number, number>();
  private mobs: MobWorld;
  private records: Records;
  private recordsDirty = false;
  private recordsSentAt = 0;
  private lastResults: RoundResult | null = null;
  private crownId: number | null = null;
  /** Lobby auto-start time, null while there aren't enough players. */
  private startAt: number | null = null;
  private duel: { a: Client; b: Client; state: "countdown" | "fight"; until: number } | null = null;
  private rosterDirty = false;
  private rosterSentAt = 0;
  private lastSweep = 0;
  private bags = new Map<number, BagInfo>();
  private nextBagId = 1;
  /** Buffs of each slot: one, two in the Chaos finale. */
  private buffPlan: BuffId[][] = [];
  /** Buffs the round's mode allows. */
  private buffPool: BuffId[] = [];
  private buffIndex = -1;
  /** Buff changes of the current round: from which tick clients knew, and how much walking speed
   *  it took away (the client's velocity decays from the old speed). */
  private buffLog: { tick: number; buffs: BuffId[]; sizes: Map<number, number> }[] = [];
  /** When each recent tick was sent, indexed by tick number modulo TICK_HISTORY. */
  private tickTimes = new Float64Array(TICK_HISTORY);
  /** Participants in the order they died this round. */
  private deaths: number[] = [];
  private winner: Client | null = null;
  private pointsWin = false;
  /** The arena island's radius, and from which tick clients knew of each change this round. */
  private floorR = ARENA_RADIUS;
  private floorLog: { tick: number; r: number }[] = [];
  /** Next crumble step of the round, and the last one already announced. */
  private crumbleIndex = 0;
  private crumbleWarned = -1;
  private overtime = false;
  private firstBlood = false;
  private teamOffset = 0;
  private winTeam: number | null = null;
  private teamKills = [0, 0];
  private teamGoal = 0;
  private lavaY = -1;
  private nextLavaRise = 0;
  private bountyId: number | null = null;
  private bomb: { holder: Client; until: number; from: number; at: number } | null = null;
  private nextBombAt = 0;
  private meteors: { id: number; x: number; y: number; z: number; at: number }[] = [];
  private nextMeteorAt = 0;
  private nextMeteorId = 1;
  private nextSwapAt = 0;
  private swapWarned = false;
  /** Giants buff: who is big and who is small. */
  private sizes = new Map<number, number>();
  private arenaArrows = new Map<number, { id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; owner: number; bornAt: number }>();
  private nextArrowId = 1;
  /** King of the Hill: who holds the hill, or whether it's contested. */
  private hill: number | null = null;
  private contested = false;
  private nextHillAt = 0;
  private scoreSentAt = 0;
  private vote: { slot: number; options: BuffId[]; until: number; sentAt: number } | null = null;
  private lastLava = 0;
  private rouletteIndex = -1;
  private tickSeq = 0;
  private lastTickAt = Date.now();
  private stallLoggedAt = 0;
  private tickTimer: ReturnType<typeof setInterval>;
  private pingTimer: ReturnType<typeof setInterval>;

  constructor(opts: ServerOptions = {}) {
    this.timings = makeTimings(opts.timeScale ?? 1);
    this.cfg = { ...configFromEnv(), ...opts.anticheat };
    this.guard = new IpGuard(this.cfg);
    this.fixedBuffs = opts.buffPlan ?? null;
    this.fixedMode = opts.mode ?? null;
    this.fixedSpawns = opts.spawnPoints ?? null;
    this.onViolation = opts.onViolation ?? null;
    this.rangeMs = opts.rangeMs ?? 30_000;
    this.buildTtlMs = opts.buildTtlMs ?? 60_000;
    this.duelMs = opts.duelMs ?? 90_000;
    const file = opts.recordsFile !== undefined ? opts.recordsFile : process.env.PVP_RECORDS_FILE || "data/records.json";
    this.records = new Records(file);
    const q = hubBlocks();
    for (let i = 0; i < q.length; i += 4) this.hub.vox.set(q[i], q[i + 1], q[i + 2], q[i + 3]);
    this.arena.vox.floorRadius = ARENA_RADIUS;
    this.mobs = new MobWorld(this.hub.vox);
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      this.guard.sweep(now);
      for (const c of this.clients.values()) {
        if (!c.isAlive) {
          c.ws.terminate();
          continue;
        }
        c.isAlive = false;
        c.pingAt = now;
        c.ws.ping();
      }
    }, 15_000);
  }

  /** Returns true when the upgrade request belonged to the game. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== WS_PATH) return false;
    const addr = clientIp(req, this.cfg.ipHeader);
    if (!addr.known && !warnedUnknownIp) {
      warnedUnknownIp = true;
      console.warn(
        `[anticheat] connections from ${addr.ip} carry no X-Forwarded-For, so players can't be told apart: per-IP limits and bans are off for them` +
          " (behind nginx add: proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;)",
      );
    }
    if (!originAllowed(req.headers.origin, this.cfg.allowedOrigins)) {
      reject(socket, "403 Forbidden");
      return true;
    }
    if (!this.guard.allowAttempt(addr, Date.now())) {
      reject(socket, "429 Too Many Requests");
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, addr));
    return true;
  }

  close(): void {
    clearInterval(this.tickTimer);
    clearInterval(this.pingTimer);
    this.records.flush();
    for (const c of this.clients.values()) c.ws.terminate();
    this.wss.close();
  }

  // ---------------------------------------------------------------- connections

  private onConnection(ws: WebSocket, addr: ClientAddr): void {
    const now = Date.now();
    const refusal = this.guard.refuse(addr, this.clients.size, now);
    if (refusal) {
      ws.close(refusal.code, refusal.reason);
      return;
    }
    if (addr.known) this.guard.opened(addr.ip);
    const c: Client = {
      id: this.nextId++,
      ws,
      ip: addr.ip,
      ipKnown: addr.known,
      name: null,
      color: PLAYER_COLORS[0],
      skin: "steve",
      role: "spectator",
      loc: "hub",
      watching: false,
      joinedAt: now,
      alive: false,
      hp: MAX_HP,
      dirt: 0,
      kills: 0,
      lastHitBy: 0,
      lastHitAt: 0,
      lastKillAt: 0,
      maxHp: MAX_HP,
      bonusHp: 0,
      size: 1,
      team: null,
      score: 0,
      arrows: 0,
      lastShotAt: 0,
      respawnAt: 0,
      buffVote: null,
      x: HUB.spawn.x,
      y: 0,
      z: HUB.spawn.z,
      yaw: 0,
      pitch: 0,
      lastMoveAt: 0,
      hspeed: 0,
      isAlive: true,
      rtt: DEFAULT_RTT_MS,
      pingAt: 0,
      tpSeq: 0,
      kbSeq: 0,
      lastTk: 0,
      creditedTick: 0,
      motion: newMotion(),
      seenAt: [],
      msgs: new TokenBucket(MSG_BURST, MSG_PER_SEC, now),
      cooldowns: { hit: { ts: -Infinity }, place: { ts: -Infinity }, break: { ts: -Infinity } },
      lastAttackAt: 0,
      lastDamageAt: 0,
      nextRegenAt: 0,
      resumedAt: 0,
      vl: 0,
      vlAt: now,
      loggedAt: new Map(),
      kicked: false,
      ready: false,
      vote: null,
      lastActiveAt: now,
      queuedSince: 0,
      hubSpot: null,
      stats: { damage: 0, crits: 0, blocks: 0 },
      train: emptyTrain(),
      trainDirty: false,
      trainSentAt: 0,
      lastTrainHitAt: 0,
      dmgLog: [],
      nonCrits: 0,
      hintAt: 0,
      hintsSeen: new Set(),
      range: null,
      parkour: { state: "idle", startedAt: 0 },
      invite: null,
      invitedAt: 0,
      lookAt: 0,
      hubKey: "",
      hubSentAt: 0,
    };
    this.clients.set(c.id, c);
    ws.on("pong", () => {
      c.isAlive = true;
      if (!c.pingAt) return;
      const sample = Math.min(2000, Date.now() - c.pingAt);
      c.pingAt = 0;
      c.rtt = c.rtt === DEFAULT_RTT_MS ? sample : c.rtt * 0.7 + sample * 0.3;
    });
    ws.on("message", (data) => {
      if (c.kicked) return;
      const now = Date.now();
      if (!c.msgs.take(now)) return this.flag(c, "flood", 0.25, "message rate");
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return this.flag(c, "packet", 1, "invalid JSON");
      }
      this.onMessage(c, msg, now);
    });
    ws.on("close", () => this.onClose(c));
    ws.on("error", () => ws.terminate());
  }

  private onMessage(c: Client, m: ClientMsg, now: number): void {
    if (!m || typeof m !== "object") return this.flag(c, "packet", 1, "not an object");
    if (m.t === "ping") return finite(m.id) ? this.send(c, { t: "pong", id: m.id }) : undefined;
    if (m.t === "hello") return this.onHello(c, m, now);
    if (!c.name) return;
    switch (m.t) {
      case "move":
        return this.onMove(c, m, now);
      case "hit":
        return this.onHit(c, m, now);
      case "place":
        return this.onPlace(c, m.x, m.y, m.z, now);
      case "break":
        return this.onBreak(c, m.x, m.y, m.z, now);
      case "watch":
        return this.onWatch(c, !!m.on);
      case "look":
        return this.onLook(c, m.color, m.skin, now);
      case "duel":
        return this.onDuelInvite(c, m.id, now);
      case "duelAnswer":
        return this.onDuelAnswer(c, !!m.accept, now);
      case "shoot":
        return this.onShoot(c, m, now);
      case "buffVote":
        return this.onBuffVote(c, m.i);
    }
  }

  private onHello(c: Client, m: Extract<ClientMsg, { t: "hello" }>, now: number): void {
    if (c.name) return;
    if (m.v !== PROTOCOL_VERSION) {
      c.ws.close(CLOSE_OUTDATED, "outdated client");
      return;
    }
    let name = sanitizeName(m.name) || `Игрок${c.id}`;
    const taken = new Set(this.named().map((p) => p.name.toLowerCase()));
    if (taken.has(name.toLowerCase())) name = `${name.slice(0, 13)}#${c.id}`;
    c.name = name;
    if (typeof m.color === "string" && PLAYER_COLORS.includes(m.color)) {
      c.color = m.color;
    } else {
      const usedColors = new Set(this.named().map((p) => p.color));
      c.color = PLAYER_COLORS.find((col) => !usedColors.has(col)) ?? PLAYER_COLORS[c.id % PLAYER_COLORS.length];
    }
    c.skin = SKIN_IDS.includes(m.skin as SkinId) ? (m.skin as SkinId) : "steve";
    c.joinedAt = c.lastActiveAt = now;

    this.send(c, { t: "welcome", id: c.id });
    this.send(c, this.phaseMsg());
    this.send(c, { t: "records", r: this.records.snapshot() });
    if (this.lastResults) this.send(c, { t: "results", r: this.lastResults });
    this.toHub(c, null);
    this.sendHub(c, now, true);
    this.broadcastRoster();
    // First latency sample for lag compensation; the heartbeat refreshes it.
    c.pingAt = Date.now();
    c.ws.ping();
  }

  private onClose(c: Client): void {
    if (!this.clients.delete(c.id)) return;
    if (c.ipKnown) this.guard.closed(c.ip);
    if (!c.name) return;
    if (this.duel && (this.duel.a === c || this.duel.b === c)) this.endDuel(this.duel.a === c ? this.duel.b : this.duel.a, `${c.name} покинул игру`);
    this.cancelRange(c);
    if (c.alive && c.loc === "arena" && (this.phase === "playing" || this.phase === "countdown")) {
      this.eliminate(c, null, "leave");
    }
    if (this.crownId === c.id) this.crownId = null;
    this.broadcastRoster();
    this.checkRoundEnd();
  }

  // ---------------------------------------------------------------- who is where

  private named(): (Client & { name: string })[] {
    return [...this.clients.values()].filter((c): c is Client & { name: string } => c.name !== null);
  }

  private participants(): Client[] {
    return this.named().filter((c) => c.role === "player");
  }

  private alivePlayers(): Client[] {
    return this.participants().filter((p) => p.alive && p.loc === "arena");
  }

  private viewOf(c: Client): View {
    return c.loc === "arena" || c.watching ? "arena" : "hub";
  }

  /** Players walking around the hub (not watching the arena). */
  private hubWalkers(): (Client & { name: string })[] {
    return this.named().filter((c) => c.loc === "hub" && !c.watching);
  }

  private isWalker(c: Client): boolean {
    return c.name !== null && c.loc === "hub" && !c.watching && this.clients.has(c.id);
  }

  private inDuel(c: Client): boolean {
    return !!this.duel && (this.duel.a === c || this.duel.b === c);
  }

  private viewers(view: View): Client[] {
    return this.named().filter((c) => this.viewOf(c) === view);
  }

  private spawnSpot(): Spot {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * HUB.spawn.r;
    return { x: HUB.spawn.x + Math.cos(a) * r, y: 0, z: HUB.spawn.z + Math.sin(a) * r, yaw: 0 };
  }

  /** Moves a client into the hub world at `spot` (default: where it left from, else the spawn). */
  private toHub(c: Client, spot: Spot | null): void {
    c.loc = "hub";
    c.watching = false;
    c.alive = false;
    c.hp = MAX_HP;
    const s = spot ?? c.hubSpot ?? this.spawnSpot();
    c.hubSpot = null;
    this.relocate(c, s);
    this.send(c, { t: "world", w: "hub", blocks: this.hub.vox.toQuads() });
    this.teleport(c, s.yaw);
    this.sendYou(c);
  }

  /** New position in a (possibly different) world: fresh physics and hit history. */
  private relocate(c: Client, s: Spot): void {
    Object.assign(c, { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: 0 });
    c.motion = newMotion();
    c.seenAt = [];
    c.lastTk = c.creditedTick = this.tickSeq;
  }

  /** Teleport within the hub (duel pit, back from it). */
  private placeAt(c: Client, s: Spot): void {
    this.relocate(c, s);
    this.teleport(c, s.yaw);
  }

  private onWatch(c: Client, on: boolean): void {
    if (on) {
      if (c.loc !== "hub" || c.watching || this.phase === "lobby" || this.inDuel(c)) return;
      this.leaveActivities(c);
      c.hubSpot = { x: c.x, y: c.y, z: c.z, yaw: c.yaw };
      c.watching = true;
      c.ready = false;
      this.send(c, { t: "world", w: "arena", blocks: this.arena.vox.toQuads() });
      this.send(c, { t: "bags", bags: [...this.bags.values()] });
      this.sendRoundState(c);
      this.sendYou(c);
      return;
    }
    if (c.watching || (c.loc === "arena" && !c.alive)) this.toHub(c, null);
  }

  private onLook(c: Client, color: unknown, skin: unknown, now: number): void {
    if (now - c.lookAt < 300) return;
    if (typeof color !== "string" || !PLAYER_COLORS.includes(color) || !SKIN_IDS.includes(skin as SkinId)) return;
    c.lookAt = now;
    c.color = color;
    c.skin = skin as SkinId;
    c.lastActiveAt = now;
    this.rosterDirty = true;
  }

  // ---------------------------------------------------------------- round

  private startRound(active: Client[], now: number): void {
    const sorted = [...active].sort(
      (a, b) => Number(b.ready) - Number(a.ready) || (a.queuedSince || Infinity) - (b.queuedSince || Infinity) || a.joinedAt - b.joinedAt,
    );
    const chosen = sorted.slice(0, MAX_PLAYERS);
    for (const c of sorted.slice(MAX_PLAYERS)) if (!c.queuedSince) c.queuedSince = now;
    const tally = new Map<GameMode, number>();
    for (const c of this.named()) if (c.vote) tally.set(c.vote, (tally.get(c.vote) ?? 0) + 1);
    const most = Math.max(0, ...tally.values());
    const leaders = MODE_IDS.filter((m) => most > 0 && tally.get(m) === most);
    const mode = this.fixedMode ?? (leaders.length ? leaders[Math.floor(Math.random() * leaders.length)] : "classic");
    for (const c of this.named()) c.vote = null;
    this.startCountdown(chosen, mode);
  }

  private startCountdown(chosen: Client[], mode: GameMode): void {
    const ps = shuffle(chosen);
    const offset = Math.random() * Math.PI * 2;
    const def = MODES[mode];
    this.mode = mode;
    this.clearArena();
    this.bags.clear();
    this.resetRoundEvents();
    const slots = buffCount(this.timings);
    const skip = MODE_SKIPS_BUFFS[mode];
    this.buffPool = BUFF_IDS.filter((b) => !skip.includes(b));
    this.buffPlan = this.fixedBuffs ? this.fixedBuffs.slice(0, slots).map((b) => [b]) : this.planBuffs(slots);
    this.buffIndex = -1;
    this.rouletteIndex = -1;
    this.winner = null;
    this.winTeam = null;
    this.pointsWin = false;
    this.overtime = false;
    this.firstBlood = false;
    this.teamKills = [0, 0];
    this.floorLog = [];
    this.crumbleIndex = 0;
    this.crumbleWarned = -1;
    this.setFloor(startRadius(mode));
    if (mode === "spleef") this.fillSpleef();
    this.deaths = [];
    this.setPhase("countdown");
    this.buffLog = [{ tick: this.tickSeq, buffs: [], sizes: new Map() }];
    for (const c of this.named()) {
      c.role = "spectator";
      c.ready = false;
    }
    const teams = this.assignTeams(ps, mode);
    this.teamGoal = TEAM_KILLS_PER_PLAYER * Math.max(1, ...[0, 1].map((k) => [...teams.values()].filter((v) => v === k).length));
    const blocks = this.arena.vox.toQuads();
    const dirt = mode === "sumo" || mode === "spleef" ? 0 : START_DIRT + (mode === "builders" ? BUILDERS_BONUS : 0);
    ps.forEach((p, i) => {
      this.leaveActivities(p);
      const team = teams.get(p.id) ?? null;
      const s = this.fixedSpawns?.(i, ps.length) ?? this.startSpot(i, ps.length, offset, team);
      p.loc = "arena";
      p.watching = false;
      p.hubSpot = null;
      p.queuedSince = 0;
      p.role = "player";
      Object.assign(p, {
        alive: true,
        hp: MAX_HP,
        maxHp: MAX_HP,
        bonusHp: 0,
        size: 1,
        team,
        score: 0,
        arrows: 0,
        respawnAt: 0,
        buffVote: null,
        dirt,
        kills: 0,
        lastHitBy: 0,
        lastHitAt: 0,
        lastKillAt: 0,
        lastMoveAt: 0,
        lastAttackAt: 0,
        lastDamageAt: 0,
        nextRegenAt: 0,
      });
      p.stats = { damage: 0, crits: 0, blocks: 0 };
      this.relocate(p, { x: s.x, y: mode === "spleef" ? SPLEEF_LAYERS[1] + 1 : 0, z: s.z, yaw: s.yaw });
      this.send(p, { t: "world", w: "arena", blocks });
      this.send(p, { t: "bags", bags: [] });
      this.teleport(p, s.yaw);
      this.sendYou(p);
    });
    this.notice(`Раунд начался · ${def.title} · ${plural(ps.length, "игрок", "игрока", "игроков")}`, def.color);
    if (def.respawn) this.sendScore(true);
    this.broadcastRoster();
  }

  /** One buff per slot from the mode's pool; the last slot is the Chaos finale: two at once. */
  private planBuffs(slots: number): BuffId[][] {
    const pool = shuffle(this.buffPool);
    const plan = pool.slice(0, slots).map((b) => [b]);
    if (slots >= 2 && plan.length === slots) {
      const last = plan[slots - 1][0];
      const clash = (b: BuffId) => b === last || CHAOS_CLASH.some(([x, y]) => (x === last && y === b) || (x === b && y === last));
      const second = pool.slice(slots).find((b) => !clash(b)) ?? pool.slice(0, slots - 1).find((b) => !clash(b));
      if (second) plan[slots - 1] = [last, second];
    }
    return plan;
  }

  /** Teams: alternate (the list is shuffled). Infection: about one zombie in four to start. */
  private assignTeams(ps: Client[], mode: GameMode): Map<number, number> {
    const out = new Map<number, number>();
    if (mode === "teams") ps.forEach((p, i) => out.set(p.id, i % 2));
    if (mode === "infection") {
      const zombies = Math.max(1, Math.round(ps.length / 4));
      ps.forEach((p, i) => out.set(p.id, i < zombies ? 1 : 0));
    }
    return out;
  }

  private teamAngle(team: number, offset: number): number {
    return offset + team * Math.PI;
  }

  private startSpot(i: number, n: number, offset: number, team: number | null): { x: number; z: number; yaw: number } {
    if (this.mode === "teams" && team !== null) {
      // Each team starts together on its own side of the island.
      const j = Math.floor(i / 2);
      const m = team === 0 ? Math.ceil(n / 2) : Math.floor(n / 2);
      const a = this.teamAngle(team, offset) + (j - (m - 1) / 2) * 0.22;
      const x = Math.cos(a) * 34;
      const z = Math.sin(a) * 34;
      this.teamOffset = offset;
      return { x, z, yaw: Math.atan2(x, z) };
    }
    if (this.mode === "sumo") return spawnPoint(i, n, offset, 7);
    if (this.mode === "spleef") return spawnPoint(i, n, offset, 9);
    return spawnPoint(i, n, offset);
  }

  /** Spleef: two snow layers over the abyss (there's no floor in this mode). */
  private fillSpleef(): void {
    const r = this.floorR;
    for (let x = -r - 1; x <= r; x++)
      for (let z = -r - 1; z <= r; z++) {
        if (!cellInRing(x, z, r)) continue;
        for (const y of SPLEEF_LAYERS) this.arena.vox.set(x, y, z, BLOCK.snow);
      }
  }

  private toLobby(): void {
    this.clearArena();
    this.bags.clear();
    this.resetRoundEvents();
    this.buffPlan = [];
    this.buffIndex = -1;
    this.overtime = false;
    this.setFloor(ARENA_RADIUS);
    const winner = this.winner;
    for (const c of this.named()) {
      const wasThere = c.loc === "arena" || c.watching;
      c.role = "spectator";
      c.alive = false;
      Object.assign(c, { size: 1, team: null, maxHp: MAX_HP, bonusHp: 0, arrows: 0, respawnAt: 0, buffVote: null, score: 0 });
      if (c === winner) this.toHub(c, HUB.pedestal);
      else if (wasThere) this.toHub(c, null);
    }
    this.setPhase("lobby");
    for (const c of this.named()) this.sendYou(c);
    this.broadcastRoster();
  }

  /** Stops every buff event (lava, bounty, bomb, meteors, swaps, sizes, arrows) and the buff vote. */
  private resetRoundEvents(): void {
    if (this.lavaY >= 0) this.broadcast({ t: "lava", y: -1 });
    if (this.bountyId !== null) this.broadcast({ t: "bounty", id: null });
    if (this.bomb) this.broadcast({ t: "bomb", holder: null, ms: 0 });
    this.lavaY = -1;
    this.bountyId = null;
    this.bomb = null;
    this.nextBombAt = 0;
    this.meteors = [];
    this.nextMeteorAt = 0;
    this.nextSwapAt = 0;
    this.swapWarned = false;
    this.sizes.clear();
    this.arenaArrows.clear();
    this.hill = null;
    this.contested = false;
    this.nextHillAt = 0;
    this.closeVote();
  }

  private clearArena(): void {
    this.arena.vox.clear();
    this.arena.changedAt.clear();
  }

  private get currentBuffs(): BuffId[] {
    return this.buffIndex >= 0 ? (this.buffPlan[this.buffIndex] ?? []) : [];
  }

  private has(buff: BuffId): boolean {
    return this.phase === "playing" && this.currentBuffs.includes(buff);
  }

  /** The island crumbles to radius `r` (or is whole again): blocks and bags past the edge go down
   *  with it. Clients drop the cells when they get the message, sent ahead of the next tick.
   *  Spleef has no floor at all, only its snow layers. */
  private setFloor(r: number, now = Date.now()): void {
    this.floorR = r;
    const floor = this.mode === "spleef" ? 0 : r;
    this.arena.vox.floorRadius = floor;
    this.floorLog.push({ tick: this.tickSeq + 1, r: floor });
    for (const i of [...this.arena.vox.filled]) {
      const [x, y, z] = Voxels.decode(i);
      if (cellInRing(x, z, r)) continue;
      this.arena.vox.set(x, y, z, 0);
      this.arena.changedAt.set(i, now);
    }
    const bags = this.bags.size;
    for (const [id, b] of this.bags) if (!cellInRing(Math.floor(b.x), Math.floor(b.z), r)) this.bags.delete(id);
    if (this.bags.size !== bags) this.sendTo(this.viewers("arena"), { t: "bags", bags: [...this.bags.values()] });
    this.broadcast({ t: "floor", r, next: null, ms: 0 });
  }

  /** Floor radius as of tick `tk`: the largest a client that had seen up to it may still stand on. */
  private floorSeen(tk: number): number {
    let r = ARENA_RADIUS;
    for (const e of this.floorLog) {
      if (e.tick > tk) break;
      r = e.r;
    }
    return r;
  }

  /** Marks the cells about to fall ahead of time, then drops them. */
  private crumbleTick(elapsed: number, now: number): void {
    const steps = crumbleSteps(this.timings, this.mode);
    const next = steps[this.crumbleIndex];
    if (next && this.crumbleWarned < this.crumbleIndex && next.at - elapsed <= this.timings.crumbleWarnMs) {
      this.crumbleWarned = this.crumbleIndex;
      this.broadcast({ t: "floor", r: this.floorR, next: next.r, ms: Math.max(0, next.at - elapsed) });
    }
    while (this.crumbleIndex < steps.length && elapsed >= steps[this.crumbleIndex].at) this.setFloor(steps[this.crumbleIndex++].r, now);
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.phaseStart = Date.now();
    this.broadcast(this.phaseMsg());
  }

  private phaseMsg(): ServerMsg {
    return {
      t: "phase",
      phase: this.phase,
      elapsed: Date.now() - this.phaseStart,
      timings: this.timings,
      buffs: this.currentBuffs,
      mode: this.mode,
      winner: this.winner?.id ?? null,
      winnerName: this.winner?.name ?? null,
      pointsWin: this.pointsWin,
      floor: this.floorR,
      winTeam: this.winTeam,
    };
  }

  private activateBuff(index: number, now = Date.now()): void {
    const prev = this.currentBuffs;
    const buffs = this.buffPlan[index];
    for (const b of prev) if (!buffs.includes(b)) this.endBuff(b);
    this.buffIndex = index;
    if (buffs.includes("giants") && !prev.includes("giants")) this.assignSizes();
    // Sent ahead of the next tick, so a client that has seen that tick knows the buff.
    this.buffLog.push({ tick: this.tickSeq + 1, buffs, sizes: new Map(this.sizes) });
    this.broadcast({ t: "buff", buffs });
    for (const b of buffs) if (!prev.includes(b)) this.startBuff(b, now);
    console.log(`[pvp] buff: ${buffs.map((b) => BUFFS[b].title).join(" + ")}`);
  }

  private startBuff(b: BuffId, now: number): void {
    const alive = this.alivePlayers();
    switch (b) {
      case "builder":
        for (const p of alive) {
          p.dirt += BUILDER_BONUS;
          this.sendYou(p);
        }
        break;
      case "lava":
        this.lavaY = 0;
        this.nextLavaRise = now + this.timings.lavaRiseMs;
        this.broadcast({ t: "lava", y: 0 });
        break;
      case "bounty":
        this.setBounty(this.leader(alive));
        break;
      case "potato":
        this.nextBombAt = now;
        break;
      case "meteors":
        this.nextMeteorAt = now + Math.min(1000, this.timings.meteorMs);
        break;
      case "swap":
        this.nextSwapAt = now + this.swapWarn() + 500;
        this.swapWarned = false;
        break;
      case "bows":
        for (const p of alive) {
          p.arrows = BOW_ARROWS;
          this.sendYou(p);
        }
        break;
    }
  }

  private endBuff(b: BuffId): void {
    switch (b) {
      case "lava":
        this.lavaY = -1;
        this.broadcast({ t: "lava", y: -1 });
        break;
      case "bounty":
        this.setBounty(null);
        break;
      case "potato":
        this.nextBombAt = 0;
        this.giveBomb(null, Date.now());
        break;
      case "meteors":
        this.nextMeteorAt = 0;
        break;
      case "swap":
        this.nextSwapAt = 0;
        break;
      case "giants":
        this.sizes.clear();
        for (const p of this.participants()) this.resize(p, 1);
        this.broadcastRoster();
        break;
      case "bows":
        for (const p of this.participants()) {
          if (!p.arrows) continue;
          p.arrows = 0;
          this.sendYou(p);
        }
        break;
    }
  }

  /** Giants buff: half the players grow, the others shrink. */
  private assignSizes(): void {
    const ps = shuffle(this.participants());
    const big = Math.ceil(ps.length / 2);
    ps.forEach((p, i) => {
      const size = i < big ? GIANT_SIZE : SMALL_SIZE;
      this.sizes.set(p.id, size);
      this.resize(p, size);
    });
    this.broadcastRoster();
  }

  /** New size: health scales with the new maximum. */
  private resize(p: Client, size: number): void {
    const old = p.maxHp;
    p.size = size;
    p.maxHp = sizeStats(size).maxHp + p.bonusHp;
    if (p.alive) p.hp = Math.max(1, Math.min(p.maxHp, Math.round((p.hp * p.maxHp) / old)));
    this.sendYou(p);
  }

  /** The best player alive by kills, then damage (ties drawn by lot). */
  private leader(alive: Client[]): Client | null {
    return shuffle(alive).sort((a, b) => b.kills - a.kills || b.stats.damage - a.stats.damage)[0] ?? null;
  }

  private setBounty(c: Client | null): void {
    this.bountyId = c?.id ?? null;
    this.broadcast({ t: "bounty", id: this.bountyId });
    if (c) this.callout("ОХОТА ЗА ГОЛОВОЙ", `Цель — ${c.name}`, BUFFS.bounty.color);
  }

  private giveBomb(holder: Client | null, now: number, from = 0, until = now + this.timings.bombMs): void {
    this.bomb = holder ? { holder, until, from, at: now } : null;
    this.broadcast({ t: "bomb", holder: holder?.id ?? null, ms: holder ? Math.max(0, until - now) : 0 });
  }

  private sameTeam(a: Client, b: Client): boolean {
    return a !== b && a.team !== null && a.team === b.team && MODES[this.mode].teams !== null;
  }

  private checkRoundEnd(): void {
    if (this.phase !== "playing" && this.phase !== "countdown") return;
    if (!MODES[this.mode].respawn) {
      const alive = this.alivePlayers();
      if (alive.length <= 1) this.endRound(alive[0] ?? null, false);
      return;
    }
    const ps = this.participants();
    if (ps.length <= 1) return this.endRound(ps[0] ?? null, false);
    if (this.mode === "teams") {
      const left = [0, 1].filter((k) => ps.some((p) => p.team === k));
      if (left.length === 1) this.endTeam(left[0], false);
    } else if (this.mode === "infection") {
      const humans = ps.filter((p) => p.team === 0);
      if (!humans.length) return this.endTeam(1, false);
      if (!ps.some((p) => p.team === 1)) {
        // The zombies all left: someone has to start the outbreak again.
        const zero = humans[Math.floor(Math.random() * humans.length)];
        zero.team = 1;
        this.callout("НУЛЕВОЙ ПАЦИЕНТ", `${zero.name} теперь зомби`, MODES.infection.color);
        this.broadcastRoster();
        this.sendScore(true);
        if (humans.length === 1) this.endTeam(1, false);
      }
    }
  }

  /** A team won: its best player takes the crown. */
  private endTeam(team: number, onPoints: boolean): void {
    const mates = this.participants().filter((p) => p.team === team);
    const best = shuffle(mates).sort((a, b) => Number(b.alive) - Number(a.alive) || b.kills - a.kills || b.stats.damage - a.stats.damage)[0] ?? null;
    this.endRound(best, onPoints, team);
  }

  private endRound(winner: Client | null, onPoints: boolean, team: number | null = null): void {
    if (this.phase === "ended") return;
    this.winner = winner;
    this.winTeam = team;
    this.pointsWin = onPoints;
    const ps = this.participants();
    for (const c of ps) {
      c.alive = false;
      c.respawnAt = 0;
    }
    this.closeVote();
    this.setPhase("ended");
    this.lastResults = this.results(ps, winner, onPoints, team);
    this.broadcast({ t: "results", r: this.lastResults });
    if (winner?.name) this.records.addWin(winner.name);
    for (const p of ps) if (p.name) this.records.addKills(p.name, p.kills);
    this.recordsDirty = true;
    this.crownId = winner?.id ?? null;
    const teamDef = team !== null ? MODES[this.mode].teams?.[team] : undefined;
    if (teamDef) this.notice(`${teamDef.name} победили! Корону получает ${winner?.name ?? "—"}`, teamDef.color);
    else if (winner) this.notice(`${winner.name} победил в раунде и получает корону!`, "#ffde59");
    this.broadcastRoster();
    for (const c of this.named()) this.sendYou(c);
  }

  private results(ps: Client[], winner: Client | null, onPoints: boolean, team: number | null): RoundResult {
    const order = [...(winner ? [winner.id] : []), ...[...this.deaths].reverse()];
    const place = (c: Client) => {
      const i = order.indexOf(c.id);
      return i < 0 ? order.length : i;
    };
    const won = (c: Client) => Number(c === winner) * 2 + Number(team !== null && c.team === team);
    const sorted = MODES[this.mode].respawn
      ? [...ps].sort((a, b) => won(b) - won(a) || b.score - a.score || b.kills - a.kills || b.stats.damage - a.stats.damage)
      : [...ps].sort((a, b) => place(a) - place(b));
    const rows = sorted.map((c) => ({
      id: c.id,
      name: c.name ?? "?",
      color: c.color,
      kills: c.kills,
      damage: c.stats.damage,
      crits: c.stats.crits,
      blocks: c.stats.blocks,
      score: c.score,
      team: c.team,
    }));
    const awards: RoundResult["awards"] = [];
    const teamDef = team !== null ? MODES[this.mode].teams?.[team] : undefined;
    if (winner) {
      const value =
        this.mode === "koth"
          ? plural(winner.score, "очко", "очка", "очков")
          : teamDef
            ? `${teamDef.name} победили`
            : onPoints
              ? "лучший по очкам в овертайме"
              : "последний выживший";
      awards.push({ title: "Победитель", name: winner.name ?? "?", color: winner.color, value });
    }
    const best = (key: "kills" | "damage" | "crits" | "blocks", min: number, title: string, value: (n: number) => string) => {
      const top = rows.reduce<(typeof rows)[number] | null>((a, r) => (r[key] >= min && (!a || r[key] > a[key]) ? r : a), null);
      if (top) awards.push({ title, name: top.name, color: top.color, value: value(top[key]) });
    };
    best("kills", 1, this.mode === "infection" ? "Главный заразитель" : "Убийца", (n) => plural(n, "убийство", "убийства", "убийств"));
    best("damage", 1, "Мясник", (n) => `${n} урона`);
    best("crits", 1, "Король критов", (n) => plural(n, "крит", "крита", "критов"));
    best("blocks", 5, "Главный строитель", (n) => plural(n, "блок", "блока", "блоков"));
    return { mode: this.mode, winner: winner?.id ?? null, winnerName: winner?.name ?? null, pointsWin: onPoints, team, rows, awards };
  }

  /** Overtime ran out: the best survivor by kills, then damage, then health (ties drawn by lot). */
  private bestOnPoints(alive: Client[]): Client | null {
    return shuffle(alive).sort((a, b) => b.kills - a.kills || b.stats.damage - a.stats.damage || b.hp - a.hp)[0] ?? null;
  }

  private eliminate(victim: Client, killer: Client | null, reason: KillReason): void {
    if (!victim.alive && reason !== "leave") return;
    const now = Date.now();
    const streak = victim.kills;
    victim.alive = false;
    victim.hp = 0;
    victim.arrows = 0;
    this.deaths.push(victim.id);
    if (killer && (killer === victim || this.sameTeam(killer, victim) || killer.role !== "player")) killer = null;
    if (killer) killer.kills++;
    // A bag that fell off the island is gone with its owner.
    if (victim.dirt > 0 && reason !== "fall") {
      const bag: BagInfo = { id: this.nextBagId++, x: r2(victim.x), y: this.groundBelow(this.arena, victim.x, victim.y, victim.z), z: r2(victim.z), dirt: victim.dirt };
      this.bags.set(bag.id, bag);
      this.sendTo(this.viewers("arena"), { t: "bags", bags: [...this.bags.values()] });
    }
    victim.dirt = 0;
    const playing = reason !== "leave";
    if (MODES[this.mode].respawn && playing) {
      victim.respawnAt = now + this.timings.respawnMs;
      victim.bonusHp = 0;
    }
    if (this.mode === "teams" && victim.team !== null && playing) this.teamKills[1 - victim.team]++;
    const infected = this.mode === "infection" && victim.team === 0 && playing;
    if (infected) victim.team = 1;
    this.broadcast({ t: "kill", victim: victim.id, killer: killer?.id ?? null, reason });
    if (killer) this.killCallout(killer, victim, streak, now);
    if (killer?.alive && this.has("vampire")) {
      killer.bonusHp = Math.min(VAMPIRE_MAX_BONUS, killer.bonusHp + VAMPIRE_BONUS);
      killer.maxHp = sizeStats(killer.size).maxHp + killer.bonusHp;
      killer.hp = killer.maxHp;
      this.sendYou(killer);
    }
    if (victim.id === this.bountyId) {
      if (killer?.alive) {
        killer.dirt += BOUNTY_DIRT;
        killer.hp = killer.maxHp;
        this.sendYou(killer);
        this.bountyId = killer.id;
        this.broadcast({ t: "bounty", id: killer.id });
        this.callout("ГОЛОВА СНЯТА", `${killer.name} получает награду и становится целью`, BUFFS.bounty.color);
      } else {
        this.setBounty(this.leader(this.alivePlayers()));
      }
    }
    if (this.bomb?.holder === victim && reason !== "boom") {
      const alive = this.alivePlayers();
      const next = killer?.alive ? killer : alive[Math.floor(Math.random() * alive.length)];
      this.giveBomb(next ?? null, now, 0, this.bomb.until);
    }
    if (infected) {
      const humans = this.participants().filter((p) => p.team === 0);
      if (humans.length === 1) this.callout("ПОСЛЕДНИЙ ВЫЖИВШИЙ", `${humans[0].name} против всех`, MODES.infection.teams?.[0].color ?? "#facc15");
    }
    this.broadcastRoster();
    if (victim.ws.readyState === WebSocket.OPEN) this.sendYou(victim);
    if (MODES[this.mode].respawn) this.sendScore(true);
    this.checkRoundEnd();
    if (this.mode === "teams" && playing && this.phase === "playing") {
      const lead = this.teamKills[0] === this.teamKills[1] ? -1 : this.teamKills[0] > this.teamKills[1] ? 0 : 1;
      if (lead >= 0 && (this.overtime || this.teamKills[lead] >= this.teamGoal)) this.endTeam(lead, false);
    }
  }

  /** Back into the round (respawn modes): a free spot away from enemies, a fresh body. */
  private respawn(c: Client): void {
    c.respawnAt = 0;
    if (c.loc !== "arena") {
      this.leaveActivities(c);
      c.loc = "arena";
      c.hubSpot = null;
      this.send(c, { t: "world", w: "arena", blocks: this.arena.vox.toQuads() });
      this.send(c, { t: "bags", bags: [...this.bags.values()] });
      this.sendRoundState(c);
    }
    c.watching = false;
    const s = this.respawnSpot(c);
    Object.assign(c, { alive: true, bonusHp: 0, dirt: RESPAWN_DIRT, arrows: this.has("bows") ? BOW_ARROWS : 0, lastHitBy: 0, lastHitAt: 0, lastDamageAt: 0, nextRegenAt: 0 });
    c.maxHp = sizeStats(c.size).maxHp;
    c.hp = c.maxHp;
    this.relocate(c, s);
    this.teleport(c, s.yaw);
    this.sendYou(c);
    this.broadcastRoster();
  }

  private respawnSpot(c: Client): Spot {
    const r = Math.max(3, this.floorR - 2);
    const enemies = this.alivePlayers().filter((o) => o !== c && !this.sameTeam(o, c));
    let best: Spot | null = null;
    let bestFar = -1;
    for (let i = 0; i < 30; i++) {
      const teamSide = this.mode === "teams" && c.team !== null;
      const a = teamSide ? this.teamAngle(c.team ?? 0, this.teamOffset) + (Math.random() - 0.5) * 1.4 : Math.random() * Math.PI * 2;
      const d = teamSide ? r * (0.5 + Math.random() * 0.45) : Math.sqrt(Math.random()) * r;
      const x = r2(Math.cos(a) * d);
      const z = r2(Math.sin(a) * d);
      const y = this.standAt(x, z);
      if (y === null) continue;
      const far = Math.min(40, ...enemies.map((o) => Math.hypot(o.x - x, o.z - z)));
      if (far > bestFar) {
        bestFar = far;
        best = { x, y, z, yaw: Math.atan2(x, z) };
      }
    }
    return best ?? { x: 0.5, y: this.standAt(0.5, 0.5) ?? 0, z: 0.5, yaw: 0 };
  }

  /** Top of the highest block in a column, or 0 (the floor's level). */
  private columnTop(x: number, z: number): number {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    for (let y = MAX_HEIGHT - 1; y >= 0; y--) if (this.arena.vox.get(ix, y, iz)) return y + 1;
    return 0;
  }

  /** Where a player could stand at x, z: on the highest block under its feet, or on the floor.
   *  Null over the abyss or right under the ceiling. */
  private standAt(x: number, z: number): number | null {
    const hw = PLAYER_HALF_WIDTH;
    const cells = [
      [x - hw, z - hw],
      [x + hw, z - hw],
      [x - hw, z + hw],
      [x + hw, z + hw],
    ].map(([a, b]) => [Math.floor(a), Math.floor(b)]);
    const y = Math.max(...cells.map(([cx, cz]) => this.columnTop(cx, cz)));
    if (y === 0 && !cells.every(([cx, cz]) => this.arena.vox.solid(cx, -1, cz))) return null;
    return y + PLAYER_HEIGHT + 1 >= MAX_HEIGHT ? null : y;
  }

  /** Whoever hit this player within FALL_CREDIT_MS: falls, lava and blasts are their kills. */
  private recentHitter(c: Client, now: number): Client | null {
    if (now - c.lastHitAt > FALL_CREDIT_MS) return null;
    const by = this.clients.get(c.lastHitBy);
    return by && by !== c && by.role === "player" ? by : null;
  }

  /** Off the island: out of the round, and a kill for whoever knocked them off. */
  private fallOut(c: Client, now: number): void {
    this.eliminate(c, this.recentHitter(c, now), "fall");
  }

  /** First blood, kill streaks and ended streaks get a big announcement over the arena. */
  private killCallout(killer: Client, victim: Client, victimKills: number, now: number): void {
    const k = killer.name ?? "?";
    const v = victim.name ?? "?";
    const quick = now - killer.lastKillAt < MULTI_KILL_MS;
    killer.lastKillAt = now;
    if (!this.firstBlood) {
      this.firstBlood = true;
      return this.callout("ПЕРВАЯ КРОВЬ", `${k} → ${v}`, "#ef4444");
    }
    const streak = STREAKS[killer.kills];
    if (streak) return this.callout(streak, `${k} · ${plural(killer.kills, "убийство", "убийства", "убийств")}`, "#fb923c");
    if (victimKills >= HOT_STREAK && !MODES[this.mode].respawn) return this.callout("СЕРИЯ ПРЕРВАНА", `${k} остановил ${v}`, "#facc15");
    if (quick) this.callout("ДВОЙНОЕ УБИЙСТВО", k, "#f472b6");
  }

  private callout(text: string, sub: string, color: string): void {
    this.sendTo(this.viewers("arena"), { t: "callout", text, sub, color });
  }

  private scoreMsg(): ServerMsg {
    const ps = this.participants();
    const teams = this.mode === "teams" ? [...this.teamKills] : this.mode === "infection" ? [0, 1].map((k) => ps.filter((p) => p.team === k).length) : [];
    const target = this.mode === "teams" ? this.teamGoal : this.mode === "koth" ? HILL_TARGET : 0;
    return { t: "score", teams, target, hill: this.hill, contested: this.contested };
  }

  private sendScore(force = false): void {
    const now = Date.now();
    if (!force && now - this.scoreSentAt < 250) return;
    this.scoreSentAt = now;
    this.sendTo(this.viewers("arena"), this.scoreMsg());
  }

  /** What a player who starts watching (or comes back) mid-round needs to know. */
  private sendRoundState(c: Client): void {
    if (this.phase !== "playing" && this.phase !== "countdown") return;
    if (this.lavaY >= 0) this.send(c, { t: "lava", y: this.lavaY });
    if (this.bountyId !== null) this.send(c, { t: "bounty", id: this.bountyId });
    if (this.bomb) this.send(c, { t: "bomb", holder: this.bomb.holder.id, ms: Math.max(0, this.bomb.until - Date.now()) });
    if (MODES[this.mode].respawn) this.send(c, this.scoreMsg());
  }

  private groundBelow(world: GameWorld, x: number, y: number, z: number): number {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    for (let iy = Math.min(MAX_HEIGHT - 1, Math.floor(y)); iy >= 0; iy--) {
      if (world.vox.get(ix, iy, iz)) return iy + 1;
    }
    return 0;
  }

  private tick(): void {
    const now = Date.now();
    // A late tick means the event loop was blocked: every player feels that as lag.
    const late = now - this.lastTickAt - TICK_MS;
    this.lastTickAt = now;
    if (late >= 200 && this.clients.size > 0 && now - this.stallLoggedAt >= 10_000) {
      this.stallLoggedAt = now;
      console.warn(`[pvp] server stalled for ${late} ms (event loop blocked: dev mode, CPU overload or swapping?)`);
    }
    this.roundTick(now);
    this.hubTick(now);
    this.sendTicks(now);
    if (this.rosterDirty && now - this.rosterSentAt >= 200) this.broadcastRoster();
    if (now - this.lastSweep >= 10_000) {
      this.lastSweep = now;
      if (this.records.checkDay()) this.recordsDirty = true;
      this.records.flush();
    }
    if (this.recordsDirty && now - this.recordsSentAt >= 1000) {
      this.recordsDirty = false;
      this.recordsSentAt = now;
      this.broadcast({ t: "records", r: this.records.snapshot() });
    }
  }

  private roundTick(now: number): void {
    const elapsed = now - this.phaseStart;
    const t = this.timings;
    if (this.phase === "countdown" && elapsed >= t.countdownMs) {
      this.setPhase("playing");
      return;
    }
    if (this.phase === "ended" && elapsed >= t.endMs) {
      this.toLobby();
      return;
    }
    if (this.phase !== "playing") return;

    const target = buffIndexAt(elapsed, t, this.buffPlan.length);
    while (this.buffIndex < target) this.activateBuff(this.buffIndex + 1, now);
    this.voteTick(elapsed, now);

    const next = this.buffIndex + 1;
    if (next < this.buffPlan.length && this.rouletteIndex < next) {
      const at = buffAt(next, t);
      if (at - elapsed <= Math.min(ROULETTE_MS, t.buffIntervalMs / 2)) {
        this.closeVote(next);
        this.rouletteIndex = next;
        this.broadcast({ t: "roulette", buffs: this.buffPlan[next], ms: at - elapsed });
      }
    }

    this.crumbleTick(elapsed, now);
    this.eventsTick(elapsed, now);
    if (this.phase !== "playing") return;

    // регенерация: 4 секунды без урона → +1 hp (полсердца) в секунду; в овертайме её нет
    for (const p of this.overtime ? [] : this.alivePlayers()) {
      if (p.hp <= 0 || p.hp >= p.maxHp || now - p.lastDamageAt < REGEN_DELAY_MS) continue;
      if (now >= p.nextRegenAt) {
        p.hp = Math.min(p.maxHp, p.hp + REGEN_HP);
        p.nextRegenAt = now + REGEN_INTERVAL_MS;
        this.sendYou(p);
      }
    }

    this.pickupBags();
    for (const p of this.alivePlayers()) this.expireCredits(p, now);
    if (MODES[this.mode].respawn) for (const p of this.participants()) if (!p.alive && p.respawnAt && now >= p.respawnAt) this.respawn(p);
    this.hillTick(now);
    if (this.phase !== "playing") return;

    // A client that stopped reporting on its way down doesn't get to hang under the island.
    for (const p of this.alivePlayers()) if (p.alive && p.y < 0 && now - p.lastMoveAt > STALE_FALL_MS) this.fallOut(p, now);
    if (this.phase !== "playing") return;

    if (elapsed >= t.roundMs) {
      if (this.mode === "infection") return this.endTeam(0, false);
      if (this.mode === "koth") {
        const top = shuffle(this.participants()).sort((a, b) => b.score - a.score || b.kills - a.kills)[0] ?? null;
        return this.endRound(top, false);
      }
      if (this.mode === "teams" && this.teamKills[0] !== this.teamKills[1]) return this.endTeam(this.teamKills[0] > this.teamKills[1] ? 0 : 1, false);
      if (!this.overtime) {
        this.overtime = true;
        const sub =
          this.mode === "teams"
            ? "Следующее убийство решает исход"
            : MODES[this.mode].noDamage
              ? "Остров рушится!"
              : "Любой удар убивает · регенерации нет · остров рушится";
        this.callout("ОВЕРТАЙМ", sub, "#ef4444");
      }
    }
    if (elapsed >= t.roundMs + t.overtimeMs) {
      if (this.mode === "teams") {
        const dmg = [0, 1].map((k) => this.participants().reduce((n, p) => n + (p.team === k ? p.stats.damage : 0), 0));
        return this.endTeam(dmg[0] === dmg[1] ? Math.floor(Math.random() * 2) : dmg[0] > dmg[1] ? 0 : 1, true);
      }
      const alive = this.alivePlayers();
      this.endRound(this.bestOnPoints(alive), alive.length > 1);
    }
  }

  /** Lava, the bomb, meteors, swaps and arrows. */
  private eventsTick(elapsed: number, now: number): void {
    const t = this.timings;
    if (this.lavaY >= 0) {
      if (this.lavaY < LAVA_MAX && now >= this.nextLavaRise) {
        this.lavaY++;
        this.nextLavaRise = now + t.lavaRiseMs;
        this.broadcast({ t: "lava", y: this.lavaY });
      }
      if (now - this.lastLava >= LAVA_INTERVAL_MS) {
        this.lastLava = now;
        for (const p of this.alivePlayers()) {
          if (p.y > this.lavaY + 0.05) continue;
          p.hp -= 1;
          p.lastDamageAt = now;
          p.nextRegenAt = 0;
          this.sendTo(this.viewers("arena"), { t: "hurt", id: p.id, by: 0, hp: p.hp, dmg: 1, crit: false, kx: 0, ky: 0, kz: 0, kn: 0 });
          if (p.hp <= 0) this.eliminate(p, this.recentHitter(p, now), "lava");
          else this.sendYou(p);
          if (this.phase !== "playing") return;
        }
      }
    }

    if (this.bomb && now >= this.bomb.until) {
      const { holder, from } = this.bomb;
      this.giveBomb(null, now);
      const passer = this.clients.get(from);
      this.explode(holder.x, holder.y + 0.9, holder.z, BOMB_RADIUS, BOMB_DAMAGE, BOMB_BLOCKS, "bomb", passer && passer !== holder ? passer : null, now, holder);
      if (this.phase !== "playing") return;
      const end = this.buffIndex + 1 < this.buffPlan.length ? buffAt(this.buffIndex + 1, t) : t.roundMs + t.overtimeMs;
      if (this.has("potato") && end - elapsed > t.bombMs * 0.6) this.nextBombAt = now + t.bombMs * 0.15;
    }
    if (!this.bomb && this.nextBombAt && now >= this.nextBombAt && this.has("potato")) {
      this.nextBombAt = 0;
      const alive = this.alivePlayers();
      const p = alive[Math.floor(Math.random() * alive.length)];
      if (p) {
        this.giveBomb(p, now);
        this.callout("ГОРЯЧАЯ КАРТОШКА", `Бомба у ${p.name}! Ударь соперника, чтобы передать`, BUFFS.potato.color);
      }
    }

    if (this.nextMeteorAt && now >= this.nextMeteorAt && this.has("meteors")) {
      this.nextMeteorAt = now + t.meteorMs;
      const alive = this.alivePlayers();
      const n = Math.max(1, Math.round(alive.length * 0.6));
      for (let i = 0; i < n; i++) {
        const near = alive.length && Math.random() < 0.6 ? alive[Math.floor(Math.random() * alive.length)] : null;
        let x: number;
        let z: number;
        if (near) {
          x = near.x + (Math.random() - 0.5) * 4;
          z = near.z + (Math.random() - 0.5) * 4;
        } else {
          const a = Math.random() * Math.PI * 2;
          const d = Math.sqrt(Math.random()) * this.floorR * 0.9;
          x = Math.cos(a) * d;
          z = Math.sin(a) * d;
        }
        const m = { id: this.nextMeteorId++, x: r2(x), y: this.columnTop(x, z), z: r2(z), at: now + METEOR_WARN_MS };
        this.meteors.push(m);
        this.sendTo(this.viewers("arena"), { t: "meteor", id: m.id, x: m.x, y: m.y, z: m.z, r: METEOR_RADIUS, ms: METEOR_WARN_MS });
      }
    }
    if (this.meteors.length) {
      const landed = this.meteors.filter((m) => now >= m.at);
      this.meteors = this.meteors.filter((m) => now < m.at);
      for (const m of landed) {
        this.explode(m.x, m.y + 0.3, m.z, METEOR_RADIUS, METEOR_DAMAGE, METEOR_BLOCKS, "meteor", null, now);
        if (this.phase !== "playing") return;
      }
    }

    if (this.nextSwapAt && this.has("swap")) {
      if (!this.swapWarned && now >= this.nextSwapAt - this.swapWarn()) {
        this.swapWarned = true;
        this.callout("ОБМЕН", "Через 3 секунды все поменяются местами!", BUFFS.swap.color);
      }
      if (now >= this.nextSwapAt) {
        this.swapWarned = false;
        this.nextSwapAt = now + t.swapMs;
        this.swapPlaces();
      }
    }

    this.stepArrows(now);
  }

  private swapWarn(): number {
    return Math.min(SWAP_WARN_MS, this.timings.swapMs / 3);
  }

  /** Everyone alive moves to where someone else stood (never their own spot), keeping their view. */
  private swapPlaces(): void {
    const ps = shuffle(this.alivePlayers());
    if (ps.length < 2) return;
    const spots = ps.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    ps.forEach((p, i) => {
      Object.assign(p, spots[(i + 1) % ps.length]);
      p.seenAt = [];
      this.teleport(p);
    });
    this.callout("ОБМЕН!", "Где это я?", BUFFS.swap.color);
  }

  /** A blast: damage and knockback falling off with distance, blocks around it gone. `doomed`
   *  (the bomb's holder) dies whatever the mode. */
  private explode(x: number, y: number, z: number, r: number, maxDmg: number, blockR: number, kind: "bomb" | "meteor", credit: Client | null, now: number, doomed: Client | null = null): void {
    this.sendTo(this.viewers("arena"), { t: "boom", x: r2(x), y: r2(y), z: r2(z), r, kind });
    const noDamage = MODES[this.mode].noDamage;
    for (const p of this.alivePlayers()) {
      const d = Math.hypot(p.x - x, p.y + 0.9 - y, p.z - z);
      if (p !== doomed && d > r) continue;
      const k = p === doomed ? 1 : 1 - d / r;
      const dmg = p === doomed ? p.hp : noDamage ? 0 : Math.min(p.hp, Math.max(1, Math.round(maxDmg * k)));
      const len = Math.hypot(p.x - x, p.z - z) || 1;
      const push = (4 + 8 * k) * sizeStats(p.size).knockback;
      const kx = r2(((p.x - x) / len) * push);
      const kz = r2(((p.z - z) / len) * push);
      const ky = r2(5 + 4 * k);
      p.hp -= dmg;
      if (dmg) {
        p.lastDamageAt = now;
        p.nextRegenAt = 0;
      }
      if (credit && credit !== p) {
        p.lastHitBy = credit.id;
        p.lastHitAt = now;
      }
      const alive = p.hp > 0;
      if (alive) p.motion.credits.push(knockbackCredit(now, ++p.kbSeq, kx, ky, kz));
      this.sendTo(this.viewers("arena"), { t: "hurt", id: p.id, by: 0, hp: p.hp, dmg, crit: false, kx, ky, kz, kn: alive ? p.kbSeq : 0 });
      if (!alive) this.eliminate(p, this.recentHitter(p, now), "boom");
      else this.sendYou(p);
      if (this.phase !== "playing") return;
    }
    const w = this.arena;
    for (let bx = Math.floor(x - blockR); bx <= Math.floor(x + blockR); bx++)
      for (let by = Math.max(0, Math.floor(y - blockR)); by <= Math.floor(y + blockR); by++)
        for (let bz = Math.floor(z - blockR); bz <= Math.floor(z + blockR); bz++) {
          if (Math.hypot(bx + 0.5 - x, by + 0.5 - y, bz + 0.5 - z) > blockR) continue;
          if (w.vox.get(bx, by, bz)) this.setBlock(w, bx, by, bz, 0, now);
        }
  }

  private stepArrows(now: number): void {
    if (!this.arenaArrows.size) return;
    const dt = TICK_MS / 1000;
    for (const a of [...this.arenaArrows.values()]) {
      const from = { x: a.x, y: a.y, z: a.z };
      a.vy -= ARROW_GRAVITY * dt;
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.z += a.vz * dt;
      const owner = this.clients.get(a.owner) ?? null;
      let hit: Client | null = null;
      let stuck = false;
      for (let k = 1; k <= 6 && !hit && !stuck; k++) {
        const f = k / 6;
        const q = { x: from.x + (a.x - from.x) * f, y: from.y + (a.y - from.y) * f, z: from.z + (a.z - from.z) * f };
        if (this.arena.vox.solid(Math.floor(q.x), Math.floor(q.y), Math.floor(q.z))) {
          stuck = true;
          break;
        }
        for (const p of this.alivePlayers()) {
          if (p.id === a.owner || (owner && this.sameTeam(owner, p))) continue;
          const hw = PLAYER_HALF_WIDTH * p.size + 0.1;
          if (Math.abs(q.x - p.x) <= hw && Math.abs(q.z - p.z) <= hw && q.y >= p.y - 0.1 && q.y <= p.y + PLAYER_HEIGHT * p.size + 0.1) {
            hit = p;
            break;
          }
        }
      }
      if (hit) {
        this.arenaArrows.delete(a.id);
        this.arrowHit(a, owner, hit, now);
        if (this.phase !== "playing") return;
      } else if (stuck || now - a.bornAt > ARROW_LIFE_MS || a.y < FALL_OUT_Y) {
        this.arenaArrows.delete(a.id);
      }
    }
  }

  private arrowHit(a: { vx: number; vz: number }, owner: Client | null, t: Client, now: number): void {
    const lethal = this.overtime || buffModifiers(this.currentBuffs, this.mode).damage >= MAX_HP;
    const dmg = MODES[this.mode].noDamage ? 0 : lethal ? t.hp : Math.min(t.hp, ARROW_DAMAGE);
    t.hp -= dmg;
    if (dmg) {
      t.lastDamageAt = now;
      t.nextRegenAt = 0;
    }
    if (owner) {
      t.lastHitBy = owner.id;
      t.lastHitAt = now;
      owner.stats.damage += dmg;
    }
    const len = Math.hypot(a.vx, a.vz) || 1;
    const kb = 5 * buffModifiers(this.currentBuffs, this.mode, t.size).knockback;
    const kx = r2((a.vx / len) * kb);
    const kz = r2((a.vz / len) * kb);
    const ky = 4;
    const alive = t.hp > 0;
    if (alive) t.motion.credits.push(knockbackCredit(now, ++t.kbSeq, kx, ky, kz));
    this.sendTo(this.viewers("arena"), { t: "hurt", id: t.id, by: owner?.id ?? 0, hp: t.hp, dmg, crit: false, kx, ky, kz, kn: alive ? t.kbSeq : 0, arrow: true });
    if (!alive) return this.eliminate(t, owner, "kill");
    this.sendYou(t);
  }

  private onShoot(c: Client, m: Extract<ClientMsg, { t: "shoot" }>, now: number): void {
    if (!finite(m.yaw, m.pitch, m.tk)) return this.flag(c, "packet", 1, "malformed shot");
    if (this.phase !== "playing" || c.loc !== "arena" || !c.alive || c.arrows <= 0 || !c.motion.synced) return;
    if (now - c.lastShotAt < SHOOT_COOLDOWN_MS) return;
    c.lastShotAt = now;
    c.lastAttackAt = now;
    c.arrows--;
    c.yaw = m.yaw;
    c.pitch = clampPitch(m.pitch);
    const d = lookDir(c.yaw, c.pitch);
    const eye = { x: c.x, y: c.y + EYE_HEIGHT * c.size, z: c.z };
    const id = this.nextArrowId++;
    this.arenaArrows.set(id, { id, x: eye.x + d.x * 0.5, y: eye.y + d.y * 0.5, z: eye.z + d.z * 0.5, vx: d.x * ARROW_SPEED, vy: d.y * ARROW_SPEED, vz: d.z * ARROW_SPEED, owner: c.id, bornAt: now });
    this.sendYou(c);
  }

  /** King of the Hill: alone on the hill, a point every hillPointMs. */
  private hillTick(now: number): void {
    if (this.mode !== "koth" || now < this.nextHillAt) return;
    this.nextHillAt = now + this.timings.hillPointMs;
    const on = this.alivePlayers().filter((p) => Math.hypot(p.x, p.z) <= HILL_RADIUS && p.y < 6);
    const holder = on.length === 1 ? on[0] : null;
    const changed = (holder?.id ?? null) !== this.hill || this.contested !== on.length > 1;
    this.hill = holder?.id ?? null;
    this.contested = on.length > 1;
    if (holder) {
      holder.score++;
      this.rosterDirty = true;
    }
    if (holder || changed) this.sendScore(true);
    if (holder && holder.score >= HILL_TARGET) this.endRound(holder, false);
  }

  // ---------------------------------------------------------------- buff vote

  /** Eliminated players (elimination modes only) pick the next buff out of three. */
  private voters(): Client[] {
    return MODES[this.mode].respawn ? [] : this.participants().filter((p) => !p.alive);
  }

  private voteTick(elapsed: number, now: number): void {
    const t = this.timings;
    const next = this.buffIndex + 1;
    if (!this.vote && next < this.buffPlan.length && this.buffPlan[next].length === 1 && this.voters().length) {
      const opensAt = next > 0 ? buffAt(next - 1, t) + Math.min(VOTE_DELAY_MS, t.buffIntervalMs / 4) : 0;
      const closesAt = buffAt(next, t) - Math.min(ROULETTE_MS, t.buffIntervalMs / 2);
      if (elapsed >= opensAt && closesAt - elapsed > 1500) {
        const used = new Set(this.buffPlan.flat());
        const others = shuffle(this.buffPool.filter((b) => !used.has(b))).slice(0, 2);
        if (others.length) {
          this.vote = { slot: next, options: shuffle([this.buffPlan[next][0], ...others]), until: this.phaseStart + closesAt, sentAt: 0 };
          for (const p of this.participants()) p.buffVote = null;
        }
      }
    }
    if (this.vote && now - this.vote.sentAt >= 1000) this.sendVote();
  }

  private sendVote(): void {
    const v = this.vote;
    if (!v) return;
    const now = Date.now();
    v.sentAt = now;
    const vs = this.voters();
    const votes = v.options.map((_, i) => vs.filter((p) => p.buffVote === i).length);
    for (const p of vs) this.send(p, { t: "buffVote", options: v.options, votes, ms: Math.max(0, v.until - now), mine: p.buffVote });
  }

  /** At the roulette the most voted option takes the slot (ties drawn by lot; no votes: as planned). */
  private closeVote(slot?: number): void {
    const v = this.vote;
    if (!v) return;
    this.vote = null;
    if (slot === v.slot) {
      const vs = this.voters();
      const votes = v.options.map((_, i) => vs.filter((p) => p.buffVote === i).length);
      const most = Math.max(...votes);
      const top = v.options.filter((_, i) => votes[i] === most);
      if (most > 0) this.buffPlan[slot] = [top[Math.floor(Math.random() * top.length)]];
    }
    this.broadcast({ t: "buffVote", options: [], votes: [], ms: 0, mine: null });
  }

  private onBuffVote(c: Client, i: unknown): void {
    const v = this.vote;
    if (!v || typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= v.options.length || !this.voters().includes(c)) return;
    c.buffVote = i;
    this.sendVote();
  }

  private pickupBags(): void {
    if (!this.bags.size) return;
    let changed = false;
    for (const bag of this.bags.values()) {
      for (const p of this.alivePlayers()) {
        if (Math.hypot(p.x - bag.x, p.z - bag.z) > 1.6 || Math.abs(p.y - bag.y) > 2) continue;
        p.dirt += bag.dirt;
        this.sendYou(p);
        this.bags.delete(bag.id);
        changed = true;
        break;
      }
    }
    if (changed) this.sendTo(this.viewers("arena"), { t: "bags", bags: [...this.bags.values()] });
  }

  // ---------------------------------------------------------------- hub

  private hubTick(now: number): void {
    const walkers = this.hubWalkers();
    for (const c of walkers) {
      this.zones(c, now);
      this.rangeTick(c, now);
      this.expireCredits(c, now);
    }
    for (const e of this.mobs.step(walkers.map((w) => ({ id: w.id, x: w.x, y: w.y, z: w.z })), now)) {
      const c = this.clients.get(e.t === "knocked" ? e.by : e.player);
      if (!c || !this.isWalker(c)) continue;
      if (e.t === "knocked") {
        c.train.knocked++;
        c.trainDirty = true;
        this.hint(c, `Сбит с обрыва! Всего: ${c.train.knocked}`, now, true);
      } else if (e.t === "arrowHit") {
        c.train.arrowHits++;
        c.trainDirty = true;
        this.send(c, { t: "arrowHit" });
        this.hint(c, "Попадание! Двигайся зигзагом и прыгай", now);
      } else {
        c.train.dodged++;
        c.trainDirty = true;
      }
    }
    this.duelTick(now);
    for (const [i, until] of this.hubPlaced) {
      if (now < until) continue;
      this.hubPlaced.delete(i);
      const [x, y, z] = Voxels.decode(i);
      this.setBlock(this.hub, x, y, z, 0, now);
    }
    this.lobbyTick(now);
    for (const c of this.named()) {
      this.sendHub(c, now, false);
      this.sendTrain(c, now);
    }
  }

  /** Ready circle, vote pads, range start and parkour, from where the player stands. */
  private zones(c: Client, now: number): void {
    const grounded = c.y < 1.5;
    const ready = this.phase === "lobby" && grounded && inCircle(c.x, c.z, HUB.ready) && !this.inDuel(c);
    if (ready !== c.ready) {
      c.ready = ready;
      this.rosterDirty = true;
      if (ready && !c.hintsSeen.has("ready")) {
        c.hintsSeen.add("ready");
        this.hint(c, "Ты готов! Когда в круге больше половины игроков, старт через 10 секунд", now, true);
      }
    }
    if (grounded) {
      for (const mode of MODE_IDS) {
        if (c.vote === mode || !inCircle(c.x, c.z, HUB.votes[mode])) continue;
        c.vote = mode;
        this.hint(c, `Твой голос: ${MODES[mode].title}`, now, true);
      }
    }
    if (!c.range && !this.inDuel(c) && c.y < 1 && inCircle(c.x, c.z, HUB.rangeStart)) this.startRange(c, now);
    this.parkourTick(c, now);
  }

  private lobbyTick(now: number): void {
    if (this.phase !== "lobby") {
      this.startAt = null;
      return;
    }
    const active = this.hubWalkers().filter((c) => now - c.lastActiveAt < AFK_MS && !this.inDuel(c));
    if (active.length < MIN_PLAYERS) {
      this.startAt = null;
      return;
    }
    const ready = active.filter((c) => c.ready).length;
    if (this.startAt === null) this.startAt = now + this.timings.lobbyMs;
    if (ready >= MIN_PLAYERS && ready * 2 > active.length) this.startAt = Math.min(this.startAt, now + this.timings.readyMs);
    if (now >= this.startAt) {
      this.startAt = null;
      this.startRound(active, now);
    }
  }

  private sendHub(c: Client, now: number, force: boolean): void {
    const walkers = this.hubWalkers();
    const active = walkers.filter((w) => now - w.lastActiveAt < AFK_MS && !this.inDuel(w));
    const votes = MODE_IDS.map((m) => this.named().filter((p) => p.vote === m).length);
    const msg: ServerMsg = {
      t: "hub",
      startIn: this.startAt === null ? null : Math.max(0, this.startAt - now),
      ready: active.filter((w) => w.ready).length,
      active: active.length,
      need: MIN_PLAYERS,
      votes,
      myVote: c.vote,
      inRound: this.alivePlayers().length,
    };
    const key = JSON.stringify({ ...msg, startIn: this.startAt });
    if (!force && key === c.hubKey && now - c.hubSentAt < HUB_REFRESH_MS) return;
    c.hubKey = key;
    c.hubSentAt = now;
    this.send(c, msg);
  }

  private sendTrain(c: Client, now: number): void {
    if (c.dmgLog.length) {
      c.dmgLog = c.dmgLog.filter(([t]) => now - t < 5000);
      const dps = Math.round((c.dmgLog.reduce((s, [, d]) => s + d, 0) / 5) * 10) / 10;
      if (dps !== c.train.dps) {
        c.train.dps = dps;
        c.trainDirty = true;
      }
    } else if (c.train.dps !== 0) {
      c.train.dps = 0;
      c.trainDirty = true;
    }
    if (!c.trainDirty || now - c.trainSentAt < TRAIN_SEND_MS) return;
    c.trainDirty = false;
    c.trainSentAt = now;
    this.send(c, { t: "train", s: { ...c.train } });
  }

  private hint(c: Client, text: string, now: number, force = false): void {
    if (!force && now - c.hintAt < HINT_GAP_MS) return;
    c.hintAt = now;
    this.send(c, { t: "hint", text });
  }

  private notice(text: string, color: string): void {
    this.broadcast({ t: "notice", text, color });
  }

  /** Stops what a player does in the hub before they leave it (round start, watching). */
  private leaveActivities(c: Client): void {
    this.cancelRange(c);
    if (c.parkour.state !== "idle") {
      c.parkour = { state: "idle", startedAt: 0 };
      this.send(c, { t: "parkour", state: "idle", ms: 0, best: c.name ? this.records.personalBest("parkour", c.name) : null });
    }
    c.invite = null;
  }

  // ---- shooting range

  private startRange(c: Client, now: number): void {
    c.range = { state: "countdown", until: now + RANGE_COUNTDOWN_MS, score: 0, target: null, nextSpawnAt: 0 };
    c.lastActiveAt = now;
    this.sendRange(c, now);
  }

  private sendRange(c: Client, now: number, done?: { score: number; best: number }): void {
    const best = c.name ? (this.records.personalBest("range", c.name) ?? 0) : 0;
    if (done) return this.send(c, { t: "range", state: "done", ms: 0, score: done.score, best: done.best });
    const r = c.range;
    if (!r) return this.send(c, { t: "range", state: "idle", ms: 0, score: 0, best });
    this.send(c, { t: "range", state: r.state, ms: Math.max(0, r.until - now), score: r.score, best });
  }

  private cancelRange(c: Client): void {
    const r = c.range;
    if (!r) return;
    if (r.target !== null) this.mobs.remove(r.target);
    c.range = null;
    this.sendRange(c, Date.now());
  }

  private rangeTick(c: Client, now: number): void {
    const r = c.range;
    if (!r) return;
    if (!inCellBox(c.x, c.z, HUB.range, 1)) {
      this.cancelRange(c);
      this.hint(c, "Ты ушёл с поля — тир остановлен", now, true);
      return;
    }
    if (r.state === "countdown") {
      if (now < r.until) return;
      r.state = "running";
      r.until = now + this.rangeMs;
      r.nextSpawnAt = now;
      this.sendRange(c, now);
    }
    if (r.target !== null) {
      const t = this.mobs.mobs.get(r.target);
      if (!t || t.dead || now >= t.expiresAt) {
        this.mobs.remove(r.target);
        r.target = null;
        r.nextSpawnAt = now + 150;
      }
    }
    if (now >= r.until) {
      if (r.target !== null) this.mobs.remove(r.target);
      c.range = null;
      const res = this.records.offer("range", c.name ?? "?", r.score);
      this.recordsDirty = true;
      this.sendRange(c, now, { score: r.score, best: res.best });
      if (res.first && r.score > 0) this.notice(`Рекорд тира за сегодня: ${c.name} — ${r.score}`, "#facc15");
      return;
    }
    if (r.target === null && now >= r.nextSpawnAt) r.target = this.spawnTarget(c, now).id;
  }

  private spawnTarget(c: Client, now: number): Mob {
    const b = HUB.range;
    let spot: Spot = { x: (b.x0 + b.x1 + 1) / 2, y: 0, z: (b.z0 + b.z1 + 1) / 2, yaw: 0 };
    for (let i = 0; i < 20; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = 3 + Math.random() * 4;
      const x = c.x + Math.cos(a) * d;
      const z = c.z + Math.sin(a) * d;
      if (x < b.x0 + 0.5 || x > b.x1 + 0.5 || z < b.z0 + 0.5 || z > b.z1 + 0.5) continue;
      spot = { x, y: 0, z, yaw: yawTowards(x, z, c.x, c.z) };
      break;
    }
    return this.mobs.spawnTarget(c.id, spot, TARGET_TTL_MS, now);
  }

  // ---- parkour

  private parkourTick(c: Client, now: number): void {
    const p = c.parkour;
    const start = HUB.parkourStart;
    const onStart = c.y < 1 && inCircle(c.x, c.z, start);
    const best = () => (c.name ? this.records.personalBest("parkour", c.name) : null);
    const set = (state: ParkourRun["state"], ms = 0) => {
      c.parkour = { state, startedAt: state === "running" ? now : 0 };
      this.send(c, { t: "parkour", state, ms, best: best() });
    };
    if (p.state === "idle") {
      if (onStart && !this.inDuel(c)) set("ready");
      return;
    }
    if (p.state === "ready") {
      if (!onStart) set(c.y < 0.5 && Math.hypot(c.x - start.x, c.z - start.z) > PARKOUR_FALL_DIST ? "idle" : "running");
      return;
    }
    const f = HUB.parkourFinish;
    if (inCellBox(c.x, c.z, f) && c.y >= f.h - 0.05) {
      const ms = now - p.startedAt;
      const res = this.records.offer("parkour", c.name ?? "?", ms);
      this.recordsDirty = true;
      c.parkour = { state: "idle", startedAt: 0 };
      this.send(c, { t: "parkour", state: "done", ms, best: res.best });
      if (res.first) this.notice(`Рекорд паркура за сегодня: ${c.name} — ${(ms / 1000).toFixed(1)} с`, "#facc15");
      return;
    }
    if (onStart) return set("ready");
    if (c.y < 0.5 && Math.hypot(c.x - start.x, c.z - start.z) > PARKOUR_FALL_DIST) {
      set("idle");
      this.hint(c, "Упал! Возвращайся на старт паркура", now, true);
      return;
    }
    if (now - p.startedAt > PARKOUR_MAX_MS) set("idle");
  }

  // ---- duels

  private onDuelInvite(c: Client, id: unknown, now: number): void {
    if (!finite(id) || !this.isWalker(c) || this.inDuel(c) || now - c.invitedAt < 2000) return;
    const t = this.clients.get(id as number);
    if (!t || t === c || !t.name || !this.isWalker(t) || this.inDuel(t)) return;
    c.lastActiveAt = now;
    if (Math.hypot(t.x - c.x, t.z - c.z) > DUEL_RANGE) return this.hint(c, "Подойди ближе, чтобы вызвать на дуэль", now, true);
    if (this.duel) return this.hint(c, "Яма для дуэлей занята — подожди", now, true);
    c.invitedAt = now;
    t.invite = { from: c.id, at: now };
    this.send(t, { t: "duelInvite", from: c.id });
    this.hint(c, `Вызов отправлен: ${t.name}`, now, true);
  }

  private onDuelAnswer(c: Client, accept: boolean, now: number): void {
    const inv = c.invite;
    c.invite = null;
    if (!inv || now - inv.at > INVITE_MS) return;
    const a = this.clients.get(inv.from);
    if (!a || !a.name || !this.isWalker(a) || this.inDuel(a)) return this.hint(c, "Вызов больше не действует", now, true);
    if (!accept) return this.hint(a, `${c.name} отказался от дуэли`, now, true);
    if (!this.isWalker(c) || this.inDuel(c)) return;
    if (this.duel) {
      this.hint(c, "Яма для дуэлей занята — подожди", now, true);
      return this.hint(a, "Яма для дуэлей занята — подожди", now, true);
    }
    this.startDuel(a, c, now);
  }

  private startDuel(a: Client, b: Client, now: number): void {
    this.duel = { a, b, state: "countdown", until: now + DUEL_COUNTDOWN_MS };
    [a, b].forEach((c, i) => {
      this.leaveActivities(c);
      c.ready = false;
      c.hp = MAX_HP;
      c.lastActiveAt = now;
      this.placeAt(c, HUB.duelSpots[i]);
      this.sendYou(c);
    });
    this.sendDuel(now);
    this.notice(`Дуэль: ${a.name} против ${b.name}!`, "#fb923c");
  }

  private sendDuel(now: number): void {
    const d = this.duel;
    if (!d) return;
    this.send(d.a, { t: "duel", state: d.state, opponent: d.b.id, ms: Math.max(0, d.until - now), won: null });
    this.send(d.b, { t: "duel", state: d.state, opponent: d.a.id, ms: Math.max(0, d.until - now), won: null });
  }

  private duelTick(now: number): void {
    const d = this.duel;
    if (!d || now < d.until) return;
    if (d.state === "countdown") {
      d.state = "fight";
      d.until = now + this.duelMs;
      this.sendDuel(now);
      return;
    }
    this.endDuel(null, "время вышло");
  }

  private endDuel(winner: Client | null, why = ""): void {
    const d = this.duel;
    if (!d) return;
    this.duel = null;
    const loser = winner ? (winner === d.a ? d.b : d.a) : null;
    [d.a, d.b].forEach((c, i) => {
      if (!this.clients.has(c.id)) return;
      c.hp = MAX_HP;
      c.motion.credits = [];
      if (this.isWalker(c)) {
        const e = HUB.duelExit;
        this.placeAt(c, { ...e, x: e.x + (i ? 1.2 : -1.2) });
      }
      this.send(c, { t: "duel", state: "over", opponent: (c === d.a ? d.b : d.a).id, ms: 0, won: winner ? c === winner : null });
      this.sendYou(c);
    });
    if (winner && loser) this.notice(`${winner.name} победил ${loser.name} в дуэли${why ? ` (${why})` : ""}`, "#fb923c");
    else this.notice(`Дуэль ${d.a.name} и ${d.b.name}: ничья${why ? ` (${why})` : ""}`, "#fb923c");
  }

  // ---------------------------------------------------------------- ticks

  /** Positions for every client's world. In the arena, while fog or invisibility hides players,
   *  each client only gets the ones it could see, so a hacked client has nothing extra to draw. */
  private sendTicks(now: number): void {
    const s = ++this.tickSeq;
    this.tickTimes[s % TICK_HISTORY] = now;
    const arenaLive = this.phase === "countdown" || this.phase === "playing";
    const alive = arenaLive ? this.alivePlayers() : [];
    const walkers = this.hubWalkers();
    const remember = (h: Hittable) => {
      h.seenAt.push({ s, x: r2(h.x), y: r2(h.y), z: r2(h.z) });
      if (h.seenAt.length > MAX_REWIND_TICKS + HIT_BLEND_TICKS + 2) h.seenAt.shift();
    };
    for (const c of [...alive, ...walkers]) remember(c);
    for (const m of this.mobs.mobs.values()) if (!m.dead) remember(Object.assign(m.body.pos, { seenAt: m.seenAt }));
    const row = (c: Client) => [c.id, r2(c.x), r2(c.y), r2(c.z), r2(c.yaw), r2(c.pitch), c.hp];

    if (arenaLive) this.sendArenaTick(s, now, alive, row);

    const hubViewers = this.viewers("hub");
    if (!hubViewers.length) return;
    const p = walkers.flatMap(row);
    const shared: number[] = [];
    const owned = new Map<number, number[]>();
    for (const m of this.mobs.mobs.values()) {
      if (m.dead) continue;
      if (m.owner === null) shared.push(...MobWorld.row(m));
      else owned.set(m.owner, [...(owned.get(m.owner) ?? []), ...MobWorld.row(m)]);
    }
    const a = [...this.mobs.arrows.values()].flatMap(MobWorld.arrowRow);
    const common = owned.size ? null : JSON.stringify({ t: "tick", s, p, m: shared, a } satisfies ServerMsg);
    for (const c of hubViewers) {
      if (c.ws.readyState !== WebSocket.OPEN) continue;
      if (common) c.ws.send(common);
      else this.send(c, { t: "tick", s, p, m: [...shared, ...(owned.get(c.id) ?? [])], a });
    }
  }

  private sendArenaTick(s: number, now: number, alive: Client[], row: (c: Client) => number[]): void {
    const viewers = this.viewers("arena");
    if (!viewers.length) return;
    const mods = buffModifiers(this.phase === "playing" ? this.currentBuffs : null);
    const a = this.arenaArrows.size ? [...this.arenaArrows.values()].flatMap((x) => [x.id, r2(x.x), r2(x.y), r2(x.z), r2(x.vx), r2(x.vy), r2(x.vz)]) : null;
    const tick = (p: number[]): ServerMsg => (a ? { t: "tick", s, p, a } : { t: "tick", s, p });
    if (!mods.night && !mods.invisible) {
      this.sendTo(viewers, tick(alive.flatMap(row)));
      return;
    }
    const range = Math.min(mods.night ? NIGHT_VIEW : Infinity, mods.invisible ? INVISIBLE_VIEW : Infinity);
    const visible = new Map<number, Set<number>>();
    for (const v of alive) {
      const ids = new Set([v.id]);
      for (const o of alive) {
        const near = Math.hypot(o.x - v.x, o.y - v.y, o.z - v.z) <= range;
        // The bounty target is seen through anything.
        if (near || o.id === this.bountyId || (mods.invisible && now - o.lastAttackAt < REVEAL_MS)) ids.add(o.id);
      }
      visible.set(v.id, ids);
    }
    for (const c of viewers) {
      if (c.ws.readyState !== WebSocket.OPEN) continue;
      const ids = visible.get(c.id) ?? this.ghostView(c, alive, visible);
      this.send(c, tick((ids ? alive.filter((x) => ids.has(x.id)) : alive).flatMap(row)));
    }
  }

  /** Spectators see everyone, except a second tab next to an alive player (ghosting): that one
   *  only gets what the player on the same IP may see. */
  private ghostView(c: Client, alive: Client[], visible: Map<number, Set<number>>): Set<number> | null {
    if (!c.ipKnown) return null;
    const mates = alive.filter((a) => a.ipKnown && a.ip === c.ip);
    return mates.length ? new Set(mates.flatMap((a) => [...(visible.get(a.id) ?? [])])) : null;
  }

  // ---------------------------------------------------------------- anticheat

  /** Adds violation points; past the threshold the player is kicked (and banned on repeat). */
  private flag(c: Client, check: string, points: number, detail: string): void {
    if (c.kicked) return;
    const now = Date.now();
    c.vl = decayVl(c.vl, now - c.vlAt) + points;
    c.vlAt = now;
    const kick = this.cfg.kick && c.vl >= this.cfg.kickVl;
    this.onViolation?.({ at: now, id: c.id, name: c.name ?? "", ip: c.ip, check, points, vl: c.vl, detail, kicked: kick });
    if (points > 0 && now - (c.loggedAt.get(check) ?? 0) >= 2000) {
      c.loggedAt.set(check, now);
      console.warn(`[anticheat] ${c.name ?? "?"}#${c.id} ${c.ip} ${check} +${r2(points)} vl=${c.vl.toFixed(1)}: ${detail}`);
    }
    if (kick) this.kick(c, check);
  }

  private kick(c: Client, check: string): void {
    c.kicked = true;
    const banMinutes = c.ipKnown ? this.guard.kicked(c.ip, Date.now()) : 0;
    console.warn(`[anticheat] kicked ${c.name ?? "?"}#${c.id} ${c.ip} for ${check}${banMinutes ? `, IP banned for ${banMinutes} min` : ""}`);
    if (c.alive && c.loc === "arena" && (this.phase === "playing" || this.phase === "countdown")) this.eliminate(c, null, "leave");
    c.ws.close(CLOSE_KICKED, CHECK_LABELS[check] ?? check);
    // Don't wait forever for a client that ignores the close handshake.
    setTimeout(() => c.ws.terminate(), 2000).unref();
  }

  /** Sends the player to the server's position for them; moves already in flight get dropped. */
  private teleport(c: Client, yaw?: number): void {
    c.tpSeq++;
    c.motion.synced = false;
    c.motion.vy = 0;
    c.motion.credits = [];
    this.send(c, { t: "tp", x: c.x, y: c.y, z: c.z, n: c.tpSeq, ...(yaw === undefined ? {} : { yaw }) });
  }

  /** Back to the last accepted position, kept inside the hub's wall (the arena's edge is a drop). */
  private setback(c: Client, view: View): void {
    const limit = ARENA_RADIUS - PLAYER_HALF_WIDTH;
    const r = Math.hypot(c.x, c.z);
    if (view === "hub" && r > limit) {
      c.x *= limit / r;
      c.z *= limit / r;
    }
    this.teleport(c);
  }

  /** Knockback the client never acknowledges was ignored, unless the client stopped reporting
   *  altogether (hidden tab, lost connection). */
  private expireCredits(c: Client, now: number): void {
    const overdue = (k: KbCredit) => k.ackTs === null && now > k.at + c.rtt + KB_ACK_MS;
    if (!c.motion.credits.some(overdue)) return;
    for (const k of c.motion.credits.filter(overdue)) {
      if (c.motion.srvAt > k.at + c.rtt + 1000) this.flag(c, "velocity", 3, `knockback #${k.seq} never applied`);
    }
    c.motion.credits = c.motion.credits.filter((k) => !overdue(k));
  }

  /** Modifiers a client played with under one entry of the buff log (its size included). */
  private logMods(c: Client, e: { buffs: BuffId[]; sizes: Map<number, number> }): BuffMods {
    return buffModifiers(e.buffs, this.mode, e.sizes.get(c.id) ?? 1);
  }

  /** Modifiers of every buff a client may have played with while it knew ticks lo..hi (the next
   *  buff may already have arrived ahead of tick hi). */
  private buffsBetween(c: Client, lo: number, hi: number): BuffMods[] {
    const out: BuffMods[] = [];
    for (let i = this.buffLog.length - 1; i >= 0; i--) {
      const e = this.buffLog[i];
      if (e.tick <= hi + 1) out.push(this.logMods(c, e));
      if (e.tick <= lo) break;
    }
    return out.length ? out : [buffModifiers(null, this.mode)];
  }

  /** When tick `tk` was sent (clamped to the remembered history). */
  private tickTime(tk: number): number {
    return this.tickTimes[Math.max(tk, this.tickSeq - TICK_HISTORY + 1, 0) % TICK_HISTORY];
  }

  /** Oldest tick a client's move is judged by: what it had seen at its previous move. */
  private seenTick(c: Client, tk: number): number {
    return Math.max(Math.min(c.lastTk, tk), this.tickSeq - MAX_LAG_TICKS);
  }

  /** Changes since this moment may still be unknown to the client. */
  private unseenSince(c: Client, tk: number, now: number): number {
    return Math.min(now - c.rtt - 1000, this.tickTime(this.seenTick(c, tk)) - 200);
  }

  /** Checks run against what the client knew while it moved, so a slow or stalled connection
   *  can't make honest moves look impossible. */
  private moveCtx(c: Client, now: number, tk: number, view: View): MoveCtx {
    const since = this.unseenSince(c, tk, now);
    if (view === "hub") {
      const g = GRAVITY * buffModifiers(null).gravity;
      return {
        world: this.hub.vox,
        now,
        gLo: g,
        gHi: g,
        maxSpeed: WALK_SPEED,
        airJump: false,
        ringRadius: ARENA_RADIUS,
        ringLimit: ARENA_RADIUS,
        ringSpeed: 0,
        freshBlocks: (a, b) => this.blocksChangedNear(this.hub, a, b, since),
      };
    }
    const lo = this.seenTick(c, tk);
    const mods = this.buffsBetween(c, lo, tk);
    const g = mods.map((m) => GRAVITY * m.gravity);
    return {
      world: this.arena.vox,
      // The island as the client may still have known it while it moved.
      ground: this.arena.vox.overFloor(this.floorSeen(lo)),
      now,
      gLo: Math.min(...g),
      gHi: Math.max(...g),
      maxSpeed: WALK_SPEED * Math.max(...mods.map((m) => m.speed)),
      airJump: mods.some((m) => m.extraJumps > 0),
      // No wall around the arena: past the island's edge players fall.
      ringRadius: Infinity,
      ringLimit: Infinity,
      ringSpeed: 0,
      freshBlocks: (a, b) => this.blocksChangedNear(this.arena, a, b, since),
    };
  }

  private blocksChangedNear(world: GameWorld, a: Vec3, b: Vec3, since: number): boolean {
    for (let x = Math.floor(Math.min(a.x, b.x)) - 1; x <= Math.floor(Math.max(a.x, b.x)) + 1; x++)
      for (let y = Math.floor(Math.min(a.y, b.y)) - 1; y <= Math.floor(Math.max(a.y, b.y) + PLAYER_HEIGHT) + 1; y++)
        for (let z = Math.floor(Math.min(a.z, b.z)) - 1; z <= Math.floor(Math.max(a.z, b.z)) + 1; z++) {
          if (Voxels.inBounds(x, y, z) && (world.changedAt.get(Voxels.index(x, y, z)) ?? 0) >= since) return true;
        }
    return false;
  }

  private setBlock(world: GameWorld, x: number, y: number, z: number, v: number, now: number): void {
    world.vox.set(x, y, z, v);
    world.changedAt.set(Voxels.index(x, y, z), now);
    this.sendTo(this.viewers(world.w), { t: "block", w: world.w, x, y, z, v });
  }

  /** Is the player aiming at this block (or, for `place`, at the face next to this cell)? The client
   *  reports its position and view right before acting, so this is the client's own raycast; when
   *  that disagrees (blocks changed meanwhile), any visible part of the cell will do. */
  private aimsAt(world: GameWorld, c: Client, action: "place" | "break", x: number, y: number, z: number): boolean {
    const eye = { x: c.x, y: c.y + EYE_HEIGHT * c.size, z: c.z };
    const hit = raycastVoxels(world.vox, eye, lookDir(c.yaw, c.pitch), BUILD_REACH + 0.01);
    if (hit && action === "break" && !hit.floor && hit.x === x && hit.y === y && hit.z === z) return true;
    if (hit && action === "place" && hit.x + hit.nx === x && hit.y + hit.ny === y && hit.z + hit.nz === z) return true;
    return CELL_SAMPLES.some(([px, py, pz]) => segmentClear(world.vox, eye, { x: x + px, y: y + py, z: z + pz }, x, y, z));
  }

  /** Refusal points for building, waived when blocks between the player and the cell just changed. */
  private buildPoints(world: GameWorld, c: Client, x: number, y: number, z: number, now: number): number {
    return this.blocksChangedNear(world, c, { x: x + 0.5, y, z: z + 0.5 }, this.unseenSince(c, c.lastTk, now)) ? 0 : 1;
  }

  // ---------------------------------------------------------------- actions

  private onMove(c: Client, m: Extract<ClientMsg, { t: "move" }>, now: number): void {
    if (!finite(m.x, m.y, m.z, m.yaw, m.pitch, m.vy, m.ts, m.n, m.k) || !ints(m.tk) || m.tk > this.tickSeq) {
      return this.flag(c, "packet", 1, "malformed move");
    }
    // Sent before our last teleport reached the client (or before it changed worlds).
    if (m.n !== c.tpSeq) return;
    if (this.viewOf(c) === "hub") return this.moveIn(c, m, now, "hub");
    if (c.loc !== "arena" || !c.alive) return;
    if (this.phase === "countdown") {
      // Players are frozen; only the spawn acknowledgement that anchors their clock is taken.
      if (!c.motion.synced && isTeleportAck(c, m)) checkMove(c, c.motion, m, this.moveCtx(c, now, m.tk, "arena"));
      return;
    }
    if (this.phase !== "playing") return;
    // Once the client knows a buff took speed away, its velocity decays from the old speed.
    for (let i = 1; i < this.buffLog.length; i++) {
      const e = this.buffLog[i];
      if (e.tick <= c.creditedTick || e.tick > m.tk + 1) continue;
      const slower = WALK_SPEED * SPRINT_SPEED * (this.logMods(c, this.buffLog[i - 1]).speed - this.logMods(c, e).speed);
      if (slower > 0) c.motion.credits.push(speedCredit(now, c.motion.ts, slower));
    }
    c.creditedTick = Math.max(c.creditedTick, m.tk + 1);
    this.moveIn(c, m, now, "arena");
  }

  private moveIn(c: Client, m: Extract<ClientMsg, { t: "move" }>, now: number, view: View): void {
    if (Math.abs(m.yaw - c.yaw) > 1e-3 || Math.abs(m.pitch - c.pitch) > 1e-3 || Math.hypot(m.x - c.x, m.z - c.z) > 0.01) c.lastActiveAt = now;
    c.yaw = m.yaw;
    c.pitch = clampPitch(m.pitch);
    // The client simulates its own movement; the server replays it and refuses what physics can't explain.
    const lastAt = c.motion.srvAt;
    const gap = m.ts - c.motion.ts;
    const dh = Math.hypot(m.x - c.x, m.z - c.z);
    const verdict = checkMove(c, c.motion, m, this.moveCtx(c, now, m.tk, view));
    if (!verdict.ok) {
      this.flag(c, verdict.check, verdict.points, verdict.detail);
      if (verdict.drop) c.y = dropToGround(view === "hub" ? this.hub.vox : this.arena.vox, c);
      this.setback(c, view);
      return;
    }
    if (verdict.flag) this.flag(c, verdict.flag.check, verdict.flag.points, verdict.flag.detail);
    c.lastTk = Math.max(c.lastTk, m.tk);
    if (verdict.idle) return;
    if (now - lastAt > 300) c.resumedAt = now;
    if (gap > 0) c.hspeed = dh / (gap / 1000);
    c.x = m.x;
    c.y = m.y;
    c.z = m.z;
    c.lastMoveAt = now;
    if (view === "arena" && c.y < FALL_OUT_Y) this.fallOut(c, now);
  }

  private onHit(c: Client, m: Extract<ClientMsg, { t: "hit" }>, now: number): void {
    if (!finite(m.id, m.yaw, m.pitch, m.tk) || m.tk > this.tickSeq) return this.flag(c, "packet", 1, "malformed hit");
    // The attacker hasn't seen anything recent (too much lag to judge, or a backtrack attempt), or
    // acted before a correction reached it: its position for the hit is unknown.
    if (m.tk < this.tickSeq - MAX_REWIND_TICKS || !c.motion.synced) return;
    if (m.id >= MOB_ID_BASE) return this.hitMob(c, m, now);
    const t = this.clients.get(m.id);
    if (!t || t === c) return;
    if (this.phase === "playing" && c.loc === "arena" && c.alive && t.loc === "arena" && t.alive && t.role === "player") return this.hitArena(c, t, m, now);
    const d = this.duel;
    if (d && d.state === "fight" && ((d.a === c && d.b === t) || (d.b === c && d.a === t))) this.hitDuel(c, t, m, now);
  }

  /** Common hit validation. Returns why the hit doesn't count, or null. */
  private strikeProblem(c: Client, t: Hittable, m: Extract<ClientMsg, { t: "hit" }>, now: number, world: GameWorld): string | null {
    c.yaw = m.yaw;
    c.pitch = clampPitch(m.pitch);
    const problem = this.hitProblem(world, c, t, m.tk);
    if (problem) {
      const settled = m.tk >= this.tickSeq - FRESH_VIEW_TICKS && now - c.resumedAt > RESUME_GRACE_MS;
      this.flag(c, problem.check, settled ? problem.points : 0, problem.detail);
      return problem.check;
    }
    if (!this.cooledDown(c, "hit")) {
      this.flag(c, "hitrate", 1, "hit before the cooldown ended");
      return "hitrate";
    }
    c.lastAttackAt = now;
    c.lastActiveAt = now;
    return null;
  }

  /** Falling (validated vertical speed) and off the ground. */
  private falling(c: Client, world: GameWorld, now: number): boolean {
    return now - c.lastMoveAt < 300 && c.motion.vy < -1 && c.y - this.groundBelow(world, c.x, c.y, c.z) > 0.1;
  }

  /** Minecraft-style critical hit: a falling hit, but not while sprinting. */
  private isCrit(c: Client, world: GameWorld, now: number): boolean {
    return !c.motion.sprint && this.falling(c, world, now);
  }

  /** Minecraft: a hit ends the sprint; with a real run-up behind it, it knocks back harder. The
   *  sprint flag alone is the client's word, so the speed of the last move must back it up. */
  private sprintHit(c: Client, now: number, mods: BuffMods): boolean {
    const hit = c.motion.sprint && now - c.lastMoveAt < 300 && c.hspeed >= WALK_SPEED * mods.speed * 0.8;
    endSprint(c.motion);
    return hit;
  }

  private knock(c: Client, tx: number, tz: number, mods: BuffMods, sprint = false): { kx: number; ky: number; kz: number } {
    let dx = tx - c.x;
    let dz = tz - c.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) {
      dx = -Math.sin(c.yaw);
      dz = -Math.cos(c.yaw);
    } else {
      dx /= len;
      dz /= len;
    }
    const kb = 7 * mods.knockback;
    let kx = dx * kb;
    let kz = dz * kb;
    let ky = mods.launch || (mods.knockback > 1 ? 8 : 5.5);
    if (sprint) {
      // Along the attacker's view, like Minecraft's sprint knockback.
      kx -= Math.sin(c.yaw) * SPRINT_KNOCKBACK;
      kz -= Math.cos(c.yaw) * SPRINT_KNOCKBACK;
      ky += SPRINT_KNOCKBACK_UP;
    }
    return { kx: r2(kx), ky: r2(ky), kz: r2(kz) };
  }

  private hitArena(c: Client, t: Client, m: Extract<ClientMsg, { t: "hit" }>, now: number): void {
    if (this.strikeProblem(c, t, m, now, this.arena)) return;
    if (this.sameTeam(c, t)) return this.hint(c, "Это союзник", now);
    const buffs = this.currentBuffs;
    const mods = buffModifiers(buffs, this.mode, c.size);
    const crit = this.isCrit(c, this.arena, now);
    const sprint = this.sprintHit(c, now, mods);
    let base = (mods.berserk ? HIT_DAMAGE * (1 + 2 * (1 - c.hp / c.maxHp)) : HIT_DAMAGE) * sizeStats(c.size).damage;
    if (this.mode === "infection" && c.team === 1) base *= ZOMBIE_DAMAGE;
    // Overtime is sudden death; one-shot kills even a giant.
    const lethal = this.overtime || mods.damage >= MAX_HP;
    let dmg = lethal ? t.hp : Math.max(1, Math.round(crit ? base * CRIT_MULTIPLIER : base));
    if (MODES[this.mode].noDamage) dmg = 0;
    dmg = Math.min(t.hp, dmg);
    t.hp -= dmg;
    if (dmg) {
      t.lastDamageAt = now;
      t.nextRegenAt = 0;
    }
    t.lastHitBy = c.id;
    t.lastHitAt = now;
    c.stats.damage += dmg;
    if (crit) c.stats.crits++;
    if (mods.lifesteal && c.hp < c.maxHp && dmg) {
      c.hp = Math.min(c.maxHp, c.hp + dmg);
      this.sendYou(c);
    }
    const { kx, ky, kz } = this.knock(c, t.x, t.z, buffModifiers(buffs, this.mode, t.size), sprint);
    const alive = t.hp > 0;
    if (alive) t.motion.credits.push(knockbackCredit(now, ++t.kbSeq, kx, ky, kz));
    this.sendTo(this.viewers("arena"), { t: "hurt", id: t.id, by: c.id, hp: t.hp, dmg, crit, kx, ky, kz, kn: alive ? t.kbSeq : 0 });
    const bomb = this.bomb;
    if (alive && bomb && bomb.holder === c && !(t.id === bomb.from && now - bomb.at < BOMB_TAGBACK_MS)) this.giveBomb(t, now, c.id, bomb.until);
    if (!alive) return this.eliminate(t, c, "kill");
    this.sendYou(t);
  }

  private hitDuel(c: Client, t: Client, m: Extract<ClientMsg, { t: "hit" }>, now: number): void {
    if (this.strikeProblem(c, t, m, now, this.hub)) return;
    const mods = buffModifiers(null);
    const crit = this.isCrit(c, this.hub, now);
    const sprint = this.sprintHit(c, now, mods);
    const dmg = Math.min(t.hp, crit ? Math.ceil(mods.damage * CRIT_MULTIPLIER) : mods.damage);
    t.hp -= dmg;
    const { kx, ky, kz } = this.knock(c, t.x, t.z, mods, sprint);
    const alive = t.hp > 0;
    if (alive) t.motion.credits.push(knockbackCredit(now, ++t.kbSeq, kx, ky, kz));
    this.sendTo(this.viewers("hub"), { t: "hurt", id: t.id, by: c.id, hp: t.hp, dmg, crit, kx, ky, kz, kn: alive ? t.kbSeq : 0 });
    if (!alive) return this.endDuel(c);
    this.sendYou(t);
  }

  private hitMob(c: Client, m: Extract<ClientMsg, { t: "hit" }>, now: number): void {
    if (!this.isWalker(c)) return;
    const mob = this.mobs.mobs.get(m.id);
    if (!mob || mob.dead || (mob.owner !== null && mob.owner !== c.id)) return;
    const target: Hittable = { ...mob.body.pos, seenAt: mob.seenAt };
    const why = this.strikeProblem(c, target, m, now, this.hub);
    if (why) {
      const tips: Record<string, string> = {
        reach: "Далеко — подойди ближе (удар достаёт на 3–4 блока)",
        wall: "Между вами блок — обойди его",
        aim: "Мимо — наведи прицел прямо на скелета",
        hitrate: "Слишком часто: между ударами 0,45 с",
      };
      if (tips[why]) this.hint(c, tips[why], now);
      return;
    }
    const mods = buffModifiers(null);
    const wasSprinting = c.motion.sprint;
    const fell = this.falling(c, this.hub, now);
    const crit = this.isCrit(c, this.hub, now);
    const sprint = this.sprintHit(c, now, mods);
    const dmg = crit ? Math.ceil(mods.damage * CRIT_MULTIPLIER) : mods.damage;
    const { kx, ky, kz } = this.knock(c, mob.body.pos.x, mob.body.pos.z, mods, sprint);
    const result = this.mobs.hit(mob, c.id, dmg, kx, ky, kz, now);
    const msg: ServerMsg = { t: "hurt", id: mob.id, by: c.id, hp: mob.hp, dmg, crit, kx, ky, kz, kn: 0 };
    if (mob.owner !== null) this.send(c, msg);
    else this.sendTo(this.viewers("hub"), msg);

    const tr = c.train;
    tr.hits++;
    if (crit) tr.crits++;
    tr.combo = now - c.lastTrainHitAt <= 2000 ? tr.combo + 1 : 1;
    tr.best = Math.max(tr.best, tr.combo);
    c.lastTrainHitAt = now;
    c.dmgLog.push([now, dmg]);
    c.trainDirty = true;
    if (result === "killed" && mob.kind === "walker") {
      tr.kills++;
      this.hint(c, `Скелет повержен! Всего: ${tr.kills}`, now, true);
    }
    if (mob.kind === "target" && c.range?.target === mob.id) {
      const r = c.range;
      r.score++;
      this.mobs.remove(mob.id);
      r.target = null;
      r.nextSpawnAt = now + 200;
      this.sendRange(c, now);
      return;
    }
    if (wasSprinting && fell) {
      this.hint(c, "Крит не засчитан — ты в спринте. Отпусти W перед ударом в падении", now, true);
    } else if (sprint && !c.hintsSeen.has("sprint")) {
      c.hintsSeen.add("sprint");
      this.hint(c, "Удар с разбега: отбрасывает сильнее, но спринт сбивается", now, true);
    } else if (crit) {
      c.nonCrits = 0;
      if (tr.crits <= 3) this.hint(c, "КРИТ! Удар в падении наносит ×1.5 урона", now, true);
    } else if (++c.nonCrits >= 6 && !c.hintsSeen.has(`crit${Math.floor(now / 30_000)}`)) {
      c.hintsSeen.add(`crit${Math.floor(now / 30_000)}`);
      c.nonCrits = 0;
      this.hint(c, c.motion.vy > 0.5 ? "Рано! Бей, когда уже падаешь вниз — будет крит" : "Прыгни и ударь на падении — будет крит ×1.5", now, true);
    }
  }

  /** Where the attacker may have seen the target: positions of the ticks blended into its drawing
   *  (lag compensation), plus midpoints so fast targets leave no gaps. */
  private seenPositions(t: Hittable, tk: number): Vec3[] {
    const seen = t.seenAt.filter((h) => h.s <= tk && h.s >= tk - HIT_BLEND_TICKS);
    if (!seen.length) return [t];
    const out: Vec3[] = [...seen];
    for (let i = 1; i < seen.length; i++) {
      const a = seen[i - 1];
      const b = seen[i];
      out.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
    }
    return out;
  }

  /** Why a hit can't be real, or null. The ray from the attacker's eye along the reported view must
   *  reach the target where the attacker saw it, without a block in between. */
  private hitProblem(world: GameWorld, c: Client, t: Hittable, tk: number): { check: string; points: number; detail: string } | null {
    const eye = { x: c.x, y: c.y + EYE_HEIGHT * c.size, z: c.z };
    const dir = lookDir(c.yaw, c.pitch);
    const reach = HIT_REACH + HIT_REACH_SLACK;
    const size = (t as Partial<Client>).size ?? 1;
    const seen = this.seenPositions(t, tk);
    let closest = Infinity;
    let walled = false;
    for (const p of seen) {
      const pad = PLAYER_HALF_WIDTH * size + HIT_BOX_PAD;
      const min = { x: p.x - pad, y: p.y - HIT_BOX_PAD, z: p.z - pad };
      const max = { x: p.x + pad, y: p.y + PLAYER_HEIGHT * size + HIT_BOX_PAD, z: p.z + pad };
      closest = Math.min(closest, boxDistance(eye, min, max));
      const at = rayBox(eye, dir, min, max, reach);
      if (at === null) continue;
      const block = raycastVoxels(world.vox, eye, dir, at);
      if (block && block.t < at - 0.15) {
        walled = true;
        continue;
      }
      return null;
    }
    if (walled) return { check: "wall", points: 2, detail: "hit through a block" };
    if (closest > reach) return { check: "reach", points: 2, detail: `target ${closest.toFixed(2)} blocks away` };
    const off = Math.min(
      ...seen.map((p) => {
        const to = { x: p.x - eye.x, y: p.y + 0.9 - eye.y, z: p.z - eye.z };
        const len = Math.hypot(to.x, to.y, to.z) || 1;
        return Math.acos(Math.max(-1, Math.min(1, (to.x * dir.x + to.y * dir.y + to.z * dir.z) / len)));
      }),
    );
    return { check: "aim", points: 1, detail: `target not in view (${((off * 180) / Math.PI).toFixed(0)}° off, view ${this.tickSeq - tk} ticks old)` };
  }

  /** Actions are spaced on the client's physics clock, which the timer check keeps in step with
   *  real time; actions held back by a network stall may then arrive together. */
  private cooledDown(c: Client, action: Action): boolean {
    const cd = c.cooldowns[action];
    if (c.motion.ts - cd.ts < COOLDOWN_MS[action] - 5) return false;
    cd.ts = c.motion.ts;
    return true;
  }

  private canReach(c: Client, x: number, y: number, z: number): boolean {
    return Math.hypot(x + 0.5 - c.x, y + 0.5 - (c.y + EYE_HEIGHT * c.size), z + 0.5 - c.z) <= BUILD_REACH_MAX;
  }

  private overlapsPlayer(players: Client[], x: number, y: number, z: number): boolean {
    // Lenient overlap test: positions lag a little, and clients push themselves out of blocks.
    const hw = PLAYER_HALF_WIDTH - 0.1;
    return players.some((p) => p.x + hw > x && p.x - hw < x + 1 && p.z + hw > z && p.z - hw < z + 1 && p.y + PLAYER_HEIGHT - 0.1 > y && p.y + 0.5 < y + 1);
  }

  private supported(world: GameWorld, x: number, y: number, z: number): boolean {
    const w = world.vox;
    return y === 0 || !!(w.get(x + 1, y, z) || w.get(x - 1, y, z) || w.get(x, y + 1, z) || w.get(x, y - 1, z) || w.get(x, y, z + 1) || w.get(x, y, z - 1));
  }

  private onPlace(c: Client, x: number, y: number, z: number, now: number): void {
    if (!ints(x, y, z) || !c.motion.synced) return;
    if (this.viewOf(c) === "hub") return this.placeHub(c, x, y, z, now);
    if (this.phase !== "playing" || c.loc !== "arena" || !c.alive || c.dirt <= 0) return;
    const w = this.arena;
    if (!Voxels.inBounds(x, y, z) || !cellInRing(x, z, this.floorR) || w.vox.get(x, y, z)) return;
    if (!this.canReach(c, x, y, z)) return this.flag(c, "build", 1, "placing out of reach");
    if (!this.aimsAt(w, c, "place", x, y, z)) return this.flag(c, "build", this.buildPoints(w, c, x, y, z, now), "placing through a wall");
    if (!this.supported(w, x, y, z) || this.overlapsPlayer(this.alivePlayers(), x, y, z)) return;
    if (!this.cooledDown(c, "place")) return this.flag(c, "build", 0.5, "placing too fast");
    c.dirt--;
    c.stats.blocks++;
    this.setBlock(w, x, y, z, BLOCK.dirt, now);
    this.sendYou(c);
  }

  private placeHub(c: Client, x: number, y: number, z: number, now: number): void {
    if (!this.isWalker(c) || this.inDuel(c)) return;
    const w = this.hub;
    if (!inCellBox(x, z, HUB.build) || y < 0 || y >= HUB.buildMaxY || w.vox.get(x, y, z)) return;
    if (this.hubPlaced.size >= HUB_BLOCK_LIMIT) return this.hint(c, "Слишком много блоков — подожди, пока старые исчезнут", now);
    if (!this.canReach(c, x, y, z)) return this.flag(c, "build", 1, "placing out of reach");
    if (!this.aimsAt(w, c, "place", x, y, z)) return this.flag(c, "build", this.buildPoints(w, c, x, y, z, now), "placing through a wall");
    if (!this.supported(w, x, y, z) || this.overlapsPlayer(this.hubWalkers(), x, y, z)) return;
    if (!this.cooledDown(c, "place")) return this.flag(c, "build", 0.5, "placing too fast");
    c.lastActiveAt = now;
    this.hubPlaced.set(Voxels.index(x, y, z), now + this.buildTtlMs);
    this.setBlock(w, x, y, z, BLOCK.dirt, now);
  }

  private onBreak(c: Client, x: number, y: number, z: number, now: number): void {
    if (!ints(x, y, z) || !c.motion.synced) return;
    const hub = this.viewOf(c) === "hub";
    const w = hub ? this.hub : this.arena;
    if (hub) {
      if (!this.isWalker(c) || !Voxels.inBounds(x, y, z) || !this.hubPlaced.has(Voxels.index(x, y, z))) return;
    } else if (this.phase !== "playing" || c.loc !== "arena" || !c.alive || !w.vox.get(x, y, z)) {
      return;
    }
    if (!this.canReach(c, x, y, z)) return this.flag(c, "build", 1, "breaking out of reach");
    if (!this.aimsAt(w, c, "break", x, y, z)) return this.flag(c, "build", this.buildPoints(w, c, x, y, z, now), "breaking through a wall");
    if (!this.cooledDown(c, "break")) return this.flag(c, "build", 0.5, "breaking too fast");
    c.lastActiveAt = now;
    if (hub) {
      this.hubPlaced.delete(Voxels.index(x, y, z));
    } else if (this.mode !== "spleef") {
      c.dirt++;
      this.sendYou(c);
    }
    this.setBlock(w, x, y, z, 0, now);
  }

  // ---------------------------------------------------------------- messaging

  private send(c: Client, msg: ServerMsg): void {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }

  private sendTo(clients: Client[], msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const c of clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }

  private broadcast(msg: ServerMsg): void {
    this.sendTo(this.named(), msg);
  }

  private sendYou(c: Client): void {
    const respawnIn = c.respawnAt ? Math.max(0, c.respawnAt - Date.now()) : 0;
    this.send(c, { t: "you", hp: c.hp, maxHp: c.maxHp, dirt: c.dirt, arrows: c.arrows, alive: c.alive, role: c.role, watching: c.watching, respawnIn });
  }

  private broadcastRoster(): void {
    this.rosterDirty = false;
    this.rosterSentAt = Date.now();
    const players: PlayerInfo[] = this.named()
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((c) => ({
        id: c.id,
        name: c.name,
        color: c.color,
        skin: c.skin,
        role: c.role,
        alive: c.alive,
        ready: c.ready,
        kills: c.kills,
        crown: c.id === this.crownId,
        team: c.team,
        size: c.size,
        maxHp: c.maxHp,
        score: c.score,
      }));
    this.broadcast({ t: "roster", players });
  }
}
