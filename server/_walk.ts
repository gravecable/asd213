import { Voxels, ARENA_RADIUS, MAX_HEIGHT, SPAWN_RADIUS, MAP_IDS, cellInRing } from "../src/game/shared.ts";
import { generateMap, seededRandom } from "./maps.ts";
import type { MapId } from "../src/game/shared.ts";
const R = ARENA_RADIUS;
function analyse(id: MapId, seed: number, hill = false) {
  const v = new Voxels();
  v.floorRadius = R;
  generateMap(v, id, { hill }, seededRandom(seed));
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const stands = (x: number, y: number, z: number) => v.solid(x, y - 1, z) && !v.solid(x, y, z) && !v.solid(x, y + 1, z) && cellInRing(x, z, R);
  // lowest standing height per column
  const low = new Map<string, number>();
  for (let x = -R - 1; x <= R; x++) for (let z = -R - 1; z <= R; z++) {
    if (!cellInRing(x, z, R)) continue;
    for (let y = 0; y < MAX_HEIGHT - 1; y++) if (stands(x, y, z)) { low.set(`${x},${z}`, y); break; }
  }
  const start = (() => { for (let a = 0; a < 6.3; a += 0.1) { const x = Math.floor(Math.cos(a) * SPAWN_RADIUS), z = Math.floor(Math.sin(a) * SPAWN_RADIUS); const y = low.get(`${x},${z}`); if (y !== undefined) return [x, y, z]; } return null; })()!;
  const seen = new Set<string>([key(start[0], start[1], start[2])]);
  const q = [start];
  while (q.length) {
    const [x, y, z] = q.pop()!;
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, nz = z + dz;
      for (let ny = Math.min(MAX_HEIGHT - 2, y + 1); ny >= 0; ny--) {
        if (ny === y + 1 && v.solid(x, y + 2, z)) continue;
        // walking off: must pass through air at the neighbour from y down to ny
        if (!stands(nx, ny, nz)) { if (ny <= y && v.solid(nx, ny, nz) ) break; continue; }
        const k = key(nx, ny, nz);
        if (!seen.has(k)) { seen.add(k); q.push([nx, ny, nz]); }
        break;
      }
    }
  }
  let reach = 0; const miss: string[] = [];
  for (const [c, y] of low) { const [x, z] = c.split(",").map(Number); if (seen.has(key(x, y, z))) reach++; else miss.push(`${c}@${y}`); }
  return { id, seed, cols: low.size, reach, pct: ((100 * reach) / low.size).toFixed(2), miss: miss.slice(0, 8).join(" ") };
}
for (const id of MAP_IDS) for (let s = 1; s <= 6; s++) { const r = analyse(id, s, s % 3 === 0); console.log(r.id, r.seed, r.cols, r.pct + "%", r.miss); }
