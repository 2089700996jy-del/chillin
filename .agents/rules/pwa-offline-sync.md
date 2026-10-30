# PWA 离线运行与数据同步规范 (PWA & Sync Rule)

> 本规范约束 Chillin 的 Service Worker 离线缓存生命周期、数据本地优先策略与双向增量同步机制。

---

## 1. Service Worker (`public/sw.js`) 离线生命线

1. **绝对禁止 JS 模块降级为 HTML (防离线崩溃白屏)**：
   * 在拦截 `/js/` 目录下的 ES 模块请求时，**离线状态下严禁将请求回退到 `/index.html`**；
   * 浏览器将 HTML 网页内容作为 JS 解析会立即抛出 `Uncaught SyntaxError: Unexpected token '<'`，造成应用离线彻底瘫痪；
   * 离线时对于模块请求，必须严格从本地 Cache 匹配已缓存的 JS 脚本。
2. **全量核心模块预缓存 (Pre-cache All 27 Modules)**：
   * `public/sw.js` 的静态预缓存列表 `ASSETS` 必须完整维护前端全部 27 个核心模块路径（`actions`, `api`, `auth`, `backup`, `bookmarks`, `config`, `daily-spark`, `db`, `echo-ai`, `evergreen-topics`, `feeds`, `feature-loader`, `notes`, `prompts`, `pwa-update`, `reader`, `router`, `search`, `state`, `sync`, `trusted-types`, `ui`, `upload`, `utils`, `version`, `weeklies`, `wikilinks`）；
   * 安装期（`install` 事件）必须使用 `Promise.allSettled` 进行静默容错缓存，防止单个非致命资源加载失败导致整个 Service Worker 拒绝激活。
3. **运行时缓存写入：模块 SWR，导航/静态资源网络优先，响应不等写盘**：
   * 模块 JS 走 **stale-while-revalidate**：先用精确 `cache.match(request)`（不加 `ignoreSearch`，防止新 `app.js?v=` 命中旧入口）立即返回缓存，同时后台 `fetch` 新版本；只有缓存缺失时才等网络，网络失败再按 `ignoreSearch` 回退离线缓存。模块请求**永远不得**回退 `/index.html`；
   * 导航与静态资源仍走网络优先；所有 200 响应必须先 `res.clone()`，再用 `e.waitUntil()` 把 `cache.put(request, clone)` 挂进 SW 生命周期——浏览器会保活到写入完成，用户不必等缓存落盘；
   * **两个极端都禁止**：把 `await cache.put()` 塞进 `respondWith` 的 promise 里（每次请求白等一次磁盘写入），或 fire-and-forget 丢到后台（SW 被回收时那次写入可能来不及完成，用户下次离线就发现这一版没被缓存住）；
   * `waitUntil` 在个别引擎上可能因事件已失活而抛错，须 `try/catch` 兜住；写入失败（配额满等）同样只吞异常，绝不影响当次响应；
   * 守卫用例：`tests/sw.test.mjs` 会校验模块分支使用 `staleWhileRevalidate()`、精确 `cache.match`、后台刷新挂在 `e.waitUntil()` 上且绝不回退 `/index.html`；导航分支仍回退 `/index.html`，并断言缓存写入确实挂在 `e.waitUntil()` 上、且不再出现 `await cache.put`。

---

## 2. 数据本地优先与双向增量同步规范

1. **本地存储先行 (Local-First Resilience)**：
   * 任何新笔记、周记、随手记创建或编辑操作，必须首先**同步持久化到本地**（`public/js/db.js` 的 `idbSet`：IndexedDB 为主存、`localStorage` 仅作镜像兜底），确保断网或崩溃时内容绝对安全；只改内存 `state` 而不落盘，等同于没保存；
   * 周记与笔记的编辑页面必须具备草稿暂存（Draft Save）与崩溃恢复机制。
2. **聚合增量拉取 (`GET /api/sync/pull`)**：
   * 前端同步必须优先调用聚合增量拉取接口；默认每次 RTT 同时拉取 5 张业务表的一页（`page_size=100`），用服务端 keyset 游标逐页合并，最终仍写满完整本地缓存；
   * 严禁退化为针对 5 个端点的低效串行拉取循环；分页也不能改变“一次请求覆盖 5 张表”的聚合形态；
   * 当聚合接口不可用时，平滑降级为 `Promise.all` 并发独立拉取。
3. **精准脏数据推送 (Delta Push 原则)**：
   * 客户端在向 `/api/sync/batch` 推送变动时，必须通过 `item._dirty === true` 严格筛选真正发生过新建或修改的记录；
   * **严禁无差别上报全量数据**，防止数据库中数百条未修改数据的 `updated_at` 时间戳被意外重置与流量浪费。
4. **编辑冲突保护（Conflict Guard，LWW 仅作兜底）**：
   * 每条记录在本地保存上次成功同步的基线 `{updated_at, signature}`（`gardenSyncBases`）；内容指纹只覆盖用户可编辑字段，忽略 `_dirty` 等同步噪音；
   * 拉取时若「本地 `_dirty` + 云端相对基线已变 + 两边内容不同」，必须判定为冲突：**保留本地版本、写入冲突中心（`gardenSyncConflicts`），禁止自动合并覆盖**；
   * 推送时携带 `base_updated_at`；服务端发现当前 `updated_at` 已不等于基线，拒绝写入并在 `conflicts` 中回传云端版本；只有用户明确选择「保留本地」或手动合并后，才允许带 `force_sync` 覆盖；
   * 冲突中心提供「保留本地 / 保留云端 / 手动合并」，并把被覆盖的版本先写入本地历史快照（`gardenSyncHistory`，上限 30 条）；旧版本必须可恢复；
   * 无冲突时仍使用统一的 `toUpdatedTs` 对齐东八区时间戳（`2026-09-23 10:00:00`），保留原有 LWW 合并作为兜底。
5. **网络断网感知与自动重连同步**：
   * 在 `public/app.js` 中监听 `window.addEventListener('offline')` 与 `'online'`；
   * 断网时标记 `.is-offline` 状态并提示用户；
   * 网络恢复连通时，自动静默触发 `syncFromApi()`，将离线期间积累的本地脏变更自动推送云端并拉取远端更新。
