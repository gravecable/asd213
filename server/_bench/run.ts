import { Voxels, ARENA_RADIUS, MAP_IDS } from "../../src/game/shared.ts";
import { generateMap, seededRandom } from "../maps.ts";
import { CHUNK_KEYS, buildBlockGeometry, chunkKey } from "./meshing.ts";
const t = (f: () => void, n = 10) => { f(); const s = performance.now(); for (let i = 0; i < n; i++) f(); return ((performance.now() - s) / n).toFixed(2); };
for (const id of MAP_IDS) {
  const v = new Voxels(); v.floorRadius = ARENA_RADIUS; generateMap(v, id, {}, seededRandom(3));
  let tris = 0; for (const k of CHUNK_KEYS) tris += buildBlockGeometry(v, k).index!.count / 3;
  const one = [...new Set([0, 1, -1].flatMap((dx) => [0, 1, -1].map((dz) => chunkKey(20 + dx, 5 + dz))))];
  console.log(id, "blocks", v.filled.size, "tris", tris, "chunks", CHUNK_KEYS.length, "all ms", t(() => { for (const k of CHUNK_KEYS) buildBlockGeometry(v, k); }), "block change ms", t(() => { for (const k of one) buildBlockGeometry(v, k); }, 50));
}
