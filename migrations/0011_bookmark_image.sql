-- 给 bookmarks 表添加 image 封面图列（已有时忽略）
ALTER TABLE bookmarks ADD COLUMN image TEXT;

CREATE INDEX IF NOT EXISTS idx_bookmarks_url ON bookmarks(url);
