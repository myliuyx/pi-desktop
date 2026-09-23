# task-M6 · Pi 对接实现规格书（第三阶段：C6 收尾）

> 日期：2026-09-23　分支：`dev-m6`　预算：~4h
> 前置：C0–C5 已全部复核通过（见 `task-M6-C0-C2.md` §五、`task-M6-C3-C5.md` §五）。
> 本阶段 = **三条遗留归置 + 全链路端到端终验 + 文档收口**。沿用 `task-M6-C3-C5.md` §零 全局约束。

---

## 一、遗留归置（三条，处置口径已定）

### 1.1 04 屏工具开关接 Pi（**做**，~1.5h）

- 现状：04 屏工具开关（read/bash/edit/write，`role=switch`）仍走 UI 本地持久化，与真实会话无关。
- 目标：live 形态下开关读写 core 的真实工具启用状态。
  - core：确认 `@earendil-works/pi-coding-agent@0.87.1` 上 `AgentSession` 的工具启用 API
    （0.86 源码里是 `setActiveToolsByName`，`agent-session.ts:2972` 附近；0.87 以实际类型为准；
    同时找读取当前启用清单的 getter）。新增 `GET /tools/active` + `POST /tools/active {names}`。
  - UI：live 下开关初始态来自 `/tools/active`，点击调 `POST`；**mock 形态与全部 testid 一行不改**
    （`accept:m4` 4-3 的期望值不动 —— live 是新增形态）。
- 判据：live 下关闭 bash → `GET /tools/active` 反映；重新打开 → 反映；**开关后发一条需 bash 的
  prompt，被关工具的行为符合预期（拒执行/不出现该工具调用）**（证据落盘）。

### 1.2 `continue-recent` 重建活动会话（**限时评估，≤45min**）

- 现状：`POST /sessions/continue-recent` 只读返回消息，不把 core 的活动会话切过去。
- 处置：先查 0.87.1 是否有公开的会话切换/重建 API（`switchSession` / 重建 `AgentSession` +
  `bindExtensions` 重挂载也算，但要评估成本与风险）。
  - **有公开且低险路径 → 实现**：`continue-recent` 后活动会话即该会话，后续 `sendMessage` 续写在其中；
  - **没有或需深改 → 记为后期**，并在代码注释与本规格书 §四 写明依据（API 名/类型出处）。
  - 两 种结果都算完成，**不许为了做而做**（会话重建涉及扩展重绑，做错比不做危险）。
- 判据：若实现 → 续写消息落在同一 session 文件（`listSessions` 里 messageCount 增长，证据落盘）；
  若记后期 → 注释 + 本文档记录依据。

### 1.3 分支 / fork 的 UI（**明确记后期，不实现**）

- 在 `S6 §十` 已归档；本阶段只需在 §四 执行记录里再次确认「记后期」并给出一句话依据
  （原型无分支交互，树结构主干已在 C4 正确处理）。

---

## 二、全链路端到端终验（`probe:c6`，~1.5h）

新增 `packages/core/scripts/c6-e2e-check.mjs`（**这是 M6 的总验收**，一层脚本串起全部能力）：

1. 起 core（真实模型 + `test/fixtures/agentdir-ext` 夹具）；
2. 经 SSE+HTTP 走一轮**完整真实会话**：prompt（要求用 bash 执行 `echo c6-e2e-ok`）→
   授权 `approval_request` → 应答「允许」→ `tool_execution_start/end`（成功）→ `agent_settled`；
3. 会话落盘：`GET /sessions` 包含本轮（messageCount ≥2）；
4. `POST /sessions/load` 该会话 → 返回消息 ≥2 且含本轮 toolCall 的 terminal 块内容；
5. `GET /tools/active` 与 `POST /tools/active` 往返（§1.1 的 API 若已实现）；
6. `GET /resources` 三类 ≥1、`GET /models` ≥1；
7. UI 层复用 `probe:c4`/`probe:c5`/`live:smoke` 各跑一遍（不重写，引用即可）。

**判据**：`check:c6` 全绿 + 证据 json 落盘；随后**全家桶终验全绿**：
`accept:m1~m5` + `check:cn` + `check:adapter` + `live:smoke` + `check:c3/c4/c5/c6` +
`security-check` + `smoke:check` + 两包 `tsc` + `vite build` 隔离。

---

## 三、文档收口（~1h，执行方起草、主控终审）

| 文件 | 写什么 |
|---|---|
| `.plan/progress-M6.md`（新建） | M6 验收记录：C0–C6 各步判据与证据索引、两条裁决的落实情况、遗留清单（含本阶段 1.2/1.3 的结论） |
| `.plan/README.md` | 状态速览改「M6 已完成（C0–C6）」；A 层表加 progress-M6 行；下一步改「进入日常使用/后续迭代」 |
| `survey/S6-integration-design.md` §八 | C0–C6 表格标注完成状态与实际耗时 |
| `.workbuddy/memory/MEMORY.md` | M6 完成状态 + 命令口径增补（`check:c6`） |

**注意**：文档里的状态必须与实测一致；「遗留」如实列（1.2 若记后期、分支 UI、MCP 暂缓、
`window.__chatStore` live 挂真实 store 的既有口径等）。

---

## 四、执行记录（执行方填写，主控复核前只标「待主控复核」）

| 步 | 状态 | 关键决策/偏差 | 证据 |
|---|---|---|---|
| 1.1 工具开关 | 待复核 | | |
| 1.2 continue-recent | 待复核 | | |
| 1.3 分支 UI | 待复核 | | |
| 二 probe:c6 + 终验 | 待复核 | | |
| 三 文档收口 | 待复核 | | |

## 五、主控复核栏（主控填写）

> ______
