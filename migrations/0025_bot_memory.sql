-- Bot 个人记忆：当前对话上下文 + 「关于我」个人档案
--
-- 三层记忆刻意分开存放，绝不合并成一张无边界的表：
--   bot_chat_turns —— 近场对话上下文（有限条数、可以被「重置对话」整体软删）；
--   bot_profile    —— 用户自述的长期事实与偏好（只能由显式指令写入，可看 / 可改 / 可遗忘）；
--   花园业务表      —— 周记/随手记等历史事实，回答时由 RAG 检索充当证据。
--
-- 写入方：workers/src/bot-memory.js（Bot 侧唯一的记忆读写入口）。
-- 用户数据一律软删（is_deleted），不做物理 DELETE。
CREATE TABLE IF NOT EXISTS bot_chat_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL DEFAULT '',
    is_deleted INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', '+8 hours')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bot_chat_turns_user
ON bot_chat_turns(user_id, is_deleted, id DESC);

CREATE TABLE IF NOT EXISTS bot_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'user',
    is_deleted INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', '+8 hours')),
    updated_at TEXT DEFAULT (datetime('now', '+8 hours')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bot_profile_user
ON bot_profile(user_id, is_deleted, id DESC);
