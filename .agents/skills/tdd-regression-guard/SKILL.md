---
name: tdd-regression-guard
description: Node 20+ 原生零依赖测试套件（node:test）、FakeD1 内存数据库模拟、浏览器环境 Mock 与回归防护指南。在编写单测、排查回归缺陷、驱动新功能开发或验证边缘边界条件时使用。
---

# 原生单测驱动与回归防护助手 (tdd-regression-guard)

> 本技能为 **Chillin 数字花园** 的测试工程标准手册，贯彻 **Node 20+ 原生零依赖测试（`node:test`）**、**纯内存 FakeD1 模拟**、**轻量浏览器环境 Mock** 与 **测试驱动开发 (TDD)** 流程。

---

## 1. 核心测试原则与技术栈

### 1.1 零外部依赖铁律 (Zero External Test Dependencies)
* **严禁引入大型测试框架**（如 Jest、Mocha、Vitest 等），绝不污染项目 `node_modules`。
* 所有单元测试基于 Node.js 20+ 原生内置模块：
  - `import test from 'node:test'`
  - `import assert from 'node:assert/strict'`
  - `import { DatabaseSync } from 'node:sqlite'`（通过 [`tests/fake-d1.mjs`](file:///e:/Chillin/tests/fake-d1.mjs)）

### 1.2 毫秒级极速执行
* 目前项目 68+ 项核心测试执行总耗时严格控制在 **400ms~600ms** 内。编写测试时必须优先使用轻量计算与内存模拟，禁止产生高延迟的外部 I/O 阻塞。

---

## 2. 核心 Mock 范式标准

### 2.1 浏览器全局环境 Mock 模板 (用于测试前端模块)
若测试的前端模块（如 `sync.js`, `db.js`, `daily-spark.js`）依赖了全局变量，在测试文件顶部引入标准 Mock：

```javascript
// 标准前端全局 Mock 模板
if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
}
if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => store.get(k) || null,
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear()
    };
}
if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => []
    };
}
```

### 2.2 FakeD1 数据库与事务测试范式 (用于测试 Worker 逻辑)
利用 `node:sqlite` 原生内存数据库模拟 Cloudflare D1：

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeD1, sqliteAvailable } from './fake-d1.mjs';

test('Feature - D1 lifecycle and boundary', { skip: !sqliteAvailable }, async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const rawDb = new DatabaseSync(':memory:');
    const db = new FakeD1(rawDb);

    // 1. 初始化表结构 (直接复用或粘贴 migrations 对应 DDL)
    rawDb.exec(`
        CREATE TABLE notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            is_deleted INTEGER DEFAULT 0,
            updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
        );
    `);

    // 2. 参数绑定防注入测试 (?1, ?2)
    const result = await db.prepare(
        'INSERT INTO notes (user_id, title) VALUES (?1, ?2) RETURNING *'
    ).bind(1, '测试笔记').first();

    assert.equal(result.title, '测试笔记');
    assert.ok(result.id > 0);

    // 3. 边界测试：软删除墓碑
    await db.prepare('UPDATE notes SET is_deleted = 1 WHERE id = ?1').bind(result.id).run();
    const rows = await db.prepare('SELECT * FROM notes WHERE is_deleted = 0').all();
    assert.equal(rows.results.length, 0);
});
```

---

## 3. TDD 推荐工作流 (Red-Green-Refactor)

在开发诸如“数据同步合并算法”、“时间跨日计算”或“复杂查询打分”等核心逻辑时，推荐三步法：

1. **先写失败的测试 (Red)**：
   在 `tests/` 下新建或修改测试文件，明确输入输出与边界条件（如空字符串、超长文本、跨天时间戳），此时测试运行报错。
2. **编写最简通过逻辑 (Green)**：
   实现最小可用业务代码，运行 `npm test` 验证测试变绿。
3. **架构与性能重构 (Refactor)**：
   清理代码，提取公共工具函数，确保单文件不超过 500 行，再次运行 `npm test` 确保无任何功能回退。

---

## 4. 常用单测运行指令速查

```bash
# 1. 运行全局全部测试
npm test

# 2. 单独运行指定领域测试文件 (极速调试)
node --test tests/garden.test.mjs
node --test tests/sync.test.mjs
node --test tests/security.test.mjs
node --test tests/rag.test.mjs

# 3. 过滤运行特定名称的测试用例
node --test --test-name-pattern="LWW" tests/sync.test.mjs
```
