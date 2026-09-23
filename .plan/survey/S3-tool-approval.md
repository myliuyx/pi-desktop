# S3 · 工具执行与授权闭环（梳理结论）

> 日期：2026-09-23　阶段：Pi 梳理 S3（`pi-survey-plan.md`）
> 前置：S0（`survey/S0-our-contract.md`）、S1（`survey/S1-event-mapping.md`）、S4（`survey/S4-transport-decision.md`）
> 方法：按 `pi-survey-plan.md` §六纪律——**先读 docs、必要时读 src、以实测为准、结论标出处**。
> 本阶段**未跑真实 dump 探针**（原因与补验清单见 §八），所有结论均来自源码实证（`文件:行号`）。

---

## 零、大图：先定位，再进细节（2026-09-23 补写）

> 本节是事后补写的。原稿直接扎进源码细节，读者容易把「Pi 的设计选择」误读成「我们发现的问题」。
> **看后面的细节前先读这一节。**

### 0.1 我们的位置：给 Pi 套壳

S4 已定：**UI 不 import Pi**，`packages/core` 包住 Pi，经 `AgentTransport` 给 UI 供数据。
→ 所以**能力层由 Pi 的扩展 / 包生态负责，我们几乎不写**。我们只做两件事：

1. **把 Pi 的清单读出来画成界面**（如 04 屏的扩展 / 技能 / 提示词，数据源见 `pi-survey-plan.md` S5）
2. **把 Pi 的提问接上界面**（← 本文档的主题）

### 0.2 Pi 是刻意极简的，不是缺功能

`docs/usage.md:306-310` 原文（设计原则）：

> Pi keeps the core small and pushes workflow-specific behavior into extensions, skills, prompt
> templates, and packages.
> **It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode,
> to-dos, or background bash.**

`intentionally` —— **刻意不做**。所以「Pi 没有权限弹窗」不是缺陷、不是缺口、不是风险，
而是**它把这件事明确划给了扩展**。本项目代码里早已有对应惯例：
`mock/skills.ts:190-192`、`mock/types.ts:96`、`SkillsScreen.tsx:29` 都用
**「自建能力 —— Pi 不内置 X」** 这个说法标注。

**→ 本文档的一切结论都应读作「这个自建能力要接到界面上的接口长什么样」，
而不是「Pi 有 bug」或「我们要补 Pi 的能力」。**

### 0.3 工具口径（先对齐，避免误读）

| 项 | 事实 | 出处 |
|---|---|---|
| 内置工具**实现** | 8 个：`read` / `bash` / `powershell`(Windows) / `edit` / `write` / `grep` / `find` / `ls` | `docs/usage.md:218`、`core/tools/index.ts:95-96` |
| **默认启用** | **4 个**：`read` / `bash` / `edit` / `write` | `core/agent-session.ts:2972-2974` |
| 我们 04 屏画的 | 正好这 4 个（`TOOL_ENTRIES` = read/bash/edit/write，`DEFAULT_ENABLED_TOOLS` 同） | `mock/skills.ts:149-188` |

**→ 04 屏与 Pi 默认是对齐的，此处无需改动。**

### 0.4 MCP 已裁决暂缓（2026-09-23）

同一次讨论中用户裁决：**MCP 暂时不管，后期再说**。理由与牵连面见
`pi-survey-plan.md` S5 的「MCP 暂缓处置」段。对本文档的影响：
**S3 不需要为 MCP 做任何事**（它本来也不在 S3 范围内，只是同属「Pi 不内置」清单）。
注意其中一条牵连：`accept:m2` 的 2-11 与 `accept:m4` 的 4-4 都依赖 MCP 区块存在。

---

## 一、结论速览（先给）

1. **★ 授权通道不是「消费 Pi 的 `extension_ui_request` 事件」，而是「core 实现 `ExtensionUIContext` 接口」。**
   这是本阶段最重要的结论，**修正了 S1 §八的表述**。因为 S4 定的 core 走 **SDK 直连**，
   而 `extension_ui_request` 只是 **RPC 模式**对这一接口的序列化形式。
2. **幂等语义两边天然一致**（首次应答生效、后续静默丢弃），`chat-store.resolveApproval` 不需要改语义。
3. **终端卡片三字段的来源全部定位**：`command` ← `resource_start.args.command`；
   `output` ← `_update.partialResult` → `_end.result.output`；`exitCode` ← `_end.result.exitCode`。
   **但我们的 `AgentEvent` 目前把 `exitCode` / `truncated` 丢掉了**，需要补。
4. **授权属于「自建能力」**（与 MCP、plan mode 同类，见 §零）：
   Pi **刻意**不内置权限弹窗（`docs/usage.md:310`）。所以 `ApprovalCard` 要真用起来，
   前提是**在 Pi 侧装或写一个这样的扩展**（可抄的示例：`examples/extensions/permission-gate.ts`）。
   **这不是缺口，是 Pi 的设计边界**；我们侧要做的只有「把它的提问接上界面」。
5. **接线时有两个必须处理的点**（详见 §五）：
   - **`hasUI` 陷阱**：core 若不注入 `uiContext`，`permission-gate` 会走「无 UI 直接 block」分支，
     **危险命令静默失败且 UI 看不到任何授权卡**，排查成本高 → core 启动须显式断言。
   - **「查看完整输出」在浏览器里没有出口**：Pi 只给 `fullOutputPath`（本机临时文件的绝对路径），
     浏览器读不到 → core 需补一个按 toolCallId 取全文的端点。**这是新增的一小块工作。**

---

## 二、要拍的板 ①：授权通道的真实形态

### 2.1 实测：`extension_ui_request` 是 RPC 模式的产物

`rpc.md` L1186 的原文：

> Extensions can request user interaction via `ctx.ui.select()`, `ctx.ui.confirm()`, etc.
> In RPC mode, these are translated into a **request/response sub-protocol on top of the base
> command/event flow**.

而接口本身的定义在 `core/extensions/types.ts:130-133`：

```ts
/**
 * UI context for extensions to request interactive UI.
 * Each mode (interactive, RPC, print) provides its own implementation.
 */
export interface ExtensionUIContext { ... }
```

**→ 即：`select` / `confirm` 是接口方法；`extension_ui_request` 只是 RPC 模式对它的实现。**

### 2.2 修正 S1 §八的说法

`S1-event-mapping.md:151-152` 写的是「`rpc.md` 事件表里没有 `extension_ui_request`」——
**这句需要修正**：它在 `rpc.md` 里，位置是 L1186–1340 的独立小节
「Extension UI Requests (stdout)」，只是**不在基础事件表内**。
`rpc-types.ts:241-291` 也有完整类型定义（9 个请求变体 + 3 个应答形状）。

### 2.3 core 的正确做法：实现接口，而非解析事件

SDK 提供了注入点（实测）：

| 证据 | 内容 |
|---|---|
| `core/agent-session.ts:244-251` | `interface ExtensionBindings { uiContext?: ExtensionUIContext; mode?: ExtensionMode; ... }` |
| `core/agent-session.ts:2610-2614` | `async bindExtensions(bindings)` → 写入 `this._extensionUIContext` / `_extensionMode` |
| `core/agent-session.ts:2688` | `_applyExtensionBindings()` → `runner.setUIContext(this._extensionUIContext, this._extensionMode)` |
| `core/extensions/runner.ts:474-475` | `setUIContext(uiContext?, mode = "print")`；不传则回落 `noOpUIContext` |

**→ core 在 `createAgentSession` 之后调 `session.bindExtensions({ uiContext, mode })` 即可。**

### 2.4 ★ `hasUI` 陷阱（必须显式处理）

`core/extensions/runner.ts:530-532`：`hasUI()` 的实现是 `this.uiContext !== noOpUIContext` ——
**`hasUI` 不是我们自己声明的，而是由「是否注入了 uiContext」推导出来的。**

而 `examples/extensions/permission-gate.ts:20-23`：

```ts
if (!ctx.hasUI) {
  // In non-interactive mode, block by default
  return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
}
```

**→ 如果 core 忘了注入 `uiContext`：`hasUI === false` → 危险命令被直接 block，
且 UI 侧看不到任何授权请求。用户只会看到命令"神秘失败"。**
这是接真数据后最容易踩且最难排查的一个坑，建议 core 启动时**断言 `ctx.hasUI === true`**。

**✅ 已实测确认（2026-09-23 spike）**：注入 `uiContext` 后，扩展侧读到 `hasUI=true`，
`ctx.ui.select()` 成功经 HTTP/SSE 下发并收到应答。反向（不注入）未实测，但源码路径明确。

### 2.5 `mode` 填什么 —— ✅ 已实测确定填 `"rpc"`

`types.ts:308`：`export type ExtensionMode = "tui" | "rpc" | "json" | "print";`
**没有「嵌入式 SDK 宿主」这一档。** `setUIContext` 的默认值是 `"print"`（`runner.ts:474`）。

**结论（2026-09-23 spike 实测）**：填 **`"rpc"`**。
`bindExtensions({ uiContext, mode: "rpc" })` 后，扩展侧实测读到
`ctx.mode === "rpc"` 且 `ctx.hasUI === true`，Pi 正常接受 —— **初版的倾向得到证实**。

依据（`rpc.md` L1205 原文）：

> Note: `ctx.mode` is `"rpc"` and `ctx.hasUI` is `true` in RPC mode because the dialog and
> fire-and-forget methods are functional via the extension UI sub-protocol.

即 `"rpc"` 的语义就是「无终端、但有能应答 UI 的客户端」—— 与我们的形态完全吻合。
填 `"print"` 会让扩展用 `ctx.mode === "tui"` 之类的守卫关掉部分 UI 能力。

### 2.6 `ExtensionUIContext` 全量方法分档

`types.ts:134-200+` 共约 20 个方法。core 按三档处理：

| 档 | 方法 | 处置 |
|---|---|---|
| **必做真实现** | `select` / `confirm` / `input` | 走我们的反向通道（见 §三） |
| **可选真实现**（有 UI 语义，可后续补） | `notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text` | `setTitle` 可接我们的 TitleBar 标题、`set_editor_text` 可预填 composer —— 有明确落点 |
| **必须给安全空实现** | `onTerminalInput` / `setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` / `setHiddenThinkingLabel` / `setFooter` / `setHeader` / `custom` 等终端专属 | 返回安全默认值（`() => {}` / `undefined`），**不可省略** |

⚠️ **空实现的风险**：一旦我们声明了 `uiContext`（`hasUI` 即为 true），扩展会放心调用对话框。
若某个对话框方法返回 `undefined`，扩展会把它理解为「用户取消」→ **静默变成"用户拒绝了"**。
所以 `select` / `confirm` / `input` **三个必须真实现**，不能留空。

---

## 三、要拍的板 ②：幂等语义与反向通道设计

### 3.1 Pi 侧的幂等语义（实测，与我们的语义一致）

`rpc-mode.ts:768-782`（应答处理）：

```ts
const response = parsed as RpcExtensionUIResponse;
const pending = pendingExtensionRequests.get(response.id);
if (pending) {
  pendingExtensionRequests.delete(response.id);   // 先 delete
  pending.resolve(response);                      // 再 resolve
}
return;                                           // 否则静默忽略
```

`rpc-mode.ts:103-107` 的 `cleanup()` 同样 `pendingExtensionRequests.delete(id)`
（超时/abort 也会清）。

**→ Pi 的语义：首次应答生效（delete-then-resolve）；重复 id 或未知/过期 id 一律静默丢弃、不报错。**

对照我们：`chat-store.resolveApproval` 是「已决 `requestId` 不再覆盖」（`S0-our-contract.md:43`）。
**两边都是 first-write-wins + 静默忽略 → 语义一致，不需要改。**

但有一处职责要分清：**我们的幂等是 UI 本地判断（防重复点击），Pi 的是 core 侧 Map 判断（防协议层重复）。
接真数据后 core 是唯一仲裁者，两者都要保留，不是二选一。**

### 3.2 超时：Pi 自己管，但 UI 仍须自己收尾

`rpc-mode.ts:115-120`：若调用方传了 `opts.timeout`，
`setTimeout(() => { cleanup(); resolve(defaultValue); }, opts.timeout)` —— **Pi 侧自动以默认值收尾**。
`rpc.md` L1193 原文：**"The client does not need to track timeouts."**

**→ 但 UI 不能因此不管**：Pi 超时后 `id` 已从 Map 移除，用户此时再点按钮会被**静默丢弃**——
用户会看到「点了没反应」。所以：

- **UI 必须自己渲染倒计时 / 超时失效态**（数据来源：请求里带的 `timeout` 字段，
  `rpc-types.ts:247` / `types.ts:99-102`）
- 超时后卡片标记为「已超时」，按钮置灰不可点（对应我们 `ApprovalBlock.resolved` 的既有语义）

### 3.3 ★ Pi 不会把授权结果 echo 回 UI

`permission-gate.ts:13-33` 的机制是 **`pi.on("tool_call", handler)` 的返回值**：
返回 `{ block: true, reason }` 表示拦下，返回 `undefined` 表示放行。
**这是一个 hook 返回值，不是事件 —— 不会产生任何下发给 UI 的事件。**

**→ 结论：`ApprovalBlock.resolved` 只能是 UI 侧的乐观写入**（现有 mock 行为恰好就是对的），
不能指望 Pi 回显。连带两个后果：

1. ~~用户拒绝后 UI 靠什么知道结果？~~ → ✅ **已实测确认（2026-09-23 core 骨架 spike）**：
   **被 block 的调用仍会走完整的 `tool_execution_start` → `tool_execution_end` 事件序列**，
   只是 `result.content[0].text` 换成 block 原因（实测值 `"Blocked by spike (auto-reject)"`）
   且 `isError: true`。
   → **`TerminalBlock` 不需要为「被拒绝」做特判** —— 它就是一条普通终端块（输出=原因、状态=error）。
   → **初版猜的「可能表现为该 toolCall 没有 `tool_execution_start`」是错的**，已纠正。
   见 `.plan/spike-core-2026-09-23.md`。
2. 若 Pi 因 timeout/abort 自行收尾，UI 不知情 → 见 3.2，必须 UI 侧兜底。

### 3.4 反向通道接口建议

`S4` §四的草案里只有 `resolveApproval(requestId, choice)` 一个 POST，不够用。建议：

```ts
// chat-store 五方法签名保持冻结（M2 契约），仅确认 choice 的编码规则：
//   select / input / editor → 用户选中的 option 字符串 / 输入文本
//   confirm                 → "true" / "false"
// 取消单独走新方法（理由见下）
resolveApproval(requestId: string, choice: string): void;

// 新增独立方法对应 Pi 的 { id, cancelled: true }（rpc-types.ts:291）
cancelApproval(requestId: string): void;
```

**为什么取消不塞进 `resolveApproval`**：本项目既有教训 #3——
「**给既有公共 API 加可选参不是向后兼容的改动** —— 优先新增独立方法」。
用保留值（如空串）表达 cancelled 会让语义变脆，不如显式新增方法。

core 侧转发时按 pending 里记下的 `method` 构造对应应答形状
（`rpc-types.ts:288-291` 三种）：

| method | 应答形状 |
|---|---|
| `select` / `input` / `editor` | `{ type: "extension_ui_response", id, value: string }` |
| `confirm` | `{ type: "extension_ui_response", id, confirmed: boolean }` |
| 任意（取消） | `{ type: "extension_ui_response", id, cancelled: true }` |

**→ 即 core 的 pending Map 必须同时存 `method`**（`rpc-mode.ts:80-83` 只存了 resolve/reject，
我们比它多存一个 method 即可）。

---

## 四、要拍的板 ③：终端卡片取值

### 4.1 事件形状（实测）

`core/extensions/types.ts:798-822`：

```ts
export interface ToolExecutionStartEvent  { type: "tool_execution_start";  toolCallId: string; toolName: string; args: any }
export interface ToolExecutionUpdateEvent { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
export interface ToolExecutionEndEvent    { type: "tool_execution_end";    toolCallId: string; toolName: string; result: any; isError: boolean }
```

### 4.2 bash 工具的结果形状（**初版写错，已按真实 dump 修正**）

> ⚠️ **初版此处只引了 `core/bash-executor.ts:29-40` 的 `BashResult`，并据此断言
> 「`exitCode` ← `tool_execution_end.result.exitCode`」—— 这是错的。**
> `BashResult` 是**内部类型**，事件里送出来的**不是它**。2026-09-23 用已有真实 dump
> `pi/_poc/fx-tool.jsonl`（420 行，3 组真实 `tool_execution_*`）核对后修正如下。

**内部类型**（`core/bash-executor.ts:29-40`，`executeBash` 的返回值，**不直接进事件**）：

```ts
export interface BashResult {
  output: string;               // stdout + stderr 合并（已 sanitize，可能已截断）
  exitCode: number | undefined; // 被 kill / cancel 时为 undefined
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;      // 输出超阈值时，完整内容落在临时文件
}
```

**事件里实际送出的形状**（`fx-tool.jsonl` 原文，逐字摘录）：

```jsonc
// tool_execution_start
{"type":"tool_execution_start","toolCallId":"call_bucy1…","toolName":"bash",
 "args":{"command":"ls | head -3"}}

// tool_execution_end —— 注意 result 是 {content, details}，不是 BashResult
{"type":"tool_execution_end","toolCallId":"call_bucy1…","toolName":"bash",
 "result":{"content":[{"type":"text","text":"No bash shell found. Options: …"}],"details":{}},
 "isError":true}

// tool_execution_update —— partialResult 是对象，不是字符串
{"type":"tool_execution_update","toolCallId":"call_bucy1…","toolName":"bash",
 "partialResult":{"content":[]}}
```

**→ 三条修正**：

1. **`result` 是 `{ content: [{type:"text",text}], details: {} }`** —— 输出文本在
   `result.content[*].text`，**不是 `result.output`**。
2. **事件里没有 `exitCode`**。`BashResult.exitCode` 若真被送出，位置只可能是
   `result.details` —— 而本 dump 里 `details` 是 `{}`（因为 bash 根本没跑起来，见下），
   **所以「exitCode 怎么取」仍未验**（已移入 §八 补验清单）。
3. **`partialResult` 是对象 `{content: [...]}`，不是 string**（初版标为「未观察到」——现已确认）。
   `content` 为数组，元素形状与 `result.content` 同族。

**附带一条环境事实（真实 dump 实证）**：本机 **3 次 bash 调用全部失败**，
返回 `No bash shell found. Options: …` 且 `isError: true` —— 模型被拒后**连续换了 3 种写法重试**
（`ls | head -3` → `cmd /c "dir /b | more +0"` → `where.exe /R … bash.exe`），三次都失败。
印证 S1 §八 与 S4 §八·3 的记载，并量化了代价：**一次 prompt 白烧 3 个 turn**。

### 4.3 映射结论（按真实 dump 修正）

| 我们的 `TerminalBlock` 字段 | 来源 | 状态 |
|---|---|---|
| `toolCallId` | 三个事件都有 | ✅ 现有适配层已挂 |
| `command` | `tool_execution_start.args.command` | ✅ **真实 dump 确认**（`{"command":"ls \| head -3"}`） |
| `output` | `_update.partialResult.content[*].text` → 终态 `_end.result.content[*].text` | ⚠️ **修正**：不是 `result.output`；现有适配层归一成 `output: string` 的方向对，但**取值路径要按上面改** |
| `exitCode?` | **事件里没有** | ❌ **修正**：初版说「来源是 `result.exitCode`」是错的，`result` 里没这个字段，**待补验** |
| `truncated?` | 同上 | ❌ 同上，**待补验**（`BashResult` 有，但事件是否透传未知） |
| `hiddenLineCount?` | **Pi 不提供** | ❌ 需 core 自算，或改为展示「已被截断 + 可查看完整输出」 |
| `status` | `isError` → `error`/`success` | ✅ 真实 dump 确认（`isError: true`） |

⚠️ **字段名不一致的坑**：`tool_call` hook 里命令在 `event.input.command`
（`permission-gate.ts:16`），而 `tool_execution_*` 里在 `event.args.command`。
**同一个「命令」在 Pi 的两处叫不同名字**，core 适配时要各按各的取，别写成同一个常量。

### 4.4 ★ 缺口：`fullOutputPath` 在浏览器里没有出口

`TerminalBlock.hiddenLineCount` 的注释写着「验收 2-7 要求给出『查看完整内容』入口」
（`packages/ui/src/mock/types.ts:73-74`）。但 Pi 给的是 **`fullOutputPath`：本机临时文件的绝对路径**。

**我们的客户端是浏览器 → 读不到本地路径。** 所以「查看完整内容」需要 core 额外提供一个端点
（例如 `GET /tools/:toolCallId/full-output`），把临时文件内容读出来回给浏览器。
这是一个**原型期不存在的真实工作量**，要计入 core 的接口清单。

---

## 五、对我们这侧文件的接口修订（本阶段产出）

### A. `packages/ui/src/adapter/pi-events.ts`（需扩）

现状（L38-40）丢字段：

```ts
| { type: "tool_execution_end"; toolCallId: string; output: string; isError: boolean }   // ← 缺 exitCode / truncated
```

建议改为：

```ts
| { type: "tool_execution_end"; toolCallId: string; output: string; isError: boolean;
    exitCode?: number; truncated?: boolean }
// 新增授权事件（名字避免与 Pi 的 extension_ui_request 混淆，因为形状已不同）
| { type: "approval_request"; requestId: string; method: "select" | "confirm" | "input";
    title: string; message?: string; options?: string[]; placeholder?: string; timeoutMs?: number }
| { type: "approval_settled"; requestId: string }   // 可选：Pi 侧超时/中止后由 core 补发，令 UI 收尾
```

**注意**：`approval_request` 是**我们的形状**，不是 Pi 的 `extension_ui_request`
（后者有 9 个变体，含 `setWidget`/`setStatus` 这类与本 Block 无关的）。
core 只把 `select`/`confirm`/`input` 三类映射进来，其余 fire-and-forget 类
（`notify`/`setStatus` 等）走别的通道，不进 Block 体系。

### B. `packages/ui/src/adapter/reduce.ts`（需补）

现状：只有 `updateTerminal` / `findTerminalOwner` 等终端逻辑（L59-76、L150-201），
**完全没有 approval 分支**。需补 `approval_request` → `ApprovalBlock`、
`approval_settled` → 标记已决。

### C. `mock/types.ts:78-88` 的 `ApprovalBlock` 注释需修订

现有注释：`/** 对应 Pi 的 extension_ui_request.id */`（L80-81）。
**SDK 模式下 Pi 不产生 id —— `requestId` 是我们自己生成的**（照抄 `rpc-mode.ts:99` 的
`crypto.randomUUID()` 做法）。注释要改，否则后人以为它是 Pi 给的。

字段映射核对（**结论：字段够用，不需要改结构**）：

| `ApprovalBlock` | `ExtensionUIContext` 对应 | 备注 |
|---|---|---|
| `requestId` | 无（我们自己生成） | 注释要改 |
| `title` | `select(title, ...)` / `confirm(title, ...)` | ✅ |
| `options: string[]` | `select(title, options: string[])` | ✅ 完全对齐 |
| `message?` | **只有 `confirm` 有独立 `message`** | `select` 时留空；`select` 的多行说明被塞进 `title`（见 `permission-gate.ts:25` 的 `\n\n`） |
| `resolved?` | 无回显，UI 乐观写（见 §3.3） | ✅ |

⚠️ **`select` 的 title 含多行**：`permission-gate.ts:25` 传的是
`` `⚠️ Dangerous command:\n\n  ${command}\n\nAllow?` `` ——
**命令原文被嵌在 title 里**。我们的 `ApprovalCard` 是把它整块渲染，还是要拆出命令部分
单独做等宽代码块？**这是 S3 之后要拍的 UI 细节板**（涉及组件结构，本轮不动组件，故只登记）。

---

## 六、对我们项目的影响面

| 项 | 结论 |
|---|---|
| **动我们哪些文件** | `adapter/pi-events.ts`（扩类型）、`adapter/reduce.ts`（补 approval 分支）、`mock/types.ts`（只改注释）；**组件结构不动** |
| **是否碰不动清单** | **不碰**。全部 testid 契约、`lib/layout.ts`、`tokens.css`、G1–G8 均无涉及；`ApprovalCard` / `TerminalCard` 只换数据源 |
| **影响哪些验收** | `accept:m2` 对卡片 testid 与内容的断言——**组件不动则风险低**。`check:adapter`（24 项）需扩用例覆盖新事件类型，**扩用例属新增，不改既有 24 项期望值** |
| **需要新增的 core 接口** | ① `resolveApproval` POST；② `cancelApproval` POST（新）；③ `GET /tools/:toolCallId/full-output`（新，因 `fullOutputPath` 在浏览器无出口） |
| **产品级前提** | 工具授权靠 extension 提供（`permission-gate.ts` 是示例）。**不启用此类扩展则 `ApprovalCard` 永不出现**——需要决定是内置一个、还是让用户自己装 |

---

## 七、对上游文档的修正

1. **`survey/S1-event-mapping.md:151-152`** —— 「`rpc.md` 事件表里没有 `extension_ui_request`」
   表述不准：它**在** `rpc.md` L1186-1340 的独立小节里，只是不在基础事件表内。
   且更关键的是：**core 走 SDK 时不消费这个事件**（§2.3）。
2. **`survey/S1-event-mapping.md:158`** —— 「`exitCode` / `truncated` / `hiddenLineCount` 的 Pi 侧来源未验」
   → **已验证**：`exitCode`、`truncated` 在 `BashResult`（`bash-executor.ts:29-40`）里；
   `hiddenLineCount` **Pi 不提供**。
3. **`survey/S4-transport-decision.md` §四接口草案** —— 需按 §3.4 补 `cancelApproval`
   与「按 method 构造应答形状」的说明；§九「授权闭环在 transport 上怎么传」可销账。

---

## 八、本阶段未覆盖 / 待补验

**⚠️ 本阶段的重要方法学缺口：全部结论来自源码阅读，未跑真实 dump。**
`pi-survey-plan.md` §六纪律第 3 条要求「事件形状的断言必须用真实会话 dump 验证」。
本轮未做的原因：POC 只跑过**纯文本会话**（`poc-pi-2026-09-22.md` §六·3 明确记录
「未验证工具调用、授权卡片、执行计划等 Pi 事件」），要产出含工具调用与授权的 dump，
需要先写一个带 `permission-gate` 扩展的探针会话并真实触发危险命令。

**→ 2026-09-23 更新：其中两条已用真实数据补掉**（详见 `.plan/spike-core-2026-09-23.md`）：
第 1 条由 core 骨架 spike 实测确认；第 2 条由已有 dump `pi/_poc/fx-tool.jsonl` 确认。
剩余项见下（已标注状态）。

**待补验清单：**

1. ~~用户拒绝授权后，UI 能看到什么终态？~~ → ✅ **已补**（spike 实测，见 §3.3）
2. ~~`tool_execution_update.partialResult` 的实际形状~~ → ✅ **已补**：是**对象 `{content: [...]}`**，
   不是 string（`pi/_poc/fx-tool.jsonl` 三条 update 均为 `{"content":[]}`）
3. **`opts.timeout` 在真实扩展里的使用情况**：`permission-gate.ts` **没传 timeout**，
   即默认无限等待（本轮 spike 用的也是不带 timeout 的写法）。若我们要给授权卡加倒计时，
   得先确认哪些扩展会传 —— **仍开放**。
4. **`select` 的多行 title 在真实场景下的稳定形状** → ✅ **已补**：spike 实测
   `"Allow this command?\n\n  ls | head -3"` —— 命令原文确实嵌在 title 里，`\n\n` 分隔稳定。
5. **`exitCode` / `truncated` 在事件里的来源** —— ❌ **仍开放**，且**已确认初版判断是错的**：
   事件里 `result` 是 `{content, details}`，spike 与既有 dump 的 `details` **均为 `{}`**
   （bash 全部失败、read 报 EISDIR，没有一次成功执行）→ **需要一个「工具成功执行」的 dump**
   才能看到 `details` 的真实内容。
6. **`hiddenLineCount` 自算方案**：Pi 只给 `truncated: boolean`，行数要 core 比对数出来，
   还是改用「已截断 + 查看完整输出」的文案（更省事，但要改验收 2-7 的期望）—— **仍开放**。
7. **多会话并发时的 `requestId` 唯一性**：`crypto.randomUUID()` 本身够用，
   但 core 的 pending Map 是否需要按会话分区（避免跨会话串号）—— **仍开放**。

**★ 本轮 spike 额外产出的两条产品级发现**（原清单里没有）：

8. **拒绝授权的真实交互代价**：spike 里模型被连续拒绝 4 次，**每次都换一种命令写法重试**
   （`ls | head -3` → `ls -1 | head -n 3` → `find . -maxdepth 1 …` → `pwd`），
   烧掉 6 个 turn。→ **产品上要决策**：拒绝后是继续让它试，还是给「拒绝并停止本次任务」的选项？
9. **`mode: "rpc"` 已实测可行**（§2.5 的待拍板项可结）：spike 里
   `bindExtensions({ uiContext, mode: "rpc" })` 之后扩展读到 `ctx.mode === "rpc"`、
   `ctx.hasUI === true`，Pi 正常接受。

**本阶段明确不做**：不改 `packages/ui` 任何代码；不写 core；不实现 `ExtensionUIContext`（只在 spike 里做了最小实现）。
