-- 待存图片暂存位（v2.5.128）：微信发来的图片先只描述、不写进随手记，
-- 等用户在 1 小时内回「记录」确认，才落成带图随手记。每人只保留最新一张。
-- 这张表不进前端同步通道（不在 garden-shared 的 OWNED_TABLES 里），所以不需要同步索引。
-- 写入一律软删（is_deleted），用户数据永不物理删除。
CREATE TABLE IF NOT EXISTS bot_pending_media (
    user_id INTEGER PRIMARY KEY,
    media_url TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', '+8 hours')),
    is_deleted INTEGER DEFAULT 0
);
