# M1 · 布局骨架 —— 执行规格书

> 版本：2026-09-21 · 状态：待执行
> 验收依据：[acceptance-criteria.md](./acceptance-criteria.md) 第三章 M1 小节（12 条）+ 第二章 G1~G8
> 尺寸来源：[`src/lib/layout.ts`](../packages/ui/src/lib/layout.ts)（**唯一数值来源，禁止硬编码数字**）
> 颜色来源：[`src/styles/tokens.css`](../packages/ui/src/styles/tokens.css)（**唯一颜色来源**）

---

## 一、任务清单（严格按序）

| # | 任务 | 产出文件 | 验收项 |
|---|---|---|---|
| 1.1 | `WindowShell`：接受 `os` prop，三端外壳骨架 | `components/shell/WindowShell.tsx` | 1-1 |
| 1.2 | `TitleBar`：窗口控件 + 收起左/右 + 主题切换 + 设置 | `components/shell/TitleBar.tsx` | 1-9 |
| 1.3 | `Sidebar`：新建任务 → 搜索 → 历史会话 → 工作目录 | `components/shell/Sidebar.tsx` | 1-6 / 1-7 / 1-8 |
| 1.4 | `SidebarFooter`：**通底贴边**条带 | `components/shell/SidebarFooter.tsx` | **1-3** / 1-4 / 1-5 |
| 1.5 | 折叠逻辑 + 180ms 过渡 + 持久化 | 扩展 `store/ui-store.ts` | 1-9~1-12 |
| 1.6 | 屏幕路由与切换入口 | 改写 `App.tsx` | 1-1 |

`PreviewPane` 本阶段只放**占位容器**（保证 1-1 三栏成立），M3 才填内容。

---

## 二、目标结构

```
WindowShell (os="mac"|"win"|"linux")
├── TitleBar                     高 36（TITLE_BAR_HEIGHT）
│   ├── 左：窗口控件（close/min/max，仅 mac 显示于左侧）
│   ├── 左：收起左侧按钮 ⚠ 插在窗口控件之后
│   ├── 中：会话标题（弹性，truncate）
│   └── 右：主题切换 → 设置 → 收起右侧按钮 ⚠ 追加到最右
├── 主区 (flex-1, flex-row)
│   ├── Sidebar                  宽 264（SIDEBAR_WIDTH），可折叠
│   │   ├── 侧边栏内容（vertical, pad 12, gap 10, flex-1, min-h-0）
│   │   │   ├── 新建任务
│   │   │   ├── 搜索
│   │   │   ├── 历史会话（无分组标题）
│   │   │   └── 工作目录
│   │   └── SidebarFooter        高 36，★ 必须在内容包装器之外 ★
│   ├── 内容区 (flex-1, min-w-0)  本阶段占位
│   └── PreviewPane              宽 480（PREVIEW_PANE_WIDTH），可折叠，本阶段占位
```

---

## 三、★ 三个最容易做错的点（务必逐条确认）

### 3.1 底部条带通底（验收 1-3，M1 头号坑）

**错误做法**：把条带直接放进带 `padding: 12px` 的侧边栏里 → 左右和底部各残留 12px 间隙。

**正确做法**：在侧边栏内建一层「侧边栏内容」包装容器承载那 12px padding，条带作为侧边栏的**兄弟节点**放在包装器之外：

```
Sidebar (padding: 0, gap: 0, flex-col)
├── div.侧边栏内容 (padding: 12px, gap: 10px, flex: 1, min-height: 0, overflow-y: auto)
│   └── …菜单项…
└── SidebarFooter (height: 36, width: 100%, shrink-0)   ← 无 padding，无 margin
```

**判定**：条带左右边缘与侧边栏左右边界重合、底边与窗口底重合，`offsetLeft` 与 `offsetBottom` 差值 ≤ 0。

> 设计稿改到**第 11 轮**才把这一项定稿（见 memory `2026-09-21.md` 第 11 轮），别凭直觉写。

### 3.2 条带无圆角无缝隙（验收 1-5）

条带内部是「模型 / 设置」两半，各占半宽：
- 外层容器：`border-radius: 0`、`gap: 0`、`padding: 0`
- 两半之间无分隔线、无间隙
- 「设置」那半的背景色设为与其父容器**相同**的变量（`bg-bg-subtle`），视觉上等于透明

> 踩坑记录：清空填充不要在代码里试 `fills: []`（那是设计稿侧的经验），代码里直接给同色变量最稳。

### 3.3 折叠无跳动（验收 1-10）

**错误做法**：`display: none` 切换 → 宽度过渡直接断掉，内容区瞬间重排。

**正确做法**：
- 宽度过渡：`transition-[width] duration-[180ms]`
- 折叠到 0 宽：`overflow: hidden`，配 `COLLAPSED_WIDTH`
- 内容区加 `min-width: 0`，否则 flex 子项不会正确收缩，会出现横向滚动条（同时会挂掉 1-12）
- 折叠时给侧边栏内层内容加 `whitespace-nowrap`，避免宽度收缩过程中文字反复折行造成视觉抖动

### 3.4 折到 0 宽要「严格 0」（验收 1-13）

**症状**：折叠后 `getBoundingClientRect().width` 是 `1` 而非 `0`，内容区只有 `1422` 而非 `1424`。

**根因（实测确认，别再猜）**：侧边栏有 `border-right: 1px`，而在 `box-sizing: border-box` 下
**边框盒不可能窄于边框自身**。实测把内联 `width` 依次设为 `0` / `0.5` / `1` / `2` / `10px`，
`rect` 宽度**恒为 `1px`** —— 这就是那条硬下限。

**`min-w-0` 解决不了这个问题**（这是个容易走错的弯路）：
`min-width` 管的是「收缩下限」，管不了边框的物理宽度。给侧边栏、三栏容器都加 `min-w-0` 后
实测仍然卡在 `1px`，四层容器全部 `min-width: 0px` 也没用。

**修法：把分隔线从 `border` 换成绝对定位伪元素**（`globals.css` 里的 `divider-r` / `divider-l`）。
伪元素脱离常规流，**不占任何布局宽度**，父元素才能真的收到 0。实测折叠后 `sidebar = 0`、
`workspace = 944`、两栏全收时 `workspace = 1424`，条带宽度也从 `263` 修正为 `264`。

**附带好处**：因为没有 `border-width` 了，也就不需要在折叠时改它的值 ——
「折叠时把 border 改成 0」那种写法会在过渡收尾闪一下边框，这个副作用自然消失。
所以**不要**退回 `border` + 折叠时改 `border-width` 的写法。

### 3.5 `prefers-reduced-motion` 的正确处理（易踩）

**不要**写 `motion-reduce:transition-none`。它生成
`@media (prefers-reduced-motion: reduce) { transition-property: none }`，会把过渡**整个取消**，
折叠退化成瞬间跳变，**直接违反验收 1-10 与 G8**。而且 headless Chrome 默认就是 `reduce`，
一跑验收就挂，报错还看不出原因。

**也不要**因此就删掉 reduced-motion 适配 —— 开启该偏好的用户是真实存在的。

**正确做法：缩短时长，而非取消过渡。** 用 `lib/use-prefers-reduced-motion.ts` 侦测偏好，
正常用 `COLLAPSE_DURATION`（180ms），reduced-motion 下用 `COLLAPSE_DURATION_REDUCED`（**90ms**）。
验收要的「非瞬间跳变」保住，用户偏好也被尊重 —— **两个目标不冲突，不要做成二选一**。

⚠️ **缩短幅度别过头**：初版取过 `1ms`，实测 rAF 采样中间帧数 = `0`
（`264 → 1` 直接跳），等价于瞬间跳变，1-10 照样挂 —— 那只是把「取消过渡」换成了「快到看不见」。
取 `90ms`（正常时长的一半）实测可采到 4 个中间帧，序列为
`264 → 138.7 → 72.36 → 32.48 → 10.2 → 0.77 → 0`，过渡真实可见。


---

## 四、必须遵守的硬约束

### 4.1 颜色（G1 / G2 / G5 —— 违反即 Blocker）

- **禁止**任何 `#hex`、`rgb()`、`hsl()` 字面量。所有颜色走 `tokens.css` 的语义令牌，class 形如 `bg-bg-subtle` / `text-text-secondary` / `border-border-subtle`
- **禁止** `dark:` 变体。深色靠令牌自动派生，写 `dark:` 说明令牌没抽对
- **禁止** Tailwind 内置调色板（`bg-gray-100` / `text-black` / `bg-white` / `text-slate-*` 等）
- 图标颜色用 `--icon-neutral`（`text-icon-neutral`），该值**深浅两模式下都是 `#8A919E`**，是刻意的固定色，唯一允许的例外

**自检命令**（在 `packages/ui` 下）：
- 搜 `#([0-9a-fA-F]{3,8})\b` → 预期**仅** `src/styles/tokens.css` 命中
- 搜 `dark:` → 预期 0 命中（`TokensScreen.tsx` 里有个局部变量名含 `dark:`，那不是 Tailwind 变体，可忽略）
- 搜 `bg-gray-` / `text-black` / `bg-white` / `text-gray-` → 预期 0 命中

### 4.2 尺寸

- 一律从 `@/lib/layout.ts` 导入常量（`SIDEBAR_WIDTH` / `TITLE_BAR_HEIGHT` / `COLLAPSE_DURATION` 等）
- **禁止**在组件里直接写 `264` / `36` / `180` 这类魔数
- 需要新尺寸时，先加进 `layout.ts`，再引用

### 4.3 无障碍（G7）

- 所有图标按钮必须传 `label`（`IconButton` 的必填 prop，会转成 `aria-label` + `title`）
- 可切换状态的按钮传 `active`（转成 `aria-pressed`）
- 焦点环已全局定义（`globals.css` 的 `:focus-visible`），**不要**用 `outline: none` 覆盖
- 键盘 Tab 能走通，Enter / Space 能触发

### 4.4 其他

- 组件用 `forwardRef` 暴露 ref（沿用现有 `Button` / `IconButton` / `Chip` 的写法）
- `className` 透传 + `cn()` 合并，允许调用方覆盖样式
- 不引入新的第三方依赖（Radix 等到 M2 真正需要时再加）；`Segmented` / `Tabs` 本阶段手写即可
- 注释用中文，风格与现有文件保持一致

---

## 五、可直接复用的 M0 资产

| 资产 | 位置 | 用途 |
|---|---|---|
| `Button` / `IconButton` / `Chip` | `components/primitives/` | 标题栏按钮、菜单项、条带按钮 |
| `Icon` + `LucideIcon` | `components/common/icons.tsx` | 统一图标出口，`ICON_COLOR_CLASS` / `ICON_SIZE` |
| `cn()` | `lib/cn.ts` | className 合并 |
| `useUiStore` | `store/ui-store.ts` | 主题状态；**折叠状态扩展到同一 store** |
| `initTheme()` | `store/ui-store.ts` | 已有持久化模式，折叠状态照抄这个写法 |

**所需图标已在清单内，无需新增**：`Plus` / `Search` / `History` / `FolderOpen` / `PanelLeftClose` / `PanelRightClose` / `Settings` / `Cpu` / `Sun` / `Moon`。

---

## 六、明令禁止

1. **不要**实现 M2 的消息流、Composer、工具条、TokenStats —— 本阶段内容区是占位
2. **不要**实现 M3 的预览区双 Tab —— 本阶段 PreviewPane 是占位容器
3. **不要**改动 `tokens.css` 的色值（已做过对比度校准，8 个浅色 + 1 个深色值为定稿）
4. **不要**把 8 屏都做出来 —— 本阶段只需 Shell + 01 屏骨架 + `/tokens` 路由仍可用
5. **不要**写 `dark:` 变体或硬编码色值去"快速修一下"深色问题
6. **不要**用 `display: none` 做折叠
7. **不要**写 `motion-reduce:transition-none` —— 它会把过渡整个取消，反而违反 1-10/G8。
   reduced-motion 要适配，但方式是**缩短时长**（见 3.5），且别缩到 `1ms` 那种看不见的程度
8. **不要**给可折叠的侧边栏 / 预览区用 `border-r` / `border-l` 画分隔线 ——
   border 在 border-box 下最窄就是 1px，折叠后必然卡在 1px（验收 1-13 挂）。
   用 `divider-r` / `divider-l`（绝对定位伪元素）。同理**不要**用「折叠时改 `border-width`」绕过（见 3.4）

---

## 七、完成后必须交付

### 7.1 产出 `progress-M1.md`

仿照 [`progress-M0.md`](./progress-M0.md) 的格式，放 `.plan/` 下，必须包含：

1. **逐任务状态表**（1.1~1.6 六行 + 状态）
2. **12 条验收逐项核对表** —— 每条必须给**实测证据**，不接受"应该正确"
   - 数值类（1-2 / 1-4 / 1-8）：给出 DevTools 量到的实际数值
   - 判定类（1-3 / 1-5 / 1-10）：说明用什么方法验证的，附观察结果
   - 交互类（1-9 / 1-11 / 1-12）：说明操作步骤与实际结果
3. **G1~G8 结果表**
4. **本轮修复记录**（发现的缺陷 + 根因 + 修法）
5. **M2 待办**

> ⚠️ M0 的教训：上一轮就是在"实现已完成、验收未跑完"处被打断，导致一度不知道做到哪。
> **验收必须真跑，不能在文档里写"预计通过"。**

### 7.2 环境注意事项

- 本机 **bash 缺 `tail` / `dirname` / `ls` 等命令**，不要用 `| tail` 这类管道
- 调用 node 用**正斜杠 Windows 路径**：`"C:/Users/myliu/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"`，不要用 `/c/...`（会被 Git Bash 改写）
- 类型检查：`cd packages/ui && "C:/.../node.exe" node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json`
- 构建：`cd packages/ui && "C:/.../node.exe" node_modules/vite/bin/vite.js build`
- 包管理器 **npm**（已锁 `packageManager: npm@10.9.7`），不要用 pnpm

### 7.3 完成判据

- `tsc --noEmit` → EXIT=0
- `vite build` → EXIT=0
- G1 / G2 / G5 全部通过
- 12 条验收全部有实测证据
- `progress-M1.md` 已产出

---

## 八、交接备注

- 这是**纯前端原型**阶段：不接 Pi、不接 LLM、不接后端、不做 Electron 壳
- 当前只有 `packages/ui` 一个包，**暂不搭 monorepo**（接入 Pi 时再拆 `core` / `ui` / `desktop` / `web`）
- 全部界面用 mock 数据，本阶段还不需要 mock
- 设计稿在 Ardot（fileId `728255468414716`），但**当前会话无设计稿读写工具**，以本规格书 + `screens.md` 为准
