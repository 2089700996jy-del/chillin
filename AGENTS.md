# Chillin 数字花园：全局开发规约总纲 (AGENTS.md)

> 本文档是 **Chillin 数字花园** 项目的全局最高开发宪法。无论是人类开发者还是 AI 协作助手，在阅读、编写、重构或调试本项目代码时，**必须无条件严格遵守**以下总纲原则。
>
> 深入的技术细节、实现标准与边界定义，已模块化拆分至 [`.agents/rules/`](file:///d:/7/chillin/.agents/rules/) 专项目标库中。

---

## 细分领域专项规则库索引 (.agents/rules/)

进行特定业务域的开发时，必须对照执行对应的细分规范：

| 领域模块 | 规约文件 | 核心管控要点 |
| :--- | :--- | :--- |
| 🏗️ **系统架构与技术栈** | [`architecture.md`](file:///d:/7/chillin/.agents/rules/architecture.md) | **Zero-Build 原生铁律**（HTML5+CSS+ESM，严禁打包器与视图框架）；后端 Worker 网关 **300 行红线** 与 6 大微内核职责分工；D1 迁移版本控制。 |
| 🎨 **UI 美学与交互标准** | [`ui-style.md`](file:///d:/7/chillin/.agents/rules/ui-style.md) | **Apple HIG Inset Grouped** 视觉标准；Apple Spring 弹性阻尼触感反馈；**Cmd+K 现代命令面板**（快捷指令优先、关键词高亮、全键盘导航）；移动端软键盘智能躲避；外链媒体兜底。 |
| 📶 **PWA 离线与增量同步** | [`pwa-offline-sync.md`](file:///d:/7/chillin/.agents/rules/pwa-offline-sync.md) | **Service Worker 离线防崩白屏生命线**（严禁 JS 降级为 HTML）；20 个核心模块全量预缓存；单次 RTT 聚合拉取；**Delta Push 脏数据差异推送**；LWW 冲突裁决；断网感知与重连自动同步。 |
| 🛡️ **数据安全与防御式编程** | [`security.md`](file:///d:/7/chillin/.agents/rules/security.md) | **PBKDF2 强哈希**（10万次+动态盐）；`timingSafeEqualStr` 恒定时间防时序攻击；图片二进制魔数严格嗅探；SSRF 14 组保留私网拦截；DOMPurify XSS 白名单清洗。 |
| 🧪 **工程质量与交付工作流** | [`engineering-workflow.md`](file:///d:/7/chillin/.agents/rules/engineering-workflow.md) | **Node 20 原生零依赖单测套件**（`npm test` 100% 通过卡点）；Wrangler 边缘预打包演练卡点；`npm run bump` **6 点版本号联动对齐**；Conventional Commits 语义化提交。 |

---

## 五大不可逾越的核心底线 (Golden Rules)

1. **零构建黑盒底线**：严禁私自为前端引入任何编译打包黑盒（Vite, Webpack, Tailwind 等）或全家桶框架（React, Vue 等），保持原生 ES Modules 毫秒级极速直开。
2. **Worker 防膨胀底线**：[`workers/api.js`](file:///d:/7/chillin/workers/api.js) 必须保持在 300 行以内纯净路由网关，任何业务逻辑必须严格归入 `workers/src/` 子领域。
3. **离线白屏零容忍底线**：修改 `sw.js` 严禁将 JS 脚本请求错误降级回退至 `/index.html`，维护好 20 个核心模块的离线缓存。
4. **脏数据精准推送底线**：批量同步必须基于 `_dirty: true` 进行精准差异推送，禁止无脑推送全量数据污染数据库全局修改时间戳。
5. **双 100% 验证卡点底线**：代码提交前必须在终端通过 `npm test`（零失败通过）与 `npx wrangler deploy --dry-run`（Exit Code 0 构建成功）。
