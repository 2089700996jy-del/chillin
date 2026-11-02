-- Push 订阅按设备去重：同一浏览器重复订阅时更新同一 device_id，避免一次事件推多条。
ALTER TABLE push_subscriptions ADD COLUMN device_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_device
ON push_subscriptions(user_id, device_id) WHERE device_id IS NOT NULL;
