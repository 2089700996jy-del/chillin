# 第三方技能来源（SOURCES）

本目录只保留**本项目自研**与**少数第三方单文件技能**；通用 Cloudflare 技能已不再随仓库分发（见下）。

## 本项目自研（10 个）

apple-interaction-craft / brainstorm-challenger / cf-worker-d1 / chillin-ship-guardian / garden-rag-llm /
garden-spark-ideator / konsta-ios-ui / pwa-offline-engine / systematic-debugging / tdd-regression-guard

## 第三方引入、仍随仓库保留（2 个）

| 技能目录 | 来源 | 版本 / 提交 | 许可 | 引入日期 |
| :--- | :--- | :--- | :--- | :--- |
| `conservative-code-edits` | https://github.com/addxing/conservative-code-edits | ab3bd49 | Apache-2.0（见该目录 LICENSE.txt） | 2026-10-15 |
| `function-testing` | https://github.com/addxing/function-testing | d14cb54 | Apache-2.0（见该目录 LICENSE.txt） | 2026-10-15 |

## 已移出仓库：通用 Cloudflare 技能

曾于 2026-10-15 从 npm `@try-works/dsh-cloudflare@0.1.3`（其中 9 个 vendored 自 openai/plugins 的
cloudflare 包）引入 **11 个**技能：`agents-sdk`、`building-ai-agent-on-cloudflare`、
`building-mcp-server-on-cloudflare`、`cloudflare`、`durable-objects`、`flue`、`sandbox-sdk`、`think`、
`web-perf`、`workers-best-practices`、`wrangler`。实际留在本目录的只有最后 3 个；
**2026-10-22 这 3 个也已移出**（`cloudflare` 50 文件 228.9 KB、`workers-best-practices` 4 文件 31.1 KB、
`wrangler` 4 文件 19.6 KB，合计 58 文件约 280 KB）。原因：它们是上游内容的**冻结快照**，而同名时会
遮蔽本机全局技能目录里的更新版本（实测 `tools.skill` 解析 `cloudflare` 时 `resourceBase` 指向仓库副本），
属于「没人跟版就会悄悄过期」的负债——项目此前已因同类陈旧内容被迫修正规约（CDN、localStorage、测试项数）。

现在这些通用技能由本机全局目录（`~/.claude/skills`）提供：删掉仓库副本是**把生效内容换成当前上游版**，
而不是丢掉能力（删除后技能目录里 `cloudflare` 的 description 立刻变成上游新版文案）。项目自身的硬约束
仍写在受门禁校验的 `.agents/rules/*.md` 里，不依赖任何外部技能。

**需要重新拉回仓库时**：`npm pack @try-works/dsh-cloudflare@0.1.3`，解开 tarball 后把 `skills/` 下
对应目录放回本目录并提交（改回即恢复遮蔽，请同时确认上游版本是否已更新）。

> 说明：第三方技能是**外部内容**，使用时会作为参考指令注入上下文。该 npm 包里另有配套的 slash 命令
> 与 Cloudflare API MCP（需以 DSH bundle 插件方式安装才能获得），本目录从来只包含技能本体。