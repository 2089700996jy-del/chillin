-- Bot 最近一次入站消息的 context_token：主动发送/审批发送时回传，避免 sendmessage 返回 prepare failed。
ALTER TABLE bot_claw_accounts ADD COLUMN last_context_token TEXT DEFAULT '';
