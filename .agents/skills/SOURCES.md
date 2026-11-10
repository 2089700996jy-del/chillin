# 技能来源说明（SOURCES）

本目录仅保留**本项目深度自研技能**（9 个）；第三方通用技能与冗余样式快照已全部移出仓库，由工程规则（`.agents/rules/`）与全局能力原生覆盖。

## 本项目自研（9 个）

`apple-interaction-craft` / `brainstorm-challenger` / `cf-worker-d1` / `chillin-ship-guardian` / `garden-rag-llm` /
`garden-spark-ideator` / `pwa-offline-engine` / `systematic-debugging` / `tdd-regression-guard`

## 已移出仓库：第三方与冗余技能

1. **`function-testing`（已移出）**：原引入自 `addxing/function-testing`，设计用于生成外企/外包 PRD 导向的手工测试 Excel 报告。与 Chillin 的 465 项原生 `node:test` 零构建全自动测试体系完全脱节，属于无用负债。
2. **`conservative-code-edits`（已移出）**：原引入自 `addxing/conservative-code-edits`，属于通用的“最小必要改动、避免无关重构”提示词片段。此类行为已在系统原生指令及 `.agents/rules/architecture.md` / `engineering-workflow.md` 中强制约束，无需额外技能占位。
3. **`konsta-ios-ui`（已移出）**：原为 2026-10-02 摘录的 Konsta UI 移动端样式定义。其规范已全面并入项目受控规则 `.agents/rules/ui-style.md`（Inset Grouped 标准、CSS 变量令牌系统）与 `apple-interaction-craft` 技能（Haptic 震动、Spring 曲线、软键盘避让），仓库不再保留陈旧样式快照。
4. **通用 Cloudflare 技能（已移出）**：曾引入 `cloudflare`、`workers-best-practices`、`wrangler` 等快照，现已完全转由本机全局技能目录或官方文档提供，避免同名副本遮蔽上游新版。