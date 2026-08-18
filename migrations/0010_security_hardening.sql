-- 安全加固：文件归属 + UGC 隔离区（软删可恢复）

-- 文件归属用户（历史行允许为 NULL，读取时收紧策略）
ALTER TABLE files ADD COLUMN user_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_files_user_id ON files(user_id);

-- UGC 违规隔离：先归档完整记录再从业务表删除，避免 Cron 误杀不可恢复
CREATE TABLE IF NOT EXISTS ugc_quarantine (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    user_id INTEGER,
    payload TEXT NOT NULL,
    snippet TEXT,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ugc_quarantine_created ON ugc_quarantine(created_at);
CREATE INDEX IF NOT EXISTS idx_ugc_quarantine_user ON ugc_quarantine(user_id);
