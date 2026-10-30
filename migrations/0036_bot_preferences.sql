-- 0036：Bot 交流偏好（独立于「关于我」事实档案）
-- 只影响表达方式，不把偏好当事实；所有删除一律软删。
CREATE TABLE IF NOT EXISTS bot_preferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    pref_key TEXT NOT NULL,
    label TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'user',
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_bot_preferences_user
ON bot_preferences(user_id, is_deleted, id);
