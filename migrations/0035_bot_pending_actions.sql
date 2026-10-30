-- 0035：Bot 管家的「先确认、再执行」待办动作。
-- 列表 / 编辑 / 删除收藏与提示词都先落一条 pending，用户回「确认」才真正执行；
-- 删除仍走 is_deleted = 1 的软删，不做物理删除。
CREATE TABLE IF NOT EXISTS bot_pending_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    target_table TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at_ms INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bot_pending_actions_user
ON bot_pending_actions(user_id, is_deleted, id DESC);
