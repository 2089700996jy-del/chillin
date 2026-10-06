---
name: apple-interaction-craft
description: Apple HIG 原生质感、iOS 触感反馈（Haptic API）、弹簧阻尼动效、软键盘智能躲避与 Cmd+K 命令面板微交互调优规范。在设计 UI 组件、打磨移动端手感、优化交互动效或编写 CSS 视觉样式时使用。
---

# 苹果级微交互与触感调优指南 (apple-interaction-craft)

> 本技能为 **Chillin 数字花园** 的前沿交互美学与手感调优手册，贯彻 **Apple iOS Human Interface Guidelines (HIG)**，专注于 **物理阻尼触感**、**Haptic 震动反馈**、**移动端软键盘躲避**、**毛玻璃材质 (Liquid Blur)** 与 **Cmd+K 现代命令面板**。

---

## 1. Apple 原生拟物触感反馈 (Haptic Feedback)

为重要的用户操作注入物理触感，利用 Web 原生 `navigator.vibrate` 实现无依赖轻量反馈：

```javascript
/**
 * iOS 拟物震动反馈统一封装 (不支持的环境静默忽略)
 */
export function triggerHaptic(type = 'light') {
    if (typeof navigator === 'undefined' || !navigator.vibrate) return;
    try {
        switch (type) {
            case 'light':     // 轻触点按、切换 Tab、选择项切换
                navigator.vibrate(10);
                break;
            case 'medium':    // 保存成功、复选框打勾、开关切换
                navigator.vibrate(20);
                break;
            case 'success':   // 同步完成、邮件直发成功
                navigator.vibrate([15, 40, 15]);
                break;
            case 'warning':   // 软删除、清空确认、危险操作提示
                navigator.vibrate([25, 50, 35]);
                break;
            case 'heavy':     // 核心长按弹出菜单 (ContextMenu)
                navigator.vibrate(40);
                break;
        }
    } catch {}
}
```

---

## 2. Apple Spring 弹簧阻尼与物理动效 (Spring Curves)

严禁使用线性（`linear`）或突兀的生硬过度，必须使用符合物理惯性的 Apple 贝塞尔曲线：

```css
:root {
    /* Apple HIG 标准弹簧回弹曲线 */
    --ease-ios-spring: cubic-bezier(0.32, 0.72, 0, 1);
    /* 弹性微张力曲线 (用于徽标、点赞或小卡片弹出) */
    --ease-ios-bounce: cubic-bezier(0.175, 0.885, 0.32, 1.275);
    /* 模态框收缩淡出 */
    --ease-ios-exit: cubic-bezier(0.4, 0, 1, 1);
}

/* 按钮点击按压微收缩 (Active Tap Feedback) */
.ios-clickable {
    transition: transform 0.15s var(--ease-ios-spring), opacity 0.15s ease;
}
.ios-clickable:active {
    transform: scale(0.97);
    opacity: 0.85;
}

/* 底部抽屉 (Bottom Sheet) 弹出动效 */
.sheet-modal {
    transition: transform 0.35s var(--ease-ios-spring), opacity 0.25s ease;
}
```

---

## 3. 移动端软键盘智能躲避 (Keyboard Avoidance)

在手机端打开 Bottom Sheet 或编辑随手记/周记时，软键盘弹起常会遮挡输入框或底部工具条：

### 3.1 Viewport 与 CSS 兜底方案
```css
/* 针对支持动态视口单位的现代移动浏览器 */
.sheet-container {
    max-height: 90dvh; /* 动态视口高度，键盘弹起时自动收缩 */
    padding-bottom: max(16px, env(safe-area-inset-bottom));
}
```

### 3.2 `visualViewport` 动态监听方案
```javascript
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        const currentSheet = document.querySelector('.bottom-sheet.is-open');
        if (!currentSheet) return;
        const offset = window.innerHeight - window.visualViewport.height;
        currentSheet.style.transform = offset > 0 
            ? `translateY(-${offset}px)` 
            : 'translateY(0)';
    });
}
```

---

## 4. 毛玻璃与系统材质 (System Materials & Glassmorphism)

遵循 iOS 动态材质，禁止纯黑色或单调背景：

```css
/* Apple 亚克力毛玻璃顶栏/导航栏 */
.ios-navbar-blur {
    background: rgba(255, 255, 255, 0.75);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    backdrop-filter: blur(20px) saturate(180%);
    border-bottom: 0.5px solid rgba(0, 0, 0, 0.08);
}

/* 深色模式下的超视网膜材质 */
@media (prefers-color-scheme: dark) {
    .ios-navbar-blur {
        background: rgba(28, 28, 30, 0.75);
        border-bottom: 0.5px solid rgba(255, 255, 255, 0.12);
    }
}
```

---

## 5. Cmd+K 现代命令面板标准交互

全局快捷搜索与指令面板 (`Cmd+K` / `Ctrl+K`) 需具备以下关键质感：
1. **关键词高亮 (`<mark>`)**：匹配到的搜索词加粗与背景柔和高亮；
2. **全键盘无缝漫游**：支持 `ArrowUp`、`ArrowDown` 焦点上下移动，`Enter` 立即执行，`Esc` 瞬间退回；
3. **指令与历史记忆**：优先展示快捷动作（“快速写随手记”、“立即同步数据”、“查看备份守卫”），下方展示最近编辑的记忆卡片。
