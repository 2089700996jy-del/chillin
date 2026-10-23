-- 联网检索缓存（v2.5.143）：同一句话问第二遍直接回缓存，省上游额度、也更快。
-- 只存「合成好的回复文本」，6 小时过期；每人一句一份（user_id + query_key 唯一）。
-- 过期行在下次检索时顺手软删（表很小，不做单独 cron）；命中后 UPSERT 复活同一行。
-- 本表不进前端同步通道（不在 garden-shared 的 OWNED_TABLES 里）。
CREATE TABLE IF NOT EXISTS bot_web_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    query_key TEXT NOT NULL DEFAULT '',
    query TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL DEFAULT '',
    expires_at_ms INTEGER NOT NULL DEFAULT 0,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', '+8 hours')),
    updated_at TEXT DEFAULT (datetime('now', '+8 hours')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_web_cache_key ON bot_web_cache(user_id, query_key);
CREATE INDEX IF NOT EXISTS idx_bot_web_cache_user ON bot_web_cache(user_id, is_deleted, id DESC);
