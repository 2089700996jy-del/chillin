-- 0031_quick_feeds_cst_default.sql
-- quick_feeds.created_at 的列默认值自 0006 起是 SQLite 的 datetime('now')（UTC），
-- 与全库东八区约定（updated_at 与其余新表都用 datetime('now', '+8 hours')）不一致。
-- 所有写入路径其实都已显式传 created_at（workers/src/garden-resources.js 与 garden-sync.js），
-- 默认值只是没人用过的兜底；一旦兜底生效就会写进一条 UTC 时间，热力图与回响的时间窗随之错位。
-- SQLite 不能 ALTER 列默认值，只能按官方 12 步法的子集重建表：
-- 建同构新表 -> 逐行搬迁（created_at 为空的历史行退回 updated_at，绝不 +8）-> 删旧表 -> 改名 -> 重建索引。
-- 重放安全：搬迁只按列名复制、不做任何时间加减，第二次执行结果不变。

CREATE TABLE IF NOT EXISTS quick_feeds_cst (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    media_url TEXT,
    summary TEXT,
    tags TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
    updated_at TEXT,
    is_deleted INTEGER DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

INSERT INTO quick_feeds_cst (id, user_id, content, type, media_url, summary, tags, created_at, updated_at, is_deleted)
SELECT id, user_id, content, type, media_url, summary, tags,
       COALESCE(created_at, updated_at, datetime('now', '+8 hours')),
       updated_at, IFNULL(is_deleted, 0)
FROM quick_feeds;

DROP TABLE quick_feeds;

ALTER TABLE quick_feeds_cst RENAME TO quick_feeds;

CREATE INDEX IF NOT EXISTS idx_quick_feeds_user_id ON quick_feeds(user_id);

CREATE INDEX IF NOT EXISTS idx_quick_feeds_updated_at ON quick_feeds(updated_at);

CREATE INDEX IF NOT EXISTS idx_quick_feeds_is_deleted ON quick_feeds(is_deleted);
