-- 0018_audit_log_index.sql
-- 审计日志增加保留策略（默认 180 天，由 workers/src/audit.js 的 cleanupAuditLogs 执行）后，
-- 按 created_at 删除需要索引；ugc_quarantine 在 0010 已有同类索引，这里补齐 audit_log。
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
