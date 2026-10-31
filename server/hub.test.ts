// Hub (lobby world) tests: zones, auto-start, modes, training skeletons, range, parkour, duels,
// watching, the winner's return, the build area. Run: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HUB, MOB_ID_BASE, Voxels, buffModifiers, hubBlocks, inCellBox, stepBody, yawTowards } from "../src/game/shared.ts";
import type { Body, MoveInput } from "../src/game/shared.ts";
import { MobWorld } from "./mobs.ts";
import { Bot, facing, idleUntil, lookAt, pickMob, run, sleep, startServer, waitFor, walkPath } from "./test-utils.ts";

function hubWorld(): Voxels {
  const v = new Voxels();
  const q = hubBlocks();
  for (let i = 0; i < q.length; i += 4) v.set(q[i], q[i + 1], q[i + 2], q[i + 3]);
  return v;
}

/** Pillar centres of the parkour, then the middle of the golden finish. */
function parkourRoute(): { x: number; z: number; y: number }[] {
  const f = HUB.parkourFinish;
  return [...HUB.parkourSteps.map(([x, z, h]) => ({ x: x + 0.5, z: z + 0.5, y: h })), { x: (f.x0 + f.x1 + 1) / 2, z: (f.z0 + f.z1 + 1) / 2, y: f.h }];
}

/** A plain player's way through the parkour: run at the next pillar, jump off the edge of the
 *  current one, steer in the air, stop once over the target. Returns the next input. */
function parkourPilot() {
  const route = parkourRoute();
  let i = 0;
  let from = { x: HUB.parkourStart.x, z: HUB.parkourStart.z, y: 0 };
  let centred = true;
  return {
    done: () => i >= route.length,
    stage: () => i,
    input(b: Body): MoveInput {
      const p = b.pos;
      const goal = route[Math.min(i, route.length - 1)];
      const onGoal = b.onGround && Math.abs(p.y - goal.y) < 0.01 && Math.hypot(p.x - goal.x, p.z - goal.z) < 0.85;
      if (onGoal && i < route.length) {
        from = goal;
        i++;
        centred = false;
      }
      // Settle on the pillar first, like a player lining up the next jump.
      if (!centred) {
        const dc = Math.hypot(from.x - p.x, from.z - p.z);
        if (dc > 0.2 || Math.hypot(b.vel.x, b.vel.z) > 0.5) {
          return { forward: dc > 0.2 ? 1 : 0, strafe: 0, jump: false, yaw: yawTowards(p.x, p.z, from.x, from.z) };
        }
        centred = true;
      }
      const next = route[Math.min(i, route.length - 1)];
      const yaw = yawTowards(p.x, p.z, next.x, next.z);
      const d = Math.hypot(next.x - p.x, next.z - p.z);
      const offEdge = from.y === 0 ? d < 1.4 : Math.hypot(p.x - from.x, p.z - from.z) > 0.6;
      return { forward: d > 0.25 ? 1 : 0, strafe: 0, jump: b.onGround && offEdge && i < route.length, yaw };
    },
  };
}

describe("hub layout", () => {
  it("the parkour course can be finished with the real physics", () => {
    const world = hubWorld();
    const pilot = parkourPilot();
    const b: Body = { pos: { x: HUB.parkourStart.x, y: 0, z: HUB.parkourStart.z }, vel: { x: 0, y: 0, z: 0 }, onGround: true, jumpsLeft: 0, jumpHeld: false };
    let t = 0;
    let best = 0;
    for (; t < 60 && !pilot.done(); t += 1 / 60) {
      stepBody(world, b, pilot.input(b), 1 / 60, buffModifiers(null), 48);
      best = Math.max(best, pilot.stage());
      if (b.pos.y < 0.01 && pilot.stage() > 1) break;
    }
    assert.ok(pilot.done(), `stuck after pillar ${best} of ${parkourRoute().length} at ${JSON.stringify(b.pos)}`);
    console.log(`parkour sim: finished in ${t.toFixed(1)} s`);
  });

  it("the cliff skeleton falls when knocked off the edge", () => {
    const mobs = new MobWorld(hubWorld(), () => 0.5);
    const cliff = [...mobs.mobs.values()].find((m) => m.kind === "cliff")!;
    const events = [];
    let now = 1000;
    for (let k = 0; k < 3 && !cliff.dead; k++) {
      mobs.hit(cliff, 7, 4, -7, 5.5, 0, now);
      for (let i = 0; i < 30; i++) events.push(...mobs.step([], (now += 50)));
    }
    assert.ok(events.some((e) => e.t === "knocked" && e.by === 7), "knocked off and credited to the hitter");
    for (let i = 0; i < 40; i++) mobs.step([], (now += 50));
    assert.ok(!cliff.dead && cliff.body.pos.y >= 4.9, "back on the cliff after a moment");
  });

  it("the archer shoots at players in its zone; standing still gets you hit, far away is safe", () => {
    const mobs = new MobWorld(hubWorld(), () => 0.5);
    let now = 1000;
    const still = { id: 1, x: HUB.archer.x, y: 0, z: HUB.archer.z + 8 };
    const far = { id: 2, x: 0, y: 0, z: 10 };
    const events = [];
    for (let i = 0; i < 120; i++) events.push(...mobs.step([still, far], (now += 50)));
    assert.ok(events.some((e) => e.t === "arrowHit" && e.player === 1), "a standing player gets hit");
    assert.ok(!events.some((e) => e.t !== "dodged" && "player" in e && e.player === 2), "nobody shoots outside the zone");
  });
});

describe("hub", { concurrency: 3, timeout: 120_000 }, () => {
  it("new players arrive in the hub with the training skeletons around", async () => {
    const srv = await startServer();
    const a = await Bot.join(srv.url, "a");
    await waitFor(() => a.inHub && a.mobs.size > 0 && !!a.hub && !!a.records, 3000, "hub");
    srv.close();
    assert.ok(a.world.filled.size > 1000, "hub blocks received");
    assert.ok(Math.hypot(a.body.pos.x - HUB.spawn.x, a.body.pos.z - HUB.spawn.z) <= HUB.spawn.r + 0.01, "spawned on the plaza");
    const kinds = new Set([...a.mobs.values()].map((m) => m.kind));
    for (const k of ["dummy", "walker", "cliff", "archer"] as const) assert.ok(kinds.has(k), `${k} present`);
    assert.equal(a.hub?.need, 2);
  });

  it("standing in the ready circle cuts the wait, then everyone active drops into the arena", async () => {
    const srv = await startServer({ timeScale: 0.2 });
    const a = await Bot.join(srv.url, "a");
    const b = await Bot.join(srv.url, "b");
    await waitFor(() => a.inHub && b.inHub && a.hub?.startIn != null, 3000, "lobby timer");
    const longWait = a.hub!.startIn!;
    assert.ok(longWait > 8000, `long wait first (${longWait} ms)`);
    const circle = { x: HUB.ready.x + 2, z: HUB.ready.z };
    await Promise.all([walkPath(a, [{ x: 4.5, z: 8 }, circle]), walkPath(b, [{ x: 4.5, z: 8 }, { x: circle.x + 1, z: circle.z }])]);
    await waitFor(() => a.roster.filter((p) => p.ready).length === 2, 3000, "both ready");
    await waitFor(() => a.hub!.startIn !== null && a.hub!.startIn <= 2000, 3000, "short timer");
    await Promise.all([idleUntil(a, () => a.worldView === "arena", 6000), idleUntil(b, () => b.worldView === "arena", 6000)]);
    srv.close();
    assert.equal(a.worldView, "arena");
    assert.equal(b.worldView, "arena");
    assert.equal(a.phase, "countdown");
    assert.deepEqual(srv.violations.filter((v) => v.points > 0), []);
  });

  it("the mode pad vote decides the round: in one-shot a single hit kills", async () => {
    const srv = await startServer({ timeScale: 0.2, spawnPoints: facing(2.5) });
    const a = await Bot.join(srv.url, "a");
    const b = await Bot.join(srv.url, "b");
    await waitFor(() => a.inHub && b.inHub, 3000, "hub");
    const pad = HUB.votes.oneshot;
    await walkPath(a, [{ x: -4.5, z: 9 }, { x: -4.5, z: pad.z }, pad]);
    await waitFor(() => a.hub?.myVote === "oneshot", 2000, "vote counted");
    await Promise.all([idleUntil(a, () => a.playing, 20_000), idleUntil(b, () => b.playing, 20_000)]);
    assert.equal(a.mode, "oneshot");
    await run(a, (dt, now) => {
      a.interp(dt);
      const t = a.view.get(b.id);
      if (!a.playing || !t) return;
      lookAt(a, { x: t.pos.x, y: t.pos.y + 1, z: t.pos.z });
      a.step(dt, { forward: 0, strafe: 0, jump: false, yaw: a.yaw });
      a.maybeSendMove(now);
      if (!a.hurts.length) a.hit(b.id);
    }, 3000, () => !b.alive);
    srv.close();
    assert.equal(b.alive, false, "one hit killed");
    assert.equal(a.hurts.filter((h) => h.by === a.id).length, 1);
  });

  it("hitting skeletons counts as training, crits need a fall, and misses get explained", async () => {
    const srv = await startServer();
    const a = await Bot.join(srv.url, "a");
    await waitFor(() => a.inHub, 3000, "hub");
    const dummy = HUB.dummies[1];
    await walkPath(a, [{ x: 8, z: 9 }, { x: 15.5, z: dummy.z }]);
    const target = () => [...a.mobs.entries()].find(([, m]) => m.kind === "dummy" && Math.abs(m.pos.z - dummy.z) < 1);
    let jumped = false;
    await run(a, (dt, now) => {
      a.interp(dt);
      const t = target();
      if (!t) return;
      lookAt(a, { x: t[1].pos.x, y: t[1].pos.y + 1.2, z: t[1].pos.z });
      const wantCrit = (a.train?.hits ?? 0) >= 2;
      const jump = wantCrit && a.body.onGround && !jumped;
      if (jump) jumped = true;
      a.step(dt, { forward: Math.hypot(t[1].pos.x - a.body.pos.x, t[1].pos.z - a.body.pos.z) > 2.6 ? 1 : 0, strafe: 0, jump, yaw: a.yaw });
      a.maybeSendMove(now);
      if (a.body.onGround && jumped && a.body.vel.y === 0 && (a.train?.crits ?? 0) === 0) jumped = false;
      const falling = a.body.vel.y < -2;
      if (a.canHit() && pickMob(a)?.id === t[0] && (!wantCrit || falling)) {
        a.hit(t[0]);
      }
    }, 15_000, () => (a.train?.crits ?? 0) >= 1 && (a.train?.hits ?? 0) >= 3);
    const mobHurts = a.hurts.filter((h) => h.id >= MOB_ID_BASE && h.by === a.id);
    srv.close();
    assert.ok((a.train?.hits ?? 0) >= 3, `training hits counted (${a.train?.hits})`);
    assert.ok(mobHurts.some((h) => h.crit), "a falling hit is a crit");
    assert.ok(mobHurts.filter((h) => !h.crit).length >= 2, "ground hits are not");
    assert.ok(a.hints.some((h) => h.includes("КРИТ")), "crit explained");
    assert.deepEqual(srv.violations.filter((v) => v.points > 0), []);
  });

  it("the shooting range spawns private targets and keeps score", async () => {
    // Real lobby timing: with two bots in the hub a scaled-down lobby would start a round mid-run.
    const srv = await startServer({ rangeMs: 6000, timeScale: 1 });
    const a = await Bot.join(srv.url, "a");
    const b = await Bot.join(srv.url, "b");
    await waitFor(() => a.inHub && b.inHub, 3000, "hub");
    await walkPath(a, [{ x: HUB.rangeStart.x, z: 20 }, HUB.rangeStart]);
    await waitFor(() => a.rangeMsgs.some((m) => m.state === "countdown"), 2000, "countdown");
    let otherSawTarget = false;
    await run(a, (dt, now) => {
      a.interp(dt);
      if ([...b.mobs.values()].some((m) => m.kind === "target")) otherSawTarget = true;
      const t = [...a.mobs.entries()].find(([, m]) => m.kind === "target");
      if (!t) {
        a.step(dt, { forward: 0, strafe: 0, jump: false, yaw: a.yaw });
        a.maybeSendMove(now);
        return;
      }
      lookAt(a, { x: t[1].pos.x, y: t[1].pos.y + 1.2, z: t[1].pos.z });
      const d = Math.hypot(t[1].pos.x - a.body.pos.x, t[1].pos.z - a.body.pos.z);
      a.step(dt, { forward: d > 2.4 ? 1 : 0, strafe: 0, jump: false, yaw: a.yaw });
      a.maybeSendMove(now);
      if (a.canHit() && pickMob(a)?.id === t[0]) {
        a.hit(t[0]);
      }
    }, 14_000, () => a.rangeMsgs.some((m) => m.state === "done"));
    await sleep(1200);
    srv.close();
    const done = a.rangeMsgs.find((m) => m.state === "done");
    assert.ok(done, "run finished");
    assert.ok(done.score >= 2, `scored ${done.score}`);
    assert.equal(otherSawTarget, false, "targets are private");
    assert.ok(a.records?.range.some(([n, s]) => n === "a" && s === done.score), "daily record updated");
  });

  it("parkour runs are timed from leaving the start pad to the golden finish", async () => {
    const srv = await startServer();
    const a = await Bot.join(srv.url, "a");
    await waitFor(() => a.inHub, 3000, "hub");
    await walkPath(a, [{ x: -4.5, z: 9 }, { x: -4.5, z: -29.5 }, HUB.parkourStart]);
    await waitFor(() => a.parkourMsgs.some((m) => m.state === "ready"), 2000, "ready on the start pad");
    const pilot = parkourPilot();
    await run(a, (dt, now) => {
      if (!a.inHub) return;
      a.step(dt, pilot.input(a.body));
      a.maybeSendMove(now);
    }, 40_000, () => a.parkourMsgs.some((m) => m.state === "done" || m.state === "idle"));
    await sleep(1200);
    srv.close();
    const done = a.parkourMsgs.find((m) => m.state === "done");
    assert.ok(done, `finished (got ${a.parkourMsgs.map((m) => m.state).join(",")})`);
    assert.ok(done.ms > 2000 && done.ms < 40_000, `time ${done.ms}`);
    assert.ok(a.records?.parkour.some(([n]) => n === "a"), "daily record updated");
    assert.deepEqual(srv.violations.filter((v) => v.points > 0), []);
  });

  it("duels: challenge, accept, fight in the pit, the loser is announced, both walk out healthy", async () => {
    const srv = await startServer({ duelMs: 30_000 });
    const a = await Bot.join(srv.url, "a");
    const b = await Bot.join(srv.url, "b");
    await waitFor(() => a.inHub && b.inHub, 3000, "hub");
    a.send({ t: "duel", id: b.id });
    await waitFor(() => b.invites.includes(a.id), 2000, "invite");
    b.send({ t: "duelAnswer", accept: true });
    await waitFor(() => a.duelMsgs.some((m) => m.state === "countdown") && b.duelMsgs.some((m) => m.state === "countdown"), 2000, "duel starts");
    await waitFor(() => inCellBox(a.body.pos.x, a.body.pos.z, HUB.duel) && inCellBox(b.body.pos.x, b.body.pos.z, HUB.duel), 2000, "both in the pit");
    await Promise.all([
      run(a, (dt, now) => {
        a.interp(dt);
        const t = a.view.get(b.id);
        if (!a.inHub || !t) return;
        lookAt(a, { x: t.pos.x, y: t.pos.y + 1.2, z: t.pos.z });
        const d = Math.hypot(t.pos.x - a.body.pos.x, t.pos.z - a.body.pos.z);
        a.step(dt, { forward: d > 2.2 ? 1 : 0, strafe: 0, jump: false, yaw: a.yaw });
        a.maybeSendMove(now);
        const fighting = a.duelMsgs.at(-1)?.state === "fight";
        if (fighting && d < 3.2 && a.canHit()) {
          a.hit(b.id);
        }
      }, 25_000, () => a.duelMsgs.some((m) => m.state === "over")),
      idleUntil(b, () => b.duelMsgs.some((m) => m.state === "over"), 25_000),
    ]);
    await sleep(400);
    srv.close();
    assert.equal(a.duelMsgs.at(-1)?.won, true);
    assert.equal(b.duelMsgs.at(-1)?.won, false);
    assert.ok(a.notices.some((n) => n.includes("победил b в дуэли")), "announced");
    assert.equal(b.hp, 20, "healed after the duel");
    assert.ok(!inCellBox(b.body.pos.x, b.body.pos.z, HUB.duel), "out of the pit");
    assert.deepEqual(srv.violations.filter((v) => v.points > 0), []);
  });

  it("late joiners can watch the round (T) and come back to the same spot", async () => {
    const srv = await startServer({ spawnPoints: facing(10) });
    const a = await Bot.join(srv.url, "a");
    const b = await Bot.join(srv.url, "b");
    await Promise.all([idleUntil(a, () => a.playing, 20_000), idleUntil(b, () => b.playing, 20_000)]);
    const c = await Bot.join(srv.url, "c");
    await waitFor(() => c.inHub, 3000, "late joiner in the hub");
    const before = { ...c.body.pos };
    c.send({ t: "watch", on: true });
    await waitFor(() => c.worldView === "arena" && c.watching, 2000, "watching");
    await waitFor(() => (c.ticks.at(-1) ?? []).length === 14, 2000, "sees both players");
    c.send({ t: "watch", on: false });
    await waitFor(() => c.inHub, 2000, "back in the hub");
    srv.close();
    assert.ok(Math.hypot(c.body.pos.x - before.x, c.body.pos.z - before.z) < 0.1, "same spot");
    assert.equal(a.worldView, "arena", "players stay in the round");
  });

  it("after the round everyone returns to the hub; the winner gets the pedestal, crown, awards and a record", async () => {
    const srv = await startServer({ spawnPoints: facing(2.5) });
    const a = await Bot.join(srv.url, "a");
    const b = await Bot.join(srv.url, "b");
    await Promise.all([idleUntil(a, () => a.playing, 20_000), idleUntil(b, () => b.playing, 20_000)]);
    await run(a, (dt, now) => {
      a.interp(dt);
      const t = a.view.get(b.id);
      if (!a.playing || !t) return;
      lookAt(a, { x: t.pos.x, y: t.pos.y + 1.2, z: t.pos.z });
      const d = Math.hypot(t.pos.x - a.body.pos.x, t.pos.z - a.body.pos.z);
      a.step(dt, { forward: d > 2.2 ? 1 : 0, strafe: 0, jump: false, yaw: a.yaw });
      a.maybeSendMove(now);
      if (d < 3.2 && a.canHit()) {
        a.hit(b.id);
      }
    }, 20_000, () => !b.alive && b.phase !== "playing");
    await waitFor(() => a.phase === "ended" && !!a.results, 3000, "results");
    assert.equal(a.results?.winnerName, "a");
    assert.ok(a.results?.awards.some((w) => w.title === "Мясник" && w.name === "a"));
    await waitFor(() => a.inHub && b.inHub, 12_000, "back in the hub");
    await waitFor(() => !!a.roster.find((p) => p.id === a.id)?.crown, 2000, "crown");
    srv.close();
    const p = a.body.pos;
    assert.ok(Math.abs(p.x - HUB.pedestal.x) < 0.01 && Math.abs(p.y - HUB.pedestal.y) < 0.01 && Math.abs(p.z - HUB.pedestal.z) < 0.01, "on the pedestal");
    assert.ok(a.records?.wins.some(([n, w]) => n === "a" && w === 1), "win recorded");
    assert.equal(a.phase, "lobby");
  });

  it("the build area takes blocks (only there) and they vanish after a while", async () => {
    const srv = await startServer({ buildTtlMs: 2500 });
    const a = await Bot.join(srv.url, "a");
    await waitFor(() => a.inHub, 3000, "hub");
    const b = HUB.build;
    const spot = { x: b.x0 + 2.5, z: (b.z0 + b.z1 + 1) / 2 };
    await walkPath(a, [{ x: -5, z: 12 }, spot]);
    const place = async (cx: number, cz: number) => {
      lookAt(a, { x: cx + 0.5, y: 0.05, z: cz + 0.5 });
      await idleUntil(a, () => false, 150);
      a.place(cx, 0, cz);
      await idleUntil(a, () => false, 400);
    };
    const inside = { x: Math.floor(spot.x) + 2, z: Math.floor(spot.z) };
    const outside = { x: b.x0 - 1, z: Math.floor(spot.z) };
    await place(inside.x, inside.z);
    await place(outside.x, outside.z);
    const added = a.blocks.filter((m) => m.w === "hub" && m.v === 1);
    assert.deepEqual(added.map((m) => [m.x, m.z]), [[inside.x, inside.z]], "only the block inside the area");
    await idleUntil(a, () => a.world.get(inside.x, 0, inside.z) === 0, 5000);
    srv.close();
    assert.equal(a.world.get(inside.x, 0, inside.z), 0, "vanished");
    assert.deepEqual(srv.violations.filter((v) => v.points > 0), []);
  });
});

