-- Chillin self-hosted file storage
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    mime_type TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
