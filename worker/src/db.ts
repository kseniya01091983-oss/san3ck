import type {
  AttachmentApi,
  AttachmentRow,
  NoteApi,
  NoteRow,
  NoteSection,
  NoteStatus,
  NoteType,
  ProcessingStatus,
} from "./types";
import { normalizeTags, parseJson } from "./utils";

export interface CreateNoteInput {
  ownerTelegramId: number;
  type: NoteType;
  title: string;
  summary?: string;
  text: string;
  tags?: string[];
  section?: NoteSection;
  status?: NoteStatus;
  sourceUrl?: string | null;
  processingStatus?: ProcessingStatus;
  metadata?: Record<string, unknown>;
}

export interface UpdateNoteInput {
  type?: NoteType;
  title?: string;
  summary?: string;
  text?: string;
  tags?: string[];
  section?: NoteSection;
  status?: NoteStatus;
  sourceUrl?: string | null;
  processingStatus?: ProcessingStatus;
  metadata?: Record<string, unknown>;
}

export interface ListNotesOptions {
  limit?: number;
  offset?: number;
  status?: NoteStatus | null;
  section?: NoteSection | null;
  type?: NoteType | null;
  tag?: string | null;
  query?: string | null;
}

function ftsQuery(value: string): string | null {
  const words = value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [];
  const tokens = words.filter((word) => word.length >= 2).slice(0, 12);
  if (!tokens.length) return null;
  return tokens.map((word) => `"${word.replaceAll('"', '""')}"*`).join(" OR ");
}

export function attachmentToApi(row: AttachmentRow): AttachmentApi {
  return {
    id: row.id,
    file_name: row.file_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    width: row.width,
    height: row.height,
    url: `/api/files/${row.id}`,
  };
}

export function noteToApi(row: NoteRow, attachments: AttachmentRow[] = []): NoteApi {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    text: row.text,
    tags: normalizeTags(parseJson<unknown[]>(row.tags_json, [])),
    section: row.section,
    status: row.status,
    source_url: row.source_url,
    processing_status: row.processing_status,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    attachments: attachments.map(attachmentToApi),
  };
}

export async function createNote(db: D1Database, input: CreateNoteInput): Promise<NoteRow> {
  const row = await db
    .prepare(
      `INSERT INTO notes (
        owner_telegram_id, type, title, summary, text, tags_json, section,
        status, source_url, processing_status, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(
      input.ownerTelegramId,
      input.type,
      input.title,
      input.summary || "",
      input.text,
      JSON.stringify(normalizeTags(input.tags || [])),
      input.section || "tasks",
      input.status || "published",
      input.sourceUrl || null,
      input.processingStatus || "ready",
      JSON.stringify(input.metadata || {}),
    )
    .first<NoteRow>();
  if (!row) throw new Error("D1 did not return the created note");
  return row;
}

export async function getNote(db: D1Database, ownerTelegramId: number, id: number): Promise<NoteRow | null> {
  return db
    .prepare("SELECT * FROM notes WHERE id = ? AND owner_telegram_id = ?")
    .bind(id, ownerTelegramId)
    .first<NoteRow>();
}

export async function getNoteApi(
  db: D1Database,
  ownerTelegramId: number,
  id: number,
): Promise<NoteApi | null> {
  const note = await getNote(db, ownerTelegramId, id);
  if (!note) return null;
  const attachments = await listAttachmentsForNote(db, ownerTelegramId, id);
  return noteToApi(note, attachments);
}

function buildListQuery(ownerTelegramId: number, options: ListNotesOptions, count: boolean) {
  const bindings: unknown[] = [ownerTelegramId];
  const where = ["n.owner_telegram_id = ?"];
  let from = "notes n";
  const normalizedFts = options.query ? ftsQuery(options.query) : null;

  if (normalizedFts) {
    from = "notes_fts JOIN notes n ON n.id = notes_fts.rowid";
    where.push("notes_fts MATCH ?");
    bindings.push(normalizedFts);
  }
  if (options.status !== null && options.status !== undefined) {
    where.push("n.status = ?");
    bindings.push(options.status);
  }
  if (options.section) {
    where.push("n.section = ?");
    bindings.push(options.section);
  }
  if (options.type) {
    where.push("n.type = ?");
    bindings.push(options.type);
  }
  if (options.tag) {
    where.push("EXISTS (SELECT 1 FROM json_each(n.tags_json) WHERE lower(value) = lower(?))");
    bindings.push(options.tag.replace(/^#/, ""));
  }

  const order = count ? "" : normalizedFts ? " ORDER BY bm25(notes_fts), n.id DESC" : " ORDER BY n.id DESC";
  const select = count ? "COUNT(*) AS total" : "n.*";
  return { sql: `SELECT ${select} FROM ${from} WHERE ${where.join(" AND ")}${order}`, bindings };
}

export async function listNotes(
  db: D1Database,
  ownerTelegramId: number,
  options: ListNotesOptions = {},
): Promise<{ items: NoteApi[]; total: number }> {
  const limit = Math.min(200, Math.max(1, options.limit || 50));
  const offset = Math.max(0, options.offset || 0);
  const list = buildListQuery(ownerTelegramId, options, false);
  const count = buildListQuery(ownerTelegramId, options, true);
  const [rows, totalRow] = await db.batch([
    db.prepare(`${list.sql} LIMIT ? OFFSET ?`).bind(...list.bindings, limit, offset),
    db.prepare(count.sql).bind(...count.bindings),
  ]);
  const noteRows = (rows.results || []) as unknown as NoteRow[];
  const noteIds = new Set(noteRows.map((note) => note.id));
  const allAttachments = noteIds.size
    ? await db
        .prepare("SELECT * FROM attachments WHERE owner_telegram_id = ? ORDER BY id")
        .bind(ownerTelegramId)
        .all<AttachmentRow>()
    : { results: [] as AttachmentRow[] };
  const grouped = new Map<number, AttachmentRow[]>();
  for (const attachment of allAttachments.results || []) {
    if (!noteIds.has(attachment.note_id)) continue;
    const values = grouped.get(attachment.note_id) || [];
    values.push(attachment);
    grouped.set(attachment.note_id, values);
  }
  return {
    items: noteRows.map((note) => noteToApi(note, grouped.get(note.id) || [])),
    total: Number((totalRow.results?.[0] as { total?: number } | undefined)?.total || 0),
  };
}

export async function failStalePendingNotes(
  db: D1Database,
  ownerTelegramId: number,
  olderThanMinutes = 2,
): Promise<number> {
  const safeMinutes = Math.min(60, Math.max(1, Math.floor(olderThanMinutes)));
  const result = await db
    .prepare(
      `UPDATE notes
       SET status = 'published',
           processing_status = 'failed',
           metadata_json = json_set(
             metadata_json,
             '$.processing_error',
             'Автоматическая обработка не завершилась вовремя. Исходная запись сохранена.'
           ),
           updated_at = CURRENT_TIMESTAMP
       WHERE owner_telegram_id = ?
         AND processing_status = 'pending'
         AND created_at <= datetime('now', ?)
       RETURNING id`,
    )
    .bind(ownerTelegramId, `-${safeMinutes} minutes`)
    .all<{ id: number }>();
  return result.results.length;
}

export async function searchNotesForAnswer(
  db: D1Database,
  ownerTelegramId: number,
  query: string,
  limit = 8,
): Promise<NoteApi[]> {
  const result = await listNotes(db, ownerTelegramId, {
    query,
    status: "published",
    limit,
    offset: 0,
  });
  return result.items;
}

export async function updateNote(
  db: D1Database,
  ownerTelegramId: number,
  id: number,
  input: UpdateNoteInput,
): Promise<NoteRow | null> {
  const columns: string[] = [];
  const bindings: unknown[] = [];
  const add = (column: string, value: unknown) => {
    columns.push(`${column} = ?`);
    bindings.push(value);
  };
  if (input.type !== undefined) add("type", input.type);
  if (input.title !== undefined) add("title", input.title);
  if (input.summary !== undefined) add("summary", input.summary);
  if (input.text !== undefined) add("text", input.text);
  if (input.tags !== undefined) add("tags_json", JSON.stringify(normalizeTags(input.tags)));
  if (input.section !== undefined) add("section", input.section);
  if (input.status !== undefined) add("status", input.status);
  if (input.sourceUrl !== undefined) add("source_url", input.sourceUrl);
  if (input.processingStatus !== undefined) add("processing_status", input.processingStatus);
  if (input.metadata !== undefined) add("metadata_json", JSON.stringify(input.metadata));
  if (!columns.length) return getNote(db, ownerTelegramId, id);
  columns.push("updated_at = CURRENT_TIMESTAMP");
  return db
    .prepare(`UPDATE notes SET ${columns.join(", ")} WHERE id = ? AND owner_telegram_id = ? RETURNING *`)
    .bind(...bindings, id, ownerTelegramId)
    .first<NoteRow>();
}

export async function deleteNote(db: D1Database, ownerTelegramId: number, id: number): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM notes WHERE id = ? AND owner_telegram_id = ?")
    .bind(id, ownerTelegramId)
    .run();
  return Number(result.meta.changes || 0) > 0;
}

export async function insertAttachment(
  db: D1Database,
  input: Omit<AttachmentRow, "id" | "created_at">,
): Promise<AttachmentRow> {
  const row = await db
    .prepare(
      `INSERT INTO attachments (
        note_id, owner_telegram_id, telegram_file_id, telegram_file_unique_id,
        file_name, mime_type, size_bytes, width, height
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(
      input.note_id,
      input.owner_telegram_id,
      input.telegram_file_id,
      input.telegram_file_unique_id,
      input.file_name,
      input.mime_type,
      input.size_bytes,
      input.width,
      input.height,
    )
    .first<AttachmentRow>();
  if (!row) throw new Error("D1 did not return the created attachment");
  return row;
}

export async function listAttachmentsForNote(
  db: D1Database,
  ownerTelegramId: number,
  noteId: number,
): Promise<AttachmentRow[]> {
  const result = await db
    .prepare("SELECT * FROM attachments WHERE note_id = ? AND owner_telegram_id = ? ORDER BY id")
    .bind(noteId, ownerTelegramId)
    .all<AttachmentRow>();
  return result.results || [];
}

export async function getAttachment(
  db: D1Database,
  ownerTelegramId: number,
  attachmentId: number,
): Promise<AttachmentRow | null> {
  return db
    .prepare("SELECT * FROM attachments WHERE id = ? AND owner_telegram_id = ?")
    .bind(attachmentId, ownerTelegramId)
    .first<AttachmentRow>();
}

export async function claimTelegramUpdate(db: D1Database, updateId: number): Promise<boolean> {
  const result = await db
    .prepare("INSERT OR IGNORE INTO telegram_updates(update_id) VALUES (?)")
    .bind(updateId)
    .run();
  return Number(result.meta.changes || 0) > 0;
}

export async function setConversationState(
  db: D1Database,
  ownerTelegramId: number,
  action: string,
  noteId: number | null,
  ttlMinutes = 30,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO conversation_state(owner_telegram_id, action, note_id, expires_at, updated_at)
       VALUES (?, ?, ?, datetime('now', ?), CURRENT_TIMESTAMP)
       ON CONFLICT(owner_telegram_id) DO UPDATE SET
         action = excluded.action,
         note_id = excluded.note_id,
         expires_at = excluded.expires_at,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(ownerTelegramId, action, noteId, `+${ttlMinutes} minutes`)
    .run();
}

export async function getConversationState(
  db: D1Database,
  ownerTelegramId: number,
): Promise<{ action: string; note_id: number | null } | null> {
  const state = await db
    .prepare(
      "SELECT action, note_id FROM conversation_state WHERE owner_telegram_id = ? AND expires_at > CURRENT_TIMESTAMP",
    )
    .bind(ownerTelegramId)
    .first<{ action: string; note_id: number | null }>();
  if (!state) await clearConversationState(db, ownerTelegramId);
  return state;
}

export async function clearConversationState(db: D1Database, ownerTelegramId: number): Promise<void> {
  await db.prepare("DELETE FROM conversation_state WHERE owner_telegram_id = ?").bind(ownerTelegramId).run();
}

export async function getStats(db: D1Database, ownerTelegramId: number) {
  const [countResult, tagsResult] = await db.batch([
    db.prepare("SELECT COUNT(*) AS total FROM notes WHERE owner_telegram_id = ? AND status = 'published'").bind(
      ownerTelegramId,
    ),
    db
      .prepare(
        `SELECT lower(j.value) AS tag, COUNT(*) AS count
         FROM notes n, json_each(n.tags_json) j
         WHERE n.owner_telegram_id = ? AND n.status = 'published'
         GROUP BY lower(j.value)
         ORDER BY count DESC, tag ASC`,
      )
      .bind(ownerTelegramId),
  ]);
  const tags: Record<string, number> = {};
  for (const row of tagsResult.results as Array<{ tag: string; count: number }>) {
    tags[row.tag] = Number(row.count);
  }
  return {
    total_notes: Number((countResult.results[0] as { total: number }).total || 0),
    total_tags: Object.keys(tags).length,
    tags,
  };
}
