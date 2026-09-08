import { analyzeTextMessage, describeImage, structureTextNote, summarizeExtractedLink } from "./ai";
import { createSiteLoginUrl } from "./auth";
import {
  claimTelegramUpdate,
  clearConversationState,
  createNote,
  deleteNote,
  getConversationState,
  getNote,
  getNoteApi,
  insertAttachment,
  listAttachmentsForNote,
  listNotes,
  searchNotesForAnswer,
  setConversationState,
  updateNote,
} from "./db";
import { extractPage } from "./tavily";
import {
  answerCallback,
  downloadTelegramFile,
  getTelegramFile,
  sendMessage,
  sendTyping,
  type InlineButton,
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

const NOTES_PER_PAGE = 5;
const MAX_VISION_BYTES = 8 * 1024 * 1024;

function ownerId(env: Env): number {
  return Number(env.OWNER_TELEGRAM_ID);
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
  const failed = note.processing_status === "failed" ? "\n\n⚠️ <i>Автоматическая обработка не завершена. Исходник сохранён.</i>" : "";
  const source = note.source_url ? `\n\n🔗 ${escapeHtml(note.source_url)}` : "";
  const text = truncate(note.text || note.summary || note.title, 3200);
  return `📁 <b>${escapeHtml(label)}</b> · <b>${escapeHtml(note.title || firstLine(text))}</b>\n\n${escapeHtml(text)}${source}${pending}${failed}`;
}

async function sendNote(env: Env, chatId: number, noteId: number): Promise<void> {
  const note = await getNoteApi(env.DB, ownerId(env), noteId);
  if (!note) return sendMessage(env, chatId, "❌ Заметка не найдена.");
  await sendMessage(env, chatId, formatNote(note), noteKeyboard(note));
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

async function sendNotesPage(env: Env, chatId: number, page: number): Promise<void> {
  const result = await listNotes(env.DB, ownerId(env), {
    status: null,
    limit: NOTES_PER_PAGE,
    offset: Math.max(0, page) * NOTES_PER_PAGE,
  });
  const totalPages = Math.max(1, Math.ceil(result.total / NOTES_PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  if (safePage !== page) return sendNotesPage(env, chatId, safePage);
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

async function answerFromNotes(env: Env, chatId: number, question: string): Promise<void> {
  const candidates = await searchNotesForAnswer(env.DB, ownerId(env), question);
  const result = await analyzeTextMessage(env, question, candidates, true);
  const buttons = result.intent === "answer_question"
    ? result.source_note_ids.map((id) => [{ text: `Открыть источник №${id}`, callback_data: `view:${id}` }])
    : [];
  await sendMessage(env, chatId, escapeHtml(result.intent === "answer_question" ? result.answer : "В заметках нет ответа."), buttons);
}

async function savePlainText(env: Env, chatId: number, text: string): Promise<void> {
  const pending = await createNote(env.DB, {
    ownerTelegramId: ownerId(env),
    type: "note",
    title: firstLine(text),
    text,
    tags: tagsFromText(text),
    section: "tasks",
    status: "draft",
    processingStatus: "pending",
    metadata: { created_from: "telegram", original_text_saved: true },
  });
  const candidates = await searchNotesForAnswer(env.DB, ownerId(env), text);
  try {
    const analysis = await analyzeTextMessage(env, text, candidates, false);
    if (analysis.intent === "answer_question") {
      await deleteNote(env.DB, ownerId(env), pending.id);
      const buttons = analysis.source_note_ids.map((id) => [
        { text: `Открыть источник №${id}`, callback_data: `view:${id}` },
      ]);
      await sendMessage(env, chatId, escapeHtml(analysis.answer), buttons);
      return;
    }
    await updateNote(env.DB, ownerId(env), pending.id, {
      ...analysis.note,
      status: "published",
      processingStatus: "ready",
      metadata: { created_from: "telegram" },
    });
    await sendNote(env, chatId, pending.id);
  } catch (error) {
    await updateNote(env.DB, ownerId(env), pending.id, {
      status: "published",
      processingStatus: "failed",
      metadata: { created_from: "telegram", processing_error: error instanceof Error ? error.message : "unknown" },
    });
    await sendNote(env, chatId, pending.id);
  }
}

async function saveLink(env: Env, chatId: number, rawText: string, url: string): Promise<void> {
  const caption = rawText.replace(url, "").trim();
  const note = await createNote(env.DB, {
    ownerTelegramId: ownerId(env),
    type: "link",
    title: firstLine(caption || new URL(url).hostname, "Ссылка"),
    summary: caption,
    text: caption || url,
    sourceUrl: url,
    section: "tasks",
    processingStatus: "pending",
    metadata: { created_from: "telegram" },
  });
  try {
    const extracted = await extractPage(env, url);
    const summary = await summarizeExtractedLink(env, url, caption, extracted.content);
    await updateNote(env.DB, ownerId(env), note.id, {
      type: "link",
      ...summary,
      processingStatus: "ready",
      metadata: { created_from: "telegram", ...extracted.metadata },
    });
  } catch (error) {
    await updateNote(env.DB, ownerId(env), note.id, {
      processingStatus: "failed",
      metadata: { created_from: "telegram", processing_error: error instanceof Error ? error.message : "unknown" },
    });
  }
  await sendNote(env, chatId, note.id);
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

async function saveIncomingFile(env: Env, chatId: number, file: IncomingFile, caption: string): Promise<void> {
  const baseMetadata = { created_from: "telegram", telegram_file: incomingFileMetadata(file) };
  const note = await createNote(env.DB, {
    ownerTelegramId: ownerId(env),
    type: file.isImage ? "image" : "file",
    title: firstLine(caption || file.fileName),
    summary: caption,
    text: caption || file.fileName,
    section: "tasks",
    processingStatus: "pending",
    metadata: baseMetadata,
  });
  try {
    const attachment = await insertAttachment(env.DB, {
      note_id: note.id,
      owner_telegram_id: ownerId(env),
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
      await updateNote(env.DB, ownerId(env), note.id, {
        type: "image",
        ...description,
        processingStatus: "ready",
        metadata: { ...baseMetadata, attachment_id: attachment.id },
      });
    } else {
      await updateNote(env.DB, ownerId(env), note.id, {
        type: "file",
        title: firstLine(caption || file.fileName),
        summary: caption || `Файл ${file.fileName}`,
        text: caption || file.fileName,
        processingStatus: "ready",
        metadata: { ...baseMetadata, attachment_id: attachment.id },
      });
    }
  } catch (error) {
    await updateNote(env.DB, ownerId(env), note.id, {
      processingStatus: "failed",
      metadata: { ...baseMetadata, processing_error: error instanceof Error ? error.message : "unknown" },
    });
  }
  await sendNote(env, chatId, note.id);
}

async function editNoteText(env: Env, chatId: number, noteId: number, text: string): Promise<void> {
  const updated = await updateNote(env.DB, ownerId(env), noteId, {
    title: firstLine(text),
    summary: "",
    text,
    tags: tagsFromText(text),
    processingStatus: "ready",
  });
  await clearConversationState(env.DB, ownerId(env));
  if (!updated) return sendMessage(env, chatId, "❌ Заметка не найдена.");
  await sendMessage(env, chatId, "✨ <b>Заметка успешно обновлена на сайте!</b>");
  await sendNote(env, chatId, noteId);
}

async function removeNote(env: Env, noteId: number): Promise<boolean> {
  return deleteNote(env.DB, ownerId(env), noteId);
}

async function retryNote(env: Env, chatId: number, noteId: number): Promise<void> {
  const note = await getNote(env.DB, ownerId(env), noteId);
  if (!note) return sendMessage(env, chatId, "❌ Заметка не найдена.");
  await updateNote(env.DB, ownerId(env), noteId, { processingStatus: "pending" });
  try {
    if (note.type === "link" && note.source_url) {
      const extracted = await extractPage(env, note.source_url);
      const summary = await summarizeExtractedLink(env, note.source_url, note.summary, extracted.content);
      await updateNote(env.DB, ownerId(env), noteId, {
        ...summary,
        processingStatus: "ready",
        metadata: extracted.metadata,
      });
    } else if (note.type === "image" || note.type === "file") {
      let attachment = (await listAttachmentsForNote(env.DB, ownerId(env), noteId))[0] || null;
      const incoming = incomingFileFromMetadata(note);
      if (!attachment) {
        if (!incoming) throw new Error("Данные Telegram-файла отсутствуют для повтора");
        attachment = await insertAttachment(env.DB, {
          note_id: noteId,
          owner_telegram_id: ownerId(env),
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
        await updateNote(env.DB, ownerId(env), noteId, { ...description, processingStatus: "ready" });
      } else {
        await updateNote(env.DB, ownerId(env), noteId, { processingStatus: "ready" });
      }
    } else {
      const structured = await structureTextNote(env, note.text);
      await updateNote(env.DB, ownerId(env), noteId, { ...structured, processingStatus: "ready" });
    }
  } catch (error) {
    await updateNote(env.DB, ownerId(env), noteId, {
      processingStatus: "failed",
      metadata: { processing_error: error instanceof Error ? error.message : "unknown" },
    });
  }
  await sendNote(env, chatId, noteId);
}

async function handleCommand(env: Env, message: TelegramMessage, command: string, args: string): Promise<void> {
  const chatId = message.chat.id;
  if (["start", "help"].includes(command)) {
    return sendMessage(
      env,
      chatId,
      "<b>FastNotes</b>\n\nОтправьте мысль, ссылку, изображение или файл — сохраню и структурирую.\n\nКоманды: /notes, /ask, /site, /edit, /hide, /show, /delete",
    );
  }
  if (["notes", "list"].includes(command)) return sendNotesPage(env, chatId, 0);
  if (["site", "web"].includes(command)) {
    const url = await createSiteLoginUrl(env);
    return sendMessage(env, chatId, "<b>FastNotes</b>\n\nСсылка действует 10 минут:", [[{ text: "🌐 Открыть сайт", url }]]);
  }
  if (["ask", "q"].includes(command)) {
    if (!args) return sendMessage(env, chatId, "💬 Задайте вопрос после команды. Например: <code>/ask какая цель проекта?</code>");
    return answerFromNotes(env, chatId, args);
  }
  if (command === "edit") {
    const match = args.match(/^(\d+)(?:\s+([\s\S]+))?$/);
    if (!match) return sendMessage(env, chatId, "⚠️ Используйте: <code>/edit &lt;id&gt;</code>");
    const noteId = Number(match[1]);
    if (!(await getNote(env.DB, ownerId(env), noteId))) return sendMessage(env, chatId, "❌ Заметка не найдена.");
    if (match[2]) return editNoteText(env, chatId, noteId, match[2].trim());
    await setConversationState(env.DB, ownerId(env), "edit", noteId);
    return sendMessage(env, chatId, `✏️ Отправьте новым сообщением текст для заметки <b>№${noteId}</b>.`, [[{ text: "❌ Отменить", callback_data: "cancel_action" }]]);
  }
  if (["hide", "show"].includes(command)) {
    const noteId = Number(args);
    if (!Number.isInteger(noteId)) return sendMessage(env, chatId, `⚠️ Используйте: <code>/${command} &lt;id&gt;</code>`);
    const note = await updateNote(env.DB, ownerId(env), noteId, { status: command === "hide" ? "hidden" : "published" });
    if (!note) return sendMessage(env, chatId, "❌ Заметка не найдена.");
    return sendNote(env, chatId, noteId);
  }
  if (command === "delete") {
    const noteId = Number(args);
    if (!Number.isInteger(noteId)) return sendMessage(env, chatId, "⚠️ Используйте: <code>/delete &lt;id&gt;</code>");
    const note = await getNote(env.DB, ownerId(env), noteId);
    if (!note) return sendMessage(env, chatId, "❌ Заметка не найдена.");
    return sendMessage(env, chatId, `❓ Удалить заметку <b>№${noteId}</b>?`, [[
      { text: "✅ Да, удалить", callback_data: `confirm_delete:${noteId}` },
      { text: "❌ Отмена", callback_data: "cancel_action" },
    ]]);
  }
  await sendMessage(env, chatId, "Неизвестная команда. Используйте /help.");
}

async function handleMessage(env: Env, message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  if (text) {
    const command = commandParts(text);
    if (command) return handleCommand(env, message, command.command, command.args);
  }

  const state = await getConversationState(env.DB, ownerId(env));
  if (state?.action === "edit" && state.note_id && text) return editNoteText(env, chatId, state.note_id, text);

  await sendTyping(env, chatId).catch(() => undefined);
  const caption = (message.caption || "").trim();
  if (message.photo?.length) return saveIncomingFile(env, chatId, incomingPhoto(message.photo.at(-1)!), caption);
  if (message.document) return saveIncomingFile(env, chatId, incomingDocument(message.document), caption);
  if (!text) return sendMessage(env, chatId, "Пока я умею сохранять текст, ссылки, изображения и файлы.");
  const url = extractFirstUrl(text);
  return url ? saveLink(env, chatId, text, url) : savePlainText(env, chatId, text);
}

async function handleCallback(env: Env, callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data || "";
  const chatId = callback.message?.chat.id;
  await answerCallback(env, callback.id).catch(() => undefined);
  if (!chatId) return;
  if (data === "noop") return;
  if (data === "cancel_action") {
    await clearConversationState(env.DB, ownerId(env));
    return sendMessage(env, chatId, "🚫 Действие отменено.");
  }
  const [action, rawId] = data.split(":", 2);
  const id = Number(rawId);
  if (action === "page" && Number.isInteger(id)) return sendNotesPage(env, chatId, id);
  if (action === "view" && Number.isInteger(id)) return sendNote(env, chatId, id);
  if (action === "edit" && Number.isInteger(id)) {
    if (!(await getNote(env.DB, ownerId(env), id))) return sendMessage(env, chatId, "❌ Заметка не найдена.");
    await setConversationState(env.DB, ownerId(env), "edit", id);
    return sendMessage(env, chatId, `✏️ Отправьте новым сообщением текст для заметки <b>№${id}</b>.`, [[{ text: "❌ Отменить", callback_data: "cancel_action" }]]);
  }
  if (action === "delete" && Number.isInteger(id)) {
    return sendMessage(env, chatId, `❓ Вы действительно хотите удалить заметку <b>№${id}</b>?`, [[
      { text: "✅ Да, удалить", callback_data: `confirm_delete:${id}` },
      { text: "❌ Отмена", callback_data: "cancel_action" },
    ]]);
  }
  if (action === "confirm_delete" && Number.isInteger(id)) {
    const deleted = await removeNote(env, id);
    return sendMessage(env, chatId, deleted ? `🗑 <b>Заметка №${id} удалена.</b>` : "❌ Заметка уже удалена.");
  }
  if (action === "toggle_status" && Number.isInteger(id)) {
    const note = await getNote(env.DB, ownerId(env), id);
    if (!note) return sendMessage(env, chatId, "❌ Заметка не найдена.");
    await updateNote(env.DB, ownerId(env), id, { status: note.status === "published" ? "hidden" : "published" });
    return sendNote(env, chatId, id);
  }
  if (action === "retry" && Number.isInteger(id)) return retryNote(env, chatId, id);
}

async function processUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  const actor = update.message?.from || update.callback_query?.from;
  const chatId = update.message?.chat.id || update.callback_query?.message?.chat.id;
  if (!actor || actor.id !== ownerId(env)) {
    if (chatId) await sendMessage(env, chatId, "⛔ Доступ закрыт.").catch(() => undefined);
    return;
  }
  if (!(await claimTelegramUpdate(env.DB, update.update_id))) return;
  try {
    if (update.callback_query) await handleCallback(env, update.callback_query);
    else if (update.message) await handleMessage(env, update.message);
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
