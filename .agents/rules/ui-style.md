# UI 体验与 Apple HIG 视觉设计规范 (UI & Style Rule)

> 本规范约束前端页面的视觉系统、CSS 变量、Apple iOS HIG 触控反馈动效与无障碍交互体验。

---

## 1. 核心设计语言：Apple HIG 与 Inset Grouped 标准

1. **容器卡片 (Inset Grouped)**：
   * 所有卡片（周记、随手记、笔记、书签、提示词、阅读书架）统一遵循 iOS Inset Grouped 设计标准；
   * 圆角规范：主表面统一使用 `var(--surface-radius)`（26px），微件与子元素使用 `10px ~ 12px`，胶囊一律 `var(--radius-pill)`；
   * 边框与层次：主表面**不画可见硬边框**（`border: 1px solid transparent` 仅保留布局位与深色覆写位），改用 `var(--card-shadow)` 两层柔和弥散阴影分层；确需极细分隔时使用 `--surface-hairline`；
   * 投影系统：`--card-shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 10px 28px rgba(16, 24, 40, 0.05)`，悬停升为 `--card-hover-shadow` 并配合 `transform: translateY(-2px)`；
   * 强调色纪律：全站**唯一强调色**是 `--ios-blue`（`#0066CC`，白字按钮对比度 5.57:1），严禁引入第二个蓝；深色底上的文字与图标改用 `--accent-text`（`#4A9EFF`），严禁拿 `--ios-blue` 作深色文字色；状态绿与热力图色阶一律走令牌（`--heat-empty` / `--heat-1` ~ `--heat-4`）；
   * 留白与字号节奏：移动端主容器内边距 `72px 18px 104px`、卡片垂直间距 ≥ 20px、`.page-title` 40px 且 `letter-spacing: -0.9px`；**层次依靠间距与阴影，不靠生硬分隔线**；
   * 首屏柔光：亮色主题 `body` 顶部铺设两枚低透明度 `radial-gradient`（`--ios-blue` 与 systemGreen）作为 hero 光晕，卡片纯白浮于其上；深色与护眼主题必须显式设置 `background-image: none`。

2. **模糊层与层级纪律**：
   * `backdrop-filter` 只允许「浮在内容之上」的表面使用：顶部导航 `.super-navbar`、底部 Tab 栏 `.mobile-bottom-nav`、阅读器底栏 `.reader-nav-bottom`、弹层遮罩 `.modal-overlay` / `.confirm-dialog-overlay` / `.wikilink-autocomplete-popup`、压在图片上的悬浮图标按钮；
   * 判断标准为**背后是否有可透视的流动内容**：父级不透明（如纯白卡片内的 `.search-input`）或背板仅为纯色时，严禁滥用无收益的模糊层；
   * 顶层层级一律走 `:root` 的 `--z-nav` / `--z-modal` / `--z-toast` / `--z-auth` / `--z-alert` 令牌，严禁裸写 `z-index`；
   * 过渡效果只允许显式声明属性列表，**严禁使用 `transition: all`**（防止连锁触发布局重排）。

3. **Apple Spring 触感反馈微动效**：
   * 所有交互按钮（`.btn-primary`, `.btn-secondary`, `.fab-btn`, `.btn-chip`, `.prompt-chip` 等）必须提供真实的触感回弹；
   * 采用 Apple Spring 弹性阻尼：
     ```css
     :active {
       transform: scale(0.96) !important;
       opacity: 0.88;
       transition: transform 0.15s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.15s ease !important;
     }
     ```
   * 移动端点击禁止触发浏览器原生粗暴的高亮灰框：全局维护 `-webkit-tap-highlight-color: transparent !important;`。

---

## 2. 现代全局「Cmd+K 命令面板」规范

1. **快捷操作优先 (Quick Actions First)**：
   * 当用户按下 `Cmd+K` / `Ctrl+K` 且搜索框为空时，优先呈现高频动作指令（呼叫 AI、写随手记、记笔记、写周记、新建提示词、云同步）；
   * 支持前缀输入 `>` 过滤纯指令动作。
2. **关键词命中高亮 (`<mark>`)**：
   * 搜索命中的标题与正文摘要必须经过 `highlightMatches` 进行关键词高亮包裹：`<mark class="search-highlight">关键词</mark>`；
   * 必须严格经过 `escapeHtml` 字符转义，防御恶意 XSS 注入。
3. **全键盘无障碍导航 (Keyboard Accessibility)**：
   * 监听 `ArrowDown` 与 `ArrowUp` 键，实现选中焦点的平滑循环位移；
   * 选中项赋予 `.active-selection`（带 iOS 蓝条指示与位移动效），自动跟随视口滚动；
   * 监听 `Enter` 键直接执行选中指令或跳转直达目标卡片。

---

## 3. 移动端细节打磨 (Mobile First)

1. **软键盘智能躲避 (Virtual Keyboard Avoidance)**：
   * 监听页面任何输入框获焦事件，自动为 `document.body` 附加 `.keyboard-open` 类名；
   * 键盘弹起时，底部导航栏（`.mobile-bottom-nav`）与右下角悬浮按钮（`.fab-btn`）必须平滑淡出隐藏，避免遮挡正文输入视线。
2. **外链图片防崩兜底与懒加载**：
   * 全局所有动态渲染的图片（周记封面、烟火日常拍立得、随手记媒体预览）必须标注 `loading="lazy"` 与 `decoding="async"`；
   * 图片失败兜底由 `public/app.js` 的**捕获阶段代理**统一处理：自动追加 `img-load-failed` / `is-fallback`，并按 `data-img-hide-on-error="hide|remove"` 决定隐藏或移除；**严禁写内联 `onerror`**（CSP 已禁用内联处理器）。
3. **无障碍 (Accessibility) 底线**：
   * 弹层必须通过 `.modal-overlay.show` 触发，自动补 `role="dialog"` / `aria-modal`、圈定 Tab 焦点、Esc 关闭并归还焦点；
   * 严禁使用原生 `confirm()` / `alert()`，一律改用 `utils.confirmDialog()` 与 `showToast()`；
   * 键盘焦点必须有可见样式（`:focus-visible` 统一兜底，不得再新增 `outline: none`）；
   * **严禁直接写 `el.innerHTML`**：一律使用 [`public/js/trusted-types.js`](../../public/js/trusted-types.js) 的 `setHtml(el, html)`，防御代码注入。
4. **触控热区 (Touch Target) 44pt 底线**：
   * 任何可点击元素的**实际可点区域**不得小于 44×44pt（Apple HIG 与 Konsta 标准）；
   * **热区 ≠ 视觉尺寸**：紧凑胶囊（`.btn-chip` / `.k-mood-chip` / `.prompt-chip` 等）视觉保持 28px，热区通过 `::after` 伪元素扩展：
     ```css
     .btn-chip,
     .k-mood-chip {
       height: 28px;          /* 视觉尺寸 */
       position: relative;    /* 热区锚点 */
     }

     .btn-chip::after,
     .k-mood-chip::after {
       content: '';
       position: absolute;
       left: 0;
       right: 0;              /* 严禁横向外扩，防止抢占相邻点击 */
       top: -8px;
       bottom: -8px;          /* 28 + 8 + 8 = 44px */
     }
     ```
   * **热区严禁横向外扩**：同行胶囊间距通常仅 6~8px，横向外扩会抢占邻近项触控；
   * 横向滚动容器必须设置 `padding: 8px 0` 防止裁剪纵向热区；换行容器 `flex-wrap: wrap` 必须设置 `row-gap: 16px` 防止上下热区重叠；
   * 横向滚动的胶囊行必须提供右缘渐隐 `mask-image`，提示内容可滚动。

### 3.5 固定栏取色同源：顶栏透明、底栏悬浮胶囊

顶栏与底部导航均取页面同源底色，底栏采用悬浮胶囊形态以保持通透：

* **分量同源**：页面底色必须同时提供 `--ios-bg`（hex）与 `--bg-rgb`（`R, G, B` 分量）；导航玻璃层（`--nav-glass-scrolled` / `--nav-scrolled-bg`）与底栏一律由 `rgba(var(--bg-rgb), α)` 或 `var(--bg-color)` 派生，严禁定义第二套独立导航取色。
* **顶栏静止态透明**：`background: transparent`，使页面 hero 光晕一直铺到状态栏；仅在 `.scrolled` 时升起毛玻璃底（`--nav-scrolled-bg`）。
* **底栏 = 悬浮胶囊 dock**：`left/right: 12px`、`bottom: calc(8px + env(safe-area-inset-bottom, 0px))`、`height: 62px`、`border-radius: 22px`、`padding: 4px 6px`；材质采用 `background: var(--nav-scrolled-bg)` + `backdrop-filter: blur(20px) saturate(180%)`（含 `-webkit-` 配对）；边界由 `border: 1px solid var(--surface-hairline)` + `box-shadow: var(--card-shadow)` 给出，**严禁画 `0 -1px 0` 顶边线**。
* **滚动智能收起**：页面顶部 48px 内始终显示胶囊；向下滚动超过 96px 后增加 `.scroll-hidden`（`translateY(calc(100% + 20px))` + `opacity: 0` + `pointer-events: none`）平滑下移，向上滚 6px 即恢复（带 6px 死区防抖）。收起时同步为 `nav` 附加 `inert` 属性，防止不可见时被键盘 Tab 聚焦。
* **保证底层通透**：页面底部保持 `104px` 内边距，允许卡片在滚动中从悬浮胶囊下方经过并被磨砂柔化。
* **禁止用 `!important` 压死阅读器覆盖**：夜间/护眼模式对底栏有更高特异性的主题覆写，底栏基础样式严禁加 `!important`。
* **深色投影仅滚动出现**：深色层下分界与投影仅写在 `.super-navbar.scrolled` 上，静止态保持零线零影。

### 3.6 长列表的密度、渲染与回顶

* **紧凑行（短碎片）**：纯文字且 ≤60 字的随手记采用紧凑密度（判定在 [`public/js/feeds.js`](../../public/js/feeds.js) 的 `shouldRenderCompactFeed`）；样式使用双类选择器 `.feed-item-card.feed-item-card--compact` 提高优先级；带图或外链卡片保持原密度展示。
* **屏外卡片跳过布局**：长列表卡片使用 `content-visibility: auto` + `contain-intrinsic-size: auto <真实高度>`（常规卡 `auto 150px`、紧凑卡 `auto 76px`）；周记多列画廊（`.notion-collection-card`）不加尺寸 containment。
* **自动续载保留手动兜底**：分页列表使用 `IntersectionObserver` 提前 600px 预取；当不支持该 API 时必须优雅退化为手动「加载更多」按钮。
* **回到顶部**：滚动超过 1.5 屏浮出 44pt 圆钮（`.back-to-top`），默认设置 `opacity: 0` 且 `visibility: hidden` 双重关闭；FAB 在场时追加 `.above-fab` 上移；圆心与 FAB 严格对齐竖轴（`right: 22px`）。
* **分页列表内跳转**：Cmd+K 跨页检索跳转时，先调用 [`public/js/feeds.js`](../../public/js/feeds.js) 的 `ensureItemRendered` 扩充窗口，再定位元素。

### 3.7 底栏选中态 = Apple「实心字形」(filled variant)

* **成对提供两组字形**：每个 Tab 均在 [`public/index.html`](../../public/index.html) 中提供描边字形 `svg.tab-svg-outline` 与实心字形 `svg.tab-svg-fill`（22×22 规格），由 `.active` 状态切换显隐，严禁使用整体图标缩放作为选中反馈。
* **禁止图标缩放动画**：按下反馈由 `.mobile-tab-item:active { transform: scale(0.95) !important }` 统一处理，严禁在图标上叠加 scale，避免双重动效。
* **选中色严禁加 `!important`**：保证夜间阅读器与护眼模式的主题覆盖正常生效。
* **深色主题选中色**：深色层显式指定 `:root[data-theme="dark"] .mobile-tab-item.active { color: var(--ios-blue-dark) }`（#0A84FF，对比度 5.18:1）。
* **无障碍状态同步**：底栏 `nav` 保持 `aria-label="主导航"`，选中项由 [`public/js/router.js`](../../public/js/router.js) 切换时同步更新 `aria-current="page"`。

### 3.8 无需登录的公开静态页（隐私政策 / 用户协议）

[`public/privacy.html`](../../public/privacy.html) 与 [`public/terms.html`](../../public/terms.html) 为免鉴权公开页：
* **完全自包含**：不引入外部样式与脚本，仅靠 `prefers-color-scheme` 适配深浅模式；
* **安全一致性**：无内联事件、无 `javascript:` 链接、外链一律标注 `target="_blank" rel="noopener"`；
* **双向连通**：两页互链且均具备返回首页导航；
* **内容详实**：如实交代数据存储机制、密钥加密标准与第三方集成清单。

### 3.9 对比度与键盘焦点 (WCAG 2.1 AA 门禁)

* **对比度标准**：正文文字对比度 ≥ 4.5:1，非文本 UI ≥ 3:1；二级文字使用 `rgba(var(--label-rgb), 0.75)`；底栏未选中 `--tab-inactive: #6E6E73`；主强调色 `--ios-blue: #0066CC`；危险色 `--danger-color: #D70015`。
* **深色层按需覆盖**：`--accent-text`、`--danger-fill`、`--focus-ring-color`、`--label-rgb` 必须在 `:root[data-theme="dark"]` 中显式重载。
* **键盘专属可见焦点**：全局重置 `:focus:not(:focus-visible)`，键盘焦点统一 `outline: 2px solid var(--focus-ring-color); outline-offset: 2px`，严禁裸写 `:focus { outline: none }` 剥夺键盘可访问性。

---

## 4. 设计令牌 (Design Tokens)

[`public/style.css`](../../public/style.css) 的 `:root` 是唯一令牌来源，新编写的样式必须优先引用设计变量：

| 类别 | 核心令牌 |
| :--- | :--- |
| **间距** | `--space-1` (4px) / `--space-2` (8px) / `--space-3` (12px) / `--space-4` (16px) / `--space-5` (24px) / `--space-6` (32px) |
| **圆角** | `--radius-sm` (10px) / `--radius-md` (14px) / `--radius-lg` (18px) / `--radius-pill` (999px) / `--surface-radius` (26px 主表面) |
| **动效** | `--dur-fast` (0.18s) / `--dur-base` (0.28s) / `--ease-spring` (`cubic-bezier(0.16, 1, 0.3, 1)`) |
| **颜色** | `--ios-blue` (#0066CC) / `--link-color` / `--ios-green` / `--ios-red` / `--ios-bg` / `--widget-bg` / `--callout-bg` / `--danger-color` / `--focus-ring-color` |
| **材质** | `--card-shadow` / `--card-hover-shadow` / `--surface-hairline` / `--heat-empty` / `--heat-1` ~ `--heat-4` |

### `!important` 与覆写层的削减纪律

* 削减 `!important` 必须使用 [`scripts/css-computed-audit.mjs`](../../scripts/css-computed-audit.mjs) 基于真浏览器 CDP 进行逐元素 computed style 比对；
* 批量调整后必须运行全矩阵上下文验证（不同视口、不同状态与亮暗主题），防止样式被底层规则隐蔽破坏；
* 动态渲染组件未在初始 DOM 中匹配时应保守保留，严禁盲目依据静态规则删除。

## 主题令牌纪律

`html[data-theme="light"|"dark"]` 是应用唯一的顶层主题开关（由 [`public/js/utils.js`](../../public/js/utils.js) 维护，在首帧前同步注入避免白屏闪烁）：

* **灰度一律使用 RGB 分量令牌**：文字与边框使用 `rgba(var(--label-rgb), α)`，中性背景使用 `rgba(var(--neutral-rgb), α)`；深色模式直接反转分量，alpha 语义保持不变；**严禁硬编码 `rgba(60, 60, 67, α)` 或 `rgba(120, 120, 128, α)`**。
* **五类主表面深色令牌覆盖**：导航底栏（`--nav-bg` / `--bg-rgb` / `--nav-scrolled-bg`）、卡片（`--card-bg` / `--ios-card-bg`）、文本（`--text-color` / `--ios-label` / `--ios-secondary-label`）、输入框（`--input-bg` / `--hairline`）、悬浮与分段（`--hover-bg` / `--segment-active-bg`）。
* **分段控件对比**：深色模式下选中胶囊 `--segment-active-bg` 必须亮于背景轨道。
* **深色错误提示**：深色层错误色使用 `--danger-color`（`#FF453A`）。
* **禁止硬编码 Tailwind 色阶**：严禁在样式表或模板中硬编码 `#0f172a`、`#1e293b` 等浅色固定灰阶；正文超链接统一使用 `--link-color`；严禁在 JS 模板中拼接内联颜色样式。
