# 接 Pi 真实数据替换点清单（pi-integration-points）

> 用途：原型（`packages/ui`）所有数据来自 `src/mock/*`。接 Pi 真实数据时按本文档逐点替换——
> **UI 组件树、data-testid 契约、`lib/layout.ts` / `styles/tokens.css` 全部不动**。
> 配套阅读：`.plan/ui-rulings.md`（布局终态裁决台账）、`.plan/README.md`（里程碑口径）。
> 消费点清单由 grep 实证（`from "@/mock` 全扫），非凭记忆。

## 核心结论（先读这个）

1. **`mock/types.ts` 的 Block 模型就是 UI 的数据契约**——接 Pi 不改 UI，而是写一个**适配层**，
   把 Pi 的事件流映射成 `Message[] / Block`。
2. **`chat-store.ts` 是唯一的状态缝隙**——五个公开方法签名是 M2 冻结契约，内部实现从 mock 换真即可。
3. 其余 mock 文件按屏独立替换，与工作台主链路无耦合。

## 一、类型契约 `mock/types.ts` —— 保留为目标形态（不删不换）

- 消息域：`Message` / `MessageRole` / `Session` / `SessionSummary` / `TokenUsage`
- **Block 联合六型**：`TextBlock`（含 streaming 标志）/ `ThinkingBlock`（collapsed）/
  `ToolCallBlock` / `TerminalBlock` / `ApprovalBlock` / `PlanBlock`（+`PlanStep`/`PlanStepStatus`）；
  收窄工具 `isBlock()` / `BlockType`
- 设置域：`ThinkingLevel` / `ModelOption` / `McpServer` / `McpStatus` / `ToolStatus`
- 消费者（全部 **type-only import**，17 个消费文件中的 10 个）：
  `MessageBubble` / `MessageList` / `PlanCard` / `TerminalCard` / `ThinkingCard` / `ApprovalCard` /
  `RunDetailScreen` / `chat-store` / `ui-store` / `ShellPreview`
- **接 Pi 工作量主体 = 适配层：Pi 事件 → 这六种 Block 的映射**（建议写成纯函数，先配单测再接 store）

## 二、`chat-store.ts` —— 改造核心

| 方法（签名冻结） | 现状（mock） | 接 Pi 后 |
| --- | --- | --- |
| `sendMessage(text)` | 追加 user 消息 + `simulateStream` 打字机回复 + `computeTokens` 估算 | 发送真实输入；订阅 Pi 会话事件，事件→Block 增量更新（assistant 消息可能含 thinking/plan/tool_call/terminal/approval 多种 Block；保持「流式中只更新最后一条 assistant 消息」的既有模式，虚拟测量依赖其稳定） |
| `abortStream()` | `activeStream.abort()` + 定格 | 中断 Pi 会话；已产出 Block 定格（streaming 标志清掉） |
| `resolveApproval(requestId, choice)` | 本地把 `resolved` 置为 choice | 回传 Pi 授权应答；**幂等语义保留**（已决 requestId 不再覆盖） |
| `loadSession(session)` | 切 mock 会话（先 abort） | 加载真实会话（消息已是 Block 形态） |
| `reset()` | 回 `INITIAL_SESSION` | 回空会话或最近会话（产品决策） |

其他改造点：

- `computeTokens()`（字符数 ×0.5 估算）→ 用 Pi 返回的真实用量；`TokenUsage` 四字段语义不变
- `sessionTitle` 目前只随 `loadSession` 更新 → 接 Pi 后由真实会话标题驱动
- **DEV 挂载的 `window.__chatStore`**（chat-store.ts 尾部，仅 `import.meta.env.DEV`）——验收脚本驱动用；
  **接 Pi 后改回真实 UI 驱动**（MEMORY 遗留项既有记录）

## 三、`mock/sessions.ts` —— 整文件替换

导出：`INITIAL_SESSION` / `INITIAL_SESSION_TITLE` / `EMPTY_SESSION` / `EMPTY_SESSION_TITLE` /
`SESSION_SUMMARIES`（8 条）/ `SESSION_LIST_NOW` / `INITIAL_TOKEN_USAGE` / `createStressSession()`

消费点：

- `App.tsx:8` → `createStressSession` / `EMPTY_SESSION`（支撑 `?stress=N` / `?empty=1` 两个**正式验收入口**；
  接真数据后 stress 仍是有效压测手段可保留，empty 可由「无会话」状态天然覆盖，需显式决策）
- `chat-store.ts:3` → `INITIAL_SESSION` / `INITIAL_SESSION_TITLE` / `INITIAL_TOKEN_USAGE`（初始态）
- `Sidebar.tsx:16` → `SESSION_LIST_NOW` / `SESSION_SUMMARIES`（历史列表；
  `SESSION_LIST_NOW` 是相对时间的**冻结锚点**，接真数据后换 `Date.now()`，`formatRelativeTime` 本身不动）

⚠️ **验收牵连**：`INITIAL_SESSION` 的 7 条消息 Block 构成是 M2 冻结的验收输入（`accept:m2` 按它逐条断言）。
替换后 accept:m1/m2 会失效——要么保留一份 mock 会话供回归（推荐：给 `mock/sessions.ts` 留导出开关），
要么正式宣告 m1/m2 验收退役并归档证据。

## 四、`mock/stream.ts` —— 被适配层取代

- 导出：`simulateStream(opts) → StreamHandle{abort}`；唯一消费者 `chat-store.ts:4`；
  tick 常量 `STREAM_TICK_MS` 在 `lib/layout.ts`（接 Pi 后可退役）
- 接 Pi：Pi SDK 事件订阅替代——适配层把增量文本 / 工具 / 计划 / 授权事件转成 Block 更新

## 五、其余屏 mock —— 逐屏独立替换（与工作台链路无耦合）

| 文件 | 关键导出 | 消费点 | 接 Pi 后来源 |
| --- | --- | --- | --- |
| `mock/runs.ts` | `RUN_SUMMARY` / `RUN_STEPS` / `RUN_STEP_COUNT` / `RUN_STATUS_COUNT` / type `RunStep`·`RunSummary` | `RunDetailScreen.tsx:19-26` | 真实运行记录 |
| `mock/composer.ts` | `COMPOSER_MODELS` / `COMPOSER_MODEL_GROUPS` / `COMPOSER_THINKING_LEVELS` / `THINKING_LABEL` / `INITIAL_MODEL_INDEX` / `INITIAL_THINKING_INDEX` / `COMPOSER_MCP_SERVERS` / `MCP_CONNECTED_COUNT` | `ComposerToolbar.tsx:14`、`SettingsScreen.tsx:12`、`SkillsScreen.tsx:10`、`ui-store.ts:12` | 模型 / 思考档位 / MCP 清单来自 Pi 配置 |
| `mock/settings.ts` | `SETTINGS_GROUPS` / `SESSION_SWITCHES` / `DEFAULT_SESSION_SWITCHES` / `THEME_OPTIONS` / `PI_FIELD_NAMES` / `DEFAULT_WORKING_DIR` 等 | `SettingsScreen.tsx:18`、`ui-store.ts:10` | 真实设置项（`PI_FIELD_NAMES` 已预留 Pi 字段映射意图） |
| `mock/skills.ts` | `SKILL_GROUPS` / `TOOL_ENTRIES` / `DEFAULT_ENABLED_TOOLS` / `SKILL_CATEGORY_LABEL` / `MCP_NOTE` 等 | `SkillsScreen.tsx:17`、`ui-store.ts:5` | 真实技能 / 工具清单 |
| `mock/shells.ts` | `SHELL_VARIANTS` / `SHELL_OS_VALUES` / `isOsName()` / 屏标题常量 | `ShellsScreen.tsx:11`、`ShellPreview.tsx:12` | 06 屏是壳演示屏，可保留 mock 或按真实平台枚举 |
| `mock/preview.ts` | `previewHtml` / `previewLanguage` / `previewTitle` | `PreviewPane.tsx:23` | 真实产物预览（iframe src 或源码字符串） |

## 六、建议替换顺序

1. **适配层先行**：Pi 事件 → Block（纯函数 + 单测，不碰 store）
2. **chat-store**：`simulateStream` → 适配层；`computeTokens` → 真实用量
3. **sessions / Sidebar**：真实会话列表与会话加载
4. **其余屏**按需逐个替换
5. **验收策略显式决策**：accept:m1/m2 的 mock 依赖怎么处置（保留 mock 分支 or 验收退役归档）

## 七、不动清单（接 Pi 时不许碰）

- UI 组件树与全部 data-testid 契约（`composer` / `send` / `input` / `message-item` / `message-list` /
  `titlebar-toggle-sidebar` / `titlebar-toggle-preview` / 各卡片 testid 等）
- `lib/layout.ts` 全部常量（含 R9 的 `SEND_ICON_OPTICAL_SHIFT_X/Y`）、`styles/tokens.css`
- `scripts/probe-r7.mjs` 的 7 项布局断言依然有效——它只依赖「会话里同时存在 user 与 assistant 消息」
  与纯 UI 折叠交互，与数据源无关
