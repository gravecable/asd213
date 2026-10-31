"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { BUFFS, HILL_TARGET, HOT_STREAK, MAX_HP, MAX_PLAYERS, MIN_PLAYERS, MODES, MODE_IDS, PLAYER_COLORS, SKINS, SKIN_IDS, buffAt, buffCount, buffIndexAt, roundClock } from "@/game/shared";
import type { BuffId, GameMode, PlayerInfo, SkinId, TrainStats } from "@/game/shared";
import { Engine, SENS_MAX, SENS_MIN } from "@/game/client/engine";
import { createStore, initialUi } from "@/game/client/store";
import type { UiState } from "@/game/client/store";
import { hairFor, skinFaceUrl } from "@/game/client/skins";
import { dirtIconUrl } from "@/game/client/textures";
import { sfx } from "@/game/client/sound";
import "./pvp.css";

const NAME_KEY = "pvp-name";

/** The engine calls this UI relies on; typed locally so the HUD does not depend on the engine's other members. */
type EngineApi = {
  join(name: string): void;
  reconnect(): void;
  toggleMute(): void;
  setSens(v: number): void;
  setLook(color: string, skin: SkinId): void;
  setWardrobe(open: boolean): void;
  setHelp(open: boolean): void;
  answerDuel(accept: boolean): void;
  toggleWatch(): void;
  vote(i: number): void;
};

interface HudActions {
  toggleMute(): void;
  setSens(v: number): void;
  setLook(color: string, skin: SkinId): void;
  setWardrobe(open: boolean): void;
  setHelp(open: boolean): void;
  answerDuel(accept: boolean): void;
  vote(i: number): void;
}

function useNow(interval = 200) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), interval);
    return () => clearInterval(id);
  }, [interval]);
  return now;
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const fmtTenths = (ms: number) => (Math.max(0, ms) / 1000).toFixed(1);

function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`pvp-panel ${className}`}>{children}</div>;
}

function McButton({ children, onClick, tone = "stone", className = "", disabled }: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "stone" | "green" | "red";
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button type={onClick ? "button" : "submit"} onClick={onClick} disabled={disabled} className={`pvp-btn pvp-btn-${tone} ${className}`}>
      {children}
    </button>
  );
}

const CONTROLS: [string, string][] = [
  ["WASD", "ходьба"],
  ["W W", "спринт (дважды быстро)"],
  ["Пробел", "прыжок"],
  ["Мышь", "обзор"],
  ["ЛКМ", "удар / сломать блок"],
  ["ПКМ", "поставить землю"],
  ["Прыжок + удар", "крит ×1.5"],
  ["Q", "выстрел (баф «Луки»)"],
  ["1 / 2 / 3", "голос за баф (выбывшим)"],
  ["V", "вид от 1-го / 3-го лица"],
  ["T", "смотреть арену / в лобби"],
  ["E", "гардероб"],
  ["F", "вызвать на дуэль"],
  ["Y / N", "принять / отказать"],
  ["H", "помощь"],
  ["M", "звук вкл/выкл"],
];

function Controls({ className = "grid-cols-2" }: { className?: string }) {
  return (
    <ul className={`grid gap-x-4 gap-y-1 text-sm text-white/80 ${className}`}>
      {CONTROLS.map(([k, v]) => (
        <li key={k}>
          <span className="pvp-key">{k}</span> {v}
        </li>
      ))}
    </ul>
  );
}

function SensSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-3 text-sm text-white/85">
      <span className="shrink-0">Чувствительность мыши</span>
      <input
        type="range"
        min={SENS_MIN}
        max={SENS_MAX}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1 accent-[#ffde59]"
      />
      <b className="w-12 shrink-0 text-right tabular-nums text-[#ffde59]">{value.toFixed(2)}×</b>
    </label>
  );
}

function JoinScreen({ onJoin, sens, onSens }: { onJoin: (name: string) => void; sens: number; onSens: (v: number) => void }) {
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/35 p-4">
      <Panel className="max-h-full w-full max-w-xl overflow-y-auto">
        <h1 className="pvp-title text-center text-3xl text-[#ffde59] md:text-4xl">БЛОК-АРЕНА</h1>
        <p className="mt-2 text-center text-white/85">
          PvP до последнего выжившего · {MIN_PLAYERS}–{MAX_PLAYERS} игроков
        </p>
        <form
          className="mt-5 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim().slice(0, 16);
            localStorage.setItem(NAME_KEY, n);
            onJoin(n);
          }}
        >
          <input
            autoFocus
            value={name}
            maxLength={16}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ваш ник"
            aria-label="Ник"
            className="pvp-input flex-1"
          />
          <McButton tone="green">Играть</McButton>
        </form>
        <div className="mt-3">
          <SensSlider value={sens} onChange={onSens} />
        </div>
        <ul className="mt-5 space-y-1 text-sm text-white/80">
          <li>• Между раундами ты ходишь по лобби: тренируйся на скелетах, стреляй в тире, бегай паркур, дуэлься, меняй облик в гардеробе.</li>
          <li>• Раунд стартует сам: через 60 с, когда в лобби двое, или через 10 с, если больше половины встали в зелёный круг у портала.</li>
          <li>• Режим выбирают голосованием — встань на одну из 9 цветных площадок.</li>
          <li>• На арене у каждого 10 блоков земли и меч. Убитый теряет всё. Удар в падении — крит ×1.5, строить можно до 20 блоков.</li>
          <li>• Выбыл — смотришь до конца раунда. Потом все возвращаются в лобби, победитель получает корону.</li>
          <li>• Раунд — 6 минут: первый баф на 30-й секунде, дальше новый каждую минуту.</li>
          <li>• Край острова — обрыв. Упал — выбыл; если тебя сбросили ударом, убийство засчитают сбросившему.</li>
          <li>• С 2-й минуты остров осыпается с краёв: красные клетки скоро рухнут вместе с блоками на них.</li>
          <li>• После 6:00 — овертайм: любой удар убивает, регенерации нет. Через минуту побеждает лучший по убийствам и урону.</li>
          <li>• Последний баф раунда — «Хаос»: два сразу. Выбывшие голосуют за следующий баф клавишами 1–3.</li>
        </ul>
        <div className="mt-4">
          <Controls />
        </div>
      </Panel>
    </div>
  );
}

const HEART_ROWS = [".XX.XX.", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..."];

function Heart({ fill }: { fill: 0 | 1 | 2 }) {
  return (
    <svg viewBox="-0.5 -0.5 8 7" className="h-6 w-6" shapeRendering="crispEdges" aria-hidden>
      {HEART_ROWS.flatMap((row, y) =>
        [...row].map((c, x) =>
          c === "X" ? (
            <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill === 2 || (fill === 1 && x <= 3) ? "#e11d48" : "#3f3f46"} stroke="#000" strokeWidth={0.12} />
          ) : null,
        ),
      )}
    </svg>
  );
}

/** Ten hearts; extra health (giants, vampire kills) adds golden ones. */
function Hearts({ hp, max = MAX_HP }: { hp: number; max?: number }) {
  return (
    <div className="flex max-w-[22rem] flex-wrap justify-center gap-0.5" aria-label={`Здоровье ${hp} из ${max}`}>
      {Array.from({ length: Math.ceil(max / 2) }, (_, i) => {
        const v = hp - i * 2;
        return (
          <span key={i} className={i >= MAX_HP / 2 ? "pvp-heart-gold" : ""}>
            <Heart fill={v >= 2 ? 2 : v === 1 ? 1 : 0} />
          </span>
        );
      })}
    </div>
  );
}

function ModeBadge({ mode }: { mode: GameMode }) {
  const m = MODES[mode];
  return (
    <span className="pvp-badge" style={{ borderColor: m.color, color: m.color }}>
      {m.title}
    </span>
  );
}

// ---------------------------------------------------------------- arena

/** Team score, survivors or the hill, depending on the mode. */
function ModeScore({ ui }: { ui: UiState }) {
  const sc = ui.score;
  const def = MODES[ui.mode];
  if (!sc) return null;
  if (def.teams && sc.teams.length === 2) {
    const [a, b] = def.teams;
    return (
      <Panel className="!px-3 !py-1.5 text-lg tabular-nums">
        <b style={{ color: a.color }}>{a.name}</b> <b className="text-2xl">{sc.teams[0]}</b> : <b className="text-2xl">{sc.teams[1]}</b> <b style={{ color: b.color }}>{b.name}</b>
        {sc.target > 0 && <span className="ml-2 text-sm text-white/70">до {sc.target}</span>}
      </Panel>
    );
  }
  if (ui.mode === "koth") {
    const holder = ui.players.find((p) => p.id === sc.hill);
    return (
      <Panel className="!px-3 !py-1.5 text-base">
        Холм:{" "}
        {sc.contested ? (
          <b className="pvp-pulse text-red-400">оспаривается</b>
        ) : holder ? (
          <b style={{ color: holder.color }}>{holder.name}</b>
        ) : (
          <span className="text-white/70">свободен</span>
        )}
        <span className="ml-2 text-sm text-white/70">до {HILL_TARGET} очков</span>
      </Panel>
    );
  }
  return null;
}

function TopBar({ ui, now }: { ui: UiState; now: number }) {
  const elapsed = Math.max(0, now - ui.phaseStartedAt);
  const t = ui.timings;
  const participants = ui.players.filter((p) => p.role === "player");
  const alive = participants.filter((p) => p.alive).length;
  const clock = roundClock(elapsed, t);
  const index = buffIndexAt(elapsed, t, buffCount(t));
  const nextBuff = index + 1;
  // The current buff lasts until the next one, or (the Chaos finale) to the end of overtime.
  const buffEnds = nextBuff < buffCount(t) ? buffAt(nextBuff, t) : t.roundMs + t.overtimeMs;
  const buffLeft = index >= 0 ? Math.max(0, Math.min(1, (buffEnds - elapsed) / (buffEnds - buffAt(index, t)))) : 0;
  const crumble = ui.phase === "playing" ? ui.crumble : null;
  const respawn = MODES[ui.mode].respawn;
  const color = ui.buffs.length ? BUFFS[ui.buffs[0]].color : "#ffffff";
  return (
    <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 flex-col items-center gap-1.5">
      <div className="flex items-center gap-3">
        <Panel className={`pvp-title !px-4 !py-2 text-xl ${clock.overtime ? "pvp-pulse text-red-400" : ""}`}>
          {clock.overtime ? `ОВЕРТАЙМ ${fmt(clock.left)}` : fmt(clock.left)}
        </Panel>
        {respawn ? (
          <ModeScore ui={ui} />
        ) : (
          <Panel className="!px-3 !py-1.5 text-lg">
            Живых <b className="text-[#7CFC00]">{alive}</b>/{participants.length}
          </Panel>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
        {ui.mode !== "classic" && <ModeBadge mode={ui.mode} />}
        {ui.buffs.length > 1 && <span className="pvp-badge pvp-pulse border-fuchsia-400 text-fuchsia-300">ХАОС</span>}
        {ui.buffs.length ? (
          ui.buffs.map((b) => (
            <span key={b} className="pvp-badge" style={{ borderColor: BUFFS[b].color, color: BUFFS[b].color }}>
              {BUFFS[b].title}
            </span>
          ))
        ) : (
          <span className="pvp-badge border-white/40 text-white/70">без бафа</span>
        )}
        {crumble ? (
          <span className="pvp-badge pvp-pulse border-red-400 text-red-300">Край рухнет через {fmt(crumble.at - now)}!</span>
        ) : clock.overtime ? (
          <span className="pvp-badge pvp-pulse border-red-400 text-red-300">{MODES[ui.mode].noDamage ? "Остров рушится" : "Любой удар убивает"}</span>
        ) : nextBuff < buffCount(t) ? (
          <span className="bg-black/45 px-2 py-0.5 text-white">новый баф через {fmt(buffAt(nextBuff, t) - elapsed)}</span>
        ) : null}
      </div>
      {index >= 0 && ui.buffs.length > 0 && (
        <div className="h-1.5 w-56 overflow-hidden bg-black/50" title="Сколько осталось бафу">
          <div className="h-full transition-[width] duration-200" style={{ width: `${buffLeft * 100}%`, background: color, boxShadow: `0 0 8px ${color}` }} />
        </div>
      )}
    </div>
  );
}

/** Icons next to a name: team role, size, bounty, bomb. */
function playerTags(ui: UiState, p: PlayerInfo): string {
  const tags: string[] = [];
  if (ui.mode === "infection" && p.team === 1) tags.push("🧟");
  if (p.size > 1.2) tags.push("⬆");
  if (p.size < 0.8) tags.push("⬇");
  if (ui.bounty === p.id) tags.push("🎯");
  if (ui.bomb?.holder === p.id) tags.push("💣");
  return tags.join("");
}

function Scoreboard({ ui }: { ui: UiState }) {
  const teams = MODES[ui.mode].teams;
  const participants = ui.players
    .filter((p) => p.role === "player")
    .sort((a, b) => (teams ? (a.team ?? 0) - (b.team ?? 0) : 0) || (ui.mode === "koth" ? b.score - a.score : 0));
  const respawn = MODES[ui.mode].respawn;
  return (
    <div className="pointer-events-none absolute left-3 top-3 w-48 space-y-0.5 text-sm">
      {participants.map((p) => (
        <div
          key={p.id}
          className={`flex items-center gap-1.5 bg-black/35 px-2 py-0.5 ${p.alive ? "" : respawn ? "opacity-60" : "opacity-45 line-through"}`}
          style={teams && p.team !== null ? { borderLeft: `3px solid ${teams[p.team].color}` } : undefined}
        >
          <span className="h-2.5 w-2.5 shrink-0" style={{ background: p.color }} />
          <span className="flex-1 truncate">{p.name}</span>
          <span>{playerTags(ui, p)}</span>
          {ui.mode === "koth" && <span className="text-[#fbbf24]">★{p.score}</span>}
          {p.kills >= HOT_STREAK && !respawn ? <span className="text-orange-400">🔥{p.kills}</span> : <span className="text-white/70">⚔{p.kills}</span>}
        </div>
      ))}
    </div>
  );
}

const DEATH_TEXT: Record<string, [string, string]> = {
  fall: ["сбросил", "упал с острова"],
  lava: ["утопил в лаве", "сгорел в лаве"],
  boom: ["взорвал", "взорвался"],
};

function KillFeed({ ui, now }: { ui: UiState; now: number }) {
  const items = ui.feed.filter((f) => now - f.at < 7000);
  return (
    <div className="pointer-events-none absolute right-3 top-3 flex flex-col items-end gap-1 text-sm">
      {items.map((f) => {
        const [withKiller, alone] = DEATH_TEXT[f.reason] ?? ["⚔", "погиб"];
        const verb = f.reason === "kill" && ui.mode === "infection" ? "заразил" : withKiller;
        return (
          <div key={f.key} className="pvp-feed bg-black/45 px-2 py-1">
            {f.reason === "leave" || !f.killer ? (
              <>
                <span style={{ color: f.victim.color }}>{f.victim.name}</span> <span className="text-white/70">{f.reason === "leave" ? "вышел" : alone}</span>
              </>
            ) : (
              <>
                <span style={{ color: f.killer.color }}>{f.killer.name}</span> <span className="text-white/70">{verb}</span>{" "}
                <span style={{ color: f.victim.color }}>{f.victim.name}</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Announcement({ buffs }: { buffs: BuffId[] }) {
  const chaos = buffs.length > 1;
  const color = chaos ? "#e879f9" : BUFFS[buffs[0]].color;
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
      <div className="pvp-flash absolute inset-0" style={{ background: `radial-gradient(circle at center, ${color}aa 0%, transparent 65%)` }} />
      <div className="pvp-sub pvp-outline relative text-base tracking-[0.5em] text-white/90">{chaos ? "ХАОС · ДВА БАФА СРАЗУ" : "НОВЫЙ БАФ"}</div>
      {buffs.map((id) => {
        const b = BUFFS[id];
        return (
          <div key={id} className="relative">
            <div className="pvp-shake relative">
              <div className={`pvp-announce relative px-4 ${chaos ? "text-3xl md:text-5xl" : "text-4xl md:text-6xl"}`} style={{ color: b.color, textShadow: `0 0 28px ${b.color}, 5px 5px 0 #000` }}>
                {b.title}
              </div>
            </div>
            <div className={`pvp-sub pvp-outline relative px-6 ${chaos ? "mt-1 text-lg md:text-xl" : "mt-4 text-xl md:text-2xl"}`}>{b.description}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Each buff tints the screen's edges in its colour; night darkens them. */
function BuffTint({ buffs }: { buffs: BuffId[] }) {
  if (!buffs.length) return null;
  const night = buffs.includes("night");
  const color = night ? "#000010" : BUFFS[buffs[0]].color;
  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{ background: `radial-gradient(ellipse at center, transparent ${night ? 30 : 55}%, ${color}${night ? "e6" : "40"} 100%)` }}
    />
  );
}

/** The bomb: a big warning for its holder, a small line for everyone else. */
function BombBanner({ ui, now }: { ui: UiState; now: number }) {
  const b = ui.bomb;
  if (!b) return null;
  const left = Math.max(0, b.endsAt - now);
  const holder = ui.players.find((p) => p.id === b.holder);
  if (b.holder === ui.myId) {
    return (
      <div className="pointer-events-none absolute inset-x-0 top-[22%] flex flex-col items-center text-center">
        <div className="pvp-pulse pvp-title text-3xl text-orange-400 md:text-4xl" style={{ textShadow: "0 0 18px #f97316, 3px 3px 0 #000" }}>
          💣 У ТЕБЯ БОМБА! {fmtTenths(left)}
        </div>
        <div className="pvp-outline mt-2 text-lg">Ударь соперника, чтобы передать её</div>
      </div>
    );
  }
  return (
    <div className="pointer-events-none absolute left-1/2 top-[7.5rem] -translate-x-1/2 bg-black/55 px-3 py-1 text-base">
      💣 бомба у <b style={{ color: holder?.color ?? "#fff" }}>{holder?.name ?? "?"}</b> · <span className={left < 5000 ? "text-red-400" : ""}>{fmtTenths(left)}</span>
    </div>
  );
}

/** First blood, kill streaks, overtime: a short banner under the top bar. */
function Callout({ c }: { c: NonNullable<UiState["callout"]> }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[24%] flex flex-col items-center text-center">
      <div className="pvp-announce-in pvp-title px-4 text-3xl md:text-5xl" style={{ color: c.color, textShadow: `0 0 24px ${c.color}, 4px 4px 0 #000` }}>
        {c.text}
      </div>
      {c.sub && <div className="pvp-outline mt-3 px-6 text-lg md:text-xl">{c.sub}</div>}
    </div>
  );
}

/** Big centred number (or word) that re-animates whenever `text` changes. */
function BigCount({ text, sub }: { text: string; sub?: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3">
      {sub && <div className="pvp-outline px-4 text-center text-xl">{sub}</div>}
      <div key={text} className="pvp-count pvp-title text-8xl text-[#ffde59]">
        {text}
      </div>
    </div>
  );
}

function Countdown({ ui, now }: { ui: UiState; now: number }) {
  const elapsed = Math.max(0, now - ui.phaseStartedAt);
  if (ui.phase === "countdown") {
    return <BigCount text={String(Math.max(1, Math.ceil((ui.timings.countdownMs - elapsed) / 1000)))} sub="Высадка на арену!" />;
  }
  if (ui.phase === "playing" && elapsed < 1200) return <BigCount text="БОЙ!" />;
  return null;
}

/** Eliminated players choose the next buff (keys 1–3 or a click). */
function VotePanel({ ui, now, onVote }: { ui: UiState; now: number; onVote: (i: number) => void }) {
  const v = ui.vote;
  if (!v) return null;
  return (
    <div className="pointer-events-auto flex flex-col items-center gap-1.5">
      <div className="pvp-outline text-base text-[#ffde59]">Выбери следующий баф · {fmt(v.endsAt - now)}</div>
      <div className="flex flex-wrap justify-center gap-2">
        {v.options.map((id, i) => {
          const b = BUFFS[id];
          const mine = v.mine === i;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onVote(i)}
              className="pvp-panel w-44 !px-2 !py-1.5 text-left"
              style={{ borderColor: mine ? b.color : undefined, boxShadow: mine ? `0 0 12px ${b.color}` : undefined }}
            >
              <div className="flex items-center justify-between text-sm">
                <span className="pvp-key">{i + 1}</span>
                <span className="text-white/80">голосов: {v.votes[i] ?? 0}</span>
              </div>
              <div className="mt-0.5 text-sm" style={{ color: b.color }}>
                {b.title}
              </div>
              <div className="text-[11px] leading-tight text-white/70">{b.description}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SpectatorBar({ ui, now, onVote }: { ui: UiState; now: number; onVote: (i: number) => void }) {
  const s = ui.spectate;
  const modeName = s?.mode === "first" ? "1-е лицо" : s?.mode === "third" ? "3-е лицо" : "свободная камера";
  const respawning = !ui.watching && ui.respawnAt > now;
  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2 text-center">
      {!ui.watching && <VotePanel ui={ui} now={now} onVote={onVote} />}
      <Panel className="!py-2">
        <div className="text-lg text-[#ffde59]">
          {ui.watching ? "Вы смотрите раунд" : respawning ? `Возрождение через ${Math.ceil((ui.respawnAt - now) / 1000)}…` : "Вы выбыли — наблюдение"}
        </div>
        <div className="text-white/90">
          {s?.target && s.mode !== "free" ? (
            <>
              Смотрите за <b>{s.target}</b> · {modeName}
            </>
          ) : (
            modeName
          )}
        </div>
        {!respawning && (
          <div className="mt-1 text-sm text-white/90">
            <span className="pvp-key">T</span> вернуться в лобби
          </div>
        )}
        <div className="mt-1 text-xs text-white/65">
          <span className="pvp-key">V</span> режим · <span className="pvp-key">Q</span>/<span className="pvp-key">E</span> или ЛКМ/ПКМ — игрок ·{" "}
          <span className="pvp-key">WASD</span> <span className="pvp-key">Пробел</span>/<span className="pvp-key">Shift</span> — полёт
        </div>
      </Panel>
    </div>
  );
}

function EndScreen({ ui, now }: { ui: UiState; now: number }) {
  const left = ui.timings.endMs - Math.max(0, now - ui.phaseStartedAt);
  const winner = ui.players.find((p) => p.id === ui.winnerId);
  const res = ui.results;
  const rows = res?.rows.slice(0, 8) ?? [];
  const winTeam = ui.winTeam !== null ? MODES[ui.mode].teams?.[ui.winTeam] : undefined;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 p-4">
      <Panel className="max-h-full w-full max-w-xl overflow-y-auto text-center !p-4">
        {ui.winnerName ? (
          <>
            <div className="text-base tracking-[0.4em] text-white/80">ПОБЕДИТЕЛЬ</div>
            <div className="pvp-announce-in pvp-title mt-2 text-3xl md:text-4xl" style={{ color: winner?.color ?? "#ffde59" }}>
              {ui.winnerName}
            </div>
            {ui.winnerId === ui.myId && <div className="mt-1 text-2xl text-[#7CFC00]">Это вы!</div>}
            {winTeam && (
              <div className="mt-2 text-xl" style={{ color: winTeam.color }}>
                {winTeam.name} победили · корона лучшему в команде
              </div>
            )}
            {!winTeam && (ui.pointsWin || res?.pointsWin) && <div className="mt-2 text-sm text-white/80">Овертайм закончился — победил лучший по убийствам и урону</div>}
          </>
        ) : (
          <div className="pvp-title text-2xl text-white">Никто не выжил</div>
        )}
        {res && res.mode !== "classic" && (
          <div className="mt-2 text-sm">
            <ModeBadge mode={res.mode} />
          </div>
        )}
        {res && res.awards.length > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-1.5 text-left text-sm">
            {res.awards.map((a) => (
              <div key={a.title} className="bg-black/35 px-2 py-1">
                <div className="text-xs text-[#ffde59]">{a.title}</div>
                <div className="truncate">
                  <b style={{ color: a.color }}>{a.name}</b> <span className="text-white/70">{a.value}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        {rows.length > 0 && (
          <table className="mt-3 w-full text-left text-sm tabular-nums">
            <thead>
              <tr className="text-xs text-white/55">
                <th className="w-6 py-0.5 font-bold">#</th>
                <th className="font-bold">Игрок</th>
                <th className="w-12 text-right font-bold">⚔</th>
                <th className="w-16 text-right font-bold">Урон</th>
                <th className="w-14 text-right font-bold">Криты</th>
                <th className="w-14 text-right font-bold">Блоки</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} className={r.id === ui.myId ? "bg-white/10" : "odd:bg-black/20"}>
                  <td className="py-0.5 pl-1 text-white/60">{i + 1}</td>
                  <td className="max-w-0 truncate">
                    <span className="mr-1.5 inline-block h-2.5 w-2.5" style={{ background: r.color }} />
                    {r.name}
                  </td>
                  <td className="text-right">{r.kills}</td>
                  <td className="text-right">{Math.round(r.damage)}</td>
                  <td className="text-right">{r.crits}</td>
                  <td className="pr-1 text-right">{r.blocks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-3 text-sm text-white/60">Возврат в лобби через {Math.max(0, Math.ceil(left / 1000))} с</div>
      </Panel>
    </div>
  );
}

const REEL_ITEM_H = 46;

/** Slot-machine reel that decelerates onto the next buff, timed to land just before it activates. */
function Roulette({ r }: { r: NonNullable<UiState["roulette"]> }) {
  const reelRef = useRef<HTMLDivElement>(null);
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    let raf = 0;
    let last = -1;
    const start = r.endsAt - r.duration;
    const n = r.items.length - 1;
    const loop = () => {
      const u = Math.min(1, Math.max(0, (performance.now() - start) / r.duration));
      const p = n * (1 - Math.pow(1 - u, 3));
      if (reelRef.current) reelRef.current.style.transform = `translateY(${-p * REEL_ITEM_H}px)`;
      const idx = Math.round(p);
      if (idx !== last) {
        if (last >= 0) sfx.rouletteTick(u);
        last = idx;
      }
      if (u >= 1) {
        sfx.rouletteStop();
        setLanded(true);
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [r]);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[17%] flex flex-col items-center">
      <div className="pvp-outline mb-2 text-sm tracking-[0.4em] text-white/90">СЛЕДУЮЩИЙ БАФ</div>
      <div className={`pvp-reel ${landed ? "pvp-reel-landed" : ""}`} style={{ height: REEL_ITEM_H * 3 }}>
        <div ref={reelRef} style={{ paddingTop: REEL_ITEM_H }}>
          {r.items.map((b, i) => (
            <div key={i} className="pvp-title flex items-center justify-center text-lg" style={{ height: REEL_ITEM_H, color: BUFFS[b].color }}>
              {BUFFS[b].title}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DeathBanner({ d }: { d: NonNullable<UiState["death"]> }) {
  return (
    <div className="pvp-death pointer-events-none absolute inset-0 flex flex-col items-center justify-center pt-[22vh] text-center">
      <div className="pvp-title text-4xl text-[#ff4d4d] md:text-5xl">{d.fall ? "ВЫ УПАЛИ" : "ВЫ ПОГИБЛИ"}</div>
      {d.killer && (
        <div className="pvp-outline mt-5 text-xl">
          {d.fall ? "Вас сбросил" : "Вас убил"} <span style={{ color: d.color ?? "#fff" }}>{d.killer}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- hub

function leadingMode(votes: Record<GameMode, number>): GameMode | null {
  let best: GameMode | null = null;
  for (const m of MODE_IDS) if ((votes[m] ?? 0) > 0 && (best === null || votes[m] > votes[best])) best = m;
  return best;
}

function HubStatus({ ui, now }: { ui: UiState; now: number }) {
  if (ui.phase === "ended") {
    const winner = ui.players.find((p) => p.id === ui.winnerId);
    return (
      <Panel className="!px-4 !py-2 text-center text-lg">
        {ui.winnerName ? (
          <>
            Победил{" "}
            <b key={ui.winnerId} className="pvp-announce-in inline-block" style={{ color: winner?.color ?? "#ffde59" }}>
              {ui.winnerName}
            </b>
          </>
        ) : (
          "Никто не выжил"
        )}
      </Panel>
    );
  }

  if (ui.phase !== "lobby") {
    const participants = ui.players.filter((p) => p.role === "player");
    const alive = participants.filter((p) => p.alive).length;
    const clock = ui.phase === "playing" ? roundClock(Math.max(0, now - ui.phaseStartedAt), ui.timings) : { overtime: false, left: ui.timings.roundMs };
    return (
      <Panel className="!px-4 !py-2 text-center">
        <div className="text-base">
          Идёт раунд · <b style={{ color: MODES[ui.mode].color }}>{MODES[ui.mode].title}</b> · {clock.overtime ? "овертайм " : ""}
          {fmt(clock.left)} · живых{" "}
          <b className="text-[#7CFC00]">{alive}</b>/{participants.length}
        </div>
        <div className="text-sm text-white/85">
          <span className="pvp-key">T</span> смотреть
        </div>
        <div className="text-sm text-[#ffde59]">Вы в очереди на следующий раунд</div>
      </Panel>
    );
  }

  const hub = ui.hub;
  if (!hub) return null;
  const lead = leadingMode(hub.votes);
  const myVote = hub.myVote ? MODES[hub.myVote] : null;
  return (
    <Panel className="!px-4 !py-2 text-center">
      <div className="pvp-title text-sm text-[#ffde59] md:text-base">
        {hub.startAt !== null ? `Старт через ${fmt(hub.startAt - now)}` : `Ждём игроков: нужно ещё ${Math.max(0, hub.need - hub.active)}`}
      </div>
      <div className="mt-1.5 text-sm text-white/90">
        Готовы{" "}
        <b className="text-[#7CFC00]">
          {hub.ready}/{hub.active}
        </b>{" "}
        — встань в зелёный круг у портала
      </div>
      <div className="text-sm text-white/90">
        {lead ? (
          <>
            Лидирует: <b style={{ color: MODES[lead].color }}>{MODES[lead].title}</b>
          </>
        ) : (
          <span className="text-white/70">Голосуй за режим на цветных площадках</span>
        )}
        {myVote && (
          <span className="text-white/70">
            {" "}
            (твой голос: <b style={{ color: myVote.color }}>{myVote.title}</b>)
          </span>
        )}
      </div>
    </Panel>
  );
}

/** Range, parkour and duel panels stacked under the hub status. */
function HubActivity({ ui, now }: { ui: UiState; now: number }) {
  const { range, parkour, duel } = ui;
  const opp = duel ? ui.players.find((p) => p.id === duel.opponent) : undefined;
  return (
    <>
      {range?.state === "running" && (
        <Panel className="!px-4 !py-1.5 text-center">
          <span className="pvp-title text-sm text-[#ffde59]">ТИР {fmt(range.endsAt - now)}</span> · очки <b className="text-[#7CFC00]">{range.score}</b>
        </Panel>
      )}
      {range?.state === "done" && now - range.at < 5000 && (
        <Panel className="!px-4 !py-1.5 text-center">
          Результат <b className="text-[#7CFC00]">{range.score}</b> · лучший сегодня <b>{range.best}</b>
        </Panel>
      )}
      {parkour?.state === "ready" && <Panel className="!px-4 !py-1.5 text-center">Беги! Таймер стартует, когда сойдёшь с круга</Panel>}
      {parkour?.state === "running" && (
        <Panel className="!px-4 !py-1.5 text-center">
          <span className="pvp-title text-sm text-[#ffde59]">ПАРКУР {fmtTenths(now - parkour.startedAt)} с</span>
        </Panel>
      )}
      {parkour?.state === "done" && now - parkour.at < 6000 && (
        <Panel className="!px-4 !py-1.5 text-center">
          Финиш: <b className="text-[#7CFC00]">{fmtTenths(parkour.time)} с</b>
          {parkour.best !== null && (
            <>
              {" "}
              · лучшее сегодня <b>{fmtTenths(parkour.best)} с</b>
            </>
          )}
        </Panel>
      )}
      {duel?.state === "fight" && (
        <Panel className="!px-4 !py-1.5 text-center">
          <span className="pvp-title text-sm text-[#ffde59]">ДУЭЛЬ</span> · <b style={{ color: opp?.color ?? "#fff" }}>{opp?.name ?? "соперник"}</b> · {fmt(duel.endsAt - now)}
        </Panel>
      )}
    </>
  );
}

/** Centred big numbers and verdicts: range / duel countdown, duel result. */
function HubCenter({ ui, now }: { ui: UiState; now: number }) {
  const { range, duel } = ui;
  const opp = duel ? ui.players.find((p) => p.id === duel.opponent) : undefined;
  if (range?.state === "countdown") return <BigCount text={String(Math.max(1, Math.ceil((range.endsAt - now) / 1000)))} sub="Тир" />;
  if (duel?.state === "countdown") {
    return <BigCount text={String(Math.max(1, Math.ceil((duel.endsAt - now) / 1000)))} sub={`Дуэль с ${opp?.name ?? "соперником"}`} />;
  }
  if (duel?.state === "over" && now - duel.at < 4000) {
    const [text, color] = duel.won === null ? ["Ничья", "#ffffff"] : duel.won ? ["ПОБЕДА!", "#7CFC00"] : ["Поражение", "#ff4d4d"];
    return (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div key={duel.at} className="pvp-announce-in pvp-title text-4xl md:text-5xl" style={{ color, textShadow: "4px 4px 0 #000" }}>
          {text}
        </div>
      </div>
    );
  }
  return null;
}

function TrainPanel({ t }: { t: TrainStats }) {
  const pct = t.hits > 0 ? Math.round((t.crits / t.hits) * 100) : 0;
  const rows: [string, string | number][] = [
    ["Удары", t.hits],
    ["Криты", `${t.crits} (${pct}%)`],
    ["Серия", `${t.combo} · макс ${t.best}`],
    ["Урон/с", t.dps.toFixed(1)],
    ["Скелетов побеждено", t.kills],
    ["Сбито с обрыва", t.knocked],
    ["Стрелы: уклонился / попаданий", `${t.dodged} / ${t.arrowHits}`],
  ];
  return (
    <div className="pvp-train pointer-events-none absolute bottom-3 left-3 w-[19rem] px-3 py-2 text-xs">
      <div className="pvp-title mb-1 text-[0.65rem] text-[#ffde59]">ТРЕНИРОВКА</div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-white/70">{k}</dt>
            <dd className="text-right tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Notices({ ui, now, className }: { ui: UiState; now: number; className: string }) {
  const items = ui.notices.filter((n) => now - n.at < 6000).slice(-5);
  if (items.length === 0) return null;
  return (
    <div className={`pointer-events-none absolute right-3 flex max-w-60 flex-col items-end gap-1 text-sm ${className}`}>
      {items.map((n) => (
        <div key={n.key} className="pvp-feed bg-black/55 px-2 py-1 text-right" style={{ color: n.color }}>
          {n.text}
        </div>
      ))}
    </div>
  );
}

function InvitePrompt({ ui, onAnswer }: { ui: UiState; onAnswer: (accept: boolean) => void }) {
  const from = ui.players.find((p) => p.id === ui.invite?.from);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[30%] flex justify-center px-4">
      <Panel className="pointer-events-auto !px-4 !py-3 text-center">
        <div className="text-lg">
          <b style={{ color: from?.color ?? "#fff" }}>{from?.name ?? "Игрок"}</b> вызывает на дуэль
        </div>
        <div className="mt-3 flex justify-center gap-3">
          <McButton tone="green" className="!px-4 !py-2" onClick={() => onAnswer(true)}>
            Принять [Y]
          </McButton>
          <McButton tone="red" className="!px-4 !py-2" onClick={() => onAnswer(false)}>
            Отказать [N]
          </McButton>
        </div>
      </Panel>
    </div>
  );
}

function Wardrobe({ look, myId, onLook, onClose }: { look: UiState["look"]; myId: number | null; onLook: (color: string, skin: SkinId) => void; onClose: () => void }) {
  // Each skin's face in the chosen colour (Steve's hair follows the player's id, as in game).
  const faces = useMemo(() => Object.fromEntries(SKIN_IDS.map((id) => [id, skinFaceUrl(id, look.color, hairFor(myId ?? 0))])), [look.color, myId]);
  return (
    <div className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-black/55 p-4">
      <Panel className="pvp-panel-solid max-h-full w-full max-w-md overflow-y-auto">
        <h2 className="pvp-title text-center text-2xl text-[#ffde59]">ГАРДЕРОБ</h2>
        <div className="mt-4 text-sm text-white/75">Цвет</div>
        <div className="mt-2 grid grid-cols-6 gap-2">
          {PLAYER_COLORS.map((c) => {
            const on = look.color.toLowerCase() === c;
            return (
              <button
                key={c}
                type="button"
                aria-label={`Цвет ${c}`}
                aria-pressed={on}
                onClick={() => onLook(c, look.skin)}
                className={`pvp-swatch ${on ? "pvp-swatch-on" : ""}`}
                style={{ background: c }}
              />
            );
          })}
        </div>
        <div className="mt-4 text-sm text-white/75">Облик</div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {SKIN_IDS.map((id) => (
            <button key={id} type="button" aria-pressed={look.skin === id} onClick={() => onLook(look.color, id)} className={`pvp-chip pvp-skin-chip ${look.skin === id ? "pvp-chip-on" : ""}`}>
              <span className="pvp-skin-face" style={{ backgroundImage: `url(${faces[id]})` }} aria-hidden />
              {SKINS[id].title}
            </button>
          ))}
        </div>
        <div className="mt-5 flex items-center justify-between gap-3">
          <span className="text-xs text-white/60">
            <span className="pvp-key">Esc</span> — закрыть
          </span>
          <McButton tone="green" onClick={onClose}>
            Готово
          </McButton>
        </div>
      </Panel>
    </div>
  );
}

const HELP_ITEMS: [string, string][] = [
  ["Зелёный круг у портала", "Встань в него: когда в круге больше половины игроков, раунд начнётся через 10 с. Иначе старт через 60 с после того, как в лобби двое."],
  ["Цветные площадки", "Голосование за режим. Встань на площадку — режим с наибольшим числом голосов сыграют в раунде."],
  ["Спринт", "Дважды быстро нажми W, как в Minecraft. Бег быстрее на 30%, с прыжками ещё быстрее. Спринт сбивается, если отпустить W, врезаться в стену или ударить. Удар с разбега отбрасывает сильнее, но не критует."],
  ["Скелеты", "Манекены, ходячие скелеты, «Сбей меня!» на обрыве и лучник — его стрелы безвредны, учись уворачиваться. Статистика слева внизу."],
  ["Тир", "Встань на стартовую площадку: 30 секунд попадай по мишеням, каждая — очко. Лучший результат дня запоминается."],
  ["Паркур", "Встань на круг и беги: таймер стартует, когда сойдёшь с него, и останавливается на финише."],
  ["Дуэли", "Посмотри на игрока и нажми F. Соперник отвечает Y или N. Бой идёт в яме, до первой смерти."],
  ["Гардероб", "Подойди и нажми E: выбери цвет и облик."],
  ["Стройка", "Ставь блоки (ПКМ) на площадке для строительства — со временем они исчезают."],
  ["Раунд", "Нажми T, чтобы смотреть арену из лобби. После раунда все возвращаются сюда, победитель стоит на пьедестале в короне."],
  ["Бафы", "Каждую минуту — новый, в конце раунда «Хаос» из двух. Выбывшие выбирают следующий баф клавишами 1–3. «Луки»: Q — выстрел, у каждого 5 стрел."],
];

function Help({ onClose, sens, onSens }: { onClose: () => void; sens: number; onSens: (v: number) => void }) {
  return (
    <div className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-black/55 p-4">
      <Panel className="pvp-panel-solid flex max-h-full w-full max-w-3xl flex-col !p-4">
        <h2 className="pvp-title text-center text-2xl text-[#ffde59]">ПОМОЩЬ</h2>
        <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1">
          <ul className="grid gap-x-5 gap-y-1.5 text-[13px] leading-snug text-white/85 md:grid-cols-2">
            {HELP_ITEMS.map(([title, text]) => (
              <li key={title}>
                <b className="text-[#ffde59]">{title}.</b> {text}
              </li>
            ))}
          </ul>
          <div className="mt-2 text-[13px] leading-snug text-white/85">
            <b className="text-[#ffde59]">Режимы.</b>{" "}
            {MODE_IDS.map((m, i) => (
              <span key={m}>
                {i > 0 && " · "}
                <b style={{ color: MODES[m].color }}>{MODES[m].title}</b> — {MODES[m].description}
              </span>
            ))}
          </div>
          <div className="mt-2">
            <Controls className="grid-cols-2 md:grid-cols-3" />
          </div>
          <div className="mt-3">
            <SensSlider value={sens} onChange={onSens} />
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-white/60">
            <span className="pvp-key">H</span> / <span className="pvp-key">Esc</span> — закрыть
          </span>
          <McButton tone="green" onClick={onClose}>
            Закрыть
          </McButton>
        </div>
      </Panel>
    </div>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="h-5 w-5" aria-hidden>
      <path d="M2 6h3l4-3v10l-4-3H2z" fill="#fff" />
      {muted ? (
        <path d="M11 5.5l4 5M15 5.5l-4 5" stroke="#ff6b6b" strokeWidth="1.6" />
      ) : (
        <path d="M11 5.5c1 .8 1 4.2 0 5M13 4c2 1.5 2 6.5 0 8" stroke="#fff" strokeWidth="1.4" fill="none" />
      )}
    </svg>
  );
}

function Hud({ ui, dirtIcon, actions }: { ui: UiState; dirtIcon: string; actions: HudActions }) {
  const now = useNow(100);
  const arena = ui.view === "arena" || ui.watching;
  const playing = ui.phase === "playing" || ui.phase === "countdown";
  const inRound = arena && playing;
  const spectating = inRound && (ui.watching || !ui.alive);
  const overlay = ui.wardrobe || ui.help;
  const duelActive = ui.duel?.state === "countdown" || ui.duel?.state === "fight";
  const showCrosshair = !overlay && (arena ? inRound && ui.alive && !ui.watching : true);
  const showLockHint = !ui.locked && !overlay && (arena ? inRound && !(spectating && ui.vote) : true);
  return (
    <>
      {ui.hurtKey > 0 && <div key={ui.hurtKey} className="pvp-hurt pointer-events-none absolute inset-0" />}
      {ui.arrowKey > 0 && <div key={`a${ui.arrowKey}`} className="pvp-arrow-flash pointer-events-none absolute inset-0" />}
      {inRound && ui.phase === "playing" && <BuffTint buffs={ui.buffs} />}
      {inRound && ui.alive && !ui.watching && ui.lava >= 0 && <div className="pvp-lava pointer-events-none absolute inset-0" />}

      {!arena && (
        <>
          <div className="pointer-events-none absolute left-1/2 top-3 flex w-max max-w-[min(32rem,56vw)] -translate-x-1/2 flex-col items-center gap-2">
            <HubStatus ui={ui} now={now} />
            <HubActivity ui={ui} now={now} />
          </div>
          <div className="pointer-events-none absolute left-3 top-3 bg-black/45 px-2 py-1 text-sm">
            <span className="pvp-key">H</span> помощь
          </div>
          {ui.train && <TrainPanel t={ui.train} />}
          <HubCenter ui={ui} now={now} />
          {ui.hint && now - ui.hint.at < 3000 && (
            <div key={ui.hint.key} className="pvp-toast pointer-events-none absolute inset-x-0 top-[56%] flex justify-center px-4">
              <span className="pvp-outline bg-black/55 px-3 py-1.5 text-center text-lg">{ui.hint.text}</span>
            </div>
          )}
          {ui.invite && now - ui.invite.at < 15000 && <InvitePrompt ui={ui} onAnswer={actions.answerDuel} />}
          {!duelActive && !overlay && (ui.duelTarget || ui.nearWardrobe) && (
            <div className="pointer-events-none absolute bottom-5 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1.5 text-lg">
              {ui.duelTarget && (
                <span className="pvp-outline bg-black/55 px-3 py-1">
                  <span className="pvp-key">F</span> вызвать <b style={{ color: ui.players.find((p) => p.id === ui.duelTarget?.id)?.color ?? "#fff" }}>{ui.duelTarget.name}</b> на дуэль
                </span>
              )}
              {ui.nearWardrobe && (
                <span className="pvp-outline bg-black/55 px-3 py-1">
                  <span className="pvp-key">E</span> гардероб
                </span>
              )}
            </div>
          )}
          {duelActive && (
            <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2">
              <div key={ui.hurtKey} className={ui.hurtKey ? "pvp-heart-shake" : ""}>
                <Hearts hp={ui.hp} />
              </div>
            </div>
          )}
          <Notices ui={ui} now={now} className="top-3" />
        </>
      )}

      {inRound && (
        <>
          <TopBar ui={ui} now={now} />
          <Scoreboard ui={ui} />
          <KillFeed ui={ui} now={now} />
          <Notices ui={ui} now={now} className="top-[34%]" />
          <Countdown ui={ui} now={now} />
          {ui.roulette && ui.phase === "playing" && <Roulette key={ui.roulette.key} r={ui.roulette} />}
          {ui.announce && ui.phase === "playing" && now - ui.announce.at < 4000 && <Announcement key={ui.announce.key} buffs={ui.announce.buffs} />}
          {ui.phase === "playing" && <BombBanner ui={ui} now={now} />}
          {ui.callout && ui.phase === "playing" && now - ui.callout.at < 3000 && <Callout key={ui.callout.key} c={ui.callout} />}
        </>
      )}

      {inRound && ui.alive && !ui.watching && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
          <div key={ui.hurtKey} className={ui.hurtKey ? "pvp-heart-shake" : ""}>
            <Hearts hp={ui.hp} max={ui.maxHp} />
          </div>
          {ui.arrows > 0 && (
            <div className="pvp-outline bg-black/45 px-2 py-0.5 text-lg">
              🏹 <b className="tabular-nums">{ui.arrows}</b> · <span className="pvp-key">Q</span> выстрел
            </div>
          )}
          <div className="pvp-slot flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={dirtIcon} alt="" className="h-9 w-9 [image-rendering:pixelated]" />
            <span className="pvp-outline text-2xl tabular-nums">{ui.dirt}</span>
          </div>
        </div>
      )}

      {showCrosshair && <div className="pvp-crosshair pointer-events-none absolute left-1/2 top-1/2" />}

      {spectating && !ui.watching && ui.death && now - ui.death.at < 3200 && <DeathBanner key={ui.death.key} d={ui.death} />}
      {spectating && <SpectatorBar ui={ui} now={now} onVote={actions.vote} />}

      {showLockHint && (
        <div className="pointer-events-none absolute inset-x-0 top-[66%] text-center">
          <span className="pvp-outline bg-black/45 px-3 py-1.5 text-lg">Кликните по экрану, чтобы управлять мышью</span>
        </div>
      )}

      {ui.ping !== null && (
        <div className="pvp-outline pointer-events-none absolute bottom-3.5 right-[4.75rem] bg-black/45 px-2 py-0.5 text-sm" title="Задержка до игрового сервера">
          Пинг <b style={{ color: ui.ping < 80 ? "#7CFC00" : ui.ping < 160 ? "#facc15" : "#ff7b7b" }}>{ui.ping}</b> мс
        </div>
      )}

      <button
        type="button"
        onClick={actions.toggleMute}
        className="pvp-mute absolute bottom-3 right-3"
        aria-label={ui.muted ? "Включить звук" : "Выключить звук"}
        title="Звук (M)"
      >
        <SpeakerIcon muted={ui.muted} />
        <span className="text-xs text-white/70">M</span>
      </button>

      {arena && ui.phase === "ended" && <EndScreen ui={ui} now={now} />}
      {ui.wardrobe && <Wardrobe look={ui.look} myId={ui.myId} onLook={actions.setLook} onClose={() => actions.setWardrobe(false)} />}
      {ui.help && <Help onClose={() => actions.setHelp(false)} sens={ui.sens} onSens={actions.setSens} />}
    </>
  );
}

export default function PvpGame() {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [store] = useState(() => createStore(initialUi()));
  const [dirtIcon] = useState(() => dirtIconUrl());
  const ui = useSyncExternalStore(store.subscribe, store.get, store.get);

  useEffect(() => {
    const engine = new Engine(hostRef.current!, store);
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [store]);

  const api = () => engineRef.current as unknown as EngineApi | null;
  const actions: HudActions = {
    toggleMute: () => api()?.toggleMute(),
    setSens: (v) => api()?.setSens(v),
    setLook: (color, skin) => api()?.setLook(color, skin),
    setWardrobe: (open) => api()?.setWardrobe(open),
    setHelp: (open) => api()?.setHelp(open),
    answerDuel: (accept) => api()?.answerDuel(accept),
    vote: (i) => api()?.vote(i),
  };

  return (
    <div className="pvp-root fixed inset-0 select-none overflow-hidden bg-black text-white">
      <div ref={hostRef} className="absolute inset-0" />
      {ui.conn === "idle" && <JoinScreen onJoin={(name) => api()?.join(name)} sens={ui.sens} onSens={actions.setSens} />}
      {ui.conn === "connecting" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Panel className="text-xl">Подключение к серверу…</Panel>
        </div>
      )}
      {ui.conn === "closed" && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 p-4">
          <Panel className="max-w-md text-center">
            <div className="text-2xl text-[#ff7b7b]">{ui.closeReason ? "Отключено сервером" : "Нет связи с игровым сервером"}</div>
            <p className="mt-2 text-sm text-white/75">{ui.closeReason ?? "Сервер не запущен или соединение оборвалось."}</p>
            <McButton className="mt-4" onClick={() => api()?.reconnect()}>
              Переподключиться
            </McButton>
          </Panel>
        </div>
      )}
      {ui.conn === "open" && <Hud ui={ui} dirtIcon={dirtIcon} actions={actions} />}
    </div>
  );
}
