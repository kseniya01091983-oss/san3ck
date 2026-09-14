import { analyzeTextMessage, describeImage, structureTextNote, summarizeExtractedLink } from "./ai";
import { isAllowedTelegramId } from "./access";
import { createSiteLoginUrl } from "./auth";
import {
  claimFailedNoteForRetry,
  claimTelegramUpdate,
  clearConversationState,
  createNote,
  deleteNote,
  failStalePendingNotes,
  findExternalNote,
  getConversationState,
  getNote,
  getNoteApi,
  insertAttachment,
  listAttachmentsForNote,
  listNotes,
  setConversationState,
  updateNote,
} from "./db";
import { extractPage } from "./tavily";
import { getTmdbCard, searchTmdb, unambiguousTmdbResult, type TmdbCard, type TmdbMediaHint } from "./tmdb";
import {
  answerCallback,
  downloadTelegramFile,
  editMessageText,
  getTelegramFile,
  sendMessage,
  sendMessageWithResult,
  sendPhoto,
  sendTyping,
  setBotCommands,
  type InlineButton,
  type TelegramBotCommand,
} from "./telegram-api";
import type {
  Env,
  NoteApi,
  NoteRow,
  TelegramCallbackQuery,
  TelegramDocument,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramUpdate,
} from "./types";
import {
  bytesToBase64,
  commandParts,
  escapeHtml,
  extractFirstUrl,
  firstLine,
  jsonResponse,
  parseJson,
  safeFileName,
  SECTION_LABELS,
  tagsFromText,
  truncate,
} from "./utils";
import { deleteNoteVector, reindexFailureMessage, reindexOwner, searchRagNotes, syncNoteVector } from "./upstash";

const NOTES_PER_PAGE = 5;
const MAX_VISION_BYTES = 8 * 1024 * 1024;
const BOT_COMMANDS: TelegramBotCommand[] = [
  { command: "notes", description: "Показать мои заметки" },
  { command: "ask", description: "Задать вопрос по заметкам" },
  { command: "site", description: "Открыть сайт FastNotes" },
  { command: "edit", description: "Изменить заметку по номеру" },
  { command: "hide", description: "Скрыть заметку по номеру" },
  { command: "show", description: "Показать скрытую заметку" },
  { command: "delete", description: "Удалить заметку по номеру" },
  { command: "cancel", description: "Отменить начатое действие" },
  { command: "help", description: "Показать понятную справку" },
];

const HELP_TEXT = `<b>Как пользоваться FastNotes</b>

Просто отправьте сообщение — бот сохранит его и подберёт заголовок, раздел и теги.

🎬 <b>Фильм:</b> <code>Хочу посмотреть Интерстеллар</code>
✅ <b>Задача:</b> <code>Завтра позвонить врачу в 10 утра</code>
🔗 <b>Ссылка:</b> отправьте адрес страницы — бот сделает краткий пересказ.
💬 <b>Вопрос по базе:</b> <code>/ask какие фильмы я хотела посмотреть?</code>

<b>Команды</b>
/notes — мои заметки
/site — открыть сайт
/edit 12 — изменить заметку №12
/hide 12 — скрыть заметку
/show 12 — показать заметку
/delete 12 — удалить заметку
/cancel — отменить редактирование

ℹ️ Текст со временем сохраняется как задача, но бот пока не присылает напоминание в назначенный час.`;

async function sendStart(env: Env, chatId: number, telegramId: number): Promise<void> {
  await setBotCommands(env, BOT_COMMANDS).catch((error) => {
    console.warn("Telegram setMyCommands failed", error);
  });
  const siteUrl = await createSiteLoginUrl(env, telegramId);
  await sendMessage(
    env,
    chatId,
    `<b>👋 Добро пожаловать в FastNotes!</b>

Я сохраняю ваши заметки и помогаю находить их.

Просто отправьте:
🎬 <code>Хочу посмотреть фильм Интерстеллар</code>
✅ <code>Завтра позвонить врачу в 10 утра</code>
🔗 ссылку на статью
🖼 фотографию или изображение

Чтобы задать вопрос по заметкам:
<code>/ask какие фильмы я хотел посмотреть?</code>

ℹ️ Задачи сохраняются как заметки, но бот пока не присылает напоминания в назначенное время.`,
    [
      [{ text: "📝 Мои заметки", callback_data: "page:0" }],
      [{ text: "🌐 Открыть сайт", url: siteUrl }],
      [{ text: "💬 Задать вопрос", callback_data: "help_ask" }],
      [{ text: "📖 Полная справка", callback_data: "help_full" }],
    ],
  );
}

function noteKeyboard(note: NoteApi | NoteRow): InlineButton[][] {
  const failed = note.processing_status === "failed"
    ? [{ text: "🔄 Повторить", callback_data: `retry:${note.id}` }]
    : [];
  return [
    [
      { text: "✏️ Изменить", callback_data: `edit:${note.id}` },
      {
        text: note.status === "published" ? "👁 Скрыть" : "📢 Опубликовать",
        callback_data: `toggle_status:${note.id}`,
      },
      { text: "🗑 Удалить", callback_data: `delete:${note.id}` },
    ],
    failed,
  ].filter((row) => row.length > 0);
}

function formatNote(note: NoteApi | NoteRow): string {
  const label = SECTION_LABELS[note.section] || "Задачи и быт";
  const pending = note.processing_status === "pending" ? "\n\n⏳ <i>Обрабатывается…</i>" : "";
  const failed = note.processing_status === "failed"
    ? "\n\n⚠️ <i>Заметка сохранена, но нейросеть не смогла её обработать.</i>"
    : "";
  const source = note.source_url ? `\n\n🔗 ${escapeHtml(note.source_url)}` : "";
  const text = truncate(note.text || note.summary || note.title, 3200);
  return `📁 <b>${escapeHtml(label)}</b> · <b>${escapeHtml(note.title || firstLine(text))}</b>\n\n${escapeHtml(text)}${source}${pending}${failed}`;
}

async function deliverMessage(
  env: Env,
  chatId: number,
  text: string,
  keyboard?: InlineButton[][],
  replaceMessageId?: number | null,
): Promise<void> {
  if (replaceMessageId) {
    try {
      await editMessageText(env, chatId, replaceMessageId, text, keyboard);
      return;
    } catch (error) {
      console.warn("Telegram editMessageText failed; sending a new message", error);
    }
  }
  await sendMessage(env, chatId, text, keyboard);
}

async function syncVectorQuietly(env: Env, note: NoteRow | null): Promise<void> {
  if (!note) return;
  await syncNoteVector(env, note).catch((error) => console.warn("Vector sync failed", error));
}

function tmdbKindLabel(kind: "movie" | "tv"): string {
  return kind === "movie" ? "фильм" : "сериал";
}

function formatTmdbCard(card: TmdbCard): string {
  const rating = card.voteCount
    ? `${card.voteAverage.toFixed(1)}/10 · ${card.voteCount} оценок`
    : "оценок пока нет";
  const genres = card.genres.length ? truncate(card.genres.join(", "), 180) : "не указаны";
  return `<b>${escapeHtml(truncate(card.title, 160))}</b>\n${escapeHtml(tmdbKindLabel(card.kind))} · ${escapeHtml(card.year)}\n\n${escapeHtml(truncate(card.overview, 480))}\n\n<b>Жанры:</b> ${escapeHtml(genres)}\n<b>Рейтинг TMDB:</b> ${escapeHtml(rating)}`;
}

function parseTmdbCard(value: Record<string, unknown>): TmdbCard | null {
  const card = value.card;
  if (!card || typeof card !== "object" || Array.isArray(card)) return null;
  const item = card as Record<string, unknown>;
  if ((item.kind !== "movie" && item.kind !== "tv") || !Number.isSafeInteger(Number(item.id))) return null;
  return {
    id: Number(item.id),
    kind: item.kind,
    title: String(item.title || "Без названия"),
    originalTitle: String(item.originalTitle || ""),
    year: String(item.year || "год неизвестен"),
    overview: String(item.overview || "Описание пока отсутствует."),
    genres: Array.isArray(item.genres) ? item.genres.map(String).filter(Boolean) : [],
    voteAverage: Number(item.voteAverage || 0),
    voteCount: Number(item.voteCount || 0),
    releaseDate: String(item.releaseDate || ""),
    posterUrl: typeof item.posterUrl === "string" ? item.posterUrl : null,
    sourceUrl: String(item.sourceUrl || `https://www.themoviedb.org/${item.kind}/${item.id}`),
  };
}

async function showTmdbPreview(env: Env, chatId: number, telegramId: number, card: TmdbCard): Promise<void> {
  await setConversationState(env.DB, telegramId, "tmdb_confirm", null, 30, { card });
  const keyboard: InlineButton[][] = [[
    { text: "✅ Сохранить", callback_data: "tmdb_save" },
    { text: "❌ Отмена", callback_data: "tmdb_cancel" },
  ]];
  const caption = `${formatTmdbCard(card)}\n\nСохранить в раздел «Фильмы и сериалы»?`;
  if (card.posterUrl) {
    try {
      await sendPhoto(env, chatId, card.posterUrl, caption, keyboard);
      return;
    } catch (error) {
      console.warn("TMDB poster delivery failed; using text card", error);
    }
  }
  await sendMessage(env, chatId, caption, keyboard);
}

async function markTmdbFailure(
  env: Env,
  telegramId: number,
  originalText: string,
  query: string,
  hint: TmdbMediaHint,
  error: unknown,
  noteId?: number | null,
): Promise<number> {
  const metadata = {
    created_from: "telegram",
    retry_kind: "tmdb",
    tmdb_query: query,
    tmdb_media_type: hint,
    processing_error: error instanceof Error ? error.message : "TMDB недоступен",
  };
  if (noteId) {
    await updateNote(env.DB, telegramId, noteId, { status: "published", processingStatus: "failed", metadata });
    return noteId;
  }
  const row = await createNote(env.DB, {
    ownerTelegramId: telegramId,
    type: "recommendation",
    title: firstLine(originalText),
    text: originalText,
    tags: ["кино"],
    section: "movies",
    processingStatus: "failed",
    metadata,
  });
  return row.id;
}

async function beginTmdbLookup(
  env: Env,
  chatId: number,
  telegramId: number,
  originalText: string,
  query: string,
  hint: TmdbMediaHint,
  pendingNoteId?: number | null,
  replaceMessageId?: number | null,
): Promise<void> {
  try {
    const results = await searchTmdb(env, query, hint);
    if (!results.length) throw new Error("TMDB не нашёл подходящий фильм или сериал");
    const exact = unambiguousTmdbResult(results, query);
    if (exact) {
      const card = await getTmdbCard(env, exact.kind, exact.id);
      if (pendingNoteId) await deleteNote(env.DB, telegramId, pendingNoteId);
      if (replaceMessageId) {
        await editMessageText(env, chatId, replaceMessageId, "🎬 Карточка найдена. Проверьте её ниже.").catch(() => undefined);
      }
      await showTmdbPreview(env, chatId, telegramId, card);
      return;
    }

    if (pendingNoteId) await deleteNote(env.DB, telegramId, pendingNoteId);
    await setConversationState(env.DB, telegramId, "tmdb_choose", null, 30, {
      originalText,
      query,
      hint,
    });
    const buttons = results.map((item) => [{
      text: `${truncate(item.title, 34)} · ${tmdbKindLabel(item.kind)} · ${item.year}`,
      callback_data: `tmdb_pick:${item.kind}:${item.id}`,
    }]);
    buttons.push([{ text: "❌ Отмена", callback_data: "tmdb_cancel" }]);
    await deliverMessage(env, chatId, `<b>Нашлось несколько вариантов.</b>\nВыберите нужный:`, buttons, replaceMessageId);
  } catch (error) {
    const failedId = await markTmdbFailure(env, telegramId, originalText, query, hint, error, pendingNoteId);
    await sendNote(env, chatId, failedId, telegramId, replaceMessageId);
  }
}

async function saveTmdbCard(env: Env, chatId: number, telegramId: number, card: TmdbCard): Promise<void> {
  const existing = await findExternalNote(env.DB, telegramId, "tmdb", card.kind, String(card.id));
  if (existing) {
    await clearConversationState(env.DB, telegramId);
    return sendMessage(env, chatId, `ℹ️ «${escapeHtml(card.title)}» уже сохранён как заметка №${existing.id}.`, [[
      { text: `Открыть №${existing.id}`, callback_data: `view:${existing.id}` },
    ]]);
  }
  try {
    const row = await createNote(env.DB, {
      ownerTelegramId: telegramId,
      type: "recommendation",
      title: card.title,
      summary: card.overview,
      text: `${card.title} (${card.year})\n${tmdbKindLabel(card.kind)}\n\n${card.overview}\n\nЖанры: ${card.genres.join(", ") || "не указаны"}\nРейтинг TMDB: ${card.voteAverage.toFixed(1)}/10 (${card.voteCount} оценок)`,
      tags: [tmdbKindLabel(card.kind), ...card.genres],
      section: "movies",
      sourceUrl: card.sourceUrl,
      processingStatus: "ready",
      externalProvider: "tmdb",
      externalKind: card.kind,
      externalId: String(card.id),
      metadata: { created_from: "tmdb", tmdb: card },
    });
    await clearConversationState(env.DB, telegramId);
    await syncVectorQuietly(env, row);
    await sendMessage(env, chatId, `✅ <b>«${escapeHtml(card.title)}» сохранён в фильмы и сериалы.</b>`, [[
      { text: `Открыть заметку №${row.id}`, callback_data: `view:${row.id}` },
    ]]);
  } catch (error) {
    const duplicate = await findExternalNote(env.DB, telegramId, "tmdb", card.kind, String(card.id));
    if (duplicate) {
      await clearConversationState(env.DB, telegramId);
      return sendMessage(env, chatId, `ℹ️ Этот фильм или сериал уже сохранён как заметка №${duplicate.id}.`);
    }
    throw error;
  }
}

async function announceSaved(env: Env, chatId: number, noteId: number): Promise<number | null> {
  try {
    const message = await sendMessageWithResult(
      env,
      chatId,
      `✅ <b>Заметка №${noteId} сохранена.</b>\n⏳ Обрабатываю…`,
    );
    return Number.isInteger(message.message_id) ? message.message_id : null;
  } catch (error) {
    console.warn("Telegram processing announcement failed", error);
    return null;
  }
}

async function sendNote(
  env: Env,
  chatId: number,
  noteId: number,
  telegramId: number,
  replaceMessageId?: number | null,
): Promise<void> {
  const note = await getNoteApi(env.DB, telegramId, noteId);
  if (!note) return sendMessage(env, chatId, "❌ Заметка не найдена.");
  await deliverMessage(env, chatId, formatNote(note), noteKeyboard(note), replaceMessageId);
}

function paginationKeyboard(notes: NoteApi[], page: number, totalPages: number): InlineButton[][] {
  const rows: InlineButton[][] = [];
  for (let i = 0; i < notes.length; i += 5) {
    rows.push(notes.slice(i, i + 5).map((note) => ({ text: `№${note.id}`, callback_data: `view:${note.id}` })));
  }
  const navigation: InlineButton[] = [];
  if (page > 0) navigation.push({ text: "⬅️ Назад", callback_data: `page:${page - 1}` });
  navigation.push({ text: `Стр. ${page + 1}/${Math.max(1, totalPages)}`, callback_data: "noop" });
  if (page < totalPages - 1) navigation.push({ text: "Вперёд ➡️", callback_data: `page:${page + 1}` });
  rows.push(navigation);
  return rows;
}

async function sendNotesPage(env: Env, chatId: number, page: number, telegramId: number): Promise<void> {
  await failStalePendingNotes(env.DB, telegramId);
  const result = await listNotes(env.DB, telegramId, {
    status: null,
    limit: NOTES_PER_PAGE,
    offset: Math.max(0, page) * NOTES_PER_PAGE,
  });
  const totalPages = Math.max(1, Math.ceil(result.total / NOTES_PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  if (safePage !== page) return sendNotesPage(env, chatId, safePage, telegramId);
  if (!result.items.length) return sendMessage(env, chatId, "📝 Заметок пока нет. Отправьте первую мысль или ссылку.");
  const lines = result.items.map(
    (note) => `• <b>№${note.id}</b> ${escapeHtml(note.title || firstLine(note.text))}`,
  );
  await sendMessage(
    env,
    chatId,
    `<b>FastNotes</b> · ${result.total} записей\n\n${lines.join("\n")}`,
    paginationKeyboard(result.items, safePage, totalPages),
  );
}

async function answerFromNotes(env: Env, chatId: number, question: string, telegramId: number): Promise<void> {
  const candidates = await searchRagNotes(env, telegramId, question);
  const result = await analyzeTextMessage(env, question, candidates, true);
  const buttons = result.intent === "answer_question"
    ? result.source_note_ids.map((id) => [{ text: `Открыть источник №${id}`, callback_data: `view:${id}` }])
    : [];
  await sendMessage(env, chatId, escapeHtml(result.intent === "answer_question" ? result.answer : "В заметках нет ответа."), buttons);
}

async function savePlainText(env: Env, chatId: number, text: string, telegramId: number): Promise<void> {
  const pending = await createNote(env.DB, {
    ownerTelegramId: telegramId,
    type: "note",
    title: firstLine(text),
    text,
    tags: tagsFromText(text),
    section: "tasks",
    status: "published",
    processingStatus: "pending",
    metadata: { created_from: "telegram", original_text_saved: true },
  });
  const progressMessageId = await announceSaved(env, chatId, pending.id);
  const candidates = await searchRagNotes(env, telegramId, text);
  try {
    const analysis = await analyzeTextMessage(env, text, candidates, false);
    if (analysis.intent === "answer_question") {
      await deleteNote(env.DB, telegramId, pending.id);
      const buttons = analysis.source_note_ids.map((id) => [
        { text: `Открыть источник №${id}`, callback_data: `view:${id}` },
      ]);
      await deliverMessage(env, chatId, escapeHtml(analysis.answer), buttons, progressMessageId);
      return;
    }
    if (analysis.intent === "media_lookup") {
      await beginTmdbLookup(
        env,
        chatId,
        telegramId,
        text,
        analysis.query,
        analysis.media_type,
        pending.id,
        progressMessageId,
      );
      return;
    }
    const updated = await updateNote(env.DB, telegramId, pending.id, {
      ...analysis.note,
      status: "published",
      processingStatus: "ready",
      metadata: { created_from: "telegram" },
    });
    await syncVectorQuietly(env, updated);
    await sendNote(env, chatId, pending.id, telegramId, progressMessageId);
  } catch (error) {
    await updateNote(env.DB, telegramId, pending.id, {
      status: "published",
      processingStatus: "failed",
      metadata: { created_from: "telegram", processing_error: error instanceof Error ? error.message : "unknown" },
    });
    await sendNote(env, chatId, pending.id, telegramId, progressMessageId);
  }
}

async function saveLink(env: Env, chatId: number, rawText: string, url: string, telegramId: number): Promise<void> {
  const caption = rawText.replace(url, "").trim();
  const note = await createNote(env.DB, {
    ownerTelegramId: telegramId,
    type: "link",
    title: firstLine(caption || new URL(url).hostname, "Ссылка"),
    summary: caption,
    text: caption || url,
    sourceUrl: url,
    section: "tasks",
    processingStatus: "pending",
    metadata: { created_from: "telegram" },
  });
  const progressMessageId = await announceSaved(env, chatId, note.id);
  try {
    const extracted = await extractPage(env, url);
    const summary = await summarizeExtractedLink(env, url, caption, extracted.content);
    await updateNote(env.DB, telegramId, note.id, {
      type: "link",
      ...summary,
      processingStatus: "ready",
      metadata: { created_from: "telegram", ...extracted.metadata },
    });
  } catch (error) {
    await updateNote(env.DB, telegramId, note.id, {
      processingStatus: "failed",
      metadata: { created_from: "telegram", processing_error: error instanceof Error ? error.message : "unknown" },
    });
  }
  await syncVectorQuietly(env, await getNote(env.DB, telegramId, note.id));
  await sendNote(env, chatId, note.id, telegramId, progressMessageId);
}

type IncomingFile = {
  fileId: string;
  uniqueId: string;
  fileName: string;
  mimeType: string;
  size: number | null;
  width: number | null;
  height: number | null;
  isImage: boolean;
};

function incomingFileMetadata(file: IncomingFile): Record<string, unknown> {
  return {
    file_id: file.fileId,
    unique_id: file.uniqueId,
    file_name: file.fileName,
    mime_type: file.mimeType,
    size: file.size,
    width: file.width,
    height: file.height,
    is_image: file.isImage,
  };
}

function incomingFileFromMetadata(note: NoteRow): IncomingFile | null {
  const metadata = parseJson<Record<string, unknown>>(note.metadata_json, {});
  const raw = metadata.telegram_file;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const fileId = String(value.file_id || "");
  const uniqueId = String(value.unique_id || "");
  const fileName = String(value.file_name || "");
  const mimeType = String(value.mime_type || "application/octet-stream");
  if (!fileId || !uniqueId || !fileName) return null;
  const optionalNumber = (raw: unknown): number | null => {
    if (raw === null || raw === undefined || raw === "") return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    fileId,
    uniqueId,
    fileName: safeFileName(fileName),
    mimeType,
    size: optionalNumber(value.size),
    width: optionalNumber(value.width),
    height: optionalNumber(value.height),
    isImage: value.is_image === true || mimeType.startsWith("image/"),
  };
}

function incomingPhoto(photo: TelegramPhotoSize): IncomingFile {
  return {
    fileId: photo.file_id,
    uniqueId: photo.file_unique_id,
    fileName: `telegram-photo-${photo.file_unique_id}.jpg`,
    mimeType: "image/jpeg",
    size: photo.file_size || null,
    width: photo.width,
    height: photo.height,
    isImage: true,
  };
}

function incomingDocument(document: TelegramDocument): IncomingFile {
  const mimeType = document.mime_type || "application/octet-stream";
  return {
    fileId: document.file_id,
    uniqueId: document.file_unique_id,
    fileName: safeFileName(document.file_name || `telegram-file-${document.file_unique_id}`),
    mimeType,
    size: document.file_size || null,
    width: null,
    height: null,
    isImage: mimeType.startsWith("image/"),
  };
}

async function saveIncomingFile(
  env: Env,
  chatId: number,
  file: IncomingFile,
  caption: string,
  telegramId: number,
): Promise<void> {
  const baseMetadata = { created_from: "telegram", telegram_file: incomingFileMetadata(file) };
  const note = await createNote(env.DB, {
    ownerTelegramId: telegramId,
    type: file.isImage ? "image" : "file",
    title: firstLine(caption || file.fileName),
    summary: caption,
    text: caption || file.fileName,
    section: "tasks",
    processingStatus: "pending",
    metadata: baseMetadata,
  });
  const progressMessageId = await announceSaved(env, chatId, note.id);
  try {
    const attachment = await insertAttachment(env.DB, {
      note_id: note.id,
      owner_telegram_id: telegramId,
      telegram_file_id: file.fileId,
      telegram_file_unique_id: file.uniqueId,
      file_name: file.fileName,
      mime_type: file.mimeType,
      size_bytes: file.size,
      width: file.width,
      height: file.height,
    });

    if (file.isImage) {
      const info = await getTelegramFile(env, file.fileId);
      const knownSize = file.size || info.file_size || null;
      if (knownSize && knownSize > MAX_VISION_BYTES) throw new Error("Изображение слишком велико для автоматического описания");
      const download = await downloadTelegramFile(env, info.file_path);
      const bytes = new Uint8Array(await download.arrayBuffer());
      if (bytes.byteLength > MAX_VISION_BYTES) {
        throw new Error("Изображение слишком велико для автоматического описания");
      }
      const dataUrl = `data:${file.mimeType};base64,${bytesToBase64(bytes)}`;
      const description = await describeImage(env, dataUrl, caption);
      await updateNote(env.DB, telegramId, note.id, {
        type: "image",
        ...description,
        processingStatus: "ready",
        metadata: { ...baseMetadata, attachment_id: attachment.id },
      });
    } else {
      await updateNote(env.DB, telegramId, note.id, {
        type: "file",
        title: firstLine(caption || file.fileName),
        summary: caption || `Файл ${file.fileName}`,
        text: caption || file.fileName,
        processingStatus: "ready",
        metadata: { ...baseMetadata, attachment_id: attachment.id },
      });
    }
  } catch (error) {
    await updateNote(env.DB, telegramId, note.id, {
      processingStatus: "failed",
      metadata: { ...baseMetadata, processing_error: error instanceof Error ? error.message : "unknown" },
    });
  }
  await syncVectorQuietly(env, await getNote(env.DB, telegramId, note.id));
  await sendNote(env, chatId, note.id, telegramId, progressMessageId);
}

async function editNoteText(env: Env, chatId: number, noteId: number, text: string, telegramId: number): Promise<void> {
  const updated = await updateNote(env.DB, telegramId, noteId, {
    title: firstLine(text),
    summary: "",
    text,
    tags: tagsFromText(text),
    processingStatus: "ready",
  });
  await clearConversationState(env.DB, telegramId);
  if (!updated) return sendMessage(env, chatId, "❌ Заметка не найдена.");
  await syncVectorQuietly(env, updated);
  await sendMessage(env, chatId, "✨ <b>Заметка успешно обновлена на сайте!</b>");
  await sendNote(env, chatId, noteId, telegramId);
}

async function removeNote(env: Env, noteId: number, telegramId: number): Promise<boolean> {
  const existing = await getNote(env.DB, telegramId, noteId);
  const removed = await deleteNote(env.DB, telegramId, noteId);
  if (removed && existing?.vector_status !== "not_indexed") {
    await deleteNoteVector(env, telegramId, noteId).catch((error) => console.warn("Vector delete failed", error));
  }
  return removed;
}

async function retryNote(
  env: Env,
  chatId: number,
  noteId: number,
  telegramId: number,
  replaceMessageId?: number,
): Promise<void> {
  const note = await getNote(env.DB, telegramId, noteId);
  if (!note) return sendMessage(env, chatId, "❌ Заметка не найдена.");
  if (note.processing_status === "pending") {
    return sendMessage(env, chatId, "⏳ Повторная обработка уже выполняется.");
  }
  if (note.processing_status !== "failed") {
    return sendMessage(env, chatId, "✅ Эта заметка уже обработана.");
  }
  if (!(await claimFailedNoteForRetry(env.DB, telegramId, noteId))) {
    return sendMessage(env, chatId, "⏳ Повторная обработка уже запущена.");
  }
  await sendNote(env, chatId, noteId, telegramId, replaceMessageId);
  const retryMetadata = parseJson<Record<string, unknown>>(note.metadata_json, {});
  if (retryMetadata.retry_kind === "tmdb") {
    await beginTmdbLookup(
      env,
      chatId,
      telegramId,
      note.text,
      String(retryMetadata.tmdb_query || note.title),
      ["movie", "tv", "any"].includes(String(retryMetadata.tmdb_media_type))
        ? retryMetadata.tmdb_media_type as TmdbMediaHint
        : "any",
      noteId,
      replaceMessageId,
    );
    return;
  }
  try {
    if (note.type === "link" && note.source_url) {
      const extracted = await extractPage(env, note.source_url);
      const summary = await summarizeExtractedLink(env, note.source_url, note.summary, extracted.content);
      await updateNote(env.DB, telegramId, noteId, {
        ...summary,
        processingStatus: "ready",
        metadata: extracted.metadata,
      });
    } else if (note.type === "image" || note.type === "file") {
      let attachment = (await listAttachmentsForNote(env.DB, telegramId, noteId))[0] || null;
      const incoming = incomingFileFromMetadata(note);
      if (!attachment) {
        if (!incoming) throw new Error("Данные Telegram-файла отсутствуют для повтора");
        attachment = await insertAttachment(env.DB, {
          note_id: noteId,
          owner_telegram_id: telegramId,
          telegram_file_id: incoming.fileId,
          telegram_file_unique_id: incoming.uniqueId,
          file_name: incoming.fileName,
          mime_type: incoming.mimeType,
          size_bytes: incoming.size,
          width: incoming.width,
          height: incoming.height,
        });
      }
      if (!attachment.telegram_file_id) throw new Error("Telegram file_id отсутствует");
      if (note.type === "image") {
        const info = await getTelegramFile(env, attachment.telegram_file_id);
        const download = await downloadTelegramFile(env, info.file_path);
        const bytes = new Uint8Array(await download.arrayBuffer());
        if (bytes.byteLength > MAX_VISION_BYTES) throw new Error("Изображение слишком велико для модели");
        const description = await describeImage(
          env,
          `data:${attachment.mime_type};base64,${bytesToBase64(bytes)}`,
          note.summary,
        );
        await updateNote(env.DB, telegramId, noteId, { ...description, processingStatus: "ready" });
      } else {
        await updateNote(env.DB, telegramId, noteId, { processingStatus: "ready" });
      }
    } else {
      const structured = await structureTextNote(env, note.text);
      await updateNote(env.DB, telegramId, noteId, { ...structured, processingStatus: "ready" });
    }
  } catch (error) {
    await updateNote(env.DB, telegramId, noteId, {
      processingStatus: "failed",
      metadata: { processing_error: error instanceof Error ? error.message : "unknown" },
    });
  }
  await syncVectorQuietly(env, await getNote(env.DB, telegramId, noteId));
  await sendNote(env, chatId, noteId, telegramId, replaceMessageId);
}

async function handleCommand(
  env: Env,
  message: TelegramMessage,
  command: string,
  args: string,
  telegramId: number,
): Promise<void> {
  const chatId = message.chat.id;
  if (command === "start") return sendStart(env, chatId, telegramId);
  if (command === "help") return sendMessage(env, chatId, HELP_TEXT);
  if (command === "reindex") {
    await sendMessage(env, chatId, "⏳ Пересобираю смысловой индекс ваших заметок…");
    try {
      const count = await reindexOwner(env, telegramId);
      return sendMessage(env, chatId, `✅ Смысловой индекс готов: ${count} заметок.`);
    } catch (error) {
      console.warn("Upstash reindex failed", error);
      return sendMessage(env, chatId, reindexFailureMessage(error));
    }
  }
  if (command === "cancel") {
    const state = await getConversationState(env.DB, telegramId);
    await clearConversationState(env.DB, telegramId);
    return sendMessage(
      env,
      chatId,
      state ? "🚫 Начатое действие отменено." : "ℹ️ Сейчас нет действия, которое нужно отменить.",
    );
  }
  if (["notes", "list"].includes(command)) return sendNotesPage(env, chatId, 0, telegramId);
  if (["site", "web"].includes(command)) {
    const url = await createSiteLoginUrl(env, telegramId);
    return sendMessage(env, chatId, "<b>FastNotes</b>\n\nСсылка действует 10 минут:", [[{ text: "🌐 Открыть сайт", url }]]);
  }
  if (["ask", "q"].includes(command)) {
    if (!args) return sendMessage(env, chatId, "💬 Задайте вопрос после команды. Например: <code>/ask какая цель проекта?</code>");
    return answerFromNotes(env, chatId, args, telegramId);
  }
  if (command === "edit") {
    const match = args.match(/^(\d+)(?:\s+([\s\S]+))?$/);
    if (!match) return sendMessage(env, chatId, "⚠️ Используйте: <code>/edit &lt;id&gt;</code>");
    const noteId = Number(match[1]);
    if (!(await getNote(env.DB, telegramId, noteId))) return sendMessage(env, chatId, "❌ Заметка не найдена.");
    if (match[2]) return editNoteText(env, chatId, noteId, match[2].trim(), telegramId);
    await setConversationState(env.DB, telegramId, "edit", noteId);
    return sendMessage(env, chatId, `✏️ Отправьте новым сообщением текст для заметки <b>№${noteId}</b>.`, [[{ text: "❌ Отменить", callback_data: "cancel_action" }]]);
  }
  if (["hide", "show"].includes(command)) {
    const noteId = Number(args);
    if (!Number.isInteger(noteId)) return sendMessage(env, chatId, `⚠️ Используйте: <code>/${command} &lt;id&gt;</code>`);
    const note = await updateNote(env.DB, telegramId, noteId, { status: command === "hide" ? "hidden" : "published" });
    if (!note) return sendMessage(env, chatId, "❌ Заметка не найдена.");
    await syncVectorQuietly(env, note);
    return sendNote(env, chatId, noteId, telegramId);
  }
  if (command === "delete") {
    const noteId = Number(args);
    if (!Number.isInteger(noteId)) return sendMessage(env, chatId, "⚠️ Используйте: <code>/delete &lt;id&gt;</code>");
    const note = await getNote(env.DB, telegramId, noteId);
    if (!note) return sendMessage(env, chatId, "❌ Заметка не найдена.");
    return sendMessage(env, chatId, `❓ Удалить заметку <b>№${noteId}</b>?`, [[
      { text: "✅ Да, удалить", callback_data: `confirm_delete:${noteId}` },
      { text: "❌ Отмена", callback_data: "cancel_action" },
    ]]);
  }
  await sendMessage(env, chatId, "Неизвестная команда. Используйте /help.");
}

async function handleMessage(env: Env, message: TelegramMessage, telegramId: number): Promise<void> {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  if (text) {
    const command = commandParts(text);
    if (command) return handleCommand(env, message, command.command, command.args, telegramId);
  }

  const state = await getConversationState(env.DB, telegramId);
  if (state?.action === "edit" && state.note_id && text) return editNoteText(env, chatId, state.note_id, text, telegramId);

  await sendTyping(env, chatId).catch(() => undefined);
  const caption = (message.caption || "").trim();
  if (message.photo?.length) return saveIncomingFile(env, chatId, incomingPhoto(message.photo.at(-1)!), caption, telegramId);
  if (message.document) return saveIncomingFile(env, chatId, incomingDocument(message.document), caption, telegramId);
  if (!text) return sendMessage(env, chatId, "Пока я умею сохранять текст, ссылки, изображения и файлы.");
  const url = extractFirstUrl(text);
  return url ? saveLink(env, chatId, text, url, telegramId) : savePlainText(env, chatId, text, telegramId);
}

async function handleCallback(env: Env, callback: TelegramCallbackQuery, telegramId: number): Promise<void> {
  const data = callback.data || "";
  const chatId = callback.message?.chat.id;
  await answerCallback(env, callback.id).catch(() => undefined);
  if (!chatId) return;
  if (data === "noop") return;
  if (data === "help_ask") {
    return sendMessage(
      env,
      chatId,
      "💬 Напишите команду и вопрос одним сообщением.\n\nНапример: <code>/ask какие фильмы я хотела посмотреть?</code>\n\nЯ отвечу только по вашим сохранённым заметкам.",
    );
  }
  if (data === "help_full") return sendMessage(env, chatId, HELP_TEXT);
  if (data === "tmdb_cancel") {
    await clearConversationState(env.DB, telegramId);
    return sendMessage(env, chatId, "🚫 Добавление фильма или сериала отменено.");
  }
  if (data === "tmdb_save") {
    const state = await getConversationState(env.DB, telegramId);
    const card = state?.action === "tmdb_confirm" ? parseTmdbCard(state.payload) : null;
    if (!card) return sendMessage(env, chatId, "⌛ Карточка устарела. Отправьте название ещё раз.");
    return saveTmdbCard(env, chatId, telegramId, card);
  }
  if (data.startsWith("tmdb_pick:")) {
    const match = data.match(/^tmdb_pick:(movie|tv):(\d+)$/);
    const state = await getConversationState(env.DB, telegramId);
    if (!match || state?.action !== "tmdb_choose") {
      return sendMessage(env, chatId, "⌛ Выбор устарел. Отправьте название ещё раз.");
    }
    try {
      const card = await getTmdbCard(env, match[1] as "movie" | "tv", Number(match[2]));
      return showTmdbPreview(env, chatId, telegramId, card);
    } catch (error) {
      const originalText = String(state.payload.originalText || state.payload.query || "Фильм или сериал");
      const hint = ["movie", "tv", "any"].includes(String(state.payload.hint))
        ? state.payload.hint as TmdbMediaHint
        : "any";
      const noteId = await markTmdbFailure(
        env,
        telegramId,
        originalText,
        String(state.payload.query || originalText),
        hint,
        error,
      );
      await clearConversationState(env.DB, telegramId);
      return sendNote(env, chatId, noteId, telegramId);
    }
  }
  if (data === "cancel_action") {
    await clearConversationState(env.DB, telegramId);
    return sendMessage(env, chatId, "🚫 Действие отменено.");
  }
  const [action, rawId] = data.split(":", 2);
  const id = Number(rawId);
  if (action === "page" && Number.isInteger(id)) return sendNotesPage(env, chatId, id, telegramId);
  if (action === "view" && Number.isInteger(id)) return sendNote(env, chatId, id, telegramId);
  if (action === "edit" && Number.isInteger(id)) {
    if (!(await getNote(env.DB, telegramId, id))) return sendMessage(env, chatId, "❌ Заметка не найдена.");
    await setConversationState(env.DB, telegramId, "edit", id);
    return sendMessage(env, chatId, `✏️ Отправьте новым сообщением текст для заметки <b>№${id}</b>.`, [[{ text: "❌ Отменить", callback_data: "cancel_action" }]]);
  }
  if (action === "delete" && Number.isInteger(id)) {
    return sendMessage(env, chatId, `❓ Вы действительно хотите удалить заметку <b>№${id}</b>?`, [[
      { text: "✅ Да, удалить", callback_data: `confirm_delete:${id}` },
      { text: "❌ Отмена", callback_data: "cancel_action" },
    ]]);
  }
  if (action === "confirm_delete" && Number.isInteger(id)) {
    const deleted = await removeNote(env, id, telegramId);
    return sendMessage(env, chatId, deleted ? `🗑 <b>Заметка №${id} удалена.</b>` : "❌ Заметка уже удалена.");
  }
  if (action === "toggle_status" && Number.isInteger(id)) {
    const note = await getNote(env.DB, telegramId, id);
    if (!note) return sendMessage(env, chatId, "❌ Заметка не найдена.");
    const updated = await updateNote(env.DB, telegramId, id, { status: note.status === "published" ? "hidden" : "published" });
    await syncVectorQuietly(env, updated);
    return sendNote(env, chatId, id, telegramId);
  }
  if (action === "retry" && Number.isInteger(id)) {
    return retryNote(env, chatId, id, telegramId, callback.message?.message_id);
  }
}

async function processUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  const actor = update.message?.from || update.callback_query?.from;
  const chatId = update.message?.chat.id || update.callback_query?.message?.chat.id;
  if (!actor || !isAllowedTelegramId(env, actor.id)) {
    if (chatId) await sendMessage(env, chatId, "⛔ Доступ закрыт.").catch(() => undefined);
    return;
  }
  if (!(await claimTelegramUpdate(env.DB, update.update_id))) return;
  try {
    if (update.callback_query) await handleCallback(env, update.callback_query, actor.id);
    else if (update.message) await handleMessage(env, update.message, actor.id);
  } catch (error) {
    console.error("Telegram update failed", update.update_id, error);
    if (chatId) await sendMessage(env, chatId, "⚠️ Не удалось завершить операцию. Исходные данные по возможности сохранены.").catch(() => undefined);
  }
}

export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }
  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return jsonResponse({ error: "Invalid Telegram update" }, 400);
  }
  if (!Number.isInteger(update.update_id)) return jsonResponse({ error: "Invalid update_id" }, 400);
  ctx.waitUntil(processUpdate(update, env));
  return jsonResponse({ ok: true });
}
