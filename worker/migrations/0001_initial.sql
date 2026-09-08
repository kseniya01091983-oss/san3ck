PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_telegram_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'note',
    title TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
    section TEXT NOT NULL DEFAULT 'tasks',
    status TEXT NOT NULL DEFAULT 'published',
    source_url TEXT,
    processing_status TEXT NOT NULL DEFAULT 'ready',
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notes_owner_status_id
    ON notes(owner_telegram_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_notes_owner_section
    ON notes(owner_telegram_id, section, id DESC);
CREATE INDEX IF NOT EXISTS idx_notes_owner_type
    ON notes(owner_telegram_id, type, id DESC);

CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    owner_telegram_id INTEGER NOT NULL,
    r2_key TEXT NOT NULL UNIQUE,
    telegram_file_id TEXT,
    telegram_file_unique_id TEXT,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes INTEGER,
    width INTEGER,
    height INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments(note_id);
CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner_telegram_id, id);

CREATE TABLE IF NOT EXISTS telegram_updates (
    update_id INTEGER PRIMARY KEY,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversation_state (
    owner_telegram_id INTEGER PRIMARY KEY,
    action TEXT NOT NULL,
    note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title,
    summary,
    text,
    tags_json,
    content='notes',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, summary, text, tags_json)
    VALUES (new.id, new.title, new.summary, new.text, new.tags_json);
END;

CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, summary, text, tags_json)
    VALUES ('delete', old.id, old.title, old.summary, old.text, old.tags_json);
END;

CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, summary, text, tags_json)
    VALUES ('delete', old.id, old.title, old.summary, old.text, old.tags_json);
    INSERT INTO notes_fts(rowid, title, summary, text, tags_json)
    VALUES (new.id, new.title, new.summary, new.text, new.tags_json);
END;

INSERT INTO notes_fts(notes_fts) VALUES ('rebuild');
