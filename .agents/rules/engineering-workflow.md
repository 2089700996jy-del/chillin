# 工程质量、自动化测试与交付工作流规范 (Engineering & Workflow Rule)

> 本规范整合了 Chillin 项目的代码质量底线、原生自动化测试、预打包校验、版本号联动机制与 Git 协作提交标准，构成完整的端到端开发与交付流水线。

---

## 1. 质量底线与自动化测试红线 (Zero-Dependency Testing)

1. **测试引擎选型**：
   * 本项目测试体系保持**零第三方外部依赖**；
   * 采用 Node.js 20+ 原生内置测试运行器：`node --test tests/` 与严格断言库 `node:assert/strict`；
   * 严禁引入 Jest、Vitest、Mocha 等重型测试框架与成百上千个衍生依赖包。
2. **零容忍质量红线**：
   * 每次代码提交或发布前，必须在终端执行 `npm test`，所有用例必须 **100% 全部通过 (0 Fail, 0 Skip)**；
   * 任何导致单测失败的代码变动，一律视为不合格变更。

### 1.1 核心模块测试覆盖责任矩阵
当修改或新增下列业务模块时，开发者或 AI 助手**必须在 `tests/` 下同步新增或补充测试用例**：

| 修改范围 | 对应测试文件 | 必须覆盖的验证项 |
| :--- | :--- | :--- |
| **密码/鉴权/安全防线** | [`tests/security.test.mjs`](file:///d:/7/chillin/tests/security.test.mjs) | 密码强哈希复杂度、恒定时间比较防时序攻击、图片魔数嗅探、SSRF 14组保留 CIDR 拦截阻断。 |
| **数据同步/冲突合并** | [`tests/sync.test.mjs`](file:///d:/7/chillin/tests/sync.test.mjs) | 时间戳多格式解析 (`toUpdatedTs`)、双向数据合并、Last-Write-Wins 规则生效验证。 |
| **AI 记忆回响 (RAG)** | [`tests/rag.test.mjs`](file:///d:/7/chillin/tests/rag.test.mjs) | 停用词准确过滤、自然语言时间范围解析、全表多特征检索加权打分准确率。 |
| **搜索与命令面板** | [`tests/search.test.mjs`](file:///d:/7/chillin/tests/search.test.mjs) | 关键词命中高亮 (`<mark>`)、大小写不敏感匹配、特殊符号转义与 XSS 防御测试。 |

---

## 2. 边缘构建预检卡点 (Wrangler Dry-Run)

任何涉及 Worker 后端（[`workers/`](file:///d:/7/chillin/workers)）的修改，提交前必须执行预打包演练：

```bash
npx wrangler deploy --dry-run
```

* 验证构建输出必须为 `Exit Code 0`；
* 验证不存在语法解析错误、未声明的 D1 / 环境变量 Binding 缺失，或循环依赖导致打包死锁。

---

## 3. 版本号联动自增机制 (`npm run bump`)

本项目在前端页面、PWA 缓存与 Worker 后端分布有 6 处版本号锚点。**严禁手动单独修改某一个文件**，防止因版本未对齐导致 PWA 缓存无法静默探测更新。

### 3.1 联动文件清单
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

## 4. Git 提交信息格式 (Conventional Commits)

每次 Git Commit 必须严格遵循语义化提交规范，严禁提交模糊无意义信息（如 "fix bug"、"update"）：

* `feat(...)`: 新功能或新业务模块（例如 `feat(rag): add prompt retrieval`）
* `fix(...)`: 修复缺陷或崩溃（例如 `fix(sw): prevent offline fallback to index.html`）
* `perf(...)`: 性能提升（例如 `perf(sync): single rtt aggregated pull`）
* `refactor(...)`: 代码重构（例如 `refactor(worker): modularize into workers/src`）
* `docs(...)`: 文档、报告或开发规约变更（例如 `docs: update rules`）
* `test(...)`: 增加或更新自动化测试用例（例如 `test(search): add highlight xss tests`）
* `style(...)`: 不影响代码逻辑的样式或格式变动
