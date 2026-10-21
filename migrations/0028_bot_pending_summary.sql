-- 待存位补一列卡片元数据（v2.5.132）：小宇宙链接速览把 {title, description, cover,
-- platform, icon} 暂存成 JSON，用户回「记录」时才原样写进 quick_feeds.summary，
-- 前端 public/js/feeds.js 据此渲染富链接卡片。图片消息这一列为 NULL。
-- 注意：bot_pending_media 不在 garden-shared.js 的 OWNED_TABLES 里，不进前端同步通道。
ALTER TABLE bot_pending_media ADD COLUMN summary TEXT;
