# M4 执行规格书 · 其余三屏（03 运行详情 / 04 技能与工具 / 05 设置）

> 派发日期：2026-09-22
> 执行方：general-purpose agent（单人；三屏共享同一套路由与常量改动，拆并行会撞 App.tsx / layout.ts，不拆）
> 配套：[development-plan.md](./development-plan.md) 第三节 M4 · [acceptance-criteria.md](./acceptance-criteria.md) M4 表 · [screens.md](./screens.md) 03/04/05 节 · [progress-M3.md](./progress-M3.md) 第九节（教训）
> 前置：M0–M3 已完成并通过主控独立复核（见 progress-M3.md 第十节）

---

## 〇、背景与范围

M0–M3 已完成：三栏骨架、会话工作台、预览区双 Tab 与深色版均已验收。M4 补齐**其余三屏**：

| # | 任务 | 产出 | 计划工时 |
|---|---|---|---|
| 4.1 | 03 运行详情：步骤时间轴 + 耗时 + 输入输出摘要 | `src/screens/RunDetailScreen.tsx` | 3h |
| 4.2 | 04 技能与工具：技能列表 / 工具开关 / MCP 服务器列表 | `src/screens/SkillsScreen.tsx` | 3h |
| 4.3 | 05 设置：模型、思考强度、会话、外观、工作目录 | `src/screens/SettingsScreen.tsx` | 2.5h |

**范围内**：以上三屏 + 为此需要的路由扩展（App.tsx）、store 小改、layout.ts 新增常量段、mock 数据新增。
**范围外**：不动 01/02/01b 三屏的既有行为；不动 `Sidebar` / `TitleBar` / `WindowShell` /
`MessageList` / `Composer` / `PreviewPane` 的既有实现；不接 Pi；不接 LLM；不做 Electron 壳；
不改 `tokens.css` 的既有令牌值；不新增 npm 依赖。

**完成判据**（development-plan.md 原文）：三屏能走通；04 屏的字段与 Pi 的 `get_commands`
三类对齐；05 屏与 `SettingsManager` 对齐，为接入做准备。
⚠️ **04 屏的 MCP 区块是自建能力的展示位——Pi 不内置 MCP**，这是刻意的能力补位，不是"照抄 Pi"。

---

## 一、现状与集成点（动手前必读）

1. **路由现状**：`src/App.tsx` 是极简 hash 路由，`ScreenId = "workbench" | "tokens"`，
   `readScreen()` 只认 `#/tokens`，其余一律回落 workbench。文件头注释已预告
   「M4 扩到 8 屏时再评估换成 react-router」。
   **本轮决策：仍不引入 router**（见第四节禁止项）。扩法：把 `ScreenId` 扩到 5 个值
   （`workbench` / `run-detail` / `skills` / `settings` / `tokens`），`readScreen()` 改成查表。
2. **两个既有 URL 参数入口是模式范本**：`applyStressParam()`（`?stress=N`）与
   `applyPreviewTabParam()`（`?preview=code|effect`）。M4 新增的深链参数照抄这个形状：
   在 `useEffect` 里读一次、不存在时什么都不做。
3. **`src/screens/` 目前只有 `TokensScreen.tsx`**，它是唯一的"页面级"范本：
   `sticky` header + 返回按钮 + `Section` 组件 + `space-y-*` 纵向分组 + `bg-bg-app`。
   三屏沿用这个页面结构，但**三屏是"工作台里的一块"而不是"独立全屏页"** ——
   见第 4 点。
4. **★ 三屏的容器归属（本轮最大的设计判断，先看懂再动手）**：
   03/04/05 屏在原型里是**独立可访问的路由**，但视觉上应保持与工作台一致的应用外观。
   两种做法：
   - (a) 复用 `WindowShell`（带 TitleBar + 三栏），三屏内容替换其中一栏；
   - (b) 像 `TokensScreen` 那样做一个独立全屏页。

   **本轮采用 (a) 的简化版**：三屏各自渲染 `<WindowShell>` + `Sidebar` + 自己的内容区，
   **不渲染 `PreviewPane`**（这三屏与预览无关，占 480px 只会挤压内容）。
   理由：① 三屏是"应用的三个功能页"，保留侧边栏才有应用感（TokensScreen 是体检页，
   性质不同，保持原样）；② 复用 WindowShell 才能让 G4/G6 与 06 屏将来能覆盖它们；
   ③ 改动面小，不动任何既有 shell 组件。
   **注意**：`Sidebar` 的 `footer` 传 `SidebarFooter` 以保持条带通底（验收 1-3 已锁定的结构），
   照 `WorkbenchScreen` 的写法抄。
5. **必须复用的既有件（不要重写）**：
   - 原语：`Button`（`variant: primary|secondary|ghost|danger`、`size: sm|md`）、
     `Chip`（`variant: neutral|accent|outline` + `selected`）、`IconButton`（`label` 必填）、
     `Tabs`（headless，泛型 `<T extends string>`）—— 全部从 `@/components/primitives` 引。
   - 图标：一律走 `components/common/icons.tsx` 的 `Icon`（size 16 / strokeWidth 1.75 /
     `--icon-neutral`）。**M4 需要但尚未进清单的图标必须先加进 `ICON_INVENTORY`**
     （见 4.2 的图标清单）。
   - 卡片：`chat/PlanCard.tsx`（`STATUS_META` 四态：done/running/pending/failed）、
     `chat/TerminalCard.tsx`（`data-truncated` / `terminal-expand` 展开入口）——
     **03 屏明确要求复用这两个组件**（screens.md 原文：「数据复用 `TerminalCard` 与
     `PlanCard` 的组件，只是排布不同」）。
   - 行样式范本：`Sidebar.tsx` 里的 `MenuItem` / `SectionLabel`（`h-8` + `rounded-md` +
     `hover:bg-bg-hover`）。这两个是 Sidebar 内部私有函数，**不要导出复用，照样式另写**。
6. **数据源尽量复用、不要另造**（`mock/composer.ts` 已有 M4 直接可用的东西）：
   - `COMPOSER_MODELS`（5 个 `ModelOption`）→ 05 屏模型选择 + 04 屏无关
   - `COMPOSER_THINKING_LEVELS`（`["low","high","max"]`）+ `THINKING_LABEL`（全集映射）→ 05 屏
   - `COMPOSER_MCP_SERVERS`（4 个 `McpServer`）+ `MCP_CONNECTED_COUNT` → 04 屏 MCP 区块
   - `INITIAL_SESSION`（含 plan 四态 + terminal success/error 两条）→ 03 屏步骤数据
   - `INITIAL_TOKEN_USAGE` → 05 屏如需展示上下文用量
   **新增数据一律放新的 `src/mock/` 文件**（建议 `mock/skills.ts` 与 `mock/settings.ts`），
   **不要改 `mock/types.ts`**（M2 冻结契约）—— 新类型定义在各自 mock 文件里，
   或按契约允许的方式"只新增可选字段"。
7. **`lib/layout.ts` 只有"新增"权限**：既有常量的值一个字都不能改（M3 刚验收过）。
   M4 新增常量段的写法照 M2/M3 段的注释风格，把"为什么是这个值"写清楚。
8. **`lib/cn.ts` 的 `flex`/`flex-col` 分组**：同传时已能正确分组，但**新增代码里不要引入
   它没覆盖的同前缀异方向组合**，不确定就分开传（M3 的坑）。

---

## 二、任务拆解与实现要求

### 4.1 · 03 运行详情（`screens/RunDetailScreen.tsx`，约 3h）

**内容**：一次 Agent 运行的完整步骤视图。screens.md 原文：「时间轴或步骤列表，每步含状态、
耗时、输入/输出摘要、可展开的完整结果」。

**结构要求**：

- 页面头：运行标题（如「接入 Pi 工具链的调研 · 运行 #1」）+ 汇总（总步数 / 成功 / 失败 /
  总耗时）+ 返回工作台按钮（`Button variant="ghost" size="sm" icon={ArrowLeft}`）。
- 主体：**纵向时间轴**。左列是时间轴轨道（节点圆点 + 连接线），右列是每步的内容卡。
  轨道用绝对定位伪元素或单纯一个左侧 `border-l` + 圆点，**不要引入新依赖**。
- 每步一行，含：
  - 序号 + 步骤名 + 状态徽标（状态色沿用 `PlanCard` 的语义映射：done→`text-success`、
    running→`text-accent`、pending→`text-text-tertiary`、failed→`text-danger`）
  - **耗时**（如 `1.2s` / `340ms`）—— 由 mock 数据直接给，不要在组件里做格式化逻辑之外的运算
  - **输入 / 输出摘要**（各一行，超出截断）
  - **可展开的完整结果**：用 `<details>` 或受控展开均可，展开后渲染完整输出。
    **要求**：展开态渲染 `TerminalCard`（命令类的步骤）或 `PlanCard`（计划类的步骤），
    以此满足"复用组件"的硬要求。
- testid 契约（验收脚本按此断言，**必须逐条实现**）：
  | testid | 挂在 | 语义 |
  |---|---|---|
  | `run-detail-screen` | 屏根容器 | 03 屏存在 |
  | `run-step` | 每个步骤行 | 步骤条数 = `data-step-count` |
  | `data-status` | 每个 `run-step` 上 | 四态之一，且**四态在 mock 里必须齐全** |
  | `run-step-duration` | 耗时节点 | 文本含数字 + 单位 |
  | `run-step-summary` | 摘要节点 | 输入/输出摘要 |
  | `run-step-toggle` | 展开按钮 | `data-expanded` 同步 |
  | `run-step-detail` | 展开区容器 | 展开后才渲染 |
  | `data-step-count` | 屏根或时间轴容器 | 步骤总数，供脚本与 `run-step` 数比对 |

**边界要求**：长输出**不得撑破容器**（内层 `overflow-auto` + `min-w-0`）；
展开/收起是条件渲染而不是 `display:none`（M2 的既定做法）。

### 4.2 · 04 技能与工具（`screens/SkillsScreen.tsx`，约 3h）

**内容**：三个分区，顺序固定 —— **技能列表 → 工具开关 → MCP 服务器列表**。

**① 技能列表**：对应 Pi 的 `get_commands` 三类 `extension` / `prompt` / `skill`。
- 用 `Tabs`（`primitives/Tabs.tsx`）做三分类切换？**不**。分类应**同时可见**（验收 4-2 要
  「分类对应三类」，脚本要能在一次页面加载里读到三类），所以做成**三个分组段落各自带小标题
  与条数**，每类下面列条目（名称 + 一行描述 + 可选来源标记）。
- 每个条目给 `data-skill-type="extension|prompt|skill"`，容器给 `data-testid="skill-item"`。
- 分组标题旁给条数，供脚本核对（如 `data-testid="skill-group-count"`）。
- **三类都必须有非空数据**（验收 4-2 的核心）。

**② 工具开关**：对应 Pi 的 `tools` allowlist：`read` / `bash` / `edit` / `write` 四个。
- 每个工具一行：图标 + 名称 + 一行说明 + **开关**。
- 开关用 `role="switch"` + `aria-checked` 的 `button`（**不要用 checkbox 打样式**，
  也**不要引入 Radix Switch**）。视觉：`accent` 底表示开启。
- 点击可切换，状态变化必须反映到 `aria-checked` 与 `data-enabled`。
- testid：`tool-toggle`（每个开关）、`data-tool-name`（如 `"bash"`）、`data-enabled`。
- 状态存放：**进 `ui-store`**（局部 `useState` 在验收脚本里也能读，但 store 更符合
  "开关要能被其它屏读"的语义；两选一即可，**若进 store 必须同时做 localStorage 持久化**，
  照 `readStoredFlag` / `persistFlag` 的既有模式写）。
  默认值：`read`/`edit`/`write` 开启，`bash` 开启（四个全开，最简单且与 Pi 默认 allowlist 一致）。

**③ MCP 服务器列表**：数据直接用 `COMPOSER_MCP_SERVERS`。
- 每行：名称 + 状态（`connected` → `text-success` / `disconnected` → `text-text-tertiary`）
  + 工具数（如「6 个工具」）。
- testid：`mcp-server`、`data-mcp-name`、`data-mcp-status`。
- **必须在此区块放一句明确的说明文字**：MCP 是本项目的**自建能力**，Pi 不内置。
  这句话是给后来接 Pi 的人看的，别省。

**图标**：`read`→`FileText`、`bash`→`Terminal`、`edit`→`Pencil`、`write`→`Package`；
技能组标题→`Blocks`(extension) / `MessageSquare`(prompt) / `Sparkles`(skill)；
MCP→`Database`。以上**均在 `ICON_INVENTORY` 的 import 清单里已有**，
`ICON_INVENTORY` 数组若缺则补进去（00 屏体检页会显示清单，属于应当同步的地方）。

### 4.3 · 05 设置（`screens/SettingsScreen.tsx`，约 2.5h）

**内容分组（顺序即验收 4-5 的顺序）**：模型 → 思考强度 → 会话 → 外观 → 工作目录。

| 分组 | 字段 | 数据/对齐目标 | 交互 |
|---|---|---|---|
| 模型 | 当前模型（label + provider） | `COMPOSER_MODELS` / `ModelOption` | 单选列表或 `Chip` 组，选中态写入 store |
| 思考强度 | 档位 | `COMPOSER_THINKING_LEVELS` + `THINKING_LABEL` | 分段选择（`Chip` 组即可），选中写入 store |
| 会话 | 自动压缩 / 自动重试 | 对齐 Pi 的 `SettingsManager` 语义 | 两个开关，`role="switch"` + `aria-checked` |
| 外观 | 主题（浅色 / 深色 / 跟随系统） | `useUiStore` 的 `theme` + `themeSource` | 三段选择；**必须走既有 `setTheme` / `syncSystemTheme`**，不要自己写 DOM 操作 |
| 工作目录 | 路径 | mock 字符串 | 展示 + 「更改」按钮（原型里可不实现选择器，按钮可空实现但要可点） |

**字段对齐要求（验收 4-6）**：每个字段行的**说明文本里要带上对齐 Pi 的字段名**，
让"对齐"这件事在 UI 上可核对。例如：
- 模型行注 `对齐 AgentOptions.model`
- 思考强度注 `对齐 set_thinking_level`
- 自动压缩注 `对齐 SettingsManager.autoCompact`、自动重试注 `SettingsManager.autoRetry`
- 工作目录注 `对齐 AgentOptions.cwd`
⚠️ 若不确定 Pi 的确切字段名，**照 development-plan/screens.md 里已写明的名字用**，
不要凭空发明；发明出来的名字比不写更糟。

**外观分组的主题切换必须复用 store**：`setTheme("light"|"dark")` + `themeSource: "system"`
时用 `syncSystemTheme()`。**不要直接改 `document.documentElement.dataset.theme`** ——
那会绕过 `ui-store` 的持久化，"首帧前确定"的既有约定就破了。

**testid 契约**：
| testid | 挂在 | 语义 |
|---|---|---|
| `settings-screen` | 屏根 | 05 屏存在 |
| `settings-group` | 每个分组 | `data-group` = `model|thinking|session|appearance|working-dir` |
| `settings-model-option` | 每个模型项 | `data-active` |
| `settings-thinking-option` | 每个档位 | `data-active` |
| `settings-switch` | 会话开关 | `data-field` = `autoCompact|autoRetry` + `aria-checked` |
| `settings-theme-option` | 主题三段 | `data-theme-value` = `light|dark|system` + `data-active` |
| `settings-working-dir` | 工作目录行 | 文本含路径 |

**验收 4-5 的判定方式预期**：脚本会检查五个 `settings-group` 的 `data-group` 集合
是否等于要求的五项。**顺序与命名都要对。**

---

## 三、高危点（真实踩过的坑，必读）

1. **同文件并行 Edit 会静默丢改动**（M3 事故，`ui-store.ts` 与 `App.tsx` 各丢一批）。
   对 `App.tsx` / `ui-store.ts` / `layout.ts` 这三个"三屏都要碰"的文件，
   **一律串行改，或用一次全量 Write**。改完**重新 Read 全文**核对，不要相信成功回执。
2. **`tsc --noEmit` 裸口径是假绿**（references 型 tsconfig）。真实口径：
   `tsc --noEmit -p tsconfig.app.json`（`npm run typecheck` 已修正为这个，M3 主控决策）。
3. **不要自己写 `m4-acceptance.mjs`**：验收脚本由主控（非实现方）编写，M2 定下的规矩
   （自写脚本曾制造 7 个假失败）。你只需把上面第二节的 testid / data 属性暴露好。
4. **`tokens.css` 的 23 个双模式令牌值、`layout.ts` 既有常量、`mock/types.ts` 字段** ——
   三类"只读"。M4 需要新值时**新增**，不改既有。
5. **不要为了排版方便硬编码尺寸数字**（如 `style={{ width: 320 }}`）。尺寸进 `layout.ts`
   新增常量段，组件里引常量（9.2 工程约定，M0 起就是硬约束）。
6. **不要引入 router / Radix / 任何新依赖**。`App.tsx` 的 hash 路由扩到 5 个值是几行代码的事，
   `Tabs` 已经是自研的，开关用原生 `role="switch"` 即可。包依赖段保持冻结。
7. **响应式（验收 4-7）**：左右栏折叠时三屏布局要正常、无横向溢出。
   要点：内容区容器给 `min-w-0`；任何横向排布（表格/多列）在窄宽下要么换行要么内部滚动；
   **不要出现 `w-[1200px]` 这类固定宽度**。判定是「视口 + 折叠态组合下
   `document.documentElement.scrollWidth <= clientWidth`」。
8. **`Icon` 的 `label` / 可访问性**：`IconButton` 的 `label` 必填；纯装饰图标走 `Icon`
   （自带 `aria-hidden`）。开关类控件必须有可读名称（`aria-label` 或可见文字），
   否则 G7 会被判不达标。

---

## 四、明令禁止（违反即返工）

- `dark:` 变体（Tailwind 或 CSS 选择器）—— G2，M0–M3 一直是 0 容忍
- 组件 / 非 `tokens.css` 文件出现 `#hex`（G1）
- 使用 Tailwind 内置调色板（`bg-slate-800` 之类）—— G5，只用令牌类
- 组件内硬编码尺寸数字（必须走 `layout.ts` 常量）
- 引入新运行时依赖（router / Radix / AntD / headlessui 等一律不要）
- 改 `mock/types.ts` 的既有字段名与语义（M2 冻结契约）
- 改 `tokens.css` 既有令牌值、改 `layout.ts` 既有常量值
- 改 01/02/01b 三屏与 `Sidebar`/`TitleBar`/`WindowShell`/`PreviewPane` 的既有实现
- 动 `scripts/m1-*.mjs`、`m2-acceptance.mjs`、`m3-acceptance.mjs`、`cdp.mjs`（验收基线）
- 让新屏出现横向滚动条（G6）

---

## 五、自验最低要求（做完必须全跑，如实记录 exit code）

```bash
# 以下命令都在 packages/ui 下执行
npm run typecheck          # 必须 EXIT=0（已是 -p tsconfig.app.json 口径）
npm run build              # 必须 EXIT=0，记录 modules 数与主包体积
npm run accept:m1          # M1 红线回归。先起 dev server：
                           #   npm run dev -- --port 5180 --strictPort
npm run accept:m2          # M2 回归（M2_ORIGIN=http://127.0.0.1:5180 可复用 5180）
npm run accept:m3          # M3 回归（M3_ORIGIN 同法复用 5180；CDP 端口 9341）
npm run check:cn           # cn() 回归 15 条
```

- **手工浏览器走查（必须做，逐项记录实测值）**：
  1. 三屏各自能通过 hash 进入（`#/run-detail`、`#/skills`、`#/settings`），
     且返回按钮能回工作台。
  2. 03 屏：步骤四态齐全、耗时可见、展开收起正常、长输出在容器内滚动。
  3. 04 屏：技能三类都有内容；四个工具开关点击后 `aria-checked` 翻转；
     MCP 区块存在且有"自建能力"说明。
  4. 05 屏：五个分组齐全且顺序正确；主题三段切换**真的换肤**（`<html data-theme>` 变化）
     且刷新后保留；工作目录路径可见。
  5. **深浅两模式各走一遍三屏**，抽查是否有白底黑字 / 不可读处。
  6. **左右栏折叠组合下三屏无横向溢出**（用 devtools 量
     `documentElement.scrollWidth` vs `clientWidth`）。
- 浏览器用系统 Chrome（见第六节）。**如实报告未实测项** ——
  留在盘上但没自验的代码 = 未验证资产（M2 铁律）。

---

## 六、环境注意事项（本机实测结论，别再踩）

- node 全路径：`"C:/Users/myliu/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"`，
  **正斜杠 Windows 路径**，不要 `/c/...`（会被 Git Bash 改写）。
- Bash 工具缺 `ls` / `tail` / `dirname` 等，且 stderr 恒有两行噪音（不影响 exit code）；
  **别用管道**。
- PowerShell：stdout 常不回传（只回 exit code）→ 重要输出写临时文件再 Read。
  `cmd.exe` 被安全策略拦截，用原生 PowerShell 语法（`$LASTEXITCODE` 取退出码）。
  `npm.ps1` 会被执行策略拦截，**用 `npm.cmd`**。
  若把 npm 输出重定向到文件，`*>` 会写成 UTF-16 导致 Read 报
  `Cannot display content of binary file`；修法：
  `Get-Content -Raw` → `-replace '[^\x20-\x7E\r\n]',''` → `Out-File -Encoding ascii`。
- 包管理器是 **npm**（10.9.7，已锁在 package.json 的 `packageManager`）。
- 浏览器走查：`"C:\Program Files\Google\Chrome\Application\chrome.exe"`，
  headless + CDP 可用。**CDP 调试端口 M4 用 9342**
  （9333 = m1、9337 = m2、9341 = m3，别撞）。残留僵尸 Chrome 会占端口，
  表现为"连上但无响应"，先用 `/json/version` 区分。
- 工作目录：代码在 `F:\DevelopWork\WorkBuddyWork\Tiktok_auto\packages\ui`，
  本规格书与进度文档在 `F:\DevelopWork\WorkBuddyWork\Tiktok_auto\.plan\`。

---

## 七、交付要求

1. **代码文件（预计，允许合理增删）**：
   - 新 `src/screens/RunDetailScreen.tsx`
   - 新 `src/screens/SkillsScreen.tsx`
   - 新 `src/screens/SettingsScreen.tsx`
   - 新 `src/mock/skills.ts`（技能三类 + 工具四项 + 复用 MCP）
   - 新 `src/mock/settings.ts`（设置分组数据 + 默认值；会话开关默认值等）
   - 改 `src/App.tsx`（`ScreenId` 扩到 5 值 + `readScreen()` 查表 + 深链参数）
   - 改 `src/store/ui-store.ts`（工具开关 / 设置字段的持久化；**串行改，改完重读**）
   - 改 `src/lib/layout.ts`（**新增** M4 常量段，不动既有值）
   - 改 `src/components/common/icons.tsx`（按需把新用到的图标补进 `import` 与 `ICON_INVENTORY`）
   - 按需新 `src/components/screens/` 下的小组件（如 `StepTimeline` / `SwitchRow`），
     若确实共用于多屏才抽；单屏内联即可，别过度抽象
2. **产出 `.plan/progress-M4.md`**（仿 `progress-M3.md` 结构）：
   逐任务状态表 / 自验实测证据（命令 + exit code + 关键数值）/ 偏离规格及理由 / 遗留项 /
   **本轮教训**。**验收 4-1~4-7 的逐条结论留给主控复核定稿，你写"待主控复核"。**
3. **testid 契约表**（写进 progress-M4.md，供主控写验收脚本）：

| 验收项 | 判定预期 | 依赖的 testid / 特征 |
|---|---|---|
| 4-1 03 屏可读 | 步骤时间轴完整、四态齐、耗时 + 输入输出摘要 | `run-detail-screen`、`run-step` + `data-status`（四态）、`run-step-duration`、`run-step-summary`、`run-step-toggle` + `data-expanded`、`run-step-detail`、`data-step-count` |
| 4-2 04 技能分类 | 三类都存在且有内容 | `skill-item` + `data-skill-type`（extension/prompt/skill 三类齐）、`skill-group-count` |
| 4-3 04 工具开关可用 | 四个开关可切换且状态可读 | `tool-toggle` + `data-tool-name`（read/bash/edit/write）+ `aria-checked` + `data-enabled` |
| 4-4 04 MCP 区块存在 | 有列表位 + 自建能力说明 | `mcp-server` + `data-mcp-name` / `data-mcp-status`，区块内含"自建能力"文案 |
| 4-5 05 分组完整 | 五个 `data-group` 齐全且顺序正确 | `settings-group` + `data-group` ∈ {model, thinking, session, appearance, working-dir} |
| 4-6 05 字段对齐 Pi | 字段名可在 UI 读到 | 各分组说明文本含 `AgentOptions.model` / `set_thinking_level` / `SettingsManager.autoCompact` / `autoRetry` / `AgentOptions.cwd` |
| 4-7 三屏响应式 | 折叠组合下无横向溢出 | 三屏根容器 + `min-w-0`；`documentElement.scrollWidth <= clientWidth` |

---

## 八、给你的一句提醒

三屏本身不难，难在**别把 M0–M3 已经验收过的东西碰坏**。
M1 的折叠三断言（1-10 / 1-12 / 1-13）、M3 的 5 条 `accept:m3` 断言是红线，
你的改动只要碰了 `WindowShell` / `Sidebar` / `App.tsx` 的既有分支，跑回归时就要重点看它们。

优先级：**先让三屏都能走通（完成判据），再打磨细节**。三屏全绿 + 回归全绿 > 某一屏做得极精致
但另一屏进不去。
