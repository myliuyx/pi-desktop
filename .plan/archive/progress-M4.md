# M4 进度与验收记录

> 更新日期：2026-09-22
> 里程碑：**M4 · 运行详情 / 技能与工具 / 设置三屏**（计划净工时 10h）
> 配套：[task-M4.md](./task-M4.md) · [development-plan.md](./development-plan.md) 第三节 M4 · [acceptance-criteria.md](./acceptance-criteria.md) M4 表 4-1~4-7 · [progress-M3.md](./progress-M3.md)（教训）
> 执行方：general-purpose agent（m4-screens，单人实现）；本文档由执行方撰写，
> **验收 4-1~4-7 的逐条结论留给主控复核定稿**，实现方仅提供实测数据。

---

## 一、结论

**M4 三屏（03 运行详情 / 04 技能与工具 / 05 设置）代码已全部落地，
`tsc -p tsconfig.app.json` 与 `vite build` EXIT=0，
M1（红线回归）/ M2 / M3 三条回归全绿，`check:cn` 15/15，
实现方自查走查 30/30 断言通过。** 可交主控复核。

| 项目 | 结果 |
|---|---|
| 03 运行详情（`screens/RunDetailScreen.tsx`） | ✅ 已实现并实测 |
| 04 技能与工具（`screens/SkillsScreen.tsx`） | ✅ 已实现并实测 |
| 05 设置（`screens/SettingsScreen.tsx`） | ✅ 已实现并实测 |
| hash 路由扩到 5 值（`App.tsx`，查表式 `readScreen()`） | ✅ 已实现并实测（含非法值回落） |
| `tsc --noEmit -p tsconfig.app.json` | **EXIT=0**（真实口径） |
| `vite build` | **EXIT=0**（2060 modules，主包 `index-CuJsqb4N.js` 515.29 kB / gzip 158.23 kB，CSS 28.65 kB / gzip 6.63 kB，built in 6.27s） |
| `npm run check:cn` | **EXIT=0**（15/15） |
| `npm run accept:m1`（**红线回归**） | **EXIT=0**（1-10 中间帧 4、1-12 内容区 1424、1-13 严格 0 宽，三条红线均成立） |
| `npm run accept:m2`（复用 5180） | **EXIT=0** |
| `npm run accept:m3`（复用 5180，CDP 9341） | **EXIT=0**（五条 `accept:m3` 断言全 `[PASS]`） |
| 实现方自查走查（30 组断言，CDP 9342） | **30/30 通过**（证据 `packages/ui/_m4-walkthrough.json`） |
| 新增 npm 依赖 | **0** |
| 遗留 Blocker / Major（实现方自查口径） | **0** |

---

## 二、执行方式

严格按 task-M4.md 的 4.1 → 4.2 → 4.3 串行推进，每个任务完成后即跑 typecheck 再进下一步。

规格书里已替实现方定好、明令不得推翻的四个关键判断，全部照办：

1. **不引入 router**：`ScreenId` 由 2 值扩到 5 值，`readScreen()` 改**查表**（`SCREEN_BY_HASH`），非法值回落 `workbench`。
2. **三屏容器结构**：各自渲染 `<WindowShell>` + `<Sidebar>`（含 `SidebarFooter` 通底）+ 自己的内容区，**不渲染 `PreviewPane`**。
3. **数据复用**：`COMPOSER_MODELS` / `COMPOSER_THINKING_LEVELS` / `THINKING_LABEL` / `COMPOSER_MCP_SERVERS` 从 `mock/composer.ts` 复用；新数据只放 `mock/skills.ts` 与 `mock/settings.ts`；**未改 `mock/types.ts`**。
4. **03 屏必须复用** `chat/PlanCard.tsx` 与 `chat/TerminalCard.tsx`；**05 屏主题切换必须走既有 store**（`setTheme` / `useSystemTheme`），不自己改 `document.documentElement.dataset.theme`。

**改既有文件一律串行 + 改完重新 Read 全文核对**（M3 教训 1 的直接落实）：`App.tsx`、`ui-store.ts`、`layout.ts`、`icons.tsx` 四个文件均逐个串行改，`ui-store.ts` 改完用 node 脚本做了 12 项结构完整性自查（含 interface 声明、create() 实现体、`initTheme` 恢复三处必须同源），`ALL=true`。

---

## 三、逐任务状态

| # | 任务 | 产出文件 | 状态 |
|---|---|---|---|
| 4.1 | 03 运行详情屏 | 新 `screens/RunDetailScreen.tsx`、新 `mock/runs.ts`、新 `components/screens/ScreenLayout.tsx`、改 `lib/layout.ts`（M4 常量段）、改 `App.tsx` | ✅ |
| 4.2 | 04 技能与工具屏 | 新 `screens/SkillsScreen.tsx`、新 `mock/skills.ts`、新 `components/screens/Switch.tsx`、改 `store/ui-store.ts`（`enabledTools` / `toggleTool`） | ✅ |
| 4.3 | 05 设置屏 | 新 `screens/SettingsScreen.tsx`、新 `mock/settings.ts`、改 `store/ui-store.ts`（`modelId` / `thinkingLevel` / `sessionSwitches` / `workingDir` / `useSystemTheme`）、改 `components/common/icons.tsx`（补 `ArrowLeft`） | ✅ |

**`layout.ts` 新增常量（M4 段，未动任何既有值）**：
`SCREEN_PADDING=24`、`SCREEN_HEADER_HEIGHT=64`、`SCREEN_SECTION_GAP=24`、`SCREEN_ROW_GAP=10`、
`TIMELINE_RAIL_WIDTH=28`、`TIMELINE_DOT_SIZE=10`、`RUN_STEP_SUMMARY_MAX_HEIGHT=88`、
`RUN_STEP_DETAIL_MAX_HEIGHT=420`、`SETTINGS_LABEL_WIDTH=148`、
`SWITCH_WIDTH=36`、`SWITCH_HEIGHT=20`、`SWITCH_KNOB_SIZE=16`、`SWITCH_KNOB_INSET=2`。

**实现要点**：

- **三屏共用外壳 `components/screens/ScreenLayout.tsx`**：导出 `ScreenArea`（`<main>`，`flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg-app`）/ `ScreenHeader`（标题 + 副标题 + `screen-back` 返回按钮）/ `ScreenBody`（`overflow-y-auto` + `SCREEN_PADDING`，内层再套 `min-w-0 flex flex-col`）/ `ScreenSection`。抽这一层是为了让三屏的内边距、滚动容器、`min-w-0` 三处最容易写错的骨架只写一遍。
- **03 屏时间轴**：每步 `<li data-testid="run-step" data-status data-step-id>`，内含固定宽（`TIMELINE_RAIL_WIDTH`）的轨道列（圆点 `absolute` 定位 + 1px `w-px` 连接线，**最后一步不画线**）与右侧内容卡。`StepDetail` 按 `terminal → plan → 纯文本` 优先级三选一渲染，因此同一个 `TerminalCard` / `PlanCard` 组件在多步之间复用（实测：step0 纯文本、step1/2 `plan-card`、step3/4 `terminal-card`、step5 纯文本）。
- **06 步四态齐全**：`RUN_STEPS` 六步状态为 done / done / running / done / failed / pending，`RUN_STATUS_COUNT` 用 `reduce` 从数据推导而非手写常量（避免数据和计数漂移）。
- **`Switch` 组件（`components/screens/Switch.tsx`）**：原生 `<button role="switch">`，输出 `aria-checked={checked}` + `aria-label={label}` + `data-enabled={checked}` **三态同源**（04/05 两屏共用）。滑块用 `left` 定位而非 `translate-x`，取值来自 `SWITCH_*` 常量。不用 Radix、不用 checkbox 打样式。
- **05 屏主题三态**：`THEME_OPTIONS` 为 light/dark/system。激活判定 `themeSource === "system" ? "system" : theme`；点击时 `"system"` 走 `useSystemTheme()`（清 `theme` key + 置 `themeSource: "system"`），否则走 `setTheme(value)`。全部经 store，**未直接触碰 `document.documentElement.dataset.theme`**。
- **05 屏五分组顺序固定**：model → thinking → session → appearance → working-dir，每组 `data-testid="settings-group"` + `data-group`；分组说明文案内嵌 `PI_FIELD_NAMES` 里的 Pi 字段名（`AgentOptions.model` / `set_thinking_level` / `SettingsManager.autoCompact` / `SettingsManager.autoRetry` / `AgentOptions.cwd`），便于主控按字段名核对。
- **路由**：`SCREEN_BY_HASH` 对照表 + `readScreen()` 查表，`hash.replace(/^#\/?/, "")` 归一化，未命中回落 `workbench`。`App.tsx` render 改 `switch (screen)`；workbench 的 `onOpenSettings` 由原来的跳 tokens 改为跳 settings。

---

## 四、自验实测证据（命令 + exit code + 关键数值）

### 4.1 规格书第五节命令（全部在 `packages/ui` 下）

| 命令 | exit code | 关键数值 |
|---|---|---|
| `tsc --noEmit -p tsconfig.app.json`（= `npm run typecheck`，真实口径） | **0** | 0 error（strict + noUnusedLocals + noUnusedParameters 全开） |
| `vite build`（= `npm run build`） | **0** | **2060 modules**（M3 为 2052，+8）；主包 `index-CuJsqb4N.js` **515.29 kB / gzip 158.23 kB**（M3：489.41 / 150.79）；CSS `index-DKJd9mWb.css` **28.65 kB / gzip 6.63 kB**（M3：27.71）；`built in 6.27s` |
| `npm run check:cn` | **0** | **15/15 通过** |
| `npm run accept:m1`（先起 dev server 5180） | **0** | 见下表 |
| `M2_ORIGIN=http://127.0.0.1:5180 npm run accept:m2` | **0** | 复用 5180 |
| `M3_ORIGIN=http://127.0.0.1:5180 npm run accept:m3` | **0** | 复用 5180，CDP 9341 |

**M1 回归（红线）逐条关键读数**：

| 断言 | 门槛 | 实测 | 结果 |
|---|---|---|---|
| 1-10 过渡中间帧数 | ≥3 | **4**（宽度序列 264→138.88→72.16→32.55→10.23→0.77→0） | ✅ |
| 1-12 全屏内容区填满 | 内容区 == 视口宽、左 0 右 1424 | workspace 1424 / left 0 / right 1424 / docScrollWidth 1424 == docClientWidth 1424 | ✅ |
| 1-13 严格 0 宽硬断言 | 侧栏 0、预览区 0、无边框占位 | 侧边栏 0、预览区 0、内容区 1424、borderRight 0、borderLeft 0，`全部通过: true` | ✅ |
| 1-11 折叠持久化 | 落盘 + 重载仍折叠 | 点击后 `localStorage.sidebar="1"`，重载后宽 0、`collapsed="true"` | ✅ |
| G4 图标色（8 样本） | 全 `rgb(138,145,158)` | 8/8 命中 | ✅ |
| G7 Enter / Space 触发 | 均可触发 | Enter 后 `collapsed` false→true；Space 后两栏 `["true","true"]` | ✅ |
| 深色骨架无白底黑字 | — | shell `rgb(22,24,28)` / sidebar `rgb(28,31,36)` / footer `rgb(36,39,45)` / workspace `rgb(22,24,28)` / preview `rgb(28,31,36)`，图标色深色下仍 `rgb(138,145,158)` | ✅ |

> ⚠️ **M1 回归的适用路由口径（须记录）**：`m1-acceptance.mjs` 直接查 `[data-testid="preview-pane"]` 与 `[data-testid="workspace-area"]`，这两个元素只存在于 workbench 路由。因此 `accept:m1` 必须落在默认路由（`/`）上跑，不能在三屏路由上跑。本次运行即默认路由，EXIT=0。

**M3 回归（5 条断言）**：G1 颜色来源唯一、G2 无 `dark:` 变体、G5 无内置调色板、3-1a/3-1b 双 Tab 互斥、3-2 源码态三要素、3-3 iframe sandbox、复制按钮回落、3-7 深色高亮——日志内逐条 `[PASS]`，EXIT=0。

### 4.2 实现方自查走查（30 组断言，Chrome headless + CDP **端口 9342**，证据 `packages/ui/_m4-walkthrough.json`）

汇总：**`{ assertions: 30, passed: 30, failed: 0, failedNames: [] }`**

| # | 断言组 | 结果 | 关键实测值 |
|---|---|---|---|
| 1 | 03 屏外壳结构 | ✅ | `run-detail-screen` 存在；sidebar 宽 **264**；`sidebar-footer` 存在（通底）；**无 `preview-pane`**；步数 **6**；状态集合 `["done","failed","pending","running"]`（四态齐全）；无横向滚动条 |
| 2 | 03 屏每步三要素 | ✅ | 6/6 步都有状态文本、耗时文本、展开按钮；初始 `data-expanded` 全 `false`；初始无 `run-step-detail` |
| 3 | 03 屏展开/收起 | ✅ | 点第 2 步 → `data-expanded="true"`、详情高 **185.36px**、`style.maxHeight="420px"`（= `RUN_STEP_DETAIL_MAX_HEIGHT`）、命中 `plan-card`；再点一次 → `false` 且详情节点移除 |
| 4 | 03 屏详情类型分布 | ✅ | step0 纯文本 / step1 `plan-card` / step2 `plan-card` / step3 `terminal-card` / step4 `terminal-card` / step5 纯文本 —— **两个卡片组件都被真实复用** |
| 5 | 03 屏返回 | ✅ | `screen-back` 存在，点击后回到 workbench |
| 6 | 04 屏三类分组 | ✅ | `skills-screen` 存在；分组数 **3**；分类顺序 `["extension","prompt","skill"]`；每组条目数均 >0；无 `preview-pane`；无横向滚动条 |
| 7 | 04 屏工具开关（初态） | ✅ | 开关数 **4**；4/4 为 `role="switch"`；4/4 有非空 `aria-label`；`aria-checked === data-enabled` **全等**；初始四开 |
| 8 | 04 屏开关翻转 | ✅ | 点击前 `true` → 点击后 `false`，`data-enabled` 同步 `false`，`localStorage` 出现 `tool-enabled:*` 键 |
| 9 | 04 屏刷新保持 | ✅ | reload 后第一个仍 `false`，其余 3 个仍 `true` |
| 10 | 04 屏 MCP 区 | ✅ | `mcp-note` 存在且文案含 `MCP`；`mcp-list` 存在；每个 `mcp-server` 的 `data-mcp-status` ∈ {connected, disconnected} |
| 11 | 04 屏返回 | ✅ | 点击后回到 workbench |
| 12 | 05 屏五分组 | ✅ | `settings-screen` 存在；分组数 **5**；顺序 `["model","thinking","session","appearance","working-dir"]`；无 `preview-pane`；无横向滚动条 |
| 13 | 05 屏模型单选 | ✅ | 选项非空；恰 **1** 项 `data-active="true"` |
| 14 | 05 屏思考档位单选 | ✅ | 选项非空；恰 **1** 项 `data-active="true"` |
| 15 | 05 屏会话开关（初态） | ✅ | 开关数 **2**；均为 `role="switch"`；初始两开；`data-field` 集合 `["autoCompact","autoRetry"]` |
| 16 | 05 屏会话开关翻转 | ✅ | 翻转后 `aria-checked="false"`，`localStorage` 出现对应键 |
| 17 | 05 屏主题选项 | ✅ | 选项数 **3**；取值 `["dark","light","system"]`；恰 **1** 项激活 |
| 18 | 05 屏真换肤（dark） | ✅ | `html[data-theme]` 由非 dark → **`dark`**；`body` 背景三通道均 <80（变深） |
| 19 | 05 屏刷新保留深色 | ✅ | reload 后 `data-theme="dark"`，dark 选项仍 `data-active="true"` |
| 20 | 05 屏切回浅色 | ✅ | `data-theme="light"` |
| 21 | 05 屏「跟随系统」 | ✅ | `localStorage["theme"]` 变为 **`null`**（显式主题已清），`system` 选项成为唯一激活项 |
| 22 | 05 屏工作目录组 | ✅ | `settings-working-dir` 存在且文本非空；`settings-change-dir` 按钮存在 |
| 23 | 05 屏返回 | ✅ | 点击后回到 workbench |
| 24 | 路由非法 hash | ✅ | `#/not-a-real-screen` 回落 workbench，三屏节点均未残留 |
| 25 | 03 屏折叠组合 | ✅ | 左右栏全折叠后 sidebar 严格 **0**、无横向滚动条、`run-detail-screen` 宽 == 视口宽 |
| 26 | 04 屏折叠组合 | ✅ | sidebar 严格 0、无横向滚动条 |
| 27 | 05 屏折叠组合 | ✅ | sidebar 严格 0、无横向滚动条 |
| 28 | 三屏深浅底色 | ✅ | 03/04/05 三屏：light `theme=light` `bg=rgb(255,255,255)`、dark `theme=dark` `bg=rgb(22,24,28)`（三屏 6/6 组） |
| 29 | 三屏 G4 图标色 | ✅ | 三屏均含 `rgb(138,145,158)` 中性图标；非中性图标色全部落在语义令牌白名单内（`rgb(15,122,88)` 成功 / `rgb(53,99,232)` 强调 / `rgb(192,57,43)` 危险 / `rgb(97,101,107)` 正文级中性） |
| 30 | 三屏双模式无横向滚动 | ✅ | 6/6 组（三屏 × 深浅）`scrollWidth <= clientWidth` |

### 4.3 全局硬约束自查（文件级扫描，覆盖 M4 全部 8 个新增/改动文件）

| # | 约束 | 结果 | 实测 |
|---|---|---|---|
| G1 | 组件无 `#hex` | ✅ | 8 个目标文件（三屏 + 三 mock + `ScreenLayout` + `Switch`）扫描：**hex 命中 0** |
| G2 | 无 `dark:` 变体 | ✅ | **`dark:` 命中 0** |
| G5 | 无 Tailwind 内置调色板 | ✅ | `bg|text|border|...-(slate|gray|zinc|red|...)-\d{2,3}` 正则：**命中 0** |
| G6 | 无横向滚动条 | ✅ | 走查 25~27、30 共 9 组（三屏 × 折叠/展开 × 深浅）全部成立 |

> G3（对比度）/ G4（图标色）/ G7（键盘可达）由 M2 回归 32/32 + 本节走查 29 号断言共同覆盖；G8（折叠过渡非瞬间）由 M1 回归 1-10（中间帧 4）覆盖。

### 4.4 testid 契约对照表（供主控编写 `m4-acceptance.mjs`）

全项目 `data-testid` 共 **69** 个（含 M0–M3 既有）。**M4 新增**如下：

| 屏 | testid | 附加数据属性 | 说明 |
|---|---|---|---|
| 通用 | `screen-back` | — | 三屏共用的返回按钮 |
| 03 | `run-detail-screen` | `data-step-count` | 屏根容器（`<main>`） |
| 03 | `run-timeline` / `run-timeline-list` | — | 时间轴容器 / `<ol>` |
| 03 | `run-step` | `data-status`（done/running/pending/failed）、`data-step-id` | 单步 `<li>` |
| 03 | `run-step-status` | — | 状态文案 |
| 03 | `run-step-duration` | — | 耗时文本（`font-mono tabular-nums`） |
| 03 | `run-step-toggle` | `data-expanded`（"true"/"false"） | 展开/收起按钮 |
| 03 | `run-step-summary` | `data-summary-label` | 摘要行（每步 2 条） |
| 03 | `run-step-detail` | — | 详情容器（条件渲染；`style.maxHeight` = `RUN_STEP_DETAIL_MAX_HEIGHT`） |
| 03 | 复用 `plan-card` / `terminal-card` | — | 来自 `chat/`，未新增组件 |
| 04 | `skills-screen` | — | 屏根容器 |
| 04 | `skill-group` | `data-skill-category`（extension/prompt/skill） | 分类分组块（3 个） |
| 04 | `skill-group-count` | `data-skill-type` | 分组条目计数徽标 |
| 04 | `skill-item` | `data-skill-type`、`data-skill-name` | 技能条目 |
| 04 | `tool-list` | — | 工具开关列表容器 |
| 04 | `tool-toggle` | `data-tool-name`（read/bash/edit/write）、`data-enabled`，且 `role="switch"` + `aria-checked` | 工具开关（4 个） |
| 04 | `mcp-note` | — | MCP 说明文案（「Pi 不内置 MCP」） |
| 04 | `mcp-list` / `mcp-server` | `data-mcp-name`、`data-mcp-status`（connected/disconnected） | MCP 服务器列表 |
| 05 | `settings-screen` | — | 屏根容器 |
| 05 | `settings-group` | `data-group`（model/thinking/session/appearance/working-dir） | 分组块（5 个，顺序固定） |
| 05 | `settings-model-list` / `settings-model-option` | `data-model-id`、`data-active` | 模型单选 |
| 05 | `settings-thinking-option` | `data-thinking-level`、`data-active` | 思考档位单选 |
| 05 | `settings-session-list` / `settings-switch` | `data-field`（autoCompact/autoRetry），且 `role="switch"` + `aria-checked` | 会话开关（2 个） |
| 05 | `settings-theme-option` | `data-theme-value`（light/dark/system）、`data-active` | 主题三选 |
| 05 | `settings-theme-state` | — | 当前主题状态文案行 |
| 05 | `settings-working-dir` | `data-field` | 工作目录路径展示 |
| 05 | `settings-change-dir` | — | 「修改目录」按钮（空实现但可点，规格允许） |

---

## 五、本轮修复记录（一起真实类型事故 + 三处自查探针缺陷）

### 5.1 【真实事故·类型】`syncSystemTheme` 加参会打破 00 屏

- **现象**：为 05 屏「跟随系统」给 `syncSystemTheme` 加可选参 `(force?: boolean)`，typecheck 报
  `error TS2322: Type '(force?: boolean | undefined) => void' is not assignable to type 'MouseEventHandler<HTMLButtonElement>'`。
- **根因**：`TokensScreen.tsx:131` 有 `onClick={syncSystemTheme}`，直接把它当事件处理器传。加参后签名与
  `MouseEventHandler` 不兼容 —— **这是类型层面的事，与函数体怎么写无关**（第一版试图在实现里用
  `force !== true` 兜，类型错误照旧）。
- **修法**：**回滚** `syncSystemTheme` 到无参签名 `() => void`（保持 00 屏零改动），新增**独立**方法
  `useSystemTheme: () => void` 承载「切回跟随系统」的语义（清 `theme` key + 置 `themeSource: "system"`），
  05 屏改调 `useSystemTheme()`。语义上两者也有真实差异：`syncSystemTheme` 在 `themeSource === "user"`
  时会提前 return（用于监听系统变化），而用户主动点「跟随系统」必须无视该标记。
- **修后复验**：`tsc --noEmit -p tsconfig.app.json` EXIT=0；走查 21 号断言（点 system）通过。
- **教训**：**给既有公共 API 加可选参不是「向后兼容」的改动。** 当它被当作回调直接传递时（`onClick={fn}`），
  参数类型的协变/逆变会让可选参也成为破坏性变更。改签名前先 `grep` 调用点。

### 5.2 【自查】三处走查探针写错（自查脚本缺陷，非实现缺陷，M3 教训 3 的第三次复现）

第一轮走查 **27/30**，三个 FAIL 全部是探针问题：

| # | 失败断言 | 真实原因 | 修正 |
|---|---|---|---|
| 1 | 「展开第 2 步复用 TerminalCard」 | **断言写错了步号与组件**：第 1、2 步的数据是 `detailPlan`，该渲染 `plan-card`；`terminal-card` 出现在第 3、4 步 | 改为断言 `plan-card`，并把「各步详情类型」独立成一条探测记录（现走查 4 号），把六步的 `terminal/plan/纯文本` 分布全部落盘 |
| 2 | 「深色下底色暗」 | **`localStorage.setItem('theme','dark')` 之后没有真正重载页面**：`Page.navigate` 到**同源仅 hash 不同**的地址时浏览器不重新加载文档、ES 模块不重新求值，而 `initTheme()` 里 `initialized` 是模块级开关，第二次直接 `return` → `data-theme` 不更新 | 改为**硬重载**（带 cache-bust 查询串）后再探针；同时补一条 `theme` 标签本身的断言，防止「探针读错对象」再次伪装成产品缺陷 |
| 3 | 「图标色恒为 #8A919E」 | **口径过宽**：采样抓到了语义色图标（成功绿 `rgb(15,122,88)`、强调蓝 `rgb(53,99,232)`）。G4 只约束**中性图标**，语义色图标属 G3 对比度范畴 | 改为两条断言：① 三屏均**存在** `rgb(138,145,158)` 中性图标；② 非中性图标色必须落在语义令牌白名单内（防硬编码色偷渡） |

- 三处修正后重跑：**30/30 通过**。
- 与前两轮同性质：**失败的断言要先怀疑断言本身**。本轮 3 个失败里 **0 个**是产品缺陷，
  全是「探针选错元素 / 页面状态没重置 / 口径过宽」。

### 5.3 【环境】npm 与 node 的调用姿势（本轮新踩）

- `node node_modules/npm/bin/npm-cli.js` **必然失败**（`MODULE_NOT_FOUND`）：项目的 `node_modules` 下没有 npm。
  正确路径是 `C:/Users/myliu/.workbuddy/binaries/node/versions/22.22.2-3/node_modules/npm/bin/npm-cli.js`。
- `npm.ps1` 被 PowerShell 执行策略拦截、`cmd.exe` 被环境拦截；`.log` 重定向 + 事后 `Read` 仍然是最稳的取输出方式
  （Bash 的 `tail`/`ls`/`dirname` 均缺失）。
- 一次 `vite build` 前台跑吃到 `SIGTERM`（Exit 1），改 `run_in_background` 后 EXIT=0 —— 是超时被中断，**不是构建失败**。

---

## 六、偏离规格 / 需记录事项

| # | 位置 | 现象 | 级别 | 处理 |
|---|---|---|---|---|
| 1 | `store/ui-store.ts` | 规格只要求 05 屏主题切换走 store，未规定「跟随系统」怎么表达。选了**新增 `useSystemTheme` 而非改 `syncSystemTheme` 签名**（见 5.1） | Note | 00 屏零改动；两者语义差异已在代码注释写明 |
| 2 | `components/common/icons.tsx` | 需新增 `ArrowLeft`（返回按钮）。规格未列举 | Note | 仅追加一行 import 与一条 `ICON_INVENTORY`，带 M4 注释；不触碰既有图标 |
| 3 | `components/screens/ScreenLayout.tsx`、`Switch.tsx` | 规格未规定三屏外壳与开关是共用组件还是各屏内联 | Note | 抽成两个共用组件：`min-w-0`/滚动容器/padding 是三屏最容易写错的骨架；`Switch` 的 `aria-checked`/`data-enabled` 同源是 04/05 共同的验收面 |
| 4 | `mock/runs.ts` | `RUN_STATUS_COUNT` 用 `reduce` 从 `RUN_STEPS` 推导，未写成字面常量 | Note | 避免数据与计数漂移；规格未禁止 |
| 5 | 04 屏工具开关持久化 | 规格未规定 key 命名。选**按工具名逐个存 key**（`tool-enabled:read` 等），而非整块 JSON | Note | 与 `ui-store` 既有 `readStoredFlag` 风格一致；单个 key 损坏不影响其余开关 |
| 6 | 05 屏「修改目录」按钮 | 规格明示可空实现 | — | 按钮可点、当前无行为（纯原型，符合规格） |
| 7 | 03 屏 `run-step-detail` | 初次展开不做动画（条件渲染，无过渡） | Note | 规格只对折叠面板（G8）要求非瞬变；步骤展开未列入。若主控要求补过渡，归 M5 打磨 |

---

## 七、遗留项

- **`accept:m4` 验收脚本尚未存在** —— 按规格「验收脚本由主控编写」的规矩，本轮未自行创建
  `scripts/m4-acceptance.mjs`，也未往 `package.json` 加 `accept:m4` script。自查走查脚本
  `packages/ui/_m4-walkthrough.mjs` 是**临时探针**，其断言口径（尤其 5.2 的三处修正）仅供主控参考，
  不作为验收依据；证据 JSON 保留在 `packages/ui/_m4-walkthrough.json`。
- **`1-10` 中间帧**：本轮实测 **4**（门槛 ≥3，M3 末轮为 3）。仍属 rAF 采样抖动，未动折叠时长；
  M5 把 `COLLAPSE_DURATION_REDUCED` 90ms → 120ms 的既有建议继续有效。
- **主包体积**：515.29 kB / gzip 158.23 kB（M3：489.41 / 150.79，+25.88 kB）。三屏新增代码约 26 kB
  已基本吃到；chunk >500kB 的警告是既有 shiki 懒加载分块所致，非 M4 引入。若 M5 要压主包，
  可把三屏改 `React.lazy`（本轮未做，规格未要求）。
- **既有遗留不变**：`chat-store` 的 `window.__chatStore` 验收桩接 Pi 时还原；
  M3 主控定的 `role="tabpanel"` 接线归 M5 交互打磨。
- 临时文件（`packages/ui/_build-m4.log`、`_dev-m4.log`、`_acc-m1.log`、`_acc-m2.log`、`_acc-m3.log`、
  `_cn-m4.log`、`_walk-m4.log`）为本次自验过程产物，`_m4-walkthrough.json` 为证据，均未提交/未纳入源码。

---

## 八、验收对照表（4-1~4-7，**全部待主控复核**）

| # | 验收项 | 实现方实测（供复核） | 依赖 testid / 特征（已按契约暴露） | 结论 |
|---|---|---|---|---|
| 4-1 | 03 屏结构：WindowShell + Sidebar + 内容区，无 PreviewPane | sidebar 宽 264、`sidebar-footer` 通底、`preview-pane` 不存在（走查 1） | `run-detail-screen`、`sidebar`、`sidebar-footer` | **待主控复核** |
| 4-2 | 03 屏时间轴四态 + 逐步展开/收起 | 6 步四态齐全（done/done/running/done/failed/pending）；展开 → `data-expanded="true"` + 详情 185.36px + `maxHeight=420px`；再点 → 移除（走查 1/2/3） | `run-step`+`data-status`、`run-step-toggle`+`data-expanded`、`run-step-detail`、`run-step-status`、`run-step-duration` | **待主控复核** |
| 4-3 | 03 屏复用 `PlanCard` / `TerminalCard` | 实测 step1/2 命中 `plan-card`、step3/4 命中 `terminal-card`（走查 4） | 既有 `plan-card` / `terminal-card` | **待主控复核** |
| 4-4 | 04 屏三类技能分组 + 工具开关 + MCP 说明 | 三组顺序 extension/prompt/skill 且各自非空；4 个 `role="switch"` 工具开关 `aria-checked === data-enabled`、点击翻转且落盘、刷新保持；`mcp-note` 存在、`mcp-server` 带 connected/disconnected 状态（走查 6~11） | `skills-screen`、`skill-group`+`data-skill-category`、`skill-item`、`tool-toggle`+`data-tool-name`+`data-enabled`、`mcp-note`、`mcp-list`、`mcp-server`+`data-mcp-status` | **待主控复核** |
| 4-5 | 05 屏五分组 + 模型/思考单选 + 会话开关 + 主题 + 工作目录 | 分组顺序 model/thinking/session/appearance/working-dir；模型与思考各恰 1 项激活；2 个会话开关初开可翻转并落盘；主题三项齐全且恰 1 激活、点 dark 后 `html[data-theme]="dark"` 且刷新保留、点 system 后 `localStorage["theme"]=null`；工作目录路径展示 + 修改按钮存在（走查 12~23） | `settings-screen`、`settings-group`+`data-group`、`settings-model-option`+`data-model-id`+`data-active`、`settings-thinking-option`+`data-thinking-level`、`settings-switch`+`data-field`、`settings-theme-option`+`data-theme-value`、`settings-working-dir`、`settings-change-dir` | **待主控复核** |
| 4-6 | 三屏 hash 进入/返回 + 非法值回落 | `#/run-detail`、`#/skills`、`#/settings` 均可进入且 `screen-back` 可回 workbench；`#/not-a-real-screen` 回落 workbench 且三屏节点无残留（走查 5/11/23/24） | `screen-back`、`SCREEN_BY_HASH` 查表 | **待主控复核** |
| 4-7 | 三屏在折叠组合与深浅双模式下无横向滚动、无白底黑字、G4 图标色 | 折叠后 sidebar 严格 0 且无横向滚动（03/04/05 各 1 组）；三屏 × 深浅底色正确（light 白 / dark `rgb(22,24,28)`）；三屏均含 `rgb(138,145,158)` 中性图标、非中性图标色全在语义白名单（走查 25~30） | — | **待主控复核** |

---

## 九、本里程碑的教训（跨里程碑复用）

1. **给既有公共 API 加可选参不是向后兼容的改动。** `onClick={fn}` 这类「函数被当回调直接传递」的
   位置，参数类型不兼容就是编译错误，跟函数体怎么写无关。改签名前先 `grep` 调用点，
   优先**新增独立方法**而不是给老方法加参。
2. **同源仅 hash 不同的导航不重载文档。** `Page.navigate('#/x')` 不会重新求值 ES 模块，
   任何「模块级初始化开关」（如 `initTheme()` 的 `initialized`）都不会重跑。验收脚本里要观测
   「首帧前确定」的初始态，必须**硬重载**（带 cache-bust），否则会得到稳定的假结果。
3. **失败的断言先怀疑断言本身**（第三次验证）：本轮 3 个自查失败 **0 个**是产品缺陷，
   全是「探针选错元素 / 页面状态没重置 / 口径过宽」。
4. **验收口径要写清适用范围。** `accept:m1` 依赖只存在于 workbench 的两个 testid，
   它天然只能在默认路由上跑 —— 这种隐含前提必须写进 progress 文档，否则后人在三屏路由上跑
   M1 回归拿到红，会误判成回归。
5. **环境调用姿势要沉淀。** npm 真实路径不在项目 `node_modules` 下；
   长命令用 `run_in_background` 避免超时被 SIGTERM（那不是构建失败）。

---

## 十、待主控复核（本文档未经主控定稿）

按规格要求，**4-1~4-7 的逐条结论一律为「待主控复核」**，实现方不下「通过」结论。
建议主控复核动作：

1. 独立复跑：`npm run typecheck`、`npm run build`、`npm run check:cn`、`npm run accept:m1`、
   `M2_ORIGIN=… npm run accept:m2`、`M3_ORIGIN=… npm run accept:m3`。
2. 按 4.4 的 testid 契约编写 `scripts/m4-acceptance.mjs`（含 G1/G2/G5 静态扫描与三屏的
   `data-*` 属性断言），并加入 `package.json` 的 `accept:m4`。
3. 源码走读：三屏各自的折叠特征与 `min-w-0` 链、`ScreenLayout` 的滚动容器、
   `Switch` 的 `aria-checked`/`data-enabled` 同源、`ui-store.ts` 的 M4 新增段（
   `enabledTools` / `sessionSwitches` / `workingDir` / `useSystemTheme` 与 `initTheme` 三处同源）、
   `App.tsx` 的 `SCREEN_BY_HASH` 查表。
4. 决策 5.1 的 API 处理方式（新增 `useSystemTheme` 而非改签名）与第六节 7 项 Note 是否接受。

---

## 十一、主控复核（定稿，2026-09-22）

**本节由主控（非实现方）独立编写。上文全部「待主控复核」以本节结论为准。**

### 11.1 主控独立复跑证据

所有命令均由主控在独立 shell 中执行，**不采信实现方回报的结论**：

| 命令 | 口径 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | `tsc -b -p tsconfig.app.json` | **EXIT=0** |
| `npm run build` | vite build | **EXIT=0**，2060 modules，主包 515.30 kB / gzip 158.23 kB，CSS 28.65 kB |
| `npm run check:cn` | 中文文案门禁 | **EXIT=0**，15/15 |
| `npm run accept:m1` | 红线回归（在默认 workbench 路由） | **EXIT=0**，1-10 / 1-12 / 1-13 全绿 |
| `M2_ORIGIN=http://127.0.0.1:5180 npm run accept:m2` | 02 屏回归 | **EXIT=0** |
| `M3_ORIGIN=http://127.0.0.1:5180 npm run accept:m3` | 03 屏预览区与深色回归 | **EXIT=0** |
| `M4_ORIGIN=http://127.0.0.1:5180 npm run accept:m4` | **主控自写的 M4 验收脚本** | **EXIT=0，16/16 断言 `[PASS]`**，证据 `_m4-evidence.json` |

G1 / G2 / G5 静态扫描（主控独立执行，53 个源文件全扫）：

- **G1（hex 只允许出现在 `tokens.css`）**：通过，无越界。
- **G2（无 `dark:` 变体）**：0 命中。
- **G5（不用 Tailwind 内置调色板）**：0 命中。

### 11.2 验收脚本的探针缺陷修正记录

按 M2 定下的铁律，`scripts/m4-acceptance.mjs` 由**主控自写**（非实现方）。脚本首轮出现 4 个 FAIL，
经逐条溯源，**4 个全部是探针缺陷，0 个是产品缺陷**（这是本项目第四次验证「失败的断言先怀疑断言本身」——
M2 首轮 10 个失败里 7 个是脚本缺陷、M3 自查 3 个失败里 2 个是探针写错、M4 首轮 4 个失败全是探针）：

| # | 失败断言 | 根因 | 修正 |
| --- | --- | --- | --- |
| 1 | 「M4 新增组件无硬编码尺寸」 | 探针把 `gap: 12`/`gap: 16` 也算作布局尺寸 | 口径收窄为只管 `width / minWidth / maxWidth / height / minHeight / maxHeight`，并排除 `<=1` 的发丝线 |
| 2 | 「4-1 每步都有耗时数字」 | 要求所有步骤都有数字耗时，但 pending / running 用 `"—"` 占位是**正确设计** | 分层判定：done / failed 必须有「数字+单位」，pending / running 只要求有占位 |
| 3 | 「4-3 状态真的翻转」+「切换被持久化」 | 把 `.click()` 与复读塞进同一个同步 eval，React 异步 setState 下读到旧值 | 拆成两次 eval，中间 `sleep(300)` 给 React commit 机会 |
| 4 | 「深色正文对比度达标」（先后错两轮） | 第一轮：把 G4 刻意固定的中性图标色 `#8A919E` 算进对比度，得 1.0；第二轮：按 class 名 `text-text-tertiary` 过滤，漏掉**继承** tertiary 的节点（ScreenHeader subtitle 3.77） | 最终按**计算后文字颜色**分层（读 `--text-tertiary` 转 rgb 比对）：正文 ≥4.5、辅助 ≥3 |

**脚本第二轮另有 1 次崩溃**：正则 `/(ms|s|m)\b?/` 中 `\b?` 非法（`Nothing to repeat`）→ 改为 `/(ms|s)$/`。

**另有 1 处主控自己的脚本缺陷（第二类，非探针）**：首版脚本**漏了 `ctx.save()`** —— 断言全绿却不留证据文件，
与 M1/M2/M3「每次验收留一份 evidence JSON」的惯例不一致，事后复盘「当时最低对比度是多少」只能重跑。
已补 `ctx.save("_m4-evidence.json")` + `process.exitCode = failed > 0 ? 1 : 0`，
并重跑一次留档（**16/16 通过，EXIT=0**）。**教训：断言全绿 ≠ 验收完成；证据落盘是验收的一部分。**

### 11.3 复核中发现的真实实现缺陷（已修复）

| 严重度 | 位置 | 问题 | 修复 |
| --- | --- | --- | --- |
| Minor | `src/screens/SettingsScreen.tsx` | `style={{ minHeight: 20 }}` 是硬编码尺寸，违反项目「尺寸唯一来源 `lib/layout.ts`」的自有约定 | 新增常量 `SETTINGS_GROUP_HEADER_MIN_HEIGHT = 20` 并改为引用；常量注释说明「分组标题行是 flex-wrap 的，不锁最小高度时未换行行会矮于换行行」 |

修复后已重跑 `typecheck` / `build` 确认基线未破坏（2060 modules、主包 515.30 kB 不变）。

### 11.4 4-1 ~ 4-7 逐条验收结论（主控定稿）

| 条 | 验收点 | 主控结论 | 主控实测依据 |
| --- | --- | --- | --- |
| **4-1** | 03 屏运行详情：6 步四态齐全 + 耗时 + 展开收起 | **✅ 通过** | `data-step-count="6"`；四态 done/done/running/done/failed/pending 与 `STATUS_META` 同源；done/failed 均有「数字+单位」耗时，pending/running 有 `"—"` 占位；点击 `run-step-toggle` 后 `data-expanded` 真实翻转且 `run-step-detail` 挂载/卸载正确 |
| **4-2** | 03 屏步骤详情复用 TerminalCard / PlanCard | **✅ 通过** | `StepDetail` 组件对 terminal/plan 两类步骤渲染 `TerminalCard` / `PlanCard`，无重复实现；验收脚本断言两卡内部结构（终端行、计划条目）可用 |
| **4-3** | 03 屏是独立路由、可进入可返回 | **✅ 通过** | `#/run-detail` 进入后 `run-detail-screen` 存在；`screen-back` 可回 workbench；`#/not-a-real-screen` 回落 workbench 且三屏节点无残留 |
| **4-4** | 04 屏三类技能分组 + 工具开关 + MCP 说明 | **✅ 通过** | 三组顺序 extension/prompt/skill 且各自非空（`skill-group-count` 有值）；4 个 `tool-toggle` 的 `aria-checked === data-enabled` 三源同源，点击翻转、落盘（`tool-enabled:` 前缀）、刷新保持；`mcp-note` 存在；`mcp-server` 带 connected 状态 |
| **4-5** | 05 屏五分组 + 模型/思考单选 + 会话开关 + 主题 + 工作目录 | **✅ 通过** | 分组顺序 model→thinking→session→appearance→working-dir 正确；模型与思考各恰 1 项 `data-active="true"`；2 个 `settings-switch` 初开、可翻转、落盘（`setting:` 前缀）；主题三项齐全且恰 1 激活，点 dark 后 `html[data-theme]="dark"` 且刷新保留，点 system 后 `localStorage["theme"]` 为 null；`settings-working-dir` 展示路径 + `settings-change-dir` 存在 |
| **4-6** | 三屏 hash 导航与非法值回落 | **✅ 通过** | 三个 hash 均可进入、均可 `screen-back` 返回；`SCREEN_BY_HASH` 查表实现（未引入 react-router）；非法 hash 回落 workbench 且无残留节点 |
| **4-6b** | 主题换肤走 `setTheme` / `useSystemTheme`，不直改 DOM | **✅ 通过** | `ThemeSelector` 只调用 store 方法；`html[data-theme]` 由 `initTheme` 单向派生；「system」态下 `localStorage["theme"]` 被清为 null，符合设计 |
| **4-7** | 三屏响应式与深色走查 | **✅ 通过** | 三屏 × {展开, 折叠} 共 6 组，横向溢出量 `run-detail: 0/0`、`skills: 0/0`、`settings: 0/0`，折叠后 sidebar 宽度**严格 0**；深色下无大面积白底（light 为白、dark 为 `rgb(22,24,28)`）；三屏均含 `rgb(138,145,158)` 中性图标（G4 固定色），非中性图标色全在语义白名单内 |

### 11.5 深色对比度实测（主控口径，定稿数值）

按**计算后文字颜色**分层统计（正文 ≥4.5、辅助 ≥3）：

| 屏 | 正文最低 | 正文最低样本 | 辅助最低 | 辅助处数 |
| --- | --- | --- | --- | --- |
| `#/run-detail` | **5.68** | `~ / projects / atlas-age`（`text-text-secondary` `rgb(154,160,168)`） | 3.5 | 24 |
| `#/skills` | **5.68** | 同上 | 3.17 | 26 |
| `#/settings` | **4.90** | `支持 Max` | 3.5 | 21 |

**正文最低实测 4.90（门槛 4.5 ✅）、辅助文字最低实测 3.17（门槛 3 ✅）—— 三屏全部达标。**

说明：`text_tertiary` 是设计稿定稿值且有留档，属 G3「辅助文字 ≥3」档，**不在 M4 范围内改色**。此项口径已写进 `m4-acceptance.mjs` 头部注释，供后续里程碑复用。

### 11.6 主控决策

| # | 事项 | 决策 |
| --- | --- | --- |
| D1 | 实现方 5.1 的 API 处理方式（新增 `useSystemTheme` 而非给 `setTheme` 改签名） | **接受**。符合本里程碑教训 1「给既有公共 API 加可选参不是向后兼容的改动」，方向正确 |
| D2 | 第六节 7 项 Note | **全部接受**，无需返工 |
| D3 | `accept:m4` | **已加入 `packages/ui/package.json`**，后续里程碑改三屏即触发回归 |
| D4 | `SETTINGS_GROUP_HEADER_MIN_HEIGHT` | **已补入 `lib/layout.ts`**，M4 常量段现有 55 个常量（实现方 54 + 主控 1），未改动任何既有值 |

### 11.7 M4 结论

**M4 三屏（03 运行详情 / 04 技能与工具 / 05 设置）全部完工并通过主控独立验收。**
项目整体 8 屏中已落地 7 屏，仅余 M5 的窗口壳与全量走查。

**新增遗留（转 M5）**：

1. `COLLAPSE_DURATION_REDUCED` 建议 90ms → 120ms（可访问性下限，需在 M5 走查时统一裁决）。
2. Tab 面板缺 `role="tabpanel"` + `aria-labelledby` 接线（G7 键盘可达的收尾项）。
3. 本脚本的对比度分层口径应固化为 M5 走查的公共口径，避免再造轮子。

