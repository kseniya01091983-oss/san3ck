import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";

const host = "127.0.0.1";
const port = 8790;
const workerUrl = "https://fastnotes-second-brain.kseniya01091983.workers.dev";
const botDescription = "Нажмите Start / Запустить — бот сразу покажет короткую инструкцию. FastNotes сохраняет заметки, ищет ответы по вашей базе и помогает добавлять фильмы и сериалы.";
const botShortDescription = "Заметки, смысловой поиск и фильмы. Нажмите Start / Запустить, чтобы начать.";
const csrfToken = randomBytes(24).toString("base64url");
const wranglerBin = resolve(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");

function page(message = "", success = false) {
  const notice = message
    ? `<div class="notice ${success ? "success" : "error"}">${escapeHtml(message)}</div>`
    : "";
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Подключение FastNotes</title>
<style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f7;color:#1d1d1f;font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px}
  main{width:min(620px,100%);background:#fff;border-radius:24px;padding:32px;box-shadow:0 18px 70px #0002}h1{margin:0 0 8px;font-size:30px}.lead{margin:0 0 24px;color:#5b5b63}
  label{display:block;font-weight:650;margin:18px 0 7px}input{width:100%;font:inherit;padding:13px 15px;border:1px solid #c7c7cc;border-radius:12px;background:#fff}input:focus{outline:3px solid #007aff33;border-color:#007aff}
  button{width:100%;margin-top:24px;border:0;border-radius:13px;padding:14px;background:#007aff;color:#fff;font:650 17px/1.2 inherit;cursor:pointer}button:disabled{opacity:.55;cursor:wait}
  small{display:block;color:#72727a;margin-top:7px}.notice{margin:0 0 20px;padding:14px;border-radius:12px}.error{background:#ff3b3014;color:#9f1710}.success{background:#34c75918;color:#176b2e}
  #working{display:none;text-align:center;margin-top:16px;color:#5b5b63}
</style></head><body><main>
  <h1>Подключение FastNotes</h1>
  <p class="lead">Вставьте три значения один раз. Они сразу уйдут в защищённые Secrets Cloudflare, не сохранятся в файл и не попадут в GitHub.</p>
  ${notice}
  <form method="post" action="/setup" onsubmit="document.querySelector('button').disabled=true;document.querySelector('#working').style.display='block'">
    <input type="hidden" name="csrf" value="${csrfToken}">
    <label for="telegram">Токен Telegram-бота</label>
    <input id="telegram" name="telegram" type="password" required autocomplete="off" placeholder="цифры:длинная_строка">
    <small>Тот токен, который вы получили у BotFather.</small>
    <label for="openrouter">Ключ OpenRouter</label>
    <input id="openrouter" name="openrouter" type="password" required autocomplete="off" placeholder="sk-or-v1-…">
    <label for="tavily">Ключ Tavily</label>
    <input id="tavily" name="tavily" type="password" required autocomplete="off" placeholder="tvly-…">
    <button type="submit">Подключить и настроить бота</button>
    <div id="working">Настраиваю Cloudflare и Telegram. Не закрывайте страницу примерно минуту…</div>
  </form>
</main></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function putSecret(name, value) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [wranglerBin, "secret", "put", name], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let errorOutput = "";
    child.stderr.on("data", (chunk) => { errorOutput += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Cloudflare не принял ${name} (код ${code}). ${errorOutput.slice(-200)}`));
    });
    child.stdin.end(`${value}\n`);
  });
}

async function telegramRequest(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`Telegram отклонил запрос ${method}. Проверьте токен бота.`);
  return data.result;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64_000) throw new Error("Слишком большой запрос");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

let busy = false;
const server = createServer(async (request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.method === "GET" && request.url === "/") {
    response.end(page());
    return;
  }
  if (request.method !== "POST" || request.url !== "/setup" || busy) {
    response.statusCode = 404;
    response.end(page("Страница не найдена."));
    return;
  }
  busy = true;
  try {
    const form = new URLSearchParams(await readBody(request));
    if (form.get("csrf") !== csrfToken) throw new Error("Страница устарела. Откройте её заново.");
    const telegram = String(form.get("telegram") || "").trim();
    const openrouter = String(form.get("openrouter") || "").trim();
    const tavily = String(form.get("tavily") || "").trim();
    if (telegram.length < 20 || openrouter.length < 20 || tavily.length < 20) {
      throw new Error("Одно из значений выглядит слишком коротким. Проверьте, что ключи скопированы полностью.");
    }
    await telegramRequest(telegram, "getMe", {});
    const webhookSecret = randomBytes(32).toString("base64url");
    await putSecret("TELEGRAM_BOT_TOKEN", telegram);
    await putSecret("OPENROUTER_API_KEY", openrouter);
    await putSecret("TAVILY_API_KEY", tavily);
    await putSecret("TELEGRAM_WEBHOOK_SECRET", webhookSecret);
    await telegramRequest(telegram, "setWebhook", {
      url: `${workerUrl}/telegram/webhook`,
      secret_token: webhookSecret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
    await telegramRequest(telegram, "setMyDescription", { description: botDescription });
    await telegramRequest(telegram, "setMyShortDescription", { short_description: botShortDescription });
    response.end(page("Готово: секреты добавлены, Telegram webhook подключён. Эту страницу можно закрыть.", true));
    setTimeout(() => server.close(), 1500);
  } catch (error) {
    busy = false;
    response.statusCode = 400;
    response.end(page(error instanceof Error ? error.message : "Не удалось завершить настройку."));
  }
});

server.listen(port, host, () => {
  console.log(`Откройте http://${host}:${port}`);
});
