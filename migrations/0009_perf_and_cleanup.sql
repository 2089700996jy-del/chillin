-- 数据库索引与性能优化

-- 1. 为经常按 user_id 查询的表添加 B-Tree 索引
CREATE INDEX IF NOT EXISTS idx_weeklies_user_id ON weeklies(user_id);
CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user_id ON bookmarks(user_id);
CREATE INDEX IF NOT EXISTS idx_quick_feeds_user_id ON quick_feeds(user_id);
CREATE INDEX IF NOT EXISTS idx_echo_cards_user_id ON echo_cards(user_id);

-- 2. 为 Sessions 表添加 user_id 与 expires_at 索引，加速鉴权与定时过期清理
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
