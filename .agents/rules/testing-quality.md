# 自动化测试与工程质量卡点规范 (Testing & Quality Rule)

> 本规范约束 Chillin 项目的测试技术选型、质量红线、持续集成验证与代码准入标准。

---

## 1. 自动化测试红线 (Zero-Dependency Testing)

1. **测试引擎选型**：
   * 本项目测试体系必须保持**零第三方外部依赖**；
   * 采用 Node.js 20+ 原生内置测试运行器：`node --test tests/` 与断言库 `node:assert/strict`；
   * 严禁引入 Jest、Vitest、Mocha 等重型测试框架与成百上千个衍生依赖包。
2. **零容忍质量红线**：
   * 每次代码提交或发布前，必须在终端执行 `npm test`，测试用例必须 **100% 全部通过 (0 Fail, 0 Skip)**；
   * 任何导致单测失败的代码变动，一律视为不合格变更。

---

## 2. 核心模块测试覆盖责任矩阵

当修改或新增下列业务模块时，开发者或 AI 助手**必须在 `tests/` 下同步新增或补充测试用例**：

| 修改范围 | 对应测试文件 | 必须覆盖的验证项 |
| :--- | :--- | :--- |
| **密码/鉴权/安全防线** | [`tests/security.test.mjs`](file:///d:/7/chillin/tests/security.test.mjs) | 密码强哈希复杂度、恒定时间比较防时序攻击、图片魔数嗅探、SSRF 14组保留 CIDR 拦截阻断。 |
| **数据同步/冲突合并** | [`tests/sync.test.mjs`](file:///d:/7/chillin/tests/sync.test.mjs) | 时间戳多格式解析 (`toUpdatedTs`)、双向数据合并、Last-Write-Wins 规则生效验证。 |
| **AI 记忆回响 (RAG)** | [`tests/rag.test.mjs`](file:///d:/7/chillin/tests/rag.test.mjs) | 停用词准确过滤、自然语言时间范围解析、全表多特征检索加权打分准确率。 |
| **搜索与命令面板** | [`tests/search.test.mjs`](file:///d:/7/chillin/tests/search.test.mjs) | 关键词命中高亮 (`<mark>`)、大小写不敏感匹配、特殊符号转义与 XSS 防御测试。 |

---

## 3. 边缘构建预检卡点 (Wrangler Dry-Run)

任何涉及 Worker 后端（`workers/`）的修改，提交前必须执行预打包演练：

```bash
npx wrangler deploy --dry-run
```

* 验证构建输出必须为 `Exit Code 0`；
* 验证不存在语法解析错误、未声明的 D1 / 环境变量 Binding 缺失，或循环依赖导致打包死锁。
