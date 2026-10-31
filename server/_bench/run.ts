import { Voxels, ARENA_RADIUS, MAP_IDS, hubBlocks } from "../../src/game/shared.ts";
import { generateMap, seededRandom } from "../maps.ts";
import { buildBlockGeometry, buildFloor } from "./meshing.ts";
const hub = new Voxels(); const q = hubBlocks(); for (let i = 0; i < q.length; i += 4) hub.set(q[i], q[i+1], q[i+2], q[i+3]);
const t = (f: () => void, n = 10) => { f(); const s = performance.now(); for (let i = 0; i < n; i++) f(); return ((performance.now() - s) / n).toFixed(1); };
console.log("hub blocks", hub.filled.size, "mesh ms", t(() => buildBlockGeometry(hub)));
for (const id of MAP_IDS) {
  const v = new Voxels(); v.floorRadius = ARENA_RADIUS; generateMap(v, id, {}, seededRandom(3));
  const g = buildBlockGeometry(v);
  console.log(id, "blocks", v.filled.size, "tris", g.index!.count / 3, "mesh ms", t(() => buildBlockGeometry(v)), "floor ms", t(() => buildFloor(ARENA_RADIUS, v.holes), 5), "gen ms", t(() => { const w = new Voxels(); generateMap(w, id, {}, seededRandom(3)); }, 5));
}
