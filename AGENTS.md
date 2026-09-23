# Chillin 数字花园：开发规范与工程准则 (AGENTS.md)

> 本文档是 **Chillin 数字花园** 项目的唯一全局开发规约。无论是人类开发者还是 AI 协作助手，在阅读、编写、重构或调试本项目代码时，**必须严格无条件遵守**以下准则。

---

## 细分领域规则库索引 (.agents/rules/)
本项目实行“总纲 (AGENTS.md) + 领域细分规则库 (.agents/rules/)”的双层治理体系。进行特定开发时，请严格遵守对应模块的专项目标：
* 🏗️ **[架构与技术栈规范](file:///d:/7/chillin/.agents/rules/architecture.md)**：Zero-Build 原生前端、Worker 单体防膨胀微内核划分；
* 🎨 **[UI 体验与 Apple HIG 规范](file:///d:/7/chillin/.agents/rules/ui-style.md)**：Inset Grouped 卡片、Apple Spring 触感反馈、Cmd+K 命令面板、软键盘躲避；
* 📶 **[PWA 离线与数据同步规范](file:///d:/7/chillin/.agents/rules/pwa-offline-sync.md)**：SW 离线防崩白屏生命线、单次 RTT 聚合拉取、Delta 脏数据推送；
* 🧪 **[自动化测试与质量卡点规范](file:///d:/7/chillin/.agents/rules/testing-quality.md)**：Node 20 原生零依赖单测套件、Wrangler 预打包校验卡点；
* 🛡️ **[数据安全与防御式编程规范](file:///d:/7/chillin/.agents/rules/security.md)**：PBKDF2 强哈希、时序防碰撞、图片魔数嗅探、SSRF 14组 CIDR 校验；
* 🚀 **[版本发布与 Git 工作流规范](file:///d:/7/chillin/.agents/rules/workflow-git.md)**：`npm run bump` 六点联动对齐、语义化提交规范。

---

## 目录
1. [技术栈纯洁度与依赖红线 (Zero-Build)](#1-技术栈纯洁度与依赖红线-zero-build)
2. [后端 Worker 架构与模块化分工](#2-后端-worker-架构与模块化分工)
3. [自动化测试与提交质量卡点](#3-自动化测试与提交质量卡点)
4. [离线 PWA 与双向增量同步规范](#4-离线-pwa-与双向增量同步规范)
5. [数据安全与防御式编程准则](#5-数据安全与防御式编程准则)
6. [UI / UX 与 Apple HIG 交互设计标准](#6-ui--ux-与-apple-hig-交互设计标准)
7. [版本号同步与 Git 提交规范](#7-版本号同步与-git-提交规范)

---

## 1. 技术栈纯洁度与依赖红线 (Zero-Build)

### 1.1 前端核心铁律
* **严格保持原生 Zero-Build**：前端代码运行在浏览器原生环境下，采用 **HTML5 + Vanilla CSS + 原生 ES Modules**。
* **绝对严禁引入现代打包构建黑盒**：
  * ❌ 严禁引入 Webpack、Vite、Rollup、Parcel、esbuild 等打包编译流程；
  * ❌ 严禁引入 React、Vue、Angular、Svelte 等全家桶视图框架；
  * ❌ 严禁引入 TailwindCSS、PostCSS、Sass、Less 等 CSS 编译预处理器。
* **依赖引入规范**：
  * 外部必要第三方库（如 DOMPurify 等）必须通过带有完整 SRI（Subresource Integrity）Hash 校验的公共 CDN 以 `<script>` 标签显式引入；
  * 杜绝在 `package.json` 中随意添加 `dependencies`，保持前端运行时的零依赖与极致轻量。

---

## 2. 后端 Worker 架构与模块化分工

后端运行在 **Cloudflare Workers (ESM)** 平台，入口由 `wrangler.toml` 指定为 `workers/api.js`，后端数据库为 **Cloudflare D1 (SQLite)**。

### 2.1 严防单体代码膨胀
* **入口网关仅做调度**：[`workers/api.js`](file:///d:/7/chillin/workers/api.js) 仅承担网关职责（CORS 预检、鉴权守卫中间件、路由分发、定时 Cron 触发），**代码行数必须严格控制在 300 行以内**。
* **绝对严禁将业务细节重新堆砌回入口**。所有新增接口必须按领域职责归入 `workers/src/`：

```
workers/
├── api.js                 # 网关调度分发入口 (仅限路由定义与鉴权拦截)
└── src/
    ├── security.js        # 安全核心：PBKDF2 加密/时序比较/魔数嗅探/SSRF 14组 CIDR 校验/限流
    ├── auth.js            # 账号与会话：注册/登录/登出/Session 管理/Web Push 订阅
    ├── garden.js          # 资产业务：周记/笔记/随手记/书签/提示词 CRUD、聚合拉取、批量同步
    ├── rag.js             # 记忆回响 RAG：自然语言时间解析/停用词过滤/多轮主题继承/语料加权打分
    ├── llm.js             # 模型网关：DeepSeek/Workers AI 边缘调用、流式 SSE 协议、合规审查
    └── audit.js           # 周期审计：Cron UGC 违规隔离扫描、过期 Session 定时自清理
```

---

## 3. 自动化测试与提交质量卡点

本项目推崇敏捷但绝对严谨的工程底线。任何代码修改必须满足**双 100% 通过**方可提交：

### 3.1 本地测试套件 (`npm test`)
* 本项目测试体系必须保持**零第三方依赖**，基于 Node.js 20+ 原生测试运行器（`node --test tests/` + `node:assert/strict`）。
* **新增或变更逻辑必须同步补齐测试**：
  * 修改安全算法 $\rightarrow$ 更新 [`tests/security.test.mjs`](file:///d:/7/chillin/tests/security.test.mjs)；
  * 修改 RAG 算法与停用词 $\rightarrow$ 更新 [`tests/rag.test.mjs`](file:///d:/7/chillin/tests/rag.test.mjs)；
  * 修改同步与时间戳合并 $\rightarrow$ 更新 [`tests/sync.test.mjs`](file:///d:/7/chillin/tests/sync.test.mjs)；
  * 修改搜索与高亮 $\rightarrow$ 更新 [`tests/search.test.mjs`](file:///d:/7/chillin/tests/search.test.mjs)。
* **执行命令**：`npm test`（必须 0 失败，全部 Pass）。

### 3.2 边缘构建预检 (`wrangler dry-run`)
* 每次涉及 Worker 端的修改，必须在终端执行构建预演：
  ```bash
  npx wrangler deploy --dry-run
  ```
* 验证构建产物不存在语法解析错误、未定义的环境变量引用或隐式循环导入。

---

## 4. 离线 PWA 与双向增量同步规范

### 4.1 Service Worker (`sw.js`) 离线生命线
* **严防语法错误白屏**：在 `sw.js` 中拦截 `/js/` 目录下的模块请求时，**离线状态下严禁将请求回退到 `/index.html`**（否则浏览器解析 HTML 脚本会触发 `Uncaught SyntaxError: Unexpected token '<'` 导致应用彻底瘫痪）。
* **全量模块预缓存**：`sw.js` 的 `ASSETS` 静态列表必须维护前端全部核心 ES 模块列表（共 20 个子模块），安装期必须使用 `Promise.allSettled` 确保静默容错。

### 4.2 增量同步与 Delta Push 原则
* **单次 RTT 聚合拉取**：前端拉取数据必须优先走 `GET /api/sync/pull` 聚合接口，禁止退化为 5 个接口的低效串行拉取。
* **严格脏数据推送 (Delta Push)**：
  * 仅当实体标记有 `_dirty: true` 时才打包进入批量推送；
  * 禁止无差别上报全量数据，防止数据库全局 `updated_at` 时间戳大面积意外更新。
* **冲突裁决**：始终遵循 **Last-Write-Wins (LWW)** 最终一致性原则，使用 `toUpdatedTs` 严格对齐东八区 ISO 时间戳。
* **网络自愈**：所有写入操作必须先持久化至本地 `localStorage`，并在网络事件 `online` 触发时自动无缝唤起重连补偿同步。

---

## 5. 数据安全与防御式编程准则

* **密码加盐与防时序攻击**：
  * 用户密码必须使用 PBKDF2（100,000 次迭代，SHA-256，16字节独立动态盐）；
  * Token 与哈希值比较必须使用 `timingSafeEqualStr` 进行恒定时间比对，严禁直接使用 `===` 进行密码比对。
* **图片二进制魔数嗅探**：
  * 接收任何用户上传图片前，必须使用 `sniffImageMime` 严格校验二进制 Header（PNG: `89 50 4E 47`，JPEG: `FF D8 FF`，GIF: `47 49 46 38`，WebP: `RIFF....WEBP`）；
  * 坚决拦截后缀欺骗与恶意伪装脚本。
* **严格防范 SSRF (服务端请求伪造)**：
  * 解析外链或抓取 OpenGraph 封面时，必须使用安全 Fetch 包装器；
  * 严密校验 14 组保留私网、回环网段及云厂商元数据网段（如 `169.254.169.254`、`10.0.0.0/8`、`127.0.0.0/8` 等）。
* **DOMPurify 净化防存储型 XSS**：
  * 任何来自数据库或用户输入的正文在渲染至 `innerHTML` 前，必须经过 `DOMPurify.sanitize()` 白名单过滤。

---

## 6. UI / UX 与 Apple HIG 交互设计标准

* **Apple HIG 视觉质感**：
  * 容器卡片遵循 **Inset Grouped** 规范，统一采用 `border-radius: 16px ~ 18px` 与浅灰边框高光（`rgba(0, 0, 0, 0.06)`）；
  * 点击微动效遵循 Apple Spring 弹性阻尼：交互元素必须支持 `active: scale(0.96)` 与 `opacity: 0.88`。
* **Cmd+K 现代命令面板**：
  * 搜索中心必须整合快捷操作指令（支持输入 `>` 过滤）；
  * 关键词命中必须经由 `highlightMatches` 进行安全转义并以 `<mark class="search-highlight">` 醒目呈现；
  * 必须支持键盘 `↑` / `↓` 移动焦点高亮与 `Enter` 快捷回车直达。
* **移动端软键盘智能躲避**：
  * 页面任何输入框获焦唤起软键盘时，必须监听并自动为 `document.body` 附加 `.keyboard-open` 类名，动态收起底部导航栏与悬浮加号按钮，避免遮挡视线。
* **外链媒体懒加载与防崩**：
  * 页面所有卡片图片均须标注 `loading="lazy"` 与 `decoding="async"`；
  * 必须配置 `onerror` 降级容错，外链失效时优雅静默隐藏，严禁出现破碎破图图标。

---

## 7. 版本号同步与 Git 提交规范

### 7.1 一键版本号对齐机制
本项目具备多处版本号锚点，严禁手动单独修改某一个文件。当发布新版本时，必须使用预设脚本：
* `npm run bump`：小版本自增（如 2.5.25 $\rightarrow$ 2.5.26）
* **涉及联动文件**：
  1. `package.json` 中的 `version`
  2. `version.json` 中的版本号与发布时间戳
  3. `js/version.js` 中的 `APP_VERSION`
  4. `sw.js` 中的 `APP_V` 与 `CACHE_NAME`
  5. `index.html` 中的资源静态 hash 与版本展示 Badge
  6. `workers/api.js` 中的 `APP_VERSION` 探测常量

### 7.2 Git 提交信息格式 (Conventional Commits)
每次提交信息必须遵循语义化规范：
* `feat(...)`: 新功能或新特性（如 `feat(rag): add prompt retrieval`）
* `fix(...)`: 修复缺陷或崩溃（如 `fix(sw): prevent offline fallback to index.html`）
* `perf(...)`: 性能提升（如 `perf(sync): single rtt aggregated pull`）
* `refactor(...)`: 代码重构（如 `refactor(worker): modularize into workers/src`）
* `docs(...)`: 文档或报告更新（如 `docs: update AGENTS.md guidelines`）
* `test(...)`: 增加或更新测试用例（如 `test(search): add highlight xss tests`）

---

> **结语**：遵循上述规约，方能保障 Chillin 数字花园在经历数十次甚至上百次迭代后，依然保持极致敏捷、丝滑秒开与坚如磐石的系统稳定性。
