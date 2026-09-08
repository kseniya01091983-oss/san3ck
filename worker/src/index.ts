import { exchangeSiteToken, hasSiteSession, isSameOriginMutation, logoutResponse } from "./auth";
import { handleApi } from "./api";
import { handleIntegrationCheck } from "./integration-check";
import { handleTelegramWebhook } from "./telegram";
import type { Env } from "./types";
import { jsonResponse } from "./utils";

function loginRequired(): Response {
  return new Response(
    `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FastNotes — вход</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f5f7;color:#1d1d1f}.card{max-width:520px;margin:24px;padding:32px;border-radius:24px;background:white;box-shadow:0 20px 60px rgba(0,0,0,.1)}h1{margin-top:0}code{background:#eee;padding:2px 6px;border-radius:6px}</style><main class="card"><h1>FastNotes</h1><p>Это личный сайт заметок.</p><p>Откройте Telegram-бота и отправьте команду <code>/site</code>, чтобы получить временную ссылку.</p></main></html>`,
    { status: 401, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "fastnotes-second-brain" });
    }
    if (url.pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, env, ctx);
    }
    if (url.pathname === "/internal/integration-check") {
      return handleIntegrationCheck(request, env);
    }
    if (url.pathname === "/auth/site" && request.method === "GET") {
      return exchangeSiteToken(request, env);
    }

    const authenticated = await hasSiteSession(request, env);
    if (!authenticated) {
      return url.pathname.startsWith("/api/")
        ? jsonResponse({ error: "Требуется вход через Telegram" }, 401)
        : loginRequired();
    }
    if (!isSameOriginMutation(request)) {
      return jsonResponse({ error: "Недопустимый источник запроса" }, 403);
    }
    if (url.pathname === "/auth/logout" && request.method === "POST") {
      return logoutResponse(request);
    }
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });
      return handleApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export { analyzeTextMessage, structureTextNote, validateGroundedAnswer } from "./ai";
export { extractFirstUrl, normalizeTags } from "./utils";
