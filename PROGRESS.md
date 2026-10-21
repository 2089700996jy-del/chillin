# Chillin 项目进度记录

> 更新时间：2026-10-21。供后续会话快速接续。当前前端/Worker：**v2.5.133**（Worker 已部署、D1 迁移 0001–0028 已应用、R2 桶 `chillin-media` 已建且 21 张存量图片已搬迁；见「部署」）。

## 项目是什么

个人「数字花园」Web 应用（周记 / 笔记 / 收藏 / 随手记 / 提示词库 / TXT 阅读 / AI 记忆回响）。

- 前端：`public/index.html` + `public/style.css` + `public/app.js`（原生 HTML/JS，无框架）
- **目录布局**：全部站点资源位于 `public/`（Cloudflare Pages 的 build output directory）；下文模块地图中的 `js/...`、`app.js`、`sw.js` 等均指 `public/` 下的同名文件
- **链接卡片**：含链接的随手记渲染成链接卡片；**小宇宙链接**（v2.5.132 起）由微信 Bot 侧抓标题/封面做成卡片（单集另带播客名与时长，播客页带简介），回「记录」才落库；其它外链仍只做卡片展示、不做任何服务端抓取（`/api/link/parse` 已于 v2.5.97 移除）。历史条目里已存的元数据照常渲染
- 后端：Cloudflare Worker `workers/api.js` + 模块化子域 `workers/src/`（REST）
- 数据库：Cloudflare D1（`migrations/0001`–`0028`；远端应用状态以 `npm run ship` 的迁移检查为准）
- 对象存储：Cloudflare R2 桶 `chillin-media`（绑定 `MEDIA`）——图片二进制 `uploads/<userId>/<id>`、D1 备份快照 `backups/`、阅读器书籍正文 `books/<userId>/<sha256>.txt`；D1 只保留元数据
- 站点：Pages `https://chillin-bfc.pages.dev` + Worker `https://chillin-api.2089700996jy.workers.dev`
- GitHub：`https://github.com/2089700996jy-del/chillin`
- 版本：用 `npm run bump` / `npm run bump:patch` 一键对齐 **8 处**：`public/js/version.js`、`public/version.json`、`workers/api.js`、`public/sw.js`、`public/index.html`、`package.json`、`PROGRESS.md`、架构报告（`tests/docs.test.mjs` 实跑 `--dry-run` 校验覆盖范围）
- 测试：`npm test` 原生零依赖单测套件（`node --test`）
- 形态：Web / PWA（Pages）；已移除 Capacitor Android 工程

## 模块地图

### 前端
依赖方向：`app.js`（编排）→ 业务模块 → `api.js` facade → `auth.js` / `sync.js` → `state` / `utils` / `config`。

| 文件 | 职责 |
|------|------|
| `app.js` | DOMContentLoaded 编排：挂 hooks、init 各域、鉴权与自动同步 |
| `js/config.js` | Worker Base URL、`resolveApiBase`（避免循环依赖） |
| `js/version.js` | 可见版本号 `APP_VERSION` |
| `js/state.js` | 共享可变状态与默认种子数据 |
| `js/utils.js` | 纯函数工具（escapeHtml、东八区时间等） |
| `js/actions.js` | 跨模块晚绑定动作表（避免循环 import） |
| `js/ui.js` | UI 瞬态标志 |
| `js/auth.js` | 登录/登出、`apiRequest`、push 订阅 |
| `js/sync.js` | 本地持久化、增量同步（聚合pull+并发回退+Delta Push）、自动同步引擎 |
| `js/api.js` | **薄 facade**：再导出 auth+sync，业务仍 `from './api.js'` |
| `js/router.js` | Hash 路由与视图切换 |
| `js/weeklies.js` | 周记画廊/编辑/批注 |
| `js/notes.js` | 笔记列表/编辑/批注 |
| `js/bookmarks.js` | 收藏（仅新建） |
| `js/prompts.js` | AI 提示词库（筛选、填词、直发 AI） |
| `js/feeds.js` | 随手记流、热力图 |
| `js/reader.js` | TXT 阅读器 |
| `js/echo-ai.js` | AI 回响卡片与对话（带记忆来源交互跳转） |
| `js/search.js` | 全局搜索 |
| `js/upload.js` | 图片上传 |
| `js/pwa-update.js` | SW 注册、版本探测、强制刷新 |

### 后端 (Worker)
| 文件 | 职责 |
|------|------|
| `workers/api.js` | 调度入口：网关路由、CORS 预检、鉴权闸门、定时任务调度 |
| `workers/src/security.js` | 安全核心：PBKDF2、魔数嗅探、限流、时序比较；服务端出站抓取已移除，若重引入须恢复 SSRF 校验 |
| `workers/src/auth.js` | 认证会话：注册、登录、登出、用户信息、Web Push 订阅 |
| `workers/src/garden-shared.js` | 行格式化、归属校验、软删墓碑查询与惰性 schema 守卫 |
| `workers/src/garden-media.js` | 图片上传（二进制入 R2，D1 只存元数据）、带令牌与 Range 的下发、R2 备份快照保留策略 |
| `workers/src/garden-books.js` | 阅读器云端书库：TXT 正文入 R2、书目元数据、跨设备下载与软删墓碑 |
| `workers/src/garden-resources.js` | 周记/笔记/收藏/提示词/随手记 的 CRUD 与软删 |
| `workers/src/garden-sync.js` | 聚合拉取 `/api/sync/pull`、脏数据批量推送、热力图 |
| `workers/src/garden-echo.js` | AI 回响卡片、周期回顾、Web Push 通知、UGC 审计入口 |
| `workers/src/rag.js` | 记忆检索：全表（含 prompts）索引、分词、多轮主题继承、打分 |
| `workers/src/llm.js` | 模型集成：DeepSeek/Workers AI 调用、流式 SSE、内容合规审查 |
| `workers/src/audit.js` | 定时审计：Cron UGC 违规扫描与隔离区备份、过期 Session 清除 |
| `workers/src/bot-commands.js` | Bot 对话编排（chat-first）：默认只聊天不落库、显式「记录：…」才入随手记、「记住/忘记」维护档案、幂等排重、检索与 Echo AI 独立限流、来源脚注只在用户追问依据时附上（来源标签统一成 `[类型] YYYY-MM-DD`） |
| `workers/src/bot-memory.js` | Bot 私人记忆：最近 8 轮对话上下文（字符预算截断）与「关于我」档案条目增删查（一律软删）+ 应用内 `/api/bot/profile` 读写接口（增/改/单条遗忘/清空） |
| `workers/src/bot-claw.js` | 外部 IM 接入：微信 ClawBot（iLink 协议）扫码绑定、每分钟 Cron 长轮询与游标幂等、经 sendmessage 回发文本 |
| `workers/src/bot-media.js` | Bot 图片接入：微信图片消息（`item.type=2`）→ 下载 → 明文魔数嗅探，嗅不出再用 `aeskey` 走 AES-128-ECB + PKCS7 解密 → 经既有上传通道写 R2 并进「待存位」（默认不落库，用户回「记录」才写成带图随手记，见 `0027_bot_pending_media.sql`）；取不到原图只如实告知、绝不落库；全程不记正文 |
| `workers/src/bot-outreach.js` | Bot 主动关怀：东八区 10:00–22:30 时窗内每天至多一次的随机开口、刚聊完 30 分钟内不插嘴（6 小时内聊过则不等当天固定时刻，改在聊完 30–120 分钟内把最近对话当背景）与只用 3–180 天前旧素材的门禁、模型 SKIP 与概率闸门、账号级开关与发送审计；主动发出的消息同时写进对话记忆（带出处），用户回一句就能对上 |
| `workers/src/maintenance.js` | 定时任务编排：按 Cron 分流（每分钟只跑 ClawBot 轮询，整点第 13 分跑 UGC 扫描与清理） |

## 近期已完成（摘要）

### 小宇宙播客页不再张冠李戴，http 链接也不再沉默（v2.5.133）

1. **线上实测发现的错卡**：发播客页链接（`/podcast/<pid>`）时，卡片回来的是「基本无害 Mostly Harmless / 听播客，上小宇宙 · 1:13:16」——播客页上混着 33 个单集各自的 `"duration"`，抠第一个必然把某一集的时长按到这个播客头上；`<title>` 第二段在播客页是站点模板尾巴，不是播客名。
2. **修复（`workers/src/bot-links.js`）**：`parseXiaoyuzhouPage(html, { kind })` 按页面类型分流——播客页只取 `og:description` 当简介（压平空白、截 160 字），绝不给时长；单集页照旧「播客名 · 时长」；站点模板尾巴（`听播客` / `上小宇宙` / 恰好等于 `小宇宙`）不再冒充播客名。
3. **http 链接不再沉默**：`extractFirstUrl` 也会抓 `http://`，而白名单只放 https，旧行为是**直接回落普通聊天**（用户会以为 Bot 没看懂）。新增 `xiaoyuzhouHostOf(rawUrl)` 只判域名，命中就如实说一句「这个链接是 http 的，我只会读 https 的页面。改成 https 再发我一次？想原样存就发「记录：<链接>」」，仍然一次都不出站。
4. **测试**：`tests/bot-claw.test.mjs` 56 → **58 用例**（播客页只取简介 + 模板名不冒充 + `xiaoyuzhouHostOf` 正反例；http 链接零出站且给兜底路径）。

**测试 246 → 248 用例（20 套件）**；PROGRESS、`.agents/rules/architecture.md` 与架构报告同批更新。

### 微信 Bot 小宇宙链接速览：抓标题/封面做卡片，回「记录」才落库（v2.5.132）

- **问题**：小宇宙单集链接发进微信只存成一条光秃秃的 URL（`quick_feeds` 里已躺着 3 条），而前端 `public/js/feeds.js` 早就支持结构化 `summary` → 富链接卡片；缺的只是服务端那一次「替浏览器读元数据」。
- **解析**：新增 `workers/src/bot-links.js`，只认 `www.xiaoyuzhoufm.com/episode|podcast/<id>`。线上实测：单集页 169529 字节 HTML，`og:title` = 单集标题、`<title>` 第二段 = 播客名、内联 JSON 的 `"duration":6592` 给时长；封面 `og:image`（`image.xyzcdn.net`）无防盗链，转存 R2 后写自家 `/api/file/...`。
- **默认无副作用**（沿用图片那条确认路径）：卡片 JSON `{title, description, cover, platform:'小宇宙', icon:'🎧'}` 进「待存位」（`0028_bot_pending_summary.sql` 给 `bot_pending_media` 加了 `summary` 列），回「记录」才连同原始链接写进 `quick_feeds.summary`（`type='link'`）；前端零改动。
- **出站边界**（见 `.agents/rules/security.md` §3）：只认 `xiaoyuzhoufm.com` 与图床 `xyzcdn.net`、强制 https + 443、无 userinfo、手动跟重定向并逐跳复核域名、6 秒超时、HTML 512KB / 封面 4MB 上限、IP 字面量与私网主机拒绝；**白名单之外的链接一次都不出站**（原样交回聊天）。解析失败如实说明并给出「记录：<链接>」兜底。
- **测试**：`tests/bot-claw.test.mjs` 新增 5 例——纯解析、全链路落库、聊天入口路由 + 非白名单零出站、抓取失败/超限不占坑、重定向到白名单外立刻停下。

### 图片回信提速：瞬时 5xx 不再丢收信窗口，存图与看图并行（v2.5.131）

1. **实测延迟**（远端 D1 按去重键里的 `create_time_ms` 反推微信消息时刻）：三张图从发出到回信分别约 12s、13s，第三张 **54s**。拆分后一段是「取信 → 下载 / 解密 → 入 R2」（约 8–9s），另一段是「待存位 + 看图 + 回发」（约 2–4s）；54s 那次 `bot_claw_accounts.last_error` 正是 `getupdates http 520`。
2. **根因（`workers/src/bot-claw.js`）**：`pollAccountUntilDeadline` 里 `fetchClawUpdates` 一抛错就冒出 `do…while`，`pollClawAccounts` 的 per-account try/catch 只记一笔 `last_error`，于是**整分钟的长轮询窗口被丢掉**，那条消息只能等下一个整分 cron（实测 22:00:46 → 22:01:30 才被取走）。
3. **修复**：同一 deadline 内退避重试（`POLL_ERROR_BACKOFF_MS = 1000`、上限 5000，`sleep` 再用剩余预算封顶；单测用 `options.errorBackoffMs` 压到几毫秒），应用级 `ret !== 0` 仍照旧只记错；`workers/src/bot-media.js` 把 `storeClawImage` 与 `describeClawImageContent` 改为 `Promise.all` 并行——回信只等较慢的那个，不再串行等 R2；`workers/src/bot-vision.js` 的 `VISION_MAX_TOKENS` 200 → 120（描述目标 ≤40 字，留一倍余量）。
4. **测试**：`tests/bot-claw.test.mjs` 50 → **51 用例**（新增「瞬时 5xx 不丢整分钟的收信窗口：退避后接着拉，消息当轮就回」——第一轮 503、第二轮交消息，断言至少两次 getupdates、当轮回信、对话上下文两条；既有「budgetMs 0 + 503 只记 last_error」用例不变）。

**测试 240 → 241 用例（20 套件）**；PROGRESS、`.agents/rules/architecture.md` 与架构报告同批更新。
### 看图回信去掉「我看到：」前缀，且只描述不猜归属（v2.5.130）

1. **用户反馈两点**（真机实拍）：不该用「我看到：」开头；也不该说「你家这只长毛猫」——她并没有告诉过 bot 家里有猫，那是模型看图时自己认了归属。
2. **`workers/src/bot-media.js:436-438`**：有描述时回信就是那句描述本身 + 「要存进随手记就回我『记录』」，不再加前缀；没有描述时的兜底文案不变。
3. **`workers/src/bot-vision.js:17-18`** 提示词补一条硬约束：只说你看到的，别猜是谁的、别用「你家」「你的」这类归属说法（其余约束与所有行为——密钥、模型、超时、截断、失败回空串——都不变）。
4. **测试**：`tests/bot-claw.test.mjs:1124` 改为断言回信**以描述开头**且不含「我看到：」（看图失败那条仍断言不编造），`tests/bot-claw.test.mjs` 仍 50 用例。

**测试 240 用例（20 套件，数量不变）**；PROGRESS、`.agents/rules/architecture.md` 与架构报告同批更新。
### 看图描述改成「朋友随口说一句」的口气（v2.5.129）

1. **动机**：旧提示词「用一句不超过 30 字的中文说这张图里有什么，只输出描述本身。」在真图上常退回标签腔，甚至复述「这张图 / 画面中」，读起来不像聊天。
2. **真图 A/B**（同一张线上图、同一把密钥）：旧词在两张真图上都空回复；新词在 ChatGPT 截图上给出「你开了 ChatGPT 的临时聊天，说不留历史记录，现在对着空输入框发呆呢。」——带人称、带细节、不念标签（另一张 Gemini 截图两种提示词都空回复，属模型偶发，不能赖提示词）。
3. **只动提示词**：`workers/src/bot-vision.js:17-18` 换成朋友口气的一段话（≤40 字、禁用「这张图 / 画面中」这类复述、是截图就点出是什么应用、在讲什么）；密钥、模型、8 秒超时、120 字截断、「失败一律回空串」的行为全部不变。
4. **测试**：用例本就不耦合提示词原文（断言的是「我看到：…」的结构与失败时不带描述），`tests/bot-claw.test.mjs` 仍 50 用例。

**测试 240 用例（20 套件，数量不变）**；PROGRESS、`.agents/rules/architecture.md` 与架构报告同批更新。
### 微信 Bot 图片改为「先描述、说「记录」才入库」（v2.5.128）

1. **默认无副作用**（用户要求：图片先描述，只有说「记录」才存进随手记）：图仍然下载、仍然进 R2 与 `files`（拿到稳定的 `/api/file/...` 地址），但**不再自动写 `quick_feeds`**，改为进「待存位」；回信把描述说给用户（`我看到：…`）并附一句「要存进随手记就回我『记录』」。
2. **新增 `migrations/0027_bot_pending_media.sql`**：`bot_pending_media(user_id INTEGER PRIMARY KEY, media_url, content, created_at DEFAULT datetime('now','+8 hours'), is_deleted)`——每人只留最新一张（UPSERT 覆盖），**60 分钟**未确认即作废（读取时用 `datetime(created_at,'-8 hours') >= datetime('now', ?)`，东八区口径不能直接和 UTC 比）。该表不在 `garden-shared.js` 的 `OWNED_TABLES` 里，因此不进前端同步通道。
3. **`workers/src/bot-memory.js`** 新增 `savePendingMedia` / `readPendingMedia` / `clearPendingMedia`（确认落库后软删，用户数据永不物理删除）；`workers/src/bot-media.js` 改走待存位，并把「图片 + 描述」这一轮也写进对话上下文（用户接着说「这张图不错」才有指代可继承）。
4. **`workers/src/bot-commands.js`** 新增光杆「记录」确认指令 `PENDING_COMMIT_RE`：**必须排在 `RECORD_RE` 之后**，否则会抢走「记录：内容」；有待存图就落库并清位，没有就如实回「这会儿没有等着存的图片」，绝不丢给模型导致它误答「已存」。帮助文本与模块头注释同步更新。
5. **测试**：`tests/bot-claw.test.mjs` 48 → **50 用例**（三条既有集成改为断言「未确认前 0 条随手记 + 待存位有图 + 回信不说已存」；新增两条：过期待存图不会翻旧账、「记录：内容」不被待存确认抢走）。

**测试 238 → 240 用例（20 套件）**；README（迁移 26→27、`0001–0027`）、PROGRESS、架构报告同批更新。
### 微信 Bot 看懂图片：看图描述写进随手记并回读（v2.5.127）

1. **线上探针先证可行性**（临时路由用完即撤）：用 `VISION_API_KEY` 打 DeepSeek 官方端点——`GET /v1/models` 只有 `deepseek-flash` / `deepseek-v4-pro`；R2 里那张 202614 字节 JPEG 以 data URL 发出，**`deepseek-chat` 1355ms 返回准确中文描述**（`prompt_tokens` 960）；`deepseek-flash` 是带 `reasoning_content` 的思考模型，max_tokens 被思考吃光后 `content` 为空——所以默认模型定为 `deepseek-chat`。
2. **新增 `workers/src/bot-vision.js`**：`describeClawImageContent(env, bytes, mime, fetchImpl)` 走 OpenAI 兼容的 `chat/completions`，密钥 `VISION_API_KEY`（缺省回落 `LLM_API_KEY`）、地址与模型可被 `VISION_API_BASE` / `VISION_MODEL` 覆盖，8 秒超时 + 描述压平空白并截断 120 字 + 过 `moderateText`。
3. **失败绝不拖累存图**：没密钥 / 非 2xx / 网络异常 / 空回复 / 内容安全拦截，一律返回空串——`handleClawImageMessage` 照常写 R2 与随手记；有描述时正文是「配文 + 描述」、回信变成「> 我看到：…」，没有描述就退回原来的「来自微信的图片」并只报「已存入」，绝不编造。
4. **测试**：`tests/bot-claw.test.mjs` 45 → **48 用例**（看图纯函数：取回/压平/截断/无密钥零请求/500/网络抛错/空白/硬违规丢弃/软违规打码；两条集成：描述与配文一起落库并回读、看图失败仍照常存图且不提描述）。

**测试 235 → 238 用例（20 套件）**；README（workers/src 20→21 模块）、`.agents/rules/architecture.md`（模块表新增 `bot-vision.js`）与架构报告同批更新。
### 微信 Bot 图片：真实报文离线枚举，确认是 AES-128-ECB + PKCS7（v2.5.126）

1. **第五次真机验证**仍是 `not-an-image:202624`；这一版把失败时下到的**密文与密钥候选**暂存进用户自己的 R2（`probe/` 前缀），取回本地用 `node:crypto` 做「密钥 × 模式 × IV」全枚举。
2. **结论**：`AES-128-ECB` + PKCS7，密钥就是 `item.aeskey`（32 位 hex = 16 字节）——解出来是 1080×2400 的 JPEG（202614 字节），解密耗时 8 ms。此前试的 CBC（IV=密钥前 16 字节 / 全零）与 AES-256 全部否证，`media.aes_key` 的 32 字节是干扰项。
3. **一直没试出来的原因**：WebCrypto 只提供 CBC / CTR / GCM，没有 ECB，所以过去只试了 CBC。
4. **实现**：`workers/src/bot-media.js` 自带一份纯 JS 的 AES-128-ECB 解密（查表实现 + PKCS7 去填充），与 `node:crypto` 逐字节对齐；`downloadClawImage` 改为 **ECB 优先**、CBC 两种 IV 兜底。
5. **临时诊断已撤**：R2 的 `probe/` 对象与本地副本分析完即删；日志仍只记形状与响应前 8 字节，正文与密钥绝不进日志。

**测试 232 → 235 用例（20 套件）**；README、`.agents/rules/architecture.md` 与架构报告同批更新。
### 微信 Bot 图片：参数名两种拼法 × 原值/编码值，并打印每个响应的形态（v2.5.125）

1. **第四次真机验证**：`note=not-an-image:202624 head=40f8fbc90cc45d75`，`keyKinds=["item:hex-16","media.aes_key:base64-32"]`（**没有** `media.aes_key>hex`——上一版的「hex 中间层」假设被否证），`mediaHost=novac2c.cdn.weixin.qq.com`，`sizes=[2356,294033,294033]` 而两个地址下到的都只有 202624 字节。
2. **新判断**：两张**不同**照片下到的密文长度完全相同、且既不等于 mid 也不等于 hd 尺寸，说明问题多半不在密钥，而在于**我们没下到真正的对象**（授权参数拼法不对）。
3. **地址形态**：`clawImageUrlCandidates()` 现在把授权参数按 `encrypt_query_param` / `encrypted_query_param` **两种参数名**、原值与 `encodeURIComponent` 后**两种值形态**都产出候选（去重、上限 6 条）。
4. **诊断**：`downloadClawImage()` 新增 `probes`，逐条记录每个地址的 `status / content-type / 长度 / 前 8 字节 / 重定向后的最终路径`，失败日志直接打印；`describeClawImage()` 增 `mediaPath` 与 `mediaQueryKeys`（只看路径与参数名，不含参数值，正文依旧绝不进日志）。

**测试仍 232 用例（20 套件）**（本版只放宽既有断言，未新增用例）。
### 微信 Bot 图片：密钥中间层、全零 IV 与「响应头字节」诊断（v2.5.124）

1. **第三次真机验证**：`note=not-an-image:202624 tried=direct+item:hex-16:fail,direct+media.aes_key:base64-32:fail,encrypt_query_param+item:hex-16:fail,encrypt_query_param+media.aes_key:base64-32:fail` —— 两个地址下到的是同一份 202624 字节密文（长度仍是 16 的倍数），但 `media.aes_key` 解出来是 **32 字节**，说明它很可能不是最终密钥。
2. **新假设**：有些实现会把 16 字节密钥先写成 32 位 hex、再对这一整串做 base64；于是新增 `unwrapHexAsciiKey()`——若 base64 解出来是 32–64 位纯 hex，就再解一层，并把 `media.aes_key>hex` 作为额外候选密钥。
3. **IV 兜底**：`decryptClawImage` 增加第 4 个参数 `ivMode`（`'key'` 用密钥前 16 字节、`'zero'` 用全零 IV），每个密钥两种 IV 各试一次。
4. **诊断**：失败原因码现在带 `head=`（下载内容前 8 字节的十六进制，如 `3c21444f43` = `<!DOC` 说明 CDN 回的是错误页；`77786766` 则是微信私有的 `wxgf` 容器，会额外标 `wxgf`），tried 列表也带上了 `:iv0` 变体。
5. **顺带修掉一个真 bug**：`headHex(null)` 会在「一个地址都没下到」（例如 404）时抛 `Cannot read properties of null (reading 'slice')`，导致整条消息处理失败、用户连「拿不到原图」的回复都收不到；已加空值兜底并补了回归用例。

**测试 231 → 232 用例（20 套件）**；README、`.agents/rules/architecture.md` 与架构报告同批更新。

### 微信 Bot 图片：地址与密钥多形态兜底（v2.5.123）

1. **第二次真机验证**（用户重发照片）：抓到 `note=not-an-image:202624/hex-16`，`media` 对象的键是 `["encrypt_query_param","aes_key","full_url"]` —— item 级 `aeskey` 确实能解码出 16 字节，但解出来的不是图片；真正能解开的是 `media.aes_key`，真正能下到图的地址还需要拼回授权参数。
2. **修复**：新增 `clawImageUrlCandidates`（直链 + 把 `encrypt_query_param`/`encrypted_query_param` 拼回查询串，去重、最多 3 条）与 `clawImageKeys`（`item.aeskey` / `media.aes_key` / `media.aeskey` / `media.key`，去重并保留来源标签）；`downloadClawImage` 改成「地址 × 密钥」逐对尝试，任一对嗅出真实魔数才认账，且只把那一份解密结果写进 R2。
3. **诊断升级**：`describeClawImage` 增 `keyKinds` 与 `urlVariants`；全部失败时原因码带 tried 列表（如 `direct+item:hex-16:fail`），并附响应前 8 字节的十六进制（`3c21444f43` 一眼看出 CDN 返回的是 `<!DOC` 错误页），依然不记正文、不记密钥内容。
4. **回归门禁**：新增两条用例——授权参数 + `media.aes_key` 的双层兜底成功；全部失败时的 tried 列表与 head 十六进制，把线上真实形状固化成测试。
5. **教训**：字段没有公开文档时，「多形态兜底 + 可判读原因码」比死猜单一形状更快收敛；AES-CBC 只有填充校验，能解开不等于解对了，最终必须靠魔数认账。

**测试 229 → 231 用例（20 套件）**；README、`.agents/rules/architecture.md` 与架构报告同批更新。

### 微信 Bot 图片：aeskey 是 hex，密文解密后才是真图（v2.5.122）

**动机**：v2.5.121 上线后请用户在微信里真发了一张照片，`wrangler tail` 抓到真实失败（这正是做线上验证的价值）。

1. **线上失败原文**：`[bot-media] 图片下载失败 note=not-an-image:313904 shape={"keys":["aeskey","media","mid_size","thumb_size","thumb_height","thumb_width","hd_size"],"mediaType":"object","mediaLen":0,"mediaHost":"","aeskeyLen":32,"sizes":[3428,313888,313888]}` —— 下载本身成功（313904 = 313888 + 16，正好是 PKCS7 补一整块的密文长度），但 `aeskeyLen=32` 说明它是 **32 位十六进制**（= 16 字节），而旧代码只按 base64 解，长度不等于 16 就被判为「没有密钥」，于是密文永远嗅不出魔数。
2. **修复**：`decodeAesKey` 同时接受 hex（32/48/64 位）与 base64，密钥长度支持 16/24/32 字节；`decryptClawImage` 的 IV 改为「`aeskey` 前 16 字节」（微信通例，AES-128 时即密钥本身，AES-256 时不再整段当 IV）。新增 `aesKeyKind()` 只报密钥种类与长度，供日志定位。
3. **可诊断性**：失败原因码升级为 `not-an-image:<字节数>/<密钥种类>`、解密成功但魔数仍不对则 `.../after-<密钥种类>`；形状日志补上 `media` 的嵌套键名与最终认到的地址主机——**依然不记正文、不记密钥内容**。
4. **回归门禁**：`tests/bot-claw.test.mjs` 新增「aeskey 兼容 32 位 hex 与 base64，AES-256 的 IV 仍取前 16 字节」，并把「图 + 文字」集成用例的密钥改为 hex（与线上真实形状一致）。
5. **教训**：下载成功 ≠ 拿到图片；「密文长度 = 明文长度 + 16」是识别 PKCS7 密文的实用信号。

**测试 228 → 229 用例（20 套件）**；README、`.agents/rules/architecture.md` 与架构报告同批更新。

### 微信 Bot 图片随手记（v2.5.121）

**动机**（用户 m03337：「bot能看图片吗 同时记录可以记录图片」）。此前收信侧只处理纯文本，图片消息被整条丢弃。

1. **报文形状靠实测确认**：临时探针只打印字段名/长度/URL 主机（绝不记正文）上线后确认——图片消息的**外层 `message_type` 仍是 1**，靠 `item_list[i].type === 2` 且带 `image_item` 识别；`image_item` 给出 `media`（地址）、`aeskey`、`thumb_size` / `mid_size` / `hd_size`。形状确定后探针已删除（`workers/src/bot-claw.js` 不再有 `sketchClawMessage`）。
2. **新模块 `workers/src/bot-media.js`**：`extractClawImageItems` / `resolveClawImageUrl`（`media` 是字符串或嵌套对象都能兜底认地址）/ `sniffImageMagic`（JPEG/PNG/GIF/WEBP 魔数）/ `decryptClawImage`（base64 `aeskey` → AES-128-CBC，**IV 即密钥本身**）/ `downloadClawImage`（下载→明文嗅探→不行再解密嗅探）/ `handleClawImageMessage`。任何一步失败都折叠成原因码，不抛异常。
3. **存图复用既有管道**：解密后的明文交给 `handleUpload`（5MB 上限 + 魔数嗅探 + 写 R2），拿回 `/api/file/<id>?t=<token>` 作为 `media_url`，再用扩展后的 `saveFeed(db, userId, content, mediaUrl)` 落一条 `type='image'` 的随手记——与前端上传走的是同一条链路，无新表、无新迁移。图 + 文字时文字自动成为正文，无文字时用「来自微信的图片」。
4. **克制与安全**：取不到原图或入库失败时只回「拿不到原图，再发一次试试」，**绝不宣称保存**（与 chat-first 的「默认无副作用」一致）；图片通道不经模型、不占对话限流桶，秒回；日志只打用户 id、字节数与原因码，正文与 `aeskey` 永不进日志。
5. **门禁**：`tests/bot-claw.test.mjs` 新增 6 条——图片 item 识别与地址兜底、魔数嗅探、`aeskey` 解密（含非法密钥）、发图落成带图随手记并回复且**不经模型**、图 + 文字时配文优先且密文先解密再入库、取不到原图时零写入、语音等类型静默丢弃。

**测试 222 → 228 用例（20 套件）**；README、`.agents/rules/architecture.md` 与架构报告同批更新。

### 深色模式下的链接对比度修复（v2.5.120）

**动机**（用户 m03226：真机深色截图里随手记那条网址「看不清」）。

1. **根因**：`public/style.css` 的 `.rich-link-title` 写死 Tailwind slate `#0f172a` ≈ rgb(15,23,42)，在深色卡片 `#1a1d23` 上对比度约 **1:1，等于隐形**；同族的 `#64748b`（链接描述 / 平台名 / 平台动作）、`#475569`（相片说明 / 平台名）、`#334155`（唱片描边）、`#94a3b8`（卡片日期）与 `.widget-music-disk` 的 `#0f172a` 底色共 **9 处**都是浅色专用灰，不随 `data-theme` 反转。
2. **链接色令牌化**：`:root` 新增 `--link-color: var(--ios-blue)`（深色层切 `#0A84FF`，Apple 深色系统蓝；`#007AFF` 在深底上只有约 4.3:1，偏暗），`.article-inline-link`（:1683）与 `.feed-content-text a`（:4061）统一走它；9 处 slate 分别改为 `var(--text-color)` / `var(--text-color-light)` / `var(--widget-bg)` / `rgba(var(--neutral-rgb), α)`。
3. **去掉 JS 内联色**：`public/js/feeds.js` 把正文里的 URL 自动链接化时写死内联 `style="color:#007AFF"` —— 内联样式优先于样式表，深色层覆盖不掉，改为交给 `.feed-content-text a` 规则；`public/js/daily-spark.js` 的 `var(--ios-blue, #007aff)` 同步改用 `--link-color`。
4. **回归门禁**：`tests/css.test.mjs` 新增第 13 条「深色下会失明的旧 Tailwind 色阶不得回归，链接色走 `--link-color`」——封禁 6 个 slate 字面量，并断言深色层 `--link-color: #0A84FF` 与两条链接规则存在。
5. **验证**：`backups/_linkfix_{dark,light}.html` 用真实标记与 `../public/style.css` 在 420×1400 无头 Chrome 出图，深色下标题变白字、正文链接变亮蓝、胶囊与描述可读，浅色维持原样。

**测试 221 → 222 用例（20 套件）**；README、`.agents/rules/ui-style.md` 与架构报告同批更新。

### 批次 A：应用级深色主题（跟随系统 + 手动开关）（v2.5.119）

**动机**（用户 m02613「先 B 再 A」：批次 B 清完 UI 工程债后做深色模式；此前只有阅读器的 `dark-reader-body` 有自己的深色规则，系统深色模式下主界面几乎全白）。

1. **主题开关**：`public/js/utils.js` 新增 `getAppThemeMode()` / `applyAppTheme()` / `setAppThemeMode()` / `initAppTheme()`，同时切 `html[data-theme]` 与 `<meta name="theme-color">`；`public/app.js` 在 DOMContentLoaded 之前调用 `initAppTheme()`；`public/index.html` 的 head 内联脚本读 `localStorage.chillin_theme` 在首帧前落属性（否则深色用户会先看到一帧白屏）；「账号与安全」弹层新增「外观」分段控件（跟随系统 / 浅色 / 深色），`public/js/auth.js` 负责标记选中态。`router.js` / `reader.js` 原本在切页时把 theme-color 硬复位成 `#F2F2F7`，改为调用 `applyAppTheme()`。
2. **深色令牌层**：`:root[data-theme="dark"]` 覆盖 `--bg-color` / `--ios-bg` `#0f1115`、`--card-bg` / `--ios-card-bg` `#1a1d23`、`--text-color` / `--ios-label` `#f2f2f7`、`--nav-bg` `#14161b` 与导航三态玻璃色、`--input-bg` / `--input-bg-focus` / `--hairline` / `--hover-bg`、`--segment-active-bg`、`--card-shadow` / `--card-hover-shadow` 的暗投影、`--danger-color` `#FF453A`、`--heat-1`~`4`（systemGreen 透明阶）。
3. **灰度分量令牌（本批核心决策）**：`:root` 把「标签灰」与「中性命灰」拆成 `--label-rgb: 60, 60, 67` / `--neutral-rgb: 120, 120, 128`，全库 66 处 `rgba(60, 60, 67, α)` 与 65 处 `rgba(120, 120, 128, α)` 改为 `rgba(var(--label-rgb), α)` / `rgba(var(--neutral-rgb), α)`；深色只反转分量，alpha 语义完全不变，浅色渲染逐像素 diff **maxDiff = 0**。由此省掉整组「中性表面深色覆盖」与逐条二级文字覆盖（也不会顶破 `!important` 棘轮）。
4. **两处真实缺陷修复**：`.feed-textarea` 文字 `#111827`、`.feed-content-text` `#1f2937` 在深底上几乎不可见 → 改 `var(--text-color)`；`.k-mood-chip` 的 `rgba(60,60,67,0.8)` 文字由分量令牌自动修复。另外把 10 处 `#ff3b30` / `#FF3B30` 收敛到 `var(--danger-color)`，`.bot-profile-add .btn-text` 加 `white-space: nowrap`（中文「记住」按钮曾被压成两行）。
5. **回归门禁**：`tests/css.test.mjs` 新增「深色主题层：RGB 令牌反转 + 五类主表面打底」「灰度色值一律走 RGB 分量令牌（禁止写回字面量）」两条；`tests/a11y.test.mjs` 新增「外观控件有可访问名称与三个可辨认选项，且首帧前已应用主题」一条；`.agents/rules/ui-style.md` 新增「主题令牌纪律（v2.5.119 起）」。
6. **验证**：真浏览器 `getComputedStyle` 逐元素核对 21 个主表面（首页 + 账号弹层），并在 500×1500 的首页骨架与账号弹层骨架上出图比对亮/深两套；亮色逐像素 diff 证明零回归。

**测试 218 → 221 用例（20 套件）**；README、`.agents/rules/ui-style.md`、架构报告与 PROGRESS 同批更新。

### 批次 B：层级、过渡、模糊层与底栏定义的工程债清理（v2.5.118）

**动机**（用户 m02613「先 B 再 A」：先把 UI 的工程债清掉，再做深色模式）。

1. **层级令牌化**：`:root` 新增 `--z-nav` / `--z-modal` / `--z-toast` / `--z-auth` / `--z-alert`，11 处裸 `z-index` 全部改走令牌；顺手修掉一个真实层级错误——图片预览的关闭按钮原为 `100001`，会压在 `100000` 的确认弹窗之上（点 X 关掉的是预览而不是弹窗），现在确认弹窗是唯一顶层。
2. **过渡只走显式属性**：65 处 `transition: all` 全部改写为「基准集 + 状态块回流」推导出的显式属性列表（`transform, opacity, background-color, color, border-color, box-shadow` 等），布局属性不再被意外动画化；`.reader-sidebar` 的 `margin-left`、`.prompt-card-content` 的 `max-height` 这类布局动画本来就没走 `all`，未被误删。
3. **模糊层减负（46 → 41 条声明）**：`.search-input`（父级是不透明白卡）与 `.note-annotations-section`（背板只是纯色 + 平缓渐变的 `body`）删掉 `backdrop-filter`，并用高对比条纹页截图 + 逐像素 diff 证明零视觉变化；固定栏与浮层的磨砂全部保留（同一张条纹图也证明了它肉眼可见：0.88 alpha 下条纹仍透出来）。
4. **底栏定义合并**：`.mobile-bottom-nav` 曾在 11 个规则块里靠 `!important` 互相压——把文件末尾的路线 B 覆写折回 `@media (max-width: 768px)` 的基础定义，并删掉 `html.ios-pwa` 里与基础定义逐字重复的 7 条声明，块数降到 10、`!important` 300 → 296；合并前后用真浏览器在 9 组会渲染的上下文（亮/深色/护眼 × PWA × 键盘弹起/隐藏/未登录 × 垫高）逐属性比对 `getComputedStyle`，**完全一致**（>768px 的差异只发生在 `display: none` 的元素上）。
5. **回归门禁**：`tests/css.test.mjs` 新增「禁止 `transition: all`」「裸 `z-index ≥ 1000`」「`backdrop-filter` 数量棘轮 + 悬浮表面必须保留磨砂」「单组件定义块数棘轮（以 `.mobile-bottom-nav` 为反例）」四条，该套件累计 10 条；`.agents/rules/ui-style.md` 新增「模糊层与层级纪律」。

**测试 214 → 218 用例（20 套件）**；README、`.agents/rules/ui-style.md`、架构报告与 PROGRESS 同批更新；比对用的 computed style 采集页与像素 diff 脚本都在 `backups/`。
### 路线 B：留白与字号节奏、首屏柔光渐变（v2.5.117）

**动机**（用户参照 Gemini / ChatGPT 安卓版的「通透」质感，批准路线 B：在 v2.5.116 材质收敛之上做节奏与首屏）。

1. **留白与字号节奏**：移动端主容器 `66px 16px 86px` → `72px 18px 104px`，桌面端 `100px 24px 60px` → `104px 28px 80px`；卡片圆角 `--surface-radius` 22 → 26px；热力图微件 `16px 18px 14px` → `18px 20px 16px`、下间距 16 → 22px；今日偶想卡 `14px 0 12px` → `20px 0 16px`；时光留痕卡 16 → 20px；笔记卡 `16px 20px` → `18px 22px`；`.page-title` 34 → 40px、`letter-spacing` -0.6 → -0.9px（桌面与移动各一处）。
2. **首屏柔光渐变**：亮色主题 `body` 顶部铺两枚 `radial-gradient`（`--ios-blue` 13%、systemGreen 9% 低透明度）作 hero 光晕，卡片仍是纯白，浮在柔光上；深色与护眼主题显式 `background-image: none`（两处主题本身也各自声明，`tests/css.test.mjs` 新增门禁看住这条不变量）。
3. **材质残余对齐令牌**：列表层（`.notion-collection-card` / `.feed-item-card` / `.feed-input-card` / `.note-item` / `.book-card` / `.bookmark-card`）此前仍写死 `0 3px 14px rgba(0,0,0,0.02~0.03)` 一类字面阴影，全部收敛到 `var(--card-shadow)` / `var(--card-hover-shadow)`；`.note-item` 的 `1px solid rgba(60,60,67,0.08)` 硬边框改为透明。
4. **底栏去硬线**：`.mobile-bottom-nav` 的 `border-top: 0.5px solid rgba(60,60,67,0.18) !important` 改为透明边框 + `0 -8px 24px rgba(16,24,40,0.05)` 柔和上投影（底色仍保持不透明，见该处注释里对 Redmi 手势区色带的既有修复）；`!important` 总数 302 → 300，`tests/css.test.mjs` 基线同步收紧到 300。
5. **测试**：`tests/css.test.mjs` 新增「首屏柔光渐变只在亮色主题，深色/护眼显式关闭」1 条静态门禁。

**测试 213 → 214 用例（20 套件）**；README、`.agents/rules/ui-style.md`、架构报告与 PROGRESS 同批更新。
### 材质收敛：单一强调色与无边框柔和阴影（v2.5.116）

**动机**（用户参照 Gemini / ChatGPT 安卓版）：把「通透」拆开看，主体是**单一强调色 + 大圆角 + 无硬边框 + 柔和阴影 + 更松的留白**，而不是磨砂玻璃（`backdrop-filter` 全站铺开会在中低端安卓上掉帧）。本批只做令牌层收敛，不动布局骨架。

1. **强调色唯一化**：`--ios-blue` 由 `#0066CC` 改为 **`#007AFF`**（全文 8 处 `#0066CC` 一并替换，`--callout-bg` 改 `rgba(0, 122, 255, 0.06)`）。此前全站已有 110 处 `rgba(0,122,255)`、63 处 `#007aff`，`#0066CC` 是少数派。
2. **去硬边框、改柔和阴影**：新增 `--surface-radius: 22px` 与 `--surface-hairline`；`--card-shadow` 改两层弥散阴影、`--card-hover-shadow` 加深；`.heatmap-widget`、`.k-journal-card`、`.k-memory-card` 与通用卡片统一去掉 1px 硬边框（15 处 `rgba(0, 0, 0, 0.06)` → `transparent`），主表面圆角统一走 `var(--surface-radius)`（14 处 `18px` 一并替换），卡片内边距与间距各加 2px。
3. **输入框改悬浮胶囊**：`.k-journal-field` 去灰底改白底 + `var(--radius-pill)` + 柔和阴影，聚焦时双层阴影。
4. **热力图色阶去霓虹**：新增 `--heat-empty` / `--heat-1` ~ `--heat-4`，由薄荷色（`#a7f3d0` / `#6ee7b7`）改为 systemGreen `#34C759` 的透明阶，四档更克制。
5. **规约同批更新**：`.agents/rules/ui-style.md` §1 与令牌表按新材质标准改写；无头 Chrome 前后对比见 `backups/_cmp2_full.png`。纯 CSS 改动，测试 213 用例不变。
### 主动发出的消息也进对话记忆（v2.5.115）

**问题**（用户实测 + 截图）：主动关怀发了「办卡、注册 Google 号，那天你一个人把好几件事都顺下来了。」，用户回一句「什么时候啊」，它却答不上来——因为主动消息只落了审计表，没进对话记忆，下一轮根本不知道自己在说什么。

1. **发出即记忆**：成功送达后写一条 assistant 轮次到 bot_chat_turns（复用 saveChatTurn），用户回一句话时它就知道你指的是哪句；写失败只记错误，不影响已经发出去的消息。
2. **带上出处**：新纯函数 outreachTurnContent(text, candidate) 在正文后附一行「（这条是我自己先开口提的，出处：N 天前的随手记）」——既是「我自己先开口」的自我认知，也让它答得出「那是多久以前的事」；跳过（SKIP / 概率闸门）或发送失败时**不写**。
3. **测试**：tests/bot-outreach.test.mjs 20 → 23 用例（出处文案纯函数；「送达后留下一条 assistant 记忆、用户回「什么时候啊」时模型能看到」；「没说出口就不留记忆」）。

**测试 210 → 213 用例（20 套件）**；README、.agents/rules/architecture.md、架构报告与 PROGRESS 同批更新。

### 来源标签统一成一种日期写法（v2.5.114）

**问题**（用户反馈）：依据行里日期格式混排——随手记显示 `2026-08-31`，而标题本身就是日期的周记显示 `2026.5.21`（脚注取的是 `title || date`）。

1. **统一标签函数**：新增纯函数 `sourceLabel(source)`——日期一律 `YYYY-MM-DD`（复用 `rag.js` 的 `parseDateToYmd` 归一化），标题只在提供额外信息时追加（`[类型] 2026-05-21 · 读书笔记`）；标题归一化后与日期相同则不再重复展示；两者都缺时显示「未知日期」。
2. **两条路径共用**：「依据：」脚注与「搜 X」的结果列表都改走 `sourceLabel`，不会再出现两种写法。
3. **测试**：`tests/bot-claw.test.mjs` 31 → 32 用例（新增标签归一化用例，并在既有脚注用例里断言日期必须是 `YYYY-MM-DD`）。

**测试 209 → 210 用例（20 套件）**；README、`.agents/rules/architecture.md`、架构报告与 PROGRESS 同批更新。

### 依据脚注改成按需附上（v2.5.113）

**问题**（用户反馈）：每条回复末尾都挂一行「依据：[随手记] …」，像交作业，日常聊天里很吵。

1. **默认不带脚注**：新增纯函数 `wantsEvidence(text)`（依据 / 来源 / 出处 / 怎么知道 / 证据 / source 等关键词判据），聊天与「问 X」路径只有在用户主动追问来源时才附前 3 条出处；不追问就只回正文。
2. **边界不变**：人格红线里「只依据花园片段陈述过去、没找到就说没找到」照旧，来源只是从「总是展示」改成「问才给」；「搜 X」仍是有意列出的检索结果，不受影响。
3. **帮助文案**：补一行「「依据是什么」：追问刚才那句话的来源」，让按需机制可被发现。
4. **测试**：`tests/bot-claw.test.mjs` 29 → 31 用例（判据纯函数用例 + 「默认聊天不附依据、追问来源时才带」的端到端断言）。

**测试 207 → 209 用例（20 套件）**；README、`.agents/rules/architecture.md`、架构报告与 PROGRESS 同批更新。

### 聊完之后按对话的节奏开口（v2.5.112）

**问题**（v2.5.111 之后的延续）：放宽了安静间隔，却仍要等「当天那个哈希出的固定时刻」；习惯晚上聊天的人（20:30 以后）时窗 21:00 就关了，等于聊完永远等不到回应。

1. **时窗延后到 22:30**：时窗常量改为以分钟表示（`OUTREACH_WINDOW_START_MINUTE` / `OUTREACH_WINDOW_END_MINUTE`），允许开口区间为东八区 10:00–22:30。
2. **刚聊过时不再等固定时刻**：6 小时内聊过时，开口时刻改由「这轮对话」决定——`pickFollowUpDelayMs(userId, turnId)` 用 FNV-1a 哈希落在 30–120 分钟之间，同一轮对话只对应一个时刻（cron 每分钟跑也不会重掷）；超过 6 小时才回落到当天固定时刻。
3. **测试**：`tests/bot-outreach.test.mjs` 18 → 20 用例（新增「聊完之后的开口时刻由对话哈希决定，落在 30–120 分钟内」「刚聊过时不再等当天那个固定时刻」，时窗断言同步到 22:30）。

**测试 205 → 207 用例（20 套件）**；README、`.agents/rules/architecture.md`、架构报告与 PROGRESS 的主动关怀描述同批更新。

### 聊完也能主动想起你（v2.5.111）

**问题**（用户反馈）：主动关怀此前要求「用户安静 3 小时」才允许开口，等于刚聊完就彻底沉默；用户希望聊过之后它也会主动触发。

1. **最小间隔取代长时间安静**：`OUTREACH_MIN_QUIET_MS`（3 小时）改为 `OUTREACH_MIN_GAP_MS`（30 分钟）——刚说完话不插嘴，聊完半小时后重新具备开口资格；从未说过话时仍退回「距绑定 1 小时」。
2. **follow-up 背景注入**：距上次说话 6 小时以内视为「刚聊过」，把最近 6 轮对话当背景喂给模型（复用 `loadChatContext`），并追加红线「那是背景不是台词：不要复述，也不要接着追问」——可以顺着话题补一句，最终仍落回那条 3–180 天前的旧记录。
3. **审计与日志**：发送成功的日志追加 `(follow-up)` 标记；正文仍只落审计表、永不进日志。
4. **测试**：`tests/bot-outreach.test.mjs` 16 → 18 用例（新增「聊完 30 分钟就能开口并把刚才的对话当背景」「很久以前的对话不算刚聊过、不注入背景」，原「刚说过话就不打扰」改为显式断言 10 分钟间隔）。

**测试 203 → 205 用例（20 套件）**；README 测试布局表、`.agents/rules/architecture.md` 模块表、架构报告与 PROGRESS 的主动关怀描述同批更新。

### 微信 Bot 的主动关怀（v2.5.110）

**问题**（用户需求）：Bot 只在被叫到时才存在，用户希望它「偶尔想起来什么跟我说一下」——要的是主动权与记挂感，不是定时推送。

1. **实验先行**：先用真实 `bot_token` + **空 `context_token`** 调 iLink `sendmessage`（HTTP 200，用户确认收到），推翻了 `bot-claw.js` 里「回信必须回传入站消息的 context_token」的旧假设——Bot 可以自己先开口；该注释已随之修正。
2. **新增 `migrations/0026_bot_outreach.sql`**：`bot_claw_accounts.outreach_enabled` 账号级开关 + `bot_outreach` 审计表（记录依据的 `ref_type/ref_id`、正文、结果与原因，一律软删、时间东八区）。
3. **克制写进代码**（`workers/src/bot-outreach.js`）：东八区 10:00–21:00、每天至多一次、刚聊完 30 分钟内不插嘴（聊完半小时后重新具备开口资格）、素材只取 3–180 天前的旧记录、LLM 有 SKIP 否决权、到点后仍以 0.65 概率决定（连续 4 天没发则免除）——绝大多数分钟只做几次廉价判断，环境没有模型时直接不动；正文落审计表但永不进日志。
4. **两个开关，同一份状态**：微信里说「别主动找我 / 可以主动找我」；应用内「账号与安全」弹层新增「偶尔主动想起你」，读 `GET /api/bot/outreach`、切 `POST /api/bot/outreach`。
5. **测试**：新增 `tests/bot-outreach.test.mjs`（16 用例：到点前后、每日上限、安静门禁、旧素材、随机闸门、SKIP、内容安全、发送失败、开关与接口）。

**测试 187 → 203 用例（20 套件）**；README（模块数/迁移范围/测试布局表）、`.agents/rules/architecture.md`（模块表）、PROGRESS、架构报告同批同步。

### 应用内「关于我」档案可视编辑（v2.5.109）

**为什么还要做**：v2.5.108 的档案只能在微信里「你记得我什么 / 忘记 X」，而产品定义要求用户**能在 Chillin 内查看/编辑/删除**。

1. **后端**：`workers/src/bot-memory.js` 新增 `handleBotProfileApi`（`GET/POST /api/bot/profile`、`POST /api/bot/profile/clear`、`PUT|DELETE /api/bot/profile/<id>`）与 `forgetProfileById` / `updateProfileItem`；`addProfileItem` 补上 24 条硬闸（此前第 25 条会入库却因 `listProfile` 的 `LIMIT 24` 永远读不出来）。网关在 ClawBot 路由后加一行前缀分派（仍挂在鉴权闸门之后）。
2. **前端**：「账号与安全」弹层新增「关于我」区块——列表、新增、就地改名、单条遗忘、整份清空；写入走既有 `apiRequest`，删除/清空先经确认对话，一律软删；复用既有 `.session-*` 样式，零新增依赖。
3. **安全与隔离**：所有 SQL 参数化并限定 `user_id` 且 `is_deleted = 0`（跨用户改不动别人的条目，已由测试固定）；请求体限长 4096 字节；日志仍只打错误、不打档案正文。
4. **测试**：`tests/bot-claw.test.mjs` 25 → **29 用例**（接口 CRUD 与软删、跨用户隔离、24 条上限与 409、网关未登录 401）。

**测试 183 → 187 用例（19 套件）**；README（测试布局表）、`.agents/rules/architecture.md`（模块表）、PROGRESS、架构报告同批同步。

### 微信 ClawBot 改造为 chat-first 私人伴侣（v2.5.108）

**问题**（用户需求）：Bot 此前是「指令驱动的存储工具」——`buildBotReply` 的最后一步把**任何**没命中指令的文本都写成随手记，于是「今天天气不错」「测试速度」这类闲聊全部污染花园与 RAG；同时每条消息都是孤立回合，Bot 既不认识用户，也不记得上一句。

1. **意图反转（架构不变量：默认无副作用）**：新增 `migrations/0025_bot_memory.sql`（`bot_chat_turns` + `bot_profile`）与 `workers/src/bot-memory.js`；重写 `workers/src/bot-commands.js`——只有确定性正则指令会写库，聊天路径一个 INSERT 都没有：显式「记录：…」才落随手记，「记住：… / 忘记 … / 你记得我什么」维护「关于我」档案（一律软删），「重置对话」只清上下文、档案与花园记录不受影响。
2. **短多轮上下文**：每次回复前读最近 8 轮（单条 ≤2000 字、合计 ≤2400 字预算，越界即停），system 块注入东八区时间锚点 +「关于我」档案（≤1200 字）+ 花园 RAG 片段；检索与问答路径也带上 history 做指代继承。
3. **人格边界写进提示词**：不做存储工具（除显式指令外不得声称保存/记住）、倾诉先共情、不了解就说不了解、篇幅 150 字内；内容安全门禁不削弱，只把硬拒话术改成温和措辞。全部日志仍只打 id/错误，绝不打聊天正文。
4. **帮助文案与断言同步**：`BOT_HELP_TEXT` 不再宣称「直接发文字存入随手记」。
5. **测试**：`tests/bot-claw.test.mjs` 19 → **25 用例**（原「长轮询落成随手记」改为覆盖「默认不落库」，新增意图分流单测、档案写入/去重/查看/遗忘、重置只清上下文、提示词注入断言）。

**测试 177 → 183 用例（19 套件）**；README（workers/src 17→18 模块、迁移 0001–0025、测试布局表）、`.agents/rules/architecture.md`（模块表 + bot-memory）、PROGRESS、架构报告同批同步。

### 微信 ClawBot（iLink 协议）接入（工作树内，未发布）

**为什么换路线**：企业微信「智能机器人」在**个人微信（微信插件）里不可用**——插件沿用的是原企业号模型，只覆盖自建应用与小程序，机器人这个 2026 新实体不在其中（后台已成功关注插件、通讯录里却看不到机器人）。公众号 / 微信客服要 `access_token`，而自建应用调接口卡 60020「企业可信 IP」（要求调用方是本企业服务器 IP，Cloudflare Worker 无固定出口 IP）。腾讯官方开源仓库 `Tencent/openclaw-weixin`（MIT）的 `docs/protocol.md` 明确写着「供实现兼容后端的开发者使用」→ **按 iLink 协议自行实现后端是被官方预期的，不是逆向**。

**Spike 三连（全部通过）**：① 本机扫码绑定成功，拿到 `ilink_bot_id` / `ilink_user_id` / `baseurl` / `bot_token`（二维码实测 40–60 秒过期，必须自动换新）；② `getupdates` 长轮询收到真实消息、用 `sendmessage` + `context_token` 回复**真机收到**；③ 部署 12 行临时探针 Worker（已删除）证明 **Cloudflare 边缘可直连 `ilinkai.weixin.qq.com`（约 1.2 秒拿到新二维码）**——不需要 OpenClaw、不需要常驻机器。

**实现**：`workers/src/bot-claw.js`（iLink 传输层 + 扫码绑定生命周期 + 长轮询）、`workers/src/bot-commands.js`（配套的指令大脑：排重、随手记、检索、Echo AI、独立限流桶）、`workers/src/maintenance.js`（Cron 分流编排）、`migrations/0024_bot_claw.sql`（`bot_claw_accounts` 绑定表：`UNIQUE(user_id)`、`is_deleted`、`(user_id, is_deleted, id DESC)` 与 `(status, is_deleted)` 索引）。安全细节：传输层可注入 `fetchImpl` 以便离线单测；`bot_token` 只落库、`publicStatus` **绝不回传**；`baseurl` 只接受 https 主机名，防被篡改的库记录把请求带去别处；绑定前的积压消息按 `bound_at_ms - 60000` 丢弃；排重键由 `message_id` + `item_list[0].msg_id` + `client_id` 三段拼接（`message_id` 是 uint64，`JSON.parse` 会丢精度）。

**Cron 分流**：`wrangler.toml` 的 triggers 变成两条 `["13 * * * *", "* * * * *"]`；`runScheduled(env, event)` 按 `event.cron` 分流——每分钟那条**只跑 ClawBot 长轮询**，不会把小时级维护（UGC 扫描 / 会话清理 / 限流清理 / 备份保留 / 审计保留）带着跑 60 遍。

**网关**：`workers/api.js` **296 → 261 行**（红线 300）。把 `scanAndAudit`/`cleanExpiredSessions`/`cleanupRateLimits`/`pruneOldBackups`/`cleanupAuditLogs` 的调用与 import 全部下沉到 `workers/src/maintenance.js`，`scheduled()` 收缩成一行委派；新增 `if (path.startsWith('/api/bot/claw')) return handleClawApi(request, env, url, db, userId);`（在鉴权闸门**之后**，绑定状态与解绑需要登录态）。

**测试**：新增 `tests/bot-claw.test.mjs` **19 用例**（7 纯单测 + 12 SQLite 集成，全部走注入的假 `fetch`，零网络；含「一次 cron 调用内持续拉取」的循环与预算断言）。测试总数 182 → **201 用例（20 套件）**。

**企业微信路线清理（同批）**：个人微信路径已由 ClawBot 承担，企业微信「智能机器人」v1 的传输层与测试在 ship 前删除（`workers/src/bot-wechat.js`、`tests/bot-wechat.test.mjs`），公开回调路由与 `WECHAT_BOT_*` secrets 一并回收；删除后测试总数为 **177 用例（19 套件）**。

**上线**：远端应用 `0024`（`Executed 4 commands`）→ 把已持有的 `bot_token` 直接种进 D1（**不需要重新扫码**，凭证仍然有效；只有解绑后重绑才要）→ 部署 Version ID `b7e9c683-7649-423e-8ab5-1e9c4f35ed9c`，triggers 两条 `["13 * * * *", "* * * * *"]`。

**端到端实证**：cron 在每分钟 :27.8 触发（`scheduledTime` 实测 `:27.808`），23:39:27.8 那一轮 2.5 秒内就收到并回信，用户真实消息落进随手记（`quick_feeds.id = 1792080202251`、内容「今天挺开心」、`created_at 2026-10-19 23:39:30` CST），`bot_claw_accounts.last_error` 为空、游标持续推进。

**延迟优化（响应从最坏约 60s 降到数秒）**：iLink `getupdates` 空闲时服务端约 18s 才返回，原先「一次 cron 只拉一轮」会让每分钟空转约 42s。改成**在一次 scheduled 调用内、55s 预算里持续循环拉取**（`POLL_RUN_BUDGET_MS`，多账号按 `slice` 分配，`options.budgetMs` 只给单测收紧预算），单条消息的延迟只剩「在途长轮询立刻返回 + 回复往返」；单条消息处理失败只记日志，不再连坐整分钟的收信。

### 优化批次：P0–P3 清单落地（工作树内）

**背景**：对项目做完整审阅后按 P0→P3 优先级落地，全程守住零构建 / 300 行网关 / SW 不降级三条底线。

**P0 正确性与数据安全**
1. **审计隔离改软删墓碑**（`workers/src/audit.js`）：原来 `DELETE FROM <table>` 物理删行，而同步写入门禁是「行不存在 ⇒ 允许写入」，客户端下次 `sync/batch` 会把本地副本原样写回，形成「隔离—复活—再隔离」死循环。改为 `is_deleted = 1` 并推进 `updated_at`；扫描先按 `IFNULL(is_deleted,0)=0` 过滤，墓碑随增量拉取下发。新增 2 个回归用例（重复扫描只隔离一次、墓碑对 `sync/pull` 可见）。
2. **`INSERT OR REPLACE` → `ON CONFLICT(id) DO UPDATE`**（`garden-resources.js` 4 处、`garden-sync.js` 5 处）：REPLACE 是「删+插」，语句里没写 `created_at` 时每次编辑都会把创建时间重置为当前时刻。改为 UPSERT 且 `created_at` 不进 SET 列表，覆盖写保留原值。
3. **时间基准统一到东八区**（迁移 `0023_created_at_cst.sql` + 写入路径 + 消费方）：`weeklies/notes/bookmarks` 的 `created_at` 一直走 SQLite 默认的 UTC，而 `updated_at` 与客户端 `toUpdatedTs` 全是 CST，同一行差 8 小时——热力图、周月回顾窗口（`garden-echo.js`）、RAG 日期打分、审计保留窗口都会把凌晨 0–8 点的记录算到前一天。处理：迁移把这三张表的存量 `created_at` 平移 +8h（`quick_feeds/prompts/reader_books` 本来就是 CST，不动）；三张表 INSERT 显式写入 `datetime('now','+8 hours')`；比较边界同步加 `+8 hours`。**迁移是否应用到远端由人工决定**（`npm run ship` 遇到未应用迁移会直接中断）。
4. **PWA 自动刷新前检查未保存草稿**（`public/js/pwa-update.js`）：原来只判断 `document.activeElement` 是否为输入框，编辑器失焦（点开面板、切到批注）后会被误判成「没在编辑」并在 8 秒后自动刷新，草稿丢失。现在同时检查 `actions.hasUnsavedChanges()` / `actions.hasUnsavedNoteChanges()`，有草稿只留横幅等用户手动点。
5. **收藏编辑器死字段清理**（`public/index.html` / `public/js/bookmarks.js`）：核实后收藏是**设计上的「仅新建」**（页面标题即「新增收藏」，全站无编辑入口），隐藏域 `edit-bookmark-id` 永不被回填，按死代码删除。

**P1 性能**
6. **`sync/batch` 前置校验并发化**（`garden-sync.js`）：原来 5 组归属校验 + 5 组墓碑校验串行 `await`（组内还按 80 个 id 分块），最坏十几次串行往返；改为两批 `Promise.all`。
7. **惰性 schema 兜底批处理**（`garden-shared.js`）：与迁移 `0013` 等价的 10 条兜底 DDL 原来逐条串行 `run()`，拆成「ALTER 一批 + 幂等建索引一批」共 2 次 `batch`。
8. **静态资源缓存策略**（`public/_headers`）：`/style.css`、`/app.js`、`/js/*` 由 `no-cache, no-store, must-revalidate` 改为 `no-cache, must-revalidate`——两者都不会拿到旧内容，但 `no-store` 连 304 都不给，复访要把 ~650KB 全量重下。`index.html` / `version.json` / `js/version.js` / `sw.js` 仍保留 `no-store`（版本探测路径）。

**P2/P3 健壮性**
9. **R2 备份清理分页**（`workers/src/garden-media.js`）：`pruneOldBackups` 只读 `list()` 第一页，而 R2 单页上限 1000 且按 key 字典序（备份名带日期前缀 → 最旧在最前），`keep: 3` 会保护最旧的几份。改为按 cursor 翻完所有页再按上传时间排序；`tests/fake-r2.mjs` 补 `cursor`/`limit` 语义并加回归用例。
10. **本地存档读取收口**（`public/js/sync.js`）：20+ 处裸 `JSON.parse(localStorage...)` 换成 `readJsonValue()`（损坏/缺失返回 null，`Array.isArray` / `|| []` 语义不变），一个损坏的 key 不再中断整条离线同步链路。
11. **`safeInit` 捕获 async 失败**（`public/app.js`）：原来只有同步 `try/catch`，而大多数 `init*` 是 async，初始化失败会变成 `unhandledrejection` 且不落日志。

**第二批补充（工程一致性与 a11y）**

12. **文档门禁扩面**（`tests/docs.test.mjs`）：新增两条门禁——① 架构报告正文对 `workers/api.js` 的「N 行内」承诺必须是当前真实行数的上界（原来写着 260 行、实际 293 行），正文明细的用例数必须等于小节标题；② PROGRESS 的迁移范围必须等于 `migrations/` 最新编号。此前只有 README 的模块/迁移数被机器校验，报告正文的数字全靠人眼。
13. **可访问性**（`public/index.html` + 新增 `tests/a11y.test.mjs`）：补 35 处 `aria-label`（读屏用户此前听到的只是「编辑框」而不是「本周标题」；placeholder 不能替代可访问名称），并把三条规则固化成门禁：控件必须有可访问名称、无重复 id、`img` 必须有 `alt`。核实后 `h1` 虽有 10 个，但非活动视图是 `display:none`，读屏只会看到当前视图的标题，不算缺陷，故未改动。
14. **备份恢复链路可用**（新增 `scripts/restore-d1.mjs` + `npm run restore`）：README 原来的恢复命令让用户执行 `backups/*.sql`，而 `backup-d1.mjs` 导出后就把裸 `.sql` 删了、只留 `.sql.gz`——文档里的命令必然找不到文件。新脚本自动解压、默认针对远端库且必须显式 `--yes`，文档门禁同时校验命令与脚本一致。
15. **测试跳过不再静默**（`tests/fake-d1.mjs` + 8 个套件）：整批 SQL 集成用例在 Node < 22.5 上原来用裸 `test.skip` 跳过，CI 的 Node 20 腿只显示「skipped N」，看不出是环境问题还是用例写坏。收敛为 `sqliteTest` / `sqliteSkip`（跳过原因带上当前 Node 版本），并加守卫用例断言「跳过原因必须说明是运行环境」。
16. **去重**（`public/js/utils.js`）：`notes.js` 与 `weeklies.js` 各写了一份逐字相同的 19 行图片解析循环，抽为纯函数 `extractImageMatches`（语义逐字保持）并补用例。审计显示两文件还有 1 处 12 行的批注 DOM 构建重复，但差异点涉及 state 源与保存函数，属交互逻辑重构，留待确认后再动。

**第三批补充（链接、CSS、未覆盖模块）**

17. **文档链接完整性**（54 处死链 + 新门禁）：README / 规约 / 技能文档里原来有 54 个 `file:///d:/7/chillin/...` 与 `file:///e:/Chillin/...` 绝对链接——换台机器或换个盘符就全部点不开，而评审时没人会去点。全部改成相对路径，并在 `tests/docs.test.mjs` 加门禁：自有文档不得出现 `file://`，所有本地链接必须能解析（代码块内的示例除外）。
18. **CSS 卫生门禁**（新增 `tests/css.test.mjs`）：9600+ 行样式此前零测试覆盖。审下来的结论是**没有可安全删除的死代码**——16/16 `@keyframes` 都有引用、0 处重复声明、0 个空块、花括号平衡、7 个「引用了未定义」的变量全部带 fallback（`--reader-*` 由 JS 运行时注入）。那 10 个「未被 var() 引用」的自定义属性是 `:root` 里**有意预留**的令牌阶梯（注释已写明按模块逐步迁移），不是死代码，因此只加门禁不删样式：死动画、重复/空声明块、静默失效的 `var()`、`!important` 数量棘轮（当前 302，只许降）。后续专门复核「被同选择器后声明覆盖」的 58 处时发现多数是**刻意覆盖**（`height: 100vh` → `100dvh` 是渐进增强回落、`border: none` → 边框重置），盲删会在不支持 `dvh` 的浏览器上真回归——CSS 实降确认必须配浏览器视觉核对。
19. **补上未覆盖模块的测试**（`garden-echo.js` / `llm.js`）：`handleAiReview` 此前无直接测试。新增两个零网络、确定性的用例：近期无记录时返回引导语（不空跑模型）、无 LLM 凭证时降级为「本地摘要」且窗口内记录必须被取到。顺带核实 P1 的「热力图缓存」不适用——热力图是客户端从聚合拉取的数据渲染的，不存在单独的热力图请求需要缓存。

20. **补上合规控制的测试**（`tests/rag.test.mjs` +5）：内容审核是安全控制，但 `moderateText` 此前没有一行测试。新增：硬违规词拒绝且不回传原文、软广词打码而不误杀、空/正常文本不误伤、`env.MODERATION_POLITICAL_WORDS` 注入词表前后的行为、以及「无任何 LLM 凭证时安静返回空串让上层降级」的契约（全部零网络）。另加文档门禁：文档里提到的 `npm run <x>` 必须真实存在于 `package.json`——README 曾让人执行根本不存在的 `npm run restore`。

21. **缓存策略门禁**（`tests/sw.test.mjs` +1）：`public/_headers` 注释写明了「版本探测路径不缓存、静态资源带 ETag 复验」的分工，但没有测试。`public/js/*.js` 的文件名没有内容哈希——一旦有人给它加上 `max-age=31536000, immutable`，改完代码的用户会一年拿到旧文件且 Service Worker 也救不回；把 `/sw.js` 缓存住则新版本永远推不出去。门禁现在同时钉住这两侧。
22. **批注项模板去重 + 一处用户可见乱码**（`public/js/utils.js`）：notes 的「批注」与 weeklies 的「追加说明」各写了一份逐字相同的批注项模板（只有删除回调不同），收敛为纯函数 `annotationItemHtml`（输出逐字保持，交互仍留在各自模块），并补一条同时校验「删除按钮有可访问名称」与「内容被转义」的用例。顺带修掉 weeklies 里 `确定要删除这条批追记吗？` 的乱码文案（「批追记」不通顺，且与该页「追加说明」的用词不一致）。

23. **内联路径门禁 + 修一处失效引用**：链接有专门门禁，但正文里反引号点名的 `workers/src/x.js` 没人管。巡检发现 `garden-rag-llm` 技能还指向 `public/js/echo.js`（实际文件是 `echo-ai.js`），已修正；新增门禁：README / AGENTS / 规约 / 技能文档里内联提到的仓库路径必须存在（PROGRESS 是变更日志、必须能记录已删除的文件，`docs/` 与 LICENSE 同理，故排除；排错指南里作为假设示例的 `public/js/foo.js` 进白名单）。顺带完成跨模块重复巡检：剩余重复全部集中在 notes/weeklies 的图片预览渲染里，收益约 20 行却要动渲染逻辑，按 `conservative-code-edits` 规约不做。

24. **时间基准：修掉 5 处仍依赖 UTC 默认值的写入**（`workers/src/`）：0023 只搬迁了存量行，但 SQLite 的列默认值 `datetime('now')` 与 `CURRENT_TIMESTAMP` **都是 UTC**，还有 15 个列在用它。审计出的真实写入路径：`files`（上传，2 处）、`ugc_quarantine`（隔离区）、`users`（注册）、`push_subscriptions`（含 `ON CONFLICT ... = CURRENT_TIMESTAMP`）——这些行的时间会比其它记录早 8 小时。已全部改为显式 `datetime('now', '+8 hours')` 字面量（用字面量是为了不改绑定参数编号）；`notes/weeklies/bookmarks/quick_feeds` 等主链路此前已显式写 CST，无需改。并加三道防线：三条运行时断言（注册 / 上传 / 隔离区写入的 created_at 必须落在东八区窗口内，UTC 会直接越界失败）+ 一条迁移门禁（新增表不得再用 UTC 默认值，12 个历史表进白名单并注明「改默认值要重建表」）。该门禁已用注入探针验证会真失败，不是恒真。

25. **多租户与注入面复核 + 表名 fail-closed**：沿用上一轮的方法把三处隐式约定过了一遍——① 查询用户表是否都带 `user_id`（5 处命中：2 处是「条件在下一行」的逐行扫描假阳性，`ugc_quarantine` 保留期清理与 `push_subscriptions` 按 endpoint 清理属系统级，`files` 令牌轮换前已有属主校验）→ 无需改；② 所有 UPDATE 是否推进 `updated_at`（4 处未推进，但都落在 sessions / users / files，**不参与客户端增量同步**，否则才是丢数据的 bug）；③ SQL 里的 `${table}` 插值共 2 个助手、9 个调用点全为字符串字面量。复核没发现漏洞，但标识符插值只能靠调用方自觉：已改为 **fail-closed**——`garden-shared.js` 导出 `OWNED_TABLES` 白名单，`isOwnedRecord` 与 `garden-sync.js` 的 `fetchOwnedSet` 对白名单外的表名直接抛错，并加用例证明 `notes WHERE 1=1 --` 这类表名会被拒绝、白名单内的表与「他人记录」判定照常工作。

26. **XSS 注入面复核（结论：收口完整，且没加成重复门禁）**：扫 `public/js` 全部注入点——真实的 `innerHTML =` 只有 `trusted-types.js:40` 一处（唯一入口），109 处调用全走 `setHtml`；`index.html` 内联事件处理器 0 处、`javascript:` 0 处、其它 sink（`outerHTML`/`insertAdjacentHTML`/`document.write`）0 处。
    过程比结论更有价值：我先写了两条新门禁，**用探针验证时发现两条都已存在**——`:281` 的 sink 门禁还额外检查「用了 setHtml 却没 import」，`:165` 已覆盖内联处理器——探针让「一条探针文件同时打红两条同名测试」直接暴露了重复。于是撤回自建的两条，改为对已有门禁**补缺**：① sink 正则扩展到 `outerHTML` / `insertAdjacentHTML` / `document.write`；② 内联处理器那条最初被我放宽成 `on[a-z]+`，结果被 `upload.js` 的 `typeof onProgress === 'function'` 打红——`onOk` / `onKeydown` / `onSelect` 这类**回调变量名**会被误判。最终改成只认「带引号值的 HTML 属性」`on*=(\"|')`，误报归零，并用探针确认真内联处理器仍会被抓住；同时补上 `javascript:` 检查。

27. **灾难恢复链路实测 + 运维手册 + `backup --local` 对称性**：此前 `restore` 支持 `--local` 而 `backup` 只认 `--remote`（硬编码），「本地演练」只能做一半。已给 `backup` 补上 `--local`（本地快照不上传 R2、不参与远端保留策略），并跑通完整演练：建探针表 → `npm run backup -- --local --keep 999` → `DROP TABLE` 模拟丢失 → `npm run restore -- <快照> --local`（退出码 0）→ 读回 `"note": "drill-ok"`。**恢复链路是真的可用，不是「文档里存在」**。同时把 restore 的安全闸（缺文件参数、远端未加 `--yes` 都必须退出 1 且不执行任何命令）固化成门禁。沉淀文档：新增 `docs/备份恢复与迁移操作手册.md`，含风险分级、0023 专项与**有边界的回滚 SQL**——无脑 `-8 hours` 会把迁移之后新写入的 CST 行反向错位。

28. **前端首屏体积预算门禁**：项目坚持零构建、直开，但此前**没有任何体积约束**——加一个 30KB 的库只需一次提交，没人会注意到首次加载变慢。实测现状：JS 合计 452.6 KB raw / **134.8 KB gzip**（29 个文件），CSS 212.8 KB raw / **35.9 KB gzip**，最大单文件是 `public/js/reader.js` 13.6 KB gzip。已在 `tests/architecture.test.mjs` 加入预算门禁（JS 合计 ≤ 160 KB、CSS ≤ 48 KB、单文件 ≤ 20 KB gzip），并按需留出余量。门禁用 30 KB 不可压缩探针验证过会真失败——且证明了单文件上限能独立生效（探针时总量 158.6 KB 仍未越线，是单文件断言把它抓住的）。同步写入 `.agents/rules/architecture.md` §1 与 README 测试布局表。

**测试 122 → 182 用例（19 套件）**；README（迁移范围 0001–0023、测试布局表新增 a11y/css、版本联动 8 处）、PROGRESS、架构报告（正文行数/用例数纳入门禁）、`engineering-workflow.md`、`AGENTS.md` 与 `chillin-ship-guardian` 技能文档（6 点 → 8 点）同批更新。

### 请求体上限全覆盖与 Service Worker 缓存时序修正（v2.5.103 → v2.5.104）

**问题**（代码评审）：① 上一轮只覆盖了书籍/批量同步/AI 三个入口，README 却写成「一律」，而资源 CRUD（`garden-resources.js` 9 处）、账号接口（`auth.js` 3 处）、备份邮件都还在直接 `request.json()`；② SW 的运行时缓存是「响应先返回、写入丢后台」，SW 被回收时可能来不及落盘，影响离线可用性。
1. **`readJsonCapped()` + 网关兜底**（`security-network.js` / `api.js`）：新增限长 JSON 读取（返回 `{ ok, value }` / `{ status }`），并给网关加了一道 **21MB 声明长度兜底**——将来新加入口忘写上限也不会被撑爆。
2. **全入口接入**：资源 CRUD **512KB**、阅读进度 **8KB**、账号接口（注册/登录/推送订阅）**8KB**、备份邮件（含 base64 全量 ZIP）**12MB**；至此 `workers/src` 里 `request.json()` 的调用点 **13 → 0**。
3. **Service Worker**：模块 JS / 页面导航 / 静态资源三条网络优先分支统一改为「**await 缓存写入后再返回响应**」，写入失败只吞异常不影响当次响应；离线未命中时回退 `Response.error()`（不再可能 `respondWith(undefined)`）。并把这条写进 `.agents/rules/pwa-offline-sync.md` §1.3。
4. **测试 117 → 122 用例**：新增 `readJsonCapped`（413/400 分流）、CRUD 超 512KB → 413、注册超 8KB → 413、备份邮件声明超 12MB → 413、网关声明超大 → 413（不进路由）；README 安全要点与覆盖矩阵同步。
### 输入体积上限与导入状态诚实化（v2.5.102 → v2.5.103）

**问题**（代码评审提出）：① 书籍上传是 `await request.text()` 之后才判断 20MB，超大请求会先把内存吃掉；② 批量同步与 AI 问答直接 `JSON.parse` 整个请求体，没有体积/条数/字段上限；③ 书籍导入在云端同步完成前就提示「导入完成」，同步失败只进 console，用户会误以为已备份。
1. **`readTextCapped()`（`workers/src/security-network.js`）**：先看 `Content-Length` 快速拒绝，再按流累计字节，**超限立刻 `reader.cancel()`**，从读取过程本身限长。返回值 `{ ok, text, bytes }`。（v2.5.98 删掉的同名函数当时无业务调用方，这次按真实需求重新引入。）
2. **三个入口接入上限**：书籍上传 20MB（先看声明长度再流式限长）；批量同步 **4MB + 每种资源 ≤200 条 + 单条记录 ≤200KB**，并顺手修掉「非数组载荷会抛错」的隐患；AI 问答 **256KB + 问题 ≤4000 字 + 历史只留最近 20 条且单条 ≤2000 字**（超限在模型调用之前就 400/413）。
3. **导入状态诚实化**（`js/reader.js`）：导入完成后**等待云同步结果**再给结论——成功提示「已同步到云端」，失败提示「已导入本机，但云端同步失败；打开书架会自动重试」并立刻触发一次补传，未登录则明确说「未登录，暂不云同步」。书架卡片上还会给未上云的本机书加「· 未上云」标记（只有确实拉到过云端书目时才显示，离线不误报）。
4. **测试 112 → 117 用例**：新增 `readTextCapped`（正常/声明超限/**流式超限时必须中途停止拉取**）、批量同步（条数上限、单条体积、非法 JSON 与非对象载荷）、AI 问答（空问题/超长问题/非法 JSON 拦在模型调用之前）；README 安全要点、测试覆盖矩阵、架构报告同步。
### 本机书架补传：早年导入的书自动上云（v2.5.101 → v2.5.102）

**问题**：云书库（v2.5.100）只在「导入的那一刻」上传正文。v2.5.100 之前导入的书（例如本机已读很久的《白夜行》全集、《诡秘之主》）只有本机 IndexedDB 副本：云端 `reader_books` 没有记录、R2 里也没有正文，于是换设备时看不到它们，只能重新导入一次。
1. **新增 `rebuildBookText()`（`js/reader.js` 模块级纯函数）**：导入时并未保留原文，只能按「章名 + 该章正文」把本机已切的章节拼回一份正文；**保留每章开头的章名行**，保证换设备下载后仍能被识别成同样多的章节。
2. **书架自动补传**：`renderBookshelf` 拉到云端书目后，若本机某本书**不在云端**（且这次拉取确实成功——离线时不会误判成「全都缺」），就重组正文并推送，用户无需任何操作；**每次会话最多补 3 本**，失败即停（下一轮再试），成功时提示「☁️ 已把 N 本本机书补传到云端」。
3. **沿用原指纹上传**：补传直接使用本机书籍的 `bookKey` 与章节数，不重新解析正文——避免正文里出现「第X章」字样时把章节数算歪，进而在书架上多出一张重复卡片。
4. **测试 110 → 112 用例**：新增 2 例 `rebuildBookText`（乱序按 index 排序并保留章名行、缺字段/空输入不抛错）；README / 规约 / 架构报告同步。
### 阅读器进度同步强化：双向合并、离线补推与写入保护（v2.5.100 → v2.5.101）

1. **P4 写入保护（`migrations/0022_reader_progress_client_ts.sql`）**：`reader_progress` 新增 `client_ts`（客户端 `Date.now()`）。`POST /api/reader/progress` 改为 `ON CONFLICT ... DO UPDATE ... WHERE excluded.client_ts >= reader_progress.client_ts`：比库里旧的一律拒绝，响应里回 `applied:false`，前端据此把该条从队列清掉（不会无限重推）。未带 `client_ts` 的旧前端回落到服务端当前时间，保持「后到者胜」老行为，不至于写不进来；历史行 `client_ts=0`，前端遇到时退化回「位置更靠前才采纳」。
2. **P1 打开时双向合并**：以前只在「云端更靠前」时单向对齐，本地更新时不会回推。现在打开书时按时间戳比较——云端更新且更靠前 → 采纳云端；**本地更新且更靠前 → 回推一次**；云端还没有这本书 → 把本机进度推上去。任何情况下都不把读者往回带。
3. **P2 离线补推队列**：推送失败的进度按 `book_key` 落进 `localStorage.reader_progress_queue`（同一本书只留最新一条），在「联网 / 打开书 / 上一次推送成功」时自动补推（一次最多 5 条，失败即停，避免离线时连环打接口）。
4. **P3 删书连带清进度**：`DELETE /api/reader/books/<key>` 现在同时 `DELETE FROM reader_progress` 并返回 `progress_deleted`；前端删书时也会丢掉队列里该书的待推项，避免删完又被补推回来。
5. **测试 105 → 110 用例**：新增 4 例进度接口用例（写入读回、**更旧写入被拒绝**、同时间戳允许、旧前端回落、百分比夹紧与跨用户隔离）+ 1 例「删书连带清进度」；README / 规约 / 架构报告同步（迁移范围、阅读器能力、测试覆盖矩阵）。
### Cloudflare R2 接入：图片迁出 D1、备份上云与阅读器云端书库（v2.5.99 → v2.5.100）

**P0 图片二进制迁往 R2**
1. `wrangler.toml` 新增 `[[r2_buckets]]` 绑定 `MEDIA` → 桶 `chillin-media`；部署前必须先 `npx wrangler r2 bucket create chillin-media`，否则上传接口会退化为 D1 写入。
2. `migrations/0020_files_r2_metadata.sql`：重建 `files` 表——`data` 改为可空，新增 `r2_key` / `size`，重建用户索引并新增 `r2_key` 索引（迁移脚本据此筛选待搬运行）。
3. `garden-media.js`：`handleUpload(request, env, db, userId)` 先把二进制 `put` 到 `uploads/<userId>/<id>`，D1 只写元数据；未绑定 R2 时回退旧的 D1 BLOB 写入。`handleFileView(fileId, request, env, db, authenticate)` 优先读 R2，支持 **Range → 206 + Content-Range** 与 `ETag`；`r2_key` 为空的历史行继续走 D1 BLOB，因此迁移可随时进行、无需停机。
4. `scripts/migrate-files-to-r2.mjs`：一次性存量搬迁（远端 `hex(data)` → `r2 object put` → 回填 `r2_key/size`），幂等可重跑，支持 `--dry-run` 预演，确认无误后加 `--clear-data` 清空 D1 BLOB 真正给库瘦身。

**P1 备份快照进 R2**
5. `scripts/backup-d1.mjs` 默认把 `backups/chillin-d1-<UTC>.sql.gz` 一并上传到 R2（`--no-r2` 可关闭；上传失败只告警，本地快照依然有效）。
6. 过期快照由 Worker 每小时定时任务 `pruneOldBackups()` 清理：最新 3 份永不删除，其余超过 30 天的删除——从此「本机磁盘坏了」不再等于数据丢失。

**P2 阅读器云端书库**
7. `migrations/0021_reader_books.sql`：`reader_books(user_id, book_key, title, author, total_chapters, size, r2_key, is_deleted, updated_at)`，`UNIQUE(user_id, book_key)` + 用户维度索引。
8. `workers/src/garden-books.js`（新模块）：`GET/POST /api/reader/books`、`GET/DELETE /api/reader/books/<bookKey>`；正文存 `books/<userId>/<sha256(bookKey)>.txt`（避免中文书名直接进对象键），D1 存书目；删除写软删墓碑并回收 R2 对象，按 `user_id` 严格隔离。
9. `js/reader.js`：导入时后台把正文推到云端；书架先画本地、再后台补云端书目，本地没有的书显示为 ☁️「点击下载到本机」卡片，点开即下载落库并直接进入阅读；本地删除同步删云端。离线/未登录时云端部分静默为空，不影响本地阅读。
10. 质量门禁：新增 `tests/fake-r2.mjs` 内存 R2 适配器与 `media`（9 例）、`books`（5 例）、`router`（3 例，网关级接线：真实会话 Cookie 走 `/api/reader/books` CRUD 与 `/api/upload` → `/api/file/<id>?t=` 全链路）用例，覆盖 R2 读写、Range/206、令牌拒绝、D1 兼容回退、无绑定兜底写入、备份保留策略、跨用户越权与路由接线；**15 套件 / 98 用例**（本次新增 17 例）；`workers/api.js` 284 行（红线 300）。

**上线实录（2026-10-16 当天）**
11. **线上验收**：`/api/health` 与 `/api/app-version` 均为 v2.5.100；`wrangler deploy` 版本 ID `03bc4890`（`env.MEDIA` 绑定生效）；存量 **21 张 / 4.7 MB** 图片搬迁完成，逐张复验 HTTP **200** 且 `size_download` 与 D1 记录逐字节一致，`Range: bytes=0-99` 返回 **206 + `Content-Range: bytes 0-99/146738`** + `ETag`；`npm run backup` 实测把 5.16 MB 快照上传到 R2 `backups/`（P1 端到端通过）。D1 里的 BLOB **暂时保留**，确认无误后可用 `node scripts/migrate-files-to-r2.mjs --clear-data` 释放。
12. **三个只在真实环境暴露的坑**（都已在代码里修掉）：
    - **`r2 object put` 遇本地代理必失败**：`HTTP_PROXY=127.0.0.1:7897` 会让 R2 传输端点（`*.r2.cloudflarestorage.com`）报 `fetch failed`，需给子进程补 `NO_PROXY=.r2.cloudflarestorage.com,cloudflarestorage.com`（`backup-d1.mjs` 与 `migrate-files-to-r2.mjs` 已内置）。
    - **Windows 参数拆词**：`execFileSync('npx', args, { shell: true })` 会按空格把 SQL 再拆一遍，迁移脚本改为逐参数加引号；另加 3 次重试，避免几分钟的迁移被一次网络抖动打断（也因此支持中断后续跑）。
    - **R2 整对象读取也回传 `range` 元信息**：原实现据此把普通 GET 标成 `206 Partial Content`（线上实测发现），现改为**只有客户端发了 `Range` 才走 206**；`tests/fake-r2.mjs` 同步改为回传 range 元信息，让该行为被回归用例守住。
13. **浏览器端实测（真实账号登录 + 本机 Chrome CDP 驱动，2026-10-16）**：
    - **图片写路径**：经前端全局上传器真实上传一张 webp → D1 新行 `r2_key` 有值且 `data IS NULL`（size 135616，客户端压缩后）；**R2 对象 / Worker 响应 / 浏览器渲染三方哈希一致**（`9B532A96…DBF50C`），浏览器内 `naturalWidth=1201` 正常渲染。
    - **云端书库**：真实导入 3 章 TXT → 自动推送 R2（`books/1/<sha256>.txt`）；清空本机 IndexedDB 模拟「换设备」后，书架出现 ☁️「点击下载到本机」卡片，点击即下载入本地书架并直接进入阅读（分页 1/3、正文正确）。删除书目会回收 R2 对象（已用 `r2 object get` 确认测试对象不存在）。
    - **测试数据已清理**：`files` 回到 21 行、`reader_books`/`reader_progress` 归 0，无残留。
    - 踩坑备注：造测试书素材时用 PowerShell 拼中文字符串会踩 `"第$c章"` → `$c章` 被当成变量名的坑（生成出 `第 测试章节1`），**中文测试素材请用 Node 或编辑器生成**。

14. **文档一致性机器门禁与规约补全（v2.5.100 维护轮）**：
    - 新增 [`tests/docs.test.mjs`](tests/docs.test.mjs)（7 例）：把 README 的模块数 / 迁移范围 / 测试套件数、[`architecture.md`](.agents/rules/architecture.md) 的模块覆盖，以及 `package.json` ↔ `PROGRESS.md` ↔ `version.js` ↔ `sw.js` ↔ 架构报告的版本号一致性全部钉成断言——**文档漂移从此直接让 `npm test` 红灯**（本轮就是它先抓出「报告写 15 个套件、实际 16」）。
    - [`engineering-workflow.md`](.agents/rules/engineering-workflow.md) 新增 **§5 文档同步硬性要求**：给出「改什么 → 必须同批更新哪些文档」的对照表与机器校验说明；§1.1 测试覆盖矩阵从 8 条补全到 16 条（含 media / books / router / backup / evergreen / reader / wikilinks / docs）。
    - [`architecture.md`](.agents/rules/architecture.md) 领域模块表从 9 行补全为 **14 行**：此前缺 `garden-shared` / `garden-echo` / `ai` / `security-network` / `security-crypto`，且仍挂着早已不存在的 `garden.js`。
    - [`AGENTS.md`](AGENTS.md) 索引行同步（14 个领域模块、R2 存储边界、文档同步硬性要求），并清掉两处「SSRF 14 组拦截」陈旧表述。
    - README 顺带修复：[`_headers`](public/_headers) 坏链（该文件在 `public/` 下）、测试布局表补全 4 个套件、弹层数 4 → 10。

### 外链解析功能移除、SSRF 工具清理与文档同步（v2.5.95 → v2.5.98）

1. **外链补解析可靠性修复（v2.5.95）**：失败不再「一次失败就永久放弃」（`_enriching`/`_enrichFailed` 不再随 feed 落盘，失败改为带时间戳的 `_enrichFailedAt` + 5 分钟冷却）；裸域名/假标题等占位值不再被当作「解析成功」写库；单次渲染最多补解析 3 条，保护 `/api/link/parse` 的 40 次 / 10 分钟限流。
2. **小宇宙专用解析管道下线（v2.5.96）**：删除 `resolveXiaoyuzhou()` 与其平台标签分支。实测该站点对 Cloudflare 出口直接返回 403（362ms，非超时），Jina / Microlink 兜底长期 429，专用管道无法稳定工作。
3. **外链解析功能整体移除（v2.5.97）**：Worker 端删除 `handleLinkParse` / `parseRssOrAtom` / `matchEpisodeAudioFromRss` / `fetchMicrolinkPreview` 与 `/api/link/parse` 路由（`garden-media.js` 379 → 95 行、`api.js` 270 → 263 行）；前端删除自动补解析与「提交时解析」（按钮文案改「发送中…」）；`wrangler.toml` 移除 `LINK_ENRICH_MICROLINK`；测试 88 → 80。**含链接的随手记只显示链接卡片**，历史条目已存的元数据照常渲染。
4. **SSRF 工具清理（v2.5.98）**：整体删除 `workers/src/security-ssrf.js`（207 行）——审计显示其中 12 个导出业务侧引用为 0、仅测试在用（`isSafeFetchUrl` / `isLoopbackOrPrivateHost` / 14 组私网 CIDR 判定 / IPv6 内嵌 IPv4 解析 / `readTextCapped` / `fetchWithTimeout` / 违规域名黑名单）；`security.js` 门面去掉再导出，删除对应 2 个用例（80 → 78）；`.agents/rules/security.md` 第 3 节转为**废止说明**（将来若重新引入服务端出站抓取，必须从 git 历史恢复整套校验）。
5. **架构报告同步（v2.5.98）**：`docs/Chillin数字花园_产品全景与工程架构分析报告.md` 的报告版本与在线基准更新为 **v2.5.98 / `chillin-v145`**，测试小节改为 **12 套件 / 78 用例**（补齐 `reader`），安全模块分治描述去掉 SSRF 模块并注明移除原因。
6. **顺带修复的部署漂移**：发现后端提交领先线上部署 1 小时 50 分（外链重定向的违规域名校验未生效），已补部署；`npm run ship` 现已在发布前校验**远端 D1 迁移是否全部应用**（此前 `0019` 曾漏应用 12 天）。

### 工程化与体验收尾（v2.5.44 → v2.5.45）
**A 工程基础设施**
1. 新增 CI 门禁（`.github/workflows/ci.yml`，浅克隆）：每次 push/PR 跑 `npm test` + `wrangler deploy --dry-run`。
2. `npm run backup`：D1 远端导出 → gzip → `backups/`（已忽略），保留最近 14 份，附恢复与计划任务说明。
3. 新增 SW 预缓存守卫测试：断言 `js/*.js` 全部登记、清单资源与 manifest 图标存在、模块请求绝不回退 index.html。
4. 修复「无 id 记录被静默丢弃/重复推送」：推送前补客户端 id（`ensureLocalId`/`selectDirtyItems`）。
5. 拆分 `workers/api.js`（302 → 227 行）：AI 路由下沉 `workers/src/ai.js`，并新增 300 行红线守卫测试。

**B 安全再加固**
6. DOMPurify 自托管到 `vendor/`（字节与官方 3.1.7 一致并有校验测试），CSP 不再放行任何第三方脚本域。
7. CSP 追加 `object-src 'none'` / `frame-src 'none'` / `upgrade-insecure-requests`，清理无用的字体域。
8. 会话滑动续期 + 令牌轮换 + 登录设备列表（migration 0017，`/api/auth/refresh|sessions`，新增「账号与安全」面板）。
9. 外链解析响应体限长（页面 512KB / Microlink 128KB）+ `LINK_ENRICH_MICROLINK` 隐私开关。**（v2.5.97 已随功能整体移除）**

**C 体验与无障碍**
10. 全部原生 `confirm/alert` 替换为应用内弹窗与 toast；弹层补 `role=dialog`/`aria-modal`、焦点陷阱、Esc 关闭、焦点归还、跳转链接与 `:focus-visible` 兜底。
11. 上传改为 XHR 实时进度 + 失败一键重试；推送权限改为用户主动点击。
12. `style.css` 引入间距/圆角/动效令牌并在 `ui-style.md` 记录迁移策略（不做一次性大改）。
13. 上传优先转 WebP（回退 JPEG，GIF 原样保留）。

**D 维护与可观测**
14. `npm run ship`（门禁 → 版本联动 → 校验提交信息 → 提交/推送），两个 .bat 改为调用它。
15. 新增 `.dev.vars.example`、`.gitignore` 补 `.dev.vars`、新增 `LICENSE`（保留所有权利）。
16. wrangler 4.86 → 4.145，`compatibility_date` → 2026-10-01。
17. 新增公开 `GET /api/health`（DB 探测失败返回 503），README 记录日志前缀与 `wrangler tail`。
18. `docs/仓库体积与历史瘦身评估.md`：实测 89.6 MiB 打包体积中约 95 MB 为历史媒体文件；先落地零风险方案（CI 浅克隆），历史重写待明确授权。
19. `npm run changelog` 从 git 历史生成 `CHANGELOG.md`（已接入 `npm run ship`，随发布自动重生成）。
20. **T1 收尾**：`audit_log` / `ugc_quarantine` 增加 180 天保留策略（migration 0018 补索引）；`package.json` 声明 `engines.node >= 20`；README / 架构报告 / engineering-workflow 的口径同步到 v2.5.45（迁移 0001–0018、28 个测试用例、6 个测试文件）。

### 真实 IP 透传与文档同步（v2.5.43）
1. **反代真实 IP 透传**：`CF-Connecting-IP` 在跨 Worker 子请求时会被重写，导致限流退化为"全局一个桶"。Pages Function 现在显式带回原 IP（`X-Chillin-Client-IP`）与共享密钥（`X-Chillin-Proxy-Token`，取自 `PROXY_SHARED_SECRET`），Worker 用恒定时间比较校验后才采信；未配置密钥或密钥不符时一律忽略，直连 Worker 无法伪造。线上已验证限流桶键恢复为真实出口 IP（`2409:8a34:...`）。
2. **账号维度登录锁定**：即使 IP 信号失真，同一账号 15 分钟内 10 次失败即被限流。
3. **文档同步**：`docs/Chillin数字花园_产品全景与工程架构分析报告.md` 版本与 SW 缓存号更新至 v2.5.43 / `chillin-v90`，新增「安全加固批次（v2.5.38 → v2.5.43）」小节，测试套件数更正为 18。

### 遗留安全债清零（v2.5.40）
1. **会话令牌哈希落库**：登录/注册只写入 `SHA-256` 摘要，`resolveSession()` 命中旧明文行时就地升级为哈希行（零停机）；登出同时清理哈希行与遗留明文行；migration 0015 补 `sessions(user_id)` 索引。
2. **CSP 去除 `'unsafe-inline'`**：`index.html` 的 18 个内联 `onclick` 与 `js/` 模板生成的 9 个内联处理器全部改为事件委托（弹层遮罩/关闭按钮/图灯箱/章节树/回响折叠），图片失败兜底改在捕获阶段代理；两段内联引导脚本改用 sha256 白名单。新增单测会重算哈希、断言全仓无内联处理器且 `script-src` 无 `unsafe-inline`，以后误加内联处理器会在 `npm test` 阶段失败。
3. **限流跨实例共享**：新增 `checkRateLimitShared()`（内存桶快速路径 + D1 原子计数，D1 异常自动降级），登录/注册/外链/上传/AI/回响/回顾全部接入；migration 0016 建表 + 索引，Cron 清理过期窗口；`getClientIp` 改为取信 `CF-Connecting-IP`，回退取 XFF 最后一段（首段可伪造）。

### 安全加固、会话升级与工程一致性（v2.5.38 → v2.5.39）
1. **版本号联动修复**：`index.html` 长期滞留在 2.5.36 而 `js/version.js`/SW 已是 2.5.37 —— 根因是 bump 脚本按"当前版本字面量"替换，一旦漂移就永远替换不到。脚本改为正则重写全部 `?v=` 与徽标、联动 `package.json`、为 `version.json` 增加发布时间戳、`PROGRESS.md` 只改头部行；版本徽标改由 `APP_BUILD_LABEL` 渲染。
2. **外链兜底回归**：前端 `fetch('https://api.microlink.io')` 一直被 Pages 的 CSP `connect-src` 拦截（死代码），兜底下沉到 Worker `handleLinkParse`，浏览器 CSP 无需放宽。
3. **SSRF 加固**：新增 16 字节 IPv6 解析与内嵌 IPv4 判定，封堵 `[::ffff:a9fe:a9fe]`（云元数据）、NAT64 `64:ff9b::/96`、6to4、Teredo，以及 `localhost.` / `127.0.0.1.` 尾点绕过；无法解析时 fail-closed，配套单测已补齐。
4. **响应头**：Pages 与 Worker 均补齐 `Strict-Transport-Security`，API/文件响应追加 `default-src 'none'` 的 CSP 兜底。
5. **上传防内存放大**：先校验 `Content-Length` 与 `Blob.size` 再读入内存（此前先 `arrayBuffer()` 后判 5MB）。
6. **会话安全**：登录/注册下发 `HttpOnly + SameSite=Lax`（HTTPS 带 `Secure`）Cookie，`authenticate()` 同时接受 Bearer 与 Cookie（响应保留 token 与 `session:'cookie'` 标记，前后端可任意顺序升级）；前端在 Cookie 模式下不再把令牌写入 localStorage，刷新后用 Cookie 恢复会话；新增 `POST /api/auth/logout-all` 与「全部退出」按钮；CORS 支持凭据回显。
7. **体验补丁**：首屏同步期间列表展示骨架屏（不再误显示"暂无内容"）、随手记/收藏改为每页 100 条「加载更多」、支持 `prefers-reduced-motion`、首次使用跟随系统深浅色。
8. **仓库瘦身**：移出 `.agents/skills/konsta-ui-repo` 的 707 个第三方文件（本地保留、写入 .gitignore），补写正式 `README.md`。

### 离线PWA健壮性、Cmd+K命令面板与媒体体验优化
1. **Service Worker 离线白屏致命缺陷修复**：
   - 升级 Service Worker 缓存版本至 `chillin-v72`；
   - 预缓存包含 `public/js/` 下全部核心模块（当前 26 个；另有 `app.js` / `style.css` / `vendor/dompurify.min.js`，由 `tests/sw.test.mjs` 自动核对）；
   - 修复当用户断网时，抓取 `/js/*.js` 错误回退到 `/index.html` 导致浏览器抛出 `Uncaught SyntaxError: Unexpected token '<'` 的白屏问题；离线严格匹配已缓存 JS 模块。
2. **搜索中心升级为现代 Cmd+K 命令面板 (Command Palette)**：
   - 支持快捷指令库：默认或输入 `>` 展示「呼叫 AI 回响」、「快速写随手记」、「新建笔记」、「撰写周记」、「新建提示词」、「新增收藏」、「立即云同步」等高频操作；
   - 关键词命中高亮：在标题与正文摘要中使用 `<mark class="search-highlight">` 清晰标明匹配原因，保持严格的 HTML 安全转义；
   - 键盘全无障碍操作：支持 `↑` / `↓` 循环选定焦点，`Enter` 键直接执行指令或直达记忆卡片。
3. **网络断网离线感知与自动补偿重连同步**：
   - 在 `app.js` 中注册 `online` 与 `offline` 事件监听；
   - 断网离线时自动切换 `is-offline` 状态并提示用户数据已本地存储；
   - 重新连接互联网时自动触发 `syncFromApi()`，将离线期间积累的本地脏变更自动推送云端。
4. **外链图片防崩兜底与懒加载**：
   - 周记卡片封面、烟火日常拍立得、随手记媒体预览图统一注入 `loading="lazy"` 与 `decoding="async"`；
   - 统一接入 `onerror` 降级处理器，彻底杜绝外链图片 404/失效时的原生破图碎裂排版。
5. **按需移除多余代码**：
   - 完全移除了后端未启用的 `/api/export` 路由与 `handleExport` 函数，保持后端干净精简。
6. **自动化测试扩充**：
   - 新增 `tests/search.test.mjs`，包含高亮正则、特殊字符转义与 XSS 防御测试；
   - `npm test` 零依赖单测套件增至 13 个用例，全部通过。

### AI 记忆回响（RAG）深度进化（v2.5.25+）
- **提示词全量入库**：RAG 语料全面覆盖 `prompts` 表，支持根据项目/场景/标签精准召回；
- **多轮会话代词继承**：短追问（如“还有吗”、“详细说说”）自动继承上一轮用户主题词；
- **记忆来源可交互跳转**：AI 回答气泡上的检索记忆条目支持一键点击直达对应周记/笔记/随手记/提示词。

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
