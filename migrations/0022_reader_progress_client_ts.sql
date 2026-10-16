-- 阅读进度写入保护（P4）：记录客户端本地时间戳，服务端据此拒绝过期写入
-- 背景：进度接口原先是无条件覆盖，两台设备同时在线时，落后设备的写入会把云端进度拉回旧位置。
-- client_ts 为客户端 Date.now()（毫秒）；历史行默认 0，前端遇到 0 会退化为「位置更靠前才采纳」的老逻辑。
ALTER TABLE reader_progress ADD COLUMN client_ts INTEGER DEFAULT 0;
