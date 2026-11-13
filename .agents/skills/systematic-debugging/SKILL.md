---
name: systematic-debugging
description: 系统化根因排错、缺陷复现隔离与防盲猜调试指南。吸收 superpowers 软件工程纪律，在定位复杂 Bug、数据同步异常、D1 查询失效或离线白屏时使用。
---

# 系统化根因排错与调试助手 (systematic-debugging)

> 本技能为 **Chillin 数字花园** 的根因排错铁律手册，吸收自开源著名 AI 编程规范 **`obra/superpowers`** 的核心方法论。其唯一宗旨是：**彻底根除“盲猜打补丁（Shotgun Debugging）”，坚持以证据和根因为核心的科学调试闭环**。

---

## 1. 调试绝对铁律 (Iron Laws of Debugging)

1. **严禁在没有复现与确凿证据前盲改代码 (No Fix Without Root Cause)**：
   * 绝对禁止靠直觉“试一试”、“加个 try/catch 看看能不能跑”、“先改改这一行试试”；
   * 盲目打补丁不仅解决不了根因，还会掩盖真正的逻辑漏洞，引入新的隐蔽回归。
2. **永远建立最小复现基线 (Reproduce First)**：
   * 优先编写一个能重现该缺陷的最小测试用例（在 `tests/` 下编写原生 `node:test`），或者设计一个确定性的本地复现步骤。
3. **外科手术式最小修复 (Surgical Fix)**：
   * 修复必须直击根因，改动行数与影响面保持最小，严禁借修 Bug 之名顺手大改无关代码。

---

## 2. 系统化调试四步闭环协议 (The 4-Phase Protocol)

```mermaid
graph TD
    A["缺陷报告 / 异常表现"] --> B["Phase 1: 边界隔离与最小复现 (Reproduce)"]
    B --> C["Phase 2: 假说验证与根因溯源 (Trace Root Cause)"]
    C --> D["Phase 3: 外科手术式最小修复 (Surgical Fix)"]
    D --> E["Phase 4: 绿灯验证与回归防护 (Shield & Verify)"]
    E -->|新测试纳入 npm test| F["安全提交 fix(scope)"]
```

### Phase 1: 边界隔离与最小复现 (Isolate & Reproduce)
- **划定故障域**：通过报错堆栈与网络请求，确定问题属于哪个领域：
  - `A. 前端视图与交互`（DOM 渲染、CSS、输入法躲避）
  - `B. 客户端存储与离线`（Service Worker、IndexedDB、localStorage）
  - `C. 同步与裁决逻辑`（`sync.js`、`toUpdatedTs`、LWW、Dirty Delta）
  - `D. 边缘后端网关`（`workers/api.js`、鉴权、CORS、网关路由）
  - `E. D1 数据库与事务`（SQL 查询、参数绑定、软删除、外键级联）
- **编写最小失败测试 (Red Test)**：
  在 `tests/` 对应测试文件中，用最精炼的数据重现该错误输入。运行该测试应稳定抛错。

### Phase 2: 假说验证与根因溯源 (Formulate & Prove Hypotheses)
- 明确写出 1~2 个可能的根本原因假设；
- **寻找确凿证据**：通过打印变量实际运行值、查看 D1 返回结构或分析网络报文，**证实或证伪假设**；
- 问自己：“如果这个假设是对的，为什么之前没报错？为什么在这组特定输入下才报错？”

### Phase 3: 外科手术式最小修复 (Surgical Fix)
- 仅修改引起根因的那几行代码；
- 严禁通过外层吞掉异常（如空的 `catch {}`）来伪装成功；
- 检查是否破坏了 Worker 300 行网关限制或模块 500 行上限。

### Phase 4: 绿灯验证与回归防护 (Shield & Verify)
- 运行 Phase 1 编写的复现单测 -> **必须由红转绿 (Green)**；
- 运行全局单测套件 `npm test` -> **68+ 项测试必须 100% 绿灯通过**；
- 若涉及 Worker，运行 `npx wrangler deploy --dry-run` 确保打包无误；
- 将新增的测试用例永久固化在测试库中，防止未来的重构破坏此边界。

---

## 3. Chillin 专属高频疑难杂症排查指南

| 故障现象 | 最常见根因 (Root Cause) | 排查切入点与工具 |
| :--- | :--- | :--- |
| **离线启动报 `Uncaught SyntaxError: <`** | `public/sw.js` 错误将某个 JS 模块降级回退为了 `/index.html` | 检查 `tests/sw.test.mjs`，核实请求 URL 是否命中了 `isModuleJs` 分支 |
| **D1 查询返回空或主键索引失效** | 绑定参数传了字符串而不是整数（如 `'123'` 代替 `123`） | 检查传入 `db.prepare().bind(...)` 前是否经过 `Number(id)` 转换 |
| **增量同步后本地修改丢失** | 客户端与云端时间戳未对齐或缺少东八区偏移 | 检查 `toUpdatedTs` 是否正确解析了包含或缺少时区的字符串 |
| **新建记录离线同步时被丢弃** | 离线新建未及时分配临时 ID，导致脏数据选择器过滤失效 | 检查是否调用了 `ensureLocalId`，查阅 `tests/sync.test.mjs` |
| **Web Push 订阅发送报 404/410** | 用户的浏览器已撤销通知权限或注销了 Service Worker | 必须在 `sendEdgePush` 中捕获并从 `push_subscriptions` 物理删除该端点 |
| **前端新增模块离线白屏** | 新建了 `public/js/foo.js` 但忘记在 `sw.js` 的 `ASSETS` 中登记 | 运行 `node --test tests/sw.test.mjs`，单测会自动指出缺失的模块路径 |

---

## 4. 全项目健康度巡检模式 (Macro Health Audit Mode)

当用户提出 **“排查项目 Bug / 检查功能是否正常 / 为什么某功能在真机上没反应”** 等宏观或疑难需求时，**严禁仅凭单测全绿或表面语法无错就得出“代码没有问题”的草率结论**。

必须强制进入本巡检模式，按以下标准作业程序执行：

### Step 1: 静态暗病先行扫描
排查启动时，首先在终端运行：
```bash
npm run audit:system
```
拉取全局静态契约报告，重点检查目标模块是否存在：
1. **静默吞错捕获**：是否有空的 `catch {}` 或仅有 `console.log` 而未向 UI 提示 / 未重试排队的隐性断裂点；
2. **防抖生命周期脱钩**：是否存在带防抖延迟的状态持久化，却未监听 `visibilitychange` / `pagehide`，导致切后台时未刷入状态丢失；
3. **API 路由与 SQL 迁移断层**：核实前后端路径与数据表是否在迁移中真实声明。

### Step 2: 锁定 🟡 评级模块并开展五维深度排查
查阅 [`PROGRESS.md`](../../../PROGRESS.md) 的【全项目功能健康度矩阵】，对涉及的或所有标注为 🟡（仅理想路径测试）的模块，逐一排查以下 5 大真机盲区：

1. **多端状态覆盖 (Multi-client Consistency)**：
   - 检查两端计算实体唯一标识（如 `bookKey`）的算法是否严密一致；若两端各自从本地文件切章，是否会因字符编码、章名正则微小差异产生不同的指纹导致云端命中失败。
2. **移动端后台中断 (Mobile Lifecycle Interruption)**：
   - 移动端（尤其是 iOS Safari / PWA）在用户熄屏、切应用或划掉进程时，常规异步 `fetch` 会被系统瞬间挂起或杀进程。
   - 检查推送请求是否配置了 `{ keepalive: true }` 或 `navigator.sendBeacon`；检查是否存在开书时的“首屏并发竞态”，导致用户误触滚动打上新时间戳把云端进度当成落后数据覆盖。
3. **SW 缓存拦截与毒化 (Service Worker Invalidation)**：
   - 检查请求 URL 是否命中了 Service Worker 的缓存拦截；检查移动端是否仍驻留老版本 JS 未激活，导致修复逻辑未在真机生效。
4. **静默吞错与无声失败 (Silent Swallowed Exceptions)**：
   - 检查网络请求层是否有 `.catch(err => console.warn(err))` 把 401 鉴权过期或 400 参数格式错误当成日常流程吞掉，导致界面毫无反馈。
5. **Mock 测试盲区 (Mock vs Real Runtime Disparity)**：
   - 项目单测依托 Node 内置 `node:sqlite`（`fake-d1`）在单线程内存跑通，**不代表真实 Cloudflare 边缘能跑通**；
   - 警惕内存环境没有的约束：如 Cloudflare Workers 的 WebCrypto PBKDF2 10 万次硬上限、D1 并发事务锁、请求体长度硬限制与网络往返时序抖动。

### Step 3: 输出可观测性诊断方案
严禁盲猜打补丁。在确认根因前，优先在代码中植入显式可观测性挂载函数（如在控制台或界面提供 `window.checkSyncStatus()`），让用户在真机两端打印出实际的 Key、时间戳比对结果与最近 HTTP 响应，拿到确凿运行态证据后再做外科手术式修复。

