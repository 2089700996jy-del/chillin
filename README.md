# Chillin 数字花园

> 一个**零构建**的个人「数字花园」：把随手记、周记、笔记、收藏、提示词、TXT 阅读与 AI 记忆回响收在一处，结构化数据存在自己的 Cloudflare D1 里，图片与书库文件存在 Cloudflare R2 里。

* 线上前端（Cloudflare Pages）：<https://chillin-bfc.pages.dev>
* 线上后端（Cloudflare Worker）：<https://chillin-api.2089700996jy.workers.dev>

## 功能一览

| 模块 | 你能做什么 |
| :--- | :--- |
| 🫧 随手记 | 1 秒记录想法；**含链接的随手记只渲染链接卡片**（v2.5.97 起不再抓取标题 / 封面 / 平台徽标）；支持图片附件；全屏图片灯箱；连续记录徽章与贡献热力图 |
| 📓 周记 | 模块化卡片（烟火日常、音乐影音微件）、时序追加批注 |
| 📝 笔记 | 长文撰写、草稿自动暂存与崩溃恢复、批注讨论流 |
| 🔖 收藏 | 网页 / 图片卡片，一键回跳原站 |
| 🧩 提示词库 | `{{变量}}` 模板参数化、填参预览、一键复制或直发 AI |
| 📖 阅读器 | TXT 导入自动分章（GBK / UTF-8）、章节树、三档主题；**云端书库**（v2.5.100）：正文存 R2，换设备打开书架即可下载续读；**进度双向同步**（v2.5.101）：打开时双向合并、断网进度排队补推、服务端按时间戳拒绝过期写入；**本机书架补传**（v2.5.102）：早年导入、云端还没有的书会自动重组正文补推到 R2（每次会话最多 3 本） |
| 🧠 AI 记忆回响 | 基于个人历史的全域 RAG 检索、多轮代词继承、流式回答、引用卡片一键回跳原文 |
| 🤖 微信 ClawBot | 设置弹层内直接扫码绑定/解绑（90 秒二维码、扫后轮询确认）；绑定后可在微信里记事、提问、设提醒、健康打卡，主动关怀可随时关 |
| 🔍 命令面板 | `⌘K` / `Ctrl+K` 呼出：快捷指令 + 跨模块检索 + 关键词高亮 + 全键盘导航 |
| 📶 PWA | 全部前端模块（26 个 `js/` 模块 + `app.js`）离线预缓存、断网降级、重连自动补偿同步、版本热更新通知 |

## 技术栈

* **前端**：原生 HTML5 + Vanilla CSS + 原生 ES Modules（**无打包器、无视图框架**），首屏无框架开销
* **后端**：Cloudflare Workers（`workers/api.js` 为纯路由网关，业务逻辑下沉 `workers/src/`）
* **数据**：**Cloudflare D1**（SQLite，32 个迁移 0001–0032，全部查询参数化绑定）存结构化数据；**Cloudflare R2**（桶 `chillin-media`）存图片二进制、阅读器书籍正文与 D1 备份快照，D1 只保留元数据
* **反向代理**：Cloudflare Pages Functions（`functions/api/[[path]].js`）把 `/api/*` 同源转发到 Worker
* **依赖**：运行时**零第三方请求**（DOMPurify 自托管于 `public/vendor/`），构建期仅 `wrangler` 与 `web-push`

## 目录结构

```
public/             Cloudflare Pages 的**发布目录**（build output directory，仓库其余内容不会被发布）
  index.html        单页容器（11 个视图 + 10 个弹层）
  app.js            启动装配：模块初始化、会话恢复、在线/离线
  style.css         全部样式（设计令牌 + Inset Grouped + 主题 + 骨架屏；单一强调色、无边框柔和阴影材质、首屏柔光渐变与留白节奏、应用级深色主题）
  sw.js             Service Worker（预缓存全部模块，绝不把 JS 降级为 HTML）
  manifest.json     PWA 清单      _headers  安全响应头（CSP / HSTS …）      version.json  版本探测
  js/               26 个 ES 模块（auth / sync / feeds / … / trusted-types）
  icons/            PWA 图标（180 / 192 / 512）
  vendor/           自托管第三方运行时（DOMPurify 3.1.7，字节与官方发布一致，见测试校验）
workers/api.js      网关路由、CORS、鉴权闸门、定时任务
workers/src/        27 个领域模块（security / security-network / security-crypto / auth /
                    garden-shared / garden-resources / garden-sync / garden-media / garden-books /
                    garden-export / garden-echo / rag / llm / ai / audit / bot-commands /
                    bot-claw / bot-memory / bot-health / bot-outreach / bot-reminders /
                    bot-web / bot-search / bot-media / bot-vision / bot-links /
                    maintenance）
migrations/         D1 迁移 0001–0032（含会话令牌哈希与元数据、共享限流、审计保留索引、阅读进度同步与写入保护、图片元数据/R2 搬迁、阅读器云端书库、created_at 东八区口径统一、微信 ClawBot 绑定表、Bot 对话上下文与「关于我」档案、Bot 主动关怀开关与发送审计、图片待存确认位、待存卡片元数据、Bot 定点提醒状态机、联网检索缓存、quick_feeds 时间默认值东八区重建、健康打卡每日一行 health_daily）
tests/              Node 原生单测（node:test，零第三方测试框架）
functions/          Pages Functions 反向代理（**必须位于仓库根**，不能放进发布目录）
.agents/rules/      开发规约（架构 / UI / PWA 同步 / 安全 / 工程流程）
```

## 本地开发

前端是纯静态资源，任意静态服务器即可预览：

```bash
npx serve public                                       # 或 python -m http.server 8080 -d public
```

后端本地调试（需要 Wrangler 与本地 D1）：

```bash
npm install
npx wrangler d1 migrations apply DB --local
npx wrangler dev
```

> API 地址由 `public/js/config.js` 的 `resolveApiBase()` 决定：优先同源 `/api`，不可用时回退到 Worker 域名。

## 部署

```bash
# 0) R2 对象存储（首次部署必须：图片二进制、阅读器书籍正文与备份快照都放这里）
npx wrangler r2 bucket create chillin-media

# 1) 远端数据库迁移
npx wrangler d1 migrations apply DB --remote

# 2) 密钥（不要写入仓库）
npx wrangler secret put LLM_API_KEY        # DeepSeek 密钥；缺失时回退内置规则回复
npx wrangler secret put VAPID_PRIVATE_KEY  # Web Push 私钥
npx wrangler secret put RESEND_API_KEY     # 可选：备份邮件直发（缺失时前端自动降级为本地下载）
# 可选：BACKUP_EMAIL_ALLOWLIST="me@example.com,backup@example.com"（逗号分隔，不配则不限收件人）

# 3) 发布后端
npx wrangler deploy

# 4) 发布前端：推送到 main，由 Cloudflare Pages 构建静态资源
git push origin main
```

`wrangler.toml` 中 `ALLOW_REGISTRATION = "false"` 表示**注册默认关闭**（个人实例）；需要开放注册时改为 `"true"`。

> **升级顺序**：R2 建桶 → D1 迁移 → `npx wrangler deploy` → 推送前端。把二进制搬出 D1 是一次性维护动作，可随时执行（未搬迁的历史行仍从 D1 BLOB 读取，无需停机）：

```bash
node scripts/migrate-files-to-r2.mjs --dry-run    # 预演：列出待搬迁图片与目标对象键
node scripts/migrate-files-to-r2.mjs             # 实际搬迁并回填 r2_key/size
node scripts/migrate-files-to-r2.mjs --clear-data # 确认无误后清空 D1 里的 BLOB，彻底瘦身
```

### Pages 项目设置（远端状态，不在本仓库里）

| 设置 | 值 | 说明 |
| :--- | :--- | :--- |
| Build command | 空 | 无构建步骤，直接发布静态文件 |
| **Build output directory** | **§public§** | 仓库其余内容（§workers/§、§migrations/§、§tests/§、§.agents/§、文档等）**不会被发布** |
| Root directory | 空 | 仓库根；§functions/§ 必须留在根目录，不能放进 §public/§ |

> ⚠️ 本仓库**故意不在 §wrangler.toml§ 里写 §pages_build_output_dir§**：该文件是 Worker 配置（含 §main§ 与 D1 绑定），同一个文件无法同时作为 Pages 配置，混写会让 §wrangler§ 报错。改这项设置请走 Dashboard → Settings → Builds & deployments，或 §PATCH /accounts/{account_id}/pages/projects/chillin§ 的 §build_config.destination_dir§。

> 历史背景：迁移前发布目录为空 → Pages 发布整个仓库根，导致 §/workers/src/security.js§、§/migrations/*.sql§、§/tests/*§、§/AGENTS.md§ 等**可被公开下载**（无密钥泄露，因为 §.dev.vars§ / §backups/§ 从未入库）。现已改为只发布 §public/§。

> ⚠️ **升级顺序**：涉及后端接口或会话机制的改动，务必先 `npx wrangler deploy` 再推送前端，避免前端调用旧版 Worker。

## 数据备份与恢复

数据现在分布在两处：**D1 存结构化数据**，**R2 存图片二进制 / 书籍正文 / 备份快照**（D1 里的图片 BLOB 迁移后即可用 `--clear-data` 清空）。建议每天导出一次快照（脚本见 [scripts/backup-d1.mjs](scripts/backup-d1.mjs)）：

```bash
npm run backup                # 导出远端库 → backups/chillin-d1-<UTC>.sql.gz（本地保留 14 份 + 上传 R2 一份）
npm run backup -- --keep 30   # 自定义本地保留份数
npm run backup -- --no-r2     # 只做本地快照，不上传 R2
```

* `backups/` 已写入 `.gitignore`，**绝不会被提交**（快照内含密码哈希与全部内容）。
* 云端副本存在 R2 的 `backups/` 前缀下，由 Worker 每小时定时任务清理：**最新 3 份永久保留**，其余超过 30 天自动删除；桶名可用 `CHILLIN_R2_BUCKET` 覆盖。上传失败（未登录/桶不存在）只告警，不影响本地快照。
* 计划任务示例（Windows）：
  `schtasks /create /tn "Chillin D1 Backup" /tr "cmd /c cd /d E:\Chillin && npm run backup" /sc daily /st 03:30`
* 恢复：`npm run restore -- backups/chillin-d1-<时间戳>.sql.gz --yes`（脚本自动解压 gzip——备份只留 `.sql.gz`，裸 `.sql` 导出后即被删除；默认目标是**远端生产库**，所以必须显式 `--yes`，本地库用 `--local`。快照含建表语句，执行前请确认目标库）。

## 可观测性

* `GET /api/health` —— 返回 `{ ok, version, time }`；数据库探测失败时返回 503，可直接接 Uptime 监控；
* `npx wrangler tail` —— 实时查看线上 Worker 日志；
* 关键日志前缀：`[audit]`（违规扫描）、`[session]`（过期清理）、`[rate-limit]`（共享计数降级）、`[health]`（DB 探测失败）、`[upload]`、`[r2]`（备份快照保留清理）、`[reader-books]`（书库对象回收失败）。

## 质量门禁

提交前必须全部通过（详见 [`.agents/rules/engineering-workflow.md`](.agents/rules/engineering-workflow.md)）：

```bash
npm test                        # 单测 + 集成测试，必须 0 失败
npx wrangler deploy --dry-run   # 边缘预打包演练，必须 Exit Code 0
npm run ship -- --message "fix(x): ..." --push   # 一键：门禁 → 迁移校验 → 版本联动 → 校验提交信息 → 提交推送
```

> **文档同步是硬性要求**：改代码必须在同一提交里更新受影响的 README / `PROGRESS.md` / 架构报告 / `.agents/rules/`，其中的「数字类事实」由 [`tests/docs.test.mjs`](tests/docs.test.mjs) 机器校验（对不上直接红灯），详见 [`.agents/rules/engineering-workflow.md`](.agents/rules/engineering-workflow.md) §5。

> `npm run ship` 还会**校验远端 D1 迁移**：只要 `migrations/` 里存在未应用的迁移就直接中断发布。这一步必须有，因为本地测试会用 `fake-d1` 执行**全部**迁移，永远测不出「迁移没应用」这种漂移（`0019_reader_progress.sql` 曾因此漏应用 12 天，线上接口一直报 `no such table`）。离线或缺少凭据时仅告警放行，不会卡死发布。

### 测试布局

| 文件 | 覆盖范围 |
| :--- | :--- |
| [`tests/security.test.mjs`](tests/security.test.mjs) | 密码/令牌哈希、CSP 哈希与第三方域、共享限流与降级、代理 IP 取信、响应限长、**接口默认 no-store** |
| [`tests/sync.test.mjs`](tests/sync.test.mjs) | 时间格式解析、LWW 合并、脏数据选择与 id 补全 |
| [`tests/rag.test.mjs`](tests/rag.test.mjs) | 分词、停用词、时间范围解析、打分 |
| [`tests/search.test.mjs`](tests/search.test.mjs) | 关键词高亮与 HTML 转义 |
| [`tests/sw.test.mjs`](tests/sw.test.mjs) | 预缓存清单完整性、模块请求绝不回退 index.html |
| [`tests/architecture.test.mjs`](tests/architecture.test.mjs) | 网关 300 行红线、子域模块 500 行上限、网关无 SQL、健康检查公开、前端首屏体积预算 |
| [`tests/garden.test.mjs`](tests/garden.test.mjs) | 资源 CRUD、跨用户归属、软删墓碑、批量同步、热力图（真实 SQLite） |
| [`tests/auth.test.mjs`](tests/auth.test.mjs) | 会话哈希落库、刷新轮换、设备列表、单设备/全端退出、**改密校验旧密码并只保留当前会话**（真实 SQLite） |
| [`tests/media.test.mjs`](tests/media.test.mjs) | 图片字节入 R2、Range/206 下发、令牌拒绝、历史 D1 BLOB 兼容、无绑定兜底写入、备份保留策略 |
| [`tests/books.test.mjs`](tests/books.test.mjs) | 书目元数据 + R2 正文、跨用户隔离、同指纹 upsert、软删回收对象、删书连带清进度 |
| [`tests/router.test.mjs`](tests/router.test.mjs) | 网关级接线：书库 CRUD、图片上传与令牌下发、未知子路径 404（走真实会话 Cookie） |
| [`tests/backup.test.mjs`](tests/backup.test.mjs) | crc32 校验、ZIP 结构、备份打包内容、**服务端导出并入与离线降级**、Resend 邮件降级、**备份邮件限流/收件人白名单/文件名净化**、备份守卫状态机 |
| [`tests/evergreen.test.mjs`](tests/evergreen.test.mjs) | 中英混排词数统计、主题标签合法性、时间跨度解析、目录页生命周期 |
| [`tests/reader.test.mjs`](tests/reader.test.mjs) | TXT 解码（UTF-8 优先、GBK 兜底）、阅读进度写入保护（更旧写入被拒）、百分比夹紧与跨用户隔离 |
| [`tests/wikilinks.test.mjs`](tests/wikilinks.test.mjs) | `[[wiki]]` 解析与别名、XSS 防护、反向链接与摘要、Markdown 图片/链接渲染 |
| [`tests/css.test.mjs`](tests/css.test.mjs) | 样式卫生：死动画、重复/空声明块、静默失效的 `var()`、`!important` 棘轮、过渡属性白名单、层级令牌、模糊层与单组件定义块棘轮、深色主题层与灰度分量令牌、深色下会失明的 Tailwind 色阶与链接色令牌、**亮/暗 24 组对比度实算（WCAG AA）与键盘焦点可见门禁** |
| [`tests/a11y.test.mjs`](tests/a11y.test.mjs) | 静态外壳可访问性：表单控件的可访问名称、重复 id、img alt、外观主题控件的可访问名称与首帧主题应用、**toast live region 与错误 alert 角色** |
| [`tests/bot-claw.test.mjs`](tests/bot-claw.test.mjs) | 微信 ClawBot（iLink 协议）：请求头与 uint32 识别码、二维码/确认/解绑生命周期、长轮询游标持久化与排重、**默认只聊天不落库**、显式「记录：…」才写入随手记、关于我档案的记住/遗忘、**应用内档案接口的增改查删与跨用户隔离**、**来源脚注按需触发（默认不附「依据：」，联网答案默认也不带「来源：」）**、来源标签统一成「[类型] YYYY-MM-DD」、脏 baseurl 拒绝与失败只记错误、**微信发图落成带图随手记（`item.type=2` 识别 → 明文魔数 → **AES-128-ECB + PKCS7** 解密（`aeskey` 32 位 hex，另兼容 `media.aes_key` 与「hex 再 base64」中间层，CBC 两种 IV 兜底），直链与带授权参数的地址都试，图取不到就如实告知且不落库）** |
| [`tests/bot-health.test.mjs`](tests/bot-health.test.mjs) | 健康打卡：一句话解析出步数/睡眠/中高强度/静息心率/体重（斤折半、千分位）、越界值点名不写库、只认显式格式不劫持聊天、一天一行 UPSERT 只覆盖本次字段、日期一律东八区、汇总只统计真的记过该字段的天（真实 SQLite） |
| [`tests/bot-outreach.test.mjs`](tests/bot-outreach.test.mjs) | Bot 主动关怀：东八区时窗与当天唯一开口时刻、每天至多一次、刚聊完 30 分钟内不插嘴、6 小时内聊过时把最近对话当背景、只用 3 天前旧素材、随机频率闸门、模型 SKIP 否决权、内容安全、发送失败与开关接口、**主动消息写进对话记忆（带出处）**（真实 SQLite） |
| [`tests/bot-reminders.test.mjs`](tests/bot-reminders.test.mjs) | 定点提醒：中文数字与相对/绝对时刻解析、越界与「已经过去」一律反问不猜、只软删的取消、到点必达与 30 分钟只追问一次、超 2 小时不补发、发送失败退回 pending、同一分钟幂等（真实 SQLite） |
| [`tests/bot-web.test.mjs`](tests/bot-web.test.mjs) | 联网检索：三档分流闸门（花园线索强制回本地）、上游 DeepSeek/Jina 双形态 JSON 与 markdown 解析去重、`need_content` 正文优先于 summary、相对时间并成具体日期（东八区）、半截 JSON 一律不当来源、失败分类与文案、6 小时缓存与每人每天 100 次上限（命中缓存不扣额度）与每分钟 2 次突发闸、合成死线退化与出处按需（真实 SQLite）；v2.5.150 起先做 4s 死线的检索词规划（`planWebQueries`）再多条并行检索（最多 3 条、按 `rerank_score` 去重排序、部分失败不影响整体）；上游适配层在同名的 `workers/src/bot-search.js` |
| [`tests/docs.test.mjs`](tests/docs.test.mjs) | **文档一致性门禁**：README 的模块数 / 迁移范围 / 测试套件数必须等于磁盘真实数量、架构规约模块表必须覆盖全部 `workers/src/*.js`、各文档版本号必须一致 |

> 标注「真实 SQLite」的用例用 `node:sqlite`（Node ≥ 22.5）在内存库里**依次执行 migrations/**，因此同时验证了「处理函数 → SQL → 数据库结构」的一致性；在更旧的 Node 上这些用例会自动跳过（CI 同时跑 Node 20 与 22）。

发布时用脚本联动 **8 处**版本号（`package.json`、`public/version.json`、`public/js/version.js`、`public/sw.js`、`public/index.html`、`workers/api.js`、`PROGRESS.md`、架构报告），**不要手改单个文件**：

```bash
npm run bump          # patch +1，同时递增 Service Worker 缓存版本
npm run bump:minor
```

## 安全要点

* **密码**：PBKDF2-SHA256，60 万次迭代（OWASP 2023 建议）+ 每用户 16 字节随机盐；旧哈希在登录成功后就地升级；登录后可自助改密（先验旧密码，成功后只保留当前会话、其它设备立即失效）
* **会话**：`HttpOnly` + `SameSite=Lax`（HTTPS 附带 `Secure`）Cookie，同时兼容旧版 `Bearer` 令牌；**数据库只保存令牌的 SHA-256 摘要**；支持「全部退出」
* **限流**：内存桶快速拒绝 + D1 跨实例共享计数（登录 / 注册 / 上传 / AI 问答 / 改密 / 导出 / 备份邮件 3 封每小时），D1 异常时自动降级不阻断业务
* **输入**：SQL 全参数化、富文本 DOMPurify 白名单清洗、图片二进制魔数嗅探；**所有 JSON 入口都经 `readJsonCapped` 限长**（书籍 20MB、备份邮件 12MB、批量同步 4MB + 每种资源 200 条 + 单条 200KB、资源 CRUD 512KB、阅读进度 8KB、账号接口 8KB、AI 问答 256KB + 问题 ≤4000 字 + 历史 ≤20 条），网关另有一道 **21MB 声明长度兜底**（新入口忘了设上限也不会被撑爆）——超限在**读取过程中**就中止，不会先把超大请求读进内存
* **响应头**：CSP（`script-src` 已去除 `'unsafe-inline'`，内联脚本用 sha256 白名单，且**不再放行任何第三方脚本域**——DOMPurify 已自托管到 `vendor/`）、HSTS、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`，见 [`public/_headers`](public/_headers) 与 `workers/src/security.js`
* **HTML 注入收口**：全站 `innerHTML` 写入统一经过 [`public/js/trusted-types.js`](public/js/trusted-types.js) 的 `setHtml()`（Trusted Types 策略 `chillin#html`，测试会拦截绕过行为）；CSP **已强制启用** `require-trusted-types-for 'script'`，绕过 `setHtml()` 的赋值会被浏览器直接拒绝

## 开发规约

本仓库以 [`.agents/rules/`](.agents/rules) 为最高开发规约，其中五条底线：**零构建**、Worker 网关保持精简、**离线绝不把 JS 降级为 HTML**、同步只推 `_dirty` 差异、提交前双卡点全部通过。

## 许可

当前为**保留所有权利（All rights reserved）**，详见 [LICENSE](LICENSE)；如需开放使用请把该文件替换为 MIT / Apache-2.0 等许可证全文。
