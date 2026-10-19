-- 微信 ClawBot（官方 iLink 协议）账号绑定：让 Worker 自己当 ClawBot 后端，不需要 OpenClaw/常驻机器
-- 一行 = 一个 Chillin 用户绑定的一个微信 ClawBot 身份。
--   bot_token 只在服务端用于长轮询与回复，任何 API 响应都不返回；
--   cursor 是 getupdates 的长轮询游标，必须持久化，否则同一批消息会被反复拉取；
--   bound_at_ms 记录绑定时刻（客户端毫秒），用于丢弃绑定前积压的旧消息，避免重放写入花园。
CREATE TABLE IF NOT EXISTS bot_claw_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    qrcode TEXT DEFAULT '',
    qr_expires_at TEXT,
    bot_token TEXT DEFAULT '',
    baseurl TEXT DEFAULT 'https://ilinkai.weixin.qq.com',
    ilink_bot_id TEXT DEFAULT '',
    ilink_user_id TEXT DEFAULT '',
    cursor TEXT DEFAULT '',
    bound_at_ms INTEGER DEFAULT 0,
    last_poll_at TEXT,
    last_error TEXT DEFAULT '',
    is_deleted INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', '+8 hours')),
    updated_at TEXT DEFAULT (datetime('now', '+8 hours')),
    UNIQUE(user_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bot_claw_accounts_user
ON bot_claw_accounts(user_id, is_deleted, id DESC);

CREATE INDEX IF NOT EXISTS idx_bot_claw_accounts_bound
ON bot_claw_accounts(status, is_deleted);
