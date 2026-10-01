-- 0016_shared_rate_limits.sql
-- 限流从「isolate 内存桶」升级为跨实例共享计数：每个 (bucket_key, window_start) 一行，
-- 由 workers/src/security.js 的 checkRateLimitShared() 原子自增，定时任务负责清理过期行。
CREATE TABLE IF NOT EXISTS rate_limits (
    bucket_key TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket_key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start ON rate_limits(window_start);
