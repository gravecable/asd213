import { Voxels, BLOCK, ARENA_RADIUS, MAX_HEIGHT } from "../src/game/shared.ts";
import { generateMap, seededRandom } from "./maps.ts";
import type { MapId } from "../src/game/shared.ts";
const id = (process.argv[2] ?? "meadow") as MapId;
const seed = Number(process.argv[3] ?? 1);
const hill = process.argv[4] === "hill";
const v = new Voxels();
v.floorRadius = ARENA_RADIUS;
const t0 = performance.now();
generateMap(v, id, { hill }, seededRandom(seed));
const ms = performance.now() - t0;
const counts: Record<number, number> = {};
let maxY = 0;
for (const i of v.filled) { counts[v.data[i]] = (counts[v.data[i]] ?? 0) + 1; maxY = Math.max(maxY, Voxels.decode(i)[1]); }
const names = Object.fromEntries(Object.entries(BLOCK).map(([k, n]) => [n, k]));
console.log(id, "seed", seed, "blocks", v.filled.size, "holes", v.holes.size, "maxY", maxY, "ms", ms.toFixed(1), Object.entries(counts).map(([k, n]) => `${names[k]}:${n}`).join(" "), "json", JSON.stringify(v.toQuads()).length);
if (process.argv[5] !== "quiet") {
  const ch = (x: number, z: number) => {
    if (Math.hypot(x + 0.5, z + 0.5) > ARENA_RADIUS) return " ";
    if (v.holes.has(Voxels.cell(x, z)) && !v.get(x, 0, z)) return "#";
    let top = -1; for (let y = MAX_HEIGHT - 1; y >= 0; y--) if (v.get(x, y, z)) { top = y; break; }
    if (top < 0) return ".";
    const t = v.get(x, top, z);
    if (t === BLOCK.leaves) return "T"; if (t === BLOCK.log) return "|"; if (t === BLOCK.planks) return "="; if (t === BLOCK.bricks) return "B"; if (t === BLOCK.bone) return "o"; if (t === BLOCK.gold) return "$"; if (t === BLOCK.obsidian) return "O";
    return String(Math.min(9, top + 1));
  };
  for (let z = -ARENA_RADIUS - 1; z <= ARENA_RADIUS; z += 2) { let row = ""; for (let x = -ARENA_RADIUS - 1; x <= ARENA_RADIUS; x++) row += ch(x, z); console.log(row); }
}
