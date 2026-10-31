// Daily leaderboards (Moscow day), kept in memory and saved to a JSON file so restarts keep them.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DailyRecords } from "../src/game/shared.ts";

type Kind = "wins" | "kills" | "range" | "parkour";

interface Saved {
  day: string;
  wins: Record<string, number>;
  kills: Record<string, number>;
  range: Record<string, number>;
  parkour: Record<string, number>;
}

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" });
export const moscowDay = (t = Date.now()) => dayFmt.format(t);

const empty = (day: string): Saved => ({ day, wins: {}, kills: {}, range: {}, parkour: {} });

export class Records {
  private data: Saved;
  private dirty = false;
  private warned = false;
  private readonly file: string | null;
  private readonly clock: () => number;

  constructor(file: string | null, clock: () => number = Date.now) {
    this.file = file;
    this.clock = clock;
    this.data = empty(moscowDay(clock()));
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as Saved;
      if (saved.day === this.data.day) this.data = { ...empty(saved.day), ...saved };
    } catch {
      // No file yet, or unreadable: start fresh.
    }
  }

  /** Starts a new day when the date has changed. Returns true if it did. */
  private roll(): boolean {
    const day = moscowDay(this.clock());
    if (day === this.data.day) return false;
    this.data = empty(day);
    this.dirty = true;
    return true;
  }

  addWin(name: string): void {
    this.roll();
    this.data.wins[name] = (this.data.wins[name] ?? 0) + 1;
    this.dirty = true;
  }

  addKills(name: string, n: number): void {
    if (n <= 0) return;
    this.roll();
    this.data.kills[name] = (this.data.kills[name] ?? 0) + n;
    this.dirty = true;
  }

  /** Records a run; returns the player's best today and whether it is now the day's #1. */
  offer(kind: "range" | "parkour", name: string, value: number): { best: number; first: boolean; improved: boolean } {
    this.roll();
    const table = this.data[kind];
    const better = (a: number, b: number) => (kind === "range" ? a > b : a < b);
    const prev = table[name];
    const improved = prev === undefined || better(value, prev);
    if (improved) {
      table[name] = value;
      this.dirty = true;
    }
    const best = table[name];
    const top = this.top(kind, 1)[0];
    return { best, first: improved && top?.[0] === name, improved };
  }

  personalBest(kind: "range" | "parkour", name: string): number | null {
    this.roll();
    return this.data[kind][name] ?? null;
  }

  private top(kind: Kind, n: number): [string, number][] {
    const asc = kind === "parkour";
    return Object.entries(this.data[kind])
      .sort((a, b) => (asc ? a[1] - b[1] : b[1] - a[1]) || a[0].localeCompare(b[0]))
      .slice(0, n);
  }

  snapshot(): DailyRecords {
    this.roll();
    return { day: this.data.day, wins: this.top("wins", 5), kills: this.top("kills", 5), range: this.top("range", 5), parkour: this.top("parkour", 5) };
  }

  /** True once per new day, so the server can rebroadcast the (now empty) boards. */
  checkDay(): boolean {
    return this.roll();
  }

  /** Writes the file if anything changed; failures are logged once and otherwise ignored. */
  flush(): void {
    if (!this.dirty || !this.file) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
    } catch (e) {
      if (!this.warned) console.warn(`[pvp] can't save records to ${this.file}: ${(e as Error).message}`);
      this.warned = true;
    }
  }
}
