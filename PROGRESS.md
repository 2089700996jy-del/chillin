# Chillin 项目进度记录

> 更新时间：2026-11-19。当前前端/Worker：**v2.5.261**（Worker/Pages 已部署、D1 迁移 `migrations/0001`–`0043` 已应用、R2 桶 `chillin-media` 已建（21 张））。

## 项目是什么

个人「数字花园」Web 应用（周记 / 笔记 / 收藏 / 随手记 / 提示词库 / TXT 阅读 / AI 记忆回响）。

- 前端：`public/index.html` + `public/style.css` + `public/app.js` 编排 + `js/` 29 个 ESM 模块（原生无打包）。
- 后端：Cloudflare Worker `workers/api.js` 网关（≤300 行红线）+ `src/` 51 个领域模块。
- 数据库：Cloudflare D1（`migrations/0001`–`0043`）+ R2 桶 `chillin-media`。
- 测试：`npm test` 原生零依赖单测套件（`node --test`）；静态暗病扫描：`npm run audit:system`。
- 站点：Pages `https://chillin-bfc.pages.dev` + Worker `https://chillin-api.2089700996jy.workers.dev`。

---

## 全项目功能健康度矩阵 (Feature & Health Matrix)

> 评级规则（严谨工程标准）：  
> - 🟢 **完备测试**：纯无副作用或已通过端到端真机与生命周期全链路验证。  
> - 🟡 **仅理想路径单测**：单元测试全绿，但涉及网络请求、跨端同步、D1/R2 读写、防抖保存或切后台，待静态审计与真机生命周期逐一核验。  
> - 🔴 **存在已知风险**：存在未修复缺陷、真机排查未收口或未补全回归测试。

| 领域模块 | 前端核心 (`public/js/`) | 后端核心 (`workers/src/`) | 涉及 D1 迁移 | 对应测试套件 | 健康等级 | 关键盲区与风险标注 |
| :--- | :--- | :--- | :--- | :--- | :---: | :--- |
| **系统基座与配置路由** | `app.js`, `router.js`, `ui.js`, `actions.js`, `config.js`, `state.js`, `utils.js`, `version.js`, `trusted-types.js` | `api.js` (路由网关) | 无 | `tests/architecture.test.mjs`, `tests/a11y.test.mjs`, `tests/router.test.mjs` | 🟡 | 涉及首屏启动路由与配置获取，待全生命周期与全局错误边界核验 |
| **账号鉴权与安全防线** | `auth.js`, `api.js` | `auth.js`, `security.js`, `security-network.js`, `security-crypto.js` | 0001, 0023, 0026 | `tests/auth.test.mjs`, `tests/security.test.mjs` | 🟡 | 涉及 Cookie 双轨会话、网络 Token 刷新与 PBKDF2 边缘计算，待移动端超时与切后台核验 |
| **PWA 离线与增量同步** | `sync.js`, `db.js`, `pwa-update.js` (含 `sw.js`) | `garden-sync.js`, `garden-shared.js` | 0001~0011 | `tests/sync.test.mjs`, `tests/sw.test.mjs`, `tests/pwa-update.test.mjs` | 🟡 | 涉及 Service Worker 缓存穿透、IndexedDB 降级与 LWW 冲突合并，待离线恢复真机核验 |
| **TXT 阅读器与跨端同步** | `reader.js` | `garden-resources.js`, `garden-books.js` | 0019, 0021 | `tests/reader.test.mjs`, `tests/books.test.mjs` | 🟢 | 已通过系统审计与暗病治理：动态 60KB 安全 keepalive 与 pagehide 退出保活，切回前台 visibilitychange 自动拉取云端对齐最新进度与冲突解决，手机状态栏点击可视化诊断 |
| **数字花园资产 (周记/笔记/随手记/书签/提示词)** | `weeklies.js`, `notes.js`, `feeds.js`, `bookmarks.js`, `prompts.js`, `daily-spark.js` | `garden-resources.js`, `garden-shared.js` | 0001~0007, 0028, 0031 | `tests/garden.test.mjs`, `tests/router.test.mjs` | 🟡 | 涉及草稿防抖持久化、批量增量推送与软删，待防抖切后台刷新与网络重试核验 |
| **双向维基与常青知识网络** | `wikilinks.js`, `evergreen-topics.js`, `search.js` | `rag-index.js`, `insights.js` | 0001, 0034(FTS5) | `tests/wikilinks.test.mjs`, `tests/evergreen.test.mjs`, `tests/search.test.mjs` | 🟢 | 纯文本双链 `[[wiki]]` 解析、XSS 洗标、搜索高亮与反向引用，无外部网络副作用 |
| **AI 记忆回响 (RAG) 与模型编排** | `echo-ai.js` | `garden-echo.js`, `rag.js`, `rag-index.js`, `llm.js`, `ai.js`, `ai-runtime.js`, `ai-tools.js`, `agent-tools-expanded.js` | 0013, 0034(FTS5) | `tests/rag.test.mjs`, `tests/agent.test.mjs` | 🟡 | 涉及流式 SSE 请求、多步 Tool Calling 循环与 DeepSeek 网络交互，待网络超时降级核验 |
| **自主目标 Agent (Autoloop 闭环)** | `agent-goals.js` | `agent-store.js`, `agent-executor.js`, `agent-lifecycle.js`, `agent-scheduler.js`, `agent-goals.js`, `agent-approvals.js`, `agent-checkpoint.js`, `agent-web.js` | 0035~0039, 0042 | `tests/agent-goals.test.mjs` | 🟡 | 涉及后台每分钟 Cron 租约抢占、审批流与状态机防重规划竞争，待真机调度核验 |
| **微信伴侣 Bot 与健康打卡** | `feature-loader.js` (动态按需装载) | `bot-claw.js`, `bot-claw-auth.js`, `bot-commands.js`, `bot-garden.js`, `bot-agent-commands.js`, `bot-butler.js`, `bot-preferences.js`, `bot-memory.js`, `bot-reminders.js`, `bot-health.js`, `bot-web.js`, `bot-search.js`, `bot-media.js`, `bot-image-flow.js`, `bot-vision.js`, `bot-outreach.js`, `bot-outreach-source.js`, `bot-links.js`, `bot-weather.js`, `bot-prompts.js`, `bot-text.js` | 0024~0033, 0040, 0041, 0043 | `tests/bot-claw.test.mjs`, `tests/bot-health.test.mjs`, `tests/bot-weather.test.mjs`, `tests/bot-reminders.test.mjs` | 🟡 | 涉及 iLink 长轮询、微信多图编排、看图识图与健康打卡 D1 落库，待弱网与异常终态核验 |
| **长期线索与行动转化 (Insights)** | `insights.js` | `insights.js` | 无（纯确定性聚类） | `tests/insights.test.mjs` | 🟢 | 纯确定性双链/标签聚合与跨月聚类算法，无外部网络与副作用 |
| **媒体存储与云端灾备** | `upload.js`, `backup.js` | `garden-media.js`, `garden-export.js`, `garden-backup-mail.js`, `maintenance.js`, `audit.js` | 0015, 0017, 0021, 0022 | `tests/media.test.mjs`, `tests/backup.test.mjs` | 🟡 | 涉及 R2 大文件二进制读写、Range 请求分片与 ZIP 邮件直发，待存储配额与重试核验 |

---

## 近期已完成（滑动窗口：最近 5 版）

> 完整历史流水账已归档至 [`docs/archive/PROGRESS-历史详情.md`](docs/archive/PROGRESS-历史详情.md)；提交级日志见 [`CHANGELOG.md`](CHANGELOG.md)。

| 版本 | 交付要点 |
| :--- | :--- |
| v2.5.255 | 模版周记/笔记自动解耦升级与虚假冲突清空：根除用户编辑初始默认模版（如 id:1 周记、id:101/102 笔记）与云端种子误判冲突导致的同步死锁，自动将受影响条目升级为全新客户端时间戳 ID 并清除误判冲突标记，保证批量上传即时畅通；506 测试全过 |
| v2.5.253 | 架构重构第三阶段（前端巨石解耦与本地存储模型统一）：抽离 420 行 bot-claw-ui.js 专职微信 Bot 扫码轮询与状态控制，auth.js 从 1545 行瘦身至 1180 行（净减 365 行）；IndexedDB 升级至 v2 并收口独立 reader 数据库，统一托管 books 与 chapters 存储层并提供历史数据自动平滑迁移；前端模块增至 30 个并严守体积预算（JS 总 Gzip 191.99 KB <= 195 KB，单文件 <= 20 KB）；505 测试全过 |
| v2.5.252 | 架构重构第二阶段（后端领域高内聚整合与命令路由重构）：抽离 205 行 bot-agent-commands.js 专职处理 Agent 目标 CLI 与审批流，bot-garden.js 彻底收敛聚焦花园资产写入（318行）；bot-commands.js 重构为 6 大领域结构化分发表（系统设置、提醒待办、健康打卡、目标Agent、花园资源、多模态与检索）；同步更新架构规约与模块清单（51个模块）；505 测试全过 |
| v2.5.251 | 架构重构第一阶段（解除行数红线枷锁与实体四重异名归一）：废除 500 行物理行数死线调整为 800 行高内聚上限，保持 workers/api.js 224 行薄路由红线；剔除 garden-shared.js 与 bot-weather.js 运行时的 ALTER TABLE / CREATE TABLE DDL 注入；前端统一周记命名为 state.weeklies 与 ui.currentWeeklyId，IndexedDB 存储键平滑升级至 gardenWeeklies 并提供 100% 透明向后兼容与防丢保障；505 测试全过 |
| v2.5.250 | 架构报告 D1 迁移范围同步、功能健康度矩阵过期测试路径清理与双轨发布机制规范：补齐 `tests/docs.test.mjs` 对架构报告迁移范围 `0001–0043` 门禁；清理并校验健康矩阵中 `tests/rag.test.mjs`、`tests/agent.test.mjs` 与微信测试路径真实性；梳理规约与 CI 架构：D1 远端迁移在发布前由本地/发布脚本执行确认，CI 执行质量门禁后自动部署 Worker，Pages 经 Cloudflare Git Webhook 独立原子发布；505 测试全过 |

---

## 待办与健康度收敛清单 (Active Backlog)

- [x] **运行 `npm run audit:system` 首批暗病治理（🟡 $\rightarrow$ 🟢 逐项收敛）**：
  1. TXT 阅读器跨端同步：退出保活补齐动态 60KB 安全 keepalive 与 pagehide 监听，切回前台自动拉取云端对齐最新进度，手机状态栏点击可视化诊断（升为 🟢）；
  2. 微信 ClawBot 扫码：补齐切后台 visibilitychange 暂停轮询与切回前台自动恢复核验，避免后台电量空转与切台掐死；
  3. 异常吞错与查重幂等治理：收敛治理静默空 catch {} 块，修复 bot-weather 晨报查重 D1 报错安全熔断跳过；
  4. 全局暗病扫描阻断项（WARN）清零（72 $\rightarrow$ 0）。
- [ ] **下一批真机健康度深度验证**：
  1. 笔记与周记草稿：防抖保存补齐 `visibilitychange` 强制保存，消除切后台丢草稿隐患；
  2. PWA 离线增量同步真机断网恢复核验。

---

## 部署

```bat
cd chillin
npx wrangler login                           :: 凭据过期时先登录（非交互环境无法自动刷新）
npx wrangler r2 bucket create chillin-media  :: 首次部署 R2 绑定前必须先建桶
npx wrangler d1 migrations apply DB --remote :: 先迁移再部署（0020/0021 是新接口的 schema 前提）
npx wrangler deploy
node scripts/migrate-files-to-r2.mjs --dry-run :: 存量图片搬迁预演；确认后去掉 --dry-run，全部成功可加 --clear-data
git push origin main                         :: 触发 Pages 构建（前端后于 Worker 上线）
```

Secrets（勿进仓）：`LLM_API_KEY`、`VAPID_PRIVATE_KEY` 等。

**完整备份/恢复**：`npm run backup:full` → `backups/full-*`（D1 FTS5 安全导出 + R2 逐对象 SHA-256）；`backup:verify`；`restore:full`（R2→清旧表→D1）；`backup:drill` / 每周 Restore Drill。
