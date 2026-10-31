import { Bot, idle, run, startServer, waitFor } from "./test-utils.ts";
const map = (process.argv[2] ?? "canyon") as "canyon";
let violations = 0;
const srv = await startServer({ map, timeScale: 0.5, buffPlan: ["speed"] });
const bots: Bot[] = [];
for (let i = 0; i < 2; i++) bots.push(await Bot.join(srv.url, `b${i}`));
await waitFor(() => bots.every((b) => b.playing), 60_000, "round");
for (const b of bots) console.log("spawn", b.id, b.body.pos, "onGround", b.body.onGround);
const t0 = Date.now();
await Promise.all(bots.map((b) => run(b, (dt, now) => {
  idle(b)(dt, now);
  if (!b.alive) return;
}, 40_000, () => bots.some((x) => !x.alive))));
for (const b of bots) console.log("end", b.id, "alive", b.alive, b.body.pos, "kills", JSON.stringify(b.kills), "tps", b.teleports);
console.log("violations", JSON.stringify(srv.violations.slice(0, 5)), "elapsed", Date.now() - t0);
srv.close();
process.exit(0);
