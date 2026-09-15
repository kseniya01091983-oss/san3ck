import type { NoteSection, NoteStatus, NoteType } from "./types";

export const VALID_SECTIONS = new Set<NoteSection>([
  "games",
  "movies",
  "work",
  "tasks",
  "tech",
]);

export const VALID_TYPES = new Set<NoteType>([
  "note",
  "task",
  "idea",
  "recommendation",
  "link",
  "image",
  "file",
]);

export const VALID_STATUSES = new Set<NoteStatus>(["published", "hidden", "draft"]);

export const SECTION_LABELS: Record<NoteSection, string> = {
  games: "Игры",
  movies: "Фильмы",
  work: "Работа",
  tasks: "Задачи и быт",
  tech: "Технологии",
};

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    const tag = String(item).replace(/^#+/, "").trim().toLowerCase().slice(0, 50);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
    if (tags.length >= 12) break;
  }
  return tags;
}

export function tagsFromText(value: string): string[] {
  const matches = [...value.matchAll(/#([a-zA-Zа-яА-ЯёЁ0-9_]+(?:-[a-zA-Zа-яА-ЯёЁ0-9_]+)*)/g)];
  return normalizeTags(matches.map((match) => match[1]));
}

export function firstLine(value: string, fallback = "Без названия"): string {
  const line = value
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return (line || fallback).slice(0, 160);
}

export function truncate(value: string, length: number): string {
  const clean = value.trim();
  return clean.length <= length ? clean : `${clean.slice(0, length - 1).trimEnd()}…`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function extractFirstUrl(value: string): string | null {
  const match = value.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  return match[0].replace(/[),.;!?]+$/, "");
}

export function commandParts(text: string): { command: string; args: string } | null {
  const match = text.trim().match(/^\/([a-z_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: (match[2] || "").trim() };
}

const WORD_END = "(?=\\s|[,.!?;:]|$)";
const SAVE_REQUEST = new RegExp(
  `^(?:слушай[,.]?\\s+)?(?:пожалуйста[,.]?\\s+)?(?:запиши|сохрани|добавь|создай|зафиксируй)${WORD_END}`,
  "i",
);
const QUESTION_REQUEST = new RegExp(
  `^(?:слушай[,.]?\\s+)?(?:пожалуйста[,.]?\\s+)?(?:посоветуй|подскажи|расскажи|покажи|ответь|объясни|можно ли|есть ли|как|какая|какие|какой|какую|что|когда|где|кто|почему|зачем|сколько|чем)${WORD_END}`,
  "i",
);

/** Быстро отличает явный вопрос от записи, не расходуя запрос OpenRouter. */
export function looksLikeNaturalQuestion(value: string): boolean {
  const text = value.trim().replace(/\s+/g, " ");
  if (!text || SAVE_REQUEST.test(text)) return false;
  return text.includes("?") || QUESTION_REQUEST.test(text);
}

/** Убирает разговорные слова и добавляет несколько жанровых синонимов для FTS5. */
export function questionSearchText(value: string): string {
  const stopWords = new Set([
    "а", "бы", "в", "вы", "давай", "для", "же", "и", "из", "ли", "мне", "моих", "мы", "на", "по",
    "пожалуйста", "подскажи", "покажи", "посоветуй", "про", "расскажи", "с", "своих", "ты", "у", "я",
  ]);
  const words = value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [];
  const result: string[] = [];
  for (const word of words) {
    if (stopWords.has(word)) continue;
    let normalized = word;
    if (word.startsWith("истор")) normalized = "история";
    else if (word.startsWith("фантаст")) normalized = "фантастика";
    else if (word.startsWith("комед") || word.startsWith("смеш")) normalized = "комедия";
    else if (word.startsWith("ужас") || word.startsWith("страш")) normalized = "ужасы";
    else if (word.startsWith("романтич")) normalized = "романтика";
    else if (word.startsWith("мульт")) normalized = "мультфильм";
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result.join(" ") || value;
}

export function safeFileName(value: string): string {
  const clean = value.replace(/[^a-zA-Zа-яА-ЯёЁ0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (clean || "file").slice(0, 120);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let result = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(result);
}

export function jsonResponse(data: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

export function normalizeSection(value: unknown): NoteSection {
  const candidate = String(value || "").toLowerCase() as NoteSection;
  return VALID_SECTIONS.has(candidate) ? candidate : "tasks";
}

export function normalizeType(value: unknown, fallback: NoteType = "note"): NoteType {
  const candidate = String(value || "").toLowerCase() as NoteType;
  return VALID_TYPES.has(candidate) ? candidate : fallback;
}

export function normalizeStatus(value: unknown): NoteStatus {
  const candidate = String(value || "").toLowerCase() as NoteStatus;
  return VALID_STATUSES.has(candidate) ? candidate : "published";
}
