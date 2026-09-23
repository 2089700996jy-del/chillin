# Chillin 项目进度记录

> 更新时间：2026-09-23。供后续会话快速接续。当前前端/Worker：**v2.5.25**（推送后以 `js/version.js` 为准）。

## 项目是什么

个人「数字花园」Web 应用（周记 / 笔记 / 收藏 / 随手记 / 提示词库 / TXT 阅读 / AI 记忆回响）。

- 前端：`index.html` + `style.css` + `app.js`（原生 HTML/JS，无框架）
- 后端：Cloudflare Worker `workers/api.js` + 模块化子域 `workers/src/`（REST）
- 数据库：Cloudflare D1（`migrations/0001`–`0014`，远端已对齐）
- 站点：Pages `https://chillin-bfc.pages.dev` + Worker `https://chillin-api.2089700996jy.workers.dev`
- GitHub：`https://github.com/2089700996jy-del/chillin`
- 版本：用 `npm run bump` / `npm run bump:patch` 一键对齐 `js/version.js`、`version.json`、Worker、`sw.js`、`index.html`
- 测试：`npm test` 原生零依赖单测套件（`node --test tests/`）
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
| `workers/src/garden.js` | 领域业务：全资产 CRUD、聚合拉取 `/api/sync/pull`、批量推送、导出 |
| `workers/src/rag.js` | 记忆检索：全表（含 prompts）索引、分词、多轮主题继承、打分 |
| `workers/src/llm.js` | 模型集成：DeepSeek/Workers AI 调用、流式 SSE、内容合规审查 |
| `workers/src/audit.js` | 定时审计：Cron UGC 违规扫描与隔离区备份、过期 Session 清除 |

## 近期已完成（摘要）

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
