CREATE TABLE attachments_without_r2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    owner_telegram_id INTEGER NOT NULL,
    telegram_file_id TEXT,
    telegram_file_unique_id TEXT,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes INTEGER,
    width INTEGER,
    height INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO attachments_without_r2 (
    id, note_id, owner_telegram_id, telegram_file_id, telegram_file_unique_id,
    file_name, mime_type, size_bytes, width, height, created_at
)
SELECT
    id, note_id, owner_telegram_id, telegram_file_id, telegram_file_unique_id,
    file_name, mime_type, size_bytes, width, height, created_at
FROM attachments;

DROP TABLE attachments;
ALTER TABLE attachments_without_r2 RENAME TO attachments;

CREATE INDEX idx_attachments_note ON attachments(note_id);
CREATE INDEX idx_attachments_owner ON attachments(owner_telegram_id, id);
