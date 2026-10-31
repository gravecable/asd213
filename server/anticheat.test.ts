// Anticheat against a real server. Scripted honest clients run the browser's physics with jittery
// frames and network and must never be flagged; scripted cheats must be caught.
// Run: npm run test:anticheat
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ARENA_RADIUS,
  BUILD_REACH,
  CLOSE_BANNED,
  CLOSE_KICKED,
  CLOSE_OUTDATED,
  CLOSE_TOO_MANY,
  FALL_OUT_Y,
  GIANT_SIZE,
  HIT_COOLDOWN_MS,
  MAX_HP,
  MAX_STEP_DT,
  PLAYER_HALF_WIDTH as HW,
  PLAYER_HEIGHT as PH,
  PROTOCOL_VERSION,
  SMALL_SIZE,
  Voxels,
  buffModifiers,
  lookDir,
  raycastVoxels,
  stepBody,
} from "../src/game/shared.ts";
import type { Body, BuffId, MoveInput, Vec3 } from "../src/game/shared.ts";
import { checkMove, endSprint, knockbackCredit, newMotion, speedCredit } from "./anticheat.ts";
import type { MoveCtx } from "./anticheat.ts";
import { Bot, LAN, aimAt, facing, flagged, frames, idle, jitteryNet, lookAt, match, mobileNet, run, seeded, sleep, stallableNet, startServer, waitFor, walker } from "./test-utils.ts";
import type { Net } from "./test-utils.ts";

// ------------------------------------------------------------------ honest play

/** Random but human-like play: roaming, bunny hops, double jumps, fights, walls, towers, digging. */
function honestBrain(bot: Bot, rnd: () => number) {
  const input: MoveInput = { forward: 0, strafe: 0, jump: false, yaw: 0 };
  let next = 0;
  let act: "walk" | "tower" | "wall" | "dig" | "hop" = "walk";
  let actUntil = 0;
  let jumpUntil = 0;
  let turn = 0;
  // Cooldowns on both clocks, like the browser.
  const last = { hit: -1e9, place: -1e9, break: -1e9, hitSim: -1e9, placeSim: -1e9, breakSim: -1e9 };
  return (dt: number, now: number) => {
    bot.interp(dt);
    if (!bot.playing) return;
    const p = bot.body.pos;
    if (now >= next) {
      next = now + 300 + rnd() * 1200;
      input.forward = [1, 1, 1, 0, -1][Math.floor(rnd() * 5)];
      input.strafe = [-1, 0, 0, 1][Math.floor(rnd() * 4)];
      if (rnd() < 0.35) jumpUntil = now + 150 + rnd() * 1500;
      const r = rnd();
      act = bot.dirt > 3 && r < 0.12 ? "tower" : r < 0.3 ? "wall" : r < 0.4 ? "dig" : r < 0.5 ? "hop" : "walk";
      actUntil = now + 600 + rnd() * 900;
      turn = (rnd() - 0.5) * 3;
    }
    if (now > actUntil) act = "walk";
    let enemy: { pos: Vec3; d: number } | null = null;
    for (const v of bot.view.values()) {
      const d = Math.hypot(v.pos.x - p.x, v.pos.z - p.z);
      if (!enemy || d < enemy.d) enemy = { pos: v.pos, d };
    }
    if (act === "tower") {
      bot.pitch = -Math.PI / 2 + 0.01;
      input.forward = input.strafe = 0;
    } else if (act === "wall" || act === "dig") {
      bot.pitch = -0.5;
      bot.yaw += turn * dt * 0.3;
    } else if (enemy && enemy.d < 20) {
      const a = aimAt(bot.eye(), { x: enemy.pos.x, y: enemy.pos.y + 1, z: enemy.pos.z });
      let dy = a.yaw + (rnd() - 0.5) * 0.2 - bot.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      bot.yaw += Math.max(-6 * dt, Math.min(6 * dt, dy));
      bot.pitch = a.pitch;
    } else if (Math.hypot(p.x, p.z) > bot.edge() - 6) {
      bot.yaw = Math.atan2(p.x, p.z);
      bot.pitch = 0;
    } else {
      bot.yaw += turn * dt;
      bot.pitch = -0.15;
    }
    input.yaw = bot.yaw;
    input.jump = act === "tower" || (act === "hop" ? (actUntil - now) % 420 < 160 : now < jumpUntil);
    bot.step(dt, input);

    const target = bot.pick();
    const block = raycastVoxels(bot.world, bot.eye(), lookDir(bot.yaw, bot.pitch), BUILD_REACH);
    if (target && (!block || target.t < block.t)) {
      // Spare low players so the round lasts.
      if (now - last.hit >= HIT_COOLDOWN_MS && bot.simTime - last.hitSim >= HIT_COOLDOWN_MS && target.hp > 8) {
        last.hit = now;
        last.hitSim = bot.simTime;
        bot.hit(target.id);
      }
    } else if (act === "dig" && block && !block.floor && now - last.break >= 220 && bot.simTime - last.breakSim >= 220) {
      last.break = now;
      last.breakSim = bot.simTime;
      bot.breakBlock(block.x, block.y, block.z);
    }
    if ((act === "tower" || act === "wall") && now - last.place >= 200 && bot.simTime - last.placeSim >= 200 && bot.tryPlace()) {
      last.place = now;
      last.placeSim = bot.simTime;
    }
    bot.maybeSendMove(now);
  };
}

/** Replays the client physics against the validator directly: random terrain (steps, overhangs,
 *  low ceilings), random input and frame times, buff changes and knockback. Nothing may be refused. */
function fuzzRun(seed: number): number {
  const rnd = seeded(seed);
  const world = new Voxels();
  for (let i = 0; i < 90; i++) world.set(Math.floor(rnd() * 14) - 7, Math.floor(rnd() * 5), Math.floor(rnd() * 14) - 7, 1);
  // Every other seed gets a low roof over one side: sprint-jumps bounce off it.
  if (seed % 2 === 0) for (let x = -7; x <= -3; x++) for (let z = -7; z <= 7; z++) world.set(x, 2, z, 1);
  for (let y = 0; y < 20; y++) world.set(0, y, 0, 0);
  const body: Body = { pos: { x: 0.5, y: 0, z: 0.5 }, vel: { x: 0, y: 0, z: 0 }, onGround: false, jumpsLeft: 0, jumpHeld: false };
  const pos = { ...body.pos };
  const mo = newMotion();
  const plan: (BuffId | null)[] = [null, "speed", "gravity", "doublejump", "baseball", "ice"];
  const sizes = [1, 1, GIANT_SIZE, SMALL_SIZE];
  let buff: BuffId | null = null;
  let prev: BuffId | null = null;
  let size = 1;
  let prevSize = 1;
  const modsOf = (b: BuffId | null, s: number) => buffModifiers(b ? [b] : null, null, s);
  let changedAt = -1e9;
  let simTime = 0;
  let lastSent = 0;
  let kbSeq = 0;
  let checks = 0;
  let sprint = false;
  let sprintedSince = false;
  const ctx = (): MoveCtx => {
    const mods = simTime - changedAt < 1500 ? [modsOf(buff, size), modsOf(prev, prevSize)] : [modsOf(buff, size)];
    const g = mods.map((m) => 30 * m.gravity);
    return {
      world,
      now: simTime,
      gLo: Math.min(...g),
      gHi: Math.max(...g),
      maxSpeed: 5 * Math.max(...mods.map((m) => m.speed)),
      airJump: mods.some((m) => m.extraJumps > 0),
      ringRadius: ARENA_RADIUS,
      ringLimit: ARENA_RADIUS,
      ringSpeed: 0,
      freshBlocks: () => false,
    };
  };
  const report = (what: string) => {
    const v = checkMove(pos, mo, { ...body.pos, vy: body.vel.y, ts: simTime, k: kbSeq, sp: sprint || sprintedSince }, ctx());
    sprintedSince = false;
    checks++;
    assert.ok(v.ok && !v.flag, `seed ${seed} at ${simTime.toFixed(0)}ms (${what}, buff ${buff}, sprint ${sprint}): ${JSON.stringify(v)}`);
    Object.assign(pos, body.pos);
  };
  report("spawn");
  const input: MoveInput = { forward: 0, strafe: 0, jump: false, yaw: 0 };
  let nextInput = 0;
  let nextBuff = 2000;
  let tapJump = false;
  while (simTime < 60_000) {
    if (simTime >= nextInput) {
      nextInput = simTime + 200 + rnd() * 900;
      input.forward = Math.floor(rnd() * 3) - 1;
      input.strafe = Math.floor(rnd() * 3) - 1;
      input.jump = rnd() < 0.4;
      tapJump = rnd() < 0.3;
      // Double-tap W, as on the client (on the ground, moving forward).
      if (input.forward > 0 && body.onGround && rnd() < 0.6) sprint = true;
      const r = Math.hypot(body.pos.x, body.pos.z);
      input.yaw = r > 7 ? Math.atan2(body.pos.x, body.pos.z) : rnd() * Math.PI * 2;
    }
    if (tapJump) input.jump = simTime % 300 < 120;
    if (simTime >= nextBuff) {
      nextBuff = simTime + 1500 + rnd() * 3000;
      prev = buff;
      prevSize = size;
      buff = plan[Math.floor(rnd() * plan.length)];
      size = sizes[Math.floor(rnd() * sizes.length)];
      changedAt = simTime;
      const extra = 5 * (modsOf(prev, prevSize).speed - modsOf(buff, size).speed);
      if (extra > 0) mo.credits.push(speedCredit(simTime, mo.ts, extra));
    }
    if (rnd() < 0.004) {
      // A hit lands between two frames, as on the client.
      const a = rnd() * Math.PI * 2;
      const strong = buff === "baseball";
      const kx = Math.round(Math.cos(a) * (strong ? 21 : 7) * 100) / 100;
      const kz = Math.round(Math.sin(a) * (strong ? 21 : 7) * 100) / 100;
      const ky = strong ? 12 : 5.5;
      mo.credits.push(knockbackCredit(simTime, ++kbSeq, kx, ky, kz));
      body.vel.x += kx;
      body.vel.z += kz;
      body.vel.y = Math.max(body.vel.y, ky);
    }
    if (rnd() < 0.003) {
      // Someone builds or digs nearby (never inside the player).
      const p = body.pos;
      const x = Math.floor(p.x + (rnd() * 6 - 3));
      const y = Math.floor(p.y + (rnd() * 4 - 1));
      const z = Math.floor(p.z + (rnd() * 6 - 3));
      const inside = x + 1 > p.x - HW - 0.5 && x < p.x + HW + 0.5 && z + 1 > p.z - HW - 0.5 && z < p.z + HW + 0.5 && y + 1 > p.y - 0.5 && y < p.y + PH + 0.5;
      if (!inside) world.set(x, y, z, world.get(x, y, z) ? 0 : 1);
    }
    if (sprint && rnd() < 0.002) {
      // A sprint hit: the client reports its move first, then slows down and stops sprinting; the
      // server ends the sprint too.
      lastSent = simTime;
      report("sprint hit");
      sprint = false;
      body.vel.x *= 0.6;
      body.vel.z *= 0.6;
      endSprint(mo);
    }
    const wasSprinting = sprint;
    if (input.forward <= 0) sprint = false;
    const dt = rnd() < 0.05 ? MAX_STEP_DT : 0.002 + rnd() * 0.03;
    if (sprint) sprintedSince = true;
    stepBody(world, body, { ...input, sprint }, dt, modsOf(buff, size), ARENA_RADIUS);
    if (body.bumped) sprint = false;
    simTime += dt * 1000;
    if (simTime - lastSent >= 50 || (wasSprinting && !sprint)) {
      lastSent = simTime;
      report("move");
    }
  }
  return checks;
}

describe("move validator", () => {
  it("accepts everything the client physics produces (fuzz)", () => {
    let checks = 0;
    const seeds = Number(process.env.FUZZ_SEEDS) || 40;
    for (let seed = 1; seed <= seeds; seed++) checks += fuzzRun(seed);
    console.log(`fuzz: ${checks} moves validated`);
  });
});

/** Mostly 60 fps, sometimes 30 or 144, rare hitches and a rare hidden tab. */
function browserFrames(rnd: () => number) {
  return () => {
    const r = rnd();
    return r < 0.002 ? 1500 : r < 0.012 ? 80 + rnd() * 200 : r < 0.06 ? 33 : r < 0.12 ? 7 : 16;
  };
}

describe("sprint physics", () => {
  it("sprint-jumping in the open and under a low roof is accepted at any frame rate", () => {
    for (const roof of [false, true]) {
      for (const frame of [1 / 30, 1 / 60, 1 / 144, 0]) {
        const rnd = seeded(roof ? 7 : 3);
        const world = new Voxels();
        // A roof one block above head height: every jump bounces off it at once.
        if (roof) for (let x = -44; x <= 44; x++) for (let z = -2; z <= 2; z++) world.set(x, 2, z, 1);
        const body: Body = { pos: { x: -40.5, y: 0, z: 0.5 }, vel: { x: 0, y: 0, z: 0 }, onGround: true, jumpsLeft: 0, jumpHeld: false };
        const pos = { ...body.pos };
        const mo = newMotion();
        let simTime = 0;
        let lastSent = 0;
        let yaw = -Math.PI / 2;
        let x0 = 0;
        const ctx = (): MoveCtx => ({ world, now: simTime, gLo: 30, gHi: 30, maxSpeed: 5, airJump: false, ringRadius: ARENA_RADIUS, ringLimit: ARENA_RADIUS, ringSpeed: 0, freshBlocks: () => false });
        const report = () => {
          const v = checkMove(pos, mo, { ...body.pos, vy: body.vel.y, ts: simTime, k: 0, sp: true }, ctx());
          assert.ok(v.ok && !v.flag, `roof ${roof}, frame ${frame.toFixed(3)} at ${simTime.toFixed(0)}ms: ${JSON.stringify(v)}`);
          Object.assign(pos, body.pos);
        };
        report();
        while (simTime < 10_000) {
          if (body.pos.x > 40) yaw = Math.PI / 2;
          if (body.pos.x < -40) yaw = -Math.PI / 2;
          const dt = frame || (rnd() < 0.05 ? MAX_STEP_DT : 0.002 + rnd() * 0.03);
          stepBody(world, body, { forward: 1, strafe: 0, jump: true, yaw, sprint: true }, dt, buffModifiers(null), ARENA_RADIUS);
          assert.ok(!body.bumped, "nothing to bump into");
          simTime += dt * 1000;
          if (simTime >= 2000 && !x0) x0 = body.pos.x;
          if (simTime - lastSent >= 50) {
            lastSent = simTime;
            report();
          }
        }
        assert.ok(body.pos.x !== x0, "moved");
      }
    }
  });

  it("a sprint ends on a head-on wall, not when sliding along one", () => {
    const world = new Voxels();
    for (let z = -10; z <= 10; z++) for (let y = 0; y < 3; y++) world.set(5, y, z, 1);
    const go = (yaw: number) => {
      const body: Body = { pos: { x: 0.5, y: 0, z: 0.5 }, vel: { x: 0, y: 0, z: 0 }, onGround: true, jumpsLeft: 0, jumpHeld: false };
      let bumped = false;
      for (let i = 0; i < 120 && !bumped; i++) {
        stepBody(world, body, { forward: 1, strafe: 0, jump: false, yaw, sprint: true }, 1 / 60, buffModifiers(null), ARENA_RADIUS);
        bumped = !!body.bumped;
      }
      return bumped;
    };
    // The wall faces -X; yaw -π/2 runs straight into it.
    assert.equal(go(-Math.PI / 2), true, "head-on");
    assert.equal(go(-Math.PI / 2 + 0.35), true, "at 20°");
    assert.equal(go(-Math.PI / 2 + Math.PI / 2 - 0.05), false, "sliding along at 3°");
  });
});

describe("network trouble", { concurrency: true, timeout: 60_000 }, () => {
  for (const latency of [20, 150]) it(`a 2.5 s stall at ${latency} ms ping is forgiven`, async () => {
    const a = stallableNet(latency);
    const b = stallableNet(latency);
    // No buffs: fog and invisibility hide the players from each other by design.
    const srv = await startServer({ spawnPoints: facing(12), buffPlan: [] });
    const p = await Bot.join(srv.url, "laggy", a.net);
    const q = await Bot.join(srv.url, "other", b.net);
    await waitFor(() => p.id > 0 && q.id > 0, 3000, "welcome");
    await waitFor(() => p.playing && q.playing, 20_000, "round start");
    // Spawning in the hub and dropping into the arena are teleports too: count from the round start.
    const spawnTeleports = p.teleports;
    const moves = run(p, walker(p), 9000);
    const others = run(q, walker(q), 9000);
    await sleep(1500);
    a.ctl.until = Date.now() + 2500;
    await sleep(4000);
    const seenAfterStall = q.view.get(p.id)?.target;
    await Promise.all([moves, others]);
    const seenAtEnd = q.view.get(p.id)?.target;
    srv.close();
    const mine = srv.violations.filter((v) => v.id === p.id);
    assert.deepEqual(mine.filter((v) => v.points > 0), [], "no violation points");
    assert.equal(p.closed, null, "not kicked");
    assert.ok(p.teleports - spawnTeleports <= 1, `at most one correction (got ${p.teleports - spawnTeleports})`);
    assert.ok(seenAfterStall && seenAtEnd && Math.hypot(seenAtEnd.x - seenAfterStall.x, seenAtEnd.z - seenAfterStall.z) > 2, "keeps moving for others after the stall");
  });
});

/** A whole round of honest bots on the given network; nobody may earn a single violation point. */
async function honestRound(label: string, players: number, timeScale: number, netFor: (i: number) => Net, minHits: number, minBlocks: number) {
  const srv = await startServer({
    timeScale,
    buffPlan: ["speed", "gravity", "doublejump", "baseball", "ice", "giants"],
    spawnPoints: (i, n) => ({ x: Math.cos((i / n) * 6.28) * 5, z: Math.sin((i / n) * 6.28) * 5, yaw: 0 }),
  });
  const rnd = seeded(7);
  const bots: Bot[] = [];
  for (let i = 0; i < players; i++) bots.push(await Bot.join(srv.url, `honest${i}`, netFor(i)));
  await waitFor(() => bots.every((b) => b.id > 0), 3000, "welcome");
  await waitFor(() => bots.every((b) => b.playing), 20_000, "round start");
  const over = () => bots[0].phase === "ended" || bots[0].phase === "lobby";
  await Promise.all(bots.map((b, i) => run(b, honestBrain(b, seeded(i + 1)), 60_000, over, browserFrames(rnd))));
  srv.close();

  const hits = bots[0].hurts.filter((h) => h.by !== 0).length;
  const placed = bots.reduce((n, b) => n + b.blocksPlaced, 0);
  const setbacks = bots.reduce((n, b) => n + b.teleports - 1, 0);
  const kinds = Object.entries(Object.groupBy(srv.violations, (v) => v.check)).map(([k, v]) => `${k}×${v?.length}`);
  console.log(`${label}: ${hits} hits, ${placed} blocks, ${setbacks} setbacks, ${srv.violations.length} zero-point corrections ${kinds.join(" ")}`);
  const bad = srv.violations.filter((v) => v.points > 0);
  const context = bad.map((v) => {
    const bot = bots.find((b) => b.id === v.id);
    const near = bot?.log.filter((l) => Math.abs(Number(l.split(" ")[0]) - v.at) < 3000) ?? [];
    return `${v.at} ${v.name} ${v.check}: ${v.detail}\n    ${near.join("\n    ")}`;
  });
  const all = srv.violations.map((v) => `${v.at} ${v.name} ${v.check} +${v.points}: ${v.detail}`);
  assert.equal(bad.length, 0, `${context.join("\n")}\nall corrections:\n${all.join("\n")}`);
  assert.ok(bots.every((b) => !b.closed), "nobody kicked");
  assert.ok(hits >= minHits, `bots should have fought (hits: ${hits})`);
  assert.ok(placed >= minBlocks, `bots should have built (blocks: ${placed})`);
}

describe("honest players", () => {
  it("play a full round with every movement buff and are never flagged", { timeout: 90_000 }, () =>
    honestRound("honest round", 4, 0.05, (i) => jitteryNet(seeded(100 + i)), 5, 10));
  it("on a poor mobile connection are never flagged either", { timeout: 90_000 }, () =>
    honestRound("honest round, mobile", 3, 0.03, (i) => mobileNet(seeded(200 + i)), 2, 5));
});

// ------------------------------------------------------------------ gameplay

describe("gameplay", () => {
  it("health regenerates 1 hp per second after 4 s without damage", { timeout: 30_000 }, async () => {
    const { srv, bots } = await match({ spawnPoints: facing(2.5) });
    const [attacker, victim] = bots;
    const hitAt = Date.now();
    await run(attacker, (dt, now) => {
      attacker.interp(dt);
      idle(attacker)(dt, now);
      if (victim.hp === 20 && now - hitAt < 1000 && attacker.view.has(victim.id)) attacker.hit(victim.id);
    }, 1200, () => victim.hp < 20);
    const hurt = victim.hp;
    assert.ok(hurt < 20, "victim was hit");
    await run(victim, idle(victim), 3000);
    assert.equal(victim.hp, hurt, "no regeneration within 4 s of the hit");
    await run(victim, idle(victim), 3500);
    srv.close();
    assert.ok(victim.hp >= hurt + 2 && victim.hp <= hurt + 4, `regenerated to ${victim.hp} from ${hurt}`);
  });

  it("knocked off the island's edge is out, and the fall is the attacker's kill", { timeout: 30_000 }, async () => {
    // The victim stands on the rim's last cell, the attacker behind it facing out (yaw π looks to +Z).
    // Slow enough that the island doesn't start crumbling meanwhile; spawns are handed out shuffled.
    const { srv, bots } = await match({ timeScale: 0.1, spawnPoints: (i) => ({ x: 0.5, z: i === 0 ? 45 : 47.2, yaw: Math.PI }) });
    const [attacker, victim] = bots[0].body.pos.z < bots[1].body.pos.z ? bots : [bots[1], bots[0]];
    await Promise.all([
      run(attacker, (dt, now) => {
        attacker.interp(dt);
        const t = attacker.view.get(victim.id);
        if (t) lookAt(attacker, { x: t.pos.x, y: t.pos.y + 1.2, z: t.pos.z });
        idle(attacker)(dt, now);
        // One clean hit: the fall has to do the rest.
        if (t && victim.hp === MAX_HP && attacker.canHit()) attacker.hit(victim.id);
      }, 6000, () => !victim.alive),
      run(victim, idle(victim), 6000, () => !victim.alive),
    ]);
    srv.close();
    const kill = victim.kills.find((k) => k.victim === victim.id);
    assert.deepEqual(kill && { killer: kill.killer, reason: kill.reason }, { killer: attacker.id, reason: "fall" });
    assert.equal(victim.hurts.filter((h) => h.id === victim.id).length, 1, "a single hit");
    assert.ok(victim.body.pos.y < FALL_OUT_Y + 2, `fell (y ${victim.body.pos.y.toFixed(2)})`);
    assert.ok(attacker.callouts.includes("ПЕРВАЯ КРОВЬ"), "first blood announced");
    assert.deepEqual(srv.violations.filter((v) => v.points > 0), []);
  });

  it("the island crumbles to a platform, and when overtime runs out the best survivor wins on points", { timeout: 30_000 }, async () => {
    const { srv, bots } = await match({ timeScale: 0.02, spawnPoints: facing(2.5) });
    const [a, b] = bots;
    await Promise.all([
      run(a, (dt, now) => {
        a.interp(dt);
        idle(a)(dt, now);
        // A single hit before overtime: more damage dealt than b.
        if (b.hp === MAX_HP && a.view.has(b.id) && a.canHit() && !a.callouts.includes("ОВЕРТАЙМ")) a.hit(b.id);
      }, 15_000, () => a.phase !== "playing"),
      run(b, idle(b), 15_000, () => b.phase !== "playing"),
    ]);
    await waitFor(() => !!a.results, 3000, "results");
    srv.close();
    assert.equal(a.results?.winnerName, "p0");
    assert.equal(a.results?.pointsWin, true);
    assert.ok(a.callouts.includes("ОВЕРТАЙМ"), "overtime announced");
    assert.equal(a.floor, 3, "crumbled down to the last platform");
    assert.deepEqual(srv.violations.filter((v) => v.points > 0), []);
  });
});

// ------------------------------------------------------------------ cheats

describe("sprint", { concurrency: true, timeout: 60_000 }, () => {
  it("sprinting and sprint-jumping are never flagged; sprint speed without the sprint is", async () => {
    const { srv, bots } = await match({ spawnPoints: facing(24) });
    const [runner, faker] = bots;
    runner.sprint = true;
    faker.hideSprint = true;
    const start = { ...runner.body.pos };
    const run2 = (b: Bot, turn: number) => (dt: number, now: number) => {
      if (!b.playing) return;
      b.yaw += dt * turn;
      // Sprint-jump all the way, like a player crossing the map.
      b.step(dt, { forward: 1, strafe: 0, jump: true, yaw: b.yaw, sprint: true });
      b.maybeSendMove(now);
    };
    await Promise.all([run(runner, run2(runner, 0.35), 7000), run(faker, run2(faker, -0.35), 7000)]);
    srv.close();
    const travelled = Math.hypot(runner.body.pos.x - start.x, runner.body.pos.z - start.z);
    assert.deepEqual(srv.violations.filter((v) => v.id === runner.id && v.points > 0), [], "honest sprinter not flagged");
    assert.equal(runner.teleports, 2, "no setbacks (hub spawn and arena spawn only)");
    assert.ok(travelled > 20, `ran ${travelled.toFixed(1)} blocks`);
    assert.ok(flagged(srv, "speed", faker.id), "sprint speed without sprinting is caught");
  });

  it("a sprint hit knocks back harder and ends the sprint; sprinting hits never crit", async () => {
    const { srv, bots } = await match({ spawnPoints: facing(7) });
    const [att, dummy] = bots;
    type Kind = "sprint" | "walk" | "sprintFall" | "walkFall";
    const got = new Map<Kind, { k: number; ky: number; crit: boolean }>();
    const order: Kind[] = ["sprint", "walk", "sprintFall", "walkFall"];
    let pending: { kind: Kind; at: number; hurts: number } | null = null;
    await run(att, (dt, now) => {
      if (!att.playing) return;
      const kind = order.find((k) => !got.has(k));
      if (!kind) return;
      const mine = att.hurts.filter((h) => h.by === att.id);
      if (pending && mine.length > pending.hurts) {
        const h = mine[mine.length - 1];
        got.set(pending.kind, { k: Math.hypot(h.kx, h.kz), ky: h.ky, crit: h.crit });
        pending = null;
      } else if (pending && now - pending.at > 600) {
        pending = null;
      }
      const t = att.view.get(dummy.id)?.target;
      if (!t) return;
      const d = Math.hypot(t.x - att.body.pos.x, t.z - att.body.pos.z);
      lookAt(att, { x: t.x, y: t.y + 1.2, z: t.z });
      const wantSprint = kind.startsWith("sprint");
      const wantFall = kind.endsWith("Fall");
      if (!wantSprint) att.sprint = false;
      let forward = d > 2.4 ? 1 : 0;
      if (wantSprint && !att.sprint) {
        // Back off for a run-up, then double-tap and charge.
        if (d < 6) forward = -1;
        else if (att.body.onGround) att.sprint = true;
      }
      if (att.sprint) forward = d > 1.2 ? 1 : 0;
      if (forward <= 0) att.sprint = false;
      // Sprint-jumps carry further: take off earlier.
      const [lo, hi] = wantSprint ? [4.5, 6.2] : [2.5, 4.2];
      if (wantFall && !wantSprint && d < lo) forward = -1;
      const jump = wantFall && att.body.onGround && d > lo && d < hi;
      att.step(dt, { forward, strafe: 0, jump, yaw: att.yaw, sprint: att.sprint });
      if (att.body.bumped) att.sprint = false;
      att.maybeSendMove(now);
      const falling = att.body.vel.y < -2;
      const ready = !pending && att.canHit() && att.pick()?.id === dummy.id && (wantFall ? falling : att.body.onGround) && (!wantSprint || att.sprint);
      if (ready) {
        pending = { kind, at: now, hurts: mine.length };
        att.hit(dummy.id);
        if (att.sprint) {
          att.sprint = false;
          att.body.vel.x *= 0.6;
          att.body.vel.z *= 0.6;
        }
      }
    }, 30_000, () => order.every((k) => got.has(k)));
    srv.close();
    const r = Object.fromEntries(got);
    assert.ok(order.every((k) => got.has(k)), `all hits landed: ${JSON.stringify(r)}`);
    assert.ok(r.sprint.k > r.walk.k * 1.8, `sprint knockback ${r.sprint.k} vs ${r.walk.k}`);
    assert.ok(r.sprint.ky > r.walk.ky, "and a bit higher");
    assert.equal(r.sprintFall.crit, false, "no crit while sprinting");
    assert.equal(r.walkFall.crit, true, "a falling hit without sprint is a crit");
    assert.deepEqual(srv.violations.filter((v) => v.points > 0), []);
  });
});

describe("cheats", { concurrency: true, timeout: 60_000 }, () => {
  it("speed hack gets set back and kicked", async () => {
    const { srv, bots } = await match({ spawnPoints: facing(30) });
    const [cheat] = bots;
    await run(cheat, (dt, now) => {
      if (!cheat.playing) return;
      const p = cheat.body.pos;
      const x0 = p.x;
      const z0 = p.z;
      cheat.step(dt, { forward: 1, strafe: 0, jump: false, yaw: cheat.yaw });
      p.x += (p.x - x0) * 0.5;
      p.z += (p.z - z0) * 0.5;
      cheat.maybeSendMove(now);
    }, 8000);
    srv.close();
    assert.ok(flagged(srv, "speed"));
    assert.ok(cheat.teleports > 1, "set back");
    assert.equal(cheat.closed?.code, CLOSE_KICKED);
  });

  it("flying and hovering get caught", async () => {
    const { srv, bots } = await match({ spawnPoints: facing(30) });
    const [cheat] = bots;
    await run(cheat, (dt, now) => {
      if (!cheat.playing) return;
      cheat.step(dt, { forward: 1, strafe: 0, jump: true, yaw: cheat.yaw });
      if (cheat.body.pos.y > 1) {
        cheat.body.pos.y = Math.max(cheat.body.pos.y, 1.2);
        cheat.body.vel.y = 0;
      }
      cheat.maybeSendMove(now);
    }, 8000);
    srv.close();
    assert.ok(flagged(srv, "fly"));
    assert.equal(cheat.closed?.code, CLOSE_KICKED);
  });

  it("high jump gets caught", async () => {
    const { srv, bots } = await match({ spawnPoints: facing(30) });
    const [cheat] = bots;
    await run(cheat, (dt, now) => {
      if (!cheat.playing) return;
      if (cheat.body.onGround) cheat.body.vel.y = 16;
      cheat.step(dt, { forward: 0, strafe: 0, jump: false, yaw: cheat.yaw });
      cheat.maybeSendMove(now);
    }, 3000);
    srv.close();
    assert.ok(flagged(srv, "fly"));
  });

  it("walking through a block gets caught", async () => {
    const { srv, bots } = await match({ spawnPoints: facing(30) });
    const [cheat] = bots;
    const p = cheat.body.pos;
    const fz = cheat.yaw === 0 ? -1 : 1;
    const wall = { x: Math.floor(p.x), y: 0, z: Math.floor(p.z + 2 * fz) };
    cheat.place(wall.x, 0, wall.z);
    await frames(cheat);
    cheat.place(wall.x, 1, wall.z);
    await waitFor(() => cheat.world.get(wall.x, 1, wall.z) === 1, 2000, "wall");
    await sleep(1500); // fresh blocks only cause a free correction: the client may not know them yet
    await run(cheat, (dt, now) => {
      if (!cheat.playing) return;
      p.z += fz * 4 * dt; // ignores collisions
      cheat.simTime += dt * 1000;
      cheat.maybeSendMove(now);
    }, 3000);
    srv.close();
    assert.ok(flagged(srv, "noclip"));
    assert.ok(cheat.teleports > 1, "set back");
  });

  it("speeding up the game clock gets caught", async () => {
    const { srv, bots } = await match({ spawnPoints: facing(30) });
    const [cheat] = bots;
    await run(cheat, (dt, now) => {
      if (!cheat.playing) return;
      cheat.step(dt * 1.6, { forward: 1, strafe: 0, jump: false, yaw: cheat.yaw }, 1);
      cheat.maybeSendMove(now);
    }, 5000);
    srv.close();
    assert.ok(flagged(srv, "timer"));
  });

  it("long reach hits are refused", async () => {
    const { srv, bots } = await match({ spawnPoints: facing(5) });
    const [cheat, dummy] = bots;
    await run(cheat, (dt, now) => {
      if (!cheat.playing) return;
      const t = [...cheat.view.values()][0];
      if (!t) return;
      const a = aimAt(cheat.eye(), { x: t.target.x, y: t.target.y + 1, z: t.target.z });
      cheat.yaw = a.yaw;
      cheat.pitch = a.pitch;
      cheat.step(dt, { forward: 0, strafe: 0, jump: false, yaw: cheat.yaw });
      if (now % 500 < 20) cheat.hit(dummy.id);
      cheat.maybeSendMove(now);
    }, 3000);
    srv.close();
    assert.ok(flagged(srv, "reach"));
    assert.equal(dummy.hp, 20);
  });

  it("kill aura without aiming is refused", async () => {
    const { srv, bots } = await match({ spawnPoints: facing(2.5) });
    const [cheat, dummy] = bots;
    cheat.yaw += Math.PI; // looking away from the target
    await run(cheat, (dt, now) => {
      idle(cheat)(dt, now);
      if (now % 500 < 20) cheat.hit(dummy.id);
    }, 3000);
    srv.close();
    assert.ok(flagged(srv, "aim"));
    assert.equal(dummy.hp, 20);
  });

  it("hits through a wall are refused", async () => {
    const { srv, bots } = await match({ spawnPoints: facing(3) });
    const [cheat, dummy] = bots;
    const p = cheat.body.pos;
    const fz = cheat.yaw === 0 ? -1 : 1;
    const wz = Math.floor(p.z + 1.6 * fz);
    cheat.place(Math.floor(p.x), 0, wz);
    await frames(cheat);
    cheat.place(Math.floor(p.x), 1, wz);
    await waitFor(() => cheat.world.get(Math.floor(p.x), 1, wz) === 1, 2000, "wall");
    await run(cheat, (dt, now) => {
      if (!cheat.playing) return;
      const t = [...cheat.view.values()][0];
      if (!t) return;
      const a = aimAt(cheat.eye(), { x: t.target.x, y: t.target.y + 1.4, z: t.target.z });
      cheat.yaw = a.yaw;
      cheat.pitch = a.pitch;
      idle(cheat)(dt, now);
      if (now % 500 < 20) cheat.hit(dummy.id);
    }, 3000);
    srv.close();
    assert.ok(flagged(srv, "wall"));
    assert.equal(dummy.hp, 20);
  });

  it("hitting faster than the cooldown is capped", async () => {
    const { srv, bots } = await match({ spawnPoints: facing(2.5) });
    const [cheat, dummy] = bots;
    const start = Date.now();
    await run(cheat, (dt, now) => {
      idle(cheat)(dt, now);
      if (now % 100 < 20) cheat.hit(dummy.id);
    }, 2000);
    const elapsed = Date.now() - start;
    srv.close();
    const landed = cheat.hurts.filter((h) => h.by === cheat.id).length;
    assert.ok(flagged(srv, "hitrate"));
    assert.ok(landed <= Math.ceil(elapsed / HIT_COOLDOWN_MS) + 1, `landed ${landed} hits in ${elapsed}ms`);
  });

  it("faked falls give no critical hits", async () => {
    const { srv, bots } = await match({ spawnPoints: facing(2.5) });
    const [cheat, dummy] = bots;
    await run(cheat, (dt, now) => {
      if (!cheat.playing) return;
      cheat.step(dt, { forward: 0, strafe: 0, jump: false, yaw: cheat.yaw });
      if (now % 500 < 20) {
        // Pretend to be falling from a tiny hop right before the hit.
        Object.assign(cheat.body.pos, { y: 0.3 });
        cheat.body.vel.y = -2;
        cheat.simTime += 16;
        cheat.hit(dummy.id);
        Object.assign(cheat.body.pos, { y: 0 });
        cheat.body.vel.y = 0;
      }
      cheat.maybeSendMove(now);
    }, 3000);
    srv.close();
    assert.ok(flagged(srv, "fly"));
    assert.ok(cheat.hurts.every((h) => !h.crit));
  });

  for (const mode of ["ack", "silent"] as const) it(`ignoring knockback gets caught (${mode})`, async () => {
    const { srv, bots } = await match({ spawnPoints: facing(2.5) });
    const [cheat, attacker] = bots;
    cheat.ignoreKnockback = mode;
    let lastHit = 0;
    const ms = mode === "ack" ? 4000 : 8000;
    await Promise.all([
      run(cheat, idle(cheat), ms),
      run(attacker, (dt, now) => {
        attacker.interp(dt);
        if (!attacker.playing) return;
        const t = attacker.view.get(cheat.id);
        if (t) {
          const a = aimAt(attacker.eye(), { x: t.pos.x, y: t.pos.y + 1, z: t.pos.z });
          attacker.yaw = a.yaw;
          attacker.pitch = a.pitch;
        }
        attacker.step(dt, { forward: 0, strafe: 0, jump: false, yaw: attacker.yaw });
        if (t && now - lastHit > 2200 && cheat.hp > 8) {
          lastHit = now;
          attacker.hit(cheat.id);
        }
        attacker.maybeSendMove(now);
      }, ms),
    ]);
    srv.close();
    assert.ok(cheat.hurts.some((h) => h.id === cheat.id), "the cheater was hit");
    assert.ok(flagged(srv, "velocity", cheat.id));
    assert.ok(!srv.violations.some((v) => v.id === attacker.id && v.points > 0), "the honest attacker is clean");
  });

  it("placing and breaking through walls or out of reach is refused", async () => {
    const { srv, bots } = await match({ spawnPoints: facing(30) });
    const [cheat] = bots;
    const p = cheat.body.pos;
    const x = Math.floor(p.x);
    const fz = cheat.yaw === 0 ? -1 : 1;
    const at = (k: number) => Math.floor(p.z + k * fz);
    cheat.place(x, 0, at(3)); // behind the wall, placed first while visible
    await frames(cheat);
    cheat.place(x, 0, at(2));
    await frames(cheat);
    cheat.place(x, 1, at(2));
    await waitFor(() => cheat.world.get(x, 1, at(2)) === 1 && cheat.world.get(x, 0, at(3)) === 1, 2000, "blocks");
    await frames(cheat);
    cheat.breakBlock(x, 0, at(3));
    await frames(cheat);
    cheat.place(x, 0, at(9));
    await sleep(400);
    srv.close();
    assert.equal(cheat.world.get(x, 0, at(3)), 1, "block behind the wall survives");
    assert.equal(cheat.world.get(x, 0, at(9)), 0, "nothing placed 9 blocks away");
    assert.ok(srv.violations.filter((v) => v.check === "build").length >= 2);
  });

  it("message floods get kicked, and a repeat offender banned", async () => {
    const srv = await startServer({ anticheat: { ipHeader: "x-test-ip" } });
    for (let round = 0; round < 2; round++) {
      const bot = await Bot.join(srv.url, "flood", LAN, "6.6.6.6");
      await waitFor(() => bot.id > 0, 2000, "welcome");
      for (let i = 0; i < 2000; i++) bot.ws.send(JSON.stringify({ t: "watch", on: false }));
      await waitFor(() => !!bot.closed, 3000, "kick");
      assert.equal(bot.closed?.code, CLOSE_KICKED);
    }
    const again = await Bot.join(srv.url, "flood", LAN, "6.6.6.6");
    await waitFor(() => !!again.closed, 2000, "ban");
    srv.close();
    assert.equal(again.closed?.code, CLOSE_BANNED);
  });

  it("limits connections per IP and refuses outdated clients", async () => {
    const srv = await startServer({ anticheat: { ipHeader: "x-test-ip", maxConnPerIp: 2 } });
    const a = await Bot.join(srv.url, "a", LAN, "7.7.7.7");
    const b = await Bot.join(srv.url, "b", LAN, "7.7.7.7");
    const c = await Bot.join(srv.url, "c", LAN, "7.7.7.7");
    const old = await Bot.join(srv.url, "old", LAN, "8.8.8.8", PROTOCOL_VERSION - 1);
    // Behind a proxy that passes no X-Forwarded-For every player shares one address: no limit then.
    const shared: Bot[] = [];
    for (let i = 0; i < 4; i++) shared.push(await Bot.join(srv.url, `lan${i}`));
    await waitFor(() => !!c.closed && !!old.closed && shared.every((s) => s.id > 0), 2000, "refusals");
    await sleep(200);
    srv.close();
    assert.ok(shared.every((s) => !s.closed), "players sharing an unknown address are all admitted");
    assert.ok(a.id > 0 && b.id > 0);
    assert.equal(c.closed?.code, CLOSE_TOO_MANY);
    assert.equal(old.closed?.code, CLOSE_OUTDATED);
  });

  it("night and invisibility hide far players from the network (anti-ESP)", async () => {
    const srv = await startServer({ timeScale: 0.02, buffPlan: ["night", "invisible"], spawnPoints: facing(20), anticheat: { ipHeader: "x-test-ip" } });
    const a = await Bot.join(srv.url, "a", LAN, "1.1.1.1");
    const b = await Bot.join(srv.url, "b", LAN, "2.2.2.2");
    await waitFor(() => a.id > 0 && b.id > 0, 2000, "welcome");
    await waitFor(() => a.playing && b.playing, 20_000, "round start");
    const ghost = await Bot.join(srv.url, "ghost", LAN, "1.1.1.1"); // second tab of player a
    const viewer = await Bot.join(srv.url, "viewer", LAN, "3.3.3.3");
    await waitFor(() => ghost.inHub && viewer.inHub, 3000, "late joiners land in the hub");
    ghost.send({ t: "watch", on: true });
    viewer.send({ t: "watch", on: true });
    await waitFor(() => ghost.worldView === "arena" && viewer.worldView === "arena", 3000, "watching the arena");
    const ids = (bot: Bot) => new Set((bot.ticks.at(-1) ?? []).filter((_, i) => i % 7 === 0));
    await waitFor(() => ids(a).has(b.id), 2000, "clear view before the buff");
    for (const buff of ["night", "invisible"] as const) {
      await waitFor(() => a.buffs.includes(buff), 8000, buff);
      await sleep(200);
      assert.ok(!ids(a).has(b.id), `${buff}: a must not receive b`);
      assert.ok(!ids(b).has(a.id), `${buff}: b must not receive a`);
      assert.ok(!ids(ghost).has(b.id), `${buff}: a's second tab must not receive b`);
      assert.ok(ids(viewer).has(a.id) && ids(viewer).has(b.id), `${buff}: other spectators see everyone`);
    }
    srv.close();
  });
});
