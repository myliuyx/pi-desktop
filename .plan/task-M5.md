# task-M5 · 窗口壳与走查 · 执行规格书

> 仿 `task-M3.md` / `task-M4.md` 的七节结构。**验收结论留给主控复核定稿**，执行方不下通过结论。
> 里程碑工时 11h（5.1 三端壳 3h / 5.2 全屏走查 4h / 5.3 交互打磨 4h）。

---

## 〇、背景与范围

M0–M4 已完成：8 屏里 7 屏落地（00 令牌页 / 01 工作台 / 01b 源码态 / 02 深色 / 03 运行详情 / 04 技能与工具 / 05 设置）。
**M5 是最后一个里程碑**，做三件事：

1. **06 屏 · 三端窗口壳并排展示** —— 同一个内容区（01 工作台）在 mac / win / linux 三种壳下并排呈现，
   验证「内容区 100% 复用，只换壳」这条设计初衷。
2. **全屏走查** —— 逐屏对照设计稿，产出**差异清单**（`.plan/diffs/diff-M5-2026-09-22.md`），
   按 Blocker / Major / Minor 分级，Blocker 与 Major 当轮清零。
3. **交互打磨** —— hover / active / 焦点环 / 空状态 / 长文本溢出五项收口。

**不在 M5 范围**：接 Pi、接 LLM、Electron 壳打包、新增令牌色值、改既有屏的信息架构。

---

## 一、现状与集成点

### 1.1 `os` prop 已经存在（M1 就埋好了）

`WindowShell` → `TitleBar` 已带 `os?: "mac" | "win" | "linux"`，三端控件也已实现：

| os | 控件位置 | 表现 |
|---|---|---|
| `mac` | 左 | 三个交通灯圆点（`bg-window-close/minimize/maximize`，直径 10） |
| `win` | 右 | 最小化 / 最大化 / 关闭，**关闭键染 `text-danger`** |
| `linux` | 右 | 三个键同色，风格更朴素（无危险色） |

**所以 5.1 不是「实现三端壳」，而是「提供 06 屏这个并排展示面 + 支持逐壳切 `os`」。**
⚠️ 不要重写 `TitleBar` 的三端分支 —— 它已被 M1 验收覆盖，重写会作废既有证据。

### 1.2 内容区零位移的既有保障（**关键，动之前先读懂**）

`WorkbenchScreen` 的注释已写明设计意图：

> 三栏组装放在这里而不是 WindowShell 里：这样 06 屏切换 `os` 时**整棵内容子树的原位置引用不变**，
> 内容区首个元素坐标完全一致（验收 5-2）。

即：`os` 只影响 `TitleBar` 内部（左端控件改用另一种形状 + 换边），**三栏容器与主区内容完全不受 `os` 影响**。
实现 06 屏时必须保持这条：**三端壳之间只能共享同一个 `WorkbenchScreen` 元素树**，不能各自包一层会改变布局的容器。

### 1.3 06 屏的呈现方式（**本规格的主控决策，照此实现**）

设计稿要求「三个 OS 变体并排展示」。**不能用 `os` 全局 prop 切**（那样一次只能看一个），
也不能把三端壳并排塞进同一个窗口宽度里（1440 分三个只有 480，远小于三栏所需 1424，必然触发响应式收缩，
量出来的坐标也就不可比了）。

**采用方案：三端并排 = 三个「缩略窗口」纵向堆叠在一个可滚动的 06 屏里。**

- 06 屏是一个**独立 hash 路由**：`#/shells`，与 03/04/05 同一个模式（`ScreenId` 加一个值 + `SCREEN_BY_HASH` 加一行）
- 每个缩略窗口是一个 `ShellPreview` 卡片：**外壳 + 固定尺寸的内容区裁剪窗口**
- 内容区裁剪窗口的尺寸取 **`DESIGN_WIDTH` × `DESIGN_HEIGHT`**（1440 × 900）做 `transform: scale()` 缩放显示，
  **裁剪窗口的内层尺寸始终是 1440×900**，缩放只影响视觉大小 —— 这样三端之间的内容区坐标系是同一个，
  5-2 的「首个元素坐标完全一致」才有意义。
- 每张卡片带 `data-os` 与 `data-testid="shell-preview"`，供验收脚本逐壳取坐标。

> 为什么用 `transform: scale()` 而不是直接渲染 1440 宽：1440 远超 06 屏可视宽度，
> 直接渲染会把整个页面撑出横向滚动条（G6 直接挂）。`scale` 不改变布局占位之外的行为，
> 但它会改变 `getBoundingClientRect()` 的返回值 —— **因此坐标比较必须在 `scale` 之前的口径下做**：
> 验收脚本读的是**内层未缩放容器**（`data-testid="shell-content-probe"`）里首元素的
> `offsetLeft / offsetTop`（`offset*` 不受 CSS transform 影响），而不是 `getBoundingClientRect()`。
> **这条是 5-2 能不能验准的关键，务必照做。**

### 1.4 逐壳切 `os` 的入口（为 5-2 提供可复跑路径）

除了并排展示，**再提供「单壳全屏」视图**：`#/shells?os=win` 时只渲染一个全尺寸的三端壳。
理由：验收 5-2 要在**全尺寸**下比较三端内容区首元素坐标（缩放视图下比较会引入缩放误差）。
参数不存在时渲染并排三卡；存在时渲染单个全尺寸壳。

与 `?stress=` / `?preview=code` 同理做成**正式能力**（M2 的教训：验收要可复跑，不能靠手点）。

### 1.5 空状态与长文本的现状盘点（先探再补）

**必须先用 grep 盘点现状，只补真正缺的**（不要为了「做了 5-7 / 5-8」而重复实现）：

| 项 | 现状盘点命令思路 | 判断标准 |
|---|---|---|
| 空会话 | `MessageList` 是否在 0 条消息时渲染占位 | 无占位则补 `empty-state` |
| 空列表 | 04 屏技能分组为空时是否有提示 | 同上 |
| 无结果搜索 | 侧边栏搜索框输入无匹配时是否有提示 | 同上 |
| 超长会话标题 | 检查侧边栏标题的 `truncate` / `title` 属性 | 无省略或不可见全称则补 |
| 超长工具名 | 04 屏工具名 / 技能名 | 同上 |
| 超长路径 | 05 屏工作目录 | 同上 |

**长文本的合格线**：要么 `truncate`（单行省略）+ `title`（悬停可见全称），要么 `break-all` 换行。
**不允许**：撑破容器、出现横向滚动、被无声裁掉且无法看到全称。

### 1.6 既有遗留（M5 必须一并裁决）

1. **`COLLAPSE_DURATION_REDUCED` 90ms → 120ms**（M2 记录：中间帧实测 4→3 帧，门槛正是 ≥3，无余量）。
   → **本次裁决并执行**。改完必须重跑 `accept:m1`（1-10 就是这条的红线）。
2. **Tab 面板缺 `role="tabpanel"` + `aria-labelledby`**（`primitives/Tabs.tsx`，G7 收尾）。
3. **对比度分层口径**复用 M4 的（`scripts/m4-acceptance.mjs` 顶部注释），不要另立标准。

---

## 二、任务拆解

### 5.1 · 06 屏三端壳（`screens/ShellsScreen.tsx`）

**新建文件：**

| 文件 | 内容 |
|---|---|
| `src/screens/ShellsScreen.tsx` | 06 屏主体：并排三卡 + `?os=` 单壳模式 |
| `src/components/screens/ShellPreview.tsx` | 缩略窗口卡片（外壳 + 缩放裁剪的内容区 + 标签） |
| `src/mock/shells.ts` | 三端元数据（os 值、显示名、一句说明） |

**修改文件：**

| 文件 | 改动 |
|---|---|
| `src/App.tsx` | `ScreenId` 加 `"shells"`；`SCREEN_BY_HASH` 加 `shells: "shells"`；`switch` 加分支 |
| `src/lib/layout.ts` | 新增 M5 常量段（见下） |
| `src/components/shell/WorkbenchScreen.tsx` | **仅在必要时**加 prop；优先不动（它是 5-2 的基准） |

**M5 常量段（`lib/layout.ts`）：**

```ts
/* M5 · 窗口壳与走查 */

/** 06 屏缩略窗口的缩放比（1440 宽的窗口缩到可视区内） */
export const SHELL_PREVIEW_SCALE = 0.42;

/** 06 屏缩略窗口卡片的圆角（与 radius-lg 同档，但独立常量便于走查调整） */
export const SHELL_PREVIEW_RADIUS = 12;

/** 06 屏缩略窗口的标签区高度 */
export const SHELL_PREVIEW_LABEL_HEIGHT = 28;
```

> 缩放比的具体数值由实现方按 06 屏可视宽度算出来即可，**但必须走常量**（禁止在 `style={{}}` 里写裸尺寸，
> 验收脚本会扫）。同理所有新增尺寸一律进 `layout.ts`。

**testid 契约（逐条照做，验收脚本按此写）：**

| testid | 位置 | 必须带的 `data-*` | 语义 |
|---|---|---|---|
| `shells-screen` | 06 屏内容区根节点 | — | 屏存在性 |
| `shell-preview` | 每个缩略窗口卡片 | `data-os`（mac/win/linux） | 三端齐全 + 逐端定位 |
| `shell-preview-label` | 卡片标签 | `data-os` | 标签文字按端区分 |
| `shell-frame` | 卡片内的窗口壳实例（即 `WindowShell` 的 testid 已有） | — | 壳真的渲染了 |
| `shell-content-probe` | **缩放容器内层**的坐标探针 | `data-os` | **5-2 的唯一落点**：读它的 `offsetLeft/offsetTop` |
| `shells-mode-hint` | 并排/单壳模式的提示条 | `data-mode`（`grid` / `single`） | 让脚本知道当前模式 |

**并排模式必须三个 `shell-preview` 都带正确的 `data-os`，且三者的 `os` 互不相同。**

**单壳模式（`?os=mac|win|linux`）**：只渲染一个全尺寸 `WorkbenchScreen`，
带 `data-testid="shell-single"` + `data-os`。

**关键实现约束（否则 5-2 必挂）：**

1. 三张卡片必须**各自独立持有自己的 `os` 值**，不能共用 store 里的一个字段 —— 否则三端会同时变。
2. 内容区探针的 `offsetLeft / offsetTop` 必须只由**三栏布局**决定。
   `TitleBar` 的高度在三端都是 `TITLE_BAR_HEIGHT = 36`（已定稿，不许因 os 而变），
   所以标题栏若高度一致，内容区首元素 `offsetTop` 就该三端相同。
   **若实测不同，先查是不是某一端的控件把标题栏撑高了 —— 那才是真缺陷。**
3. 缩放容器用 `transform: scale()` + `transform-origin: top left`，外层给**固定的缩放后尺寸**
   （`DESIGN_WIDTH × SCALE` 等），避免缩放后仍占满原始宽高把布局撑爆。

### 5.2 · 全屏走查（产出差异清单）

**产出物：`.plan/diffs/diff-M5-2026-09-22.md`**（目录要新建），格式照 `acceptance-criteria.md` 第七节模板：

```markdown
# 差异清单 · M5 · 2026-09-22

| # | 位置 | 现象 | 设计稿期望 | 级别 | 处理 |
|---|---|---|---|---|---|
| 1 | Composer | 发送按钮距右边缘 10px | 应为 8px | Minor | 待 M5 |
```

**走查范围（8 屏，逐屏打勾）：**

| 屏 | 验收项 | 对照要点 |
|---|---|---|
| 00 | 0-7 | 色板深浅并列、字阶完整、圆角档位、状态矩阵、图标清单 |
| 01 | M2 全 18 条 + M1 全 12 条 | 逐条 |
| 01b | 3-4 | 源码态与 01 结构一致，仅 Tab 激活项不同 |
| 02 | 3-8 | 与 01 **结构完全一致**，差异仅存在于色值 —— 任何结构性差异即 ❌ |
| 03 | 4-1~4-3 | 步骤完整性、状态图标、耗时、展开收起 |
| 04 | 4-4 | 三类命令、工具开关、MCP 区块 |
| 05 | 4-5~4-6b | 分组、控件类型、对齐 Pi 字段 |
| 06 | 5-1 / 5-2 | 三端标题栏差异正确、内容区零位移 |

**分级标准（照 `acceptance-criteria.md` 第一章，不要凭感觉）：**

- **Blocker**：违反 G1~G8 任一条 / 功能不可用 / 数据错误
- **Major**：与设计稿显著不符 / 可访问性不达标 / 影响主要流程
- **Minor**：1~4px 偏差 / 文案细微差异 / 非关键状态缺失

**Blocker 与 Major 必须当轮清零**，Minor 记录待后续。**每条都要有「现象 + 期望 + 级别 + 处理」四栏**，
不许只写「看起来差不多」。

### 5.3 · 交互打磨（五项）

| 项 | 覆盖对象 | 合格线 |
|---|---|---|
| **hover** | 所有可点击元素 | 有明确的背景或颜色变化（`hover:bg-bg-hover` 之类） |
| **active** | 同上 | 有按下反馈（`active:bg-bg-active`） |
| **焦点环** | 所有可聚焦元素 | `:focus-visible` 下 2px `--accent` 描边，**深浅两模式都可见** |
| **空状态** | 空会话 / 空列表 / 无结果搜索 | 有占位提示，不塌陷成 0 高度 |
| **长文本** | 超长会话标题 / 工具名 / 路径 | 省略或换行策略，无撑破、无横向滚动 |

**焦点环的判据（G7）**：纯键盘 Tab 走一遍主流程，且**在深色模式下也要可见**。
`globals.css` 已有全局 `:focus-visible { outline: 2px solid var(--accent) }`，
**重点是确认它没被组件自己的 `outline-none` 之类覆盖掉** —— 要逐个可聚焦组件 grep 检查。

**空状态必须能复现**：不能靠「手动删数据」看效果。
用 URL 参数做正式入口（如 `?empty=1` 让会话为空），与 `?stress=` 同理。

---

## 三、高危点

| # | 高危点 | 为什么危险 | 怎么避 |
|---|---|---|---|
| 1 | **`transform: scale()` 下用 `getBoundingClientRect()` 验坐标** | `rect` 受 transform 影响，三端若缩放容器尺寸有亚像素差异会得到假差异 | 读 `offsetLeft/offsetTop`（不受 transform 影响），见 1.3 |
| 2 | **改 `TITLE_BAR_HEIGHT` 或让它随 os 变** | 5-2 直接挂，且作废 M1 验收 1-4 的证据 | 三端一律 36，不许动 |
| 3 | **重写 `TitleBar` 的三端分支** | M1 已验收过，重写作废既有证据 | 只调用，不改内部 |
| 4 | **`os` 存进全局 store 单字段** | 并排三卡会同时变，`data-os` 全一样 | 每张卡片各自持有 `os` |
| 5 | **缩放容器没给固定外层尺寸** | 缩放后仍占 1440 宽 → 06 屏横向滚动条（G6 挂） | 外层给 `DESIGN_WIDTH × SCALE` |
| 6 | **`COLLAPSE_DURATION_REDUCED` 改了没重跑 1-10** | 1-10 门槛正是「中间帧 ≥3」，改小就挂 | 改完立刻重跑 `accept:m1` |
| 7 | **给折叠写 `motion-reduce:transition-none`** | 直接把过渡整个取消，G8 + 1-10 双挂（文档已警告过两次） | 只调时长，不写这个类 |
| 8 | **`data-*` 写成 camelCase** | React 会把 `data-osValue` 落成 `data-osvalue`，脚本读不到 | 全小写连字符 |
| 9 | **空状态/长文本「为了做而做」** | 重复实现已有能力，白增风险 | 先 grep 盘点，只补真缺的 |
| 10 | **差异清单只写现象不写期望** | 无法判定是否修完 | 四栏必须齐全 |

---

## 四、明令禁止

1. **禁止新增 hex 色值**（G1）。06 屏的标签、边框、底色**全部走既有令牌**。
2. **禁止 `dark:` 变体**（G2）。06 屏的深浅表现必须自动跟随。
3. **禁止在 `style={{}}` 里写裸尺寸**（`lib/layout.ts` 是唯一来源，验收脚本会扫）。
   例外：`<=1px` 的发丝线、`transform` 的 `scale()` 值（走常量）。
4. **禁止用静态标签页签的 `os` 值硬编码坐标**去「对齐」三端 —— 三端坐标必须**天然相同**，
   不同就是 bug，不许用 `margin-top` 之类的补丁抹平。
5. **禁止改 `mock/types.ts`**（M2 冻结契约）；**禁止改 `tokens.css` 的既有色值**。
6. **禁止引入新依赖**（依赖已冻结）。
7. **禁止删改既有 `accept:m1/m2/m3/m4` 脚本的断言**。发现断言本身有缺陷要单独说明并留痕。
8. **禁止把 `os` 做成全局 store 状态**（见高危点 4）。
9. **禁止给折叠加 `motion-reduce:transition-none`**（见高危点 7）。
10. **禁止在 06 屏里重复实现三端控件** —— 复用 `TitleBar` 的三端分支。

---

## 五、自验最低要求

**必须产出 `scripts/m5-acceptance.mjs` 之外的自查证据：**

1. **三端并存**：三个 `shell-preview` 的 `data-os` 集合 == `{mac, win, linux}`，且三者互不相同。
2. **内容区零位移**（核心）：单壳模式下依次 `?os=mac|win|linux`，读
   `shell-content-probe` 内首元素的 `offsetLeft / offsetTop`，**三端必须完全一致**。
   并排模式另取一次三卡内的同一组值，同样必须一致。
   断言里要**打印出三组实际数值**，便于主控复核。
3. **缩放不产生横向滚动**：06 屏 `scrollWidth <= clientWidth + 1`。
4. **06 屏深浅两模式**：深色下无大面积白底，正文对比度 ≥4.5（复用 M4 口径）。
5. **交互三态**：抽查 ≥5 个可点击元素，hover 前后 `backgroundColor` 或 `color` 有变化；
   `:focus-visible` 时 `outlineWidth` 非 0。
6. **空状态**：走 `?empty=1`，断言占位节点存在且高度 > 0。
7. **长文本**：断言超长标题 / 工具名 / 路径元素的 `scrollWidth <= clientWidth`（有省略），
   或换行后无横向溢出。
8. **1-10 回归**：`COLLAPSE_DURATION_REDUCED` 若改动，重跑 `accept:m1` 必须仍过。

**自查脚本里的每个断言都必须是显式布尔项**（`ctx.assert` 要求 detail 里必须有布尔值），
不要只 `console.log` 数值。**失败的断言先怀疑断言本身**（本项目已四次验证这条）。

---

## 六、环境注意事项

1. **Bash 工具的 `rm` / `ls` / `dirname` 常常 exit 127**（shim 缺失）→ 文件操作用 node 脚本。
2. **PowerShell 的 stdout 常不回传**（只给 exit code）→ 结果**用 node 直接写文件**再读；
   经 PS 管道写中文会乱码；`*>` 重定向生成 UTF-16，Read 会报 binary。
3. **`npm.cmd` 而非 `npm.ps1`**（执行策略拦截）。
4. **CDP 端口分配**：m1=9333 / m2=9337 / m3=9341 / m4=9342 → **M5 用 `9343`**。
   脚本用 `M5_ORIGIN` / `M5_CDP_PORT` 环境变量覆盖。
5. **长命令用 `run_in_background`**，避免超时被 SIGTERM。
6. **dev server**：`node ./node_modules/vite/bin/vite.js --port 5180 --strictPort`。
7. **验收脚本跑完要 `ctx.save()` 落盘证据** —— M4 的教训：断言全绿却没证据文件，事后无法复盘。
8. headless Chrome 默认 `prefers-reduced-motion: reduce`，折叠走 **90ms**（改动后 120ms）分支，这是预期行为。

---

## 七、交付要求

1. **代码**：按第二节的 testid 契约实现，全部尺寸进 `layout.ts`。
2. **自查证据**：`scripts/m5-selfcheck.mjs`（或等价物）+ 其输出，**每条结论标「待主控复核」**。
3. **差异清单**：`.plan/diffs/diff-M5-2026-09-22.md`，8 屏逐条，四栏齐全，Blocker/Major 标明处置结果。
4. **progress 文档**：`.plan/progress-M5.md`，结构照 `progress-M4.md`：
   背景 / 交付物 / 逐项自验证据 / 高危点处理 / 偏离规格说明 / 教训 / **「待主控复核」章节**。
5. **不要下通过结论**：`5-1 ~ 5-9` 的逐条判定一律写「待主控复核」。
6. **跑完清理临时文件**，但**保留证据 JSON**（`_m5-evidence.json`），与 M1~M4 惯例一致。

---

## 八、主控复核时将执行的动作（供参考，你别做）

1. 独立复跑 `typecheck` / `build` / `check:cn` / `accept:m1` / `accept:m2` / `accept:m3` / `accept:m4`。
2. **主控自写** `scripts/m5-acceptance.mjs`，覆盖 5-1~5-9 与 G1~G8。
3. 源码走读：`ShellsScreen` 的三端数据流（确认没有全局 store 化）、`ShellPreview` 的缩放实现、
   `App.tsx` 的 `?os=` 参数解析、`layout.ts` M5 段、`Tabs.tsx` 的 aria 接线。
4. 裁决既有遗留（`COLLAPSE_DURATION_REDUCED`、`Tabs` aria）。
5. 若发现差异清单里的 Blocker/Major 未真正清零，打回。
