import type { Env } from "./types";

function parseTelegramId(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function ownerTelegramId(env: Env): number {
  const ownerId = parseTelegramId(env.OWNER_TELEGRAM_ID);
  if (!ownerId) throw new Error("OWNER_TELEGRAM_ID не настроен");
  return ownerId;
}

export function teacherTelegramId(env: Env): number | null {
  return parseTelegramId(env.TEACHER_TELEGRAM_ID);
}

export function isAllowedTelegramId(env: Env, telegramId: number): boolean {
  return telegramId === ownerTelegramId(env) || telegramId === teacherTelegramId(env);
}
