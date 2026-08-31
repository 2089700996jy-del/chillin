-- Add soft delete support for incremental sync
ALTER TABLE weeklies ADD COLUMN is_deleted INTEGER DEFAULT 0;
ALTER TABLE notes ADD COLUMN is_deleted INTEGER DEFAULT 0;
ALTER TABLE bookmarks ADD COLUMN is_deleted INTEGER DEFAULT 0;
ALTER TABLE quick_feeds ADD COLUMN is_deleted INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_weeklies_updated_at ON weeklies(updated_at);
CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at);
CREATE INDEX IF NOT EXISTS idx_weeklies_is_deleted ON weeklies(is_deleted);
CREATE INDEX IF NOT EXISTS idx_notes_is_deleted ON notes(is_deleted);
CREATE INDEX IF NOT EXISTS idx_bookmarks_is_deleted ON bookmarks(is_deleted);
CREATE INDEX IF NOT EXISTS idx_quick_feeds_is_deleted ON quick_feeds(is_deleted);