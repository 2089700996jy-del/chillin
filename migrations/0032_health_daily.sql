-- 自述健康打卡（v2.5.155，小米运动健康接入的 A 方案）：一天一行的身体数据，
-- 来源是用户自己在微信里说的一句话，而不是任何机器观测。
--
-- 为什么单独一张表，而不是写进随手记：
--   健康数据的形状天生是「一天一行」（步数 / 睡眠时长 / 中高强度分钟 / 静息心率 / 体重），
--   而随手记是一条条无结构的碎片流。混在一起会有两个后果——RAG 检索到大量「8500 步」
--   这种脱离上下文的噪声；而按天聚合（本周日均睡眠）在软删的碎片流上根本做不了。
--
-- 为什么只有这些列：AI 只负责把整句解析成结构化字段，解析不出来的部分宁可丢（并在回执里
--   说清丢了什么），也不把整句聊天正文原样沉淀进数据库。
--
-- 时间口径同全库：created_at / updated_at 一律东八区（datetime('now', '+8 hours')），
--   绝不用 CURRENT_TIMESTAMP（那是 UTC，会在夜里算错一天）。
--   date 列存东八区自然日 YYYY-MM-DD，由应用层按 +8 小时推算，不用 SQLite 的 date('now')。
--
-- source 列现在只会是 'manual'：将来若真走通小米云对云（B 方案），机器观测写 'mi_health'，
--   与自述数据同表共存、可区分；不管哪种来源都只读不写回小米。
CREATE TABLE IF NOT EXISTS health_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    steps INTEGER,
    sleep_min INTEGER,
    active_min INTEGER,
    resting_hr INTEGER,
    weight_kg REAL,
    source TEXT NOT NULL DEFAULT 'manual',
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

-- 同一人同一天只有一行：重复打卡走 UPSERT 合并，而不是插新行（也挡住并发重复投递）
CREATE UNIQUE INDEX IF NOT EXISTS idx_health_daily_user_date ON health_daily(user_id, date);
-- 最近 N 天的汇总查询（按天倒序取窗口）
CREATE INDEX IF NOT EXISTS idx_health_daily_user_recent ON health_daily(user_id, is_deleted, date DESC);
