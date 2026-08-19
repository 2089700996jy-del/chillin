-- 补齐 bookmarks / feeds 的 updated_at；正式纳入推送订阅表

ALTER TABLE bookmarks ADD COLUMN updated_at TEXT;
ALTER TABLE quick_feeds ADD COLUMN updated_at TEXT;

UPDATE bookmarks SET updated_at = COALESCE(updated_at, created_at, datetime('now')) WHERE updated_at IS NULL;
UPDATE quick_feeds SET updated_at = COALESCE(updated_at, created_at, datetime('now')) WHERE updated_at IS NULL;

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_updated_at ON bookmarks(updated_at);
CREATE INDEX IF NOT EXISTS idx_quick_feeds_updated_at ON quick_feeds(updated_at);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
