import {
  getPublishedNotesByIds,
  listVectorizableNotes,
  markOwnerVectorsNotIndexed,
  markNoteVector,
  markNotesVectorSynced,
  searchNotesForAnswer,
} from "./db";
import type { Env, NoteApi, NoteRow } from "./types";
import { normalizeTags, questionSearchText } from "./utils";

interface UpstashQueryResult {
  id: string;
  score: number;
}

const DEFAULT_TIMEOUT_MS = 6_000;
const REINDEX_TIMEOUT_MS = 20_000;
const REINDEX_BATCH_SIZE = 10;

type UpstashConnectionReason = "invalid_url" | "timeout" | "network" | "invalid_response";

export class UpstashRequestError extends Error {
  constructor(
    readonly command: string,
    readonly status: number,
  ) {
    super(`Upstash ${command}: HTTP ${status}`);
    this.name = "UpstashRequestError";
  }
}

export class UpstashConnectionError extends Error {
  constructor(
    readonly command: string,
    readonly reason: UpstashConnectionReason,
  ) {
    super(`Upstash ${command}: ${reason}`);
    this.name = "UpstashConnectionError";
  }
}

export function reindexFailureMessage(error: unknown): string {
  const intact = "Заметки целы, обычный поиск D1 продолжает работать.";
  if (error instanceof UpstashConnectionError) {
    if (error.reason === "invalid_url") {
      return `⚠️ Адрес UPSTASH_VECTOR_REST_URL записан неверно. Нужен только адрес https://…upstash.io без названия переменной и команды curl. ${intact}`;
    }
    if (error.reason === "timeout") {
      const stage = error.command === "reset" ? "очищения индекса" : "загрузки заметок";
      return `⚠️ Upstash не ответил вовремя на этапе ${stage}. ${intact}`;
    }
    if (error.reason === "invalid_response") {
      return `⚠️ Upstash вернул непонятный ответ на этапе ${error.command}. ${intact}`;
    }
    return `⚠️ Worker не смог подключиться к Upstash на этапе ${error.command}. Проверьте REST URL и доступность индекса. ${intact}`;
  }
  if (!(error instanceof UpstashRequestError)) {
    return `⚠️ Upstash временно не ответил. ${intact}`;
  }
  if (error.status === 401 || error.status === 403) {
    return `⚠️ Upstash отклонил ключ. В Cloudflare Secret UPSTASH_VECTOR_REST_TOKEN должен быть обычный Token, не Read-only Token. ${intact}`;
  }
  if (error.status === 400 || error.status === 422) {
    return `⚠️ Upstash не принял текст. Проверьте индекс: Hybrid, Dense openai/text-embedding-3-small, Sparse BM25. ${intact}`;
  }
  return `⚠️ Upstash вернул ошибку HTTP ${error.status}. ${intact}`;
}

function configured(env: Env): boolean {
  return Boolean(cleanSecret(env.UPSTASH_VECTOR_REST_URL) && cleanSecret(env.UPSTASH_VECTOR_REST_TOKEN));
}

function cleanSecret(value: string | undefined): string {
  let clean = String(value || "").trim();
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    clean = clean.slice(1, -1).trim();
  }
  return clean;
}

function endpoint(env: Env, command: string, namespace: string): string {
  const base = cleanSecret(env.UPSTASH_VECTOR_REST_URL).replace(/\/+$/, "");
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("invalid URL");
    }
  } catch {
    throw new UpstashConnectionError(command, "invalid_url");
  }
  return `${base}/${command}/${encodeURIComponent(namespace)}`;
}

async function request<T>(
  env: Env,
  command: string,
  namespace: string,
  method: "POST" | "DELETE",
  body?: unknown,
  allowNotFound = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(endpoint(env, command, namespace), {
      method,
      headers: {
        Authorization: `Bearer ${cleanSecret(env.UPSTASH_VECTOR_REST_TOKEN)}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof UpstashConnectionError) throw error;
    const name = error instanceof Error ? error.name : "";
    throw new UpstashConnectionError(command, name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
  }
  if (allowNotFound && response.status === 404) return {} as T;
  if (!response.ok) throw new UpstashRequestError(command, response.status);
  try {
    return await response.json<T>();
  } catch {
    throw new UpstashConnectionError(command, "invalid_response");
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function vectorNamespace(env: Env, telegramId: number): Promise<string> {
  return `u_${(await sha256(`fastnotes-vector:${env.SITE_AUTH_SECRET}:${telegramId}`)).slice(0, 40)}`;
}

export function vectorText(note: Pick<NoteRow, "title" | "summary" | "tags_json">): string {
  const tags = normalizeTags(JSON.parse(note.tags_json || "[]") as unknown[]);
  return [`Заголовок: ${note.title}`, `Описание: ${note.summary}`, `Теги: ${tags.join(", ")}`]
    .filter((part) => !part.endsWith(": "))
    .join("\n");
}

async function vectorHash(note: Pick<NoteRow, "title" | "summary" | "tags_json">): Promise<string> {
  return sha256(vectorText(note));
}

export async function deleteNoteVector(env: Env, ownerTelegramId: number, noteId: number): Promise<void> {
  if (!configured(env)) return;
  const namespace = await vectorNamespace(env, ownerTelegramId);
  await request(env, "delete", namespace, "DELETE", { ids: [String(noteId)] });
}

export async function syncNoteVector(env: Env, note: NoteRow): Promise<boolean> {
  if (!configured(env)) return false;
  if (note.status !== "published" || note.processing_status !== "ready") {
    if (note.vector_status !== "not_indexed") {
      await deleteNoteVector(env, note.owner_telegram_id, note.id);
      await markNoteVector(env.DB, note.owner_telegram_id, note.id, "not_indexed", null, null);
    }
    return false;
  }

  const hash = await vectorHash(note);
  if (note.vector_status === "synced" && note.vector_content_hash === hash) return false;
  await markNoteVector(env.DB, note.owner_telegram_id, note.id, "pending", hash, null);
  try {
    const namespace = await vectorNamespace(env, note.owner_telegram_id);
    await request(env, "upsert-data", namespace, "POST", [{
      id: String(note.id),
      data: vectorText(note),
      metadata: { note_id: note.id },
    }]);
    await markNoteVector(env.DB, note.owner_telegram_id, note.id, "synced", hash, new Date().toISOString());
    return true;
  } catch (error) {
    await markNoteVector(env.DB, note.owner_telegram_id, note.id, "failed", hash, null);
    throw error;
  }
}

export async function searchRagNotes(
  env: Env,
  ownerTelegramId: number,
  query: string,
  limit = 8,
): Promise<NoteApi[]> {
  const safeLimit = Math.min(8, Math.max(1, limit));
  const ftsPromise = searchNotesForAnswer(env.DB, ownerTelegramId, questionSearchText(query), safeLimit);
  let semanticIds: number[] = [];
  if (configured(env)) {
    try {
      const namespace = await vectorNamespace(env, ownerTelegramId);
      const payload = await request<{ result?: UpstashQueryResult[] }>(env, "query-data", namespace, "POST", {
        data: query,
        topK: safeLimit,
        includeMetadata: false,
        includeData: false,
        fusionAlgorithm: "RRF",
      });
      semanticIds = (payload.result || [])
        .map((item) => Number(item.id))
        .filter((id) => Number.isSafeInteger(id) && id > 0);
    } catch (error) {
      console.warn("Upstash search unavailable; using D1 FTS", error);
    }
  }
  const ftsNotes = await ftsPromise;
  const semanticNotes = await getPublishedNotesByIds(env.DB, ownerTelegramId, semanticIds.slice(0, safeLimit));
  const combined = new Map<number, NoteApi>();
  for (const note of [...semanticNotes, ...ftsNotes]) combined.set(note.id, note);
  return [...combined.values()].slice(0, safeLimit);
}

export async function reindexOwner(env: Env, ownerTelegramId: number): Promise<number> {
  if (!configured(env)) throw new Error("Upstash Vector Secrets не настроены");
  const namespace = await vectorNamespace(env, ownerTelegramId);
  try {
    await request(env, "reset", namespace, "DELETE", undefined, true);
  } catch (error) {
    if (!(error instanceof UpstashConnectionError) || !["timeout", "network"].includes(error.reason)) throw error;
    console.warn("Upstash reset unavailable; continuing with verified D1 upsert", error);
  }
  await markOwnerVectorsNotIndexed(env.DB, ownerTelegramId);
  const notes = await listVectorizableNotes(env.DB, ownerTelegramId);
  if (!notes.length) return 0;
  for (let offset = 0; offset < notes.length; offset += REINDEX_BATCH_SIZE) {
    const batch = notes.slice(offset, offset + REINDEX_BATCH_SIZE);
    const payload = batch.map((note) => ({
      id: String(note.id),
      data: vectorText(note),
      metadata: { note_id: note.id },
    }));
    await request(env, "upsert-data", namespace, "POST", payload, false, REINDEX_TIMEOUT_MS);
    const indexedAt = new Date().toISOString();
    const statusUpdates = await Promise.all(batch.map(async (note) => ({
      id: note.id,
      contentHash: await vectorHash(note),
    })));
    await markNotesVectorSynced(env.DB, ownerTelegramId, statusUpdates, indexedAt);
  }
  return notes.length;
}
