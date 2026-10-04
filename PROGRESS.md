# Chillin 项目进度记录

> 更新时间：2026-10-04。供后续会话快速接续。当前前端/Worker：**v2.5.53**（推送后以 `public/js/version.js` 为准）。

## 项目是什么

个人「数字花园」Web 应用（周记 / 笔记 / 收藏 / 随手记 / 提示词库 / TXT 阅读 / AI 记忆回响）。

- 前端：`public/index.html` + `public/style.css` + `public/app.js`（原生 HTML/JS，无框架）
- **目录布局**：全部站点资源位于 `public/`（Cloudflare Pages 的 build output directory）；下文模块地图中的 `js/...`、`app.js`、`sw.js` 等均指 `public/` 下的同名文件
- 后端：Cloudflare Worker `workers/api.js` + 模块化子域 `workers/src/`（REST）
- 数据库：Cloudflare D1（`migrations/0001`–`0014`，远端已对齐）
- 站点：Pages `https://chillin-bfc.pages.dev` + Worker `https://chillin-api.2089700996jy.workers.dev`
- GitHub：`https://github.com/2089700996jy-del/chillin`
- 版本：用 `npm run bump` / `npm run bump:patch` 一键对齐 `public/js/version.js`、`public/version.json`、Worker、`public/sw.js`、`public/index.html`
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
| `workers/src/security.js` | 安全核心：PBKDF2、魔数嗅探、SSRF 14组 CIDR 校验、限流、时序比较 |
| `workers/src/auth.js` | 认证会话：注册、登录、登出、用户信息、Web Push 订阅 |
| `workers/src/garden-shared.js` | 行格式化、归属校验、软删墓碑查询与惰性 schema 守卫 |
| `workers/src/garden-media.js` | 图片上传、鉴权文件读取、外链解析（含 Microlink 兜底与限长） |
| `workers/src/garden-resources.js` | 周记/笔记/收藏/提示词/随手记 的 CRUD 与软删 |
| `workers/src/garden-sync.js` | 聚合拉取 `/api/sync/pull`、脏数据批量推送、热力图 |
| `workers/src/garden-echo.js` | AI 回响卡片、周期回顾、Web Push 通知、UGC 审计入口 |
| `workers/src/rag.js` | 记忆检索：全表（含 prompts）索引、分词、多轮主题继承、打分 |
| `workers/src/llm.js` | 模型集成：DeepSeek/Workers AI 调用、流式 SSE、内容合规审查 |
| `workers/src/audit.js` | 定时审计：Cron UGC 违规扫描与隔离区备份、过期 Session 清除 |

## 近期已完成（摘要）

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
9. 外链解析响应体限长（页面 512KB / Microlink 128KB）+ `LINK_ENRICH_MICROLINK` 隐私开关。

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
   - 预缓存包含全部 20 个业务子模块（`actions`, `api`, `auth`, `search` 等）；
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
npx wrangler d1 migrations list chillin-db --remote
npx wrangler deploy
git push origin main
```

Secrets（勿进仓）：`LLM_API_KEY`、`VAPID_PRIVATE_KEY` 等。

弱网推送可用代理：`HTTP_PROXY` / `HTTPS_PROXY=http://127.0.0.1:7888`

## 可选下一步

- AI 回响来源一键跳到对应周记/随手记；短多轮上下文
- 推送订阅失败静默
