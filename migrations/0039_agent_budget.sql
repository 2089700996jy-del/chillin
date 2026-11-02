-- Agent 单目标预算：限制工具调用次数与累计执行时长，防止一个目标无限烧模型。
-- 默认 48 次工具调用 / 30 分钟；已用值在同一目标的任务结束后累加。
ALTER TABLE agent_goals ADD COLUMN max_tool_calls INTEGER NOT NULL DEFAULT 48;
ALTER TABLE agent_goals ADD COLUMN used_tool_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_goals ADD COLUMN max_minutes INTEGER NOT NULL DEFAULT 30;
ALTER TABLE agent_goals ADD COLUMN used_ms INTEGER NOT NULL DEFAULT 0;
