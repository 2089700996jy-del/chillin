# UI 体验与 Apple HIG 视觉设计规范 (UI & Style Rule)

> 本规范约束前端页面的视觉系统、CSS 变量、Apple iOS HIG 触控反馈动效与无障碍交互体验。

---

## 1. 核心设计语言：Apple HIG 与 Inset Grouped 标准

1. **容器卡片 (Inset Grouped)**：
   * 所有卡片（周记、随手记、笔记、书签、提示词、阅读书架）统一遵循 iOS Inset Grouped 设计标准；
   * 圆角规范：主卡片统一使用 `border-radius: 16px ~ 18px`，微件与子元素使用 `10px ~ 12px`；
   * 边框与微光：浅色模式下统一搭配浅透微边框 `border: 1px solid rgba(0, 0, 0, 0.05 ~ 0.06)`，杜绝生硬粗黑边框；
   * 投影系统：使用柔和弥散阴影 `box-shadow: 0 4px 16px rgba(0, 0, 0, 0.03)`，悬停微升 `transform: translateY(-2px)`。

2. **Apple Spring 触感反馈微动效**：
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
   * 键盘焦点必须有可见样式（`:focus-visible` 已在样式末尾统一兜底，不要再新增 `outline: none`）。

---

## 4. 设计令牌 (Design Tokens)

`style.css` 的 `:root` 是唯一令牌来源，**新代码必须使用变量**，旧的散落字面量按模块逐步迁移：

| 类别 | 令牌 |
| :--- | :--- |
| 间距 | `--space-1` 4px / `--space-2` 8px / `--space-3` 12px / `--space-4` 16px / `--space-5` 24px / `--space-6` 32px |
| 圆角 | `--radius-sm` 10px / `--radius-md` 14px / `--radius-lg` 18px / `--radius-pill` 999px |
| 动效 | `--dur-fast` 0.18s / `--dur-base` 0.28s / `--ease-spring` `cubic-bezier(0.16, 1, 0.3, 1)` |
| 颜色 | `--ios-blue` / `--ios-green` / `--ios-red` / `--ios-bg` / `--widget-bg` / `--callout-bg` / `--danger-color` / `--focus-ring-color` |

> 现状债务：`style.css` 约 6000 行、仍有 545 处 `!important`（多为 v2.5.30 之后叠加的覆写层）。**禁止一次性大改**，请在本模块改动时顺手替换为令牌。
