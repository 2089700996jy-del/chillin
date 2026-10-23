# Chillin 项目进度记录

> 更新时间：2026-10-23。供后续会话快速接续。当前前端/Worker：**v2.5.143**（Worker 已部署、D1 迁移 0001–0030 已应用、R2 桶 `chillin-media` 已建且 21 张存量图片已搬迁；见「部署」）。

## 项目是什么

个人「数字花园」Web 应用（周记 / 笔记 / 收藏 / 随手记 / 提示词库 / TXT 阅读 / AI 记忆回响）。

- 前端：`public/index.html` + `public/style.css` + `public/app.js`（原生 HTML/JS，无框架）
- **目录布局**：全部站点资源位于 `public/`（Cloudflare Pages 的 build output directory）；下文模块地图中的 `js/...`、`app.js`、`sw.js` 等均指 `public/` 下的同名文件
- **链接卡片**：含链接的随手记渲染成链接卡片；**小宇宙链接**（v2.5.132 起）由微信 Bot 侧抓封面/标题/详情做成卡片（单集详情取 `description`、缺失时用 `shownotes` 去标签，播客页取简介；v2.5.140 起不再抓时长），回「记录」才落库；**抓取是尽力而为**——Cloudflare 出口 IP 已被小宇宙 403 封禁（2026-10-21 边缘探针确证，见 `bot-links.js` 文件头），失败时如实告知并给出「记录：<标题> <链接>」的手动路径（v2.5.135 起这条路径真的会落成带标题的卡片）；**v2.5.137 起多一条可选退路**：配了 `LINK_READER_API_KEY` 之后，直连失败会交给第三方读取服务代读一次（默认 `https://r.jina.ai`，可用 `LINK_READER_URL` 覆盖，用它的出口绕开这道封锁；没配密钥就完全不走这条路）；其它外链仍只做卡片展示、不做任何服务端抓取（`/api/link/parse` 已于 v2.5.97 移除）。历史条目里已存的元数据照常渲染
- 后端：Cloudflare Worker `workers/api.js` + 模块化子域 `workers/src/`（REST）
- 数据库：Cloudflare D1（`migrations/0001`–`0030`；远端应用状态以 `npm run ship` 的迁移检查为准）
- 对象存储：Cloudflare R2 桶 `chillin-media`（绑定 `MEDIA`）——图片二进制 `uploads/<userId>/<id>`、D1 备份快照 `backups/`、阅读器书籍正文 `books/<userId>/<sha256>.txt`；D1 只保留元数据
- 站点：Pages `https://chillin-bfc.pages.dev` + Worker `https://chillin-api.2089700996jy.workers.dev`
- GitHub：`https://github.com/2089700996jy-del/chillin`
- 版本：用 `npm run bump` / `npm run bump:patch` 一键对齐 **8 处**：`public/js/version.js`、`public/version.json`、`workers/api.js`、`public/sw.js`、`public/index.html`、`package.json`、`PROGRESS.md`、架构报告（`tests/docs.test.mjs` 实跑 `--dry-run` 校验覆盖范围）
- 测试：`npm test` 原生零依赖单测套件（`node --test`）
- 形态：Web / PWA（Pages）；已移除 Capacitor Android 工程
- **技能库**：`.agents/skills/` 只保留 12 个项目自研 / 第三方单文件技能；通用 Cloudflare 技能（`cloudflare` / `wrangler` / `workers-best-practices` 等）自 2026-10-22 起不再随仓库分发，改由本机全局技能目录提供（同名时仓库副本会遮蔽上游新版），来源、体积与重拉命令见 [`.agents/skills/SOURCES.md`](.agents/skills/SOURCES.md)

## 模块地图

### 前端
依赖方向：`app.js`（编排）→ 业务模块 → `api.js` facade → `auth.js` / `sync.js` → `state` / `utils` / `config`。

> 各模块的职责与边界以 [`.agents/rules/architecture.md`](.agents/rules/architecture.md) §2.2「严格领域模块归档」表为**唯一来源**——`tests/docs.test.mjs` 强制它覆盖 `workers/src/` 下每一个文件，改代码必须同批改它；README 目录树是文件清单的另一个受校验视图。此处不再复制第二份表格（历史副本见归档文件附录）。

**前端分层**（`public/`：`app.js` 编排 + `js/` 26 个 ESM）：
- 基础设施：`js/config.js`、`js/state.js`、`js/utils.js`、`js/actions.js`、`js/ui.js`、`js/db.js`、`js/trusted-types.js`
- 网络与会话：`js/api.js`（薄 facade）、`js/auth.js`、`js/sync.js`
- 业务域：`js/weeklies.js`、`js/notes.js`、`js/bookmarks.js`、`js/prompts.js`、`js/feeds.js`、`js/reader.js`、`js/echo-ai.js`、`js/search.js`、`js/upload.js`、`js/daily-spark.js`、`js/evergreen-topics.js`、`js/wikilinks.js`
- 路由与生命周期：`js/router.js`、`js/pwa-update.js`、`js/version.js`、`js/backup.js`

**后端分层**（`workers/`：网关 `api.js` + `src/` 24 个领域模块）：
- 安全原语：`security.js`、`security-network.js`、`security-crypto.js`
- 鉴权：`auth.js`
- 花园业务域：`garden-shared.js`、`garden-resources.js`、`garden-sync.js`、`garden-media.js`、`garden-books.js`、`garden-echo.js`
- 智能与记忆：`ai.js`、`rag.js`、`llm.js`
- 审计与定时编排：`audit.js`、`maintenance.js`
- Bot：`bot-commands.js`、`bot-memory.js`、`bot-claw.js`、`bot-reminders.js`、`bot-web.js`、`bot-media.js`、`bot-vision.js`、`bot-outreach.js`、`bot-links.js`

## 近期已完成（摘要）

> 逐版本完整记录（47 条，含未发布的工作树内改动至 v2.5.140）已归档至 [`docs/archive/PROGRESS-历史详情.md`](docs/archive/PROGRESS-历史详情.md)；提交级日志见自动生成的 [`CHANGELOG.md`](CHANGELOG.md)。本文件只保留「接续工作所需的现状」，需要某一版的动机、证据与实测数据时去归档文件里搜版本号。

| 版本 | 交付要点 |
| :--- | :--- |
| 工作树 | Bot 定点提醒（到点主动开口、30 分钟追问一次、回「完成」沉淀成随手记）与联网检索（按来源作答附出处、6 小时缓存、每日 20 次上限） |
| v2.5.140 | 微信链接速览只装封面/标题/详情，不再抓时长 |
| v2.5.139 | 通道状态不再骗人，Bot 不再自称没有能力 |
| v2.5.138 | 代读拿回 JSON 时也从 `data.html` 里捞封面 |
| v2.5.137 | 直连被出口封锁时可选用第三方读取服务代读 |
| v2.5.136 | 小宇宙页面解析改用页面自带的 `__NEXT_DATA__` |
| v2.5.135 | 抓不到元数据也能出卡片（自己写标题的「记录：<标题> <链接>」落成真卡片） |
| v2.5.134 | 微信 Bot 认引号包着的「记录：…」，且绝不再假装已存 |
| v2.5.133 | 小宇宙播客页不再张冠李戴，`http` 链接也不再沉默 |
| v2.5.132 | 小宇宙链接速览：抓标题/封面做卡片，回「记录」才落库 |
| v2.5.131 | 图片回信提速：瞬时 5xx 不再丢收信窗口，存图与看图并行 |
| v2.5.130 | 看图回信去掉「我看到：」前缀，只描述不猜归属 |
| v2.5.129 | 看图描述改成「朋友随口说一句」的口气 |
| v2.5.128 | 微信 Bot 图片改为「先描述、说『记录』才入库」 |
| v2.5.127 | 微信 Bot 看懂图片：看图描述写进随手记并回读 |
| v2.5.122–126 | 微信图片链路打通：确证 AES-128-ECB + PKCS7、地址/密钥多形态兜底、真实报文离线枚举 |
| v2.5.121 | 微信图片随手记（先落待存位，回「记录」才写成带图随手记） |
| v2.5.110–120 | ClawBot 改造成 chat-first 私人伴侣（三层记忆、主动关怀、对话记忆）+ 深色主题与材质/工程债清理 |
| v2.5.99–109 | R2 接入（图片迁出 D1、备份上云、云端书库）、阅读器进度双向同步、「关于我」档案可视编辑 |
| ≤ v2.5.98 | 外链解析移除与 SSRF 清理、离线 PWA 健壮性、安全加固与会话升级、Cmd+K 命令面板、RAG 深度进化 |
| 工作树内 | ClawBot 接入、P0–P3 优化批次（结论已并入上方版本） |

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

弱网推送可用代理：`HTTP_PROXY` / `HTTPS_PROXY=http://127.0.0.1:7897`（本机实际监听端口；旧文档写的 7888 已不再监听）

## 可选下一步

- AI 回响来源一键跳到对应周记/随手记；短多轮上下文
- 推送订阅失败静默
