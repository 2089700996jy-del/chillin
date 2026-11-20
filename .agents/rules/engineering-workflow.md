# 工程质量、自动化测试与交付工作流规范 (Engineering & Workflow Rule)

> 本规范整合了 Chillin 项目的代码质量底线、原生自动化测试、预打包校验、版本号联动机制与 Git 协作提交标准，构成完整的端到端开发与交付流水线。

---

## 1. 质量底线与自动化测试红线 (Zero-Dependency Testing)

1. **测试引擎选型**：
   * 本项目测试体系保持**零第三方外部依赖**；
   * 采用 Node.js 22.5+ 原生内置测试运行器：`node --test` 与严格断言库 `node:assert/strict`；
   * 涉及 SQL / 会话的集成用例使用 `node:sqlite`（Node ≥ 22.5）在内存库中执行真实 migrations；`npm test` 的 `pretest` 会硬拦低版本 Node，CI 与本地发布统一使用 Node 22；
   * 严禁引入 Jest、Vitest、Mocha 等重型测试框架与成百上千个衍生依赖包。
2. **零容忍质量红线**：
   * 每次代码提交或发布前，必须在终端执行 `npm test`，所有用例必须 **100% 全部通过 (0 Fail, 0 Skip)**；
   * 任何导致单测失败的代码变动，一律视为不合格变更。

### 1.1 核心模块测试覆盖责任矩阵
当修改或新增下列业务模块时，开发者或 AI 助手**必须在 `tests/` 下同步新增或补充测试用例**：

| 修改范围 | 对应测试文件 | 必须覆盖的验证项 |
| :--- | :--- | :--- |
| **密码/鉴权/安全防线** | [`tests/security.test.mjs`](../../tests/security.test.mjs) | 请求体限长（`readTextCapped` / `readJsonCapped` 在读取过程中中止）、密码强哈希复杂度、恒定时间比较防时序攻击、令牌哈希、CSP 哈希与第三方域策略、共享限流与降级、代理 IP 取信、Trusted Types 收口、出站抓取白名单与防御式网络隔离。 |
| **数据同步/冲突合并** | [`tests/sync.test.mjs`](../../tests/sync.test.mjs) | 时间戳多格式解析 (`toUpdatedTs`)、双向数据合并、Last-Write-Wins 规则生效验证；批量推送的条数/单条体积上限见 `tests/garden.test.mjs`。 |
| **AI 记忆回响 (RAG)** | [`tests/rag.test.mjs`](../../tests/rag.test.mjs) | 停用词准确过滤、自然语言时间范围解析、全表多特征检索加权打分准确率、AI 问答输入上限（空/超长问题与非法 JSON 拦在模型调用之前）。 |
| **搜索与命令面板** | [`tests/search.test.mjs`](../../tests/search.test.mjs) | 关键词命中高亮 (`<mark>`)、大小写不敏感匹配、特殊符号转义与 XSS 防御测试。 |
| **PWA 离线缓存 / Service Worker** | [`tests/sw.test.mjs`](../../tests/sw.test.mjs) | 预缓存清单与 `public/js/*.js` 一一对应、清单资源与 manifest 图标必须存在、模块请求绝不回退 `index.html`。 |
| **领域 CRUD / 同步 / 审计** | [`tests/garden.test.mjs`](../../tests/garden.test.mjs) | 资源 CRUD、跨用户归属隔离、软删墓碑不可复活、批量增量推送、热力图按用户聚合（基于 `node:sqlite` 真实执行 migrations）。 |
| **会话与鉴权** | [`tests/auth.test.mjs`](../../tests/auth.test.mjs) | 会话令牌只存哈希、刷新时轮换、设备列表标记当前会话、单设备吊销与全端退出只影响本账号。 |
| **架构红线 / 网关瘦身** | [`tests/architecture.test.mjs`](../../tests/architecture.test.mjs) | `workers/api.js` 300 行红线、各子域模块被路由引用、网关内不得出现 SQL 与 LLM 供应商细节、`/api/health` 必须为公开路由。 |
| **文档与代码一致性** | [`tests/docs.test.mjs`](../../tests/docs.test.mjs) | README 的模块数 / 迁移范围 / 测试套件数必须等于磁盘真实数量、`architecture.md` 模块表必须覆盖全部 `workers/src/*.js`、各文档版本号必须一致（见 §5）。 |
| **媒体存储 / 图片上传与下发** | [`tests/media.test.mjs`](../../tests/media.test.mjs) | 图片字节入 R2、`Range` → 206 与 `Content-Range`、访问令牌拒绝、历史 D1 BLOB 兼容、未绑定 R2 时的兜底写入、备份快照保留策略。 |
| **阅读器云书库** | [`tests/books.test.mjs`](../../tests/books.test.mjs) | 书目元数据与 R2 正文一致、跨用户隔离、同指纹 upsert 不重复、软删回收对象、删书连带清理阅读进度。 |
| **路由接线 / 新增接口** | [`tests/router.test.mjs`](../../tests/router.test.mjs) | 走真实 `workers/api.js` 路由表与真实会话 Cookie，验证 CRUD、上传与令牌下发、未知子路径 404。 |
| **备份与恢复** | [`tests/backup.test.mjs`](../../tests/backup.test.mjs) | crc32、ZIP 结构、备份打包内容、Resend 邮件降级、备份守卫状态机。 |
| **常青主题 / 知识聚合** | [`tests/evergreen.test.mjs`](../../tests/evergreen.test.mjs) | 中英混排词数统计、主题标签合法性、中文日期与时间跨度解析、目录页生命周期。 |
| **TXT 阅读器与进度同步** | [`tests/reader.test.mjs`](../../tests/reader.test.mjs) | UTF-8 优先解码、GBK 兜底（中文不出现乱码）、阅读进度写入保护（更旧写入被拒绝）、百分比夹紧与跨用户隔离、`rebuildBookText` 按 index 重组正文并保留章名行（本机书架补传用）。 |
| **双向链接 / Markdown 渲染** | [`tests/wikilinks.test.mjs`](../../tests/wikilinks.test.mjs) | `[[wiki]]` 解析与别名、XSS 防御、反向链接与摘要高亮、Markdown 图片 / 链接渲染。 |

---

## 2. 边缘构建预检卡点 (Wrangler Dry-Run)

任何涉及 Worker 后端（[`workers/`](../../workers)）的修改，提交前必须执行预打包演练：

```bash
npx wrangler deploy --dry-run
```

* 验证构建输出必须为 `Exit Code 0`；
* 验证不存在语法解析错误、未声明的 D1 / 环境变量 Binding 缺失，或循环依赖导致打包死锁。

---

## 3. 版本号联动自增机制 (`npm run bump`)

本项目在前端页面、PWA 缓存、Worker 后端与文档之间分布有 8 处版本号锚点。**严禁手动单独修改某一个文件**，防止因版本未对齐导致 PWA 缓存无法静默探测更新。

### 3.1 联动文件清单
发布新版本时，必须使用项目自动化脚本：
* `npm run bump`：小版本自增（如 `2.5.25` $\rightarrow$ `2.5.26`）；
* `npm run bump:minor`：功能大版本自增。

**脚本将自动同步联动更新以下 8 处锚点**：
1. `package.json` 中的 `version`
2. `public/version.json` 中的版本号与发布时间戳
3. `public/js/version.js` 中的 `APP_VERSION`
4. `public/sw.js` 中的 `APP_V` 与 `CACHE_NAME`（触发 Service Worker 激活更新）
5. `public/index.html` 中的资源静态引入 hash 及右下角版本展示 Badge
6. `workers/api.js` 中的 `APP_VERSION` 探测常量
7. `PROGRESS.md` 的版本头与当前版本段落
8. `docs/Chillin数字花园_产品全景与工程架构分析报告.md` 的报告版本、在线基准与 Service Worker 缓存版本（`tests/docs.test.mjs` 会校验三处版本号两两相等）

---

## 4. Git 提交信息格式 (Conventional Commits)

每次 Git Commit 必须严格遵循语义化提交规范，严禁提交模糊无意义信息（如 "fix bug"、"update"）：

* `feat(...)`: 新功能或新业务模块（例如 `feat(rag): add prompt retrieval`）
* `fix(...)`: 修复缺陷或崩溃（例如 `fix(sw): prevent offline fallback to index.html`）
* `perf(...)`: 性能提升（例如 `perf(sync): single rtt aggregated pull`）

---

## 5. 规约分级与影响范围检查机制 (Blast Radius-Driven Docs & Checks)

项目倡导**“软约束指引方向，按任务影响范围决定检查与记账深度”**。彻底摒弃过去微观死卡行数、死板统计文件数量与“改一行代码必须同步多份长篇文档”的形式主义。

### 5.1 核心软约束原则 (Soft Constraints Guidelines)

1. **代码行数与文件体积为健康度软约束**：
   - 鼓励高内聚与就地闭环，严禁为了盲目将单个文件压在固定行数内而把原本一体的业务强拆成充满循环引用的碎片文件；
   - 行数上限为架构健康度的警示线而非阻断线；唯一硬性底座保留 `workers/api.js` 作为轻量薄路由（严禁在网关内写业务 SQL 与大模型直调）。
2. **模块数量为领域划分软约束**：
   - 关注核心领域的职责清晰与高内聚，废除磁盘文件数量必须与文档数字分毫不差相等的死板门禁；
   - 文档与规约提供核心业务领域全景，内部子模块的自然收敛、提取辅助类无需因为一个文件增删而反复被文档卡死。

### 5.2 影响范围与检查深度分级矩阵 (Inspection Depth Matrix)

根据任务的影响范围（Blast Radius），动态决定需要执行的验证门禁与文档同步深度：

| 变更等级 | 适用影响范围 (Blast Radius) | 检查与验证深度 | 文档同步要求 |
| :--- | :--- | :--- | :--- |
| **L1 局部微调**<br>(Local Fix) | 单个函数内部缺陷修复、边界保护、性能调优、样式微调、局部内存释放等；**不改变对外 API、不改动数据表、不调整跨模块依赖**。 | **定向单元测试通过**<br>执行 `npm test` 相关套件且 100% 通过（0 Fail）。 | **免除宏观文档更新**<br>无需修改 README、无需更新长篇架构报告与规约，快速交付。 |
| **L2 领域演进**<br>(Domain Evolution) | 领域内部模块自然重构（如愈合孪生碎片）、新增非破坏性内部辅助能力、性能基底优化。 | **全站测试 + 静态契约审计**<br>执行 `npm test` 全绿，并通过 `npm run audit:system` 验证契约。 | **单一事实源记账**<br>在 [`PROGRESS.md`](../../PROGRESS.md) 记录进展与健康度；无需强行逐一改写其余多份历史长文。 |
| **L3 重大演进**<br>(Major & Schema) | 新增 D1 数据库迁移（`migrations/`）、修改全局安全与鉴权防线、跨领域重大架构重构、正式发版（`npm run bump`）。 | **全链路端到端闭环**<br>`npm test` + `wrangler deploy --dry-run` + 远端迁移演练。 | **全景同步**<br>更新 [`README.md`](../../README.md) 技术栈与迁移索引、版本联动锚点对齐。 |

### 5.3 机器校验边界 (Guardrail Boundaries)

自动化测试守住核心底线，而非制造微观阻碍：

* `PROGRESS.md` 作为单一事实源，记录套件与用例数、迁移范围与版本锚点，由 [`tests/docs.test.mjs`](../../tests/docs.test.mjs) 校验；
* 核心业务领域架构与路径引用有效性保持健康；
* 每次大版本或疑难暗病排查前，建议执行 `npm run audit:system`（调用 [`scripts/system-audit.mjs`](../../scripts/system-audit.mjs)）进行静态契约健康体检。

### 5.4 例外说明

* `CHANGELOG.md` 由 `npm run changelog` 从 git 历史生成，**不要手改**；历史条目里的旧功能名（如 Microlink、小宇宙）是当时的事实，保持原样；
* `.agents/skills/` 下的第三方技能包自带文档，不纳入本要求。
* `refactor(...)`: 代码重构（例如 `refactor(worker): modularize into workers/src`）
* `docs(...)`: 文档、报告或开发规约变更（例如 `docs: update rules`）
* `test(...)`: 增加或更新自动化测试用例（例如 `test(search): add highlight xss tests`）
* `style(...)`: 不影响代码逻辑的样式或格式变动

> 推荐直接用 [`npm run ship`](../../scripts/ship.mjs) 代替手工流程：它会先跑单测与预打包演练，再做版本联动，并强制校验提交信息格式（`--push` 可一并推送）。
>
> 它还会**校验远端 D1 迁移是否全部应用**：本地测试通过 `fake-d1` 执行**全部**迁移，因此「迁移漏应用」这类漂移在本地永远测不出来——`0019_reader_progress.sql` 曾因此漏应用 12 天，而依赖它的接口已随 Worker 上线，线上持续报 `no such table`。发现未应用迁移时 `ship` 直接中断并给出 `wrangler d1 migrations apply DB --remote`。

### 5.4 双轨部署与生产一致性验证机制

1. **Worker 部署与 D1 迁移权责解耦 (最小权限原则)**：
   * **D1 迁移为有状态数据库演进**：CI 中配置的 `CLOUDFLARE_API_TOKEN` 仅具备边缘 Worker 脚本发布权限，不持有破坏性数据库变更权限；
   * **本地发布强拦截**：[`scripts/ship.mjs`](../../scripts/ship.mjs) 内置 `checkRemoteMigrations` 闸门，在每次发布前强制校验远端 D1 迁移状态；若有新增或待应用迁移，必须先执行 `npx wrangler d1 migrations apply DB --remote` 后才允许发版；
   * **CI 自动化 Worker 部署**：GitHub Actions 在 `quality-gate` 全部通过后自动执行 `npx wrangler deploy` 更新边缘 Worker 路由与逻辑。
2. **Pages 前端静态分发 (Cloudflare Git Integration)**：
   * Pages 不由 GitHub Actions 直接下发，而是由 Cloudflare 官方 Git Webhook 监听 `main` 分支自动捕获 `public/` 目录进行独立原子发布；CI 中的 `Pages output layout is complete` 只负责确保发布目录完整。
3. **版本验收双卡点**：
   * 不能仅凭 GitHub Actions 绿色即断言线上已更新完毕，发布后必须双向探活复验：
     - **后端 Worker 探活**：`https://chillin-api.2089700996jy.workers.dev/api/health`（验证 `APP_VERSION` 与健康状态）；
     - **前端 Pages 探活**：`https://chillin-bfc.pages.dev/version.json`（验证 `version` 与发布时间戳是否推进到目标版本）。
