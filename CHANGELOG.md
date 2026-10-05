# 更新日志 (CHANGELOG)

> 本文件由 `npm run changelog` 从 git 提交历史自动生成，请勿手工编辑。
> 生成时间：2026-10-05T15:52:30.527Z · 提交数：287

## 2026-10-05

### ✨ 新功能

- **garden**: 引入常青主题资产台（Evergreen Topic Shelves）与生长阶段沉淀系统
- **garden**: 每日心绪打卡、轻启发提问、时光偶遇与本周精神切片
- **storage**: IndexedDB 异步大容量接管与离线感知增强
- **backup**: 引入 IndexedDB 异步大容量存储与一键全量备份导出（ZIP + Resend 邮件直发）

### 🐛 缺陷修复

- **auth**: 兼容历史会话标识吊销并完善系统推送通知交互反馈
- **pwa**: 适配 TrustedScriptURL 解决 SW 注册受阻并解耦版本探针

### 🎨 样式

- **ui**: 采用 Konsta iOS HIG 标准重构心绪打卡与偶想卡片（去 AI 感）
- **ui**: 整体去 AI 化重构，全面落地 Apple HIG 与 Konsta iOS 视觉规范
- **ui**: 根据 Konsta iOS 规范重构账号安全弹窗，消除顶部白线并升级无边框胶囊关闭按钮
- **auth**: 登录卡片垂直居中并移除冗余副标题
- **auth**: 基于 Konsta iOS HIG 完全重构登录页去除 AI 模板痕迹
- **auth**: 重构登录页为 Konsta iOS 纯粹纸感风格并移除深色模式

## 2026-10-04

### ✨ 新功能

- **auth**: overhaul login page with Apple HIG glassmorphism, brand emblem, and password toggle

### 🐛 缺陷修复

- **garden**: 完善 D1 自增 ID 生成、访客提示词同步与前端静态门禁
- **sync**: preserve 2s auto-hide logic and attribute stripping on sync completion
- **sync**: restore permanent status light in navbar with breathing pulse and click-to-sync
- **reader**: eliminate excessive blank space at bottom of reader view
- **ui**: resolve transparent confirm dialog bug and upgrade to Apple HIG alert modal
- **ui**: eliminate harsh focus borders, outlines, and blue halos across all modules
- **feeds**: remove voice capture and eliminate aggressive card/tab focus borders
- **feeds**: pre-request mic permission and elevate mobile toasts above bottom nav
- **ui**: remove welcome toast and align mobile navbar icons flush right
- **ui**: resolve navbar scroll jump and reader mode layout collisions

### ♻️ 重构

- **auth**: remove AI-slop visual tropes, adopt tranquil human minimalism

## 2026-10-03

### ✨ 新功能

- complete phases 1-5 (reader progress sync, voice capture, bi-directional wikilinks, security decoupling, and css debt cleanup)

### 🐛 缺陷修复

- resolve reader progress api parsing, modal dismissal, voice capture duplication and wikilink edge cases

### 🎨 样式

- **ui**: polish reader typography modal contrast, wikilinks pills and dark/eyecare themes

## 2026-10-02

### ✨ 新功能

- **pwa**: add a favicon and precache the iOS 180px icon (v2.5.48)
- **ops**: add a public /api/health probe and document observability
- **ops**: add a ship pipeline that cannot bypass the quality gates
- **upload**: real progress, one-tap retry, and push permission on user gesture
- **a11y**: in-app dialogs, modal semantics with focus trap, focus-visible rings and a skip link
- **auth**: sliding sessions, token rotation and a login-device manager
- **ops**: add a rotated D1 backup script and document restore

### 🐛 缺陷修复

- **pwa**: ship a real multi-size favicon instead of a 16px-only one (v2.5.49)
- **security**: enforce Trusted Types instead of observing them (v2.5.47)
- **audit**: give audit_log and ugc_quarantine a 180-day retention policy
- **worker**: cap outbound link-parse bodies and add a Microlink privacy switch
- **csp**: add object-src/frame-src none, upgrade-insecure-requests and drop dead font allowances
- **sync**: never drop or duplicate records that lack a client id
- **security**: forward the real client IP through the Pages proxy behind a shared secret (v2.5.43)

### ⚡ 性能优化

- **upload**: re-encode images to WebP with a JPEG fallback
- **pwa**: self-host DOMPurify and drop the only third-party script origin

### ♻️ 重构

- **security**: route every HTML sink through one Trusted Types choke point (v2.5.46)
- **worker**: split the 999-line garden module into five focused modules
- **worker**: extract the AI chat route so the gateway fits the 300-line red line

### 🧪 测试

- **security**: prove setHtml takes the Trusted Types path and degrades without it
- **worker**: add SQLite-backed integration tests for CRUD and sessions
- **pwa**: guard the service worker precache list and the no-HTML-fallback rule

### 🤖 持续集成

- **workflow**: enforce the double 100% gate on push and pull requests

### 📝 文档

- **report**: refresh the architecture report to v2.5.49 across security, testing and the publish surface
- **readme**: record the remote Pages project settings the repository cannot express
- describe the public/ publishing layout across README, rules and PROGRESS
- sync version, migration and test-count references to v2.5.45
- **ops**: evaluate repository history slimming and generate a CHANGELOG
- sync the architecture report and progress log to v2.5.43

### 🎨 样式

- **css**: introduce spacing/radius/motion design tokens and document the migration policy

### 🔧 杂务

- **pages**: remove the duplicated site copies from the repository root (phase 3b/3)
- **pages**: point tooling and tests at public/ and guard the Pages layout (phase 3a/3)
- **pages**: stage the site assets under public/ for the output-directory migration (phase 1/3)
- **repo**: remove the stale APK and archive the one-off icon generator
- **repo**: archive the vendored Konsta UI snapshot outside the repository
- **repo**: drop the stale preview-ios.html ignore rule and clear the wrangler cache
- **ops**: regenerate the CHANGELOG inside ship and declare the Node engine
- **release**: bump to v2.5.44 and log the engineering/UX batch
- **deps**: update wrangler to 4.145 and move the compatibility date to 2026-10-01
- **repo**: add .dev.vars example and an explicit all-rights-reserved LICENSE

## 2026-10-01

### ✨ 新功能

- **ui**: skeleton screens, load-more pagination, reduced-motion support and system theme default
- **auth**: issue HttpOnly cookie sessions with logout-all while keeping Bearer compatibility

### 🐛 缺陷修复

- **auth**: add an account-scoped login lockout because the proxy masks client IPs (v2.5.42)
- **pwa**: compute CSP hashes from LF bytes and pin LF checkouts (v2.5.41 hotfix)
- **security**: rate limit through a D1-backed shared counter instead of an isolate-local map
- **security**: drop 'unsafe-inline' from script-src by delegating every inline handler
- **security**: store session tokens as SHA-256 hashes with transparent legacy upgrade
- **security**: add HSTS to Pages and Worker responses plus a deny-all CSP for API replies
- **security**: close IPv6 and FQDN-dot SSRF bypasses in the URL guard
- **feeds**: move Microlink link enrichment to the Worker where CSP cannot block it
- **build**: realign all six version anchors and drive badges from APP_BUILD_LABEL (v2.5.38)
- **build**: use node --test auto-discovery instead of directory argument

### ⚡ 性能优化

- **upload**: reject oversized payloads before buffering the request body

### 📝 文档

- update product and technical architecture report to reflect v2.5.37 achievements

### 🔧 杂务

- **release**: bump to v2.5.40 and document the leftover security-debt batch
- **release**: bump to v2.5.39 and log the security/UX hardening batch
- **repo**: untrack the vendored Konsta UI snapshot and write a real README

## 2026-09-30

### ✨ 新功能

- **ui**: direction 2 desktop widescreen workspace edge-to-edge navbar and de-ai prompt cards v2.5.34
- **ui**: phase 3 mobile tab item flex sizing and dark mode parity v2.5.33
- **ui**: phase 3 dark and eyecare theme component parity with snappy view transition v2.5.32
- **ui**: phase 2 mobile ergonomics, lightbox gallery and heatmap streak badge v2.5.31
- **ui**: phase 1 de-ai aesthetics overhaul, svg iconography, and collapsible echo cards

### 🐛 缺陷修复

- **reader**: fix back button flex layout from inline block to inline-flex row with optical alignment (v2.5.37)
- **ui**: perfectly balance back chevron geometry and optical center alignment v2.5.36
- **ui**: optimize back button in reader mode and hide desktop brand on mobile v2.5.35
- **test**: use tests/ directory in test script

## 2026-09-23

### ✨ 新功能

- **reader**: merge reader toolbar into top navbar with subtle low-opacity icons and bump to v2.5.27
- **reader**: replace emoji icons with sleek vector SVGs and remove toolbar borders and shadows
- **ui**: apply konsta ios mobile polish to navbar, reader, prompts filter and fab
- **core**: optimize sync, modularize worker, upgrade rag, cmd+k palette and sw offline resilience

### 🐛 缺陷修复

- **ui**: eliminate static hairline navbar border when idle and add dynamic top loading shimmer
- **pwa**: harden cache headers, bypass version.json in sw, add ignoreSearch and probe timeouts

### ♻️ 重构

- **rules**: consolidate testing and workflow into engineering-workflow.md

### 📝 文档

- remove outdated 777 initial exploration memo
- **rules**: establish modular rules library and AGENTS.md specification
- add product manager evaluation and architecture report

### 🎨 样式

- **reader**: full-bleed immersive reader redesign, fix bottom text clipping and sticky hover buttons (v2.5.29)

### 🔧 杂务

- **release**: bump version to 2.5.26 and sw cache to chillin-v73 to trigger pwa update

## 2026-09-14

### ✨ 新功能

- **ui**: remove technical vs life category separation across home gallery, cards, and weekly editor (v2.5.25)

## 2026-09-13

### ✨ 新功能

- **ui**: eliminate navbar lines, remove button shadows, upgrade top and bottom icons to SF Symbols vector style (v2.5.21)
- **ui**: complete system-wide Konsta iOS HIG mobile design overhaul (v2.5.20)
- **ui**: apply Konsta iOS HIG mobile design system and skill (v2.5.19)

### 🐛 缺陷修复

- **interaction**: disable all haptic vibrations, eliminate top edge subpixel leak line (v2.5.22)

### 🎨 样式

- **editor**: redesign weekly editor into Konsta iOS Inset Grouped layout with collapsible widgets and fix mobile nav collision (v2.5.24)
- **ui**: remove trailing dots from all module titles and brand headers (v2.5.23)

## 2026-09-12

### ✨ 新功能

- **prompts**: integrate prompt library into bookmarks with dual-filter, variable filler, and ai pipeline (v2.5.17)
- modernize focus-visible A11y, sanitize proxy errors, add SRI, archive docs, and release v2.5.15

### 🐛 缺陷修复

- **ui**: remove redundant new prompt button and polish prompts library mobile layout (v2.5.18)
- **reader**: lock viewport and contain overscroll to prevent bottom pull blank gap (v2.5.16)
- **security**: remove inline onclick handlers, enforce safe ID types, and release v2.5.14

## 2026-09-03

### ⚡ 性能优化

- **pwa**: reduce foreground sync and version poll for battery

## 2026-09-02

### ♻️ 重构

- safe cleanup — split auth/sync and remove dead code

### 🔧 杂务

- remove Capacitor Android app and www sync mirror
- add version bump script and release v2.5.12

## 2026-09-01

### ✨ 新功能

- **ui**: show sync status as traffic-light dot without text
- **pwa**: add force refresh to clear SW cache and load latest
- **ai**: retrieve relevant memories with lightweight RAG before answering

### 🐛 缺陷修复

- **auth**: harden PWA login with Worker fallback and safer init
- **pwa**: faster update detection without relying on proxy CDN
- soft-delete safety, per-user sync cursors, and PWA module cache
- restore login strings and harden soft-delete sync

### ♻️ 重构

- dedupe sync helpers and fix feeds save import

### 🔧 杂务

- align D1 migrations and clarify login error messages

## 2026-08-31

### ✨ 新功能

- **core**: implement incremental sync with soft deletions
- make AI echo cards horizontal scroll to save vertical space; perf: limit feed and bookmark list rendering to 100 items
- bypass Bilibili WAF using native API for rich link parser and fix unclosed scope bug

### 🐛 缺陷修复

- **time**: force East 8 (UTC+8) for all project timestamps in DB and frontend
- **api**: fix url reference error in worker router causing 500 on sync
- move Microlink fallback to client-side to completely bypass Cloudflare Worker IP rate limit
- increase API timeouts for Microlink to 15s to bypass WAF timeouts
- change NEXT_DATA regex from [^<]+ to [\s\S]+? to support HTML inside JSON
- link parsing failed when URL was followed by Chinese text, added timeouts to worker fetches

### 🎨 样式

- redesign rich link card to seamlessly integrate into feed card based on user screenshot

### 🔧 杂务

- bump version to 2.5.0 for incremental sync release
- remove test files
- bump version to v2.4.23
- safe bump version to v2.4.22 without encoding corruption

## 2026-08-25

### 🐛 缺陷修复

- Android bottom color band and restore gray theme-color
- restore login styles after CSS encoding corruption
- clean reader chrome and stop dark theme leaking on exit
- harden auth UX, search jumps, and empty states

### 🎨 样式

- deepen iOS look and fix Android bottom color band
- adopt iOS HIG system blue theme and system fonts

### 🔧 杂务

- stop tracking preview-ios.html

### 📎 其他

- remove module page descriptions for a cleaner layout

## 2026-08-24

### 🐛 缺陷修复

- override iOS PWA specific reader mode theme styles
- sync iOS PWA theme-color with reader mode background

### 🔧 杂务

- bump version to 2.4.9 to force PWA update

## 2026-08-21

### 🐛 缺陷修复

- respect iOS PWA safe areas for notch and home bar

## 2026-08-19

### ✨ 新功能

- show build version badge in page footer corner

### 🐛 缺陷修复

- check PWA updates on focus and auto-reload
- bump js/version.js label to v2.4.2
- make version badge visible above PWA bottom nav

### ♻️ 重构

- extract reader, feeds, echo-ai, search, and upload modules
- extract router, weeklies, notes, bookmarks modules
- extract auth/sync into js/state.js and js/api.js
- extract shared helpers into js/utils.js ES module

### 🎨 样式

- compact bookmarks list and match status bar to white
- show version at end of page content instead of overlay
- pin version label to bottom edge and soften opacity

### 🔧 杂务

- remove unused reader import CSS remnants
- remove unrelated repo junk and refresh PROGRESS.md

### 📎 其他

- route all search through global search only
- fix bookmark desc mapping and add updated_at for sync
- fix security and sync regressions after push feature

## 2026-08-18

### ✨ 新功能

- remove swipe to edit feature from bookmarks
- add pwa push notifications
- tag filter, direct image upload, and bookmark swipe to edit
- tier 1 features - bookmark edit, global search, echo links, multi-turn AI, and UX polish

### 🐛 缺陷修复

- reference error causing blank feeds
- app.js reference error and add mouse support for swipe
- auto-generate access tokens for legacy files and redirect img tags to token URL
- convert form to div, use type=button to prevent native refresh, register doLogin globally
- remove syntax error closing brace at line 1822 in app.js and bump PWA cache to v5
- add 401 retry safeguard and D1 replication lag retry to prevent login reset
- bump PWA SW cache to v3 with no-cache headers and auto update detection
- execute syncFromApi immediately on page load and login without waiting on guest merge
- enhance login form feedback, button type, and error toasts

### ⚡ 性能优化

- optimize AI chat speed with parallel DB queries and compact prompt context

### 🔧 杂务

- bump version to 2.0.6

### 📎 其他

- redesign echo card and remove tag filter
- remove edit button from bookmark cards
- improve sync, history, heatmap, and AI echo cards
- harden security: rate limits, file ownership, UGC quarantine, CSP

## 2026-08-17

### ✨ 新功能

- 数据库索引优化、Session自动清理与AI对话SSE流式响应

## 2026-08-16

### 📎 其他

- 收紧 AI 气泡排版间距
- 修复 AI 气泡间隔过大：移除 white-space pre-wrap
- AI 助手预设欢迎语改用结构化排版
- AI 回复 Markdown 渲染：修复 * # 符号外露与排版
- 去除导出按钮、修复回响卡片生成卡住、新增删除回响卡片
- 补充进度记录：图片修复与 PWA 使用决定
- 修复原生壳图片不显示：/api 相对路径转绝对地址
- 修复原生壳登录网络失败：API 走 Pages 代理 + CORS 放宽 localhost 来源
- 安卓构建修复：绕过非 ASCII 路径检查、放宽 Gradle 下载超时
- Capacitor 安卓工程 + 白底黑字 chillin 图标 + 后端 CORS 适配原生壳
- PWA 增强：iOS 全屏安装 meta、manifest 可安装性字段
- 安全修复：审计扫描限本人、链接解析需鉴权、文件访问令牌、防跨用户ID覆盖、移除死路由

## 2026-08-15

### 📎 其他

- 修复 sw.js Content-Type（Service Worker 注册需要 JS 类型）
- 新增 PWA(manifest+SW+图标) 与 AI 本周回顾
- 安全升级：密码 PBKDF2(透明升级)、Session 7天、一键导出备份、文件防爬取、.gitignore 排除 txt
- 合规加固：CORS 白名单、外链黑名单、AI 输出过滤、UGC 审计(cron)、referrer 防泄露
- 移除公开的 X-API-Key 鉴权层，改为仅靠 Bearer token 用户鉴权
- 安全加固：link/parse 防 SSRF、正文 XSS 清洗、DeepSeek 密钥收敛到后端、上传与文件响应加固

## 2026-08-14

### 📎 其他

- Fix verification file: remove trailing newline
- Add verification file for site restoration

## 2026-08-12

### 📎 其他

- Ensure robust multi-platform link parsing fallback

## 2026-08-11

### ✨ 新功能

- **sync**: implement Seamless Auto-Sync Engine with 6s background polling, zero-DOM-flicker diffing, and focus/online triggers

### 🐛 缺陷修复

- **sync**: implement Tombstones and Synced ID tracking for multi-device deletion synchronization

### 🎨 样式

- **navbar**: remove redundant backup and manual sync buttons for clean automated UX

### 📎 其他

- Support auto-parsing domain URLs without https:// prefix
- Fix mobile AI chat submit button visibility and Enter key submission
- Disable mobile auto-zoom and floating zoom bar
- Hide raw blue link text above rich link preview cards
- Add Microlink API fallback for reliable metadata and cover image fetching
- Use Googlebot user agent fallback in worker to parse Xiaoyuzhou links
- Allow unauthenticated link parsing with API key so guest link previews work
- Fix image referrer policy for Xiaoyuzhou cover artwork
- Add MindBack style rich link cards with cover image, description, and platform pill
- Fix 403 Forbidden link preview bug

## 2026-08-10

### 🐛 缺陷修复

- **auth**: call checkAuth() on page initialization to automatically hide login overlay for logged in users
- **auth**: fix mobile login Failed to fetch with same-origin Pages proxy and fetchWithFallback dual-endpoint retry
- **sync**: implement rescueAndConsolidateLocalData to recover all mobile local storage keys and ensure phone primary data is never lost
- **sync**: implement smart bi-directional union merge in syncFromApi to prevent local data wipe and auto upload missing local items
- **sync**: implement batch sync endpoint and increase fetch timeout to fix mobile network abort issue
- **sync**: fix multi-device sync, feeds ID matching, API_BASE fallback, and manual sync UI

### 🎨 样式

- **ui**: hide FAB button on feeds page and remove tap highlight rectangle overlays across all mobile buttons
- **auth**: hide top and bottom navigation bars on login screen

## 2026-08-09

### ✨ 新功能

- Add MindBack Echo features with DeepSeek AI integration

### 🐛 缺陷修复

- Hide bottom nav and FAB button when soft keyboard is open, and align send button to right
- Fix mobile scroll transform offset on top navbar and improve bottom tab bar touch target

### 🎨 样式

- Redesign mobile navigation bar into bottom tab bar

### 📎 其他

- Hide mobile bottom nav bar during book reading view

## 2026-08-07

### ✨ 新功能

- Include compressed MP3 (18.48MB) under Cloudflare 25MB limit
- Add Podcast feature with audio player and persistent mini-player

### 🐛 缺陷修复

- Add .cloudflareignore to bypass 25MB limit on Cloudflare Pages

### ⏪ 回滚

- Remove podcast feature and untrack mp3 file

## 2026-08-06

### 🔒 安全加固

- remove deployment batch files from repository and add to .gitignore

## 2026-08-03

### ✨ 新功能

- 收藏功能优化 — 分类标签改为芯片选择 + 支持封面图片
- 夜间模式整页变黑 + 新增护眼浅绿模式
- 新增微信导入、粘贴文本等多种导入方式
- 新增📚阅读功能 - TXT小说阅读器

### 🐛 缺陷修复

- 添加图片预览弹窗CSS，之前漏掉了导致弹窗不显示
- 收藏卡片添加overflow:hidden防止图片溢出
- 图片预览改用弹窗避免浏览器拦截 + 修复退出阅读时重复渲染
- 无链接但有图片的收藏卡片，点击可在新标签页查看原图
- 收藏链接字段改为选填，无链接时不跳转
- 修复四个问题
- 夜间模式顶部导航栏适配 + 去掉无效的字号按钮
- 修复章节截取偏移bug并优化侧边栏目录UI

### 📎 其他

- 简化为仅文件选择，导入功能移至右下角紫色加号

## 2026-07-02

### ✨ 新功能

- add weekly draft autosave and restore feature

## 2026-06-30

### 📎 其他

- Style: optimize backup and logout buttons into beautiful capsules
- Feat: Add annotations / timelines support to homepage weekly recaps
- Feat: Add annotations and timelines support to simple notes
- Style: implement Pinterest masonry layout for gallery view to avoid card stretching and row gaps
- Style: Fix grid card stretch by adding align-items start and revert cover to object-fit cover
- Style: Change homepage card cover to use object-fit contain and auto height to display full image without cropping
- Style: Optimize card cover height and remove max-height on article covers to display full images
- Fix: convert D1 select BLOB array output back to Uint8Array for image serving
- Fix: Migrate upload & file endpoints from Telegraph to D1 self-hosted database
- Fix: Add client-side image compression to bypass Telegraph 5MB limit and HEIC compatibility

## 2026-06-26

### 📎 其他

- Rewrite deployment script to be encoding-safe without non-ASCII characters
- Update deployment script to use npx -y wrangler to prevent hanging
- Configure API key validation and disable public registration by default
- Implement live global search and filtering for weeklies, notes, and bookmarks
- Add self-hosted image upload feature using Pages Function and Telegraph proxy
- Redesign mobile UI with floating glassmorphic navbar and premium bento style
- Fix API not configured error by removing empty API_BASE checks
- Add backup button and merge guest data on login
- Use Cloudflare Pages Functions to proxy API requests and delete redirects
- Fix mobile login failed to fetch via pages redirect

## 2026-05-12

### 📎 其他

- Auto update: add auth and multi-account

## 2026-05-08

### 📎 其他

- 修复页面加载时内容空白 — 先渲染本地缓存再后台同步 API
- 修复 XSS 安全漏洞和取消新建周记时的路由错误
- 修复 API 请求无超时导致手机端空白 — 加 5 秒 AbortController 超时
- 添加 Cloudflare D1 + Worker API 后端，支持多设备数据同步
- 清理测试文件
- test
- Add files via upload
- Initial commit
