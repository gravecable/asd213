import * as THREE from "three";
import { ARENA_RADIUS, BLOCK_TYPES, SPAWN_RADIUS, Voxels, cellInRing } from "../shared";

const R = ARENA_RADIUS;
/** Vertex brightness by ambient-occlusion level (0 = most occluded), Minecraft-style. */
const AO = [0.45, 0.64, 0.82, 1];
const UV = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

const occupied = (w: Voxels, x: number, y: number, z: number) => (y < 0 ? cellInRing(x, z, R) : w.get(x, y, z) !== 0);
const aoLevel = (s1: boolean, s2: boolean, c: boolean) => (s1 && s2 ? 0 : 3 - (Number(s1) + Number(s2) + Number(c)));

export class GeometryBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];

  /** Adds a CCW quad and returns its index. `flip` picks the other diagonal (smoother AO). */
  quad(corners: number[][], normal: number[], uvs: number[][], shade: number[] | null, flip = false) {
    const o = this.pos.length / 3;
    for (let k = 0; k < 4; k++) {
      this.pos.push(corners[k][0], corners[k][1], corners[k][2]);
      this.nor.push(normal[0], normal[1], normal[2]);
      this.uv.push(uvs[k][0], uvs[k][1]);
      if (shade) this.col.push(shade[k], shade[k], shade[k]);
    }
    if (flip) this.idx.push(o + 1, o + 2, o + 3, o + 1, o + 3, o);
    else this.idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    return o / 4;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.col.length) g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    return g;
  }
}

export interface Floor {
  top: THREE.BufferGeometry;
  ring: THREE.BufferGeometry;
  side: THREE.BufferGeometry;
  dirt: THREE.BufferGeometry;
  cells: Map<number, { geo: THREE.BufferGeometry; quad: number }>;
}

const cellKey = (x: number, z: number) => (x + 128) * 512 + (z + 128);
/** Top-quad corners as [dx, dz, neighbourDirX, neighbourDirZ]. */
const TOP_CORNERS = [
  [0, 1, -1, 1],
  [1, 1, 1, 1],
  [1, 0, 1, -1],
  [0, 0, -1, -1],
];

/** Floor slab: one quad per island cell (vertex colours carry contact AO), plus a blocky island edge.
 *  `radius`: the arena's island crumbles during a round. */
export function buildFloor(radius = R): Floor {
  const top = new GeometryBuilder();
  const ring = new GeometryBuilder();
  const side = new GeometryBuilder();
  const dirt = new GeometryBuilder();
  const topCells: number[][] = [];
  const ringCells: number[][] = [];
  const inside = (x: number, z: number) => cellInRing(x, z, radius);
  const ones = [1, 1, 1, 1];
  for (let x = -R - 1; x <= R; x++) {
    for (let z = -R - 1; z <= R; z++) {
      if (!inside(x, z)) continue;
      const isRing = Math.abs(Math.hypot(x + 0.5, z + 0.5) - SPAWN_RADIUS) < 0.75;
      const q = (isRing ? ring : top).quad(
        TOP_CORNERS.map(([dx, dz]) => [x + dx, 0, z + dz]),
        [0, 1, 0],
        UV,
        ones,
      );
      (isRing ? ringCells : topCells).push([x, z, q]);
      dirt.quad(
        [
          [x, -4, z],
          [x + 1, -4, z],
          [x + 1, -4, z + 1],
          [x, -4, z + 1],
        ],
        [0, -1, 0],
        UV,
        null,
      );
      const edges: [number, number, number[], number[], number[]][] = [
        [1, 0, [x + 1, z + 1], [x + 1, z], [1, 0, 0]],
        [-1, 0, [x, z], [x, z + 1], [-1, 0, 0]],
        [0, 1, [x, z + 1], [x + 1, z + 1], [0, 0, 1]],
        [0, -1, [x + 1, z], [x, z], [0, 0, -1]],
      ];
      for (const [dx, dz, a, b, n] of edges) {
        if (inside(x + dx, z + dz)) continue;
        side.quad(
          [
            [a[0], -1, a[1]],
            [b[0], -1, b[1]],
            [b[0], 0, b[1]],
            [a[0], 0, a[1]],
          ],
          n,
          UV,
          null,
        );
        dirt.quad(
          [
            [a[0], -4, a[1]],
            [b[0], -4, b[1]],
            [b[0], -1, b[1]],
            [a[0], -1, a[1]],
          ],
          n,
          [
            [0, 0],
            [1, 0],
            [1, 3],
            [0, 3],
          ],
          null,
        );
      }
    }
  }
  const topGeo = top.build();
  const ringGeo = ring.build();
  const cells = new Map<number, { geo: THREE.BufferGeometry; quad: number }>();
  for (const [x, z, q] of topCells) cells.set(cellKey(x, z), { geo: topGeo, quad: q });
  for (const [x, z, q] of ringCells) cells.set(cellKey(x, z), { geo: ringGeo, quad: q });
  return { top: topGeo, ring: ringGeo, side: side.build(), dirt: dirt.build(), cells };
}

/** Darkens floor corners next to ground-level blocks. `changed = null` recomputes every cell. */
export function applyFloorAo(floor: Floor, world: Voxels, changed: [number, number][] | null) {
  const touched = new Set<THREE.BufferGeometry>();
  const update = (x: number, z: number) => {
    const cell = floor.cells.get(cellKey(x, z));
    if (!cell) return;
    const col = cell.geo.getAttribute("color") as THREE.BufferAttribute;
    TOP_CORNERS.forEach(([, , du, dv], k) => {
      const v = AO[aoLevel(world.get(x + du, 0, z) !== 0, world.get(x, 0, z + dv) !== 0, world.get(x + du, 0, z + dv) !== 0)];
      col.setXYZ(cell.quad * 4 + k, v, v, v);
    });
    touched.add(cell.geo);
  };
  if (changed === null) {
    for (const key of floor.cells.keys()) update(Math.floor(key / 512) - 128, (key % 512) - 128);
  } else {
    for (const [bx, bz] of changed) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) update(bx + dx, bz + dz);
  }
  for (const g of touched) (g.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
}

const FACE_CORNERS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/** Inset (in tile fractions) that keeps nearest-filtered samples from landing on a neighbouring atlas tile. */
const TILE_INSET = 0.004;

/** Maps a 0..1 face UV into the atlas tile of a block type; unknown types fall back to dirt. */
function atlasUv(type: number, u: number, v: number) {
  const tile = type >= 1 && type <= BLOCK_TYPES ? type - 1 : 0;
  const span = 1 - 2 * TILE_INSET;
  return [(tile + TILE_INSET + u * span) / BLOCK_TYPES, TILE_INSET + v * span];
}

/** Meshes player blocks: hidden faces culled, per-vertex ambient occlusion in vertex colours. */
export function buildBlockGeometry(world: Voxels) {
  const b = new GeometryBuilder();
  for (const i of world.filled) {
    const p = Voxels.decode(i);
    const type = world.data[i];
    for (let axis = 0; axis < 3; axis++) {
      for (const s of [1, -1]) {
        const n = [0, 0, 0];
        n[axis] = s;
        const l = [p[0] + n[0], p[1] + n[1], p[2] + n[2]];
        if (occupied(world, l[0], l[1], l[2])) continue;
        const u = (axis + 1) % 3;
        const v = (axis + 2) % 3;
        const corners: number[][] = [];
        const uvs: number[][] = [];
        const ao: number[] = [];
        for (const k of s > 0 ? [0, 1, 2, 3] : [0, 3, 2, 1]) {
          const [cu, cv] = FACE_CORNERS[k];
          const q = [p[0], p[1], p[2]];
          if (s > 0) q[axis] += 1;
          q[u] += cu;
          q[v] += cv;
          corners.push(q);
          uvs.push(axis === 0 ? atlasUv(type, cv, cu) : atlasUv(type, cu, cv));
          const du = cu ? 1 : -1;
          const dv = cv ? 1 : -1;
          const s1 = [...l];
          s1[u] += du;
          const s2 = [...l];
          s2[v] += dv;
          const c = [...l];
          c[u] += du;
          c[v] += dv;
          ao.push(aoLevel(occupied(world, s1[0], s1[1], s1[2]), occupied(world, s2[0], s2[1], s2[2]), occupied(world, c[0], c[1], c[2])));
        }
        b.quad(
          corners,
          n,
          uvs,
          ao.map((a) => AO[a]),
          ao[1] + ao[3] > ao[0] + ao[2],
        );
      }
    }
  }
  return b.build();
}
