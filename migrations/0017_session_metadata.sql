-- 0017_session_metadata.sql
-- 会话元数据：滑动续期需要 last_seen_at，设备列表需要创建时间 / UA / IP。
ALTER TABLE sessions ADD COLUMN created_at INTEGER;
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
ALTER TABLE sessions ADD COLUMN ip TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
