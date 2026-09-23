# S1 · Pi 事件 → Block 映射

> 日期：2026-09-22　阶段：Pi 梳理 S1（`pi-survey-plan.md`）
> 依据：`packages/coding-agent/docs/rpc.md` L855-1100（事件类型全集）+ **两次真实会话 dump 实证**
> 靶子：`survey/S0-our-contract.md`（我方冻结契约）
> 复现：`pi/_poc/dump-events.ts`（`POC_SKIP_MSG_UPDATE=1` 可过滤刷屏的 message_update）

---

## 一、结论速览

1. **映射基本成立**——`types.ts` 注释里声明的事件来源大体对得上，可直接映射。
2. **但有一个结构性差异文档没写**：**一次 `prompt()` 可能产生多个 turn、多条 assistant 消息**，
   我们 `chat-store` 现在只建一条 assistant 占位消息 → 适配层必须支持追加。
3. **SDK 订阅到的事件比 RPC 文档 richer**（带 `message` 与 `partial` 累积字段），组装成本比文档说的低。
4. 授权（ApprovalBlock 的来源）**不在这份事件表里**，属 S3（Extension UI Protocol）。

---

## 二、实测事件序列（两次会话）

**纯文本会话**（prompt "只回复一个单词：pong"）

```
agent_start → turn_start → message_start(system) → message_end
→ message_start(user) → message_end
→ message_start(assistant) → message_update ×20 → message_end
→ turn_end → agent_end → agent_settled
```

**工具会话**（prompt 要求用 bash 列目录）

```
agent_start → turn_start → [system][user] → assistant(thinking+toolCall)
→ tool_execution_start → tool_execution_update → tool_execution_end
→ message_start/end(toolResult) → turn_end
→ turn_start（第 2 轮）→ assistant → tool_execution_* → toolResult → turn_end
→ turn_start（第 3 轮）→ assistant(thinking+text) → turn_end
→ agent_end → agent_settled
```

计数：`turn_start=3, message_start=7, message_update=286, tool_execution_*=2 组`。

---

## 三、message content → Block（核心映射）

Pi 的 assistant message 是 **`content[]` 数组**，实测到三种 content 类型，与我们的 Block 一一对应：

| Pi `content[].type` | 我们的 Block | 字段映射 | 出处 |
|---|---|---|---|
| `{type:"thinking", thinking, thinkingSignature:"reasoning_content"}` | `ThinkingBlock` | `content` ← `thinking` | dump 实证 |
| `{type:"text", text}` | `TextBlock` | `content` ← `text`；`streaming` ← 处于 `message_update` 中（收到 `message_end` 置 false） | dump 实证 |
| `{type:"toolCall", id, name, arguments}` | `ToolCallBlock` | `toolCallId` ← `id`，`toolName` ← `name`，`args` ← `arguments` | dump 实证 |

→ **一条 assistant Message 天然就是多个 Block**（本例 thinking + text / thinking + toolCall），
与 `Message.blocks: Block[]` 的结构吻合，`contentIndex` 即数组下标。

### 工具执行 → TerminalBlock

| Pi 事件 | 映射 | 备注 |
|---|---|---|
| `tool_execution_start` | 新建 TerminalBlock：`command` ← `args.command`（bash），`status:"running"` | 出处 rpc.md L1016 |
| `tool_execution_update` | `output` ← `partialResult.content[].text` | 文档称是**累积值**（直接替换显示）；**本例实测为 `content:[]`**，未观察到流式输出 |
| `tool_execution_end` | `output` ← `result.content[].text`（汇总），`status` ← `isError ? "error" : "success"` | 出处 rpc.md L1042 |
| `toolResult` message（role=toolResult） | 同一 toolCallId 的补充来源，含 `isError` | 与 `tool_execution_*` 二选一，**建议以 `tool_execution_*` 为主**（有 start→end 过程） |

`exitCode`：**Pi 事件里没有 exitCode 字段**（`result.details` 本例为 `{}`）。我们 `TerminalBlock.exitCode` 是可选字段，
接真数据时只能留空或从 details 里找（`details.truncation` / `fullOutputPath` 与我们的 `truncated` / `hiddenLineCount` 可能对应，**待验证**）。

---

## 四、事件 → 我们的处理策略

| Pi 事件 | 处理 |
|---|---|
| `message_start` / `message_end`（role=**system**） | **忽略**（我们不渲染 system；system 消息体含整份系统提示，体积大） |
| `message_start` / `message_end`（role=**user**） | 不重复渲染——user 消息由我们自己发出时已入 store |
| `message_start` / `message_end`（role=**assistant**） | 新建 / 定稿一条 assistant Message，`blocks` 由 `content[]` 映射 |
| `message_update` | 更新**当前** assistant 消息的 blocks（streaming=true） |
| `tool_execution_start/update/end` | 按 `toolCallId` 定位并更新 TerminalBlock |
| `toolResult` message | 补全终端结果（可选） |
| `turn_start` / `turn_end` | 轮次边界；`turn_end.toolResults` 可作本轮完成的信号 |
| `agent_start` / `agent_end` / `agent_settled` | 全局状态：`streaming` 起止（**`agent_settled` 才是真结束**，之前可能还有 retry/compaction） |
| `queue_update` / `compaction_*` / `auto_retry_*` / `summarization_retry_*` / `extension_error` | **原型无对应 UI** → 先忽略，建议留一个调试通道接收 |

⚠️ `agent_end` ≠ 结束：文档明确 `agent_end` 之后可能还有自动重试、压缩重试或排队续接，
**`agent_settled` 才是"不再自动继续"的信号**（rpc.md L905-911）。

---

## 五、实测与文档的三处不一致（以实测为准）

1. **文档说 `message_update` 不带累积字段，实测带了。**
   rpc.md L991-996 说"intentionally omits the former cumulative `message` field and `assistantMessageEvent.partial`"，
   但 SDK `subscribe` 收到的 `message_update` **同时有 `message` 和 `assistantMessageEvent.partial`**（完整累积 assistant 消息）。
   → 原因：RPC 文档描述的是 `--mode rpc` 打到 stdout 的序列化事件；我们用 SDK subscribe，拿到的是内部事件对象，字段更全。
   → **影响：适配层不必自己按 `contentIndex` 攒字符串**，可直接用 `event.message.content[]` 重建 blocks（更稳）。
   → 但仍要留意：依赖文档未承诺的字段有变更风险，**建议以 `assistantMessageEvent` 的 delta 为主、`message` 为辅做校验**。

2. **`tool_execution_update` 的 `partialResult.content` 实测为空数组**，文档称是累积输出。
   本例 bash 在 Windows 上直接失败（未产生流式输出），不足以判定；**需在能跑通 bash 的环境复验**。

3. **一次 `prompt()` 会产生多个 turn / 多条 assistant 消息**，文档的事件表看不出来。

---

## 六、对 `chat-store` 模式的冲击（重要）

`S0` 记下的关键模式是：`sendMessage` 一次追加 user + **一条** assistant 占位，之后只更新最后一条 assistant。
实测表明：

- **一个 prompt 可以产生 N 条 assistant Message**（本例 3 条，跨 3 个 turn，中间夹着工具执行与 toolResult）
- 每条 assistant Message 自己含多个 Block（thinking + text / thinking + toolCall）

→ 适配层必须支持：
1. **按 `message_start(assistant)` 追加新的 assistant 消息**（不再是一条占位打天下）
2. **只更新"当前最后一条 assistant 消息"**——这条不变，虚拟滚动的测量稳定性可以继续依赖
3. TerminalBlock 按 `toolCallId` 挂到对应消息（或独立成块）

### 性能提醒

一次会话实测 **286 个 `message_update`**（大量 thinking delta）。直接每个事件 setState 会造成渲染风暴，
适配层应做**批处理**（rAF 或 ~16-33ms 节流）后再写入 store。

---

## 七、适配层形状建议（S1 要拍的板）

**结论：带状态的 reducer，不是纯函数。**

理由（实测支撑）：
- 需要跨事件维护"当前 assistant 消息"与"按 toolCallId 索引的终端块"——有状态
- 但状态很轻、边界清晰（一个 Map + 当前消息 id），可以做成**纯 reducer 形态**：
  `(state: UiMessages, event: PiEvent) => UiMessages` —— 输入确定、无副作用，**易单测**

建议接口草案：

```ts
// 纯 reducer，事件进、UI 的 Message[] 出
export function applyEvent(state: DraftState, event: PiEvent): DraftState;
// DraftState: { messages: Message[]; currentAssistantId: string | null; terminals: Map<string, TerminalBlock> }
```

先写 reducer + 单测（用本次 dump 的 `pi/_poc/events-dump.jsonl` 当 fixture 回放），再接 store。

---

## 八、本阶段未覆盖

- ~~**授权闭环**（ApprovalBlock 的来源）~~ → **S3 已完成**，见 `survey/S3-tool-approval.md`。
  **本条原表述需修正两处**：
  ① 「`rpc.md` 事件表里没有 `extension_ui_request`」不够准确——它在 `rpc.md` **L1186-1340
  的独立小节**「Extension UI Requests (stdout)」（`rpc-types.ts:241-291` 有完整类型），
  只是不在**基础**事件表内；
  ② 更关键的是：**core 走 SDK 时不消费这个事件，而是实现 `ExtensionUIContext` 接口**
  （`types.ts:130-133`「每个 mode 提供自己的实现」；注入点 `agent-session.ts:2610-2614`）。
  换句话说 `extension_ui_request` 是 **RPC 模式**的序列化形式，与我们无关。
- **PlanBlock**：Pi 不内置 plan mode，需自建 → **S5**
- **TokenUsage.contextWindow**：Pi 的 `message.usage` 无此字段（只有 input/output/cacheRead/cacheWrite/reasoning/totalTokens/cost），
  需从 `get_session_stats.contextUsage.contextWindow`（rpc.md L584-588）或 model 取 → 待定
- **bash 在 Windows 不可用**：实测 `No bash shell found`（缺 Git Bash / MSYS2 / Cygwin，可用 `shellPath` 配置）。
  我们的桌面 app 若在 Windows 上要跑终端工具，**必须显式处理 shellPath**——否则终端卡片永远返回错误
- ~~`exitCode` / `truncated` / `hiddenLineCount` 的 Pi 侧来源未验~~ → **已验（S3 §四）**：
  `exitCode` 与 `truncated` 在 `core/bash-executor.ts:29-40` 的 `BashResult` 里
  （`exitCode: number | undefined`、`truncated: boolean`，另有 `cancelled` 与 `fullOutputPath`）；
  **`hiddenLineCount` Pi 不提供**，需 core 自算或改用别的文案
- 工具流式输出（partialResult 非空的情况）未观察到
