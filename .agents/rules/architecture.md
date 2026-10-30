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
   * 如确需引入外部安全库（例如 DOMPurify），必须**自托管**于 `public/vendor/`（现为 `public/vendor/dompurify.min.js` 3.1.7，其 SHA-384 已与官方发布版本逐一比对），**严禁依赖任何第三方 CDN**——`public/_headers` 的 CSP `script-src` 只放行 `'self'` 与三个内联脚本的 sha256 白名单，引入 CDN 会让脚本被浏览器直接拒绝执行；
   * 杜绝在 `package.json` 中随意添加客户端运行时 `dependencies`。
   * **首屏体积预算**：`public/` 下 JS 合计 gzip ≤ 168 KB（v2.5.192 新增长期线索模块后上调）、CSS 合计 gzip ≤ 48 KB、单文件 gzip ≤ 20 KB，由 `tests/architecture.test.mjs` 机器校验。上调预算必须是一次有意识的改动（改测试里的 `BUDGET` 并写明原因），不允许无声膨胀。

---

## 2. 后端 Worker 模块化架构

后端运行在 **Cloudflare Workers (ESM)** 平台，入口由 `wrangler.toml` 指定为 `workers/api.js`，数据库为 **Cloudflare D1 (SQLite)**，对象存储为 **Cloudflare R2**（绑定 `MEDIA` → 桶 `chillin-media`：图片二进制、阅读器书籍正文、D1 备份快照；D1 只保存元数据）。

### 2.1 网关调度入口严格瘦身
* **入口仅限调度**：[`workers/api.js`](../../workers/api.js) 仅作为路由网关、CORS 预检、鉴权闸门和定时 Cron 调度触发器；
* **代码行数约束**：`workers/api.js` 代码行数**严禁超过 300 行**，杜绝重新膨胀为两千行的单体巨石。

### 2.2 严格领域模块归档
所有新增与调整的业务逻辑，必须按职责划分归入 `workers/src/` 相应模块。

（`workers/src/` 共 **33 个模块**：3 个安全原语、1 个鉴权、7 个花园业务域、5 个智能与记忆模块（含长期线索）、1 个审计、15 个 Bot 模块（对话编排 / 管家写入 / 管家管理 / 交流偏好 / 私人记忆 / 主动关怀 / 定点提醒 / 健康打卡 / 联网检索 / 检索上游适配 / 图片接入 / 多图编排 / 看图 / 链接速览 / 外部 IM 接入）、1 个定时任务编排。新增模块必须同步补进本表，[`tests/docs.test.mjs`](../../tests/docs.test.mjs) 会校验覆盖完整性。）

| 模块文件 | 领域职责 | 约束说明 |
| :--- | :--- | :--- |
| [`workers/src/security.js`](../../workers/src/security.js) | 安全门面 | 只做再导出（network + crypto），保证各子域从单一入口取安全能力，避免循环依赖。 |
| [`workers/src/security-network.js`](../../workers/src/security-network.js) | 网络与输入防线 | CORS / 安全响应头、跨实例共享限流、客户端 IP 取信、图片二进制魔数嗅探、输入校验、`jsonResponse` 与 SSE 包装。 |
| [`workers/src/security-crypto.js`](../../workers/src/security-crypto.js) | 密码学原语 | PBKDF2-SHA256 强哈希（60 万次 + 动态盐，旧哈希登录时透明升级）、`timingSafeEqualStr` 恒定时间比对、口令强度校验。 |
| [`workers/src/auth.js`](../../workers/src/auth.js) | 账号鉴权与会话 | 注册 / 登录 / 登出、Cookie + Bearer 双轨会话签发与轮换（库内只存令牌摘要）、设备列表与吊销、自助改密（验旧密码 + 吊销其它会话）、Web Push 订阅。 |
| [`workers/src/garden-shared.js`](../../workers/src/garden-shared.js) | 花园公共设施 | 行格式化、归属与软删校验、墓碑 id 集合查询、惰性 schema 守卫。 |
| [`workers/src/garden-resources.js`](../../workers/src/garden-resources.js) | 数字花园资产领域 | 周记、笔记、随手记、收藏、提示词 CRUD 与软删、阅读进度同步。 |
| [`workers/src/garden-sync.js`](../../workers/src/garden-sync.js) | 增量同步与统计 | 聚合增量拉取 `/api/sync/pull`、脏数据批量推送（D1 分片）、热力图、备份邮件（每人每小时 3 封 + 可选收件人白名单 + 文件名净化）。 |
| [`workers/src/garden-export.js`](../../workers/src/garden-export.js) | 全量数据导出 | `GET /api/export`：把只存在 D1 的阅读进度、云端书库元数据、健康打卡、Bot 档案/提醒/近期对话与五类花园资产一并导出；显式字段白名单，**绝不含会话、Bot 令牌与轮询游标**；R2 图片与书籍正文不进 JSON，`omissions` 写明范围。 |
| [`workers/src/garden-media.js`](../../workers/src/garden-media.js) | 媒体存储领域 | 图片上传（二进制写 R2，D1 只存元数据）、带访问令牌与 Range 的下发、R2 备份快照保留策略。 |
| [`workers/src/garden-books.js`](../../workers/src/garden-books.js) | 阅读器云书库 | 书籍正文存 R2（对象键为书籍指纹的 SHA-256）、书目元数据 CRUD、跨设备下载与软删墓碑。 |
| [`workers/src/garden-echo.js`](../../workers/src/garden-echo.js) | 回响、通知与审计入口 | AI 回响卡片、周期回顾、Web Push 通知派发、UGC 审计入口。 |
| [`workers/src/insights.js`](../../workers/src/insights.js) | 长期线索与行动转化 | 从最近 180 天的随手记/笔记/周记里做确定性主题聚类：显式 `#标签`/`[[双链]]` 优先，中文 2–4 字词组与英文词兜底；同一主题至少跨 2 个自然月、跨度 ≥14 天才成为线索，证据只回短句与日期，不导出全文。`GET /api/insights/threads` 供首页「正在生长的线索」；`buildThreadCandidates` 把多记录线索交给主动关怀，让 Bot 能说「你之前也想过这个」；`POST /api/reminders` 复用 `createReminderAt` 把线索落成明晚微信提醒。不调用模型、不新增迁移，关闭的线索只在客户端本地 30 天。 |
| [`workers/src/rag.js`](../../workers/src/rag.js) | 记忆回响 RAG 引擎 | 自然语言时间范围解析、停用词过滤、分词、多轮上下文继承、全资产多特征加权打分与兜底回复。 |
| [`workers/src/rag-index.js`](../../workers/src/rag-index.js) | 长期记忆候选层 | 五类花园内容的 D1 候选查询、FTS5 命中回表、LIKE 短词兜底、wikilink 关联加载；不负责排序，保持 `rag.js` 不越过 500 行红线。 |
| [`workers/src/llm.js`](../../workers/src/llm.js) | 大模型网关集成 | DeepSeek 与 Workers AI 边缘调用、流式与非流式包装、敏感词合规审查。 |
| [`workers/src/ai.js`](../../workers/src/ai.js) | AI 问答编排 | `/api/ai/chat` 编排层：RAG 召回 → 模型调用 → SSE 流式推送（从网关下沉而来）。 |
| [`workers/src/audit.js`](../../workers/src/audit.js) | 自动化安全与审计 | 定时 Cron UGC 违规扫描与隔离区备份、违规规则集、审计日志保留清理。 |
| [`workers/src/bot-commands.js`](../../workers/src/bot-commands.js) | Bot 对话编排（chat-first；v2.5.176 聊天提示词改为按语境自然回应，不默认共情、不习惯性建议/总结、不机械限长） | ClawBot 的消息分流层：**默认只聊天、不写库**（意图反转），只有显式「记录：…」才落随手记、「记住 / 忘记」才动档案（光杆「记录」= 确认把待存图片写进随手记，图片默认不落库）；`claimBotMessage` 幂等排重、「搜 X」检索记忆、「问 X」走 Echo AI（独立限流桶）；来源脚注默认不附，只有用户追问依据时才给，且标签统一成「[类型] YYYY-MM-DD」（v2.5.148 起联网答案也默认不带来源，追问时把上一轮存下的出处原样还给他，不再出站）；v2.5.134 起所有指令先过 `normalizeCommandText`（剥成对包裹符与句末标点，被引号包着的「记录：…」也认），系统提示词同时明令模型不得自称「已保存 / 存好了」；v2.5.139 起把「系统真的会做的事」的指令清单写进提示词（模型不再答「我没有写入能力」），并对光杆「记住」与「提醒我…」两类请求走确定性回复：前者要内容，后者如实说没法定点提醒；v2.5.145 起时间锚点连星期一起给（只给日期时模型会把「这周六周日」算错一天）。 |
| [`workers/src/bot-image-flow.js`](../../workers/src/bot-image-flow.js) | Bot 多图编排 | 一条消息多张图、连续图片批次与深度看图问答：默认快速逐张识图，多图先合进 `bot_pending_media` 待存批次；用户问到表格/图表/截图共同问题时把整批图交给模型，追问时从 R2 取回原图；回「记录」才按张落随手记，未确认绝不动业务表。 |
| [`workers/src/bot-garden.js`](../../workers/src/bot-garden.js) | Bot 管家写入 | 确定性指令才落库：随手记（含待存图/链接确认）、收藏、提示词；解析链接/分类/标题/备注，格式不对只给发法、绝不乱写；不靠模型猜字段。 |
| [`workers/src/bot-preferences.js`](../../workers/src/bot-preferences.js) | Bot 交流偏好 | 独立于「关于我」事实档案的表达方式记忆：微信反馈（太官方 / 太啰嗦 / 不用安慰）先写 `bot_pending_actions` 提案，回「确认」才落库；聊天、RAG 回答与主动关怀都注入同一份偏好；全部软删，带 8 条 / 800 字符预算。 |
| [`workers/src/bot-butler.js`](../../workers/src/bot-butler.js) | Bot 管家管理 | 收藏 / 提示词的列表、编辑、删除：改动先写 `bot_pending_actions`，回「确认」才执行，10 分钟过期；删除一律 `is_deleted = 1` 软删；预览阶段不落库，编号与字段都做归属/格式校验。 |
| [`workers/src/bot-memory.js`](../../workers/src/bot-memory.js) | Bot 私人记忆 | 三层记忆的读写入口：有限长度的对话上下文（按字符预算截断）与「关于我」档案条目的增删查，一律软删、全部参数化绑定并受体积上限约束；并暴露应用内 `/api/bot/profile` 读写接口供「账号与安全」弹层可视化编辑；另有「待存图片」暂存位（`bot_pending_media`，每人一张、60 分钟过期）承接图片消息的确认落库。 |
| [`workers/src/bot-outreach.js`](../../workers/src/bot-outreach.js) | Bot 主动关怀 | 没人说话时的开口资格判定（v2.5.177 起提示词改为熟悉朋友口吻，不称伴侣、不亲密称呼或煽情）：东八区 10:00–22:30 时窗内每天至多一次的随机开口时刻、刚聊完 30 分钟内不插嘴（6 小时内聊过则不等当天固定时刻，改在聊完 30–120 分钟内把最近 6 轮对话作为背景、允许顺着话题补一句）与只用 3–180 天前旧素材的门禁、模型 SKIP 否决权与概率闸门、账号级开关与逐条发送审计（正文落库但不进日志）；送达后把主动消息写进对话记忆并标注出处，保证用户回一句时接得上。 |
| [`workers/src/bot-reminders.js`](../../workers/src/bot-reminders.js) | Bot 定点提醒 | 「提醒我 20:00 …」的时刻解析（中文数字 / 今天明天 / 早上晚上 / 相对时间；解析不了宁可反问也不猜）、每分钟 cron 到点用空 `context_token` 主动开口、30 分钟后只追问一次、超 2 小时标 missed 不补发、发送失败退回 pending 等下一分钟、回「完成」沉淀成随手记；与主动关怀分表分开关（一句「别主动找我」关不掉提醒）。 |
| [`workers/src/bot-health.js`](../../workers/src/bot-health.js) | Bot 健康打卡 | 小米运动健康云服务接入的 A 方案（先落地「用户自己一句话记」）：把「昨晚睡了 6 小时 20 分，8500 步」解析成**一天一行**的结构化数据落进 `health_daily`（`UNIQUE(user_id, date)` + UPSERT，null 不覆盖旧值），只认显式格式，普通聊天一律还给聊天；斤折半成公斤、越界值不写库但在回执里点名；日期一律东八区（「昨晚」归昨天）；「健康」回最近 7 天汇总，只统计真的记过该字段的天。**只读回显、不写回小米**；`maybeRunHealthCommand` 是 `bot-commands.js` 的唯一接线口（本模块保持 ≤500 行，编排层停在 499 行）。 |
| [`workers/src/bot-search.js`](../../workers/src/bot-search.js) | Bot 检索上游适配 | 从 `bot-web.js` 拆出的「怎么问上游、怎么读回包」：主用 DeepSeek 官方 Search（`POST /v1/tools/search`，地址从 `LLM_API_BASE` 推导、缺 `/v1` 自动补，复用 `LLM_API_KEY`），Jina 只作回落开关；v2.5.149 起请求带 `need_content` 与相对时间日期锚（`dateHints`：今天 / 明天 / 昨天 / 这周六周日 → 具体日期，解析不出就一个字不加），正文够长（≥200 字）优先于 `summary`（表格页只给 summary 会退化成「只看到标题」）；回包上限 1 MB，JSON 形状但解析失败一律返回空数组——半截 JSON 绝不当来源；v2.5.150 起支持多检索词并行（`runWebSearchMulti`：最多 3 条，按 URL 去重保留 `rerank_score` 高的副本、按分数降序取前 8，部分失败不影响整体）并解析上游 `rerank_score`，客户端检索死线 20s→12s（DeepSeek 实测 330–530ms）；只依赖 fetch，不碰 D1、提示词与存储。 |
| [`workers/src/bot-web.js`](../../workers/src/bot-web.js) | Bot 联网检索 | 三条闸门（显式「查一下」/ 时效性问句 → 出站；提到自己的记录 → 强制回本地 RAG），搜索取来源后由模型按来源作答（v2.5.148 起默认只给结论，追问「来源 / 依据 / 哪查的」时才附前 3 条出处，追问走上下文与缓存里的全量出处、不再出站），结果 6 小时缓存（v2.5.147 起命中不扣额度）、每人每天 100 次上限（`WEB_DAILY_LIMIT` 可配）与每分钟 2 次突发闸（`WEB_BURST_LIMIT`）、失败按原因给下一步；上游自 v2.5.146 起主用 DeepSeek 官方 Search（`POST /v1/tools/search`，复用 `LLM_API_KEY`，`ori_question` 带用户原话，`summary` 与站点/东八区日期进提示词；边缘实测 417ms 出 5 条，同一查询 Jina 用 1533ms 且无日期站点），Jina 只作回落（`SEARCH_PROVIDER=jina`，或 `SEARCH_API_URL` 指向旧 GET 端点时自动沿用，仍走摘要模式 `X-Respond-With: no-content` + `X-Timeout: 10`），服务端 10s 超时，客户端两道死线（检索 20s + 合成 20s）合计不占满一轮 cron 收信预算（55s）；半截 JSON 一律当没有来源，绝不把 JSON 碎片当摘要喂给模型；时间锚点带星期；上游适配层自 v2.5.149 起拆到 [`workers/src/bot-search.js`](../../workers/src/bot-search.js)，本文件只管闸门、合成、缓存与回复组装，同时候选 5→8、单条上限 1200→3000 字、提示词上下文 5000→12000 字，正文（≥200 字）优先于 summary，相对时间问句并进具体日期，并新增时区规则：网页给的多是当地时区（NBA 默认美东），结论要换算成北京时间并说明差异；v2.5.150 起闸门认「查看一下」并在时效性词表补上「比赛 / 开赛 / 下一场 / 下次 / 接下来」、疑问形状补上「什么时间 / 哪一场 / 第几场」（线上「查看一下76人下次比赛是什么时间」曾漏判走聊天路径、复述上一轮旧来源），并先做一次 4s 死线的检索词规划（`planWebQueries` + `parseQueryLines`：没配 `LLM_API_KEY` 就跳过）再多条并行检索；三道死线改为规划 4s + 检索 12s + 合成 20s = 36s。 |
| [`workers/src/bot-claw.js`](../../workers/src/bot-claw.js) | 外部 IM 接入（微信 ClawBot / iLink 协议） | 扫码绑定生命周期（二维码 / 确认 / 解绑，令牌只落库不回传）、每分钟 Cron 长轮询拉消息、游标与幂等排重、瞬时 5xx 在本次 deadline 内退避重拉（v2.5.131，不丢整分钟收信窗口）、经 iLink `sendmessage` 回发文本；v2.5.139 起每轮 cron 首次成功拉信时擦掉历史 `last_error` 并把 `last_poll_at` 刷成这一刻（该字段表示「最近一次成功轮询」，不再只在游标变化时更新，避免界面停在「通道已死」的旧值上）。 |
| [`workers/src/bot-media.js`](../../workers/src/bot-media.js) | Bot 图片接入 | 微信图片消息（外层 `message_type` 仍是 1，靠 `item.type=2` 的 `image_item` 识别）→ 下载 → 明文魔数嗅探，嗅不出再用 `aeskey` 走 **AES-128-ECB + PKCS7** 解密（v2.5.126 用真实报文离线枚举确证：`aeskey` 线上实测是 32 位 hex = 16 字节，CBC 的「IV 取密钥前 16 字节 / 全零」与 AES-256 猜测全部否证，只作兼容兜底；WebCrypto 没有 ECB，故自带纯 JS 的查表解密实现）；地址、密钥与模式都可能有多份形态（`item.aeskey` / `media.aes_key` / 「hex 再 base64」的中间层、直链 / 需拼回 `encrypt_query_param` 授权参数的地址、ECB / CBC 两种 IV），逐组尝试、任一组嗅出真实魔数才认账；失败时原因码带 tried 列表与响应前 8 字节的十六进制（可一眼看出是 CDN 错误页或微信的 `wxgf` 私有容器） → 经既有上传通道写 R2，并进「待存位」（默认无副作用：不回写 `quick_feeds`，用户 60 分钟内回「记录」才写成带图随手记，见 `0027_bot_pending_media.sql`）；取不到原图只如实告知，绝不落库，任何一步都不记正文。回信直接把描述说给用户（v2.5.130 起不再加「我看到：」前缀）；存图（R2）与看图（模型）并行，回信只等较慢的那个。 |
| [`workers/src/bot-vision.js`](../../workers/src/bot-vision.js) | Bot 看图（Vision） | 把微信图片交给多模态模型换回一句中文描述（v2.5.127 起，DeepSeek 官方端点实测可读图：202614 字节 JPEG 1355ms 返回正确中文描述）。密钥独立成 `VISION_API_KEY`（缺省回落 `LLM_API_KEY`），8 秒超时、描述压平并截断 120 字、过 `moderateText`；**没有密钥 / 报错 / 超时 / 内容安全拦截一律返回空串**，存图与回复绝不受影响。v2.5.129 起提示词改成「朋友随口说一句」的口气（≤40 字、禁「这张图 / 画面中」的复述腔、是截图就点出是什么应用在讲什么），去掉标签腔；v2.5.130 起再加一条「只说你看到的、别猜归属」的硬约束；描述目标 ≤40 字，v2.5.131 把 `VISION_MAX_TOKENS` 从 200 收到 120。 |
| [`workers/src/bot-links.js`](../../workers/src/bot-links.js) | Bot 链接速览（小宇宙） | 把微信里发来的小宇宙单集/播客链接读成一张卡片：服务端抓一次 og 元数据（单集页线上实测 169529 字节，`og:title` = 单集标题、`<title>` 第二段 = 播客名、内联 JSON 的 `"duration"` 给时长；播客页自 v2.5.133 起只取 `og:description` 当简介、不给时长——页面上混着 33 个单集各自的 `"duration"`，`<title>` 第二段是站点模板尾巴「听播客，上小宇宙」；`http://` 链接只回一句「我只会读 https 的页面」，仍一次都不出站），封面转存 R2 后写自家 `/api/file/...`；卡片 JSON（title / description / cover / platform / icon）进「待存位」，用户回「记录」才连同原始链接写进 `quick_feeds.summary`——前端 `public/js/feeds.js` 据此渲染富链接卡片，零前端改动。**出站抓取边界极紧**：只认 `xiaoyuzhoufm.com` 与图床 `xyzcdn.net`、强制 https + 443、手动跟重定向并逐跳复核域名、6 秒超时、HTML 512KB / 封面 4MB 上限、IP 字面量与私网主机拒绝；白名单之外的链接一次都不出站（原样交回聊天）。**出口现实**：Cloudflare 出口 IP 已被小宇宙 403 封（2026-10-21 边缘探针确证：页面与数据路由全 403、官方 API 401、图床 `xyzcdn.net` 200、住宅 IP 200），故抓取仅作尽力而为；失败时如实说明原因并给出「记录：<链接>」或「记录：<标题> <链接>」的手动兜底；v2.5.135 起 `buildManualLinkCard(text)`（纯函数、零出站）会把「<标题> <链接>」落成带标题的真卡片（小宇宙域名补 `platform/icon`，无封面不编封面）；v2.5.136 起 `parseXiaoyuzhouPage` 优先解析页面自带的 `__NEXT_DATA__`（`pageProps.episode` / `pageProps.podcast`），og / `<title>` 拆分退为回落；v2.5.137 起直连失败且配置了 `LINK_READER_API_KEY` 时，可选交给第三方读取服务代读一次（默认 `https://r.jina.ai`，`LINK_READER_URL` 可换、只认 https，密钥同时以 `Authorization: Bearer` 与 `x-api-key` 发出），返回的 Microlink 形状 JSON 元数据也认——但封面同样要过图床白名单，且**未配置密钥时这条路径完全关闭**；v2.5.138 起代读只请求 `Accept: text/html`（Jina 见到 `application/json` 会回 JSON，而 JSON 没有封面字段），若仍是 JSON 就从 `data.html` 取内嵌 HTML 再解析；v2.5.140 起卡片只装封面、标题、详情——单集详情取结构化 `episode.description`（缺失时 `shownotes` 去标签、再退 og:description、最后播客名兜底），`"duration"` 解析整块删除（用户明确说「要的是封面/标题/详情，不是时间」）。 |
| [`workers/src/maintenance.js`](../../workers/src/maintenance.js) | 定时任务编排 | 按 Cron 表达式分流：`* * * * *` 只跑 ClawBot 长轮询，`13 * * * *` 跑小时级维护（UGC 扫描、会话清理、限流清理、备份保留、审计保留）。 |

---

## 3. 数据库与数据流转 (D1 Database)

1. **迁移一致性**：所有数据库表结构变动必须在 `migrations/` 下按编号规范创建新的 `.sql` 迁移文件（如 `0015_xxx.sql`），禁止在代码中执行破坏性无记录 DDL；
2. **边缘查询就近优化**：利用 D1 与 Worker 同机房特性，多表读取优先通过 `Promise.all` 并发预编译执行，禁止低效嵌套串行查询。

### 3.1 完整备份与灾难恢复

* **完整备份必须同时覆盖 D1 与 R2**：`npm run backup:full` 生成 `backups/full-<UTC>/`，内含 D1 SQL、`r2/uploads/`、`r2/books/` 和 `manifest.json`；清单逐个记录 R2 key、size、SHA-256、MIME，D1 记录 gzip/SQL 双层哈希、表清单与迁移版本。
* **D1 含 FTS5 时不能直接 `wrangler d1 export`**（会报 “cannot export databases with virtual tables”）：`scripts/d1-export.mjs` 从 `sqlite_master` 取 schema（含 FTS 虚表与触发器），只对真实表导数据；恢复时由 0034 的触发器重建 `memory_fts`。
* **恢复顺序固定为 R2 → D1**：先恢复对象，再恢复会立即指向这些对象的元数据；`npm run restore:full -- <dir> --yes` 是远端生产入口，默认先清空旧业务表（`--no-reset` 可保留），`--local` 用于演练，`--dry-run` 只校验不写入。
* **校验是恢复前置条件**：`npm run backup:verify -- <dir>` 校验每个文件的大小与 SHA-256、D1 gzip/SQL 可解压、清单自哈希和路径穿越；任何一项失败都拒绝恢复。
* **定期演练**：`npm run backup:drill` 在临时独立目录生成/复制/破坏/再校验最小备份；`Restore Drill` GitHub Actions 每周跑一次。真实生产包仍应每季度恢复到 staging D1/R2 抽查。
* **R2 二进制不会自动异桶**：完整备份目录默认留在本机；必须复制到离线介质或另一个账号/桶，否则源桶丢失时清单本身无法恢复图片。历史 `backups/` 快照不重复打包，避免自我引用。
