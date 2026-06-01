# 修复自定义鼠标光标四个问题

## 问题分析

| # | 问题 | 根因 |
|---|------|------|
| 1 | 跟随光环在鼠标右下角而非包裹白点 | JS `animate()` 中用 `transform: translate(x, y)` 覆盖了 CSS 中用于居中的 `transform: translate(-50%, -50%)`，元素左上角对齐光标而非中心对齐 |
| 2 | 跟随光环是彩色边框环，不是半透明灰圆 | CSS 定义为 `border: 2px solid var(--primary)`，不符合风格 |
| 3 | 点击涟漪不出现 | CSS 静态规则写了 `transform: translate(-50%, -50%) scale(0)`，动画只改变 `width/height/opacity` 但 **永远定格在 scale(0)**，视觉上毫无效果 |
| 4 | 鼠标在某些状态（提示/文字分割等）变回系统光标 | `html.custom-cursor-active *` 用 `cursor: url(...)` 覆盖全站，但浏览器在某些交互状态（如 textarea 边缘拖拽、某些伪类状态）有更高优先级的系统光标，CSS 无法完全覆盖 |

## 计划

### 核心策略变更

放弃与系统光标做 CSS 优先级斗争。改用 **隐藏原生光标 + div 模拟** 的方式：
- `html.custom-cursor-active` 设置 `cursor: none`（隐藏系统光标）
- `#cursor-follower` div 作为唯一的视觉光标（始终跟随）

### 文件改动

#### 1. `src/styles/custom-cursor.css` — 重写

**变更点：**

- **删除** 全局 SVG data URI cursor 规则（第 7-16 行）
- **删除** 可交互元素的 cursor 覆盖规则（第 18-30 行，不再需要）
- **替换为** `html.custom-cursor-active { cursor: none }` — 彻底隐藏系统光标
- **重写** `#cursor-follower` 样式：从边框环改为 `background: rgba(128,128,128,0.25)` 半透明灰圆，尺寸为 `16px × 16px` 包裹 10px 白点设计
- **修复** `.cursor-ripple`：去掉 `scale(0)`，改为 `scale(1)`，动画用 `transform: scale(4)` 实现扩散
- **保留** `@media (max-width: 1023px)` — 移动端恢复 `cursor: auto` 且隐藏 follower
- 新增 `#cursor-follower.is-hovering` 放大效果（可选保留）

#### 2. `src/components/features/CustomCursor.astro` — 修复 JS

**变更点（`animate()` 函数内）：**

- **修复前**：`follower.style.transform = \`translate(${currentX}px, ${currentY}px)\`;`
- **修复后**：
  ```js
  follower.style.left = currentX + 'px';
  follower.style.top = currentY + 'px';
  ```
  让 JS 只设置 `left/top`，CSS 中的 `transform: translate(-50%, -50%)` 负责居中，不再冲突。

**点击涟漪函数无需修改**，CSS 修复后即可生效。

**其余逻辑**（activate/deactivate/resize/reinit）完全保持不变。

### 验证

1. `pnpm run build` 零错误
2. 桌面端打开页面，原生鼠标箭头消失，跟随灰圆始终在鼠标热点位置
3. 移动光标过链接/按钮，灰圆可放大（可选）
4. 点击任意位置，看到灰色涟漪扩散并消失
5. 移动端（< 1024px）恢复系统光标
