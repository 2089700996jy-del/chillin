---
name: konsta-ios-ui
description: Pixel-perfect Apple iOS HIG mobile UI design guidelines, styles, and component patterns inspired by Konsta UI. Use whenever designing, refactoring, or polishing iOS-style mobile web UI, segmented controls, cards, searchbars, chips, sheet modals, and typography.
---

# Konsta iOS Mobile UI Design Skill

This skill provides comprehensive specifications, CSS design tokens, component patterns, and micro-interaction guidelines derived from **Konsta UI** (pixel-perfect iOS mobile UI system) and Apple's **Human Interface Guidelines (HIG)**.

---

## 1. Core iOS HIG Design Principles (Konsta UI Standard)

1. **Clarity & Depth**:
   - Flat surfaces elevated with subtle 1px translucent borders (`rgba(0, 0, 0, 0.06)` in Light, `rgba(255, 255, 255, 0.1)` in Dark) and soft diffuse shadows (`box-shadow: 0 4px 16px rgba(0, 0, 0, 0.04)`).
   - Glassmorphism & Translucency: `backdrop-filter: blur(20px) saturate(180%)` for navbars, toolbars, and sheets.
2. **Ergonomic Touch Targets**:
   - Minimum 44px height/touch area for interactive primary elements (`h-11` in Konsta).
   - Micro-haptic tactile press: `active:scale-[0.97]` and `active:opacity-80` with spring-like timing `cubic-bezier(0.16, 1, 0.3, 1)`.
3. **Typography**:
   - Font stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "PingFang SC", sans-serif`.
   - Title 1: 28px/34px bold; Title 2: 22px/28px bold; Headline: 17px semi-bold; Body: 15-16px regular; Subhead/Footnote: 12-13px regular.

---

## 2. Standard Konsta iOS Component Specifications

### A. Segmented Control (分段选择器)
```css
/* Container: iOS Groupped Trough */
.k-segmented {
  display: flex;
  align-items: center;
  position: relative;
  background: rgba(120, 120, 128, 0.12);
  padding: 2px;
  border-radius: 12px;
  user-select: none;
  width: 100%;
}

/* Segment Button */
.k-segment-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px 12px;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 500;
  color: rgba(60, 60, 67, 0.7);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  text-align: center;
  white-space: nowrap;
}

/* Active Highlight Pill (Simulating Konsta's sliding card) */
.k-segment-btn.active {
  background: #ffffff;
  color: #000000;
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12), 0 0.5px 1.5px rgba(0, 0, 0, 0.08);
}
```

### B. iOS Searchbar (搜索输入栏)
```css
.k-searchbar-inner {
  position: relative;
  display: flex;
  align-items: center;
  background: rgba(118, 118, 128, 0.12);
  border-radius: 10px;
  height: 38px;
  padding: 0 10px;
  transition: all 0.2s ease;
}

.k-searchbar-inner:focus-within {
  background: rgba(118, 118, 128, 0.16);
  box-shadow: 0 0 0 2.5px rgba(0, 122, 255, 0.2);
}

.k-searchbar-input {
  flex: 1;
  border: none;
  background: transparent;
  font-size: 15px;
  padding-left: 8px;
  outline: none;
  color: inherit;
}
```

### C. Chips / Filter Pills (横向滑动筛选胶囊)
```css
/* Scroll Row with Fade Edge */
.k-chips-scroll {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  white-space: nowrap;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  padding: 2px 0;
  mask-image: linear-gradient(to right, black calc(100% - 24px), transparent 100%);
}

.k-chip {
  height: 28px;
  padding: 0 12px;
  border-radius: 9999px;
  font-size: 12.5px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  background: rgba(120, 120, 128, 0.1);
  color: rgba(60, 60, 67, 0.75);
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}

.k-chip.active {
  background: #007AFF;
  color: #ffffff;
  font-weight: 600;
  box-shadow: 0 2px 6px rgba(0, 122, 255, 0.3);
}
```

### D. Inset Grouped Card (iOS 16/17 卡片规范)
```css
.k-card-ios {
  background: #ffffff;
  border-radius: 16px;
  padding: 16px;
  border: 1px solid rgba(0, 0, 0, 0.05);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.02);
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease;
}

.k-card-ios:active {
  transform: scale(0.985);
}
```

### E. Sheet Modal / Bottom Sheet (抽屉弹窗)
```css
.k-sheet-modal {
  position: fixed;
  left: 0;
  bottom: 0;
  width: 100%;
  max-height: 88vh;
  background: #ffffff;
  border-radius: 20px 20px 0 0;
  box-shadow: 0 -10px 40px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  transform: translateY(100%);
  transition: transform 0.35s cubic-bezier(0.32, 0.72, 0, 1);
  z-index: 9999;
}

.k-sheet-modal.show {
  transform: translateY(0);
}

.k-sheet-pull-handle {
  width: 36px;
  height: 4.5px;
  background: rgba(60, 60, 67, 0.3);
  border-radius: 999px;
  margin: 8px auto 4px auto;
}
```

---

## 3. Applying Konsta UI Patterns to Existing Projects

When refactoring or styling components:
1. Always replace raw browser popups (`prompt()`, `alert()`) with inline chip helpers or Bottom Sheets.
2. Ensure segmented controls and primary action buttons have generous touch areas with `active:scale(0.97)` micro-press feedback.
3. Use variable highlighting (`<mark class="k-var-tag">`) for templated text.
4. Support full dark mode parity (`#1C1C1E` surfaces, `#0A84FF` active tints, `rgba(255,255,255,0.1)` dividers).
