import { describeImage, structureTextNote, summarizeExtractedLink } from "./ai";
import { createNote, deleteNote, searchNotesForAnswer } from "./db";
import { extractPage } from "./tavily";
import type { Env } from "./types";
import { jsonResponse } from "./utils";

const TEST_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function checkTelegram(env: Env): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
  const data = await response.json<{ ok?: boolean }>();
  if (!response.ok || !data.ok) throw new Error("Telegram getMe не прошёл");
  const webhookResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
  const webhook = await webhookResponse.json<{ ok?: boolean; result?: { url?: string } }>();
  if (!webhookResponse.ok || !webhook.ok || webhook.result?.url !== `${env.PUBLIC_BASE_URL}/telegram/webhook`) {
    throw new Error("Telegram webhook указывает не на FastNotes Worker");
  }
}

async function checkD1Search(env: Env): Promise<void> {
  const owner = Number(env.OWNER_TELEGRAM_ID);
  const marker = `fastnotescheck${Date.now()}`;
  const note = await createNote(env.DB, {
    ownerTelegramId: owner,
    type: "note",
    title: marker,
    text: `Временная проверка поиска ${marker}`,
    tags: [marker],
    section: "tech",
  });
  try {
    const found = await searchNotesForAnswer(env.DB, owner, marker);
    if (!found.some((item) => item.id === note.id)) throw new Error("FTS5 не нашёл тестовую запись");
  } finally {
    await deleteNote(env.DB, owner, note.id);
  }
}

export async function handleIntegrationCheck(request: Request, env: Env): Promise<Response> {
  const provided = request.headers.get("X-Integration-Test-Secret") || "";
  if (request.method !== "POST" || !env.INTEGRATION_TEST_SECRET || provided !== env.INTEGRATION_TEST_SECRET) {
    return jsonResponse({ error: "Маршрут недоступен" }, 404);
  }

  try {
    const [, text, image, extracted] = await Promise.all([
      checkTelegram(env),
      structureTextNote(env, "Сохранить тестовую идею о проверке FastNotes"),
      describeImage(env, TEST_IMAGE, "Одноцветное тестовое изображение"),
      extractPage(env, "https://example.com/"),
      checkD1Search(env),
    ]);
    const link = await summarizeExtractedLink(env, "https://example.com/", "Проверка ссылки", extracted.content);
    return jsonResponse({
      ok: true,
      checks: {
        telegram: true,
        d1_search: true,
        openrouter_text: Boolean(text.title),
        openrouter_image: Boolean(image.title),
        tavily_extract: Boolean(extracted.content),
        link_summary: Boolean(link.title),
      },
    });
  } catch (error) {
    console.error("Integration check failed", error);
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : "Неизвестная ошибка" }, 502);
  }
}
