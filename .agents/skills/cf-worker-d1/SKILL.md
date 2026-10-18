---
name: cf-worker-d1
description: Cloudflare Worker 边缘无服务器架构、D1 关系型数据库（SQLite）迁移、微内核领域拆分、原生 Web Crypto 安全防护与 FakeD1 单元测试指南。在开发、重构或调试 Chillin 的后端接口、数据表迁移、定时任务或边缘安全时使用。
---

# Cloudflare Worker & D1 边缘架构开发指南 (cf-worker-d1)

> 本技能为 **Chillin 数字花园** 的后端核心开发标准手册，涵盖 **Cloudflare Workers (ESM)**、**Cloudflare D1 (SQLite at the edge)**、**数据库迁移**、**FakeD1 测试套件** 与 **边缘安全防御**。

---

## 1. 核心架构红线与设计模式

### 1.1 网关 300 行绝对红线 (`workers/api.js`)
- **路由薄层（Thin Gateway）**：`workers/api.js` 的职责严格限定为：
  1. CORS 预检与跨域拦截（`withCors`）；
  2. 路由分发（RESTful 路径匹配）；
  3. 用户身份提取（`authenticate(request, db)`）；
  4. 调用 `workers/src/` 中的业务模块，并包装输出。
- **严禁内联业务逻辑**：任何 SQL 拼接、复杂数据计算、多表查询必须下沉到 `workers/src/` 子模块中。代码提交前自动化测试会扫描网关行数，超过 300 行将直接阻断流水线。

### 1.2 微内核领域模块职责分工 (`workers/src/`)
所有后端业务必须按照以下领域划分归位，单文件不得超过 500 行：

| 领域模块 | 核心职责 | 依赖与资源 |
| :--- | :--- | :--- |
| [`security.js`](../../../workers/src/security.js) | CORS、CSP、安全响应头、速率限制（Rate Limit） | Web Crypto, D1 rate_limits 表 |
| [`security-network.js`](../../../workers/src/security-network.js) | SSRF 私网 IP 拦截、二进制魔数嗅探、时序攻击防御 | 纯计算/无依赖 |
| [`auth.js`](../../../workers/src/auth.js) | PBKDF2 鉴权、Cookie Session 轮转、推送订阅入库 | D1 users / sessions / push_subscriptions |
| [`garden-resources.js`](../../../workers/src/garden-resources.js) | 周记 (Weeklies)、笔记 (Notes)、随手记 (Feeds)、书签、提示词 CRUD | D1 核心资源表 |
| [`garden-sync.js`](../../../workers/src/garden-sync.js) | 批量差异增量拉取/推送、热力图统计、备份邮件直发 | D1 事务 `db.batch()`、Resend API |
| [`garden-echo.js`](../../../workers/src/garden-echo.js) | AI 记忆回响生成、定时推送通知派发、内容合规审查 | Web Push VAPID、LLM API |
| [`garden-media.js`](../../../workers/src/garden-media.js) | 图片安全上传、外链 Microlink 代理抓取与安全兜底 | 二进制流、Microlink API |
| [`llm.js`](../../../workers/src/llm.js) | DeepSeek / Cloudflare AI 大模型通信与流式包装 | Fetch API, SSE |

---

## 2. Cloudflare D1 数据库与迁移标准

### 2.1 迁移文件命名与版本递增
所有数据库 Schema 变更必须在 [`migrations/`](../../../migrations/) 目录下创建纯 SQL 文件：
- **命名规范**：`00XX_feature_name.sql`（4 位数字前缀，严格顺序递增，如 `0020_xxx.sql`）。
- **幂等性保障**：建表必须使用 `CREATE TABLE IF NOT EXISTS`，索引必须使用 `CREATE INDEX IF NOT EXISTS`。

### 2.2 核心 Schema 规范与避坑要点
```sql
-- 示例：新增一张资源表
CREATE TABLE IF NOT EXISTS garden_capsules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    is_deleted INTEGER DEFAULT 0,                 -- 软删除墓碑标志：0=正常, 1=已删除
    created_at TEXT DEFAULT (datetime('now', '+8 hours')), -- 统一东八区时间
    updated_at TEXT DEFAULT (datetime('now', '+8 hours')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 必须建立用户隔离与软删除索引
CREATE INDEX IF NOT EXISTS idx_capsules_user_active 
ON garden_capsules(user_id, is_deleted, id DESC);
```

> [!IMPORTANT]
> **D1 / SQLite 核心避坑铁律**：
> 1. **严禁拼接 SQL 字符串**：所有动态查询必须通过参数化绑定（`?1, ?2, ?3` 或 `?`），严防 SQL 注入。
> 2. **参数类型严格转换**：数字 ID 必须先通过 `Number(id)` 转换，避免传给绑定参数的是字符串导致主键索引失效。
> 3. **统一软删除**：用户数据禁止直接 `DELETE FROM`，更新 `is_deleted = 1` 并更新 `updated_at`，确保前端增量同步能够同步下发墓碑标识。

### 2.3 Wrangler D1 常用命令速查

```bash
# 1. 本地演练执行迁移文件
npx wrangler d1 execute chillin-db --local --file=migrations/0020_xxx.sql

# 2. 远端正式执行迁移文件
npx wrangler d1 execute chillin-db --remote --file=migrations/0020_xxx.sql

# 3. 查看本地/远端表结构
npx wrangler d1 execute chillin-db --remote --command="SELECT name FROM sqlite_master WHERE type='table';"

# 4. 导出远端完整快照备份（生成 .sql.gz）
npm run backup
```

---

## 3. FakeD1 单元测试规范 (`node:sqlite`)

项目在 Node 20+ 环境下使用原生 `tests/fake-d1.mjs`，通过 `node:sqlite` 的内存数据库完美模拟 D1 的真实执行语义（包括外键约束、ON CONFLICT、datetime 函数与 RETURNING 语句）。

### 3.1 编写 D1 单元测试标准范式
```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeD1, sqliteAvailable } from './fake-d1.mjs';

test('Capsules - CRUD and soft delete lifecycle', { skip: !sqliteAvailable }, async () => {
    // 1. 初始化内存数据库并执行所有迁移
    const { DatabaseSync } = await import('node:sqlite');
    const rawDb = new DatabaseSync(':memory:');
    const db = new FakeD1(rawDb);
    
    // 执行测试所需迁移
    rawDb.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
        INSERT INTO users (id, username) VALUES (1, 'testuser');
        CREATE TABLE garden_capsules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            title TEXT,
            is_deleted INTEGER DEFAULT 0
        );
    `);

    // 2. 模拟 Worker 领域函数调用
    const inserted = await db.prepare(
        'INSERT INTO garden_capsules (user_id, title) VALUES (?1, ?2) RETURNING *'
    ).bind(1, '灵感胶囊').first();
    assert.equal(inserted.title, '灵感胶囊');

    // 3. 测试查询与软删除
    await db.prepare(
        'UPDATE garden_capsules SET is_deleted = 1 WHERE id = ?1 AND user_id = ?2'
    ).bind(inserted.id, 1).run();

    const activeList = await db.prepare(
        'SELECT * FROM garden_capsules WHERE user_id = ?1 AND is_deleted = 0'
    ).bind(1).all();
    assert.equal(activeList.results.length, 0);
});
```

---

## 4. Web Push 与定时任务调度 (Cron Triggers)

### 4.1 Push 通知发送标准模式
```javascript
import webPush from 'web-push';

export async function sendEdgePush(env, db, userId, { title, body, url }) {
    const subs = await db.prepare(
        'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?1'
    ).bind(userId).all();
    
    if (!subs.results || subs.results.length === 0) return;

    webPush.setVapidDetails('mailto:admin@chillin.local', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    
    const payload = JSON.stringify({
        title: title || 'Chillin',
        body: body,
        icon: '/icons/transparent.png', // 保持全屏舒展排版，避免右侧生硬占位
        data: { url: url || '/' }
    });

    const tasks = subs.results.map(async (sub) => {
        try {
            await webPush.sendNotification({
                endpoint: sub.endpoint,
                keys: { p256dh: sub.p256dh, auth: sub.auth }
            }, payload);
        } catch (err) {
            // 404 或 410 代表客户端已卸载或注销，自动剔除死订阅
            if (err.statusCode === 404 || err.statusCode === 410) {
                await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(sub.endpoint).run();
            }
        }
    });

    await Promise.all(tasks);
}
```

---

## 5. Worker 上线与交付流水线

每次修改 Worker 或新增 D1 字段，必须严格执行以下质量验证：

1. **单测验证（零失败）**：
   ```bash
   npm test
   ```
2. **边缘打包演练（零语法/包体积超限错误）**：
   ```bash
   npx wrangler deploy --dry-run
   ```
3. **版本联动与部署流水线**：
   ```bash
   npm run ship -- --message "feat(api): 新增时光胶囊边缘端点" --bump patch --push
   npx wrangler deploy
   ```
