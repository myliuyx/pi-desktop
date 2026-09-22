# 8 屏实现拆解

> 配套阅读：[README.md](./README.md)（总览）、[design-tokens.md](./design-tokens.md)（令牌）

---

## 一、统一布局骨架

8 屏共用同一套三栏骨架，只有内容区不同。这是设计稿第 06 屏「内容区 100% 复用，只换壳」思路在代码里的体现。

```
┌────────────────────────────────────────────────────────────────┐
│ TitleBar  [⊞收起左侧]         Atlas Agent         [收起右侧⊟]  │ 36px
├──────────┬─────────────────────────────┬───────────────────────┤
│ Sidebar  │ 内容区 WorkspaceArea         │ PreviewPane           │
│ 264px    │                             │ 480（默认）           │
│          │  ┌───────────────────────┐  │                       │
│ 新建任务 │  │ MessageList           │  │ [预览效果][预览源码]  │
│ 搜索     │  │ 虚拟滚动 / 纵向滚动    │  │                       │
│ 历史会话 │  └───────────────────────┘  │                       │
│ 工作目录 │  ┌───────────────────────┐  │                       │
│          │  │ Composer        [发送] │  │                       │
│          │  └───────────────────────┘  │                       │
│          │  [模型][思考强度][MCP] ·· TokenStats │                │
├──────────┤                             │                       │
│ SidebarFooter 条带 36（通底贴边）       │                      │
└──────────┴─────────────────────────────┴───────────────────────┘
```

> ⚠️ **Composer 与工具条在内容区（WorkspaceArea）内部，不横跨窗口底部。**（2026-09-22 澄清）
>
> 本节早期版本的草图把 Composer 画成了横跨全宽的一行，那是当初的粗略示意，**与两条已锁定的
> 事实冲突**：① M1 的 `WorkspaceArea` 注释已写明「M2 才填消息流 / Composer / 工具条」；
> ② 验收 1-3 要求侧边栏底部条带的**底边与窗口底重合**（`offsetBottom = 0`，已实测通过），
> 若 Composer 横跨窗口底部，条带必然被顶上去、1-3 立刻失效。
> 因此以本图为准：每一栏各自管理自己的底部 —— 侧边栏底部是条带，内容区底部是 Composer + 工具条。

### 尺寸（来自设计稿）

| 区域 | 尺寸 | 备注 |
|---|---|---|
| 标题栏 | 高 36 | 内含 28×28 按钮，`radius-md` |
| 侧边栏 | 宽 264 | 内容区 padding 12 |
| 侧边栏底部条带 | 高 36 | **通底贴边**，无圆角、无缝隙 |
| 发送按钮 | 28×28 | 圆形，`accent_soft` 底 + `accent` 描边箭头 |
| 工具条芯片 | 高 32 | |
| 窗口 | **1440×900（已定稿）** | 2026-09-21 确认按 1440 开工 |

> **尺寸一律走 `src/lib/layout.ts` 常量，禁止在组件里硬编码。** 设计稿再改宽度只需动一个文件。


### 折叠行为

- 标题栏左侧按钮收起**侧边栏**，右侧按钮收起**预览区**
- 折叠用宽度过渡（约 180ms），不用 `display:none`，避免布局跳动
- 折叠状态存 `ui-store`，刷新后保留

---

## 二、逐屏拆解

### 00 · 设计系统基础

原型里做成一个 `/tokens` 路由，用于核对，不做成正式界面。

内容：色板（全部语义令牌，深浅并列）、字号阶梯、圆角档位、按钮与芯片状态矩阵、图标清单。

**价值**：深浅模式问题在这一屏能一眼看出来，比在业务屏里逐个找快得多。

### 01 · 会话工作台（浅色）—— 主屏，M2 重点

| 区域 | 组件 | 要点 |
|---|---|---|
| 标题栏 | `TitleBar` | 左端「收起左侧」插在窗口控件后；右端「收起右侧」在最末；中间可放会话标题 |
| 侧边栏 | `Sidebar` | 顺序：新建任务 → 搜索 → **历史会话**（无今天/昨天分组）→ **工作目录** |
| 侧边栏底 | `SidebarFooter` | 方形双色条带，模型 / 设置各半宽，通底贴边、无圆角无缝 |
| 消息流 | `MessageList` | 虚拟滚动；支持流式追加 |
| 执行计划 | `PlanCard` | 步骤列表 + 状态（待执行 / 进行中 / 完成 / 失败） |
| 终端步骤 | `TerminalCard` | 命令 + 输出（等宽字体），可折叠，长输出截断 |
| 授权卡片 | `ApprovalCard` | 标题 + 说明 +「允许 / 拒绝」，突出显示 |
| 输入区 | `Composer` | 多行输入；右下角内嵌圆形发送按钮 |
| 工具条 | `ComposerToolbar` | 模型 → 思考强度 → MCP → 弹性 → `TokenStats`（靠右） |
| 预览区 | `PreviewPane` | 双 Tab：预览效果 / 预览源码 |

**TokenStats 规格**（设计稿第 5 轮定稿）：`bg_subtle` 圆角容器，四段用细分隔线隔开 —— `输入 12.4k` · `输出 6.2k` · `消耗 18.6k`（用 `text-primary` 高亮）· `上下文 128k`。

**发送按钮规格**（第 6 轮定稿）：28×28 圆形，`accent_soft` 底 + `accent` 描边箭头，`radius-full`。放在输入框**内部**右下角，不是在输入框外。

### 02 · 会话工作台（深色）

**不单独写一套样式。** 与 01 共用同一棵组件树，只切换 `data-theme`。

原型里表现为一个开关，切换后整屏换肤。若发现某处深色下不可读，说明该处硬编码了颜色 —— 修令牌或修组件，绝不写 `dark:` 变体去打补丁。

### 01b · 预览源码态（浅色）

与 01 完全相同，只有 `PreviewPane` 的激活 Tab 是「预览源码」。

源码态要点：等宽字体、行号、`Shiki` 高亮（**必须用支持深浅双主题的引擎**，这样换肤时不用重新高亮）。

### 03 · 运行详情

展示一次运行的完整步骤：时间轴或步骤列表，每步含状态、耗时、输入/输出摘要、可展开的完整结果。

数据复用 `TerminalCard` 与 `PlanCard` 的组件，只是排布不同。

### 04 · 技能与工具

- 技能列表（对应 Pi 的 `get_commands` 三类：extension / prompt / skill）
- 工具列表与开关（对应 Pi 的 `tools` allowlist：read / bash / edit / write）
- MCP 服务器列表（**Pi 不内置 MCP，此屏为自建能力的展示位**）

### 05 · 设置

常规设置分组：模型、思考强度、会话（自动压缩 / 自动重试）、外观（主题）、工作目录。

字段对齐 Pi 的 `SettingsManager`，为下阶段接入做准备。

### 06 · 跨平台窗口壳

三个 OS 变体并排展示，内容区完全一致：

- `<WindowShell os="mac">` — 交通灯在左
- `<WindowShell os="win">` — 最小化/最大化/关闭在右
- `<WindowShell os="linux">` — 控件在右，风格更朴素

**验收**：切换 `os` prop 时，内容区不应有任何布局位移。

---

## 三、组件清单

按实现优先级排列。

### P0 —— M1 布局骨架必需

| 组件 | 文件 | 依赖 |
|---|---|---|
| `WindowShell` | `shell/WindowShell.tsx` | — |
| `TitleBar` | `shell/TitleBar.tsx` | `IconButton` |
| `Sidebar` | `shell/Sidebar.tsx` | `ScrollArea` |
| `SidebarFooter` | `shell/SidebarFooter.tsx` | — |
| `IconButton` | `primitives/IconButton.tsx` | 图标统一用 `--icon-neutral` |

### P1 —— M2 主屏必需

| 组件 | 文件 | 依赖 |
|---|---|---|
| `MessageList` | `chat/MessageList.tsx` | `@tanstack/react-virtual` |
| `MessageBubble` | `chat/MessageBubble.tsx` | react-markdown + Shiki |
| `PlanCard` | `chat/PlanCard.tsx` | — |
| `TerminalCard` | `chat/TerminalCard.tsx` | — |
| `ApprovalCard` | `chat/ApprovalCard.tsx` | `Button` |
| `Composer` | `chat/Composer.tsx` | — |
| `ComposerToolbar` | `chat/ComposerToolbar.tsx` | `Chip` |
| `TokenStats` | `common/TokenStats.tsx` | — |
| `Chip` | `primitives/Chip.tsx` | — |
| `Button` | `primitives/Button.tsx` | — |

### P2 —— M3 预览区与其余屏

| 组件 | 文件 |
|---|---|
| `PreviewPane` | `shell/PreviewPane.tsx` |
| `Tabs` | `primitives/Tabs.tsx` |
| `ScrollArea` | `primitives/ScrollArea.tsx` |
| `Segmented` | `primitives/Segmented.tsx` |
| `Tooltip` | `primitives/Tooltip.tsx` |

### 基础件选型

- 需要浮层行为的（`Tooltip`、下拉菜单）用 **Radix Primitives**，样式完全自套令牌
- `ScrollArea` 用 Radix，或直接用原生 `overflow` + 自定义滚动条样式（更简单，推荐后者）
- 代码高亮用 **Shiki**，配合 `themes: { light, dark }` 双主题
- Markdown 用 `react-markdown` + `remark-gfm`
- 图标用 **Lucide**，统一 `size={16}`

> 关于图标尺寸：设计稿里「SVG 必须用 16 viewBox」是 **Figma 导入的解析限制**（用 24 viewBox 会生成越界的垃圾节点）。代码里不受此约束，Lucide 传 `size={16}` 即可正常渲染。

---

## 四、mock 数据结构

### 设计原则：对齐 Pi 事件模型

**mock 类型刻意按 Pi 的事件结构设计**，这样下阶段接真数据时，只需把事件流映射到这些结构，UI 组件完全不用改。

| Pi 事件 | 对应的 UI Block |
|---|---|
| `message_update` → `text_delta` | `TextBlock` |
| `message_update` → `thinking_delta` | `ThinkingBlock` |
| `message_update` → `toolcall_*` | `ToolCallBlock` |
| `tool_execution_start` / `_update` / `_end` | `TerminalBlock` |
| `extension_ui_request` 的 `select` / `confirm` | `ApprovalBlock` |
| （自建） | `PlanBlock` |

```ts
// mock/types.ts

export type Block =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | TerminalBlock
  | ApprovalBlock
  | PlanBlock;

export interface TextBlock {
  type: "text";
  content: string;          // markdown
  streaming?: boolean;      // 用于模拟流式光标
}

export interface ThinkingBlock {
  type: "thinking";
  content: string;
  collapsed?: boolean;
}

export interface ToolCallBlock {
  type: "tool_call";
  toolCallId: string;
  toolName: string;         // read / bash / edit / write
  args: Record<string, unknown>;
}

export interface TerminalBlock {
  type: "terminal";
  toolCallId: string;
  command: string;
  output: string;
  exitCode?: number;
  status: "running" | "success" | "error";
  truncated?: boolean;
}

export interface ApprovalBlock {
  type: "approval";
  requestId: string;        // 对应 Pi 的 extension_ui_request.id
  title: string;            // 如 "允许执行该命令？"
  message?: string;
  options: string[];        // 如 ["允许", "拒绝"]
  resolved?: string;        // 用户的选择
}

export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "failed";
}

export interface PlanBlock {
  type: "plan";
  steps: PlanStep[];
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  blocks: Block[];
  timestamp: number;
}

export interface Session {
  id: string;
  title: string;
  updatedAt: number;
  messages: Message[];
}

export interface TokenUsage {
  input: number;            // 12.4k → 12400
  output: number;
  total: number;
  contextWindow: number;    // 128k → 128000
}
```

### TokenStats 格式化

设计稿显示 `12.4k`。规则：

```ts
const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
```

---

## 五、验收标准

### 功能

- [ ] 深浅切换：全部 8 屏无硬编码颜色残留（切到深色后无白底黑字）
- [ ] 左右栏折叠：过渡平滑，折叠后内容区自动填满，无横向滚动条
- [ ] 消息流：500+ 条消息滚动流畅（虚拟滚动生效）
- [ ] 预览区双 Tab：效果态渲染 HTML，源码态显示高亮代码
- [ ] 授权卡片：点击「允许 / 拒绝」后状态更新
- [ ] 06 屏：切换 `os` prop 时内容区零位移

### 交互细节

- [ ] 侧边栏底部条带**通底贴边**，左右与底部无留白、无圆角、无缝隙
- [ ] 发送按钮在输入框**内部**右下角，圆形 28×28
- [ ] TokenStats 靠右，四段之间细分隔线，「消耗」用 `text-primary` 高亮
- [ ] 工具条顺序：模型 → 思考强度 → MCP → 弹性占位 → TokenStats
- [ ] 图标在所有背景下可见（固定中性色）

### 代码质量

- [ ] 全局搜索无 `#hex` 硬编码（除 `tokens.css` 与 `--icon-neutral`）
- [ ] 无 `dark:` 变体补丁
- [ ] 组件只引用语义令牌

### 走查

- [ ] 与 Ardot 设计稿逐屏对比，标注差异（原型阶段的差异是可接受的，但要记录）
