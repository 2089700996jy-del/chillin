-- 统一 created_at 时区基准为东八区（CST），与 updated_at 及客户端 toUpdatedTs 保持一致。
--
-- 背景：weeklies / notes / bookmarks 的 created_at 建表默认值是 datetime('now')（UTC），
-- 而代码写入 updated_at 用的是 datetime('now', '+8 hours')（CST）。凡「插入时没显式赋值
-- created_at」的路径（API 直建，如 POST /api/weeklies）都会落成 UTC，与 updated_at 差 8 小时。
-- 受影响的消费方：热力图、周月回顾窗口、RAG 日期打分（都会把凌晨 0–8 点的记录算到前一天 / 前一窗口）。
--
-- 但**不能盲移整表**。远端迁移前实测（2026-10-18，21 行）：
--   weeklies  13 行：11 行 created_at == updated_at（本就 CST），2 行恰好早 8 小时（UTC 默认值）
--   notes      5 行：5 行 created_at == updated_at
--   bookmarks  3 行：3 行 created_at == updated_at
-- 原因是 sync/batch 推送路径的历史版本曾显式写 created_at，这些行已经是 CST。
-- 无脑 +8 会把它们改错（反而变成比真实时间早 8 小时之外的错误值）。
--
-- 因此只平移「created_at 恰好比 updated_at 早 8 小时」的行——这正是 UTC 默认值的指纹
-- （updated_at 一直是显式 CST）。已 CST 的行 created_at == updated_at，不会命中。
-- 已知代价：若某行恰好是在创建后整整 8 小时被编辑过一次，也会命中（概率极低，且只前进 8 小时）。
--
-- 前置核对（迁移前人工确认，应只列出 truly-UTC 的行，并记下 id 供回滚用）：
--   SELECT id, date, created_at, updated_at FROM weeklies
--     WHERE created_at = datetime(updated_at, '-8 hours');
--
-- 注意：本迁移只修存量数据。要让新写入不再落 UTC，必须同时部署「显式写 created_at」的代码
-- （workers/src/garden-sync.js、garden-resources.js）。两者缺一不可。
--
-- D1 迁移按文件名只执行一次；WHERE 条件让它天然幂等——平移后 created_at == updated_at，重跑不再命中。

UPDATE weeklies SET created_at = datetime(created_at, '+8 hours')
  WHERE created_at IS NOT NULL AND created_at = datetime(updated_at, '-8 hours');
UPDATE notes SET created_at = datetime(created_at, '+8 hours')
  WHERE created_at IS NOT NULL AND created_at = datetime(updated_at, '-8 hours');
UPDATE bookmarks SET created_at = datetime(created_at, '+8 hours')
  WHERE created_at IS NOT NULL AND created_at = datetime(updated_at, '-8 hours');
