# S0 · 我们这侧的契约（冻结）

> 日期：2026-09-22　阶段：Pi 梳理 S0（`pi-survey-plan.md`）
> 用途：**给 S1 的事件映射当靶子**。有了这张表，才能问出「Pi 的某某事件要哪些字段才能变成 Block」。
> 全部结论现读源码实证（标 `文件:行号`），不凭记忆。

---

## 一、Block 六型（`src/mock/types.ts`，M2 冻结契约）

`types.ts` 的注释里**已经写明了每个 Block 预期的 Pi 事件来源**——这是当初刻意对齐的结果，S1 只需核对是否成立。

| Block | 声明的 Pi 事件来源（types.ts 注释） | 必填字段 | 可选字段 |
|---|---|---|---|
| `TextBlock` L38 | `message_update` → `text_delta` | `content`（markdown 源码） | `streaming?`（渲染光标/「正在输出」态） |
| `ThinkingBlock` L46 | `message_update` → `thinking_delta` | `content` | `collapsed?` |
| `ToolCallBlock` L54 | `message_update` → `toolcall_delta`（参数累积） | `toolCallId` / `toolName` / `args` | `status?`（`ToolStatus`） |
| `TerminalBlock` L64 | `tool_execution_start` / `_update` / `_end` | `toolCallId` / `command` / `output` / `status` | `exitCode?` / `truncated?` / `hiddenLineCount?` |
| `ApprovalBlock` L78 | Extension UI Protocol 的 `select` / `confirm` | `requestId`（↔ Pi 的 `extension_ui_request.id`）/ `title` / `options` | `message?` / `resolved?`（有值即已决） |
| `PlanBlock` L97 | **Pi 不内置 plan mode，属自建能力** | `steps: PlanStep[]` | — |

支撑类型：

- `PlanStepStatus = pending \| running \| done \| failed`（L19，验收 2-6 要求四态齐全）
- `ToolStatus = running \| success \| error`（L22）
- `ThinkingLevel = off \| minimal \| low \| medium \| high \| xhigh \| max`（L28）——**已对齐 Pi 七档全集**
- `Message { id, role, blocks, timestamp }`（L118）· `Session { id, title, updatedAt, messages }`（L126）
- `SessionSummary { id, title, updatedAt, messageCount }`（L135，侧边栏列表不含消息体）
- `TokenUsage { input, output, total, contextWindow }`（L147，注释指向 `get_session_stats`）
- `ModelOption { id, label, provider, supportsXhigh? }`（L159，注释指向 `get_available_models`）
- `McpServer { id, name, status, toolCount }`（L168，Pi 不内置 MCP）

---

## 二、`chat-store` 契约（`src/store/chat-store.ts`）

状态字段（L15-32）：`messages` / `streaming` / `tokenUsage` / `sessionTitle`

| 方法 | 签名 | 关键语义（接 Pi 后必须保持） |
|---|---|---|
| `sendMessage` | `(text: string) => void` | **一次追加 user 消息 + 一条 assistant 占位消息，之后只增量更新最后一条 assistant**（L100-119）。虚拟滚动的动态测量依赖这个模式稳定 |
| `abortStream` | `() => void` | 已产出内容定格（`streaming` 置 false），不清空（L146-166） |
| `resolveApproval` | `(requestId: string, choice: string) => void` | **幂等**：已决 `requestId` 再调用无效（L174 判 `resolved` 为空才写） |
| `loadSession` | `(session: Session) => void` | 切会话前先 abort（L182-195） |
| `reset` | `() => void` | 回 `INITIAL_SESSION`（L197-209） |

其他：

- 流式句柄是**模块级闭包变量**（L38-39），不进 store —— 接 Pi 时订阅关系也要放这里，别塞进可序列化状态
- `computeTokens()` 目前是字符数 ×0.5 估算（L42-61）→ 接 Pi 后换成真实用量
- **DEV 下挂 `window.__chatStore`**（L217-219）供验收脚本驱动；接 Pi 后要改回真实 UI 驱动（既有遗留项）

---

## 三、UI 渲染点（testid 契约）

全库 **92 个唯一 testid**，其中大部分被验收脚本直接引用（标记为「验」）。接 Pi 时这些是**不动清单**的核心——
动了就要同步改脚本。

| 区域 | 关键 testid（被验收脚本依赖） |
|---|---|
| 消息流 | `message-list` / `message-item` / `scroll-to-bottom` / `empty-state` |
| 卡片 | `plan-card` / `plan-step` / `terminal-card` / `terminal-command` / `terminal-output` / `terminal-expand` / `approval-card` / `approval-option-0\|1` / `thinking-card`（未验）/ `markdown-body` / `code-block` |
| 输入区 | `composer` / `composer-input` / `composer-send` / `composer-toolbar` / `composer-toolbar-spacer` / `token-stats` / `token-stats-divider` / `token-stats-item-total` |
| 壳与侧栏 | `window-shell` / `workspace-area` / `sidebar` / `sidebar-content` / `sidebar-history` / `sidebar-footer` / `titlebar-toggle-sidebar\|preview\|theme` |
| 预览区 | `preview-pane` / `preview-tabbar` / `preview-tab-effect\|code` / `preview-source` / `preview-iframe` / `preview-copy` |
| 03–06 屏 | `run-step*` / `skill-item` / `skill-group` / `tool-toggle` / `mcp-server` / `settings-*` / `shell-*` |

> 完整清单随时可用脚本再生成（扫 `src/**/*.tsx` + `scripts/*.mjs` 的 `data-testid`）。

---

## 四、S1 要拿这张表去核对的三件事

1. **映射是否成立**：types.ts 注释里声明的事件来源（如 `text_delta` / `tool_execution_*` / Extension UI Protocol），
   在 Pi 真实事件流里对不对得上？有没有我们没预料到的事件类型？
2. **字段够不够**：每个 Block 的必填字段，Pi 的事件能不能提供？缺的怎么办（补默认 / 改契约）？
3. **模式能否保持**：`sendMessage`「只更新最后一条 assistant 消息」的模式，Pi 的事件流是否支持？
   —— 这条是虚拟滚动的命门，不支持就得改 `MessageList` 的测量策略。

---

## 五、本阶段发现的一处偏差（记下来，待修正）

`pi-integration-points.md` 第八节写的是「**mock 三档 → Pi 七档**」，实证后不准确：

- `types.ts` L28 的 `ThinkingLevel` **已经是 Pi 七档全集**（注释明确"取值直接对齐 Pi 的 `set_thinking_level`"）
- `mock/composer.ts` L44 的 `THINKING_LABEL` **也已经覆盖七档文案**
- 只有 `COMPOSER_THINKING_LEVELS`（L41）= `["low","high","max"]` 是**"UI 暴露哪几档"的清单**，是三档

→ 准确说法是：**类型与文案层已对齐 Pi，只有"暴露清单"是三档**。接真数据的改动面比上次估计的小。
（待修正 `pi-integration-points.md` 第八节）

## 六、本阶段未覆盖

- 每个 Block 字段在组件里的**具体消费点**（只列了契约字段与渲染 testid，没有逐字段追到 JSX）
- 04/05/06 屏的 mock 数据形状（`skills` / `settings` / `runs` / `shells`）—— 属 S5 范围
- 验收脚本逐条断言内容（只标了 testid 是否被引用）
