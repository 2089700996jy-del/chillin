-- 图片访问令牌加过期时间
-- 令牌仍是「持有即可读」的 capability（URL 里带 ?t=），但不再永久有效：
-- 过期后只有文件所有者本人登录才能读取，泄露出去的旧链接会自然失效。
-- 为什么不改成 HMAC 签名 URL：每次读图本来就要查 D1 拿 mime/r2_key，
-- 无状态签名省不掉这次查询，反而要多管一个密钥与时钟偏移。

ALTER TABLE files ADD COLUMN token_expires_at INTEGER;

-- 历史令牌给 180 天过渡期，避免存量笔记/周记里的图片在升级后立刻裂开。
-- 迁移只跑一次，之后新上传的令牌由应用层写入 30 天有效期。
UPDATE files
SET token_expires_at = (strftime('%s', 'now') + 180 * 86400) * 1000
WHERE access_token IS NOT NULL
  AND access_token != ''
  AND token_expires_at IS NULL;
