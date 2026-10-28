-- 提醒追问状态机（v2.5.168）：把「问过一次没有」升级成可重试、可观察的状态。
-- 旧实现先写 follow_up_sent=1 再读账号/发送：账号读取或网络一失败，这次追问就永久丢了。
-- 新状态：pending（待发/退避中） -> sending（已 claim，带 5 分钟租约） -> sent | pending（重试） | failed（次数耗尽）
--        fired --用户回「还没」--> skipped（不再追问，但仍可回「完成」）
-- 列口径：follow_up_at_ms 是首次计划时刻；follow_up_retry_at_ms 是下一次真正尝试时刻；
--        follow_up_ms 是每条任务自己的追问间隔（普通 10 分钟，充电等慢任务 2 小时）。
ALTER TABLE bot_reminders ADD COLUMN follow_up_ms INTEGER NOT NULL DEFAULT 600000;
ALTER TABLE bot_reminders ADD COLUMN follow_up_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE bot_reminders ADD COLUMN follow_up_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_reminders ADD COLUMN follow_up_retry_at_ms INTEGER NOT NULL DEFAULT 0;

-- 把旧行接进新状态机：问过的是 sent，没问过的回到 pending。
UPDATE bot_reminders
SET follow_up_status = CASE
    WHEN status = 'fired' AND follow_up_sent = 1 THEN 'sent'
    WHEN status = 'fired' AND follow_up_sent = 0 AND follow_up_at_ms > 0 THEN 'pending'
    ELSE 'none'
END;

-- 旧行原本按 30 分钟排期；统一回到 10 分钟基准，已经过期的下一分钟就会尝试。
UPDATE bot_reminders
SET follow_up_at_ms = CASE
    WHEN status = 'fired' AND follow_up_sent = 0 AND fired_at_ms > 0
        THEN fired_at_ms + 600000
    ELSE follow_up_at_ms
END;

UPDATE bot_reminders
SET follow_up_retry_at_ms = CASE
    WHEN follow_up_status = 'pending' THEN follow_up_at_ms
    ELSE 0
END;

CREATE INDEX IF NOT EXISTS idx_bot_reminders_follow_up
    ON bot_reminders(is_deleted, status, follow_up_status, follow_up_retry_at_ms);
