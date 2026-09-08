import { structureTextNote } from "./ai";
import {
  createNote,
  deleteNote,
  getAttachment,
  getNote,
  getNoteApi,
  getStats,
  listNotes,
  updateNote,
} from "./db";
import { downloadTelegramFile, getTelegramFile } from "./telegram-api";
import type { Env, NoteSection, NoteStatus, NoteType } from "./types";
import {
  firstLine,
  jsonResponse,
  normalizeSection,
  normalizeStatus,
  normalizeTags,
  normalizeType,
  truncate,
} from "./utils";

function ownerId(env: Env): number {
  const value = Number(env.OWNER_TELEGRAM_ID);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("OWNER_TELEGRAM_ID не настроен");
  return value;
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > 256_000) throw new Error("Слишком большой JSON-запрос");
  const data = await request.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Ожидался JSON-объект");
  return data as Record<string, unknown>;
}

function noteIdFromPath(pathname: string): number | null {
  const match = pathname.match(/^\/api\/notes\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function attachmentIdFromPath(pathname: string): number | null {
  const match = pathname.match(/^\/api\/files\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

async function handleList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const rawStatus = url.searchParams.get("status");
  const status = rawStatus === "all" ? null : normalizeStatus(rawStatus || "published");
  const sectionValue = url.searchParams.get("section");
  const typeValue = url.searchParams.get("type");
  const limit = Number(url.searchParams.get("limit") || 50);
  const offset = Number(url.searchParams.get("offset") || 0);
  const result = await listNotes(env.DB, ownerId(env), {
    limit: Number.isFinite(limit) ? limit : 50,
    offset: Number.isFinite(offset) ? offset : 0,
    status,
    section: sectionValue && sectionValue !== "all" ? normalizeSection(sectionValue) : null,
    type: typeValue ? normalizeType(typeValue) : null,
    tag: url.searchParams.get("tag"),
    query: url.searchParams.get("q"),
  });
  return jsonResponse({ ...result, limit: Math.min(200, Math.max(1, limit || 50)), offset: Math.max(0, offset || 0) });
}

async function handleCreate(request: Request, env: Env): Promise<Response> {
  const body = await requestJson(request);
  const rawText = String(body.text || "").trim();
  if (!rawText) return jsonResponse({ error: "Текст не может быть пустым" }, 400);

  let row;
  try {
    const structured = body.raw ? null : await structureTextNote(env, rawText);
    row = await createNote(env.DB, {
      ownerTelegramId: ownerId(env),
      type: structured?.type || normalizeType(body.type, "note"),
      title: truncate(String(body.title || structured?.title || firstLine(rawText)), 160),
      summary: truncate(String(body.summary || structured?.summary || ""), 800),
      text: structured?.text || rawText,
      tags: body.tags ? normalizeTags(body.tags) : structured?.tags || [],
      section: body.section ? normalizeSection(body.section) : structured?.section || "tasks",
      status: normalizeStatus(body.status),
      processingStatus: "ready",
      metadata: { created_from: "web" },
    });
  } catch (error) {
    row = await createNote(env.DB, {
      ownerTelegramId: ownerId(env),
      type: normalizeType(body.type, "note"),
      title: truncate(String(body.title || firstLine(rawText)), 160),
      summary: "",
      text: rawText,
      tags: normalizeTags(body.tags),
      section: normalizeSection(body.section),
      status: normalizeStatus(body.status),
      processingStatus: "failed",
      metadata: { created_from: "web", processing_error: error instanceof Error ? error.message : "unknown" },
    });
  }
  return jsonResponse(await getNoteApi(env.DB, ownerId(env), row.id), 201);
}

async function handleGet(id: number, env: Env): Promise<Response> {
  const note = await getNoteApi(env.DB, ownerId(env), id);
  return note ? jsonResponse(note) : jsonResponse({ error: "Заметка не найдена" }, 404);
}

async function handleUpdate(request: Request, id: number, env: Env): Promise<Response> {
  const body = await requestJson(request);
  const current = await getNote(env.DB, ownerId(env), id);
  if (!current) return jsonResponse({ error: "Заметка не найдена" }, 404);

  const input: {
    type?: NoteType;
    title?: string;
    summary?: string;
    text?: string;
    tags?: string[];
    section?: NoteSection;
    status?: NoteStatus;
  } = {};
  if (body.type !== undefined) input.type = normalizeType(body.type, current.type);
  if (body.title !== undefined) input.title = truncate(String(body.title).trim(), 160);
  if (body.summary !== undefined) input.summary = truncate(String(body.summary).trim(), 800);
  if (body.text !== undefined) {
    const text = String(body.text).trim();
    if (!text) return jsonResponse({ error: "Текст не может быть пустым" }, 400);
    input.text = text;
    if (body.title === undefined && !current.title) input.title = firstLine(text);
  }
  if (body.tags !== undefined) input.tags = normalizeTags(body.tags);
  if (body.section !== undefined) input.section = normalizeSection(body.section);
  if (body.status !== undefined) input.status = normalizeStatus(body.status);

  await updateNote(env.DB, ownerId(env), id, input);
  return jsonResponse(await getNoteApi(env.DB, ownerId(env), id));
}

async function handleFile(id: number, env: Env): Promise<Response> {
  const attachment = await getAttachment(env.DB, ownerId(env), id);
  if (!attachment) return jsonResponse({ error: "Файл не найден" }, 404);
  if (!attachment.telegram_file_id) return jsonResponse({ error: "У файла нет Telegram file_id" }, 404);
  const info = await getTelegramFile(env, attachment.telegram_file_id);
  const telegramFile = await downloadTelegramFile(env, info.file_path);
  const headers = new Headers();
  headers.set("Content-Type", attachment.mime_type);
  headers.set("Content-Disposition", `${attachment.mime_type.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.file_name)}`);
  headers.set("Cache-Control", "private, max-age=300");
  if (info.file_size) headers.set("Content-Length", String(info.file_size));
  return new Response(telegramFile.body, { headers });
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/notes" && request.method === "GET") return handleList(request, env);
    if (url.pathname === "/api/notes" && request.method === "POST") return handleCreate(request, env);
    if (url.pathname === "/api/stats" && request.method === "GET") {
      return jsonResponse(await getStats(env.DB, ownerId(env)));
    }

    const noteId = noteIdFromPath(url.pathname);
    if (noteId !== null && request.method === "GET") return handleGet(noteId, env);
    if (noteId !== null && ["PUT", "PATCH"].includes(request.method)) return handleUpdate(request, noteId, env);
    if (noteId !== null && request.method === "DELETE") {
      const removed = await deleteNote(env.DB, ownerId(env), noteId);
      return removed ? new Response(null, { status: 204 }) : jsonResponse({ error: "Заметка не найдена" }, 404);
    }

    const fileId = attachmentIdFromPath(url.pathname);
    if (fileId !== null && request.method === "GET") return handleFile(fileId, env);
    return jsonResponse({ error: "Маршрут не найден" }, 404);
  } catch (error) {
    console.error("API error", error);
    const message = error instanceof Error && error.message.includes("JSON") ? error.message : "Не удалось выполнить запрос";
    return jsonResponse({ error: message }, 500);
  }
}
