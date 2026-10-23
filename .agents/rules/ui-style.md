# UI 体验与 Apple HIG 视觉设计规范 (UI & Style Rule)

> 本规范约束前端页面的视觉系统、CSS 变量、Apple iOS HIG 触控反馈动效与无障碍交互体验。

---

## 1. 核心设计语言：Apple HIG 与 Inset Grouped 标准

1. **容器卡片 (Inset Grouped)**：
   * 所有卡片（周记、随手记、笔记、书签、提示词、阅读书架）统一遵循 iOS Inset Grouped 设计标准；
   * 圆角规范：主表面统一使用 `var(--surface-radius)`（26px），微件与子元素使用 `10px ~ 12px`，胶囊一律 `var(--radius-pill)`；
   * 边框与层次：主表面**不画可见硬边框**（`border: 1px solid transparent` 只为保留布局位与深色覆写位），改用 `var(--card-shadow)` 两层柔和弥散阴影分层；确需极细分隔时用 `--surface-hairline`；
   * 投影系统：`--card-shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 10px 28px rgba(16, 24, 40, 0.05)`，悬停升为 `--card-hover-shadow` 并微升 `transform: translateY(-2px)`；
   * 强调色纪律：全站**唯一强调色**是 `--ios-blue`（`#007AFF`，对齐 iOS 系统蓝），不得再引入第二个蓝；状态绿与热力图色阶一律走令牌（`--heat-empty` / `--heat-1` ~ `--heat-4`）；
   * 留白与字号节奏：移动端主容器内边距 `72px 18px 104px`、卡片垂直间距 ≥ 20px、`.page-title` 40px 且 `letter-spacing: -0.9px`；**层次靠间距与阴影，不靠分隔线**（底栏顶边线也一律取消，改用柔和上投影）；
   * 首屏柔光：亮色主题 `body` 顶部铺两枚低透明度 `radial-gradient`（`--ios-blue` 与 systemGreen）作 hero 光晕，卡片保持纯白浮在其上；深色与护眼主题必须显式 `background-image: none`（深底上会发脏蓝，由 `tests/css.test.mjs` 看住）。

3. **模糊层 (backdrop-filter) 与层级纪律**：
   * `backdrop-filter` 只允许「浮在内容之上」的表面使用：顶部导航 `.super-navbar`、阅读器底栏 `.reader-nav-bottom`、弹层遮罩 `.modal-overlay` / `.confirm-dialog-overlay` / `.wikilink-autocomplete-popup`、压在图片上的悬浮图标按钮；总数由 `tests/css.test.mjs` 的棘轮看住（基线 41 条声明，含 `-webkit-` 配对）；
   * 判断标准是**背后有没有可模糊的内容**：父级不透明（如 `#FFFFFF` 卡片里的 `.search-input`）或背板只是纯色加平缓渐变（如 `.note-annotations-section` 之后的 `body`）时，模糊是零收益的合成层，应删除；固定栏上的模糊是**肉眼可见**的（0.88 alpha 下高对比条纹仍会透出，可用 `backups/_blur_on.html` 这类条纹页截图复验），必须保留；
   * 顶层层级一律走 `:root` 的 `--z-nav` / `--z-modal` / `--z-toast` / `--z-auth` / `--z-alert` 令牌，禁止裸 `z-index`（否则「关闭按钮盖住确认弹窗」这类顺序错误会重现）；
   * 过渡只允许显式属性列表，禁止 `transition: all`（会连带 `width`/`height` 触发布局重排）。

4. **Apple Spring 触感反馈微动效**：
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
   * 当用户按下 `Cmd+K` / `Ctrl+K` 且搜索框为空时，必须优先呈现高频动作指令（呼叫 AI、写随手记、记笔记、写周记、新建提示词、云同步）；
   * 支持前缀输入 `>` 过滤纯指令动作。
2. **关键词命中高亮 (`<mark>`)**：
   * 搜索命中的标题与正文摘要必须经过 `highlightMatches` 进行关键词高亮包裹：`<mark class="search-highlight">关键词</mark>`；
   * 必须严格经过 `escapeHtml` 字符转义，防御恶意 XSS 注入。
3. **全键盘无障碍导航 (Keyboard Accessibility)**：
   * 必须监听 `ArrowDown` 与 `ArrowUp` 键，实现选中焦点的平滑循环位移；
   * 选中项赋予 `.active-selection`（带 iOS 蓝条指示与位移动效），自动跟随视口滚动；
   * 监听 `Enter` 键直接执行选中指令或跳转直达目标卡片。

---

## 3. 移动端细节打磨 (Mobile First)

1. **软键盘智能躲避 (Virtual Keyboard Avoidance)**：
   * 监听页面任何输入框获焦事件，自动为 `document.body` 附加 `.keyboard-open` 类名；
   * 键盘弹起时，底部导航栏（`.mobile-bottom-nav`）与右下角悬浮按钮（`.fab-btn`）必须平滑淡出隐藏，避免遮挡正文输入视线。
2. **外链图片防崩兜底与懒加载**：
   * 全局所有动态渲染的图片（周记封面、烟火日常拍立得、随手记媒体预览）必须标注 `loading="lazy"` 与 `decoding="async"`；
   * 图片失败兜底由 `app.js` 的**捕获阶段代理**统一处理（`error` 事件不冒泡）：自动追加 `img-load-failed` / `is-fallback`，并按 `data-img-hide-on-error="hide|remove"` 决定隐藏或移除；**严禁再写内联 `onerror`**（CSP 已禁用内联处理器）。
3. **无障碍 (Accessibility) 底线**：
   * 弹层必须通过 `.modal-overlay.show` 触发，`app.js` 会自动补 `role="dialog"` / `aria-modal`、圈定 Tab 焦点、Esc 关闭并归还焦点；
   * 禁止使用原生 `confirm()` / `alert()`，一律改用 `utils.confirmDialog()` 与 `showToast()`；
   * 键盘焦点必须有可见样式（`:focus-visible` 已在样式末尾统一兜底，不要再新增 `outline: none`）；
   * **禁止直接写 `el.innerHTML`**：一律使用 [`public/js/trusted-types.js`](../../public/js/trusted-types.js) 的 `setHtml(el, html)`，测试会拦截任何绕过（Trusted Types 策略为 `chillin#html`）。
4. **触控热区 (Touch Target) 44pt 底线**：
   * 任何可点击元素的**实际可点区域**不得小于 44×44pt（Apple HIG 与 Konsta `h-11` 标准）；
   * **热区 ≠ 视觉尺寸**：紧凑胶囊（`.btn-chip` / `.k-mood-chip` / `.prompt-chip` 等）视觉保持 `28px` 本身就是 Konsta 规范，热区必须另用 `::after` 撑到 44px：

     ```css
     .btn-chip,
     .k-mood-chip {
       height: 28px;          /* 视觉：Konsta 标准，不要为了热区把它改成 44px */
       position: relative;    /* 热区锚点 */
     }

     .btn-chip::after,
     .k-mood-chip::after {
       content: '';
       position: absolute;
       left: 0;
       right: 0;              /* 严禁横向外扩 */
       top: -8px;
       bottom: -8px;          /* 28 + 8 + 8 = 44px */
     }
     ```

   * **热区严禁横向外扩**（必须 `left: 0; right: 0`）：同行 `gap` 通常只有 6~8px，横向一撑就会抢走邻居的点击；
   * 纵向热区必须有容器空间，**两个真实踩过的坑**：`overflow-x: auto` 会连带裁剪纵向溢出，横向滚动行必须补 `padding: 8px 0`；`flex-wrap: wrap` 的容器必须把 `row-gap` 提到 `16px`，否则换行后上下两行热区重叠（320px 窄屏实测会换行）；
   * 横向滚动的胶囊行必须补右缘渐隐 `mask-image`，否则被裁切的末位胶囊会让用户完全不知道它存在。

---

## 4. 设计令牌 (Design Tokens)

`public/style.css` 的 `:root` 是唯一令牌来源，**新代码必须使用变量**，旧的散落字面量按模块逐步迁移：

| 类别 | 令牌 |
| :--- | :--- |
| 间距 | `--space-1` 4px / `--space-2` 8px / `--space-3` 12px / `--space-4` 16px / `--space-5` 24px / `--space-6` 32px |
| 圆角 | `--radius-sm` 10px / `--radius-md` 14px / `--radius-lg` 18px / `--radius-pill` 999px / `--surface-radius` 26px（主表面） |
| 动效 | `--dur-fast` 0.18s / `--dur-base` 0.28s / `--ease-spring` `cubic-bezier(0.16, 1, 0.3, 1)` |
| 颜色 | `--ios-blue`（唯一强调色 #007AFF） / `--link-color`（正文链接，深色切 `#0A84FF`） / `--ios-green` / `--ios-red` / `--ios-bg` / `--widget-bg` / `--callout-bg` / `--danger-color` / `--focus-ring-color` |
| 材质 | `--card-shadow` / `--card-hover-shadow` / `--surface-hairline` / `--heat-empty` / `--heat-1` ~ `--heat-4` |

> 现状债务：`public/style.css` 9902 行、230 处 `!important`（v2.5.144 用真浏览器 computed style 审计器逐条验证后删掉 66 处，方法见下）、41 条 `backdrop-filter` 声明、126 个裸 hex 与 847 处 `rgb()/rgba()` 字面量（v2.5.144 令牌化批次把裸 hex 从 501 降到 126；v2.5.119 已把 131 处灰度收敛为分量令牌，v2.5.120 又清掉 9 处写死的 Tailwind slate 灰）待迁移到令牌。**禁止一次性大改**，请在本模块改动时顺手替换为令牌。

### `!important` 与覆写层的削减纪律（v2.5.144 起）

`!important` 只能靠「真浏览器逐元素 computed style 对比」证明安全后才允许删。工具是 [`scripts/css-computed-audit.mjs`](../../scripts/css-computed-audit.mjs)（CDP 驱动：以线上 `style.css` 为基线，把候选 CSS 注入同一级联位置后比对 `body *` 的 615 项 computed style、全部令牌与元素矩形）。

- **单条安全 ≠ 批量安全**：两条 `!important` 写同一个元素的同一个属性时会互相遮罩——单独删任何一条都测不出差异，一起删就会让下层旧值浮上来。所以逐条扫描只用来筛候选，**批量删除后必须把整份文件再跑一遍全矩阵（182 上下文：7 视口/媒体 × 13 状态 × 亮暗）验收**；v2.5.144 正是靠这一步才发现 90 个上下文回归（`.super-navbar` 底边、`.confirm-dialog-overlay`/`-card`/`-cancel`），据此回补了 12 条。
- **回补判据**：某元素出现差异，就恢复「所有匹配该元素且已删的 `!important`」——只要不再有已删声明命中该元素，它的层叠结果就与基线恒等。
- **已知覆盖上限**：审计只覆盖静态 DOM。JS 动态渲染的内容（笔记列表、阅读器正文、AI 会话气泡）不在初始 DOM 里，选择器从未匹配的候选一律**保留**，不得凭静态分析删除。

## 主题令牌纪律（v2.5.119 起）

`html[data-theme="light"|"dark"]` 是**唯一**的应用级主题开关（`public/js/utils.js` 的 `applyAppTheme()` 写属性、`initAppTheme()` 跟随系统；`public/index.html` head 里的内联脚本在首帧之前落属性，避免深色用户先看到一帧白屏）。`prefers-color-scheme` 只允许出现在 `auto` 模式的判定分支里，**不得**再写 `@media (prefers-color-scheme: dark)` 覆盖规则。

- **灰度一律走 RGB 分量令牌**：文字与细边框用 `rgba(var(--label-rgb), α)`，中性表面用 `rgba(var(--neutral-rgb), α)`。亮色基线 `--label-rgb: 60, 60, 67`、`--neutral-rgb: 120, 120, 128`；深色层只反转分量（`235, 235, 245` / `255, 255, 255`），alpha 语义不变。这样 131 处灰度自动跟随主题，不必逐条写深色覆盖。**禁止**再写回 `rgba(60, 60, 67, α)` / `rgba(120, 120, 128, α)`（`tests/css.test.mjs` 有门禁）。
- **五类主表面在深色层必须有令牌**：导航与底栏（`--nav-bg` / `--nav-glass` / `--nav-glass-scrolled` / `--nav-scrolled-bg`）、卡片（`--card-bg` / `--ios-card-bg`）、文字（`--text-color` / `--ios-label` / `--ios-secondary-label`）、输入框（`--input-bg` / `--input-bg-focus` / `--hairline`）、悬浮与选中（`--hover-bg` / `--segment-active-bg`）。
- **分段控件的选中胶囊必须比轨道更亮**：深色下 `--segment-active-bg: rgba(255, 255, 255, 0.16)`，轨道是半透明白。曾出现「选中的比未选中的更暗」的实现缺陷。
- **深色红色用 `--danger-color`**（深色层切到 `#FF453A`），不要再写 `#ff3b30` 字面量。
- **禁止写死 Tailwind 色阶**：`#0f172a` / `#1e293b` / `#334155` / `#475569` / `#64748b` / `#94a3b8` 都是浅色专用灰，不跟随 `data-theme` 反转（v2.5.120 修掉的 `.rich-link-title` 就曾在深色卡片上隐形）。正文链接统一走 `--link-color`（亮 `var(--ios-blue)` / 深 `#0A84FF`）；**不要在 JS 模板里拼内联 `style="color:#007AFF"`**——内联样式优先于样式表，深色层覆盖不掉（`tests/css.test.mjs` 对以上两者都有门禁）。
- **验证方法**：改动后必须用真浏览器读 `getComputedStyle` 逐元素核对（不要只看截图——归一化后的截图会让白字看起来发暗），并对浅色主题做逐像素 diff（`maxDiff` 必须为 0）证明零回归；`backups/` 里有采集页与 `_pngdiff.mjs` 可直接复用。
