-- 长期记忆：候选索引 + FTS5 全文索引（v2.5.184）
--
-- 目标：RAG 不再只取最近 60/100 条，而是先在全部历史里召回候选，再做排序与上下文整理。
-- FTS5 使用 trigram 分词，支持中文 3 字以上子串；2 字词由 rag.js 的 LIKE 兜底。
-- 索引由触发器跟随五类内容表的增删改（含软删）维护；迁移时回填已有内容。
-- 说明：memory_fts 是 FTS5 虚表，source_type/source_id 只做定位，不参与全文打分。

CREATE INDEX IF NOT EXISTS idx_notes_user_live_updated
ON notes(user_id, is_deleted, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_weeklies_user_live_updated
ON weeklies(user_id, is_deleted, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user_live_updated
ON bookmarks(user_id, is_deleted, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_quick_feeds_user_live_updated
ON quick_feeds(user_id, is_deleted, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_prompts_user_live_updated
ON prompts(user_id, is_deleted, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    user_id UNINDEXED,
    source_type UNINDEXED,
    source_id UNINDEXED,
    title,
    body,
    tags,
    tokenize = 'trigram'
);

-- 回填已有内容（只回填未软删的行）
INSERT INTO memory_fts (user_id, source_type, source_id, title, body, tags)
SELECT COALESCE(user_id, 1), '随手记', id, '',
       COALESCE(content, '') || ' ' || COALESCE(summary, ''),
       COALESCE(tags, '')
FROM quick_feeds
WHERE COALESCE(is_deleted, 0) = 0;

INSERT INTO memory_fts (user_id, source_type, source_id, title, body, tags)
SELECT COALESCE(user_id, 1), '笔记', id, COALESCE(title, ''),
       COALESCE(content, ''), ''
FROM notes
WHERE COALESCE(is_deleted, 0) = 0;

INSERT INTO memory_fts (user_id, source_type, source_id, title, body, tags)
SELECT COALESCE(user_id, 1), '周记', id, COALESCE(title, ''),
       COALESCE(summary, '') || ' ' || COALESCE(content, ''), ''
FROM weeklies
WHERE COALESCE(is_deleted, 0) = 0;

INSERT INTO memory_fts (user_id, source_type, source_id, title, body, tags)
SELECT COALESCE(user_id, 1), '收藏', id, COALESCE(title, ''),
       COALESCE(description, '') || ' ' || COALESCE(url, ''), ''
FROM bookmarks
WHERE COALESCE(is_deleted, 0) = 0;

INSERT INTO memory_fts (user_id, source_type, source_id, title, body, tags)
SELECT COALESCE(user_id, 1), '提示词', id,
       COALESCE(project, '') || ' ' || COALESCE(scene, '') || ' ' || COALESCE(title, ''),
       COALESCE(description, '') || ' ' || COALESCE(content, ''),
       COALESCE(tags, '')
FROM prompts
WHERE COALESCE(is_deleted, 0) = 0;

-- 随手记
CREATE TRIGGER IF NOT EXISTS trg_memory_fts_quick_feeds_ai
AFTER INSERT ON quick_feeds
WHEN COALESCE(new.is_deleted, 0) = 0
BEGIN
    INSERT INTO memory_fts (user_id, source_type, source_id, title, body, tags)
    VALUES (COALESCE(new.user_id, 1), '随手记', new.id, '',
            COALESCE(new.content, '') || ' ' || COALESCE(new.summary, ''),
            COALESCE(new.tags, ''));
END;
CREATE TRIGGER IF NOT EXISTS trg_memory_fts_quick_feeds_au
AFTER UPDATE ON quick_feeds
BEGIN
    DELETE FROM memory_fts WHERE source_type = '随手记' AND source_id = old.id;
    INSERT INTO memory_fts (user_id, source_type, source_id, title, body, tags)
    SELECT COALESCE(new.user_id, 1), '随手记', new.id, '',
           COALESCE(new.content, '') || ' ' || COALESCE(new.summary, ''),
           COALESCE(new.tags, '')
    WHERE COALESCE(new.is_deleted, 0) = 0;
END;
CREATE TRIGGER IF NOT EXISTS trg_memory_fts_quick_feeds_ad
AFTER DELETE ON quick_feeds
BEGIN
    DELETE FROM memory_fts WHERE source_type = '随手记' AND source_id = old.id;
END;

-- 笔记
CREATE TRIGGER IF NOT EXISTS trg_memory_fts_notes_ai
AFTER INSERT ON notes
WHEN COALESCE(new.is_deleted, 0) = 0
BEGIN
    INSERT INTO memory_fts (user_id, source_type, source_id, title, body, tags)
    VALUES (COALESCE(new.user_id, 1), '笔记', new.id, COALESCE(new.title, ''),
            COALESCE(new.content, ''), '');
END;
CREATE TRIGGER IF NOT EXISTS trg_memory_fts_notes_au
AFTER UPDATE ON notes
BEGIN
    DELETE FROM memory_fts WHERE source_type = '笔记' AND source_id = old.id;
    INSERT INTO memory_fts (user_id, source_type, source_id, title, body, tags)
    SELECT COALESCE(new.user_id, 1), '笔记', new.id, COALESCE(new.title, ''),
           COALESCE(new.content, ''), ''
    WHERE COALESCE(new.is_deleted, 0) = 0;
END;
CREATE TRIGGER IF NOT EXISTS trg_memory_fts_notes_ad
AFTER DELETE ON notes
BEGIN
    DELETE FROM memory_fts WHERE source_type = '笔记' AND source_id = old.id;
END;

-- 周记
CREATE TRIGGER IF NOT EXISTS trg_memory_fts_weeklies_ai
AFTER INSERT ON weeklies
WHEN COALESCE(new.is_deleted, 0) = 0
BEGIN
    INSERT INTO memory_fts (user_id, source_type, source_id, title, body, tags)
    VALUES (COALESCE(new.user_id, 1), '周记', new.id, COALESCE(new.title, ''),
            COALESCE(new.summary, '') || ' ' || COALESCE(new.content, ''), '');
END;
CREATE TRIGGER IF NOT EXISTS trg_memory_fts_weeklies_au
AFTER UPDATE ON weeklies
BEGIN
    DELETE FROM memory_fts WHERE source_type = '周记' AND source_id = old.id;
    INSERT INTO memory_fts (user_id, source_type, source_id, title, body, tags)
    SELECT COALESCE(new.user_id, 1), '周记', new.id, COALESCE(new.title, ''),
           COALESCE(new.summary, '') || ' ' || COALESCE(new.content, ''), ''
    WHERE COALESCE(new.is_deleted, 0) = 0;
END;
CREATE TRIGGER IF NOT EXISTS trg_memory_fts_weeklies_ad
AFTER DELETE ON weeklies
BEGIN
    DELETE FROM memory_fts WHERE source_type = '周记' AND source_id = old.id;
END;

-- 收藏
CREATE TRIGGER IF NOT EXISTS trg_memory_fts_bookmarks_ai
AFTER INSERT ON bookmarks
WHEN COALESCE(new.is_deleted, 0) = 0
BEGIN
    INSERT INTO memory_fts (user_id, source_type, source_id, title, body, tags)
    VALUES (COALESCE(new.user_id, 1), '收藏', new.id, COALESCE(new.title, ''),
            COALESCE(new.description, '') || ' ' || COALESCE(new.url, ''), '');
END;
CREATE TRIGGER IF NOT EXISTS trg_memory_fts_bookmarks_au
AFTER UPDATE ON bookmarks
BEGIN
    DELETE FROM memory_fts WHERE source_type = '收藏' AND source_id = old.id;
    INSERT INTO memory_fts (user_id, source_type, source_id, title, body, tags)
    SELECT COALESCE(new.user_id, 1), '收藏', new.id, COALESCE(new.title, ''),
           COALESCE(new.description, '') || ' ' || COALESCE(new.url, ''), ''
    WHERE COALESCE(new.is_deleted, 0) = 0;
END;
CREATE TRIGGER IF NOT EXISTS trg_memory_fts_bookmarks_ad
AFTER DELETE ON bookmarks
BEGIN
    DELETE FROM memory_fts WHERE source_type = '收藏' AND source_id = old.id;
END;

-- 提示词
CREATE TRIGGER IF NOT EXISTS trg_memory_fts_prompts_ai
AFTER INSERT ON prompts
WHEN COALESCE(new.is_deleted, 0) = 0
BEGIN
    INSERT INTO memory_fts (user_id, source_type, source_id, title, body, tags)
    VALUES (COALESCE(new.user_id, 1), '提示词', new.id,
            COALESCE(new.project, '') || ' ' || COALESCE(new.scene, '') || ' ' || COALESCE(new.title, ''),
            COALESCE(new.description, '') || ' ' || COALESCE(new.content, ''),
            COALESCE(new.tags, ''));
END;
CREATE TRIGGER IF NOT EXISTS trg_memory_fts_prompts_au
AFTER UPDATE ON prompts
BEGIN
    DELETE FROM memory_fts WHERE source_type = '提示词' AND source_id = old.id;
    INSERT INTO memory_fts (user_id, source_type, source_id, title, body, tags)
    SELECT COALESCE(new.user_id, 1), '提示词', new.id,
           COALESCE(new.project, '') || ' ' || COALESCE(new.scene, '') || ' ' || COALESCE(new.title, ''),
           COALESCE(new.description, '') || ' ' || COALESCE(new.content, ''),
           COALESCE(new.tags, '')
    WHERE COALESCE(new.is_deleted, 0) = 0;
END;
CREATE TRIGGER IF NOT EXISTS trg_memory_fts_prompts_ad
AFTER DELETE ON prompts
BEGIN
    DELETE FROM memory_fts WHERE source_type = '提示词' AND source_id = old.id;
END;
