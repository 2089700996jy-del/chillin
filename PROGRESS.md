# Chillin 项目进度记录

> 更新时间：2026-09-01。供后续会话快速接续。当前前端/Worker：**v2.5.9**（推送后以 `js/version.js` 为准）。

## 项目是什么

个人「数字花园」Web 应用（周记 / 笔记 / 收藏 / 随手记 / TXT 阅读 / AI 记忆回响）。

- 前端：`index.html` + `style.css` + `app.js`（原生 HTML/JS，无框架）
- 后端：Cloudflare Worker `workers/api.js`（REST）
- 数据库：Cloudflare D1（`migrations/0001`–`0013`，远端已对齐）
- 站点：Pages `https://chillin-bfc.pages.dev` + Worker `https://chillin-api.2089700996jy.workers.dev`
- GitHub：`https://github.com/2089700996jy-del/chillin`
- 版本：`js/version.js` + `version.json` + Worker `APP_VERSION` + `sw.js` `CACHE_NAME`/`APP_V` + `index.html?v=` 需同步 bump
- 前端模块：入口 `app.js` + `js/`（含 `config.js` / `pwa-update.js` / `version.js` 等）
- Android：Capacitor（`www/` 由 `npm run sync:web` 从根目录复制）

## 明确不做

- 收藏编辑
- 导出 / 导入

## 近期已完成（摘要）

### 安全

- 限流（login/register/AI/upload/link）、PBKDF2、上传 `user_id` + 魔数校验、UGC 隔离表、CSP/`_headers`、Android `allowBackup=false`
- VAPID 私钥为 `wrangler secret`；CORS 白名单；500 不回内部堆栈

### 同步 / UX

- 按 `updated_at` 增量合并；软删防复活；按用户同步游标
- 导航栏同步状态：**红黄绿灯**（无文字）
- PWA：`updateViaCache:'none'`、Worker `/api/app-version` 探测、更新横幅
- **强制刷新到最新版**（清 SW + Cache Storage，保留登录态）：登录页链接 / 版本号点击 / 横幅「强制更新」
- 登录：Pages 代理失败自动回落 Worker；错误区分密码错 / 限流 / 网络 / 服务异常

### AI

- 轻量 RAG（关键词 + 时间窗 Top-K）后再回答；UI 可展示来源

### 数据 / API（至 migration 0013）

- `is_deleted` 软删列 + 相关索引（0013）
- 说明：线上曾由 Worker `ensureSoftDeleteSchema` 先补列，正式 `wrangler d1 migrations apply` 会因 duplicate column 失败；已手工补齐索引并写入 `d1_migrations` 记录，**远端现无待执行 migration**

## 部署

```bat
cd chillin
npx wrangler d1 migrations list chillin-db --remote
npx wrangler d1 migrations apply chillin-db --remote
npx wrangler deploy
npm run sync:web
git push origin main
```

Secrets（勿进仓）：`LLM_API_KEY`、`VAPID_PRIVATE_KEY` 等。

弱网推送可用代理：`HTTP_PROXY` / `HTTPS_PROXY=http://127.0.0.1:7888`

## 本机编译 APK

```bat
npm run sync:web
npx cap sync android
cd android
gradlew.bat assembleDebug
```

## 可选下一步

- AI 回响来源一键跳到对应周记/随手记；短多轮上下文
- 推送订阅失败静默
