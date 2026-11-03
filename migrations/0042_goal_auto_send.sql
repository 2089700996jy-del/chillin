-- 目标级 Bot 自动发送授权：用户创建目标时默认开启（1），完成后自动创建并同意一次发送审批；亦可显式关闭（0）。
ALTER TABLE agent_goals ADD COLUMN auto_send INTEGER NOT NULL DEFAULT 1;
