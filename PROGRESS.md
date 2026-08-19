# Chillin 项目进度记录

> 更新时间：2026-08-19。供后续会话快速接续。

## 项目是什么

个人「数字花园」Web 应用（周记 / 笔记 / 收藏 / 随手记 / TXT 阅读 / AI 记忆回响）。

- 前端：`index.html` + `style.css` + `app.js`（原生 HTML/JS，无框架）
- 后端：Cloudflare Worker `workers/api.js`（REST）
- 数据库：Cloudflare D1（`migrations/0001`–`0012`）
- 站点：Pages `https://chillin-bfc.pages.dev` + Worker `https://chillin-api.2089700996jy.workers.dev`
- GitHub：`git@github.com:2089700996jy-del/chillin.git`
- 前端缓存：`app.js`/`style.css` `?v=2.4.4`，SW `chillin-v23`；版本号贴屏幕最底一行、半透明淡字；PWA 打开/切回前台会主动检查更新
- 前端模块化：入口 `app.js`（编排）+ `js/`（utils / state / api / ui / actions / router / weeklies / notes / bookmarks / upload / reader / feeds / echo-ai / search / version）
- Android：Capacitor（`www/` 由 `npm run sync:web` 从根目录复制，含 `js/`）

## 明确不做

- 收藏编辑
- 导出 / 导入

## 近期已完成（摘要）

### 安全

- 限流（login/register/AI/upload/link）、PBKDF2、上传 `user_id` + 魔数校验、UGC 隔离表、CSP/`_headers`、Android `allowBackup=false`
- VAPID 私钥改为 `wrangler secret`（已轮换）；公钥在 `wrangler.toml` `[vars]` 与 `app.js`
- 文件访问不再 302 带出 `?t=`；CORS 仅白名单 + localhost；500 不回内部 `err.message`

### 同步 / UX

- 按 `updated_at` 合并；编辑中不重绘；失败可见
- Hash 历史栈（返回键 / AI 弹窗）
- 热力图中文日期；viewport 可缩放；笔记草稿
- 随手记本机传图（压缩 + `/api/upload`）
- AI 回响：`/api/echo/generate` 走 DeepSeek；生成后切到 feeds
- 标签筛选 UI 已关；相关死代码已删

### 数据 / API（至 migration 0012）

- `bookmarks` / `feeds` 增加 `updated_at`；`push_subscriptions` 纳入正式 migration
- `formatBookmark`：`description` ↔ `desc`；GET/POST/export 统一
- batch 同步收藏带 `image` + `updated_at` + `description`
- 收藏编辑器仅新建；修登录框重复 `id="auth-password"`

## 部署

```bat
cd chillin
npx wrangler d1 migrations apply chillin-db --remote
npx wrangler deploy
git push origin main
```

Secrets（勿进仓）：`LLM_API_KEY`、`VAPID_PRIVATE_KEY` 等。

> 若曾泄露旧 VAPID：用户需重新开启推送订阅。

## 本机编译 APK

```bat
npm run sync:web
npx cap sync android
cd android
gradlew.bat assembleDebug
```

## 可选下一步

- 回响卡片点击跳到相关随手记；AI 多轮上下文
- 按需继续细化模块内部结构 / 补测试