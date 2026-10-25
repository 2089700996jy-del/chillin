# Chillin 项目进度记录

> 更新时间：2026-10-25。供后续会话快速接续。当前前端/Worker：**v2.5.154**（Worker 已部署、D1 迁移 0001–0031 已应用、R2 桶 `chillin-media` 已建且 21 张存量图片已搬迁；见「部署」）。

## 项目是什么

个人「数字花园」Web 应用（周记 / 笔记 / 收藏 / 随手记 / 提示词库 / TXT 阅读 / AI 记忆回响）。

- 前端：`public/index.html` + `public/style.css` + `public/app.js`（原生 HTML/JS，无框架）
- **目录布局**：全部站点资源位于 `public/`（Cloudflare Pages 的 build output directory）；下文模块地图中的 `js/...`、`app.js`、`sw.js` 等均指 `public/` 下的同名文件
- **链接卡片**：含链接的随手记渲染成链接卡片；**小宇宙链接**（v2.5.132 起）由微信 Bot 侧抓封面/标题/详情做成卡片（单集详情取 `description`、缺失时用 `shownotes` 去标签，播客页取简介；v2.5.140 起不再抓时长），回「记录」才落库；**抓取是尽力而为**——Cloudflare 出口 IP 已被小宇宙 403 封禁（2026-10-21 边缘探针确证，见 `bot-links.js` 文件头），失败时如实告知并给出「记录：<标题> <链接>」的手动路径（v2.5.135 起这条路径真的会落成带标题的卡片）；**v2.5.137 起多一条可选退路**：配了 `LINK_READER_API_KEY` 之后，直连失败会交给第三方读取服务代读一次（默认 `https://r.jina.ai`，可用 `LINK_READER_URL` 覆盖，用它的出口绕开这道封锁；没配密钥就完全不走这条路）；其它外链仍只做卡片展示、不做任何服务端抓取（`/api/link/parse` 已于 v2.5.97 移除）。历史条目里已存的元数据照常渲染
- 后端：Cloudflare Worker `workers/api.js` + 模块化子域 `workers/src/`（REST）
- 数据库：Cloudflare D1（`migrations/0001`–`0031`；远端应用状态以 `npm run ship` 的迁移检查为准）
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

**后端分层**（`workers/`：网关 `api.js` + `src/` 25 个领域模块）：
- 安全原语：`security.js`、`security-network.js`、`security-crypto.js`
- 鉴权：`auth.js`
- 花园业务域：`garden-shared.js`、`garden-resources.js`、`garden-sync.js`、`garden-media.js`、`garden-books.js`、`garden-echo.js`
- 智能与记忆：`ai.js`、`rag.js`、`llm.js`
- 审计与定时编排：`audit.js`、`maintenance.js`
- Bot：`bot-commands.js`、`bot-memory.js`、`bot-claw.js`、`bot-reminders.js`、`bot-web.js`、`bot-search.js`、`bot-media.js`、`bot-vision.js`、`bot-outreach.js`、`bot-links.js`

## 近期已完成（摘要）

> 逐版本完整记录（47 条，含未发布的工作树内改动至 v2.5.140）已归档至 [`docs/archive/PROGRESS-历史详情.md`](docs/archive/PROGRESS-历史详情.md)；提交级日志见自动生成的 [`CHANGELOG.md`](CHANGELOG.md)。本文件只保留「接续工作所需的现状」，需要某一版的动机、证据与实测数据时去归档文件里搜版本号。

| 版本 | 交付要点 |
| :--- | :--- |
| v2.5.151 | 顶栏/底栏与页面「浑然一体」：新增 `--bg-rgb` 分量令牌（亮 `248, 249, 250` / 暗 `15, 17, 21`），导航玻璃层与底栏全部由它派生（删掉第二套取色 `--nav-glass`）；顶栏静止态改透明，让 hero 光晕一直铺到状态栏、滚动才升玻璃底，iOS PWA 不再常驻玻璃底（原先状态栏区域是一条白带）；底栏改 `var(--bg-color)` 并去掉 `!important`——夜间/护眼阅读器的底栏覆盖（`--black` / `--mint-200`）终于生效；深色投影只在 `.scrolled` 出现，静止态「零线零影」。headless 逐像素复测：改前栏底 ΔR≈20 台阶、底栏比页面低 6/7/3，改后亮色 y=106→108 是 228/239/246→228/240/247（无台阶）、底栏与页面同为 248/249/250，深色底栏 15/17/21；新增 `--bg-rgb` 与 `--ios-bg` 同值静态门禁，`!important` 棘轮 230→229 |
| v2.5.152 | 底栏「去线 + 毛玻璃通透」（用户反馈「有条线分割视觉卡在还不够通透统一」）：根因是上一版把底栏做成**不透明 `var(--bg-color)` 板 + 一条 `0 -1px 0` 顶边线**——与页面同色不等于浑然一体，那条线就是把界面切断的「卡」；现底栏直接复用**滚动后顶栏的同一块材质** `--nav-scrolled-bg`（88% 页面分量）+ `backdrop-filter: blur(20px) saturate(180%)`，`box-shadow: none`、不再画任何分割线（保留不可见的 `border-top: 1px solid transparent` 供阅读器覆盖改色），不新增任何令牌。真机逐像素（390×844 dsf2，纯 stylesheet 无行内覆盖）：静止态栏上 y=780 与栏内 y=781 都是 248/249/250（连续无台阶，旧态此处是 227/229/234 的线）；滚动 150px 后卡片从栏下经过被柔化成底纹（`backups/_nav_real_scrolled.png`）；6 档材质（不透明 / 88% / 80% / 72% / 有无投影）对照图 `backups/_nav_glass_stack.png` 选定 88% 无投影。门禁同步：`tests/css.test.mjs` 把「底栏必须铺 `var(--bg-color)`」换成三条断言（材质令牌、模糊参数、禁止 `0 -1px 0`），`!important` 229 与 `backdrop-filter` 41 两条棘轮均不变 |
| v2.5.153 | 长列表「滑到底」批次（用户反馈周记/随手记越来越多、往下滑很久）：①**A1 紧凑行**——纯文字 ≤60 字的随手记密度收窄（内边距 18/20→10/14、正文 14px/1.5、双类选择器 `.feed-item-card.feed-item-card--compact` 避开后部同优先级覆写），51 条真实列表 **8679px → 7759px（10.3 屏 → 9.2 屏）**；②**B1** 卡片 `content-visibility: auto` + `contain-intrinsic-size: auto 150px`（紧凑 76px），510 条一次性强制布局 **103ms → 11ms**，周记画廊因桌面 `column-count: 2` 刻意不加；③**B2**「加载更多」改 `IntersectionObserver`（提前 600px）自动续载、保留无 IO 浏览器的手动兜底；④**C1** 滚过 1.5 屏浮出 44pt「回到顶部」圆钮，FAB 在场时 `.above-fab` 上移一格不叠角；⑤**C3** 修搜索跳转失联——随手记首屏只渲染 100 条，命中条目落在窗口外时旧的 `document.querySelector` 查不到、点了搜索**静默无反应**，现由 `actions.ensureItemRendered` 先扩整页窗口再重查。测试 295 → **298 用例**（css +1、search +2）。**未达此前口头估算的 ~5 屏**：阈值只命中 32/51 条，其余 19 条带图/带链接仍是 217px 卡片 |
| 工作树 | 底栏选中态改 Apple HIG 实心字形（filled variant），并解开被 `!important` 压死的主题色：①**实心字形**——5 个 Tab 在 `public/index.html` 里各配一组手绘实心字形 `.tab-svg-fill`，选中时实心显示、描边隐藏、标签加粗；删掉 `.active .tab-icon { translateY(-2px) scale(1.12) }`（按下缩放已由全局 `:active` 的 `scale(0.95)` 提供，叠加会「按住发软、松手浮起」），选中图标几何 **26.88px → 24px**、与未选中同基线；②**主题色复活**——`public/style.css:6517` 的重复覆写组整组删除（含 3 处 `!important`），`!important` **229 → 226**，被它压死的 `body.dark-reader-body`（纯黑底 + `--ios-blue-dark`）与 `body.eyecare-reader-body`（薄荷底 + `--garden-green`）覆盖终于生效，另补深色层 `:root[data-theme="dark"] .mobile-tab-item.active { color: var(--ios-blue-dark) }`（#0A84FF 对比度 5.18 优于 #007AFF 的 4.70）；③**无障碍**——`nav` 补 `aria-label="主导航"`、选中项运行时 `aria-current="page"`（`public/js/router.js` 同步 remove/set）、FAB 的 `aria-label` 随视图更新。CDP 四态（亮/暗/夜间/护眼）computed style 与截图均已复核；新增 2 个用例（css 17、a11y 6） |
| v2.5.150 | 联网搜索「搜不出东西」的两处根因：①闸门漏判——「查看一下76人下次比赛是什么时间」既不匹配显式检索词，时效性词表里也没有「比赛 / 下次 / 什么时间」，于是走了聊天路径把自己上一轮的旧来源复述了一遍（看着像检索结果，且没落缓存）；现在 `EXPLICIT_WEB_RE` 认「查看一下」，`FRESH_TOPIC_RE` 补「比赛 / 开赛 / 下一场 / 下次 / 接下来」，`QUESTION_SHAPE_RE` 补「什么时间 / 哪一场 / 第几场」；②一条自然语言整句打不中就再没有机会——改为先用一次 4s 死线的规划调用（`planWebQueries`）把问题改写成 1–2 条搜索框风格的关键词，与原句一起最多 3 条并行检索（`runWebSearchMulti`），按 URL 去重保留 `rerank_score` 更高的副本再按分数排序；实测「76人 下一场比赛 时间 赛程」507ms 就命中直播吧赛程正文（10月25日主场雄鹿 / 10月26日主场活塞）；检索客户端死线 20s→12s（实测 330–530ms），规划 4s + 检索 12s + 合成 20s = 36s 仍不占满一轮 cron 收信预算（55s） |
| v2.5.149 | 联网答案更像 DeepSeek 应用：请求带 `need_content`（赛程表/比分这类事实只在网页正文里，实测 8 条约 50 KB、耗时 485ms→524ms 几乎不变），候选 5→8、单条上限 1200→3000 字、提示词上下文 5000→12000 字；相对时间（今天 / 这周周六周日）解析成具体日期并进查询词——检索端没有「现在」是哪天的语境，这是「明明有赛程却答没查到」的真凶；新增时区规则（网页多给当地时区，NBA 默认美东，换算成北京时间并说明差异）；上游适配层拆到 `workers/src/bot-search.js`，给 `workers/src/*` ≤500 行红线留出余量 |
| v2.5.146–148 | 联网检索上游从 Jina 换成 DeepSeek 官方 Search：`POST /v1/tools/search` 复用 `LLM_API_KEY`，`ori_question` 带用户原话，`summary` 与站点/东八区日期进提示词（实测 417ms 出 5 条；Jina 同查询 1533ms 且无日期站点）；Jina 保留为回落开关，半截 JSON 仍一律当没有来源；限流改成只拦真正出站（缓存命中不再扣额度），日上限 20→100 且 `WEB_DAILY_LIMIT` 可配，新增每分钟 2 次突发闸 `WEB_BURST_LIMIT`；联网答案默认不再附来源，追问「来源 / 依据 / 哪查的」时才把上一轮存下的出处原样还给他（不再出站），缓存里仍存全量；`EVIDENCE_RE` 补上「怎么查 / 怎么来 / 哪查的」 |
| v2.5.145 | 联网检索不再「超时」：上游改摘要模式（`X-Respond-With: no-content`）+ 10s 服务端超时，客户端两道死线（检索/合成各 20s）合计不占满收信预算，半截 JSON 一律当没有来源；时间锚点补星期；自测提醒留下的噪声已从对话/提醒/缓存三表软删 |
| v2.5.144 | 工程债清零批次：`!important` 用真浏览器逐元素 computed style 审计（182 上下文）证明零回归后删 66 处（296→230）、裸 hex 令牌化 501→126 并加棘轮、`quick_feeds.created_at` 默认值改东八区（0031）、SW 缓存写入改挂 `waitUntil` |
| v2.5.143 | Bot 定点提醒（到点主动开口、30 分钟追问一次、回「完成」沉淀成随手记）与联网检索（按来源作答附出处、6 小时缓存、每日 20 次上限） |
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
