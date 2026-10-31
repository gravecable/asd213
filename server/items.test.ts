// Chests and their items against a real server: opening a chest, the golden apple, snowballs, the
// ender pearl, the shield and TNT. Chests sit at fixed spots with fixed loot on a bare island.
// Run: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APPLE_HEAL, BUILD_REACH, HIT_DAMAGE, MAX_HP, TNT_FUSE_MS, lookDir, raycastVoxels } from "../src/game/shared.ts";
import type { ItemId, Vec3 } from "../src/game/shared.ts";
import { Bot, idle, lookAt, match, run, waitFor, walkPath } from "./test-utils.ts";
import type { TestServer } from "./test-utils.ts";

const noPoints = (srv: TestServer) => assert.deepEqual(srv.violations.filter((v) => v.points > 0), []);

/** A round on a bare island: player spots `at`, a chest under the first player, chests holding `loot`. */
async function itemsRound(loot: ItemId[], at: { x: number; z: number; yaw: number }[], chests = [at[0]]) {
  const { srv, bots } = await match({ timeScale: 0.2, spawnPoints: (i) => at[i], chestSpots: chests.map(({ x, z }) => ({ x, z })), loot }, at.length);
  // Spawns are handed out shuffled: put the bots in the order of `at`.
  const near = (b: Bot, p: { x: number; z: number }) => Math.hypot(b.body.pos.x - p.x, b.body.pos.z - p.z);
  const ordered = at.map((p) => bots.reduce((best, b) => (near(b, p) < near(best, p) ? b : best)));
  return { srv, bots: ordered };
}

/** Runs everyone's frames (idle unless given one) until `done`. */
const all = (bots: Bot[], ms: number, done: () => boolean, frames = new Map<Bot, (dt: number, now: number) => void>()) =>
  Promise.all(bots.map((b) => run(b, frames.get(b) ?? idle(b), ms, done)));

/** `att` swings at `t` once (when in reach and cooled down). */
async function hitOnce(att: Bot, t: Bot, bots: Bot[]) {
  const before = t.hurts.filter((h) => h.id === t.id).length;
  let swung = false;
  const frame = (dt: number, now: number) => {
    att.interp(dt);
    const v = att.view.get(t.id);
    if (v) lookAt(att, { x: v.pos.x, y: v.pos.y + 1.2, z: v.pos.z });
    idle(att)(dt, now);
    if (v && !swung && att.canHit()) {
      swung = true;
      att.hit(t.id);
    }
  };
  await all(bots, 3000, () => t.hurts.filter((h) => h.id === t.id).length > before, new Map([[att, frame]]));
}

describe("chests and items", () => {
  it("walking into a chest gives its item; a golden apple heals", { timeout: 40_000 }, async () => {
    const { srv, bots } = await itemsRound(["apple"], [{ x: 0.5, z: 0.5, yaw: 0 }, { x: 2.7, z: 0.5, yaw: 0 }], [{ x: 0.5, z: -3.5 }]);
    const [a, b] = bots;
    assert.equal(a.chests.length, 1, "the chest is on the island");
    await Promise.all([walkPath(a, [{ x: 0.5, z: -3.5 }], 6000), run(b, idle(b), 6000, () => a.count("apple") > 0)]);
    await waitFor(() => a.count("apple") === 1 && a.chests.length === 0, 3000, "the apple");
    assert.ok(a.fxs.some((f) => f.fx === "chest"), "the chest opened");
    // At full health the apple stays in the pocket.
    a.use("apple");
    await all(bots, 400, () => false);
    assert.equal(a.count("apple"), 1);
    await walkPath(a, [{ x: 0.5, z: 0.5 }], 6000);
    await hitOnce(b, a, bots);
    await waitFor(() => a.hp === MAX_HP - HIT_DAMAGE, 2000, "the hit");
    a.use("apple");
    await all(bots, 2000, () => a.count("apple") === 0);
    assert.equal(a.hp, Math.min(MAX_HP, MAX_HP - HIT_DAMAGE + APPLE_HEAL));
    assert.ok(a.fxs.some((f) => f.fx === "eat" && f.id === a.id));
    srv.close();
    noPoints(srv);
  });

  it("a snowball pushes without hurting; knocked off the edge, the thrower gets the kill", { timeout: 40_000 }, async () => {
    // The victim on the rim's last cell, the thrower behind it facing out (yaw π looks to +Z).
    const { srv, bots } = await itemsRound(["snowball"], [{ x: 0.5, z: 43.5, yaw: Math.PI }, { x: 0.5, z: 47.2, yaw: Math.PI }]);
    const [a, b] = bots;
    await waitFor(() => a.count("snowball") > 0, 3000, "snowballs");
    let thrown = 0;
    let at = 0;
    const thrower = (dt: number, now: number) => {
      a.interp(dt);
      const v = a.view.get(b.id);
      if (v) lookAt(a, { x: v.pos.x, y: v.pos.y + 1.4, z: v.pos.z });
      idle(a)(dt, now);
      if (v && b.alive && now - at > 400 && a.count("snowball") > 0) {
        at = now;
        thrown++;
        a.use("snowball");
      }
    };
    await all(bots, 8000, () => !b.alive, new Map([[a, thrower]]));
    srv.close();
    const kill = b.kills.find((k) => k.victim === b.id);
    assert.deepEqual(kill && { killer: kill.killer, reason: kill.reason }, { killer: a.id, reason: "fall" });
    assert.ok(thrown >= 1);
    assert.ok(b.hurts.filter((h) => h.id === b.id).every((h) => h.dmg === 0), "snowballs do no damage");
    noPoints(srv);
  });

  it("an ender pearl takes its thrower where it lands", { timeout: 40_000 }, async () => {
    const { srv, bots } = await itemsRound(["pearl"], [{ x: 0.5, z: 0.5, yaw: 0 }, { x: 20.5, z: 20.5, yaw: 0 }]);
    const [a] = bots;
    await waitFor(() => a.count("pearl") === 1, 3000, "the pearl");
    const teleports = a.teleports;
    a.yaw = 0;
    a.pitch = 0;
    a.use("pearl");
    await all(bots, 3000, () => a.teleports > teleports);
    await all(bots, 600, () => false);
    const p = a.body.pos;
    assert.ok(p.z < -6 && Math.abs(p.x - 0.5) < 1, `landed ahead (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`);
    assert.ok(Math.abs(p.y) < 0.05 && a.body.onGround, "on the floor");
    assert.equal(a.count("pearl"), 0);
    assert.ok(a.fxs.some((f) => f.fx === "pearl" && f.id === a.id));
    srv.close();
    noPoints(srv);
  });

  it("a raised shield takes the next hit without damage, then it's down", { timeout: 40_000 }, async () => {
    const { srv, bots } = await itemsRound(["shield"], [{ x: 0.5, z: 0.5, yaw: 0 }, { x: 2.7, z: 0.5, yaw: 0 }]);
    const [a, b] = bots;
    await waitFor(() => a.count("shield") === 1, 3000, "the shield");
    a.use("shield");
    await all(bots, 2000, () => !!a.roster.find((p) => p.id === a.id)?.shield);
    assert.ok(a.roster.find((p) => p.id === a.id)?.shield, "everyone sees the shield");
    await hitOnce(b, a, bots);
    await all(bots, 600, () => false);
    assert.equal(a.hp, MAX_HP, "the shield took it");
    assert.ok(a.fxs.some((f) => f.fx === "block" && f.id === a.id));
    assert.ok(!a.roster.find((p) => p.id === a.id)?.shield, "the shield is down");
    await hitOnce(b, a, bots);
    await waitFor(() => a.hp === MAX_HP - HIT_DAMAGE, 2000, "the next hit hurts");
    srv.close();
    noPoints(srv);
  });

  it("TNT goes off a few seconds after it's set and hurts whoever is near", { timeout: 40_000 }, async () => {
    const { srv, bots } = await itemsRound(["tnt"], [{ x: 0.5, z: 0.5, yaw: 0 }, { x: 2.7, z: -1.5, yaw: 0 }]);
    const [a, b] = bots;
    await waitFor(() => a.count("tnt") === 1, 3000, "the TNT");
    const floor: Vec3 = { x: 0.5, y: 0, z: -1.5 };
    lookAt(a, floor);
    const hit = raycastVoxels(a.world, a.eye(), lookDir(a.yaw, a.pitch), BUILD_REACH);
    assert.ok(hit, "aims at the floor");
    const cell: [number, number, number] = [hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz];
    const setAt = Date.now();
    a.use("tnt", cell);
    await all(bots, 2000, () => a.tnts.length === 1);
    assert.deepEqual(a.tnts.map((t) => [t.x, t.y, t.z]), [cell]);
    await all(bots, TNT_FUSE_MS + 3000, () => b.hp < MAX_HP);
    assert.ok(Date.now() - setAt >= TNT_FUSE_MS - 200, "not before the fuse burnt down");
    assert.ok(b.hp < MAX_HP, `the blast hurt the neighbour (hp ${b.hp})`);
    assert.equal(a.tnts.length, 0);
    srv.close();
    noPoints(srv);
  });
});
