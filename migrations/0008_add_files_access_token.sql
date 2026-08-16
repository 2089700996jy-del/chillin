-- 文件访问令牌：上传时生成随机访问令牌，读取时需携带匹配的 ?t= 校验，防止 UUID 直链外泄
ALTER TABLE files ADD COLUMN access_token TEXT;
