import { Bot, idle, run } from "./test-utils.ts";
const n = Number(process.argv[2] ?? 1);
const bots: Bot[] = [];
for (let i = 0; i < n; i++) bots.push(await Bot.join("ws://127.0.0.1:3000/game-ws", `Бот${i + 1}`));
console.log("bots joined", bots.map((b) => b.id));
await Promise.all(bots.map((b) => run(b, idle(b), 900_000)));
