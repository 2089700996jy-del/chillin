---
name: garden-rag-llm
description: 数字花园智能记忆检索（RAG）、自然语言时间窗口解析、BM25 分词打分、双模大模型通信（DeepSeek / Cloudflare Workers AI）与 SSE 流式推送规范。在开发或优化花园回响 (Garden Echo)、AI 问答、记忆召回、内容安全合规时使用。
---

# 数字花园 RAG 记忆检索与 LLM 双模通信指南 (garden-rag-llm)

> 本技能为 **Chillin 数字花园** 的 AI 智能检索与大模型边缘端点开发手册，覆盖 **自然语言时间窗口解析**、**多源记忆召回打分 (RAG)**、**双模大模型边缘通信**、**SSE 流式逐字输出** 与 **敏感内容合规审查**。

---

## 1. 记忆检索与 RAG 核心架构 (`workers/src/rag.js`)

数字花园的记忆回响（Garden Echo）基于零外部依赖的边缘轻量 RAG 引擎，全流程纯原生 ESM 实现：

### 1.1 自然语言时间窗口解析 (`parseTimeRangeFromQuestion`)
用户在提问时经常带有自然语言时间状语（例如：“*昨天我写了什么*”、“*本周的工作总结*”、“*2026年3月读过的书*”）：
- **东八区精准对齐**：使用 `east8NowParts()` 将当前系统时间换算为东八区年月日；
- **智能窗口匹配**：
  - “昨天 / 今日 / 今天”：计算单日范围 `[YYYY-MM-DD, YYYY-MM-DD]`；
  - “本周 / 上周”：结合 `date.getDay()`（周一至周日）动态截取周首与周末；
  - “本月 / 上个月”：通过 `new Date(y, m + 1, 0)` 获取月份自然天数；
  - “XXXX年XX月 / XXXX年”：正则提取年份与月份范围。

### 1.2 中文分词与停用词过滤 (`tokenizeQuery`)
- **停用词过滤 (`RAG_STOPWORDS`)**：剔除 `的`、`了`、`关于`、`请问`、`总结` 等 60+ 常见汉语虚词；
- **双字/三字滑窗分词**：对中文字符串运行 2-gram / 3-gram 滑动窗口提取，同时保留英文/数字标识符（`[a-z0-9_]{2,}`），构建高辨识度的检索词集合。

### 1.3 多源记忆语料抽取与打分机制 (`scoreMemoryChunk`)
召回范围覆盖 5 种核心花园资产：**随手记 (Feeds)**、**笔记 (Notes)**、**周记 (Weeklies)**、**书签 (Bookmarks)**、**提示词 (Prompts)**。

| 维度 | 打分权重与规则 | 说明 |
| :--- | :--- | :--- |
| **时间范围匹配** | 时间硬约束 | 若查询带时间范围，落在范围外的数据直接返回 `-1` 淘汰 |
| **标题关键词命中** | `score += 4` / 词 | 标题匹配权重高于正文 |
| **正文关键词命中** | `score += 2` / 词 | 统计正文命中频率 |
| **零命中惩罚** | `score = -1` (淘汰) | 当存在有效主题词且命中数为 0 时，绝不向 LLM 喂入无关记忆 |
| **时效衰减加权** | `2 - ageDays / 180` | 越近的记忆享受轻微时效加分 |

---

## 2. 双模大模型边缘通信 (`workers/src/llm.js`)

Worker 支持 **主备容灾与零门槛降级** 的双模 LLM 调用架构：

### 2.1 主通道：自定义 LLM API (DeepSeek / OpenAI 兼容端点)
- 通过环境变量配置：
  - `LLM_API_BASE`: 例如 `https://api.deepseek.com/v1`
  - `LLM_API_KEY`: 用户的 API 密钥
  - `LLM_MODEL`: 例如 `deepseek-chat`
- **流式请求与 SSE 解析**：
  ```javascript
  // 建立流式通信
  const res = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages, temperature: 0.7, stream: true })
  });
  ```
- 逐行解析 `data: {...}`，提取 `choices[0].delta.content` 并回调 `onChunk(content)`。

### 2.2 备用通道：Cloudflare Workers AI (零配置免费降级)
- 当用户未配置 `LLM_API_KEY` 时，自动平滑降级至 Cloudflare 原生 Workers AI 边缘模型：
  ```javascript
  const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
      messages,
      stream: true
  });
  ```
- 即使完全没有外部大模型 Key，用户的数字花园依然可以在边缘端运行智能总结与回响。

---

## 3. 内容安全合规与敏感词过滤 (`moderateText`)

在将请求发给 LLM 或将生成内容推向客户端前，必须经过合规审查：

1. **硬违规阻断 (`MODERATE_HARD_RE`)**：
   - 涉黄、涉赌、毒品、枪支、暴力恐吓内容直接硬拦截，返回 `{ ok: false, text: '' }`；
   - 支持通过 Worker 环境变量 `MODERATION_POLITICAL_WORDS` 动态注入敏感词热词扩展。
2. **软营销脱敏 (`MODERATE_SOFT_RE`)**：
   - 包含引流、微商、刷单、加群、办卡等推广内容，自动无害化替换为 `****`，保障花园内容纯净。

---

## 4. 前端交互与流式打字机体验 (`public/js/echo.js`)

前端通过 SSE 流式读取后端接口响应：
- 使用 `TextDecoder` 实时切片并挂载进 DOM；
- 结合 Markdown 渲染器实时解析为带语法高亮与样式的花园卡片；
- 支持将生成的回响内容一键保存为本地随手记（Feed）或深思笔记（Note）。

---

## 5. 自动化测试套件

修改 RAG 或 LLM 模块后，使用以下命令验证：

```bash
# 运行 RAG 专项单测（包含分词、时间解析、记忆打分）
node --test tests/rag.test.mjs

# 运行完整单测套件
npm test
```
