import { ARENA_RADIUS, makeTimings } from "../shared";
import type { BuffId, DailyRecords, GameMode, KillReason, Phase, PlayerInfo, Role, RoundResult, SkinId, Timings, TrainStats, View } from "../shared";

export type SpecMode = "free" | "first" | "third";

export interface FeedItem {
  key: number;
  at: number;
  killer: { name: string; color: string } | null;
  victim: { name: string; color: string };
  reason: KillReason;
}

export interface Notice {
  key: number;
  at: number;
  text: string;
  color: string;
}

/** Times below are performance.now() based unless noted. */
export interface UiState {
  conn: "idle" | "connecting" | "open" | "closed";
  /** Why the server dropped us (kick, ban, outdated client); null for plain network loss. */
  closeReason: string | null;
  /** Last measured round trip to the game server, ms. */
  ping: number | null;
  myId: number | null;
  /** Which world we are in: the hub (lobby) or the arena (playing, dead, or watching). */
  view: View;
  /** In the hub but watching the arena round (T). */
  watching: boolean;
  phase: Phase;
  /** performance.now() at which the current phase started. */
  phaseStartedAt: number;
  timings: Timings;
  /** Mode of the current (or last) round. */
  mode: GameMode;
  players: PlayerInfo[];
  /** Active buffs: one, two in the Chaos finale. */
  buffs: BuffId[];
  announce: { buffs: BuffId[]; key: number; at: number } | null;
  /** Reel of buff names; the last item is the buff that will land at `endsAt`. */
  roulette: { key: number; items: BuffId[]; endsAt: number; duration: number } | null;
  maxHp: number;
  /** Bow arrows left (bows buff). */
  arrows: number;
  /** When we come back (respawn modes), 0 if not dead or not coming back. */
  respawnAt: number;
  /** Lava buff: height of the lava's surface, -1 without lava. */
  lava: number;
  /** Bounty buff: the hunted player. */
  bounty: number | null;
  /** Hot potato: holder and when it goes off; `total`: the full fuse. */
  bomb: { holder: number; endsAt: number; total: number } | null;
  /** Mode scores (Teams, Infection, King of the Hill). */
  score: { teams: number[]; target: number; hill: number | null; contested: boolean } | null;
  /** Buff vote for eliminated players. */
  vote: { options: BuffId[]; votes: number[]; endsAt: number; mine: number | null } | null;
  /** Winning team of the last round (team modes). */
  winTeam: number | null;
  hp: number;
  dirt: number;
  alive: boolean;
  role: Role;
  winnerId: number | null;
  winnerName: string | null;
  pointsWin: boolean;
  /** Radius of the arena's island, and the radius it crumbles to at `at` (warning shown). */
  floor: number;
  crumble: { next: number; at: number } | null;
  /** Big announcement over the arena: first blood, kill streaks, overtime. */
  callout: { key: number; text: string; sub: string; color: string; at: number } | null;
  feed: FeedItem[];
  spectate: { mode: SpecMode; target: string | null } | null;
  death: { key: number; killer: string | null; color: string | null; fall: boolean; at: number } | null;
  locked: boolean;
  muted: boolean;
  /** Mouse sensitivity multiplier. */
  sens: number;
  hurtKey: number;

  // ---- hub
  /** Lobby: `startAt` is when the round starts (null: waiting for players). */
  hub: { startAt: number | null; ready: number; active: number; need: number; votes: Record<GameMode, number>; myVote: GameMode | null; inRound: number } | null;
  /** Training stats against the skeletons; null until the first hit/arrow. */
  train: TrainStats | null;
  hint: { key: number; text: string; at: number } | null;
  /** Shooting range run: `endsAt` = end of countdown/run; `score` so far; `best` today's personal best. */
  range: { state: "idle" | "countdown" | "running" | "done"; endsAt: number; score: number; best: number; at: number } | null;
  /** Parkour run: `startedAt` (running) or final `time` ms (done); `best` today's personal best. */
  parkour: { state: "idle" | "ready" | "running" | "done"; startedAt: number; time: number; best: number | null; at: number } | null;
  /** Active duel: `endsAt` = countdown end (countdown) or time limit (fight). */
  duel: { state: "countdown" | "fight" | "over"; opponent: number; endsAt: number; won: boolean | null; at: number } | null;
  /** Incoming duel challenge. */
  invite: { from: number; at: number } | null;
  /** Hit by an archer's arrow: bumps to flash the screen. */
  arrowKey: number;
  records: DailyRecords | null;
  /** Results of the last round (shown on the end screen and the hub board). */
  results: RoundResult | null;
  notices: Notice[];
  /** Overlays. */
  help: boolean;
  wardrobe: boolean;
  /** Standing close enough to the wardrobe to open it (E). */
  nearWardrobe: boolean;
  /** Player looked at in the hub who can be challenged (F). */
  duelTarget: { id: number; name: string } | null;
  /** Chosen look, saved in localStorage. */
  look: { color: string; skin: SkinId };
}

export const initialUi = (): UiState => ({
  conn: "idle",
  closeReason: null,
  ping: null,
  myId: null,
  view: "hub",
  watching: false,
  phase: "lobby",
  phaseStartedAt: 0,
  timings: makeTimings(),
  mode: "classic",
  players: [],
  buffs: [],
  announce: null,
  roulette: null,
  maxHp: 20,
  arrows: 0,
  respawnAt: 0,
  lava: -1,
  bounty: null,
  bomb: null,
  score: null,
  vote: null,
  winTeam: null,
  hp: 20,
  dirt: 0,
  alive: false,
  role: "spectator",
  winnerId: null,
  winnerName: null,
  pointsWin: false,
  floor: ARENA_RADIUS,
  crumble: null,
  callout: null,
  feed: [],
  spectate: null,
  death: null,
  locked: false,
  muted: false,
  sens: 1,
  hurtKey: 0,
  hub: null,
  train: null,
  hint: null,
  range: null,
  parkour: null,
  duel: null,
  invite: null,
  arrowKey: 0,
  records: null,
  results: null,
  notices: [],
  help: false,
  wardrobe: false,
  nearWardrobe: false,
  duelTarget: null,
  look: { color: "#e74c3c", skin: "steve" },
});

export interface Store<T> {
  get(): T;
  set(patch: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
