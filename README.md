# Chillin 数字花园

> 一个**零构建**的个人「数字花园」：把随手记、周记、笔记、收藏、提示词、TXT 阅读与 AI 记忆回响收在一处，数据存在自己的 Cloudflare D1 里。

* 线上前端（Cloudflare Pages）：<https://chillin-bfc.pages.dev>
* 线上后端（Cloudflare Worker）：<https://chillin-api.2089700996jy.workers.dev>

## 功能一览

| 模块 | 你能做什么 |
| :--- | :--- |
| 🫧 随手记 | 1 秒记录想法；外链自动抓取标题 / 封面 / 平台徽标；全屏图片灯箱；连续记录徽章与贡献热力图 |
| 📓 周记 | 模块化卡片（烟火日常、音乐影音微件）、时序追加批注 |
| 📝 笔记 | 长文撰写、草稿自动暂存与崩溃恢复、批注讨论流 |
| 🔖 收藏 | 网页 / 图片卡片，一键回跳原站 |
| 🧩 提示词库 | `{{变量}}` 模板参数化、填参预览、一键复制或直发 AI |
| 📖 阅读器 | 本地 TXT 导入自动分章（GBK / UTF-8）、章节树、进度记忆、三档主题 |
| 🧠 AI 记忆回响 | 基于个人历史的全域 RAG 检索、多轮代词继承、流式回答、引用卡片一键回跳原文 |
| 🔍 命令面板 | `⌘K` / `Ctrl+K` 呼出：快捷指令 + 跨模块检索 + 关键词高亮 + 全键盘导航 |
| 📶 PWA | 20 个模块离线预缓存、断网降级、重连自动补偿同步、版本热更新通知 |

## 技术栈

* **前端**：原生 HTML5 + Vanilla CSS + 原生 ES Modules（**无打包器、无视图框架**），首屏无框架开销
* **后端**：Cloudflare Workers（`workers/api.js` 为纯路由网关，业务逻辑下沉 `workers/src/`）
* **数据**：Cloudflare D1（SQLite），18 个迁移（0001–0018），全部查询参数化绑定
* **反向代理**：Cloudflare Pages Functions（`functions/api/[[path]].js`）把 `/api/*` 同源转发到 Worker
* **依赖**：运行时**零第三方请求**（DOMPurify 自托管于 `public/vendor/`），构建期仅 `wrangler` 与 `web-push`

## 目录结构

```
public/             Cloudflare Pages 的**发布目录**（build output directory，仓库其余内容不会被发布）
  index.html        单页容器（11 个视图 + 4 个弹层）
  app.js            启动装配：模块初始化、会话恢复、在线/离线
  style.css         全部样式（设计令牌 + Inset Grouped + 主题 + 骨架屏）
  sw.js             Service Worker（预缓存全部模块，绝不把 JS 降级为 HTML）
  manifest.json     PWA 清单      _headers  安全响应头（CSP / HSTS …）      version.json  版本探测
  js/               21 个 ES 模块（auth / sync / feeds / … / trusted-types）
  icons/            PWA 图标（180 / 192 / 512）
  vendor/           自托管第三方运行时（DOMPurify 3.1.7，字节与官方发布一致，见测试校验）
workers/api.js      网关路由、CORS、鉴权闸门、定时任务
workers/src/        security / auth / garden / rag / llm / audit
migrations/         D1 迁移 0001–0018（含会话令牌哈希与元数据、共享限流、审计保留索引）
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
# 1) 远端数据库迁移
npx wrangler d1 migrations apply DB --remote

# 2) 密钥（不要写入仓库）
npx wrangler secret put LLM_API_KEY        # DeepSeek 密钥；缺失时回退内置规则回复
npx wrangler secret put VAPID_PRIVATE_KEY  # Web Push 私钥

# 3) 发布后端
npx wrangler deploy

# 4) 发布前端：推送到 main，由 Cloudflare Pages 构建静态资源
git push origin main
```

`wrangler.toml` 中 `ALLOW_REGISTRATION = "false"` 表示**注册默认关闭**（个人实例）；需要开放注册时改为 `"true"`。

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

D1 是唯一的数据源，建议每天导出一次快照（脚本见 [scripts/backup-d1.mjs](scripts/backup-d1.mjs)）：

```bash
npm run backup                # 导出远端库 → backups/chillin-d1-<UTC>.sql.gz（默认保留最近 14 份）
npm run backup -- --keep 30   # 自定义保留份数
```

* `backups/` 已写入 `.gitignore`，**绝不会被提交**（快照内含密码哈希与全部内容）。
* 计划任务示例（Windows）：
  `schtasks /create /tn "Chillin D1 Backup" /tr "cmd /c cd /d E:\Chillin && npm run backup" /sc daily /st 03:30`
* 恢复：`npx wrangler d1 execute DB --remote --file backups/chillin-d1-<时间戳>.sql`（文件含建表语句，执行前请确认目标库）。

## 可观测性

* `GET /api/health` —— 返回 `{ ok, version, time }`；数据库探测失败时返回 503，可直接接 Uptime 监控；
* `npx wrangler tail` —— 实时查看线上 Worker 日志；
* 关键日志前缀：`[audit]`（违规扫描）、`[session]`（过期清理）、`[rate-limit]`（共享计数降级）、`[health]`（DB 探测失败）、`[upload]`。

## 质量门禁

提交前必须全部通过（详见 [`.agents/rules/engineering-workflow.md`](.agents/rules/engineering-workflow.md)）：

```bash
npm test                        # 单测 + 集成测试（当前 35 个用例），必须 0 失败
npx wrangler deploy --dry-run   # 边缘预打包演练，必须 Exit Code 0
npm run ship -- --message "fix(x): ..." --push   # 一键：门禁 → 版本联动 → 校验提交信息 → 提交推送
```

### 测试布局

| 文件 | 覆盖范围 |
| :--- | :--- |
| [`tests/security.test.mjs`](tests/security.test.mjs) | 密码/令牌哈希、CSP 哈希与第三方域、共享限流与降级、SSRF（IPv4/IPv6/NAT64/6to4）、代理 IP 取信、响应限长 |
| [`tests/sync.test.mjs`](tests/sync.test.mjs) | 时间格式解析、LWW 合并、脏数据选择与 id 补全 |
| [`tests/rag.test.mjs`](tests/rag.test.mjs) | 分词、停用词、时间范围解析、打分 |
| [`tests/search.test.mjs`](tests/search.test.mjs) | 关键词高亮与 HTML 转义 |
| [`tests/sw.test.mjs`](tests/sw.test.mjs) | 预缓存清单完整性、模块请求绝不回退 index.html |
| [`tests/architecture.test.mjs`](tests/architecture.test.mjs) | 网关 300 行红线、子域模块 500 行上限、网关无 SQL、健康检查公开 |
| [`tests/garden.test.mjs`](tests/garden.test.mjs) | 资源 CRUD、跨用户归属、软删墓碑、批量同步、热力图（真实 SQLite） |
| [`tests/auth.test.mjs`](tests/auth.test.mjs) | 会话哈希落库、刷新轮换、设备列表、单设备/全端退出（真实 SQLite） |

> 后两个文件用 `node:sqlite`（Node ≥ 22.5）在内存库里**依次执行 migrations/**，因此同时验证了「处理函数 → SQL → 数据库结构」的一致性；在更旧的 Node 上这些用例会自动跳过（CI 同时跑 Node 20 与 22）。

发布时用脚本联动 6 处版本号（`package.json`、`public/version.json`、`public/js/version.js`、`public/sw.js`、`public/index.html`、`workers/api.js`），**不要手改单个文件**：

```bash
npm run bump          # patch +1，同时递增 Service Worker 缓存版本
npm run bump:minor
```

## 安全要点

* **密码**：PBKDF2-SHA256，10 万次迭代 + 每用户 16 字节随机盐
* **会话**：`HttpOnly` + `SameSite=Lax`（HTTPS 附带 `Secure`）Cookie，同时兼容旧版 `Bearer` 令牌；**数据库只保存令牌的 SHA-256 摘要**；支持「全部退出」
* **限流**：内存桶快速拒绝 + D1 跨实例共享计数（登录 / 注册 / 外链解析 / 上传 / AI 问答），D1 异常时自动降级不阻断业务
* **输入与出站**：SQL 全参数化、富文本 DOMPurify 白名单清洗、图片二进制魔数嗅探、外链解析 SSRF 防护（含 IPv6 映射 / NAT64 / 6to4）
* **出站限长与隐私**：外链解析响应体按 512KB 截断（Microlink 兜底 128KB），并可用 `LINK_ENRICH_MICROLINK=false` 彻底关闭第三方兜底
* **响应头**：CSP（`script-src` 已去除 `'unsafe-inline'`，内联脚本用 sha256 白名单，且**不再放行任何第三方脚本域**——DOMPurify 已自托管到 `vendor/`）、HSTS、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`，见 [`_headers`](_headers) 与 `workers/src/security.js`
* **HTML 注入收口**：全站 `innerHTML` 写入统一经过 [`public/js/trusted-types.js`](public/js/trusted-types.js) 的 `setHtml()`（Trusted Types 策略 `chillin#html`，测试会拦截绕过行为）；CSP **已强制启用** `require-trusted-types-for 'script'`，绕过 `setHtml()` 的赋值会被浏览器直接拒绝

## 开发规约

本仓库以 [`.agents/rules/`](.agents/rules) 为最高开发规约，其中五条底线：**零构建**、Worker 网关保持精简、**离线绝不把 JS 降级为 HTML**、同步只推 `_dirty` 差异、提交前双卡点全部通过。

## 许可

当前为**保留所有权利（All rights reserved）**，详见 [LICENSE](LICENSE)；如需开放使用请把该文件替换为 MIT / Apache-2.0 等许可证全文。
