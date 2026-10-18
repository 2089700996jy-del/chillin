# 工程质量、自动化测试与交付工作流规范 (Engineering & Workflow Rule)

> 本规范整合了 Chillin 项目的代码质量底线、原生自动化测试、预打包校验、版本号联动机制与 Git 协作提交标准，构成完整的端到端开发与交付流水线。

---

## 1. 质量底线与自动化测试红线 (Zero-Dependency Testing)

1. **测试引擎选型**：
   * 本项目测试体系保持**零第三方外部依赖**；
   * 采用 Node.js 20+ 原生内置测试运行器：`node --test` 与严格断言库 `node:assert/strict`；
   * 涉及 SQL / 会话的集成用例使用 `node:sqlite`（Node ≥ 22.5）在内存库中执行真实 migrations，旧版本 Node 会自动跳过（CI 同时跑 20 与 22）；
   * 严禁引入 Jest、Vitest、Mocha 等重型测试框架与成百上千个衍生依赖包。
2. **零容忍质量红线**：
   * 每次代码提交或发布前，必须在终端执行 `npm test`，所有用例必须 **100% 全部通过 (0 Fail, 0 Skip)**；
   * 任何导致单测失败的代码变动，一律视为不合格变更。

### 1.1 核心模块测试覆盖责任矩阵
当修改或新增下列业务模块时，开发者或 AI 助手**必须在 `tests/` 下同步新增或补充测试用例**：

| 修改范围 | 对应测试文件 | 必须覆盖的验证项 |
| :--- | :--- | :--- |
| **密码/鉴权/安全防线** | [`tests/security.test.mjs`](../../tests/security.test.mjs) | 请求体限长（`readTextCapped` / `readJsonCapped` 在读取过程中就中止，网关另有声明长度兜底）、密码强哈希复杂度、恒定时间比较防时序攻击、令牌哈希、CSP 哈希与第三方域策略、共享限流与降级、代理 IP 取信、Trusted Types 收口（服务端出站抓取与 SSRF 校验已于 v2.5.97 随外链解析功能移除）。 |
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

## 5. 文档同步硬性要求 (Docs Stay In Sync)

**任何一次代码改动，必须在同一个提交里同步受影响的文档。** 文档漂移等同缺陷：README 曾长期写着「外链自动抓取标题 / 封面」「D1 是唯一的数据源」「19 个迁移」，而这些在代码里早已不存在——这种漂移只能靠机器守住。

### 5.1 改动 ↔ 文档对照表

| 你改了什么 | 必须同批更新 |
| :--- | :--- |
| 新增 / 删除 / 重命名 `workers/src/*.js`、`public/js/*.js` 模块 | [`README.md`](../../README.md)（目录结构与模块数）、[`architecture.md`](architecture.md) 领域模块表、本文件 §1.1 覆盖矩阵 |
| 新增数据库迁移 | [`README.md`](../../README.md)（迁移范围 0001–00XX）、[`architecture.md`](architecture.md) §3 迁移一致性 |
| 新增 / 删除测试套件 | [`README.md`](../../README.md) 测试布局表、架构报告里的套件与用例数 |
| 新增 / 移除用户可见功能、接口或存储方案 | [`README.md`](../../README.md) 功能一览与技术栈、[`docs/Chillin数字花园_产品全景与工程架构分析报告.md`](../../docs/Chillin数字花园_产品全景与工程架构分析报告.md) |
| 版本号变化（每次发布） | [`PROGRESS.md`](../../PROGRESS.md) 版本头与进展记录、架构报告的报告版本与在线基准（8 处锚点由 `npm run bump` 自动联动，**严禁手改单个文件**；`tests/docs.test.mjs` 会实跑 `--dry-run patch` 校验覆盖范围） |
| 安全边界变化（CSP / 限流 / 口令策略 / 令牌） | [`security.md`](security.md)、[`public/_headers`](../../public/_headers) 注释、[`README.md`](../../README.md) 安全要点 |

### 5.2 机器校验（不靠自觉）

[`tests/docs.test.mjs`](../../tests/docs.test.mjs) 把「数字类事实」钉死，`npm test` 会直接卡住漂移：

* `README.md` 里的 `js/` 模块数、`workers/src/` 模块数、迁移范围 `0001–00XX`、测试布局表行数，**必须等于磁盘上的真实数量**；
* `architecture.md` 的模块表**必须覆盖 `workers/src/` 下的每一个文件**；
* `package.json` / `PROGRESS.md` / `public/js/version.js` / `public/sw.js` / 架构报告的版本号**必须完全一致**。

报错时请**按失败信息更新文档**，而不是去改断言里的数字。

### 5.3 例外

* `CHANGELOG.md` 由 `npm run changelog` 从 git 历史生成，**不要手改**；历史条目里的旧功能名（如 Microlink、小宇宙）是当时的事实，保持原样；
* `.agents/skills/` 下的第三方技能包自带文档，不纳入本要求。
* `refactor(...)`: 代码重构（例如 `refactor(worker): modularize into workers/src`）
* `docs(...)`: 文档、报告或开发规约变更（例如 `docs: update rules`）
* `test(...)`: 增加或更新自动化测试用例（例如 `test(search): add highlight xss tests`）
* `style(...)`: 不影响代码逻辑的样式或格式变动

> 推荐直接用 [`npm run ship`](../../scripts/ship.mjs) 代替手工流程：它会先跑单测与预打包演练，再做版本联动，并强制校验提交信息格式（`--push` 可一并推送）。
>
> 它还会**校验远端 D1 迁移是否全部应用**：本地测试通过 `fake-d1` 执行**全部**迁移，因此「迁移漏应用」这类漂移在本地永远测不出来——`0019_reader_progress.sql` 曾因此漏应用 12 天，而依赖它的接口已随 Worker 上线，线上持续报 `no such table`。发现未应用迁移时 `ship` 直接中断并给出 `wrangler d1 migrations apply DB --remote`。
