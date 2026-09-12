-- 0014_prompts.sql
-- 创建 AI 提示词库表
CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '通用',
    scene TEXT NOT NULL DEFAULT '开发',
    content TEXT NOT NULL,
    description TEXT,
    tags TEXT,
    is_pinned INTEGER DEFAULT 0,
    is_deleted INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', '+8 hours')),
    updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_prompts_user ON prompts(user_id);
CREATE INDEX IF NOT EXISTS idx_prompts_project ON prompts(user_id, project);
CREATE INDEX IF NOT EXISTS idx_prompts_scene ON prompts(user_id, scene);
CREATE INDEX IF NOT EXISTS idx_prompts_updated ON prompts(updated_at);
