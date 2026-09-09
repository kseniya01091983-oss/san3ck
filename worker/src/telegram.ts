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
  editMessageText,
  getTelegramFile,
  sendMessage,
  sendMessageWithResult,
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
    "<b>FastNotes</b>\n\nОтправьте мысль, ссылку, изображение или файл — я сразу сохраню исходник и аккуратно оформлю заметку.",
    [
      [{ text: "📝 Мои заметки", callback_data: "page:0" }],
      [{ text: "🌐 Открыть сайт", url: siteUrl }],
      [{ text: "💬 Как задать вопрос", callback_data: "help_ask" }],
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
  const candidates = await searchNotesForAnswer(env.DB, telegramId, question);
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
  const candidates = await searchNotesForAnswer(env.DB, telegramId, text);
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
    await updateNote(env.DB, telegramId, pending.id, {
      ...analysis.note,
      status: "published",
      processingStatus: "ready",
      metadata: { created_from: "telegram" },
    });
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
  await sendMessage(env, chatId, "✨ <b>Заметка успешно обновлена на сайте!</b>");
  await sendNote(env, chatId, noteId, telegramId);
}

async function removeNote(env: Env, noteId: number, telegramId: number): Promise<boolean> {
  return deleteNote(env.DB, telegramId, noteId);
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
    await updateNote(env.DB, telegramId, id, { status: note.status === "published" ? "hidden" : "published" });
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
