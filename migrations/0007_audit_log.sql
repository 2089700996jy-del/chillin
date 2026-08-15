-- UGC 合规审计日志表
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    snippet TEXT,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
