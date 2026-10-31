// Round modes and event buffs against a real server: Teams, Infection, King of the Hill, Sumo,
// Spleef, bows, the hot potato, rising lava and the eliminated players' buff vote.
// Run: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BLOCK, HILL_TARGET, MAX_HP } from "../src/game/shared.ts";
import type { Vec3 } from "../src/game/shared.ts";
import { Bot, facing, idle, lookAt, match, run, waitFor } from "./test-utils.ts";
import type { TestServer } from "./test-utils.ts";

const TRIANGLE = (i: number) => [{ x: 0.5, z: 0.5, yaw: 0 }, { x: 2.7, z: 0.5, yaw: 0 }, { x: 1.6, z: 2.4, yaw: 0 }][i];
const teamOf = (b: Bot, id = b.id) => b.roster.find((p) => p.id === id)?.team ?? null;
const noPoints = (srv: TestServer) => assert.deepEqual(srv.violations.filter((v) => v.points > 0), []);

/** Walks up to the target and swings when in reach and the cooldown allows, while `swing()` says so. */
const fighter = (att: Bot, target: () => Bot | undefined, swing: () => boolean = () => true) => (dt: number, now: number) => {
  att.interp(dt);
  const t = target();
  const v = t && att.view.get(t.id);
  if (!att.playing || !v || !t) return idle(att)(dt, now);
  lookAt(att, { x: v.pos.x, y: v.pos.y + 1.2, z: v.pos.z });
  const d = Math.hypot(v.pos.x - att.body.pos.x, v.pos.z - att.body.pos.z);
  att.step(dt, { forward: d > 2.2 ? 1 : 0, strafe: 0, jump: false, yaw: att.yaw });
  att.maybeSendMove(now);
  if (d < 3.2 && swing() && att.canHit()) att.hit(t.id);
};

/** Runs every bot's frame loop until `done`. */
const all = (bots: Bot[], frames: Map<Bot, (dt: number, now: number) => void>, ms: number, done: () => boolean) =>
  Promise.all(bots.map((b) => run(b, frames.get(b) ?? idle(b), ms, done)));

describe("modes", () => {
  it("teams: no friendly fire, a kill scores for the team, the dead respawn", { timeout: 40_000 }, async () => {
    const { srv, bots } = await match({ mode: "teams", timeScale: 0.05, buffPlan: [], spawnPoints: TRIANGLE }, 3);
    await waitFor(() => bots.every((b) => teamOf(b) !== null), 2000, "teams");
    const big = [0, 1].find((k) => bots.filter((b) => teamOf(b) === k).length === 2) ?? 0;
    const [att, mate] = bots.filter((b) => teamOf(b) === big);
    const enemy = bots.find((b) => teamOf(b) !== big) as Bot;
    let target: Bot = mate;
    const frames = new Map([[att, fighter(att, () => target, () => target !== mate || !att.hints.length)]]);
    await all(bots, frames, 3000, () => att.hints.includes("Это союзник"));
    assert.ok(att.hints.includes("Это союзник"), "a teammate can't be hurt");
    assert.equal(mate.hurts.filter((h) => h.id === mate.id).length, 0);
    target = enemy;
    await all(bots, frames, 12_000, () => (att.score?.teams[big] ?? 0) >= 1);
    assert.equal(att.score?.teams[big], 1, "the kill scores for the attacker's team");
    const diedAt = { ...enemy.body.pos };
    await all(bots, new Map(), 3000, () => enemy.alive);
    srv.close();
    assert.ok(enemy.alive, "the enemy is back");
    assert.ok(Math.hypot(enemy.body.pos.x - diedAt.x, enemy.body.pos.z - diedAt.z) > 0.01, "respawned elsewhere");
    assert.equal(enemy.hp, MAX_HP);
    noPoints(srv);
  });

  it("infection: a bitten human turns into a zombie, and with no humans left the zombies win", { timeout: 30_000 }, async () => {
    const { srv, bots } = await match({ mode: "infection", timeScale: 0.05, buffPlan: [], spawnPoints: facing(2.5) });
    await waitFor(() => bots.every((b) => teamOf(b) !== null), 2000, "teams");
    const zombie = bots.find((b) => teamOf(b) === 1) as Bot;
    const human = bots.find((b) => teamOf(b) === 0) as Bot;
    await all(bots, new Map([[zombie, fighter(zombie, () => human)]]), 15_000, () => !!zombie.results);
    srv.close();
    assert.equal(zombie.results?.team, 1, "zombies won");
    assert.equal(teamOf(zombie, human.id), 1, "the human was infected");
    noPoints(srv);
  });

  it("king of the hill: alone on the hill, a point a second; the target score wins", { timeout: 30_000 }, async () => {
    const spots = (i: number) => (i === 0 ? { x: 0.5, z: 0.5, yaw: 0 } : { x: 0.5, z: 20.5, yaw: Math.PI });
    const { srv, bots } = await match({ mode: "koth", timeScale: 0.02, buffPlan: [], spawnPoints: spots });
    const king = bots.find((b) => Math.hypot(b.body.pos.x, b.body.pos.z) < 2) as Bot;
    await all(bots, new Map(), 12_000, () => !!king.results);
    srv.close();
    assert.equal(king.results?.winner, king.id);
    assert.equal(king.results?.rows[0].score, HILL_TARGET);
    noPoints(srv);
  });

  it("sumo: hits knock back but do no damage", { timeout: 30_000 }, async () => {
    const { srv, bots } = await match({ mode: "sumo", buffPlan: [], spawnPoints: facing(2.5) });
    const [a, b] = bots;
    assert.equal(a.dirt, 0, "nothing to build with");
    await all(bots, new Map([[a, fighter(a, () => b)]]), 4000, () => b.hurts.some((h) => h.id === b.id));
    srv.close();
    const h = b.hurts.find((x) => x.id === b.id);
    assert.ok(h && h.dmg === 0 && Math.hypot(h.kx, h.kz) > 1, `knocked back without damage: ${JSON.stringify(h)}`);
    assert.equal(b.hp, MAX_HP);
    noPoints(srv);
  });

  it("spleef: players start on the upper snow layer; broken snow gives nothing to build with", { timeout: 30_000 }, async () => {
    const { srv, bots } = await match({ mode: "spleef", buffPlan: [], spawnPoints: facing(3) });
    const a = bots.find((b) => b.body.pos.z > 0) as Bot;
    assert.ok(Math.abs(a.body.pos.y - 5) < 0.01, `on the upper layer (y ${a.body.pos.y})`);
    assert.equal(a.world.get(0, 4, 0), BLOCK.snow);
    assert.equal(a.world.get(0, 0, 0), BLOCK.snow);
    // The cell in front of the feet (yaw 0 looks towards -Z).
    const cell: Vec3 = { x: 0, y: 4, z: -1 };
    lookAt(a, { x: cell.x + 0.5, y: cell.y + 1, z: cell.z + 0.5 });
    await all(bots, new Map(), 300, () => false);
    a.breakBlock(cell.x, cell.y, cell.z);
    await all(bots, new Map(), 3000, () => a.world.get(cell.x, cell.y, cell.z) === 0);
    srv.close();
    assert.equal(a.world.get(cell.x, cell.y, cell.z), 0, "broken");
    assert.equal(a.dirt, 0);
    noPoints(srv);
  });
});

describe("event buffs", () => {
  it("bows: five arrows each; an arrow hurts whoever it hits", { timeout: 30_000 }, async () => {
    const { srv, bots } = await match({ buffPlan: ["bows"], timeScale: 0.05, spawnPoints: facing(6) });
    const [a, b] = bots;
    await all(bots, new Map(), 5000, () => a.ammo === 5);
    assert.equal(a.ammo, 5);
    let shot = false;
    const frames = new Map([
      [
        a,
        (dt: number, now: number) => {
          a.interp(dt);
          const v = a.view.get(b.id);
          if (v) lookAt(a, { x: v.pos.x, y: v.pos.y + 1.3, z: v.pos.z });
          idle(a)(dt, now);
          if (v && !shot) {
            shot = true;
            a.send({ t: "shoot", yaw: a.yaw, pitch: a.pitch, tk: a.lastTick });
          }
        },
      ],
    ]);
    await all(bots, frames, 4000, () => b.hurts.some((h) => h.id === b.id));
    srv.close();
    const h = b.hurts.find((x) => x.id === b.id);
    assert.ok(h && h.by === a.id && h.dmg === 4, `hit by the arrow: ${JSON.stringify(h)}`);
    assert.equal(a.ammo, 4);
    noPoints(srv);
  });

  it("hot potato: a hit passes the bomb; when the fuse runs out its holder blows up", { timeout: 30_000 }, async () => {
    const { srv, bots } = await match({ buffPlan: ["potato"], timeScale: 0.1, spawnPoints: facing(2.5) });
    const [a] = bots;
    await all(bots, new Map(), 6000, () => a.bombHolder !== null);
    const holder = bots.find((b) => b.id === a.bombHolder) as Bot;
    const other = bots.find((b) => b !== holder) as Bot;
    await all(bots, new Map([[holder, fighter(holder, () => other, () => a.bombHolder === holder.id)]]), 4000, () => a.bombHolder === other.id);
    assert.equal(a.bombHolder, other.id, "passed on");
    await all(bots, new Map(), 6000, () => a.kills.some((k) => k.reason === "boom"));
    srv.close();
    assert.ok(a.booms >= 1, "it went off");
    assert.equal(a.kills.find((k) => k.reason === "boom")?.victim, other.id, "the holder blew up");
    noPoints(srv);
  });

  it("lava rises and kills whoever stays on the floor", { timeout: 40_000 }, async () => {
    const { srv, bots } = await match({ buffPlan: ["lava"], timeScale: 0.05, spawnPoints: facing(6) });
    const [a] = bots;
    await all(bots, new Map(), 25_000, () => a.kills.some((k) => k.reason === "lava"));
    srv.close();
    assert.ok(a.kills.some((k) => k.reason === "lava"), "burnt");
    assert.ok(a.lava >= 1 || a.phase !== "playing", "the lava rose");
    noPoints(srv);
  });

  it("an eliminated player's vote picks the next buff", { timeout: 60_000 }, async () => {
    const { srv, bots } = await match({ mode: "oneshot", timeScale: 0.2, buffPlan: ["speed", "gravity", "doublejump"], spawnPoints: TRIANGLE }, 3);
    const [att, victim] = bots;
    await all(bots, new Map([[att, fighter(att, () => victim, () => victim.alive)]]), 4000, () => !victim.alive);
    assert.equal(victim.alive, false);
    await all(bots, new Map(), 15_000, () => (victim.vote?.options.length ?? 0) === 3);
    const options = victim.vote?.options ?? [];
    assert.equal(options.length, 3, "three options");
    const pick = options[2];
    victim.send({ t: "buffVote", i: 2 });
    await all(bots, new Map(), 3000, () => victim.vote?.mine === 2);
    assert.equal(victim.vote?.votes[2], 1, "the vote counts");
    await all(bots, new Map(), 15_000, () => att.buffs.includes(pick));
    srv.close();
    assert.deepEqual(att.buffs, [pick], "the voted buff landed");
  });
});
