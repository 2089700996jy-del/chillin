# PWA 离线运行与数据同步规范 (PWA & Sync Rule)

> 本规范约束 Chillin 的 Service Worker 离线缓存生命周期、数据本地优先策略与双向增量同步机制。

---

## 1. Service Worker (`sw.js`) 离线生命线

1. **绝对禁止 JS 模块降级为 HTML (防离线崩溃白屏)**：
   * 在拦截 `/js/` 目录下的 ES 模块请求时，**离线状态下严禁将请求回退到 `/index.html`**；
   * 浏览器将 HTML 网页内容作为 JS 解析会立即抛出 `Uncaught SyntaxError: Unexpected token '<'`，造成应用离线彻底瘫痪；
   * 离线时对于模块请求，必须严格从本地 Cache 匹配已缓存的 JS 脚本。
2. **全量核心模块预缓存 (Pre-cache All 20 Modules)**：
   * `sw.js` 的静态预缓存列表 `ASSETS` 必须完整维护前端全部 20 个核心模块路径（`actions`, `api`, `auth`, `bookmarks`, `config`, `echo-ai`, `feeds`, `notes`, `prompts`, `pwa-update`, `reader`, `router`, `search`, `state`, `sync`, `ui`, `upload`, `utils`, `version`, `weeklies`）；
   * 安装期（`install` 事件）必须使用 `Promise.allSettled` 进行静默容错缓存，防止单个非致命资源加载失败导致整个 Service Worker 拒绝激活。

---

## 2. 数据本地优先与双向增量同步规范

1. **本地存储先行 (Local-First Resilience)**：
   * 任何新笔记、周记、随手记创建或编辑操作，必须首先同步写入本地 `localStorage`，确保断网或崩溃时内容绝对安全；
   * 周记与笔记的编辑页面必须具备草稿暂存（Draft Save）与崩溃恢复机制。
2. **聚合增量拉取 (`GET /api/sync/pull`)**：
   * 前端同步必须优先调用聚合增量拉取接口，单次 RTT 一网打尽 5 张业务表；
   * 严禁退化为针对 5 个端点的低效串行拉取循环；
   * 当聚合接口不可用时，平滑降级为 `Promise.all` 并发独立拉取。
3. **精准脏数据推送 (Delta Push 原则)**：
   * 客户端在向 `/api/sync/batch` 推送变动时，必须通过 `item._dirty === true` 严格筛选真正发生过新建或修改的记录；
   * **严禁无差别上报全量数据**，防止数据库中数百条未修改数据的 `updated_at` 时间戳被意外重置与流量浪费。
4. **冲突裁决机制 (Last-Write-Wins)**：
   * 客户端与云端数据冲突时，一律遵循 **最后写入胜出 (LWW)** 原则；
   * 使用统一的 `toUpdatedTs` 工具函数对齐东八区 ISO 时间戳（`2026-09-23 10:00:00`），毫秒精度比较。
5. **网络断网感知与自动重连同步**：
   * 在 `app.js` 中监听 `window.addEventListener('offline')` 与 `'online'`；
   * 断网时标记 `.is-offline` 状态并提示用户；
   * 网络恢复连通时，自动静默触发 `syncFromApi()`，将离线期间积累的本地脏变更自动推送云端并拉取远端更新。
