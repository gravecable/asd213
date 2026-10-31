// Single entry point: Next.js site + PvP WebSocket on one port.
//   node server/index.ts               — development (next dev + game)
//   node server/index.ts --prod        — production (run `next build` first)
//   node server/index.ts --game-only   — only the game server, e.g. when the site is a static export
// Env: PORT (default 3000), PVP_TIME_SCALE (e.g. 0.1 makes buffs every 6 s for testing),
//      PVP_MODE / PVP_BUFFS (testing: fixed round mode, comma-separated buff order),
//      anticheat limits PVP_AC_* / PVP_MAX_* / PVP_ALLOWED_ORIGINS / PVP_CLIENT_IP_HEADER (see README).
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import next from "next";
import { PvpServer } from "./game.ts";
import { BUFF_IDS, MODE_IDS } from "../src/game/shared.ts";
import type { BuffId, GameMode } from "../src/game/shared.ts";

const args = new Set(process.argv.slice(2));
const port = Number(process.env.PORT) || 3000;
const host = process.env.BIND_HOST || "0.0.0.0";
const gameOnly = args.has("--game-only");
const dev = !args.has("--prod") && !gameOnly;
const timeScale = Number(process.env.PVP_TIME_SCALE) || 1;

const mode = MODE_IDS.find((m) => m === process.env.PVP_MODE) as GameMode | undefined;
const buffPlan = process.env.PVP_BUFFS ? (process.env.PVP_BUFFS.split(",").filter((b) => BUFF_IDS.includes(b as BuffId)) as BuffId[]) : undefined;
const game = new PvpServer({ timeScale, mode, buffPlan });
if (dev) console.warn("> Development mode compiles pages on the fly and makes the game lag: run `npm run build && npm start` for players.");

async function main() {
  let handle: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;
  const server = createServer((req, res) => {
    if (handle) return void handle(req, res);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("PvP game server is running\n");
  });

  // Next attaches its own upgrade listener (HMR) and ignores paths it doesn't own, so both coexist.
  server.on("upgrade", (req, socket, head) => {
    game.handleUpgrade(req, socket, head);
  });

  if (!gameOnly) {
    const app = next({ dev, httpServer: server, port });
    await app.prepare();
    const requestHandler = app.getRequestHandler();
    handle = (req, res) => requestHandler(req, res);
  }

  server.listen(port, host, () => {
    const mode = gameOnly ? "game only" : dev ? "development" : "production";
    console.log(`> Ready on http://${host}:${port} (${mode}), game socket at ws://${host}:${port}/game-ws`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
