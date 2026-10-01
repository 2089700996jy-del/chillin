-- 0015_session_token_hardening.sql
-- 会话令牌改为 SHA-256 哈希落库（由 workers/src/auth.js 写入，无需改动表结构）；
-- 旧版明文会话会在首次鉴权时透明升级为哈希行。
-- 这里补充 user_id 索引，供「全部退出」（logout-all）与定时过期清理使用。
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
