ALTER TABLE notes ADD COLUMN external_provider TEXT;
ALTER TABLE notes ADD COLUMN external_kind TEXT;
ALTER TABLE notes ADD COLUMN external_id TEXT;
ALTER TABLE notes ADD COLUMN vector_status TEXT NOT NULL DEFAULT 'not_indexed';
ALTER TABLE notes ADD COLUMN vector_content_hash TEXT;
ALTER TABLE notes ADD COLUMN vector_indexed_at TEXT;

CREATE UNIQUE INDEX idx_notes_owner_external
    ON notes(owner_telegram_id, external_provider, external_kind, external_id)
    WHERE external_provider IS NOT NULL
      AND external_kind IS NOT NULL
      AND external_id IS NOT NULL;

CREATE INDEX idx_notes_owner_vector_status
    ON notes(owner_telegram_id, vector_status, id);

ALTER TABLE conversation_state ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(payload_json));

-- Служебные изменения статуса вектора не должны зря перестраивать FTS-запись.
DROP TRIGGER IF EXISTS notes_fts_update;
CREATE TRIGGER notes_fts_update AFTER UPDATE OF title, summary, text, tags_json ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, summary, text, tags_json)
    VALUES ('delete', old.id, old.title, old.summary, old.text, old.tags_json);
    INSERT INTO notes_fts(rowid, title, summary, text, tags_json)
    VALUES (new.id, new.title, new.summary, new.text, new.tags_json);
END;
