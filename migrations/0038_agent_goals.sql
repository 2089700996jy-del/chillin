-- 0038：Agent 目标与任务系统
-- 目标（goal）保存用户想持续完成的事；任务（task）是计划中的可执行单元；
-- 每次执行（run）按依赖顺序推进任务，步骤（step）记录真实执行结果；
-- 审批（approval）只用于有副作用的动作（如把结果保存为笔记草稿）。
-- 所有业务查询必须带 user_id，目标删除走 is_deleted。

CREATE TABLE IF NOT EXISTS agent_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    plan_version INTEGER NOT NULL DEFAULT 0,
    result_md TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    last_run_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
    completed_at TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agent_goals_user
ON agent_goals(user_id, is_deleted, status, updated_at);

CREATE TABLE IF NOT EXISTS agent_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    task_type TEXT NOT NULL DEFAULT 'analysis',
    depends_on TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    output_md TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
    UNIQUE(goal_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_goal
ON agent_tasks(goal_id, status, seq);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_user
ON agent_tasks(user_id, status);

CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    trigger TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'queued',
    current_task_id INTEGER,
    lease_until TEXT,
    next_run_at TEXT,
    error TEXT NOT NULL DEFAULT '',
    result_md TEXT NOT NULL DEFAULT '',
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_goal
ON agent_runs(goal_id, status, id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_user
ON agent_runs(user_id, status);

CREATE TABLE IF NOT EXISTS agent_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    goal_id INTEGER NOT NULL,
    task_id INTEGER,
    user_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    step_type TEXT NOT NULL DEFAULT 'task',
    status TEXT NOT NULL DEFAULT 'running',
    tool_name TEXT NOT NULL DEFAULT '',
    input_json TEXT NOT NULL DEFAULT '{}',
    output_json TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
    UNIQUE(run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_agent_steps_run
ON agent_steps(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_agent_steps_user
ON agent_steps(user_id, goal_id);

CREATE TABLE IF NOT EXISTS agent_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL,
    run_id INTEGER,
    task_id INTEGER,
    user_id INTEGER NOT NULL,
    action_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payload_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT NOT NULL DEFAULT '{}',
    decision_note TEXT NOT NULL DEFAULT '',
    requested_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
    decided_at TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_agent_approvals_goal
ON agent_approvals(goal_id, status, id);
CREATE INDEX IF NOT EXISTS idx_agent_approvals_user
ON agent_approvals(user_id, status, id);

-- 同一目标同时只允许一个待审批的“保存笔记”请求，避免并发点击生成两条草稿。
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_approvals_pending_save
ON agent_approvals(goal_id) WHERE action_type = 'save_note' AND status = 'pending';
