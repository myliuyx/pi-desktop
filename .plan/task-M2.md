# M2 · 会话工作台 —— 执行规格书

> 版本：2026-09-22 · 状态：待执行（**两个执行方并行**）
> 验收依据：[acceptance-criteria.md](./acceptance-criteria.md) 第三章 M2 小节（**18 条**）+ 第二章 G1~G8 + **M1 的 13 条必须回归通过**
> 尺寸来源：[`../packages/ui/src/lib/layout.ts`](../packages/ui/src/lib/layout.ts)（**唯一数值来源**）
> 颜色来源：[`../packages/ui/src/styles/tokens.css`](../packages/ui/src/styles/tokens.css)（**唯一颜色来源**）
> 类型来源：[`../packages/ui/src/mock/types.ts`](../packages/ui/src/mock/types.ts)（**已冻结**）

---

## 零、给执行方的读法

- **Agent A = 消息流与卡片**：读第 2、4.1~4.3、5、6 节 + 第 9 节的 A 部分。
- **Agent B = 输入区与统计**：读第 2、4.1、4.4、5、6 节 + 第 9 节的 B 部分。
- 第 1、3、7、8 节**两边都要看**。

**并行前提：接口桩已经打好。** 主控已创建以下文件，项目当前 `tsc` EXIT=0 且能 `npm run dev` 跑起来：

| 桩文件 | 归属 | 说明 |
|---|---|---|
| `src/mock/types.ts` | **冻结，谁都别改**（只允许新增可选字段） | 全部数据类型 |
| `src/mock/sessions.ts` | Agent A 重写 | 目前是最小桩 |
| `src/store/chat-store.ts` | Agent A 重写 | `ChatState` 是冻结契约 |
| `src/components/chat/MessageList.tsx` | Agent A 重写 | props 冻结为 `{ messages }` |
| `src/components/chat/Composer.tsx` | Agent B 重写 | 根节点即输入框 |
| `src/components/chat/ComposerToolbar.tsx` | Agent B 重写 | — |
| `src/lib/format.ts` | **冻结** | `formatCompact` / `formatClock` / `truncateLines` |
| `src/components/shell/WorkspaceArea.tsx` | **主控已集成，别改** | 已把三块拼好 |
| `scripts/cdp.mjs` | **冻结**（两边都 import） | CDP 驱动公共模块 |

**这意味着：你随时可以 `npm run dev` 看到自己的改动，也随时必须保持 `tsc` 为 0 错误。**

---

## 一、任务清单

| # | 任务 | 产出文件 | 验收项 | 归属 |
|---|---|---|---|---|
| 2.1 | mock 会话数据（按 Pi 事件结构） | `src/mock/sessions.ts` | 2-1 / 2-6 / 2-7 / 2-18 | A |
| 2.2 | `MessageList`：虚拟滚动 + 自动滚底 | `src/components/chat/MessageList.tsx` | 2-2 / 2-5 | A |
| 2.3 | `MessageBubble`：Markdown 渲染 | `src/components/chat/MessageBubble.tsx` | 2-3 | A |
| 2.4 | 代码高亮（Shiki 双主题） | `src/lib/highlight.ts` + `src/styles/shiki.css` | 2-4 | A |
| 2.5 | `PlanCard`（四态） | `src/components/chat/PlanCard.tsx` | 2-6 | A |
| 2.6 | `TerminalCard`（等宽 / 截断 / 展开） | `src/components/chat/TerminalCard.tsx` | 2-7 | A |
| 2.7 | `ApprovalCard`（可交互 / 已决置灰） | `src/components/chat/ApprovalCard.tsx` | 2-8 | A |
| 2.8 | `ThinkingCard`（思考块，可折叠） | `src/components/chat/ThinkingCard.tsx` | 支撑 2-1 | A |
| 2.9 | 流式模拟 | `src/mock/stream.ts` | 2-5 | A |
| 2.10 | `Composer`（多行自适应 + 内嵌圆形发送按钮） | `src/components/chat/Composer.tsx` | **2-9 / 2-10 / 2-17 / 2-18** | B |
| 2.11 | `ComposerToolbar`（三芯片 + 弹性占位） | `src/components/chat/ComposerToolbar.tsx` | 2-11 / 2-12 / 2-16 | B |
| 2.12 | `TokenStats`（四段 + 高亮） | `src/components/common/TokenStats.tsx` | 2-13 / 2-14 / 2-15 | B |
| 2.13 | 工具条 mock 数据（模型 / 档位 / MCP） | `src/mock/composer.ts` | 支撑 2-11 | B |

---

## 二、目标结构

```
WorkspaceArea（主控已接好，别改）
├── MessageList                      data-testid="message-list"   ← ★ 真正的滚动容器
│   ├── MessageItem × N              data-testid="message-item"   ← 虚拟滚动渲染的那几个
│   │   ├── ThinkingCard             data-testid="thinking-card"
│   │   ├── PlanCard                 data-testid="plan-card"
│   │   ├── TerminalCard             data-testid="terminal-card"
│   │   ├── ApprovalCard             data-testid="approval-card"
│   │   └── MessageBubble            （markdown / 代码块 data-testid="code-block"）
│   └── ScrollToBottom               data-testid="scroll-to-bottom"（不在底部时才出现）
└── composer-area（主控已写）
    ├── Composer                     data-testid="composer"       ← ★ 输入框本体
    │   ├── textarea                 data-testid="composer-input"
    │   └── 发送按钮                 data-testid="composer-send"   ← ★ 必须是 composer 的子孙
    └── ComposerToolbar              data-testid="composer-toolbar"
        ├── 模型芯片                 data-testid="composer-chip-model"
        ├── 思考强度芯片             data-testid="composer-chip-thinking"
        ├── MCP 芯片                 data-testid="composer-chip-mcp"
        ├── 弹性占位                 data-testid="composer-toolbar-spacer"   ← flex-1
        └── TokenStats               data-testid="token-stats"
            ├── 输入 / 输出 / 消耗 / 上下文  data-testid="token-stats-item-{input|output|total|context}"
            └── 段间细分隔线          data-testid="token-stats-divider"
```

---

## 三、★ 七个最容易做错的点

### 3.1 发送按钮必须在**输入框内部**右下角（验收 2-9 / 2-10）

- **DOM 上**：`composer-send` 必须是 `composer` 的**子孙节点**（`composer.contains(send) === true`）。
  把按钮放在输入框旁边的同级容器里 = 不通过，哪怕视觉上看着像。
- **几何上**：`send` 的矩形必须完全落在 `composer` 矩形内，且位于右下角（右侧 40%、下部 60% 的区域内）。
- **规格**：28×28 正圆（`SEND_BUTTON_SIZE`），`accent-soft` 底 + `accent` 描边箭头，`radius-full`。
- 输入框必须有可见边框（`border-border-default`）—— 否则「在内部」这个判定无从体现。

### 3.2 TokenStats 四段 + 只有「消耗」高亮（验收 2-13 / 2-14 / 2-15 / 2-16）

- 四段顺序固定：**输入 → 输出 → 消耗 → 上下文**，段间用 1px 细分隔线（`bg-border-subtle`）。
- 容器为 `bg-bg-subtle` 圆角容器，**靠右**：靠 `composer-toolbar-spacer` 这个 `flex-1` 占位把它推过去，
  不要用 `ml-auto` 之类把结构藏起来 —— 验收要能看见「弹性占位」这个节点。
- **只有「消耗」段用 `text-text-primary`**，其余三段用 `text-text-secondary`。
  验收脚本会现场注入 `text-text-primary` / `text-text-secondary` 探针元素比对计算色值，写错一定被抓。
- 数值格式化**必须走 `formatCompact`**（`src/lib/format.ts`，已冻结）：
  `12400 → 12.4k`、`128000 → 128k`（**不是 128.0k**）。

### 3.3 工具条顺序（验收 2-11）

`model → thinking → mcp → spacer → token-stats`，中间不要插别的可见元素。
芯片高 **32**（`TOOLBAR_CONTROL_HEIGHT`）——直接用现成的 `Chip`（它已经是 `h-8`），别自己写高度。

### 3.4 虚拟滚动 + Markdown：必须动态测量高度（验收 2-2 / 2-3）

`@tanstack/react-virtual` 的经典坑：**消息高度是动态的**（markdown、代码块、终端输出都会变高），
用固定 `estimateSize` 会滚动跳动、内容错位、甚至白屏。

- 必须给 `useVirtualizer` 传 `measureElement`，并在每个 item 上加
  `ref={virtualizer.measureElement}` + `data-index={virtualRow.index}`。
- `estimateSize` 只是个初值猜测，不代表最终高度。
- 代码块的异步高亮**会改变高度**，高亮完成后要能触发重新测量（`ResizeObserver` 由 `measureElement` 内置，
  别自己再包一层）。
- `message-list` 必须带 `data-total-count={messages.length}`（验收脚本要用它算「渲染数 ≪ 总数」）。
- 渲染出的每个消息根节点必须带 `data-testid="message-item"` + `data-message-id` + `data-role`。

### 3.5 自动滚底 + 用户上滚后停止（验收 2-5）

- 判据用 `AUTO_SCROLL_THRESHOLD`：`scrollHeight - scrollTop - clientHeight <= 阈值` 即视为「贴底」。
- `message-list` 带 `data-at-bottom="true|false"`，状态变化时同步（验收脚本直接读它）。
- **不在底部时**要出现 `scroll-to-bottom` 按钮，点击后回到底部。
- 用户上滚后**新消息到达不得把视口拽回底部** —— 这是本条的关键反例，必须实测。

### 3.6 Shiki 双主题：用 CSS 变量桥接，**不要写 Tailwind 的 `dark:`**（验收 2-4 + G2）

- 用 `themes: { light, dark }` 一次性渲染，Shiki 会输出 `--shiki-light` / `--shiki-dark` 两组变量。
- 桥接 CSS 放**新建的** `src/styles/shiki.css`，选择器用 `[data-theme="dark"]`
  （这是令牌机制本身的选择器，**不是** Tailwind 的 `dark:` 变体；`grep dark:` 命中数必须仍为 0）。
- `globals.css` 只允许加**一行** `@import "./shiki.css";`（必须紧跟在既有两个 `@import` 之后），
  其余一律不许动。
- **⚠️ 先实测确认 shiki 版本 API，不要照记忆写。** 装到的是 `shiki@4.4.3`，
  请直接读 `node_modules/shiki/package.json` 的 `exports` 与 README 确认入口
  （优先用体积可控的 `shiki/bundle/web` 之类的子入口，避免把全部语言主题打进产物）。
  实际用了哪个入口、产物体积多大，写进交接说明。
- 高亮器要**懒加载单例**（首次用到才 import），否则首屏会被几 MB 的 shiki 拖住。

### 3.7 长文本不破版（验收 2-18）

Markdown 正文里的**超长不可断字符串**（长路径、长 hash、长 URL）不能撑破容器。
需要 `overflow-wrap: anywhere` 级别的处理，且要覆盖 `<p>` / `<li>` / `<code>` / `<td>` 这些位置。
判定是「消息容器与 body 都没有横向溢出」，不是目测。

---

## 四、冻结的共享契约

### 4.1 已冻结、不要改的文件

| 文件 | 冻结内容 |
|---|---|
| `src/mock/types.ts` | 全部类型。只允许**新增可选字段**（并在注释里注明），不得改名或改语义 |
| `src/lib/format.ts` | `formatCompact` / `formatClock` / `truncateLines` |
| `scripts/cdp.mjs` | CDP 驱动（`withBrowser` / `SET_TEXT_HELPER` / `sleep`） |
| `src/components/shell/WorkspaceArea.tsx` | 主控已集成，别改 |
| `src/styles/tokens.css` | **既有色值一个都不许动**（已做过对比度校准） |

### 4.2 `chat-store` 的公开接口（Agent A 实现，Agent B 只读）

```ts
interface ChatState {
  messages: Message[];
  streaming: boolean;
  tokenUsage: TokenUsage;
  sessionTitle: string;
  sendMessage: (text: string) => void;      // B 用
  abortStream: () => void;                  // B 用（停止按钮，可选）
  resolveApproval: (requestId: string, choice: string) => void;
  loadSession: (session: Session) => void;  // App.tsx 的 ?stress=N 用
  reset: () => void;
}
```

允许新增字段（必须有默认值），**不得改名或删除**。

### 4.3 Agent A 的 testid 契约（验收脚本逐条依赖，必须一字不差）

| testid | 挂在什么元素上 | 附加 data 属性 |
|---|---|---|
| `message-list` | 滚动容器本身（唯一） | `data-total-count`、`data-at-bottom` |
| `message-item` | 每条渲染出的消息根节点 | `data-message-id`、`data-role`、`data-index` |
| `thinking-card` | 思考块容器 | — |
| `thinking-toggle` | 思考块展开/收起按钮 | `data-expanded="true\|false"` |
| `plan-card` | 执行计划卡片 | — |
| `plan-step` | 每个步骤行 | `data-status="pending\|running\|done\|failed"` |
| `terminal-card` | 终端卡片 | — |
| `terminal-command` | 命令行（等宽字体） | — |
| `terminal-output` | 输出容器（可滚动） | `data-truncated="true\|false"` |
| `terminal-toggle` | 输出展开/收起 | `data-expanded` |
| `terminal-expand` | 「查看完整内容」入口 | — |
| `approval-card` | 授权卡片 | `data-resolved="true\|false"` |
| `approval-option-0` / `approval-option-1` | 两个选项按钮（按 options 下标） | `data-option` |
| `code-block` | Shiki 渲染出的代码块容器 | — |
| `scroll-to-bottom` | 回到底部按钮 | — |
| `markdown-body` | 文本 Block 的 markdown 根节点 | — |

### 4.4 Agent B 的 testid 契约

| testid | 挂在什么元素上 |
|---|---|
| `composer` | **输入框本体**（带边框的那个容器） |
| `composer-input` | `textarea` |
| `composer-send` | 发送按钮（必须是 `composer` 的子孙） |
| `composer-toolbar` | 工具条根节点 |
| `composer-chip-model` / `composer-chip-thinking` / `composer-chip-mcp` | 三个芯片 |
| `composer-toolbar-spacer` | 弹性占位节点（`flex-1`） |
| `token-stats` | TokenStats 根容器 |
| `token-stats-item-input` / `-output` / `-total` / `-context` | 四段 |
| `token-stats-divider` | 段间细分隔线（可多个） |

---

## 五、硬约束（违反即 Blocker）

### 5.1 颜色（G1 / G2 / G5）

- **禁止**任何 `#hex` / `rgb()` / `hsl()` 字面量；一律走 `tokens.css` 的语义令牌
- **禁止** `dark:` 变体（深色靠令牌自动派生）
- **禁止** Tailwind 内置调色板（`bg-gray-*` / `text-black` / `bg-white` / `text-slate-*` …）
- 图标颜色用 `text-icon-neutral`（`--icon-neutral` 是唯一允许的固定色例外）
- 自检：搜 `#([0-9a-fA-F]{3,8})\b` → 预期**仅** `tokens.css` 命中；
  搜 `dark:` → 0 命中；搜 `bg-gray-` / `text-black` / `bg-white` → 0 命中

### 5.2 尺寸

- 一律从 `@/lib/layout.ts` 导入。**不要自己加新常量到这个文件**（它是共享文件，两个执行方同时改会冲突）。
  确实缺常量时：在**自己目录下**新建领域常量文件（A 用 `src/lib/chat-layout.ts`，B 用 `src/lib/composer-layout.ts`），
  并在交接说明里列出你新增了哪些值 —— 主控会在收尾时决定是否归并。

### 5.3 无障碍（G7）

- 图标按钮必须传 `label`；可切换状态的传 `active`
- **授权卡片被解决后两个选项都要 `disabled`**（验收 2-8 要求不可再点）
- 不要用 `outline: none` 覆盖焦点环
- 键盘 Tab 能走通主流程

### 5.4 组件写法

- `forwardRef` + `className` 透传 + `cn()` 合并（沿用现有 `Button` / `Chip` / `IconButton` 的写法）
- 注释用中文，风格与现有文件一致（重点解释「为什么」，不要复述「做了什么」）
- **不引入任何新依赖**：本阶段只允许 `@tanstack/react-virtual` / `react-markdown` / `remark-gfm` / `shiki`
  这四个（已装好）。不要再装 radix / clsx / date-fns / highlight.js 之类

### 5.5 不得破坏 M1（回归红线）

M1 的 13 条验收**必须仍然全绿**（主控会重跑 `npm run accept:m1` 验证）。特别注意：

- **不要碰** `TitleBar` / `Sidebar` / `SidebarFooter` / `WindowShell` / `TokensScreen`
- 不要在折叠相关的容器上引入 `border`（折叠态必须严格 0 宽，见 `task-M1.md` 3.4）
- 内容区新增的内容**不得引入横向滚动条**（G6）

---

## 六、明令禁止

1. **不要**改 `src/mock/types.ts` 的既有字段名或语义（只允许新增可选字段）
2. **不要**改 `src/lib/layout.ts` / `src/lib/format.ts` / `scripts/cdp.mjs` / `WorkspaceArea.tsx`
3. **不要**改 `tokens.css` 的既有色值
4. **不要**写 `dark:` 变体或硬编码色值去「快速修一下」深色问题
5. **不要**给 `message-list` 之外的节点当滚动容器（验收脚本只认它）
6. **不要**用 `display: none` 做任何折叠
7. **不要**为了「让验收过」把断言相关的 `data-*` 属性写死成常量 ——
   比如 `data-at-bottom` 必须反映真实滚动位置，不能永远返回 `true`。
   **凡是这类属性，主控会构造反例来验伪**（M1 的教训：一个永远不会失败的断言等于没有断言）
8. **不要**实现 M3 的预览区双 Tab、M4 的三屏、M5 的三端壳

---

## 七、完成后必须交付

### 7.1 A 产出 `.plan/m2-notes-A.md`、B 产出 `.plan/m2-notes-B.md`

必须包含：

1. **逐任务状态表**（对应第 1 节里属于你的那几行）
2. **你负责的验收项逐条实测证据** —— 每条给浏览器里量到的**实际数值/实际观察**，
   不接受「应该正确」。判定类要写清「用什么方法验的 + 观察结果」
3. **你做过的反例验证**（见第 6 节第 7 条）：至少对自己写的判定类属性做一次「喂坏数据应判 false」
4. **新增的常量**（如有，列在哪个文件、什么值、为什么）
5. **偏离规格之处**（如有，注明原因；没有就写「无」）
6. **留给主控/后续的问题**（不确定的、没实测的，如实列出 —— 「未实测」比「应该是好的」有价值得多）

### 7.2 完成判据

- `tsc --noEmit -p tsconfig.app.json` → **EXIT=0**
- `vite build` → EXIT=0
- G1 / G2 / G5 自检通过
- 你负责的验收项全部有实测证据
- 交接说明已写入 `.plan/m2-notes-{A|B}.md`

---

## 八、环境注意事项（很重要，照抄即可）

### 8.1 本机 shell 的坑

- **Bash 工具完全不可用**（缺 `ls` / `dirname` / `tail`，exit 127）。**用 PowerShell 工具**。
- **PowerShell 的 stdout 不回传**（只回 exit code）。取输出的可靠办法是**写文件再读**：
  ```powershell
  cd F:\DevelopWork\WorkBuddyWork\Tiktok_auto\packages\ui
  $out = & "C:\Users\myliu\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" node_modules\typescript\bin\tsc --noEmit -p tsconfig.app.json 2>&1
  "TSC_EXIT=$LASTEXITCODE" | Out-File -Encoding utf8 _chk.txt
  $out | Out-File -Append -Encoding utf8 _chk.txt
  ```
  然后用 Read 读 `_chk.txt`。用完删掉（用 `node -e "require('fs').unlinkSync('...')"`，`rm` 不可用）。
- Node 一律用**正斜杠 Windows 路径**调托管版本：
  `C:/Users/myliu/.workbuddy/binaries/node/versions/22.22.2-3/node.exe`
  不要用 `/c/...`（会被 Git Bash 改写）。包管理器是 **npm**（已锁 `npm@10.9.7`）。

### 8.2 起 dev server（两个执行方端口必须错开）

```powershell
cd F:\DevelopWork\WorkBuddyWork\Tiktok_auto\packages\ui
$env:Path = "C:\Users\myliu\.workbuddy\binaries\node\versions\22.22.2-3;" + $env:Path
& "C:\Users\myliu\.workbuddy\binaries\node\versions\22.22.2-3\npm.cmd" run dev -- --port <你的端口> --strictPort
```
用 `run_in_background=true` 起。**Agent A 用 5180，Agent B 用 5181。**

浏览器验证用 `scripts/cdp.mjs`（**Chrome 调试端口同样要错开：A 用 9334，B 用 9335**）：

```js
import { withBrowser, SET_TEXT_HELPER, sleep } from "./cdp.mjs";
await withBrowser({ port: 9334, origin: "http://127.0.0.1:5180", evidencePath: "_a-evidence.json" }, async (ctx) => {
  await ctx.open("/");
  ctx.assert("2-x_某某", { 某某布尔: (await ctx.cdp.eval("...")) === 0 });
});
```

- 系统 Chrome 在 `C:\Program Files\Google\Chrome\Application\chrome.exe`（**不要去下载 Chromium，会超时**）
- 不要用 `| tail` 这类管道；跑脚本用 `node.exe scripts/xxx.mjs`

---

## 九、分工详情

### 9.1 Agent A —— 消息流与卡片

**你负责的文件（只有这些）**

```
src/mock/sessions.ts                      重写（含 createStressSession）
src/mock/stream.ts                        新建
src/store/chat-store.ts                   重写（实现 ChatState）
src/lib/chat-layout.ts                    仅在确实需要新常量时新建
src/lib/highlight.ts                      新建（Shiki 懒加载单例）
src/styles/shiki.css                      新建（双主题桥接）
src/styles/globals.css                    只允许加一行 @import
src/components/common/Markdown.tsx        新建（react-markdown + remark-gfm + 代码块）
src/components/chat/MessageList.tsx       重写
src/components/chat/MessageBubble.tsx     新建
src/components/chat/ThinkingCard.tsx      新建
src/components/chat/PlanCard.tsx          新建
src/components/chat/TerminalCard.tsx      新建
src/components/chat/ApprovalCard.tsx      新建
```

**mock 会话数据的内容规格（验收脚本按这个写，请严格照做）**

首屏默认会话（`INITIAL_SESSION`，标题 `接入 Pi 工具链的调研`）按顺序包含 7 条消息，时间戳递增：

| # | role | Block | 必须满足 |
|---|---|---|---|
| 1 | user | text | 普通短句 |
| 2 | assistant | thinking + text | **text 必须覆盖七项 markdown**：二级标题、无序列表、有序列表、行内代码、代码块（ts）、表格、链接 |
| 3 | assistant | plan + tool_call | **plan 四态齐全**：`done` / `running` / `pending` / `failed` 各至少一步 |
| 4 | assistant | terminal | `status: "success"`，输出**超过 `TERMINAL_MAX_LINES` 行**，`truncated: true` + `hiddenLineCount` |
| 5 | assistant | approval | `options: ["允许", "拒绝"]`，`resolved` **为空**（未决） |
| 6 | user | text | 普通短句 |
| 7 | assistant | text + terminal | text 含**超长不可断字符串**（≥120 字符的长 hash 或长 URL，验收 2-18）；terminal 为 `status: "error"` 且 `exitCode: 1` |

`createStressSession(count)`：生成**恰好 count 条**轻量消息（文本为主，混少量 tool_call / terminal），
**不要**在压力会话里塞大段终端输出或代码块 —— 否则量的是渲染性能而不是虚拟滚动。

`sendMessage(text)` 的行为：

1. 同步追加一条 user 消息（TextBlock）
2. `streaming = true`，追加一条 assistant 消息，其 TextBlock 分片增长（打字机）
3. 结束时 `streaming = false`，并更新 `tokenUsage`（input/output/total 按内容长度合理估算）
4. **一次回复的流式总时长 ≤ 2 秒**（验收脚本要等它结束，别做成长篇大论）
5. `abortStream()` 能立即中止并把已产出的内容定格

### 9.2 Agent B —— 输入区与统计

**你负责的文件（只有这些）**

```
src/mock/composer.ts                      新建（模型清单 / 档位 / MCP 服务器 / 初始用量）
src/lib/composer-layout.ts                仅在确实需要新常量时新建
src/components/chat/Composer.tsx          重写
src/components/chat/ComposerToolbar.tsx   重写
src/components/common/TokenStats.tsx      新建
```

**行为规格**

- **Composer**
  - `textarea` 自适应多行：内容变高则容器变高，**上限 `COMPOSER_MAX_HEIGHT`**，到顶后输入框内部滚动
  - 高度必须真的随内容变（验收 2-17 会量单行态 vs 10 行态的实际高度）
  - 发送按钮：28×28 正圆、`accent-soft` 底 + `accent` 箭头、**在输入框内部右下角**（见 3.1）
  - 发送：有内容才可发；`sendMessage(text)` 后清空输入框
  - `streaming` 为 true 时：发送按钮切换成「停止」（调 `abortStream`），或禁用发送 —— 二选一，但必须让状态可见
  - 键盘：Enter 发送、Shift+Enter 换行（**原型里 Enter 发送是加分项，若与验收冲突以验收为准**）
  - 无内容时发送按钮禁用（`disabled`）
- **ComposerToolbar**
  - 顺序：`model → thinking → mcp → spacer → token-stats`（见 3.3）
  - 三个芯片点击可循环切换值（原型内闭环，不弹菜单）：
    模型在 `mock/composer.ts` 的模型清单里循环；思考强度在 `low → high → max` 循环；
    MCP 芯片显示形如 `MCP 4`（4 = 已连接服务器数）
  - 芯片用现成的 `Chip` 组件（已是 `h-8` = 32）
- **TokenStats**
  - 从 `useChatStore` 读 `tokenUsage`（A 会更新它）
  - 四段 + 细分隔线 + **仅「消耗」用 `text-text-primary`**（见 3.2）
  - 数值走 `formatCompact`
  - 容器 `bg-bg-subtle` + 圆角；在工具条里靠右（右侧那个 `spacer` 负责推）

---

## 十、交接备注

- 这是**纯前端原型**阶段：不接 Pi、不接 LLM、不接后端、不做 Electron 壳
- 当前只有 `packages/ui` 一个包，**暂不搭 monorepo**
- 设计稿在 Ardot（fileId `728255468414716`），但**当前会话无设计稿读写工具**，
  以本规格书 + `screens.md` + `design-tokens.md` 为准
- 你看到的 `Composer` / `ComposerToolbar` / `MessageList` 等文件里写着「接口桩」——
  那是主控为了并行开发打的桩，**你负责的那个直接整份替换实现**，不属于你的不要动
