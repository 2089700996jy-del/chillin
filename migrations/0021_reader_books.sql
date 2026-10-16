-- 阅读器书库云同步：TXT 正文放 R2，D1 只保存书目元数据，实现跨设备同一本书
CREATE TABLE IF NOT EXISTS reader_books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    book_key TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT DEFAULT '',
    total_chapters INTEGER NOT NULL DEFAULT 0,
    size INTEGER DEFAULT 0,
    r2_key TEXT NOT NULL,
    is_deleted INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', '+8 hours')),
    updated_at TEXT DEFAULT (datetime('now', '+8 hours')),
    UNIQUE(user_id, book_key),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reader_books_user
ON reader_books(user_id, is_deleted, updated_at DESC);
