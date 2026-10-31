import * as THREE from "three";
import { BLOCK_TYPES } from "../shared";

// Procedural 16×16 pixel-art textures, so the game ships without image assets.

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!] as const;
}

function pick(r: () => number, palette: string[]) {
  return palette[Math.floor(r() * palette.length)];
}

function noise(ctx: CanvasRenderingContext2D, seed: number, palette: string[], y0 = 0, y1 = 16) {
  const r = rng(seed);
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < 16; x++) {
      ctx.fillStyle = pick(r, palette);
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

function rect(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function speckle(ctx: CanvasRenderingContext2D, seed: number, palette: string[], x0: number, y0: number, w: number, h: number) {
  const r = rng(seed);
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) rect(ctx, pick(r, palette), x, y, 1, 1);
}

const DIRT = ["#79553a", "#866043", "#966c4a", "#6c4b33", "#866043", "#5d4128"];
const GRASS = ["#5f9e35", "#6bb03c", "#57912f", "#78bd47", "#64a637"];
const STONE = ["#7d7d7d", "#8a8a8a", "#6e6e6e", "#959595", "#848484"];
const LAVA = ["#ff7a00", "#ff9a1f", "#ffb43d", "#e85d04", "#ffd166", "#d94a00"];
const SNOW = ["#f4f8fb", "#f4f8fb", "#eef4f9", "#f9fcfe", "#e8f0f6"];
const ICE = ["#a9d0f7", "#b4d8fa", "#9cc8f5", "#bfdffc", "#a9d0f7", "#c6e2fd"];

function toTexture(c: HTMLCanvasElement, repeat = false) {
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestMipmapLinearFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function drawDirt(seed = 1) {
  const [c, ctx] = canvas(16, 16);
  noise(ctx, seed, DIRT);
  return c;
}

function drawStoneTile(ctx: CanvasRenderingContext2D) {
  noise(ctx, 5, STONE);
  const seam = "#4f5356";
  for (const [y, joints] of [[0, [7]], [5, [3, 11]], [10, [7]]] as const) {
    rect(ctx, "rgba(255,255,255,0.14)", 0, y, 16, 1);
    for (const x of joints) rect(ctx, seam, x, y, 1, 4);
    rect(ctx, seam, 0, y + 4, 16, 1);
  }
}

function drawPlanks(ctx: CanvasRenderingContext2D) {
  const r = rng(31);
  const boards = ["#b08a55", "#a98350", "#b8935d", "#a47e4c"];
  for (let b = 0; b < 4; b++) {
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 16; x++) rect(ctx, r() < 0.2 ? "#97723f" : boards[b], x, b * 4 + y, 1, 1);
    }
    rect(ctx, "#6b4f2c", 0, b * 4 + 3, 16, 1);
    rect(ctx, "#6b4f2c", 4 + (b % 2) * 8, b * 4, 1, 3);
    rect(ctx, "#5a4023", 2 + (b % 2) * 8, b * 4 + 1, 1, 1);
  }
}

function drawGoldTile(ctx: CanvasRenderingContext2D) {
  noise(ctx, 61, ["#f7d63c", "#f4c820", "#ffe05a", "#eebd18", "#f7d63c"]);
  rect(ctx, "#fff39a", 0, 0, 15, 1);
  rect(ctx, "#fff39a", 0, 0, 1, 15);
  rect(ctx, "#d9a914", 1, 14, 14, 1);
  rect(ctx, "#d9a914", 14, 1, 1, 14);
  ctx.fillStyle = "#fffbe0";
  for (const [x, y] of [[3, 3], [4, 3], [3, 4], [10, 9], [11, 9], [10, 10], [7, 12]]) ctx.fillRect(x, y, 1, 1);
}

function drawObsidianTile(ctx: CanvasRenderingContext2D) {
  noise(ctx, 71, ["#150f24", "#1b1430", "#0f0a1b", "#20183a", "#120c20"]);
  const r = rng(72);
  for (let i = 0; i < 14; i++) rect(ctx, pick(r, ["#4b2a8f", "#6a3fc0", "#35206b"]), Math.floor(r() * 16), Math.floor(r() * 16), 1, 1);
}

function drawBricksTile(ctx: CanvasRenderingContext2D) {
  const r = rng(81);
  const bricks = ["#a8412f", "#b44a37", "#9a3a29", "#bd5440"];
  rect(ctx, "#cbc4b5", 0, 0, 16, 16);
  for (let row = 0; row < 4; row++) {
    const off = (row % 2) * 4;
    for (let x = 0; x < 16; x++) {
      const joint = (x + 16 - off) % 8 === 0;
      for (let y = 0; y < 3; y++) if (!joint) rect(ctx, pick(r, bricks), x, row * 4 + y, 1, 1);
    }
  }
}

function drawBoneTile(ctx: CanvasRenderingContext2D) {
  noise(ctx, 91, ["#ebe7d6", "#e2ddc8", "#f2efe2", "#d9d4bd"]);
  rect(ctx, "#cfc9b0", 0, 5, 16, 1);
  rect(ctx, "#cfc9b0", 0, 11, 16, 1);
  ctx.fillStyle = "#a39d83";
  for (const [x, y] of [[3, 1], [3, 2], [4, 2], [4, 3], [5, 3], [11, 7], [11, 8], [12, 8], [12, 9], [12, 12], [13, 12], [13, 13]]) ctx.fillRect(x, y, 1, 1);
}

function drawSnowTile(ctx: CanvasRenderingContext2D) {
  noise(ctx, 101, SNOW);
  const r = rng(102);
  for (let i = 0; i < 18; i++) rect(ctx, pick(r, ["#c9d9e8", "#b9cde0", "#d6e3ef"]), Math.floor(r() * 16), Math.floor(r() * 16), 1, 1);
}

function drawIce(ctx: CanvasRenderingContext2D) {
  noise(ctx, 13, ICE);
  const diagonal = (color: string, x: number, y: number, len: number) => {
    for (let i = 0; i < len; i++) rect(ctx, color, (x + i) & 15, (y - i) & 15, 1, 1);
  };
  for (const [x, y, len] of [[1, 9, 6], [8, 14, 7], [10, 5, 4]] as const) diagonal("#cfe6ff", x, y, len);
  for (const [x, y, len] of [[2, 8, 3], [9, 13, 3], [11, 4, 2]] as const) diagonal("#f2f9ff", x, y, len);
  for (const [x, y, len] of [[3, 2, 4], [12, 11, 3]] as const) diagonal("#86b6ea", x, y, len);
}

/** One 16×16 drawer per block type, in `BLOCK` order (tile index = type − 1). */
const BLOCK_TILES: ((ctx: CanvasRenderingContext2D) => void)[] = [
  (ctx) => noise(ctx, 21, DIRT),
  drawStoneTile,
  drawPlanks,
  drawGoldTile,
  drawObsidianTile,
  drawBricksTile,
  drawBoneTile,
  drawSnowTile,
];

/** Horizontal strip of block tiles. Nearest filtering and no mipmaps keep neighbouring tiles from bleeding. */
function blockAtlas() {
  const [c, ctx] = canvas(16 * BLOCK_TYPES, 16);
  BLOCK_TILES.slice(0, BLOCK_TYPES).forEach((draw, i) => {
    const [tile, tctx] = canvas(16, 16);
    draw(tctx);
    rect(tctx, "rgba(0,0,0,0.25)", 0, 15, 16, 1);
    rect(tctx, "rgba(0,0,0,0.25)", 15, 0, 1, 16);
    ctx.drawImage(tile, i * 16, 0);
  });
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createTextures() {
  const grassTop = canvas(16, 16);
  noise(grassTop[1], 7, GRASS);

  const grassSide = canvas(16, 16);
  noise(grassSide[1], 3, DIRT);
  const r = rng(11);
  for (let x = 0; x < 16; x++) {
    const depth = 3 + Math.floor(r() * 3);
    for (let y = 0; y < depth; y++) {
      grassSide[1].fillStyle = pick(r, GRASS);
      grassSide[1].fillRect(x, y, 1, 1);
    }
  }

  const stone = canvas(16, 16);
  noise(stone[1], 5, STONE);
  stone[1].strokeStyle = "rgba(0,0,0,0.18)";
  stone[1].strokeRect(0.5, 0.5, 15, 15);

  const lava = canvas(16, 16);
  noise(lava[1], 9, LAVA);

  const ice = canvas(16, 16);
  drawIce(ice[1]);

  const block = drawDirt(21);
  const ctx = block.getContext("2d")!;
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(0, 15, 16, 1);
  ctx.fillRect(15, 0, 1, 16);

  const planksCanvas = canvas(16, 16);
  drawPlanks(planksCanvas[1]);

  return {
    grassTop: toTexture(grassTop[0]),
    grassSide: toTexture(grassSide[0]),
    dirt: toTexture(drawDirt(2), true),
    stone: toTexture(stone[0]),
    lava: toTexture(lava[0]),
    ice: toTexture(ice[0]),
    block: toTexture(block),
    blockAtlas: blockAtlas(),
    planks: toTexture(planksCanvas[0], true),
  };
}

/** Data URL of the dirt block, for HUD icons. */
export function dirtIconUrl() {
  return drawDirt(21).toDataURL();
}

export function ringTexture() {
  const [c, ctx] = canvas(32, 64);
  const g = ctx.createLinearGradient(0, 64, 0, 0);
  g.addColorStop(0, "rgba(255,255,255,0.55)");
  g.addColorStop(0.35, "rgba(255,255,255,0.18)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 64);
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fillRect(0, 0, 2, 64);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

export function gridTexture() {
  const [c, ctx] = canvas(32, 32);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

let labelFont = "monospace";

/** Canvas can't resolve next/font's generated family name by itself, so the engine passes it in. */
export function setLabelFont(family: string) {
  if (family) labelFont = family;
}

export function labelTexture(text: string, color: string, hpRatio: number | null) {
  const [c, ctx] = canvas(256, 72);
  ctx.font = `bold 30px ${labelFont}`;
  const w = Math.min(248, ctx.measureText(text).width + 24);
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(128 - w / 2, 4, w, 40);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 25);
  if (hpRatio !== null) {
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(68, 52, 120, 14);
    ctx.fillStyle = hpRatio > 0.5 ? "#4ade80" : hpRatio > 0.25 ? "#facc15" : "#ef4444";
    ctx.fillRect(70, 54, 116 * Math.max(0, hpRatio), 10);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let pixelFont = "monospace";

export function setPixelFont(family: string) {
  if (family.trim()) pixelFont = family;
}

export function numberTexture(text: string, color: string) {
  const font = `28px ${pixelFont}`;
  const probe = canvas(1, 1)[1];
  probe.font = font;
  const w = Math.ceil(probe.measureText(text).width) + 16;
  const [c, ctx] = canvas(w, 48);
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(text, w / 2, 26);
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, 26);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

const BARK = ["#6b4f2a", "#5a4223", "#7a5a31", "#4d381d", "#634826"];
const LEAVES = ["#3f8f2a", "#4aa032", "#357a23", "#5bb53d", "#2e6b1f", "#459a2e"];
const WATER = ["#2f7fd0", "#3a8ddb", "#2a73c2", "#4597e0", "#3383d4", "#5aa6ea"];

/** Repeating block textures for the scenery around the island (UVs in block units). */
export function sceneryTextures() {
  const grassTop = canvas(16, 16);
  noise(grassTop[1], 7, GRASS);
  const grassSide = canvas(16, 16);
  noise(grassSide[1], 3, DIRT);
  const r = rng(11);
  for (let x = 0; x < 16; x++) {
    const depth = 3 + Math.floor(r() * 3);
    for (let y = 0; y < depth; y++) rect(grassSide[1], pick(r, GRASS), x, y, 1, 1);
  }
  const stone = canvas(16, 16);
  noise(stone[1], 9, STONE);
  speckle(stone[1], 13, ["rgba(0,0,0,0)", "rgba(0,0,0,0)", "rgba(0,0,0,0)", "rgba(0,0,0,0)", "rgba(40,40,40,0.35)"], 0, 0, 16, 16);
  const bark = canvas(16, 16);
  noise(bark[1], 31, BARK);
  for (let x = 1; x < 16; x += 4) for (let y = 0; y < 16; y++) if (r() < 0.7) rect(bark[1], "#3e2c16", x, y, 1, 1);
  const leaves = canvas(16, 16);
  noise(leaves[1], 37, LEAVES);
  speckle(leaves[1], 41, ["rgba(0,0,0,0)", "rgba(0,0,0,0)", "rgba(0,0,0,0)", "rgba(20,50,10,0.55)"], 0, 0, 16, 16);
  const water = canvas(16, 16);
  noise(water[1], 53, WATER);
  return {
    grassTop: toTexture(grassTop[0], true),
    grassSide: toTexture(grassSide[0], true),
    dirt: toTexture(drawDirt(5), true),
    stone: toTexture(stone[0], true),
    bark: toTexture(bark[0], true),
    leaves: toTexture(leaves[0], true),
    water: toTexture(water[0], true),
  };
}
