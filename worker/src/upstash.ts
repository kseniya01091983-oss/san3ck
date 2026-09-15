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

export class UpstashRequestError extends Error {
  constructor(
    readonly command: string,
    readonly status: number,
  ) {
    super(`Upstash ${command}: HTTP ${status}`);
    this.name = "UpstashRequestError";
  }
}

export function reindexFailureMessage(error: unknown): string {
  const intact = "Заметки целы, обычный поиск D1 продолжает работать.";
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
  return Boolean(env.UPSTASH_VECTOR_REST_URL && env.UPSTASH_VECTOR_REST_TOKEN);
}

function endpoint(env: Env, command: string, namespace: string): string {
  return `${env.UPSTASH_VECTOR_REST_URL!.replace(/\/$/, "")}/${command}/${encodeURIComponent(namespace)}`;
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
  const response = await fetch(endpoint(env, command, namespace), {
    method,
    headers: {
      Authorization: `Bearer ${env.UPSTASH_VECTOR_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (allowNotFound && response.status === 404) return {} as T;
  if (!response.ok) throw new UpstashRequestError(command, response.status);
  return response.json<T>();
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
  await request(env, "reset", namespace, "DELETE", undefined, true);
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
