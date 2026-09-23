# 架构与技术栈规范 (Architecture & Stack Rule)

> 本规范约束 Chillin 项目的前后端系统架构、技术选型边界与模块分工。任何技术演进不得违背此架构原则。

---

## 1. 前端技术栈纯洁度 (Zero-Build 铁律)

1. **绝对原生化运行**：
   * 前端代码运行在浏览器原生环境下，必须使用 **HTML5 + Vanilla CSS + 原生 ES Modules (ESM)**。
   * **严禁引入构建打包黑盒**：
     * ❌ 严禁引入 Webpack、Vite、Rollup、Parcel、esbuild 等打包编译流程；
     * ❌ 严禁引入 React、Vue、Angular、Svelte 等全家桶视图框架；
     * ❌ 严禁引入 TailwindCSS、PostCSS、Sass、Less 等 CSS 编译预处理器。
2. **轻量与依赖控制**：
   * 必须保持前端在浏览器中直接可见即可执行（所写即所得）；
   * 如确需引入外部安全库（例如 DOMPurify），必须通过带有完整 SRI（Subresource Integrity）Hash 校验的公共 CDN，以 `<script>` 标签显式引入；
   * 杜绝在 `package.json` 中随意添加客户端运行时 `dependencies`。

---

## 2. 后端 Worker 模块化架构

后端运行在 **Cloudflare Workers (ESM)** 平台，入口由 `wrangler.toml` 指定为 `workers/api.js`，数据库为 **Cloudflare D1 (SQLite)**。

### 2.1 网关调度入口严格瘦身
* **入口仅限调度**：[`workers/api.js`](file:///d:/7/chillin/workers/api.js) 仅作为路由网关、CORS 预检、鉴权闸门和定时 Cron 调度触发器；
* **代码行数约束**：`workers/api.js` 代码行数**严禁超过 300 行**，杜绝重新膨胀为两千行的单体巨石。

### 2.2 严格领域模块归档
所有新增与调整的业务逻辑，必须按职责划分归入 `workers/src/` 相应模块：

| 模块文件 | 领域职责 | 约束说明 |
| :--- | :--- | :--- |
| [`workers/src/security.js`](file:///d:/7/chillin/workers/src/security.js) | 安全核心防线 | PBKDF2 强哈希、时序安全比对、图片二进制魔数嗅探、SSRF 14组 CIDR 校验、限流器。 |
| [`workers/src/auth.js`](file:///d:/7/chillin/workers/src/auth.js) | 账号鉴权与会话 | 注册、登录、登出、Session 校验与签发、Web Push 订阅。 |
| [`workers/src/garden.js`](file:///d:/7/chillin/workers/src/garden.js) | 数字花园资产领域 | 周记、笔记、随手记、收藏、提示词 CRUD、聚合增量拉取 `/api/sync/pull`、批量推送。 |
| [`workers/src/rag.js`](file:///d:/7/chillin/workers/src/rag.js) | 记忆回响 RAG 引擎 | 自然语言时间提取、停用词过滤、分词、多轮上下文继承、全资产多特征加权打分。 |
| [`workers/src/llm.js`](file:///d:/7/chillin/workers/src/llm.js) | 大模型网关集成 | DeepSeek 与 Workers AI 边缘调用、流式 SSE 协议、敏感词合规审查。 |
| [`workers/src/audit.js`](file:///d:/7/chillin/workers/src/audit.js) | 自动化安全与审计 | 定时 Cron UGC 违规扫描与隔离区备份、过期 Session 自动清理。 |

---

## 3. 数据库与数据流转 (D1 Database)

1. **迁移一致性**：所有数据库表结构变动必须在 `migrations/` 下按编号规范创建新的 `.sql` 迁移文件（如 `0015_xxx.sql`），禁止在代码中执行破坏性无记录 DDL；
2. **边缘查询就近优化**：利用 D1 与 Worker 同机房特性，多表读取优先通过 `Promise.all` 并发预编译执行，禁止低效嵌套串行查询。
