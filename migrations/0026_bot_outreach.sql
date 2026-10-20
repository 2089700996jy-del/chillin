-- 0026_bot_outreach.sql
-- Bot 主动关怀：账号级开关 + 每次开口的审计。
--
-- 为什么要有这张表：
--   1. bot_claw_accounts 只描述「绑定关系」，没有地方记录「它主动说过什么」。
--      主动开口必须可回溯（依据哪条旧记录、什么时候、成功与否），否则既回答不了
--      「你凭什么突然想起这件事」，也没法做每日节流。
--   2. 主动关怀必须可关：outreach_enabled 默认 1（绑定即开启），微信里一句
--      「别主动找我」或应用内开关都能立刻关掉。
--
-- 约定：时间一律东八区（与全库一致，见 0023_created_at_cst.sql）；只软删，
--       用户数据永不物理删除；ref_type/ref_id 指向被引用的花园记录。

ALTER TABLE bot_claw_accounts ADD COLUMN outreach_enabled INTEGER DEFAULT 1;

CREATE TABLE IF NOT EXISTS bot_outreach (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    account_id INTEGER,
    status TEXT DEFAULT 'sent',
    ref_type TEXT DEFAULT '',
    ref_id TEXT DEFAULT '',
    text TEXT DEFAULT '',
    reason TEXT DEFAULT '',
    is_deleted INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', '+8 hours')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bot_outreach_user ON bot_outreach(user_id, is_deleted, id DESC);
