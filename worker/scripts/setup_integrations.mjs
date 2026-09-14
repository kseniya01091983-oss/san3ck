import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const wranglerBin = resolve(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
const secrets = [
  "UPSTASH_VECTOR_REST_URL",
  "UPSTASH_VECTOR_REST_TOKEN",
  "TMDB_READ_ACCESS_TOKEN",
];

console.log("FastNotes: подключение Upstash Vector и TMDB.");
console.log("Wrangler по очереди попросит три значения. Введённое не отображается и не сохраняется в проекте.\n");

for (const secret of secrets) {
  console.log(`\nСейчас вставьте ${secret} и нажмите Enter:`);
  const result = spawnSync(process.execPath, [wranglerBin, "secret", "put", secret], {
    cwd: process.cwd(),
    stdio: "inherit",
    windowsHide: false,
  });
  if (result.status !== 0) {
    console.error(`\nНе удалось сохранить ${secret}. Уже добавленные Secrets не удалены.`);
    process.exit(result.status || 1);
  }
}

console.log("\nГотово. Три новых секрета сохранены непосредственно в Cloudflare.");
