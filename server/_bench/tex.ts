import { BLOCK_TYPES } from "../../src/game/shared.ts";
export const TILE = { grassSide: BLOCK_TYPES, logTop: BLOCK_TYPES + 1 } as const;
export const ATLAS_TILES = BLOCK_TYPES + 2;
