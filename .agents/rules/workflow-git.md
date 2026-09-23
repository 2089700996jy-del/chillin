# 版本发布与 Git 协作工作流规范 (Workflow & Git Rule)

> 本规范约束 Chillin 项目的版本号多文件联动对齐、语义化提交格式（Conventional Commits）与代码发布工作流。

---

## 1. 版本号联动自增机制 (`npm run bump`)

本项目在前端页面、PWA 缓存与 Worker 后端分布有 6 处版本号锚点。严禁手动单独修改某一个文件，防止因版本未对齐导致 PWA 缓存无法静默探测更新。

### 1.1 联动文件清单
发布新版本时，必须使用项目自动化脚本：
* `npm run bump`：小版本自增（如 `2.5.25` $\rightarrow$ `2.5.26`）；
* `npm run bump:minor`：功能大版本自增。

**脚本将自动同步联动更新以下 6 处锚点**：
1. `package.json` 中的 `version`
2. `version.json` 中的版本号与发布时间戳
3. `js/version.js` 中的 `APP_VERSION`
4. `sw.js` 中的 `APP_V` 与 `CACHE_NAME`（触发 Service Worker 激活更新）
5. `index.html` 中的资源静态引入 hash 及右下角版本展示 Badge
6. `workers/api.js` 中的 `APP_VERSION` 探测常量

---

## 2. Git 提交信息格式 (Conventional Commits)

每次 Git Commit 必须严格遵循语义化提交规范，严禁提交模糊无意义信息（如 "fix bug"、"update"）：

* `feat(...)`: 新功能或新业务模块（例如 `feat(rag): add prompt retrieval`）
* `fix(...)`: 修复缺陷或崩溃（例如 `fix(sw): prevent offline fallback to index.html`）
* `perf(...)`: 性能提升（例如 `perf(sync): single rtt aggregated pull`）
* `refactor(...)`: 代码重构（例如 `refactor(worker): modularize into workers/src`）
* `docs(...)`: 文档、报告或开发规约变更（例如 `docs: add modular rules`）
* `test(...)`: 增加或更新自动化测试用例（例如 `test(search): add highlight xss tests`）
* `style(...)`: 不影响代码逻辑的样式或格式变动
