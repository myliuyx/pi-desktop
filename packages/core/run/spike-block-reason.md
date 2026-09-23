# Spike · block.reason 是否进模型上下文（backlog ⑥ / S6 §九·3）

> 2026-09-23 · 执行方 spike · 产物归 pi/_poc/（gitignore 区），结论归档本文件
> 标记串：`BLOCKED-REASON-PROBE-20260923`

## 一句话结论

**进。** 扩展在 `tool_call` 返回 `{ block: true, reason }` 后，core/Pi 把 `reason` 原样作为该次调用的 toolResult 文本回给模型（`isError: true`），模型下一轮即可读取并复述该 reason —— 「拒绝理由明示」（B2）的产品判断因此成立：模型能看到被拒原因并据此调整后续动作。

## 方法

- 复制 `pi/_poc/spike-core/agentdir/` → `agentdir-block-reason/`，`extensions/approval-gate.ts`
  改为免交互自动 block：bash 的 `tool_call` 一律返回
  `{ block: true, reason: "BLOCKED-REASON-PROBE-20260923" }`（原 select 提问删除）。
- 一次性脚本 `packages/core/run/_spike-block-reason.mjs`（照 `scripts/core-smoke.mjs` 范式）：
  起临时 core（端口 5196，env：`CORE_AGENT_DIR` 指向该 agentdir、
  `CORE_MODELS_PATH=pi/_poc/models.json`、`CORE_SHELL_PATH` 指向 PortableGit bash、
  key 经 `--env-file=pi/_poc/.env.local`）→ SSE 收全部事件 →
  POST `/prompt`：「请调用 bash 工具执行命令 echo hello，然后原样告诉我命令执行的结果。」
- 事件 dump：`packages/core/run/spike-block-reason-events.jsonl`（34 条）。
- session 证据：`agentdir-block-reason/sessions/--F--DevelopWork-WorkBuddyWork-Tiktok_auto-packages-core--/2026-09-23T09-57-29-663Z_01a0cdb2-e9be-77f8-b832-f213bb2262bd.jsonl`

## 证据

### 事件层（SSE dump 第 11、12 行）

```json
{"type":"tool_execution_start","toolCallId":"call_el1b3o4adznax33snl0b6q4g","toolName":"bash","args":{"command":"echo hello"}}
{"type":"tool_execution_end","toolCallId":"call_el1b3o4adznax33snl0b6q4g","output":"BLOCKED-REASON-PROBE-20260923","isError":true}
```

`tool_execution_end.output` 即 reason 原文（无包裹、无改写）。

### 会话层（session .jsonl 第 7 行，回给模型的 toolResult 消息）

```json
{"type":"message","id":"37f35cf5","parentId":"d53a4a04","timestamp":"2026-09-23T09:57:31.248Z","message":{"role":"toolResult","toolCallId":"call_el1b3o4adznax33snl0b6q4g","toolName":"bash","content":[{"type":"text","text":"BLOCKED-REASON-PROBE-20260923"}],"details":{},"isError":true,"timestamp":1790157451246}}
```

`role:"toolResult"` 的 `content[0].text` = 标记串 —— 这正是回灌进模型上下文的消息。

### 模型行为佐证（同一 session 的后续 assistant 文本）

> 「命令执行的结果是：
> ```
> BLOCKED-REASON-PROBE-20260923
> ```
> 该命令被安全机制拦截，未能正常执行 `echo hello`。」

模型不仅读到 reason，还能正确理解「被拦截」并放弃重试。（旁证：更早的 spike 会话
`agentdir/sessions/...2026-09-23T02-43-42-*.jsonl` 中，reason 为
"Blocked by spike (auto-reject)" 时模型连续换了 4 种命令重试 —— reason 文案本身
会影响模型的后续策略。）

## 口径备注

- 本 spike 只做只读观察，产品代码（core/ui）零改动；`agentdir-block-reason/` 在
  pi/（gitignore 区）不入库。
- `tool_execution_end` 契约里已有 `output` 字段承载该文本，UI 侧无需新字段即可展示 reason。
