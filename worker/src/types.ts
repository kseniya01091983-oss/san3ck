export type NoteType =
  | "note"
  | "task"
  | "idea"
  | "recommendation"
  | "link"
  | "image"
  | "file";

export type NoteSection = "games" | "movies" | "work" | "tasks" | "tech";
export type NoteStatus = "published" | "hidden" | "draft";
export type ProcessingStatus = "pending" | "ready" | "failed";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  OWNER_TELEGRAM_ID: string;
  PUBLIC_BASE_URL: string;
  OPENROUTER_MODEL: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OPENROUTER_API_KEY: string;
  TAVILY_API_KEY: string;
  SITE_AUTH_SECRET: string;
  INTEGRATION_TEST_SECRET?: string;
}

export interface NoteRow {
  id: number;
  owner_telegram_id: number;
  type: NoteType;
  title: string;
  summary: string;
  text: string;
  tags_json: string;
  section: NoteSection;
  status: NoteStatus;
  source_url: string | null;
  processing_status: ProcessingStatus;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface AttachmentRow {
  id: number;
  note_id: number;
  owner_telegram_id: number;
  telegram_file_id: string | null;
  telegram_file_unique_id: string | null;
  file_name: string;
  mime_type: string;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface AttachmentApi {
  id: number;
  file_name: string;
  mime_type: string;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  url: string;
}

export interface NoteApi {
  id: number;
  type: NoteType;
  title: string;
  summary: string;
  text: string;
  tags: string[];
  section: NoteSection;
  status: NoteStatus;
  source_url: string | null;
  processing_status: ProcessingStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  attachments: AttachmentApi[];
}

export interface TelegramUser {
  id: number;
  username?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface StructuredNote {
  type: Exclude<NoteType, "link" | "image" | "file">;
  title: string;
  summary: string;
  text: string;
  tags: string[];
  section: NoteSection;
}

export interface AnswerResult {
  answer: string;
  source_note_ids: number[];
}
