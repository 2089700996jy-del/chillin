# 第三方技能来源（SOURCES）

本目录下的技能分两类：**本项目自研**（apple-interaction-craft / chillin-ship-guardian / cf-worker-d1 /
pwa-offline-engine / garden-rag-llm / garden-spark-ideator / konsta-ios-ui / systematic-debugging /
tdd-regression-guard / brainstorm-challenger）与**第三方引入**（下表）。

| 技能目录 | 来源 | 版本 / 提交 | 许可 | 引入日期 |
| :--- | :--- | :--- | :--- | :--- |
| `conservative-code-edits` | https://github.com/addxing/conservative-code-edits | ab3bd49 | Apache-2.0（见该目录 LICENSE.txt） | 2026-10-15 |
| `function-testing` | https://github.com/addxing/function-testing | d14cb54 | Apache-2.0（见该目录 LICENSE.txt） | 2026-10-15 |
| `agents-sdk` / `building-ai-agent-on-cloudflare` / `building-mcp-server-on-cloudflare` / `cloudflare` / `durable-objects` / `flue` / `sandbox-sdk` / `think` / `web-perf` / `workers-best-practices` / `wrangler` | npm `@try-works/dsh-cloudflare`（源自 https://github.com/try-works/dsh-cloudflare，其中 9 个 vendored 自 openai/plugins 的 cloudflare 包） | 0.1.3 | 见包内 LICENSE | 2026-10-15 |

> 说明：第三方技能是**外部内容**，使用时会作为参考指令注入上下文。升级方式：重新拉取上游，替换对应目录后提交。
> 这 11 个 Cloudflare 技能在 npm 包里另有配套的 slash 命令与 Cloudflare API MCP（需以 DSH bundle 插件方式安装才能获得），
> 本目录只包含技能本体。
