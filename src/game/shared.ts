// Shared by the browser client and the Node game server (run via Node type stripping):
// keep it dependency-free, use `import type` only, no enums or parameter properties.

export const WS_PATH = "/game-ws";

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 12;

export const ARENA_RADIUS = 48;
export const FINAL_RING_RADIUS = 12;
export const SPAWN_RADIUS = 40;
/** Ceiling: neither blocks nor players can go above y = MAX_HEIGHT. */
export const MAX_HEIGHT = 20;
export const GRID = ARENA_RADIUS * 2 + 1;

export const PLAYER_HALF_WIDTH = 0.3;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;

export const MAX_HP = 20;
export const HIT_DAMAGE = 4;
export const HIT_COOLDOWN_MS = 450;
export const HIT_REACH = 3.6;
export const BUILD_REACH = 5.5;
export const START_DIRT = 10;
export const BUILDER_BONUS = 20;
export const CRIT_MULTIPLIER = 1.5;
/** How long the buff roulette spins before each buff. */
export const ROULETTE_MS = 4500;
/** Below this height a player has fallen off the island for good. */
export const FALL_OUT_Y = -10;
/** A fall counts as a kill for whoever hit the player this recently. */
export const FALL_CREDIT_MS = 8000;
/** Kills in one round that make a player "on fire" (announced and highlighted). */
export const HOT_STREAK = 3;

export const TICK_MS = 50;

/** Bumped whenever the wire format changes; outdated clients are asked to reload. */
export const PROTOCOL_VERSION = 5;

/** WebSocket close codes the server uses to explain why it dropped a client. */
export const CLOSE_OUTDATED = 4000;
export const CLOSE_KICKED = 4001;
export const CLOSE_TOO_MANY = 4002;
export const CLOSE_BANNED = 4003;
export const CLOSE_FULL = 4004;

// Player physics. The client simulates it; the server re-checks every reported move against it.
export const WALK_SPEED = 5;
export const JUMP_SPEED = 9.2;
export const GRAVITY = 30;
export const MAX_FALL_SPEED = 45;
export const GROUND_ACCEL = 14;
export const AIR_ACCEL = 2.5;
/** Longest physics step: slower frames run the game in slow motion instead of skipping ahead. */
export const MAX_STEP_DT = 0.05;

// Sprint, as in Minecraft (Java): double-tap forward within 7 ticks while on the ground; it lasts
// while forward is held and ends on a head-on wall hit or on hitting someone.
export const SPRINT_TAP_MS = 350;
export const SPRINT_SPEED = 1.3;
/** Push along the view on every jump from the ground while sprinting. Tuned so that sprint-jumping is
 *  ~27% faster than sprinting, as in Minecraft. */
export const SPRINT_JUMP_BOOST = 3;
/** Sliding along a wall within this angle of where you're heading keeps the sprint. */
export const SPRINT_WALL_ANGLE = (8 * Math.PI) / 180;
/** A sprint hit knocks back harder (like one level of the Knockback enchantment) and a bit higher. */
export const SPRINT_KNOCKBACK = 8.75;
export const SPRINT_KNOCKBACK_UP = 1.4;

export interface Timings {
  countdownMs: number;
  roundMs: number;
  /** The first buff lands this far into the round, then a new one every buffIntervalMs. */
  firstBuffMs: number;
  buffIntervalMs: number;
  /** The island starts crumbling from the edge here, a step at a time (see crumbleSteps). */
  shrinkStartMs: number;
  /** Cells about to fall are marked this long before they do. */
  crumbleWarnMs: number;
  /** Sudden death after roundMs while several players live; then the best of them wins on points. */
  overtimeMs: number;
  endMs: number;
  /** Respawn delay in the respawn modes (Infection, King of the Hill, Teams). */
  respawnMs: number;
  /** Lava buff: the lava rises a block this often. */
  lavaRiseMs: number;
  /** Hot potato fuse. */
  bombMs: number;
  /** Swap buff: players trade places this often. */
  swapMs: number;
  /** Meteor buff: a volley this often. */
  meteorMs: number;
  /** King of the Hill: a point per this much time alone on the hill. */
  hillPointMs: number;
  /** Lobby auto-start: the round starts this long after two active players are in the hub… */
  lobbyMs: number;
  /** …or this soon once more than half of them stand in the ready circle. */
  readyMs: number;
}

export function makeTimings(scale = 1): Timings {
  return {
    countdownMs: 4000,
    roundMs: 6 * 60_000 * scale,
    firstBuffMs: 30_000 * scale,
    buffIntervalMs: 60_000 * scale,
    shrinkStartMs: 2 * 60_000 * scale,
    crumbleWarnMs: 10_000 * scale,
    overtimeMs: 60_000 * scale,
    endMs: 8000,
    respawnMs: 3000 * scale,
    lavaRiseMs: 20_000 * scale,
    bombMs: 20_000 * scale,
    swapMs: 15_000 * scale,
    meteorMs: Math.max(250, 1500 * scale),
    hillPointMs: 1000 * scale,
    lobbyMs: 60_000 * scale,
    readyMs: 10_000 * scale,
  };
}

export type Phase = "lobby" | "countdown" | "playing" | "ended";
export type Role = "player" | "spectator";

export type BuffId =
  | "gravity"
  | "speed"
  | "oneshot"
  | "vampire"
  | "night"
  | "lava"
  | "baseball"
  | "doublejump"
  | "invisible"
  | "berserk"
  | "builder"
  | "bounty"
  | "potato"
  | "meteors"
  | "swap"
  | "giants"
  | "ice"
  | "bows";

export interface BuffDef {
  id: BuffId;
  title: string;
  description: string;
  color: string;
}

export const BUFFS: Record<BuffId, BuffDef> = {
  gravity: { id: "gravity", title: "ГРАВИТАЦИЯ", description: "Гравитация ослабла: прыжки выше, падение медленнее", color: "#7dd3fc" },
  speed: { id: "speed", title: "СКОРОСТЬ", description: "Все бегают в 1.7 раза быстрее", color: "#facc15" },
  oneshot: { id: "oneshot", title: "ВАНШОТ", description: "Один удар — одна смерть", color: "#ef4444" },
  vampire: { id: "vampire", title: "ВАМПИРИЗМ", description: "Урон лечит. Убийство — полное здоровье и +1 сердце сверху", color: "#f43f5e" },
  night: { id: "night", title: "НОЧЬ", description: "Темно, хоть глаз выколи. Только ники светятся", color: "#818cf8" },
  lava: { id: "lava", title: "ПОЛ — ЛАВА", description: "Лава поднимается на блок каждые 20 секунд и убивает. Стройтесь вверх!", color: "#fb923c" },
  baseball: { id: "baseball", title: "БЕЙСБОЛ", description: "Удар отправляет в полёт. Берегитесь края!", color: "#a78bfa" },
  doublejump: { id: "doublejump", title: "ДВОЙНОЙ ПРЫЖОК", description: "Можно прыгнуть ещё раз в воздухе", color: "#34d399" },
  invisible: { id: "invisible", title: "НЕВИДИМОСТЬ", description: "Все невидимы, но на бегу остаются следы. Удар выдаёт вас", color: "#94a3b8" },
  berserk: { id: "berserk", title: "БЕРСЕРК", description: "Чем меньше у тебя здоровья, тем сильнее удар — до ×3", color: "#dc2626" },
  builder: { id: "builder", title: "СТРОЙКА", description: `Каждому +${BUILDER_BONUS} земли`, color: "#d4a373" },
  bounty: { id: "bounty", title: "ОХОТА ЗА ГОЛОВОЙ", description: "Лидера видно сквозь стены. Убей его — получишь награду и станешь целью сам", color: "#fbbf24" },
  potato: { id: "potato", title: "ГОРЯЧАЯ КАРТОШКА", description: "У кого-то бомба! Ударь соперника, чтобы передать. Через 20 секунд — взрыв", color: "#f97316" },
  meteors: { id: "meteors", title: "МЕТЕОРИТЫ", description: "С неба падают камни. Уходите из красных кругов!", color: "#f59e0b" },
  swap: { id: "swap", title: "ОБМЕН", description: "Каждые 15 секунд все меняются местами", color: "#c084fc" },
  giants: { id: "giants", title: "ВЕЛИКАНЫ И МАЛЫШИ", description: "Половина — великаны (сильнее, крепче), половина — малыши (быстрее, мельче)", color: "#2dd4bf" },
  ice: { id: "ice", title: "ГОЛОЛЁД", description: "Пол скользкий — тормозить трудно", color: "#bae6fd" },
  bows: { id: "bows", title: "ЛУКИ", description: "Каждому 5 стрел. Q — выстрел", color: "#a3e635" },
};

export const BUFF_IDS = Object.keys(BUFFS) as BuffId[];

/** Buffs that make no sense together in a Chaos pair. */
export const CHAOS_CLASH: [BuffId, BuffId][] = [
  ["lava", "ice"],
  ["oneshot", "berserk"],
  ["oneshot", "vampire"],
  ["night", "invisible"],
];

export interface TeamDef {
  name: string;
  color: string;
}

export interface ModeDef {
  title: string;
  description: string;
  color: string;
  /** The dead come back after Timings.respawnMs instead of watching till the end. */
  respawn: boolean;
  /** Hits only knock back: the fall is the only way out. */
  noDamage: boolean;
  /** Team 0 and team 1 (Infection: humans and zombies). */
  teams: [TeamDef, TeamDef] | null;
}

/** Round modes, voted for in the hub. */
export type GameMode = "classic" | "oneshot" | "lowgrav" | "builders" | "infection" | "koth" | "sumo" | "spleef" | "teams";
export const MODE_IDS: GameMode[] = ["classic", "oneshot", "lowgrav", "builders", "infection", "koth", "sumo", "spleef", "teams"];
const solo = { respawn: false, noDamage: false, teams: null };
export const MODES: Record<GameMode, ModeDef> = {
  classic: { ...solo, title: "КЛАССИКА", description: "Последний выживший; новый баф каждую минуту", color: "#7CFC00" },
  oneshot: { ...solo, title: "ВАНШОТ", description: "Весь раунд: один удар — одна смерть", color: "#ef4444" },
  lowgrav: { ...solo, title: "НИЗКАЯ ГРАВИТАЦИЯ", description: "Весь раунд: прыжки до небес", color: "#7dd3fc" },
  builders: { ...solo, title: "СТРОИТЕЛИ", description: "Каждому +30 земли на старте", color: "#d4a373" },
  infection: {
    title: "ЗАРАЖЕНИЕ",
    description: "Зомби заражают ударами. Люди побеждают, если кто-то доживёт до конца",
    color: "#4ade80",
    respawn: true,
    noDamage: false,
    teams: [
      { name: "Люди", color: "#facc15" },
      { name: "Зомби", color: "#4ade80" },
    ],
  },
  koth: { title: "ЦАРЬ ГОРЫ", description: "Стой в центре один: очко в секунду, 60 очков — победа. Возрождение", color: "#fbbf24", respawn: true, noDamage: false, teams: null },
  sumo: { title: "СУМО", description: "Маленький остров, урона нет — только толчки. Упал — выбыл", color: "#f472b6", respawn: false, noDamage: true, teams: null },
  spleef: { title: "СПЛИФ", description: "Два снежных слоя над пропастью: ломай блоки под соперниками", color: "#bae6fd", respawn: false, noDamage: true, teams: null },
  teams: {
    title: "КОМАНДЫ",
    description: "Красные против синих, с возрождением. Первыми набрали нужное число убийств — победа",
    color: "#60a5fa",
    respawn: true,
    noDamage: false,
    teams: [
      { name: "Красные", color: "#ef4444" },
      { name: "Синие", color: "#3b82f6" },
    ],
  },
};
export const BUILDERS_BONUS = 30;
/** Buffs that a mode makes pointless are left out of its roulette. */
export const MODE_SKIPS_BUFFS: Record<GameMode, BuffId[]> = {
  classic: [],
  oneshot: ["oneshot", "berserk", "vampire"],
  lowgrav: ["gravity"],
  builders: [],
  infection: ["oneshot", "bounty", "swap"],
  koth: [],
  sumo: ["oneshot", "vampire", "berserk", "lava", "builder"],
  spleef: ["oneshot", "vampire", "berserk", "lava", "builder", "bounty"],
  teams: [],
};
/** King of the Hill: the hill in the island's centre, and the score that wins. */
export const HILL_RADIUS = 4;
export const HILL_TARGET = 60;
/** Teams: kills per player of the bigger team that win the round. */
export const TEAM_KILLS_PER_PLAYER = 4;
/** Spleef: two snow layers; players start on the upper one. */
export const SPLEEF_LAYERS = [0, 4];

/** Giants and small ones (the giants buff). Collision boxes stay the same; hit boxes, eyes, reach,
 *  speed, damage, health and knockback follow the size. */
export const GIANT_SIZE = 1.6;
export const SMALL_SIZE = 0.6;
export function sizeStats(size: number) {
  if (size > 1.2) return { speed: 0.9, damage: 1.5, maxHp: 30, knockback: 0.6 };
  if (size < 0.8) return { speed: 1.15, damage: 0.75, maxHp: 14, knockback: 1.4 };
  return { speed: 1, damage: 1, maxHp: MAX_HP, knockback: 1 };
}

/** Effective modifiers of the active buffs (several at once in Chaos), the round mode and the
 *  player's size. */
export function buffModifiers(buffs: readonly BuffId[] | null, mode: GameMode | null = null, size = 1) {
  const on = (b: BuffId) => !!buffs && buffs.includes(b);
  return {
    gravity: on("gravity") || mode === "lowgrav" ? 0.35 : 1,
    speed: (on("speed") ? 1.7 : 1) * sizeStats(size).speed,
    damage: on("oneshot") || mode === "oneshot" ? MAX_HP : HIT_DAMAGE,
    berserk: on("berserk"),
    lifesteal: on("vampire"),
    night: on("night"),
    lava: on("lava"),
    knockback: (on("baseball") ? 3 : mode === "sumo" ? 1.5 : 1) * sizeStats(size).knockback,
    /** Upward speed of a hit; the default when 0. */
    launch: on("baseball") ? 12 : 0,
    extraJumps: on("doublejump") ? 1 : 0,
    invisible: on("invisible"),
    ice: on("ice"),
    /** How fast feet on the ground change velocity: ice grips like air. */
    groundAccel: on("ice") ? AIR_ACCEL : GROUND_ACCEL,
  };
}

export type BuffMods = ReturnType<typeof buffModifiers>;

/** Buffs in a round: one per interval from firstBuffMs on, while the round's time lasts. */
export function buffCount(t: Timings): number {
  return Math.max(0, Math.ceil((t.roundMs - t.firstBuffMs) / t.buffIntervalMs));
}

/** When buff `index` (0-based) lands. */
export function buffAt(index: number, t: Timings): number {
  return t.firstBuffMs + index * t.buffIntervalMs;
}

/** Index of the active buff for a moment of the round, -1 before the first one. */
export function buffIndexAt(elapsedMs: number, t: Timings, planLength: number): number {
  if (elapsedMs < t.firstBuffMs) return -1;
  return Math.min(planLength - 1, Math.floor((elapsedMs - t.firstBuffMs) / t.buffIntervalMs));
}

/** Island radius at the start and after each crumble step: spread evenly from shrinkStartMs to
 *  roundMs, then faster through overtime, down to a small platform. */
const CRUMBLE: Partial<Record<GameMode, { start: number; steps: number[]; overtime: number[] }>> & { default: { start: number; steps: number[]; overtime: number[] } } = {
  default: { start: ARENA_RADIUS, steps: [40, 32, 24, 18, FINAL_RING_RADIUS], overtime: [9, 6, 3] },
  sumo: { start: 11, steps: [9, 7], overtime: [5, 3] },
  spleef: { start: 16, steps: [13, 10], overtime: [7, 4] },
};
const crumbleOf = (mode: GameMode) => CRUMBLE[mode] ?? CRUMBLE.default;

export function startRadius(mode: GameMode): number {
  return crumbleOf(mode).start;
}

export interface CrumbleStep {
  /** Time into the round, ms. */
  at: number;
  r: number;
}

export function crumbleSteps(t: Timings, mode: GameMode = "classic"): CrumbleStep[] {
  const c = crumbleOf(mode);
  const gap = (t.roundMs - t.shrinkStartMs) / Math.max(1, c.steps.length - 1);
  const steps = c.steps.map((r, i) => ({ at: t.shrinkStartMs + i * gap, r }));
  const og = t.overtimeMs / (c.overtime.length + 1);
  c.overtime.forEach((r, i) => steps.push({ at: t.roundMs + (i + 1) * og, r }));
  return steps;
}

/** Round clock: time left in the round, or in overtime once the round's time is up. */
export function roundClock(elapsedMs: number, t: Timings): { overtime: boolean; left: number } {
  if (elapsedMs < t.roundMs) return { overtime: false, left: t.roundMs - elapsedMs };
  return { overtime: true, left: Math.max(0, t.roundMs + t.overtimeMs - elapsedMs) };
}

/** Spawn points sit evenly on a circle, each facing the centre (yaw 0 looks towards -Z). */
export function spawnPoint(index: number, count: number, offset: number, radius = SPAWN_RADIUS) {
  const a = offset + (index / count) * Math.PI * 2;
  const x = Math.cos(a) * radius;
  const z = Math.sin(a) * radius;
  return { x, z, yaw: Math.atan2(x, z) };
}

export function cellInRing(x: number, z: number, radius: number): boolean {
  const cx = x + 0.5;
  const cz = z + 0.5;
  return cx * cx + cz * cz <= radius * radius;
}

/** Voxel storage for player-placed blocks (the floor is implicit and unbreakable). */
export class Voxels {
  readonly data = new Uint8Array(GRID * GRID * MAX_HEIGHT);
  readonly filled = new Set<number>();
  /** The floor covers the cells whose centre lies within this radius; past it is a sheer drop.
   *  Infinite in the hub (its edge is a wall), the arena's island crumbles during a round. */
  floorRadius = Infinity;

  static inBounds(x: number, y: number, z: number): boolean {
    return y >= 0 && y < MAX_HEIGHT && cellInRing(x, z, ARENA_RADIUS);
  }

  static index(x: number, y: number, z: number): number {
    return (y * GRID + (z + ARENA_RADIUS)) * GRID + (x + ARENA_RADIUS);
  }

  static decode(i: number): [number, number, number] {
    const x = (i % GRID) - ARENA_RADIUS;
    const z = (Math.floor(i / GRID) % GRID) - ARENA_RADIUS;
    const y = Math.floor(i / (GRID * GRID));
    return [x, y, z];
  }

  get(x: number, y: number, z: number): number {
    return Voxels.inBounds(x, y, z) ? this.data[Voxels.index(x, y, z)] : 0;
  }

  set(x: number, y: number, z: number, v: number): boolean {
    if (!Voxels.inBounds(x, y, z)) return false;
    const i = Voxels.index(x, y, z);
    this.data[i] = v;
    if (v) this.filled.add(i);
    else this.filled.delete(i);
    return true;
  }

  /** Solid for movement: blocks, the floor (y < 0, where there is one) and the ceiling (y >= MAX_HEIGHT). */
  solid(x: number, y: number, z: number): boolean {
    if (y < 0) return cellInRing(x, z, this.floorRadius);
    if (y >= MAX_HEIGHT) return true;
    return this.get(x, y, z) !== 0;
  }

  /** The same blocks (shared storage) over a floor of another radius. */
  overFloor(r: number): Voxels {
    const v = Object.create(this) as Voxels;
    v.floorRadius = r;
    return v;
  }

  clear(): void {
    this.data.fill(0);
    this.filled.clear();
  }

  /** Flat [x, y, z, x, y, z, ...] list of filled cells. */
  toList(): number[] {
    const out: number[] = [];
    for (const i of this.filled) out.push(...Voxels.decode(i));
    return out;
  }

  /** Flat [x, y, z, blockType, ...] list of filled cells. */
  toQuads(): number[] {
    const out: number[] = [];
    for (const i of this.filled) out.push(...Voxels.decode(i), this.data[i]);
    return out;
  }
}

/** Block types (the value stored in Voxels). Players only ever place dirt. */
export const BLOCK = { dirt: 1, stone: 2, planks: 3, gold: 4, obsidian: 5, bricks: 6, bone: 7, snow: 8 } as const;
export const BLOCK_TYPES = 8;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Moves `pos` (the feet) along one axis, testing only the cells the leading face enters (blocks
 *  overlapping the player — e.g. placed at their feet — therefore never teleport them).
 *  Returns true when a solid cell stopped the move. */
export function moveAxis(world: Voxels, pos: Vec3, axis: 0 | 1 | 2, d: number): boolean {
  if (!d) return false;
  const eps = 1e-6;
  const lo = [pos.x - PLAYER_HALF_WIDTH, pos.y, pos.z - PLAYER_HALF_WIDTH];
  const hi = [pos.x + PLAYER_HALF_WIDTH, pos.y + PLAYER_HEIGHT, pos.z + PLAYER_HALF_WIDTH];
  const oldEdge = d > 0 ? hi[axis] : lo[axis];
  lo[axis] += d;
  hi[axis] += d;
  const newEdge = d > 0 ? hi[axis] : lo[axis];
  const range = (k: number): [number, number] => {
    if (k !== axis) return [Math.floor(lo[k]), Math.floor(hi[k] - eps)];
    return d > 0 ? [Math.floor(oldEdge - eps) + 1, Math.floor(newEdge - eps)] : [Math.floor(newEdge), Math.floor(oldEdge) - 1];
  };
  const [x0, x1] = range(0);
  const [y0, y1] = range(1);
  const [z0, z1] = range(2);
  let bound = d > 0 ? Infinity : -Infinity;
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++) {
        if (!world.solid(x, y, z)) continue;
        const c = axis === 0 ? x : axis === 1 ? y : z;
        bound = d > 0 ? Math.min(bound, c) : Math.max(bound, c);
      }
  let v = (axis === 0 ? pos.x : axis === 1 ? pos.y : pos.z) + d;
  const blocked = Number.isFinite(bound);
  if (blocked) {
    if (axis === 1) v = d > 0 ? bound - PLAYER_HEIGHT - 1e-4 : bound + 1;
    else v = d > 0 ? bound - PLAYER_HALF_WIDTH - 1e-4 : bound + 1 + PLAYER_HALF_WIDTH + 1e-4;
  }
  if (axis === 0) pos.x = v;
  else if (axis === 1) pos.y = v;
  else pos.z = v;
  return blocked;
}

export interface Body {
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  jumpsLeft: number;
  jumpHeld: boolean;
  /** Ran into a wall head-on during the last step (ends a sprint). */
  bumped?: boolean;
}

export interface MoveInput {
  /** -1, 0 or 1. */
  forward: number;
  strafe: number;
  jump: boolean;
  yaw: number;
  sprint?: boolean;
}

/** One physics step of the local player. */
export function stepBody(world: Voxels, b: Body, input: MoveInput, dt: number, mods: BuffMods, ringRadius: number): void {
  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  let wx = -sin * input.forward + cos * input.strafe;
  let wz = -cos * input.forward - sin * input.strafe;
  const len = Math.hypot(wx, wz);
  const speed = WALK_SPEED * mods.speed * (input.sprint ? SPRINT_SPEED : 1);
  if (len) {
    wx = (wx / len) * speed;
    wz = (wz / len) * speed;
  }
  const accel = 1 - Math.exp(-(b.onGround ? mods.groundAccel : AIR_ACCEL) * dt);
  b.vel.x += (wx - b.vel.x) * accel;
  b.vel.z += (wz - b.vel.z) * accel;

  // Air jumps refill on the ground and exist only while the double-jump buff lasts.
  b.jumpsLeft = b.onGround ? mods.extraJumps : Math.min(b.jumpsLeft, mods.extraJumps);
  if (input.jump && b.onGround) {
    // A jump never cuts short a knockback launch that is stronger (baseball buff).
    b.vel.y = Math.max(b.vel.y, JUMP_SPEED);
    b.jumpHeld = true;
    if (input.sprint) {
      b.vel.x -= sin * SPRINT_JUMP_BOOST;
      b.vel.z -= cos * SPRINT_JUMP_BOOST;
    }
  } else if (input.jump && !b.jumpHeld && b.jumpsLeft > 0) {
    b.vel.y = JUMP_SPEED;
    b.jumpsLeft--;
    b.jumpHeld = true;
  }
  if (!input.jump) b.jumpHeld = false;
  b.vel.y = Math.max(-MAX_FALL_SPEED, b.vel.y - GRAVITY * mods.gravity * dt);

  const steps = Math.max(1, Math.ceil((Math.max(Math.abs(b.vel.x), Math.abs(b.vel.y), Math.abs(b.vel.z)) * dt) / 0.45));
  b.onGround = false;
  let wall = false;
  for (let i = 0; i < steps; i++) {
    if (moveAxis(world, b.pos, 1, (b.vel.y * dt) / steps)) {
      if (b.vel.y < 0) b.onGround = true;
      b.vel.y = 0;
    }
    if (moveAxis(world, b.pos, 0, (b.vel.x * dt) / steps)) {
      b.vel.x = 0;
      wall = true;
    }
    if (moveAxis(world, b.pos, 2, (b.vel.z * dt) / steps)) {
      b.vel.z = 0;
      wall = true;
    }
  }
  // Minecraft's "minor collision": what's left of the motion after the wall still points within a
  // few degrees of where the player is heading.
  const hv = Math.hypot(b.vel.x, b.vel.z);
  b.bumped = wall && len > 0 && (hv < 1e-4 || (b.vel.x * wx + b.vel.z * wz) / (hv * speed) < Math.cos(SPRINT_WALL_ANGLE));

  const limit = ringRadius - PLAYER_HALF_WIDTH;
  const dist = Math.hypot(b.pos.x, b.pos.z);
  if (dist > limit) {
    b.pos.x *= limit / dist;
    b.pos.z *= limit / dist;
  }
}

/** Unit view vector for yaw/pitch, matching the camera's YXZ rotation (yaw 0 looks towards -Z). */
export function lookDir(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** Distance along a ray to where it enters a box, or null when it misses within maxT. */
export function rayBox(o: Vec3, d: Vec3, min: Vec3, max: Vec3, maxT: number): number | null {
  let t0 = 0;
  let t1 = maxT;
  for (const k of ["x", "y", "z"] as const) {
    if (Math.abs(d[k]) < 1e-9) {
      if (o[k] < min[k] || o[k] > max[k]) return null;
      continue;
    }
    let ta = (min[k] - o[k]) / d[k];
    let tb = (max[k] - o[k]) / d[k];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}

export interface VoxelHit {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  t: number;
  floor: boolean;
}

/** Amanatides–Woo voxel traversal; the floor counts as a hit below y = 0. */
export function raycastVoxels(world: Voxels, origin: Vec3, dir: Vec3, maxDist: number): VoxelHit | null {
  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);
  const sx = Math.sign(dir.x);
  const sy = Math.sign(dir.y);
  const sz = Math.sign(dir.z);
  const dx = sx ? Math.abs(1 / dir.x) : Infinity;
  const dy = sy ? Math.abs(1 / dir.y) : Infinity;
  const dz = sz ? Math.abs(1 / dir.z) : Infinity;
  let tx = sx > 0 ? (x + 1 - origin.x) * dx : sx < 0 ? (origin.x - x) * dx : Infinity;
  let ty = sy > 0 ? (y + 1 - origin.y) * dy : sy < 0 ? (origin.y - y) * dy : Infinity;
  let tz = sz > 0 ? (z + 1 - origin.z) * dz : sz < 0 ? (origin.z - z) * dz : Infinity;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let t = 0;
  for (let i = 0; i < 128; i++) {
    if (tx < ty && tx < tz) {
      x += sx;
      t = tx;
      tx += dx;
      nx = -sx;
      ny = nz = 0;
    } else if (ty < tz) {
      y += sy;
      t = ty;
      ty += dy;
      ny = -sy;
      nx = nz = 0;
    } else {
      z += sz;
      t = tz;
      tz += dz;
      nz = -sz;
      nx = ny = 0;
    }
    if (t > maxDist) return null;
    if (y < 0) return cellInRing(x, z, Math.min(ARENA_RADIUS, world.floorRadius)) ? { x, y, z, nx, ny, nz, t, floor: true } : null;
    if (y < MAX_HEIGHT && world.get(x, y, z)) return { x, y, z, nx, ny, nz, t, floor: false };
  }
  return null;
}

/** True when the segment a→b crosses no solid cell before reaching b or the cell (tx, ty, tz). */
export function segmentClear(world: Voxels, a: Vec3, b: Vec3, tx: number, ty: number, tz: number): boolean {
  const ddx = b.x - a.x;
  const ddy = b.y - a.y;
  const ddz = b.z - a.z;
  let x = Math.floor(a.x);
  let y = Math.floor(a.y);
  let z = Math.floor(a.z);
  const sx = Math.sign(ddx);
  const sy = Math.sign(ddy);
  const sz = Math.sign(ddz);
  const stepX = sx ? Math.abs(1 / ddx) : Infinity;
  const stepY = sy ? Math.abs(1 / ddy) : Infinity;
  const stepZ = sz ? Math.abs(1 / ddz) : Infinity;
  let mx = sx > 0 ? (x + 1 - a.x) * stepX : sx < 0 ? (a.x - x) * stepX : Infinity;
  let my = sy > 0 ? (y + 1 - a.y) * stepY : sy < 0 ? (a.y - y) * stepY : Infinity;
  let mz = sz > 0 ? (z + 1 - a.z) * stepZ : sz < 0 ? (a.z - z) * stepZ : Infinity;
  for (let i = 0; i < 256; i++) {
    if (x === tx && y === ty && z === tz) return true;
    if (world.solid(x, y, z)) return false;
    const next = Math.min(mx, my, mz);
    if (next > 1) return true;
    if (mx === next) {
      x += sx;
      mx += stepX;
    } else if (my === next) {
      y += sy;
      my += stepY;
    } else {
      z += sz;
      mz += stepZ;
    }
  }
  return true;
}

export type SkinId = "steve" | "skeleton" | "zombie" | "knight" | "ninja" | "robot";
export const SKIN_IDS: SkinId[] = ["steve", "skeleton", "zombie", "knight", "ninja", "robot"];
export const SKINS: Record<SkinId, { title: string }> = {
  steve: { title: "Стив" },
  skeleton: { title: "Скелет" },
  zombie: { title: "Зомби" },
  knight: { title: "Рыцарь" },
  ninja: { title: "Ниндзя" },
  robot: { title: "Робот" },
};

/** Where a client is: walking around the hub, or in the arena (playing, dead, or watching). */
export type View = "hub" | "arena";

export interface PlayerInfo {
  id: number;
  name: string;
  color: string;
  skin: SkinId;
  /** "player": takes part in the current round (alive or not). */
  role: Role;
  alive: boolean;
  /** Standing in the hub's ready circle. */
  ready: boolean;
  kills: number;
  /** Won the last round: wears the crown until the next one ends. */
  crown: boolean;
  /** Team index in a team mode (Infection: 0 humans, 1 zombies), else null. */
  team: number | null;
  /** Body size (giants buff): 1 normal. */
  size: number;
  maxHp: number;
  /** King of the Hill points. */
  score: number;
}

// ---------------------------------------------------------------- hub

export type MobKind = "dummy" | "walker" | "cliff" | "archer" | "target";
export const MOB_KINDS: MobKind[] = ["dummy", "walker", "cliff", "archer", "target"];
/** Mob ids start here, so `hit.id` tells players and mobs apart. */
export const MOB_ID_BASE = 1_000_000;
export const MOB_LABELS: Record<MobKind, string> = {
  dummy: "Манекен",
  walker: "Скелет",
  cliff: "Сбей меня!",
  archer: "Лучник",
  target: "Цель",
};

export interface Circle {
  x: number;
  z: number;
  r: number;
}
/** Inclusive cell bounds. */
export interface CellBox {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}
export interface Spot {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export const inCircle = (x: number, z: number, c: Circle) => Math.hypot(x - c.x, z - c.z) <= c.r;
export const inCellBox = (x: number, z: number, b: CellBox, margin = 0) =>
  x >= b.x0 - margin && x < b.x1 + 1 + margin && z >= b.z0 - margin && z < b.z1 + 1 + margin;

/** Yaw that looks from (x, z) towards (tx, tz); yaw 0 looks towards -Z. */
export const yawTowards = (x: number, z: number, tx: number, tz: number) => Math.atan2(-(tx - x), -(tz - z));

/** Parkour pillars as [cellX, cellZ, height]; the last one is the 3×3 golden finish. */
const PARKOUR_STEPS: [number, number, number][] = [
  [-19, -32, 1],
  [-21, -33, 2],
  [-24, -33, 2],
  [-26, -32, 3],
  [-28, -30, 3],
  [-30, -30, 4],
  [-33, -29, 4],
  [-34, -27, 5],
  [-35, -24, 5],
  [-35, -22, 6],
  [-34, -19, 6],
  [-32, -18, 7],
  [-29, -17, 7],
  [-27, -16, 8],
];

/** Layout of the hub: a big round plaza (same size as the arena) with a zone per activity. */
export const HUB = {
  spawn: { x: 0.5, z: 10.5, r: 3 } as Circle,
  /** Winner's podium: cells x -1..1, z -5..-3, two blocks high. */
  pedestal: { x: 0.5, y: 2, z: -3.5, yaw: 0 } as Spot,
  ready: { x: 0.5, z: -18.5, r: 4.5 } as Circle,
  portal: { x: 0.5, z: -26.5 },
  votes: {
    classic: { x: -10.5, z: -13.5, r: 2.2 },
    oneshot: { x: -10.5, z: -19.5, r: 2.2 },
    lowgrav: { x: -10.5, z: -25.5, r: 2.2 },
    builders: { x: -16.5, z: -13.5, r: 2.2 },
    spleef: { x: -16.5, z: -19.5, r: 2.2 },
    infection: { x: 11.5, z: -13.5, r: 2.2 },
    koth: { x: 11.5, z: -19.5, r: 2.2 },
    teams: { x: 11.5, z: -25.5, r: 2.2 },
    sumo: { x: 17.5, z: -13.5, r: 2.2 },
  } as Record<GameMode, Circle>,
  wardrobe: { x: -9.5, z: 6.5, r: 3.5 } as Circle,
  /** Big boards: centre, size, and `rotY` for a PlaneGeometry (default normal +Z): the arena board
   *  faces +Z (towards the spawn), the records board faces +X. */
  boards: {
    arena: { x: 0.5, y: 13, z: -26.9, rotY: 0, w: 16, h: 8 },
    records: { x: -13.9, y: 3.5, z: 0.5, rotY: Math.PI / 2, w: 9, h: 6 },
  },
  dummies: [
    { x: 18.5, y: 0, z: -4.5, yaw: Math.PI / 2 },
    { x: 18.5, y: 0, z: 0.5, yaw: Math.PI / 2 },
    { x: 18.5, y: 0, z: 5.5, yaw: Math.PI / 2 },
  ] as Spot[],
  /** Walker pen: walls on these cells, interior inside them, gate on the west side. */
  pen: { x0: 25, x1: 35, z0: -8, z1: 8 } as CellBox,
  penGate: [-1, 0],
  archer: { x: 30.5, y: 4, z: -24.5, yaw: 0 } as Spot,
  archerZone: { x: 30.5, z: -24.5, r: 12 } as Circle,
  /** Raised platform (top at y = h) with stairs down on the east side. */
  cliff: { x0: -34, x1: -26, z0: -4, z1: 4, h: 5 },
  cliffMobs: [
    { x: -33.1, y: 5, z: -1.5, yaw: -Math.PI / 2 },
    { x: -33.1, y: 5, z: 2.5, yaw: -Math.PI / 2 },
  ] as Spot[],
  /** Shooting range field (inside its low wall) and the pad that starts a run. */
  range: { x0: -10, x1: 10, z0: 24, z1: 36 } as CellBox,
  rangeStart: { x: 0.5, z: 26.5, r: 1.5 } as Circle,
  parkourStart: { x: -17.5, z: -29.5, r: 1.5 } as Circle,
  parkourSteps: PARKOUR_STEPS,
  parkourFinish: { x0: -25, x1: -23, z0: -17, z1: -15, h: 9 },
  /** Free-build area: placed blocks vanish after a while. */
  build: { x0: -31, x1: -18, z0: 15, z1: 28 } as CellBox,
  buildMaxY: 10,
  /** Duel pit: walls on these cells, interior inside. */
  duel: { x0: 14, x1: 26, z0: 18, z1: 30 } as CellBox,
  duelSpots: [
    { x: 16.5, y: 0, z: 24.5, yaw: -Math.PI / 2 },
    { x: 24.5, y: 0, z: 24.5, yaw: Math.PI / 2 },
  ] as Spot[],
  duelExit: { x: 20.5, y: 0, z: 15.5, yaw: 0 } as Spot,
};

/** All blocks of the hub as [x, y, z, type, ...]. The server owns the hub; clients get it as a world. */
export function hubBlocks(): number[] {
  const v = new Voxels();
  const fill = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, t: number) => {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) v.set(x, y, z, t);
  };
  const ring = (b: CellBox, y0: number, y1: number, t: number) => {
    fill(b.x0, b.x1, y0, y1, b.z0, b.z0, t);
    fill(b.x0, b.x1, y0, y1, b.z1, b.z1, t);
    fill(b.x0, b.x0, y0, y1, b.z0, b.z1, t);
    fill(b.x1, b.x1, y0, y1, b.z0, b.z1, t);
  };

  // Winner's podium.
  fill(-1, 1, 0, 0, -5, -3, BLOCK.stone);
  fill(-1, 1, 1, 1, -5, -3, BLOCK.gold);

  // Portal frame behind the ready circle.
  fill(-3, -3, 0, 8, -27, -27, BLOCK.obsidian);
  fill(3, 3, 0, 8, -27, -27, BLOCK.obsidian);
  fill(-3, 3, 8, 8, -27, -27, BLOCK.obsidian);
  // Board wall above the portal.
  fill(-8, 8, 9, 17, -28, -28, BLOCK.bricks);

  // Wardrobe: a plank wall with two posts.
  fill(-12, -7, 0, 2, 4, 4, BLOCK.planks);
  fill(-12, -12, 0, 1, 5, 5, BLOCK.planks);
  fill(-7, -7, 0, 1, 5, 5, BLOCK.planks);

  // Records board wall.
  fill(-15, -15, 0, 6, -4, 5, BLOCK.bricks);

  // Walker pen with a gate on the west side.
  ring(HUB.pen, 0, 1, BLOCK.stone);
  for (const z of HUB.penGate) fill(HUB.pen.x0, HUB.pen.x0, 0, 1, z, z, 0);

  // Archer tower.
  fill(30, 30, 0, 3, -25, -25, BLOCK.stone);
  fill(29, 31, 3, 3, -26, -24, BLOCK.bone);

  // Cliff with stairs on the east side.
  const c = HUB.cliff;
  fill(c.x0, c.x1, 0, c.h - 1, c.z0, c.z1, BLOCK.stone);
  for (let i = 1; i < c.h; i++) fill(c.x1 + i, c.x1 + i, 0, c.h - 1 - i, -1, 1, BLOCK.planks);

  // Shooting range: low wall with an opening to the north.
  const r = HUB.range;
  ring({ x0: r.x0 - 1, x1: r.x1 + 1, z0: r.z0 - 1, z1: r.z1 + 1 }, 0, 0, BLOCK.bricks);
  fill(-2, 2, 0, 0, r.z0 - 1, r.z0 - 1, 0);

  // Parkour pillars and the golden finish.
  for (const [x, z, h] of PARKOUR_STEPS) fill(x, x, 0, h - 1, z, z, BLOCK.stone);
  const f = HUB.parkourFinish;
  fill(f.x0, f.x1, 0, f.h - 2, f.z0, f.z1, BLOCK.stone);
  fill(f.x0, f.x1, f.h - 1, f.h - 1, f.z0, f.z1, BLOCK.gold);

  // Duel pit: walls two blocks high, a bench around them for spectators.
  ring(HUB.duel, 0, 1, BLOCK.stone);
  const d = HUB.duel;
  ring({ x0: d.x0 - 1, x1: d.x1 + 1, z0: d.z0 - 1, z1: d.z1 + 1 }, 0, 0, BLOCK.planks);

  return v.toQuads();
}

export interface BagInfo {
  id: number;
  x: number;
  y: number;
  z: number;
  dirt: number;
}

export type ClientMsg =
  | { t: "hello"; name: string; v: number; color?: string; skin?: SkinId }
  /** `vy`: vertical velocity; `ts`: the client's physics clock (ms); `n`: last applied `tp`;
   *  `k`: last knockback (`hurt.kn`) applied to the player; `tk`: last `tick` received, i.e. how
   *  much of the game (buffs, blocks, ring) the client knew about when it moved; `sp`: sprinting. */
  | { t: "move"; x: number; y: number; z: number; yaw: number; pitch: number; vy: number; ts: number; n: number; k: number; tk: number; sp?: boolean }
  /** `tk`: the last `tick` received, so the server can rewind to what the attacker saw. */
  | { t: "hit"; id: number; yaw: number; pitch: number; tk: number }
  | { t: "place"; x: number; y: number; z: number }
  | { t: "break"; x: number; y: number; z: number }
  /** Round-trip measurement for the ping shown in the HUD; answered with `pong`. */
  | { t: "ping"; id: number }
  /** Hub: watch the arena round (on) or go back to the hub (off). */
  | { t: "watch"; on: boolean }
  /** Wardrobe: shirt colour and skin. */
  | { t: "look"; color: string; skin: SkinId }
  /** Challenge a player in the hub to a duel; the other side answers with `duelAnswer`. */
  | { t: "duel"; id: number }
  | { t: "duelAnswer"; accept: boolean }
  /** Bows buff: shoot an arrow along this view (from the server's position for the player). */
  | { t: "shoot"; yaw: number; pitch: number; tk: number }
  /** An eliminated player votes for the next buff (index into `buffVote.options`). */
  | { t: "buffVote"; i: number };

export interface DailyRecords {
  /** Moscow date, YYYY-MM-DD. */
  day: string;
  wins: [string, number][];
  kills: [string, number][];
  /** Shooting range: most targets in one run. */
  range: [string, number][];
  /** Parkour: fastest time, ms. */
  parkour: [string, number][];
}

/** `fall`: off the island; `lava`; `boom`: a bomb or a meteor. */
export type KillReason = "kill" | "leave" | "fall" | "lava" | "boom";

export interface RoundResult {
  mode: GameMode;
  winner: number | null;
  winnerName: string | null;
  /** See the `phase` message. */
  pointsWin: boolean;
  /** Winning team in a team mode (the winner is its best player). */
  team: number | null;
  /** Ordered by finishing place. */
  rows: { id: number; name: string; color: string; kills: number; damage: number; crits: number; blocks: number; score: number; team: number | null }[];
  awards: { title: string; name: string; color: string; value: string }[];
}

export interface TrainStats {
  hits: number;
  crits: number;
  combo: number;
  best: number;
  /** Damage per second over the last 5 s. */
  dps: number;
  kills: number;
  knocked: number;
  dodged: number;
  arrowHits: number;
}

export type ServerMsg =
  | { t: "welcome"; id: number }
  | { t: "roster"; players: PlayerInfo[] }
  | {
      t: "phase";
      phase: Phase;
      elapsed: number;
      timings: Timings;
      /** Active buffs: one, two in the Chaos finale, none before the first. */
      buffs: BuffId[];
      mode: GameMode;
      winner: number | null;
      winnerName: string | null;
      /** Overtime ran out with several players alive: the best of them won on points. */
      pointsWin: boolean;
      /** Current radius of the arena's island. */
      floor: number;
      winTeam: number | null;
    }
  | { t: "buff"; buffs: BuffId[] }
  /** The world the client is now in, as [x, y, z, type, ...]; a `tp` into it follows. */
  | { t: "world"; w: View; blocks: number[] }
  | { t: "block"; w: View; x: number; y: number; z: number; v: number }
  /** `s`: tick number. `p`: flat [id, x, y, z, yaw, pitch, hp, ...] for the players this client may see
   *  in its world. Hub only: `m` mobs [id, kindIndex, x, y, z, yaw, hp, maxHp, ...] and `a` arrows
   *  [id, x, y, z, vx, vy, vz, ...]. */
  | { t: "tick"; s: number; p: number[]; m?: number[]; a?: number[] }
  /** `respawnIn`: ms until the player is back (respawn modes), 0 otherwise. */
  | { t: "you"; hp: number; maxHp: number; dirt: number; arrows: number; alive: boolean; role: Role; watching: boolean; respawnIn: number }
  /** Authoritative position; `yaw` only on spawn, server corrections keep the player's view. */
  | { t: "tp"; x: number; y: number; z: number; n: number; yaw?: number }
  /** `kn`: the victim's knockback number (0 without knockback), echoed back in `move.k`. */
  | { t: "hurt"; id: number; by: number; hp: number; dmg: number; crit: boolean; kx: number; ky: number; kz: number; kn: number; arrow?: boolean }
  | { t: "roulette"; buffs: BuffId[]; ms: number }
  /** `fall`: off the island; `killer` is whoever knocked the victim off, if anyone. */
  | { t: "kill"; victim: number; killer: number | null; reason: KillReason }
  /** The arena's island: `r` its radius now; `next`/`ms` the radius it crumbles to and when (warning). */
  | { t: "floor"; r: number; next: number | null; ms: number }
  /** Big announcement over the arena (first blood, kill streaks, overtime). */
  | { t: "callout"; text: string; sub: string; color: string }
  /** Lava buff: height of the lava's surface (-1: none). */
  | { t: "lava"; y: number }
  /** Bounty buff: the hunted player. */
  | { t: "bounty"; id: number | null }
  /** Hot potato: who holds the bomb and how long until it goes off. */
  | { t: "bomb"; holder: number | null; ms: number }
  /** A meteor lands at x, y, z in `ms` (radius `r`). */
  | { t: "meteor"; id: number; x: number; y: number; z: number; r: number; ms: number }
  | { t: "boom"; x: number; y: number; z: number; r: number; kind: "bomb" | "meteor" }
  /** Mode scores: team kills (Teams) or survivors per team (Infection), the target, King of the
   *  Hill's holder (null: nobody or contested). */
  | { t: "score"; teams: number[]; target: number; hill: number | null; contested: boolean }
  /** Eliminated players choose the next buff; `options` empty when no vote is open. */
  | { t: "buffVote"; options: BuffId[]; votes: number[]; ms: number; mine: number | null }
  | { t: "bags"; bags: BagInfo[] }
  | { t: "pong"; id: number }
  /** Lobby state, sent to everyone a few times a second. `startIn`: ms until the round starts (null:
   *  waiting for players); `votes` in MODE_IDS order. */
  | { t: "hub"; startIn: number | null; ready: number; active: number; need: number; votes: number[]; myVote: GameMode | null; inRound: number }
  | { t: "train"; s: TrainStats }
  /** A short tip for the player (why a hit didn't count, how to crit…). */
  | { t: "hint"; text: string }
  /** Shooting range run. `ms`: time left (countdown/running). */
  | { t: "range"; state: "idle" | "countdown" | "running" | "done"; ms: number; score: number; best: number }
  /** Parkour run. `ms`: time so far (running) or final time (done). */
  | { t: "parkour"; state: "idle" | "ready" | "running" | "done"; ms: number; best: number | null }
  | { t: "duelInvite"; from: number }
  /** Duel state. `ms`: countdown left or fight time left. */
  | { t: "duel"; state: "none" | "countdown" | "fight" | "over"; opponent: number; ms: number; won: boolean | null }
  /** An arrow hit the player (no damage, it's training). */
  | { t: "arrowHit" }
  | { t: "records"; r: DailyRecords }
  | { t: "results"; r: RoundResult }
  /** Hub-wide news line (duel results, records, round winner). */
  | { t: "notice"; text: string; color: string };

export const PLAYER_COLORS = [
  "#e74c3c", "#3498db", "#2ecc71", "#f1c40f", "#9b59b6", "#e67e22",
  "#1abc9c", "#ff6b9d", "#95a5a6", "#34495e", "#8e44ad", "#16a085",
];
