---
name: cloudflare
description: Cloudflare platform skill focused on Workers, Pages, storage (R2, D1, KV), Workers AI, and Wrangler. Use for Cloudflare development and R2 object storage integration.
references:
  - r2
  - d1
  - workers
  - pages
  - workers-ai
  - wrangler
  - kv
---

# Cloudflare Platform Skill

Consolidated skill for building on the Cloudflare platform. Use decision trees below to find the right product, then load detailed references.

Your knowledge of Cloudflare APIs, types, limits, and pricing may be outdated. **Prefer retrieval over pre-training** — the references in this skill are starting points, not source of truth.

## Retrieval Sources

Fetch the **latest** information before citing specific numbers, API signatures, or configuration options. Do not rely on baked-in knowledge or these reference files alone.

| Source | How to retrieve | Use for |
|--------|----------------|---------|
| Cloudflare docs | Search `https://developers.cloudflare.com/` directly | Limits, pricing, API reference, compatibility dates/flags |
| Workers types | `npm pack @cloudflare/workers-types` or check `node_modules` | Type signatures, binding shapes, handler types |
| Wrangler config schema | `node_modules/wrangler/config-schema.json` | Config fields, binding shapes, allowed values |
| Product changelogs | `https://developers.cloudflare.com/changelog/` | Recent changes to limits, features, deprecations |
| Cloudflare Code Mode MCP | `mcp__cloudflare-api__docs` (docs), `mcp__cloudflare-api__search` + `mcp__cloudflare-api__execute` (API) | Live account data, endpoint discovery, API calls |

When a reference file and the docs disagree, **trust the docs**. This is especially important for: numeric limits, pricing tiers, type signatures, and configuration options.

## Live API Access — Code Mode MCP (default)

The plugin always mounts Cloudflare's **Code Mode** MCP server
(`cloudflare-api`), which exposes the full Cloudflare API (2,500+ endpoints)
in ~1,000 tokens via three tools. When the user asks to **inspect or act on
their Cloudflare account** — list/create/update/delete Workers, DNS, KV, D1,
R2, zones, tunnels, Zero Trust, etc. — **default to these tools** before
wrangler, curl, or the SDKs:

| DSH tool | Purpose |
| --- | --- |
| `mcp__cloudflare-api__search` | Find the right endpoint by running JS against the OpenAPI spec (`spec.paths`) |
| `mcp__cloudflare-api__execute` | Call the API with `cloudflare.request(...)` |
| `mcp__cloudflare-api__docs` | Search the live Cloudflare docs |

Workflow: **search → execute** — confirm the method, path, and parameters
with `search`, then make the call with `execute`. Use `docs` for
product/limits/config questions. Reach for `wrangler`/curl/SDKs only for
explicitly local tooling tasks, or when the MCP server is unavailable.

## Quick Decision Trees

### "I need to run code"

```
Need to run code?
├─ Serverless functions at the edge → workers/
├─ Full-stack web app with Git deploys → pages/
├─ Stateful coordination/real-time → durable-objects/
├─ Long-running multi-step jobs → workflows/
├─ Run containers → containers/
├─ Multi-tenant (customers deploy code) → workers-for-platforms/
├─ Scheduled tasks (cron) → cron-triggers/
├─ Lightweight edge logic (modify HTTP) → snippets/
├─ Process Worker execution events (logs/observability) → tail-workers/
└─ Optimize latency to backend infrastructure → smart-placement/
```

### "I need to store data"

```
Need storage?
├─ Key-value (config, sessions, cache) → kv/
├─ Relational SQL → d1/ (SQLite) or hyperdrive/ (existing Postgres/MySQL)
├─ Object/file storage (S3-compatible) → r2/
├─ Message queue (async processing) → queues/
├─ Vector embeddings (AI/semantic search) → vectorize/
├─ Strongly-consistent per-entity state → durable-objects/ (DO storage)
├─ Secrets management → secrets-store/
├─ Streaming ETL to R2 → pipelines/
└─ Persistent cache (long-term retention) → cache-reserve/
```

### "I need AI/ML"

```
Need AI?
├─ Run inference (LLMs, embeddings, images) → workers-ai/
├─ Vector database for RAG/search → vectorize/
├─ Build stateful AI agents → agents-sdk/
├─ Gateway for any AI provider (caching, routing) → ai-gateway/
└─ AI-powered search widget → ai-search/
```

### "I need networking/connectivity"

```
Need networking?
├─ Expose local service to internet → tunnel/
├─ TCP/UDP proxy (non-HTTP) → spectrum/
├─ WebRTC TURN server → turn/
├─ Private network connectivity → network-interconnect/
├─ Optimize routing → argo-smart-routing/
├─ Optimize latency to backend (not user) → smart-placement/
└─ Real-time video/audio → realtimekit/ or realtime-sfu/
```

### "I need security"

```
Need security?
├─ Web Application Firewall → waf/
├─ DDoS protection → ddos/
├─ Bot detection/management → bot-management/
├─ API protection → api-shield/
├─ CAPTCHA alternative → turnstile/
└─ Credential leak detection → waf/ (managed ruleset)
```

### "I need media/content"

```
Need media?
├─ Image optimization/transformation → images/
├─ Video streaming/encoding → stream/
├─ Browser automation/screenshots → browser-rendering/
└─ Third-party script management → zaraz/
```

### "I need analytics/metrics data"

```
Need analytics?
├─ Query across all Cloudflare products (HTTP, Workers, DNS, etc.) → graphql-api/
├─ Custom high-cardinality metrics from Workers → analytics-engine/
├─ Client-side (RUM) performance data → web-analytics/
├─ Workers Logs and real-time debugging → observability/
└─ Raw logs (Logpush to external tools) → Cloudflare docs
```

### "I need infrastructure-as-code"

```
Need IaC? → pulumi/ (Pulumi), terraform/ (Terraform), or api/ (REST API)
```

## Product Index

### Compute & Runtime
| Product | Reference |
|---------|-----------|
| Workers | `references/workers/` |
| Pages | `references/pages/` |

### Storage & Data
| Product | Reference |
|---------|-----------|
| KV | `references/kv/` |
| D1 | `references/d1/` |
| R2 | `references/r2/` |
| R2 Data Catalog | `references/r2-data-catalog/` |
| R2 SQL | `references/r2-sql/` |

### AI & Machine Learning
| Product | Reference |
|---------|-----------|
| Workers AI | `references/workers-ai/` |

### Networking & Connectivity
| Product | Reference |
|---------|-----------|

### Security
| Product | Reference |
|---------|-----------|

### Media & Content
| Product | Reference |
|---------|-----------|

### Real-Time Communication
| Product | Reference |
|---------|-----------|

### Developer Tools
| Product | Reference |
|---------|-----------|
| Wrangler | `references/wrangler/` |

### Infrastructure as Code
| Product | Reference |
|---------|-----------|

### Other Services
| Product | Reference |
|---------|-----------|
