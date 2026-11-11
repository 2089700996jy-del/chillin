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
   * **首屏体积预算**：`public/` 下 JS 合计 gzip ≤ 195 KB（新增 Web 桌面工作台边栏、三栏 Agent 驾驶舱与双栏笔记工作台后上调并剪裁冗余）、CSS 合计 gzip ≤ 58 KB、单文件 gzip ≤ 20 KB，由 `tests/architecture.test.mjs` 机器校验。上调预算必须是一次有意识的改动（改测试里的 `BUDGET` 并写明原因），不允许无声膨胀。

---

## 2. 后端 Worker 模块化架构

后端运行在 **Cloudflare Workers (ESM)** 平台，入口由 `wrangler.toml` 指定为 `workers/api.js`，数据库为 **Cloudflare D1 (SQLite)**，对象存储为 **Cloudflare R2**（绑定 `MEDIA` → 桶 `chillin-media`：图片二进制、阅读器书籍正文、D1 备份快照；D1 只保存元数据）。

### 2.1 网关调度入口严格瘦身
* **入口仅限调度**：[`workers/api.js`](../../workers/api.js) 仅作为路由网关、CORS 预检、鉴权闸门和定时 Cron 调度触发器；
* **代码行数约束**：`workers/api.js` 代码行数**严禁超过 300 行**，杜绝重新膨胀为两千行的单体巨石。

### 2.2 严格领域模块归档
所有新增与调整的业务逻辑，必须按职责划分归入 `workers/src/` 相应模块。

（`workers/src/` 共 **50 个模块**：3 个安全原语、1 个鉴权、8 个花园业务域、16 个智能与记忆模块（含 Agent 工具层、Agent 扩展工具、Agent 循环、目标存储/执行/生命周期/后台调度/规划/受控审批/检查点/只读联网与长期线索）、1 个审计、20 个 Bot 模块（对话编排 / 提示词与指令辅助 / 管家写入 / 管家管理 / 交流偏好 / 私人记忆 / 主动关怀 / 关怀素材挖掘 / 定点提醒 / 健康打卡 / 联网检索 / 检索上游适配 / 天气服务与晨报关怀 / 图片接入 / 多图编排 / 看图 / 链接速览 / 外部 IM 接入 / 微信扫码认证 / 纯文本格式化）、1 个定时任务编排。新增模块必须同步补进本表，[`tests/docs.test.mjs`](../../tests/docs.test.mjs) 会校验覆盖完整性。）

| 模块文件 | 领域职责 | 约束说明 |
| :--- | :--- | :--- |
| [`workers/src/security.js`](../../workers/src/security.js) | 安全门面 | 只做再导出（network + crypto），保证各子域从单一入口取安全能力，避免循环依赖。 |
| [`workers/src/security-network.js`](../../workers/src/security-network.js) | 网络与输入防线 | CORS / 安全响应头、跨实例共享限流、客户端 IP 取信、图片二进制魔数嗅探、输入校验、`jsonResponse` 与 SSE 包装。 |
| [`workers/src/security-crypto.js`](../../workers/src/security-crypto.js) | 密码学原语 | PBKDF2-SHA256 强哈希（10 万次 + 动态盐，Cloudflare Workers 硬上限；旧哈希登录时透明升级）、`timingSafeEqualStr` 恒定时间比对、口令强度校验。 |
| [`workers/src/auth.js`](../../workers/src/auth.js) | 账号鉴权与会话 | 注册 / 登录 / 登出、Cookie + Bearer 双轨会话签发与轮换（库内只存令牌摘要）、设备列表与吊销、自助改密（验旧密码 + 吊销其它会话）、Web Push 订阅。 |
| [`workers/src/garden-shared.js`](../../workers/src/garden-shared.js) | 花园公共设施 | 行格式化、归属与软删校验、墓碑 id 集合查询、惰性 schema 守卫。 |
| [`workers/src/garden-resources.js`](../../workers/src/garden-resources.js) | 数字花园资产领域 | 周记、笔记、随手记、收藏、提示词 CRUD 与软删、阅读进度同步。 |
| [`workers/src/garden-sync.js`](../../workers/src/garden-sync.js) | 增量同步与统计 | 聚合增量拉取 `/api/sync/pull`、脏数据批量推送（D1 分片）、热力图数据统计。 |
| [`workers/src/garden-backup-mail.js`](../../workers/src/garden-backup-mail.js) | 数据备份邮件直发 | 承接全量 ZIP 压缩包经由 Resend API 发送至用户邮箱，带频控（每人每小时 3 封）与白名单校验。 |
| [`workers/src/garden-export.js`](../../workers/src/garden-export.js) | 全量数据导出 | `GET /api/export`：把只存在 D1 的阅读进度、云端书库元数据、健康打卡、Bot 档案/提醒/近期对话与五类花园资产一并导出；显式字段白名单，**绝不含会话、Bot 令牌与轮询游标**；R2 图片与书籍正文不进 JSON，`omissions` 写明范围。 |
| [`workers/src/garden-media.js`](../../workers/src/garden-media.js) | 媒体存储领域 | 图片上传（二进制写 R2，D1 只存元数据）、带访问令牌与 Range 的下发、R2 备份快照保留策略。 |
| [`workers/src/garden-books.js`](../../workers/src/garden-books.js) | 阅读器云书库 | 书籍正文存 R2（对象键为书籍指纹的 SHA-256）、书目元数据 CRUD、跨设备下载与软删墓碑。 |
| [`workers/src/garden-echo.js`](../../workers/src/garden-echo.js) | 回响、通知与审计入口 | AI 回响卡片、周期回顾、Web Push 通知派发、UGC 审计入口。 |
| [`workers/src/insights.js`](../../workers/src/insights.js) | 长期线索与行动转化 | 从最近 180 天的随手记/笔记/周记里做确定性主题聚类：显式 `#标签`/`[[双链]]` 优先，中文 2–4 字词组与英文词兜底；同一主题至少跨 2 个自然月、跨度 ≥14 天才成为线索，证据只回短句与日期，不导出全文。`GET /api/insights/threads` 供首页「正在生长的线索」；`buildThreadCandidates` 把多记录线索交给主动关怀，让 Bot 能说「你之前也想过这个」；`POST /api/reminders` 复用 `createReminderAt` 把线索落成明晚微信提醒。不调用模型、不新增迁移，关闭的线索只在客户端本地 30 天。 |
| [`workers/src/rag.js`](../../workers/src/rag.js) | 记忆回响 RAG 引擎 | 自然语言时间范围解析、停用词过滤、分词、多轮上下文继承、全资产多特征加权打分与兜底回复。 |
| [`workers/src/rag-index.js`](../../workers/src/rag-index.js) | 长期记忆候选层 | 五类花园内容的 D1 候选查询、FTS5 命中回表、LIKE 短词兜底、wikilink 关联加载；不负责排序，保持 `rag.js` 不越过 500 行红线。 |
| [`workers/src/llm.js`](../../workers/src/llm.js) | 大模型网关集成 | DeepSeek 与 Workers AI 边缘调用、流式与非流式包装、敏感词合规审查。 |
| [`workers/src/ai.js`](../../workers/src/ai.js) | AI 问答编排 | `/api/ai/chat` 编排层：优先走只读 Agent 工具循环；模型不可用，或记录类问题没有触发任何工具时，退回 RAG 以确保基于真实数据；SSE 额外推送 `tool` 轨迹事件。 |
| [`workers/src/ai-tools.js`](../../workers/src/ai-tools.js) | Agent 只读工具层 | 四个基础只读工具（花园概览 / 最近记录 / 关键词检索 / 读取单条）与 Tool Gateway：JSON Schema 参数校验、用户隔离、软删过滤、时间窗、引用返回；硬拒绝任何非 `read` 工具。 |
| [`workers/src/agent-tools-expanded.js`](../../workers/src/agent-tools-expanded.js) | Agent 扩展只读工具 | 阶段 3 的花园垂直列表（周记 / 随手记 / 收藏 / 提示词）、混合检索 `search_memory`（FTS5/LIKE + wikilink/共同标签关联扩展）与长期线索 `get_recurring_threads`；全部按 `user_id` 隔离、过滤软删并返回 `[类型#id]` 引用，不写库。 |
| [`workers/src/ai-runtime.js`](../../workers/src/ai-runtime.js) | Agent Runtime | Function Calling 多步循环：最多 6 步 / 8 次工具调用、45 秒总预算、20 秒单次模型超时、重复调用熔断、工具错误回传、模型失败降级、引用白名单清洗；默认只读，但允许调用方注入额外工具（任务执行器用它提供 `propose_write` 提案工具），本身不直接写库、不审批。 |
| [`workers/src/agent-store.js`](../../workers/src/agent-store.js) | Agent 目标存储层 | 目标 / 任务 / 运行 / 步骤 / 审批五张表的查询与格式化：所有读写强制 `user_id` 归属、目标软删、依赖只认前序 `seq`、任务状态机与进度汇总；审批收件箱按用户跨目标聚合未过期 pending，只返回标题与 180 字预览，不返回全文；不调用模型、不写业务内容。 |
| [`workers/src/agent-executor.js`](../../workers/src/agent-executor.js) | Agent 目标执行器 | 一次请求或 cron tick 只推进一个任务：用 120s 活跃窗口区分“并发执行中”与“崩溃遗留的 running”、选下一个依赖就绪任务、调用阶段 1 只读 Agent 循环、把结构化结果写进 `agent_steps`、按 `max_attempts` 重试、全部完成时汇总 `result_md`；任务开始写 180s 租约，结束/暂停/失败清租约，成功后留下 `next_run_at` 交给后台续跑；任务 Agent 额外获得 `propose_write` 与 `web_search`/`fetch_url`；写入/发送只能创建审批、不能直接执行；任务完成后调用 `agent-checkpoint` 判断是否只重规划剩余任务；通知委托 `agent-approvals`。 |
| [`workers/src/agent-lifecycle.js`](../../workers/src/agent-lifecycle.js) | Agent 目标生命周期状态机 | 目标启停/继续/暂停/完成与任务重试状态机，任务提示词与睡眠指令解析。 |
| [`workers/src/agent-web.js`](../../workers/src/agent-web.js) | Agent 只读联网工具 | `web_search`（DeepSeek/Jina 检索，最多 6 条）与 `fetch_url`（公开 https、拒绝 localhost/私网/IP，直连失败回落到读取服务）；只读、截断 12k 字符、内容视为数据而非指令。 |
| [`workers/src/agent-checkpoint.js`](../../workers/src/agent-checkpoint.js) | Agent 任务后检查点 | 任务完成后先识别 BLOCKED/阻塞/缺少工具或来源；命中则暂停目标并把任务置 blocked，后续 continue 被 GOAL_BLOCKED 拦截，需走重新规划；所有任务完成后若目标要求 Bot 发送且无 pending/approved 审批，自动创建 send_bot_message 审批；目标勾选 auto_send 时自动同意并发送，否则暂停等待用户；否则最多询问一次结果是否足够，不足时只重写未完成任务，保留已完成结果，新任务依赖映射到新 seq；最多 3 个计划版本；模型失败/输出非法一律继续原计划。 |
| [`workers/src/agent-scheduler.js`](../../workers/src/agent-scheduler.js) | Agent 后台续跑调度 | 每分钟 Cron 从 `agent_runs` 原子认领一条到期 `queued` 或租约过期的 `running`，推进 active 目标任务；同目标不并行，租约 180s 防重，失败退避 120s；提供 `queueGoal` 供 Bot 等短请求只排队不执行。 |
| [`workers/src/agent-goals.js`](../../workers/src/agent-goals.js) | Agent 目标 API 与规划 | 目标 CRUD、模型生成计划（最多 8 个任务、依赖前序下标、非法输出回落三步计划；外部事实规划 `web_search`；Bot 发送必须规划 `send_bot_message` 审批）、生命周期流转、重新规划与编辑草稿；审批委托 `agent-approvals`。 |
| [`workers/src/agent-approvals.js`](../../workers/src/agent-approvals.js) | Agent 审批与通知 | `save_note` 新建笔记、`append_note` 原子追加、`send_bot_message` 发微信 Bot；`requestAgentProposal` 接收提案并生成 pending 审批；单 pending、过期作废、归属校验、同意幂等；目标完成/失败/审批创建复用 Web Push。 |
| [`workers/src/audit.js`](../../workers/src/audit.js) | 自动化安全与审计 | 定时 Cron UGC 违规扫描与隔离区备份、违规规则集、审计日志保留清理。 |
| [`workers/src/bot-text.js`](../../workers/src/bot-text.js) | Bot 文本格式化 | 把模型 Markdown 转成微信可读纯文本：标题→【】、粗体去星号、列表→•、表格→·、链接→标题：URL、去代码围栏与多余空行；发送前统一过这一层。 |
| [`workers/src/bot-commands.js`](../../workers/src/bot-commands.js) | Bot 对话编排（chat-first，自然回应） | ClawBot 消息分流层：**默认只聊天、不写库**，显式「记录：…」落随手记、「记住/忘记」动档案（光杆「记录」确认待存图落库）；`claimBotMessage` 幂等排重、「搜 X」查记忆、「问 X」走 Echo AI；来源脚注默认不附（用户追问时给出「[类型] YYYY-MM-DD」）；指令前置 `normalizeCommandText` 净化；系统提示词声明真实能力与确定性回复规则；时间锚点附带星期。 |
| [`workers/src/bot-prompts.js`](../../workers/src/bot-prompts.js) | Bot 提示词与指令格式化辅助 | 小助手帮助文本、系统提示词模板、输入包裹符剥除与来源标签格式化。 |
| [`workers/src/bot-image-flow.js`](../../workers/src/bot-image-flow.js) | Bot 多图编排 | 一条消息多张图、连续图片批次与深度看图问答：默认快速逐张识图，多图先合进 `bot_pending_media` 待存批次；用户追问多图共同问题时将批次交由模型处理；回「记录」才按张落随手记，未确认不动业务表。 |
| [`workers/src/bot-garden.js`](../../workers/src/bot-garden.js) | Bot 管家写入与目标命令 | 确定性指令落库：随手记（含待存图/链接确认）、收藏、提示词；格式不对只给提示绝不乱写；承载 Bot 目标命令（建目标/我的目标/看目标/开始排队/暂停/审批/同意/拒绝），只调用 `agent-*` 现有接口，排队不执行、写入仍走审批。 |
| [`workers/src/bot-preferences.js`](../../workers/src/bot-preferences.js) | Bot 交流偏好 | 独立于「关于我」事实档案的表达方式记忆：用户偏好反馈先写 `bot_pending_actions` 提案，回「确认」才落库；聊天、RAG 与主动关怀均注入偏好；支持软删并限制 8 条 / 800 字符预算。 |
| [`workers/src/bot-butler.js`](../../workers/src/bot-butler.js) | Bot 管家管理 | 收藏与提示词的管理：改动先写 `bot_pending_actions` 待确认提案，10 分钟过期；删除统一标记 `is_deleted = 1` 软删；预览阶段不落库，全字段校验归属与格式。 |
| [`workers/src/bot-memory.js`](../../workers/src/bot-memory.js) | Bot 私人记忆 | 三层记忆读写：截断上下文记忆、「关于我」事实档案增删查（全软删、参数化绑定、上限约束），并提供 `/api/bot/profile` 应用内编辑接口；维护 `bot_pending_media`（每人一张、60 分钟过期）承接图片确认。 |
| [`workers/src/bot-outreach.js`](../../workers/src/bot-outreach.js) | Bot 主动关怀（朋友口吻，不煽情） | 关怀资格判定：东八区 10:00–22:30 时窗内每天至多随机开口一次；刚聊完 30 分钟内不插嘴，素材取自 3–180 天前旧记录；具备模型 SKIP 否决权与概率闸门；账号级开关与逐条发送审计；送达后写入对话记忆并标注出处。 |
| [`workers/src/bot-outreach-source.js`](../../workers/src/bot-outreach-source.js) | Bot 主动关怀素材挖掘层 | 从 3~180 天前的历史记录中筛选挖掘候选素材、打分与跨月份线索聚类。 |
| [`workers/src/bot-reminders.js`](../../workers/src/bot-reminders.js) | Bot 定点提醒 | 提醒时刻智能解析（中文数字、相对时间，无法解析则反问）；每分钟 cron 到点主动开口；30 分钟后追问一次，超 2 小时标记 missed 不补发；回「完成」沉淀为随手记；独立开关控制。 |
| [`workers/src/bot-health.js`](../../workers/src/bot-health.js) | Bot 健康打卡 | 健康数据结构化沉淀：将步数、睡眠等一句话记入 `health_daily`（一天一行、UPSERT 幂等、旧值保留）；斤单位折半为公斤；日期统一东八区；「健康」指令回显最近 7 天统计；仅只读回显、不写回三方；保持模块在 500 行以内。 |
| [`workers/src/bot-search.js`](../../workers/src/bot-search.js) | Bot 检索上游适配 | 主用 DeepSeek 官方 Search（`POST /v1/tools/search`，复用 `LLM_API_KEY`），Jina 作为回落；请求带 `need_content` 与日期锚点 `dateHints`，正文 ≥200 字优先于 summary；回包上限 1MB，失败回退空数组；支持 `runWebSearchMulti` 多词并行去重检索；客户端检索死线 12s。 |
| [`workers/src/bot-web.js`](../../workers/src/bot-web.js) | Bot 联网检索 | 出站意图闸门（显式「查一下」/时效性问句出站，自身记录强制本地 RAG），检索后由模型合成回答；默认只给结论，追问出处时复用缓存；结果 6 小时缓存，每人每天 100 次上限与每分钟 2 次突发闸；规划 4s + 检索 12s + 合成 20s 严格死线控制；时区换算北京时间并提示差异。 |
| [`workers/src/bot-weather.js`](../../workers/src/bot-weather.js) | 和风天气与晨报关怀 | Ed25519 JWT 与 API Key 双模认证，高精度 24h 逐小时极温与降水区间提取、昨日温差与昼夜温差计算；8:00 晨间关怀「无事不扰」静默门禁；白天随手查秒回（30 分钟缓存）。 |
| [`workers/src/bot-claw.js`](../../workers/src/bot-claw.js) | 外部 IM 接入（微信 ClawBot / iLink 协议） | 每分钟 Cron 长轮询拉消息、游标排重、瞬时 5xx 短退避；经 iLink `sendmessage` 回发文本；成功拉信时刷新 `last_poll_at` 并清除 `last_error`。 |
| [`workers/src/bot-claw-auth.js`](../../workers/src/bot-claw-auth.js) | 微信 ClawBot 扫码认证与 API | 微信 ClawBot 扫码绑定生命周期状态机（二维码获取/扫码轮询/节点重定向切换/绑定/解绑/D1 账户元数据持久化，令牌只落库不回传）与应用内配置 API。 |
| [`workers/src/bot-media.js`](../../workers/src/bot-media.js) | Bot 图片接入 | 微信图片消息解析与下载；明文魔数嗅探失败时采用 AES-128-ECB + PKCS7 解密；支持直链与授权参数等多形态地址逐组探测；魔数验证成功后写入 R2 并存入 `bot_pending_media` 待存位（60 分钟过期）；回「记录」才落随手记；存图与视觉识别并行。 |
| [`workers/src/bot-vision.js`](../../workers/src/bot-vision.js) | Bot 看图（Vision） | 将微信图片交付多模态模型换取中文描述；独立 `VISION_API_KEY`（缺省回落 `LLM_API_KEY`），8 秒超时，描述压平截断 120 字并过 `moderateText`；无密钥/失败/拦截时返回空串，不阻断存图与主回复。 |
| [`workers/src/bot-links.js`](../../workers/src/bot-links.js) | Bot 链接速览（小宇宙） | 服务端解析小宇宙单集/播客页元数据（优先 `__NEXT_DATA__`，回落 og/title），封面转存 R2；卡片存入 `bot_pending_media` 待存位，用户回「记录」落随手记；出站严格遵循域名白名单（`xiaoyuzhoufm.com` / `xyzcdn.net`）、https/443、手动跟随重定向、6s 超时、截断限制；直连 403 时若配置 `LINK_READER_API_KEY` 则可选走第三方代读。 |
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
