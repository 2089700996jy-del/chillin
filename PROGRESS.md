# Chillin 项目进度记录

> 更新时间：2026-09-02。供后续会话快速接续。当前前端/Worker：**v2.5.13**（推送后以 `js/version.js` 为准）。

## 项目是什么

个人「数字花园」Web 应用（周记 / 笔记 / 收藏 / 随手记 / TXT 阅读 / AI 记忆回响）。

- 前端：`index.html` + `style.css` + `app.js`（原生 HTML/JS，无框架）
- 后端：Cloudflare Worker `workers/api.js`（REST）
- 数据库：Cloudflare D1（`migrations/0001`–`0013`，远端已对齐）
- 站点：Pages `https://chillin-bfc.pages.dev` + Worker `https://chillin-api.2089700996jy.workers.dev`
- GitHub：`https://github.com/2089700996jy-del/chillin`
- 版本：用 `npm run bump` / `npm run bump:patch` 一键对齐 `js/version.js`、`version.json`、Worker、`sw.js`、`index.html`
- 形态：Web / PWA（Pages）；已移除 Capacitor Android 工程

## 模块地图（前端）

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
| `js/sync.js` | 本地持久化、增量同步、`apiSync*`、自动同步引擎 |
| `js/api.js` | **薄 facade**：再导出 auth+sync，业务仍 `from './api.js'` |
| `js/router.js` | Hash 路由与视图切换 |
| `js/weeklies.js` | 周记画廊/编辑/批注 |
| `js/notes.js` | 笔记列表/编辑/批注 |
| `js/bookmarks.js` | 收藏（仅新建） |
| `js/feeds.js` | 随手记流、热力图 |
| `js/reader.js` | TXT 阅读器 |
| `js/echo-ai.js` | AI 回响卡片与对话 |
| `js/search.js` | 全局搜索 |
| `js/upload.js` | 图片上传 |
| `js/pwa-update.js` | SW 注册、版本探测、强制刷新 |

## 明确不做

- 收藏编辑
- 导出 / 导入

## 近期已完成（摘要）

### 结构清理（v2.5.11）

- 删除 echo-ai 死桩（`jumpToFeed` / 空 feedLinks）、Worker 未用 `callCustomLlmStream`、无用 `[data-force-refresh]` 绑定
- `api.js` 拆为 `auth.js` + `sync.js` + facade（对外 import 不变）

### 安全 / 同步 / PWA / AI

- 限流、PBKDF2、文件归属、CSP、软删增量同步、红黄绿灯、强制刷新、登录错误分类、轻量 RAG

## 部署

```bat
cd chillin
npx wrangler d1 migrations list chillin-db --remote
npx wrangler deploy
git push origin main
```

Secrets（勿进仓）：`LLM_API_KEY`、`VAPID_PRIVATE_KEY` 等。

弱网推送可用代理：`HTTP_PROXY` / `HTTPS_PROXY=http://127.0.0.1:7888`

## 可选下一步

- AI 回响来源一键跳到对应周记/随手记；短多轮上下文
- 推送订阅失败静默
