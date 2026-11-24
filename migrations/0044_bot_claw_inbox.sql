-- 微信 ClawBot 入站消息队列：解耦长轮询拉取与大模型回复处理，防止后台失败丢消息与并发时序混乱
CREATE TABLE IF NOT EXISTS bot_claw_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    dedup_key TEXT NOT NULL UNIQUE,
    msg_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    last_error TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', '+8 hours')),
    updated_at TEXT DEFAULT (datetime('now', '+8 hours')),
    FOREIGN KEY(account_id) REFERENCES bot_claw_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bot_claw_inbox_user_status
ON bot_claw_inbox(user_id, status, id ASC);
