-- Reader reading progress cloud synchronization
CREATE TABLE IF NOT EXISTS reader_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    book_key TEXT NOT NULL,
    book_title TEXT NOT NULL,
    chapter_index INTEGER NOT NULL DEFAULT 0,
    chapter_title TEXT DEFAULT '',
    scroll_percentage INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, book_key)
);

CREATE INDEX IF NOT EXISTS idx_reader_progress_user ON reader_progress(user_id, updated_at);
