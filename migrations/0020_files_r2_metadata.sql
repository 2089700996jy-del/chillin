-- 图片二进制迁往 R2 对象存储：files 表退化为纯元数据表
-- 1) data 列改为可空：已迁移到 R2 的行不再保留 D1 BLOB（未迁移的历史行仍可读）
-- 2) 新增 r2_key（对象键）与 size（字节数）
-- SQLite 不支持修改列约束，这里按「建新表 → 搬数据 → 换名」的标准做法重建
CREATE TABLE IF NOT EXISTS files_r2 (
    id TEXT PRIMARY KEY,
    mime_type TEXT NOT NULL,
    data BLOB,
    access_token TEXT,
    user_id INTEGER,
    r2_key TEXT,
    size INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO files_r2 (id, mime_type, data, access_token, user_id, created_at)
    SELECT id, mime_type, data, access_token, user_id, created_at FROM files;

DROP TABLE files;
ALTER TABLE files_r2 RENAME TO files;

-- 重建用户维度索引（DROP TABLE 会一并删掉原索引）
CREATE INDEX IF NOT EXISTS idx_files_user_id ON files(user_id);
-- 迁移脚本按「r2_key 为空」筛选待搬运行，索引让这个筛选走索引
CREATE INDEX IF NOT EXISTS idx_files_r2_key ON files(r2_key);
