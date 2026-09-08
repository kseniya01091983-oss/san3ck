import type { Env } from "./types";
import { truncate } from "./utils";

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramFileInfo {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path: string;
}

async function telegramRequest<T>(
  env: Env,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await response.json()) as { ok: boolean; result?: T; description?: string };
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method}: ${truncate(data.description || `HTTP ${response.status}`, 300)}`);
  }
  return data.result as T;
}

export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  keyboard?: InlineButton[][],
): Promise<void> {
  await telegramRequest(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

export async function answerCallback(env: Env, callbackQueryId: string, text?: string): Promise<void> {
  await telegramRequest(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

export async function sendTyping(env: Env, chatId: number): Promise<void> {
  await telegramRequest(env, "sendChatAction", { chat_id: chatId, action: "typing" });
}

export async function getTelegramFile(env: Env, fileId: string): Promise<TelegramFileInfo> {
  return telegramRequest<TelegramFileInfo>(env, "getFile", { file_id: fileId });
}

export async function downloadTelegramFile(env: Env, filePath: string): Promise<Response> {
  const response = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!response.ok || !response.body) throw new Error(`Telegram file download: HTTP ${response.status}`);
  return response;
}
