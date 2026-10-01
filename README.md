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
* **数据**：Cloudflare D1（SQLite），14 个迁移，全部查询参数化绑定
* **反向代理**：Cloudflare Pages Functions（`functions/api/[[path]].js`）把 `/api/*` 同源转发到 Worker
* **离线与安全**：Service Worker 全模块预缓存 + `_headers` 静态响应头 + Worker 动态响应头

## 目录结构

```
index.html          单页容器（11 个视图 + 4 个弹层）
app.js              启动装配：模块初始化、会话恢复、在线/离线
style.css           全部样式（设计令牌 + Inset Grouped + 主题 + 骨架屏）
sw.js               Service Worker（预缓存 20 个模块，绝不把 JS 降级为 HTML）
js/                 20 个 ES 模块（auth / sync / feeds / weeklies / notes / reader / prompts / echo-ai / search / upload …）
workers/api.js      网关路由、CORS、鉴权闸门、定时任务
workers/src/        security / auth / garden / rag / llm / audit
migrations/         D1 迁移 0001–0014
tests/              Node 原生单测（node:test，零第三方测试框架）
functions/          Pages Functions 反向代理
.agents/rules/      开发规约（架构 / UI / PWA 同步 / 安全 / 工程流程）
```

## 本地开发

前端是纯静态资源，任意静态服务器即可预览：

```bash
npx serve .            # 或 python -m http.server 8080
```

后端本地调试（需要 Wrangler 与本地 D1）：

```bash
npm install
npx wrangler d1 migrations apply DB --local
npx wrangler dev
```

> API 地址由 `js/config.js` 的 `resolveApiBase()` 决定：优先同源 `/api`，不可用时回退到 Worker 域名。

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

> ⚠️ **升级顺序**：涉及后端接口或会话机制的改动，务必先 `npx wrangler deploy` 再推送前端，避免前端调用旧版 Worker。

## 质量门禁

提交前必须全部通过（详见 [`.agents/rules/engineering-workflow.md`](.agents/rules/engineering-workflow.md)）：

```bash
npm test                        # Node 原生单测，必须 0 失败
npx wrangler deploy --dry-run   # 边缘预打包演练，必须 Exit Code 0
```

发布时用脚本联动 6 处版本号（`package.json`、`version.json`、`js/version.js`、`sw.js`、`index.html`、`workers/api.js`），**不要手改单个文件**：

```bash
npm run bump          # patch +1，同时递增 Service Worker 缓存版本
npm run bump:minor
```

## 安全要点

* **密码**：PBKDF2-SHA256，10 万次迭代 + 每用户 16 字节随机盐
* **会话**：`HttpOnly` + `SameSite=Lax`（HTTPS 附带 `Secure`）Cookie，同时兼容旧版 `Bearer` 令牌；支持「全部退出」
* **输入与出站**：SQL 全参数化、富文本 DOMPurify 白名单清洗、图片二进制魔数嗅探、外链解析 SSRF 防护（含 IPv6 映射 / NAT64 / 6to4）
* **响应头**：CSP、HSTS、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy` 见 [`_headers`](_headers) 与 `workers/src/security.js`

## 开发规约

本仓库以 [`.agents/rules/`](.agents/rules) 为最高开发规约，其中五条底线：**零构建**、Worker 网关保持精简、**离线绝不把 JS 降级为 HTML**、同步只推 `_dirty` 差异、提交前双卡点全部通过。

## 许可

仓库暂未声明开源许可证，如需公开分发请先补充 `LICENSE`。
