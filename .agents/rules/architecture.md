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
   * **首屏体积预算**：`public/` 下 JS 合计 gzip ≤ 160 KB、CSS 合计 gzip ≤ 48 KB、单文件 gzip ≤ 20 KB，由 `tests/architecture.test.mjs` 机器校验。上调预算必须是一次有意识的改动（改测试里的 `BUDGET` 并写明原因），不允许无声膨胀。

---

## 2. 后端 Worker 模块化架构

后端运行在 **Cloudflare Workers (ESM)** 平台，入口由 `wrangler.toml` 指定为 `workers/api.js`，数据库为 **Cloudflare D1 (SQLite)**，对象存储为 **Cloudflare R2**（绑定 `MEDIA` → 桶 `chillin-media`：图片二进制、阅读器书籍正文、D1 备份快照；D1 只保存元数据）。

### 2.1 网关调度入口严格瘦身
* **入口仅限调度**：[`workers/api.js`](../../workers/api.js) 仅作为路由网关、CORS 预检、鉴权闸门和定时 Cron 调度触发器；
* **代码行数约束**：`workers/api.js` 代码行数**严禁超过 300 行**，杜绝重新膨胀为两千行的单体巨石。

### 2.2 严格领域模块归档
所有新增与调整的业务逻辑，必须按职责划分归入 `workers/src/` 相应模块：

| 模块文件 | 领域职责 | 约束说明 |
| :--- | :--- | :--- |
（`workers/src/` 共 **19 个模块**：3 个安全原语、1 个鉴权、5 个花园业务域、1 个 AI 编排、1 个审计、1 个 Bot 对话编排、1 个 Bot 私人记忆、1 个 Bot 主动关怀、1 个外部 IM 接入、1 个定时任务编排。新增模块必须同步补进本表，[`tests/docs.test.mjs`](../../tests/docs.test.mjs) 会校验覆盖完整性。）

| 模块文件 | 领域职责 | 约束说明 |
| :--- | :--- | :--- |
| [`workers/src/security.js`](../../workers/src/security.js) | 安全门面 | 只做再导出（network + crypto），保证各子域从单一入口取安全能力，避免循环依赖。 |
| [`workers/src/security-network.js`](../../workers/src/security-network.js) | 网络与输入防线 | CORS / 安全响应头、跨实例共享限流、客户端 IP 取信、图片二进制魔数嗅探、输入校验、`jsonResponse` 与 SSE 包装。 |
| [`workers/src/security-crypto.js`](../../workers/src/security-crypto.js) | 密码学原语 | PBKDF2-SHA256 强哈希（10 万次 + 动态盐）、`timingSafeEqualStr` 恒定时间比对、口令强度校验。 |
| [`workers/src/auth.js`](../../workers/src/auth.js) | 账号鉴权与会话 | 注册 / 登录 / 登出、Cookie + Bearer 双轨会话签发与轮换（库内只存令牌摘要）、设备列表与吊销、Web Push 订阅。 |
| [`workers/src/garden-shared.js`](../../workers/src/garden-shared.js) | 花园公共设施 | 行格式化、归属与软删校验、墓碑 id 集合查询、惰性 schema 守卫。 |
| [`workers/src/garden-resources.js`](../../workers/src/garden-resources.js) | 数字花园资产领域 | 周记、笔记、随手记、收藏、提示词 CRUD 与软删、阅读进度同步。 |
| [`workers/src/garden-sync.js`](../../workers/src/garden-sync.js) | 增量同步与统计 | 聚合增量拉取 `/api/sync/pull`、脏数据批量推送（D1 分片）、热力图、备份邮件。 |
| [`workers/src/garden-media.js`](../../workers/src/garden-media.js) | 媒体存储领域 | 图片上传（二进制写 R2，D1 只存元数据）、带访问令牌与 Range 的下发、R2 备份快照保留策略。 |
| [`workers/src/garden-books.js`](../../workers/src/garden-books.js) | 阅读器云书库 | 书籍正文存 R2（对象键为书籍指纹的 SHA-256）、书目元数据 CRUD、跨设备下载与软删墓碑。 |
| [`workers/src/garden-echo.js`](../../workers/src/garden-echo.js) | 回响、通知与审计入口 | AI 回响卡片、周期回顾、Web Push 通知派发、UGC 审计入口。 |
| [`workers/src/rag.js`](../../workers/src/rag.js) | 记忆回响 RAG 引擎 | 自然语言时间范围解析、停用词过滤、分词、多轮上下文继承、全资产多特征加权打分与兜底回复。 |
| [`workers/src/llm.js`](../../workers/src/llm.js) | 大模型网关集成 | DeepSeek 与 Workers AI 边缘调用、流式与非流式包装、敏感词合规审查。 |
| [`workers/src/ai.js`](../../workers/src/ai.js) | AI 问答编排 | `/api/ai/chat` 编排层：RAG 召回 → 模型调用 → SSE 流式推送（从网关下沉而来）。 |
| [`workers/src/audit.js`](../../workers/src/audit.js) | 自动化安全与审计 | 定时 Cron UGC 违规扫描与隔离区备份、违规规则集、审计日志保留清理。 |
| [`workers/src/bot-commands.js`](../../workers/src/bot-commands.js) | Bot 对话编排（chat-first） | ClawBot 的消息分流层：**默认只聊天、不写库**（意图反转），只有显式「记录：…」才落随手记、「记住 / 忘记」才动档案；`claimBotMessage` 幂等排重、「搜 X」检索记忆、「问 X」走 Echo AI（独立限流桶）。 |
| [`workers/src/bot-memory.js`](../../workers/src/bot-memory.js) | Bot 私人记忆 | 三层记忆的读写入口：有限长度的对话上下文（按字符预算截断）与「关于我」档案条目的增删查，一律软删、全部参数化绑定并受体积上限约束；并暴露应用内 `/api/bot/profile` 读写接口供「账号与安全」弹层可视化编辑。 |
| [`workers/src/bot-outreach.js`](../../workers/src/bot-outreach.js) | Bot 主动关怀 | 没人说话时的开口资格判定：东八区 10:00–22:30 时窗内每天至多一次的随机开口时刻、刚聊完 30 分钟内不插嘴（6 小时内聊过则不等当天固定时刻，改在聊完 30–120 分钟内把最近 6 轮对话作为背景、允许顺着话题补一句）与只用 3–180 天前旧素材的门禁、模型 SKIP 否决权与概率闸门、账号级开关与逐条发送审计（正文落库但不进日志）。 |
| [`workers/src/bot-claw.js`](../../workers/src/bot-claw.js) | 外部 IM 接入（微信 ClawBot / iLink 协议） | 扫码绑定生命周期（二维码 / 确认 / 解绑，令牌只落库不回传）、每分钟 Cron 长轮询拉消息、游标与幂等排重、经 iLink `sendmessage` 回发文本。 |
| [`workers/src/maintenance.js`](../../workers/src/maintenance.js) | 定时任务编排 | 按 Cron 表达式分流：`* * * * *` 只跑 ClawBot 长轮询，`13 * * * *` 跑小时级维护（UGC 扫描、会话清理、限流清理、备份保留、审计保留）。 |

---

## 3. 数据库与数据流转 (D1 Database)

1. **迁移一致性**：所有数据库表结构变动必须在 `migrations/` 下按编号规范创建新的 `.sql` 迁移文件（如 `0015_xxx.sql`），禁止在代码中执行破坏性无记录 DDL；
2. **边缘查询就近优化**：利用 D1 与 Worker 同机房特性，多表读取优先通过 `Promise.all` 并发预编译执行，禁止低效嵌套串行查询。
