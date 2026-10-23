-- 定点提醒（v2.5.143）：用户开口授权的一次性提醒。
-- 为什么必须独立成表：「未来的某个时刻」无法从任何已有表推导——bot_outreach 是系统自己
-- 挑的时刻，bot_chat_turns 是已经说过的话。提醒 = 一行文本 + 一个时刻 + 三态。
-- 与 bot_outreach 的边界（设计上刻意不共用一张表）：那张表是「系统想说话」，每天至多一次、
-- 限 10:00–22:30、距上次说话 ≥30 分钟、0.65 概率闸门；这张表是「用户叫我说话」，到点就得说，
-- 不受日限/时窗/静默期约束。被授权的打扰与自主打扰是两种东西，否则用户一句「别主动找我」
-- 会把他的提醒一起关掉。
-- 状态机：pending --到点--> fired --30 分钟--> 追问一次 --> done（用户回「完成」）
--         pending --超过 2 小时没送出去--> missed（不补发：凌晨补一句「该充电了」是伤害不是服务）
--         pending --「取消提醒 N」--> cancelled + is_deleted=1
-- 时间口径：fire_at_ms / follow_up_at_ms / fired_at_ms 都是 epoch 毫秒，直接比较、不受时区影响；
-- 展示文本与 created_at 走东八区（与项目其它表一致）。
-- 只软删：取消也不物理删除，行留着做审计。本表不进前端同步通道（不在 garden-shared 的 OWNED_TABLES 里）。
CREATE TABLE IF NOT EXISTS bot_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL DEFAULT '',
    fire_at_ms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    follow_up_at_ms INTEGER NOT NULL DEFAULT 0,
    follow_up_sent INTEGER NOT NULL DEFAULT 0,
    fired_at_ms INTEGER NOT NULL DEFAULT 0,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', '+8 hours')),
    updated_at TEXT DEFAULT (datetime('now', '+8 hours')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bot_reminders_due ON bot_reminders(is_deleted, status, fire_at_ms);
CREATE INDEX IF NOT EXISTS idx_bot_reminders_user ON bot_reminders(user_id, is_deleted, id DESC);
