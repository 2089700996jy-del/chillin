-- 多图接入：pending 暂存位从「一张图」扩成「一批图」
-- media_url 仍保留第一张，兼容旧读取路径；media_urls 存 {caption, items:[{url, fileId, mime, desc}]}
-- 只加列，不动旧行；旧行 media_urls 为 NULL，按单图处理。
ALTER TABLE bot_pending_media ADD COLUMN media_urls TEXT;
