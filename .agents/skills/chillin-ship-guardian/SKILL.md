---
name: chillin-ship-guardian
description: Chillin 发布全流程质量门禁、八点版本号联动自检、Worker 网关行数合规、Conventional Commits 规范与一键发布部署助手。在发布版本、跑发布预演或提交生产代码时使用。
---

# 发布质量自检与守卫流水线 (chillin-ship-guardian)

> 本技能为 **Chillin 数字花园** 的发布合规门禁手册。在代码合并入主分支或发布上线前，负责全面自检版本联动、测试绿灯、Worker 架构红线与部署预演。

---

## 1. 发布门禁五大卡点 (The 5 Release Quality Gates)

在执行任何发版部署前，必须全自动化完成以下五大卡点校验：

| 卡点 | 校验目标 | 验证指令 / 手段 | 违规后果 |
| :--- | :--- | :--- | :--- |
| **Gate 1: 单测 100% 绿灯** | 全量单元测试零失败 | `npm test` | 阻断发版 |
| **Gate 2: Worker 网关红线** | `workers/api.js` <= 300 行 | `tests/architecture.test.mjs` | 阻断发版 |
| **Gate 3: SW 离线预缓存** | `public/js/` 全文件已在 `ASSETS` | `tests/sw.test.mjs` | 离线白屏崩溃 |
| **Gate 4: 边缘打包预演** | 零语法/包体积超限错误 | `npx wrangler deploy --dry-run` | 边缘部署失败 |
| **Gate 5: 版本号 8 点联动** | 保证多端与 SW 缓存版本一致 | `npm run bump` | 客户端旧缓存死锁 |

---

## 2. 八点版本号联动对齐 (8-Point Version Sync)

Chillin 采用严格的静态缓存版本控制，每次发布新版本必须保证以下 8 处版本号完全一致（全部由 `npm run bump` 自动写入，**严禁手改单个文件**；[`tests/docs.test.mjs`](../../../tests/docs.test.mjs) 会实跑 `--dry-run` 校验覆盖范围）：

1. [`package.json`](../../../package.json) 中的 `"version"`
2. [`public/version.json`](../../../public/version.json) 中的版本号与发布时间戳
3. [`public/js/version.js`](../../../public/js/version.js) 中的 `APP_VERSION`
4. [`public/sw.js`](../../../public/sw.js) 中的 `APP_V` 与 `CACHE_NAME`（触发 SW 激活更新）
5. [`public/index.html`](../../../public/index.html) 中的资源静态引入 hash 与右下角版本 Badge
6. [`workers/api.js`](../../../workers/api.js) 中的 `APP_VERSION` 探测常量
7. [`PROGRESS.md`](../../../PROGRESS.md) 的版本头与当前版本段落
8. [架构报告](../../../docs/Chillin数字花园_产品全景与工程架构分析报告.md) 的报告版本、在线基准与 Service Worker 缓存版本

### 自动化版本递增工具：
```bash
# 升级 patch 版本 (例如 2.5.81 -> 2.5.82)
npm run bump patch

# 升级 minor 版本 (例如 2.5.81 -> 2.6.0)
npm run bump minor
```

---

## 3. Conventional Commits 语义化提交规范

所有 Git 提交必须遵循语义化提交规范，严禁出现含糊不清的提交信息：

```
<type>(<scope>): <subject>
```

### 常用类型 (Types):
- `feat`: 新增功能（如 `feat(echo): 记忆回响支持自定义提示词卡片`）
- `fix`: 缺陷修复（如 `fix(sw): 修正 iOS 下离线模块加载竞态`）
- `refactor`: 重构优化且不改变现有行为（如 `refactor(d1): 将笔记查询下沉至 garden-resources.js`）
- `perf`: 性能体验优化（如 `perf(ui): 增加 Apple Spring 阻尼与图片预解码`）
- `test`: 单元测试补充（如 `test(backup): 增加 FakeD1 跨日截断用例`）
- `chore`: 构建配置、依赖、版本更新（如 `chore(release): bump v2.5.82`）

---

## 4. 标准发布与上线 SOP 流水线

发布代码的标准端到端流水线如下：

```bash
# 1. 运行完整单测套件 (全量 68 项通过)
npm test

# 2. 运行边缘部署演练 (Exit Code 0)
npx wrangler deploy --dry-run

# 3. 执行自动化发布脚本 (自动递增版本、同步 8 点版本号、生成 Commit 并推送到 GitHub)
npm run ship -- --message "feat(scope): 功能描述" --bump patch --push

# 4. 触发 Cloudflare Worker 生产环境部署
npx wrangler deploy
```

> [!TIP]
> 部署完成后，在移动设备或浏览器端打开网页，点击右上角或设置面板的 **版本更新** 按钮，验证 Service Worker 是否已平滑提示新版本就绪并成功重载。
