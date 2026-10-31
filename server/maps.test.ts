// Arena maps: what the generator guarantees for every theme, then rounds on generated maps against
// a real server (blocks and holes reach the clients, players start on solid ground, the map can't be
// mined, a hole is a way out).
// Run: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ARENA_RADIUS, BLOCK, HILL_RADIUS, MAP_IDS, MAX_HEIGHT, PLAYER_HALF_WIDTH, SPAWN_RADIUS, Voxels, breakable, cellInRing, raycastVoxels } from "../src/game/shared.ts";
import type { MapId } from "../src/game/shared.ts";
import { HOLE_MIN_R, MAP_TOP, SPAWN_BAND, generateMap, seededRandom } from "./maps.ts";
import { frames, idle, lookAt, match, run, walkPath, waitFor } from "./test-utils.ts";

const R = ARENA_RADIUS;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

function build(id: MapId, seed: number, hill = false): Voxels {
  const v = new Voxels();
  v.floorRadius = R;
  generateMap(v, id, { hill }, seededRandom(seed));
  return v;
}

const dist = (x: number, z: number) => Math.hypot(x + 0.5, z + 0.5);

function* columns(): Generator<[number, number]> {
  for (let x = -R - 1; x <= R; x++) for (let z = -R - 1; z <= R; z++) if (cellInRing(x, z, R)) yield [x, z];
}

const stands = (v: Voxels, x: number, y: number, z: number) => v.solid(x, y - 1, z) && !v.solid(x, y, z) && !v.solid(x, y + 1, z);

/** Lowest spot a player could stand on in a column, if any. */
function lowest(v: Voxels, x: number, z: number): number | null {
  for (let y = 0; y < MAX_HEIGHT - 1; y++) if (stands(v, x, y, z)) return y;
  return null;
}

/** Every standing spot reachable on foot from `from`: steps up of one block (with room to jump),
 *  drops of any height, never into a hole. */
function walkable(v: Voxels, from: [number, number, number]): Set<number> {
  const seen = new Set([Voxels.index(...from)]);
  const queue = [from];
  const add = (x: number, y: number, z: number) => {
    const k = Voxels.index(x, y, z);
    if (seen.has(k)) return;
    seen.add(k);
    queue.push([x, y, z]);
  };
  while (queue.length) {
    const [x, y, z] = queue.pop()!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const nz = z + dz;
      if (v.solid(nx, y, nz)) {
        if (stands(v, nx, y + 1, nz) && !v.solid(x, y + 2, z)) add(nx, y + 1, nz);
      } else if (!v.solid(nx, y + 1, nz)) {
        let ny = y;
        while (ny > 0 && !v.solid(nx, ny - 1, nz)) ny--;
        if (v.solid(nx, ny - 1, nz)) add(nx, ny, nz);
      }
    }
  }
  return seen;
}

describe("map generator", () => {
  it("stays on the island and under the ceiling; keeps the start circle low and holes out of the final ring", () => {
    for (const id of MAP_IDS)
      for (const seed of SEEDS) {
        const v = build(id, seed);
        const what = `${id} #${seed}`;
        assert.ok(v.filled.size > 1000, `${what}: ${v.filled.size} blocks`);
        for (const i of v.filled) {
          const [x, y, z] = Voxels.decode(i);
          assert.ok(cellInRing(x, z, R - 0.5) && y < MAP_TOP, `${what}: block at ${x},${y},${z}`);
          // The start circle: low hills and bridge posts at most.
          if (Math.abs(dist(x, z) - SPAWN_RADIUS) < SPAWN_BAND) assert.ok(y <= 1, `${what}: tall block at ${x},${y},${z} by the start circle`);
        }
        for (const i of v.holes) {
          const [x, , z] = Voxels.decode(i);
          assert.ok(dist(x, z) >= HOLE_MIN_R, `${what}: hole at ${x},${z} inside the final ring`);
        }
      }
  });

  it("the same seed builds the same map, another seed another one", () => {
    for (const id of MAP_IDS) {
      const a = build(id, 42);
      const b = build(id, 42);
      const c = build(id, 43);
      assert.deepEqual(a.toQuads(), b.toQuads(), id);
      assert.deepEqual(a.holeList(), b.holeList(), id);
      assert.notDeepEqual(a.toQuads(), c.toQuads(), id);
    }
  });

  it("the ground is one piece you can walk all over, bridges included", () => {
    for (const id of MAP_IDS)
      for (const seed of SEEDS) {
        const v = build(id, seed);
        const low = new Map<string, number>();
        for (const [x, z] of columns()) {
          const y = lowest(v, x, z);
          if (y !== null) low.set(`${x},${z}`, y);
        }
        const [sx, sz] = [Math.floor(SPAWN_RADIUS * Math.cos(seed)), Math.floor(SPAWN_RADIUS * Math.sin(seed))];
        const start = [...low].map(([k, y]) => [...k.split(",").map(Number), y]).sort((a, b) => Math.hypot(a[0] - sx, a[1] - sz) - Math.hypot(b[0] - sx, b[1] - sz))[0];
        const seen = walkable(v, [start[0], start[2], start[1]]);
        let all = 0;
        let reached = 0;
        let groundAll = 0;
        let groundReached = 0;
        for (const [k, y] of low) {
          const [x, z] = k.split(",").map(Number);
          const ok = seen.has(Voxels.index(x, y, z));
          all++;
          reached += Number(ok);
          // Floor, low hills and bridge decks (tree tops, wall tops and roofs may need a dirt block).
          if (y <= 1) {
            groundAll++;
            groundReached += Number(ok);
          }
        }
        assert.ok(reached / all > 0.97, `${id} #${seed}: ${reached}/${all} columns reachable`);
        assert.ok(groundReached / groundAll > 0.99, `${id} #${seed}: ${groundReached}/${groundAll} ground cells reachable`);
      }
  });

  it("the canyon's chasm is crossed by plank bridges", () => {
    for (const seed of SEEDS) {
      const v = build("canyon", seed);
      assert.ok(v.holes.size > 150, `canyon #${seed}: ${v.holes.size} holes`);
      const decks = [...v.holes].filter((i) => v.data[i] === BLOCK.planks).length;
      assert.ok(decks >= 15, `canyon #${seed}: ${decks} bridge cells`);
    }
  });

  it("King of the Hill: the hill stays flat and open", () => {
    for (const id of MAP_IDS)
      for (const seed of SEEDS) {
        const v = build(id, seed, true);
        for (const i of v.filled) {
          const [x, , z] = Voxels.decode(i);
          assert.ok(dist(x, z) > HILL_RADIUS + 2, `${id} #${seed}: block on the hill at ${x},${z}`);
        }
      }
  });

  it("players may break dirt and snow, nothing else the map is made of", () => {
    assert.deepEqual(
      Object.entries(BLOCK)
        .filter(([, t]) => breakable(t))
        .map(([n]) => n),
      ["dirt", "snow"],
    );
  });
});

/** A floor cell of `v` with no hole within `clear` cells and nothing built within `clear` cells. */
function openCell(v: Voxels, near: (x: number, z: number) => boolean, clear = 2): [number, number] | null {
  for (const [x, z] of columns()) {
    if (!near(x, z) || dist(x, z) > R - 6) continue;
    let ok = true;
    for (let dx = -clear; dx <= clear && ok; dx++)
      for (let dz = -clear; dz <= clear && ok; dz++) ok = v.floored(x + dx, z + dz) && !v.get(x + dx, 0, z + dz) && !v.get(x + dx, 1, z + dz) && !v.get(x + dx, 2, z + dz);
    if (ok) return [x, z];
  }
  return null;
}

describe("rounds on a map", () => {
  it("clients get the map's blocks and holes, start standing on it, and can't mine it", { timeout: 40_000 }, async () => {
    const seed = 11;
    const local = build("canyon", seed);
    // A spot on open floor right next to a block of the map, facing it.
    let spot: { x: number; z: number; block: [number, number, number] } | null = null;
    for (const i of local.filled) {
      const [x, y, z] = Voxels.decode(i);
      if (y !== 0 || breakable(local.data[i]) || dist(x, z) > 30 || dist(x, z) < 14) continue;
      const c = openCell(local, (cx, cz) => Math.abs(cx - x) + Math.abs(cz - z) === 3 && (cx === x || cz === z), 1);
      if (c) {
        spot = { x: c[0] + 0.5, z: c[1] + 0.5, block: [x, y, z] };
        break;
      }
    }
    assert.ok(spot, "a spot by a map block");
    const s = spot;
    const { srv, bots } = await match({ map: "canyon", mapSeed: seed, timeScale: 0.2, spawnPoints: (i) => (i === 0 ? { x: s.x, z: s.z, yaw: 0 } : { x: 0.5, z: 0.5, yaw: 0 }) });
    for (const b of bots) {
      assert.equal(b.map, "canyon");
      assert.deepEqual(b.world.toQuads().sort(), local.toQuads().sort(), "the same blocks as the generator's");
      assert.deepEqual(b.world.holeList().sort(), local.holeList().sort(), "the same holes");
    }
    await Promise.all(bots.map((b) => frames(b, 600)));
    for (const b of bots) {
      const p = b.body.pos;
      assert.ok(b.body.onGround && p.y >= 0, `bot ${b.id} stands (y ${p.y.toFixed(2)})`);
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const cx = Math.floor(p.x + dx * PLAYER_HALF_WIDTH * 0.9);
        const cz = Math.floor(p.z + dz * PLAYER_HALF_WIDTH * 0.9);
        assert.ok(!b.world.solid(cx, Math.floor(p.y + 0.5), cz), `bot ${b.id} isn't inside a block`);
      }
    }
    const bot = bots.find((b) => Math.hypot(b.body.pos.x - s.x, b.body.pos.z - s.z) < 1.5);
    assert.ok(bot, "a bot spawned at the spot");
    const [bx, by, bz] = s.block;
    lookAt(bot, { x: bx + 0.5, y: by + 0.5, z: bz + 0.5 });
    const hit = raycastVoxels(bot.world, bot.eye(), { x: bx + 0.5 - bot.eye().x, y: by + 0.5 - bot.eye().y, z: bz + 0.5 - bot.eye().z }, 6);
    assert.deepEqual(hit && [hit.x, hit.y, hit.z], [bx, by, bz], "the bot sees the block");
    bot.breakBlock(bx, by, bz);
    await run(bot, idle(bot), 500);
    assert.ok(!bot.blocks.some((m) => m.x === bx && m.y === by && m.z === bz), "the map's block stays");
    srv.close();
    assert.deepEqual(srv.violations.filter((v) => v.points > 0), []);
  });

  it("walking into a hole is a fall out of the round", { timeout: 40_000 }, async () => {
    const seed = 5;
    const local = build("canyon", seed);
    // Open floor a few cells from the chasm, walking straight at it.
    let plan: { from: [number, number]; to: [number, number] } | null = null;
    for (const i of local.holes) {
      const [hx, , hz] = Voxels.decode(i);
      if (local.get(hx, 0, hz)) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const fx = hx + dx * 4;
        const fz = hz + dz * 4;
        let clear = true;
        for (let k = 1; k <= 5 && clear; k++) clear = local.floored(hx + dx * k, hz + dz * k) && !local.get(hx + dx * k, 0, hz + dz * k) && !local.get(hx + dx * k, 1, hz + dz * k);
        if (!clear || !openCell(local, (x, z) => x === fx && z === fz, 1) || dist(fx, fz) > 36) continue;
        plan = { from: [fx, fz], to: [hx, hz] };
        break;
      }
      if (plan) break;
    }
    assert.ok(plan, "a run-up to the chasm");
    const p = plan;
    const { srv, bots } = await match({ map: "canyon", mapSeed: seed, timeScale: 0.2, spawnPoints: (i) => (i === 0 ? { x: p.from[0] + 0.5, z: p.from[1] + 0.5, yaw: 0 } : { x: 0.5, z: 0.5, yaw: 0 }) });
    const runner = bots.find((b) => Math.hypot(b.body.pos.x - p.from[0] - 0.5, b.body.pos.z - p.from[1] - 0.5) < 1.5);
    assert.ok(runner, "a bot at the run-up");
    const other = bots.find((b) => b !== runner)!;
    await Promise.all([walkPath(runner, [{ x: p.to[0] + 0.5, z: p.to[1] + 0.5 }], 5000), run(other, idle(other), 5000, () => !runner.alive)]);
    await waitFor(() => runner.kills.some((k) => k.victim === runner.id), 5000, "the fall");
    srv.close();
    const kill = runner.kills.find((k) => k.victim === runner.id);
    assert.equal(kill?.reason, "fall");
    assert.deepEqual(srv.violations.filter((v) => v.points > 0), []);
  });
});
