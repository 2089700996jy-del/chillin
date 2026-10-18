---
name: pwa-offline-engine
description: PWA 离线运行引擎、Service Worker 缓存策略（核心模块全量预缓存/严禁 JS 降级为 HTML）、IndexedDB/localStorage 双轨持久化容灾、Delta Push 精准脏数据差异推送与 LWW 冲突裁决规范。在开发或调试离线功能、数据同步、缓存更新或断网交互时使用。
---

# PWA 离线运行与增量同步引擎指南 (pwa-offline-engine)

> 本技能为 **Chillin 数字花园** 的离线架构与数据同步专项手册，深度规范 **Service Worker 生命周期**、**防离线崩溃白屏生命线**、**双轨客户端持久化**、**Delta Push 脏数据差异推送** 与 **LWW 冲突裁决**。

---

## 1. Service Worker 离线白屏生命线 (`public/sw.js`)

### 1.1 绝对禁止 JS 模块降级为 HTML (Golden Rule)
* **崩溃根源**：单页应用（SPA）中通常会将未命中的网络路由降级重定向至 `/index.html`。但若离线时将 `/js/*.js` 请求回退到 HTML，浏览器执行时会立即抛出：
  ```
  Uncaught SyntaxError: Unexpected token '<'
  ```
  导致整个应用运行时崩溃白屏，且无法恢复。
* **规约实现**：在 `public/sw.js` 的 `fetch` 拦截中，必须严格区分 **模块脚本请求** 与 **页面导航请求**：
  ```javascript
  // 1. ES 模块请求必须严格走 Cache 匹配，严禁回退 index.html
  const isModuleJs = url.pathname.startsWith('/js/') && url.pathname.endsWith('.js');
  if (isModuleJs) {
      event.respondWith(
          caches.match(event.request, { ignoreSearch: true }).then((cached) => {
              if (cached) return cached;
              return fetch(event.request); // 若本地未缓存，尝试直接走网络（离线时直接抛出网络异常，绝不回退 HTML）
          })
      );
      return;
  }

  // 2. 页面导航请求（Navigation）才允许回退 /index.html
  if (event.request.mode === 'navigate') {
      event.respondWith(
          fetch(event.request).catch(() => caches.match('/index.html'))
      );
      return;
  }
  ```

### 1.2 核心模块全量预缓存清单 (Pre-cache All Modules)
* `public/sw.js` 的 `ASSETS` 静态资源清单必须完整登记全部核心脚本与静态清单：
  - 前端所有在 `public/js/` 目录下的 `.js` 文件均须包含（如 `actions`, `api`, `auth`, `bookmarks`, `config`, `daily-spark`, `db`, `echo-ai`, `feeds`, `notes`, `prompts`, `pwa-update`, `reader`, `router`, `search`, `state`, `sync`, `ui`, `upload`, `utils`, `version`, `weeklies` 等）。
  - 项目根目录配置与资源：`/`, `/index.html`, `/manifest.json`, 核心 CSS 与透明图标。
* **单测门禁保护**：自动化测试 [`tests/sw.test.mjs`](../../../tests/sw.test.mjs) 会对 `public/js/` 目录扫描，任何新增的 `.js` 模块未在 `sw.js` 的 `ASSETS` 中登记时，`npm test` 将立即失败阻断构建。
* **安装期容错**：`install` 事件中使用 `Promise.allSettled` 进行缓存入库，避免偶发单文件故障导致 SW 拒绝安装。

---

## 2. 客户端持久化与存储容灾 (`public/js/db.js`)

项目采用 **IndexedDB 优先，localStorage 兜底** 的双轨持久化方案：

### 2.1 存储配额超限保护 (`QuotaExceededError`)
* 当浏览器存储配额紧张时（例如用户存储大量长文笔记），`localStorage` 会抛出 `QuotaExceededError`。
* `idbSet` 写入时遇到配额异常，必须自动截断并保存前 30 项高频快照，保障关键数据不崩溃：
  ```javascript
  try {
      localStorage.setItem(key, JSON.stringify(val));
  } catch (err) {
      if (err.name === 'QuotaExceededError' && Array.isArray(val)) {
          // 优雅降级保存前 30 项最新快照
          localStorage.setItem(key, JSON.stringify(val.slice(0, 30)));
      }
  }
  ```

### 2.2 存储配额感知与持久化提升
* 支持通过 `getStorageEstimate()` 获取当前存储使用量（百分比与字节数）。
* 主动调用 `navigator.storage.persist()` 申请持久化存储权限，防止 iOS / Safari 在低存储时自动清除数字花园的离线数据库。

---

## 3. 双向增量同步与 Delta Push 原则 (`public/js/sync.js`)

### 3.1 聚合增量拉取 (`GET /api/sync/pull`)
* 前端调用同步时，优先调用单个聚合端点 `GET /api/sync/pull?since={timestamp}`，单次 RTT 一网打尽周记、笔记、随手记、书签、提示词 5 张表。
* 当聚合接口不可用时，平滑降级为 `Promise.all` 并发独立拉取。

### 3.2 Delta Push 精准脏数据差异推送 (Dirty Delta)
* 客户端向 `/api/sync/batch` 提交推送时，**必须且仅能推送标记为脏数据（`_dirty === true`）的记录**：
  ```javascript
  import { selectDirtyItems, ensureLocalId } from './utils.js';

  // 1. 过滤真正修改过、且非当前被物理墓碑拦截的数据
  const dirtyFeeds = selectDirtyItems(state.feedsDatabase, tombstoneIds);
  const dirtyNotes = selectDirtyItems(state.notesDatabase, tombstoneIds);

  // 2. 对于离线新建、尚无数据库自增 ID 的记录，自动分配安全本地 ID 打标
  dirtyNotes.forEach(ensureLocalId);
  ```
* **禁止无脑全量推送**：全量上传会导致云端所有记录的 `updated_at` 时间戳被无差别重置，破坏多端增量基线。

### 3.3 冲突裁决：最后写入胜出 (LWW - Last-Write-Wins)
* 客户端与云端数据冲突时，一律遵循 **LWW 原则**。
* 统一使用 `toUpdatedTs(item.updated_at)` 工具函数，将东八区字符串（`2026-09-23 10:00:00`）或 ISO 时间戳安全归一化为统一毫秒数进行比较：
  ```javascript
  const localTs = toUpdatedTs(localItem.updated_at);
  const cloudTs = toUpdatedTs(cloudItem.updated_at);
  if (cloudTs >= localTs) {
      // 云端数据更新或相等，使用云端版本覆盖本地
      mergedMap.set(cloudItem.id, cloudItem);
  }
  ```

---

## 4. 断网感知与自动重连同步

在前端生命周期中监听网络连通性：
* `window.addEventListener('offline')`：即时更新全局离线状态提示，操作时完全本地优先写入。
* `window.addEventListener('online')`：网络恢复时，后台静默自动触发 `syncFromApi()`，将断网期间产生的脏数据差异推送到云端并拉取远端变更。

---

## 5. 质量验证与自动化测试

修改 PWA 或同步逻辑后，必须执行以下测试套件验证：

```bash
# 1. 运行完整单元测试（包括 SW 预缓存完整性、LWW 合并、IDB 容灾等）
npm test

# 2. 验证 SW 预缓存关键点
node --test tests/sw.test.mjs
node --test tests/sync.test.mjs
```
