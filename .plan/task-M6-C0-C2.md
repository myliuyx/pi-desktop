# task-M6 · Pi 对接实现规格书（第一阶段：C0–C2）

> 日期：2026-09-23　分支：`dev-m6`　预算：第一阶段 ~10h（C3–C6 另批）
> 蓝图：[`survey/S6-integration-design.md`](./survey/S6-integration-design.md)（本规格书是其 C0–C2 的落地细化）
> 纪律：执行方实现后 progress 只标「待主控复核」；主控独立复跑、不采信回报。

---

## 零、全局约束（执行方必读）

1. **不动清单**照旧：全部 data-testid、`lib/layout.ts`、`tokens.css`、G1–G8、8 屏六路由。
2. **既有验收期望值一行不改**：accept:m1~m5 / probe-r7 / check:cn / check:adapter 的既有断言。
   默认形态必须仍是 mock（`?empty=1` / `?stress=N` / `?mcp=1` 惯例照旧）。
3. **不 import**：UI 包运行时禁止 `node:*`、禁止 import `pi-coding-agent`、禁止 import core 的运行时代码
   （type-only 引用契约文件除外）。验证手段：`vite build` 后在 dist 里 grep 不到 `pi-coding-agent` 与 core 源码字符串。
4. **不碰 `pi/` 目录**（上游 clone，gitignore）。core 依赖用 **npm 发布包
   `@earendil-works/pi-coding-agent@^0.87.1`**（已核实存在；注意本地梳理基于 0.86.x 源码，
   若 0.87.1 类型/事件有出入，以 **npm 包的实际 TS 类型 + 真实冒烟 dump** 为准，并记录差异）。
5. 环境坑（详见 `.plan/engineering-pitfalls.md`）：bash shim 缺命令（文件操作用 node；提交消息用
   `git commit -F <file>`）；`tsc` 必须带 `-p tsconfig.app.json`；长命令后台跑；npm 用 `npm.cmd`。
6. node 二进制：`C:/Users/myliu/.workbuddy/binaries/node/versions/22.22.2-3/node.exe`。
7. 模型 key：`pi/_poc/.env.local` 的 `ARK_API_KEY`；models 文件 `pi/_poc/models.json`。
   **只读使用，不提交、不复制进包内**。core 通过环境变量注入（`CORE_MODELS_PATH` / `ARK_API_KEY`）。

---

## 一、C0 · 契约提升（~2h）

**目标**：Block 六型与 AgentEvent 成为 UI/core 共享的纯类型契约；适配层类型对齐 spike 修正。

1. 新建 `packages/core`（`npm init` 手写 package.json）：
   - `name: "@agent/core"`、`private: true`、`type: "module"`、engines 同 ui（node >=22.19.0）。
   - dependencies：`@earendil-works/pi-coding-agent@^0.87.1`；devDependencies：`tsx`、`typescript`、`@types/node`。
2. 新建 `packages/core/src/contract.ts`：**纯类型、零 import**。内容 =
   `packages/ui/src/mock/types.ts` 的 Block 六型 / Message / SessionSummary / TokenUsage /
   PlanStepStatus（**字段签名原样搬，不改任何字段**）+ `packages/ui/src/adapter/pi-events.ts` 的
   AgentEvent 全集，并做三处修订：
   - 新增 `approval_request`（requestId/method/title/options?/message?/timeoutMs?）与
     `approval_settled`（requestId/resolution: "accepted" | "cancelled"）两事件（**我们的形状**，非 Pi 9 变体）；
   - `tool_execution_end`：`result` 形状 = `{ content: {type:"text";text:string}[]; details?: unknown }`、
     `isError: boolean`；**明确不设 exitCode/truncated 字段**（spike-tools 实证事件里没有）；
   - `tool_execution_update.partialResult`：对象 `{content:[...], details?: {}}`，非 string。
3. UI 侧改造：
   - `mock/types.ts` 改为从契约**再导出**（`export type { ... } from ...`），既有导入路径全部不破；
   - `adapter/pi-events.ts` 的 AgentEvent 改为从契约再导出；
   - `adapter/reduce.ts` 补 **approval 分支**：`approval_request` → 当前流式 assistant 消息后挂
     `ApprovalBlock`（resolved=false）；`approval_settled` → 对应块乐观写 resolved（S3 §四·6）；
     **不改既有 24 项期望值**；
   - 引用方式：UI 对契约 **只 `import type`**。若 tsconfig paths 跨包报错，备选方案 =
     契约文件放 `packages/ui/src/contract/`、core 以相对路径 import（方向翻转，core 侧用 .ts 扩展名）。
     **二选一，在执行记录里写明选了哪个、为什么。**
4. `check:adapter` 扩用例（新增，不改既有）：approval_request 挂卡 → approval_settled 乐观收卡；
   被拒工具调用 → TerminalBlock 正常渲染（isError）。

**完成判据**：`tsc --noEmit -p tsconfig.app.json` EXIT=0（`packages/ui` 下跑）；`check:adapter` 全绿；
`accept:m2` + `accept:m4` 全绿（**证明默认 mock 形态未被破坏**）；`vite build` 成功且 dist 无 core/pi 痕迹。

## 二、C1 · core 骨架转正（~4h）

**目标**：`packages/core` 起真实服务：安全三件套 + 持有 Pi 会话 + prompt/abort + SSE。

1. `src/contract.ts`（C0 已建）。
2. `src/session.ts`：
   - `createAgentSession`，`agentDir` = `CORE_AGENT_DIR` env（缺省 `~/.pi/agent`，**不存在则创建**）；
   - 模型解析：`agentDir` 内有 `models.json` 就用之；否则用 `CORE_MODELS_PATH` env + `ARK_API_KEY`
     （`ModelRuntime.create({modelsPath})` → `setRuntimeApiKey` → `getModel`，同 spike 手法）；
   - Windows：`CORE_SHELL_PATH` env 存在且 agentDir 的 `settings.json` 缺 `shellPath` 时**合并写入**
     （不改其他键；`settings-manager.ts:237` 证明读 `<agentDir>/settings.json`）；
   - `bindExtensions({ uiContext, mode: "rpc" })` —— C1 阶段 uiContext 用 spike 的最小实现
     （select/confirm/input → 内存 pending map，端点下一阶段接 SSE）；
   - 暴露 `prompt(text)` / `abort()`（Pi 公开 API）/ `subscribe` 事件管道。
3. `src/server.ts`（node:http 裸写，不引框架）：
   - `GET /health`；`GET /events`（SSE，15s 心跳，断连清理）；`POST /prompt` `{text}`；
     `POST /abort`；`POST /approve` `{requestId, choice}`（幂等 delete-then-resolve，
     未知识别静默 `accepted:false`，照 spike 手法）；
   - **安全三件套**（S6 §七）：随机 token 启动生成 → 写 `packages/core/run/core.json`
     （`{port, token}`，`run/` 进 core 的 .gitignore）；所有请求校验 `Authorization: Bearer`；
     校验 `Host` 头 ∈ {`127.0.0.1:<port>`, `localhost:<port>`}，其余 **403**（防 DNS rebinding）；
     无 `Access-Control-Allow-Origin` 放开（同源部署，跨源一律拒）。
4. `scripts/core-security-check.mjs`（core 包内，node 直跑）：无 token → 401；错 token → 401；
   错 Host → 403；带 token `/health` → 200 且 JSON 含 `ok:true`。
5. `scripts/core-smoke.mjs`：起服务 → `POST /prompt`（**真实模型**，prompt=「用一句话介绍 Pi 项目，
   不要使用任何工具」）→ 断言 SSE 收到 `message_start` ≥1、`message_update` 若干、
   `agent_end` 与 `agent_settled` 各 1 → 打印事件统计。命令模板：
   `node --env-file=../../pi/_poc/.env.local --env-file-if-exists=... node_modules/tsx/dist/cli.mjs src/main.ts`
   （env 注入方式执行方可自定，但 **key 只走 env**）。

**完成判据**：安全检查脚本全绿；真实冒烟通过（SSE 事件序列完整落 `run/` 下 dump 文件）；
`tsc`（core 侧自建 tsconfig，noEmit）EXIT=0。

## 三、C2 · 消息流接通（~4h）★ 风险最集中，做完全量可演示

**目标**：浏览器 `?live=1` 下通过 core 与真实模型对话；默认形态 mock 不变。

1. **适配上收**：`toAgentEvent`（Pi 事件 → AgentEvent）从 `packages/ui/src/adapter/from-pi.ts`
   迁到 `packages/core/src/adapt.ts`（core 侧 import pi 包的类型没问题）；UI 的 `from-pi.ts` 退役
   （reducer `applyEvent` **留在 UI**——那是 state 合并，S4 §四裁定）。
2. **SSE 批处理**（core 侧）：`message_update` 类事件 16–33ms 合并、同 Block 只发最新快照；
   **终态事件（`agent_end` / `agent_settled` / `approval_request` / `tool_execution_*` 的 start/end）
   不参与合并、立即下发**（否则 UI 永远停在 streaming）。
3. **UI 侧**：
   - `services/agent-transport.ts`：HTTP+SSE 实现（fetch + EventSource/fetch-stream），
     `baseUrl` 相对路径（core serve 静态资源时同源零配置；dev 下支持 `?core=http://127.0.0.1:<port>` 覆盖）；
   - `feature-flags.ts` 加 `isLiveEnabled()`：读 `?live=1`（同 MCP 门控范式，默认 false）；
   - `chat-store`：**五方法签名冻结**，live 分支内部走 transport；
     `window.__chatStore` 桩：live 模式下挂**真实 store 实例**（脚本驱动用，同 MCP 范式记入不动清单裁决）；
   - 发送中 token 统计、composer 状态沿用现有 UI 行为。
4. **验收**：
   - `scripts/live-smoke.mjs`（UI 包内，CDP 驱动，参照 m2 手法）：`?live=1&core=...` 起页 →
     composer 输入发送 → 断言出现 assistant 消息块且 `streaming` 态最终解除（`agent_settled` 后）；
     **产出证据 json**；若 CDP 驱动 live 有困难，降级为「SSE 层断言 + 手动验证步骤文档」，如实记录；
   - **全量回归**：accept:m1~m5 + check:cn + check:adapter 全绿（默认 mock 形态）。

**完成判据**：live-smoke 证据 + 全量回归全绿 + `tsc`/build 双绿。

---

## 四、执行记录（执行方填写，主控复核前只标「待复核」）

| 步 | 状态 | 关键决策/偏差 | 证据 |
|---|---|---|---|
| C0 | **待主控复核** | **契约位置二选一 → 选「契约放 `packages/core`，UI 用相对路径 `import type`（../../../core/src/contract.ts，依赖 `allowImportingTsExtensions`）引用」，未选「契约放 `packages/ui/src/contract/`、core 反向相对 import」。理由：UI 已大量 .ts 扩展名 import，零改动；vite 解析本地 .ts 后 tree-shaking，dist 无真实 core 代码；避免 core 反向 import 造成的循环/类型脆弱。** 偏差：①`tool_execution_end`/`tool_execution_update` 额外保留 `output:string`（守住 check:adapter 既有断言）；②`tool_execution_end.result` 按规格 `{content:ToolResultContent[];details?}` 落地，`partialResult` 为对象型；③新增 `approval_request`/`approval_settled` 两事件（我们的形状）。 | `tsc --noEmit -p tsconfig.app.json` EXIT=0；`check:adapter` **32/32**（24 既有 + 8 新增，含授权分支/被拒工具调用）；`accept:m2` 32/32；`accept:m4` 16/16（默认 mock 形态未破）；`vite build` 成功；dist grep 真实 `pi-coding-agent`/core 运行时 import **命中 0**（仅 frozen mock 展示文本含字样，非真实 import）。commit `c3502e9`。 |
| C1 | **待主控复核** | **依赖 `@earendil-works/pi-coding-agent@0.87.1`**，与 0.86.x spike 类型基本一致；`ExtensionUIContext` 方法签名更严格，用 `as unknown as ExtensionUIContext` 桥接（已在 reduce/session 标注）。`makeUiContext` select/confirm/input 实现 pending map，`/approve` 幂等 delete-then-resolve；其余方法安全空实现。Windows `CORE_SHELL_PATH` 合并写入 `agentDir/settings.json`（缺省不覆盖）。模型经 `CORE_MODELS_PATH`+`ARK_API_KEY` env 注入（key 只走 env，不落提交文件）。安全三件套：随机 Bearer token→写 `run/core.json`、所有请求校验 Authorization、Host ∈ {127.0.0.1:`<port>`,localhost:`<port>`} 否则 403、无 CORS 放开。 | core `tsc -p tsconfig.json` EXIT=0；`core-security-check.mjs` **5/5**（无 token→401 / 错 token→401 / 错 Host→403 / 正确→200 含 ok:true）；`core-smoke.mjs` 真实模型 SMOKE_EXIT=0，**109 事件**（message_start=3 / message_update=98 / agent_end=1 / agent_settled=1），dump 落 `run/events.jsonl` 与 `run/smoke-report.json`。commit `6045713`。 |
| C2 | **待主控复核** | **① 适配上收**：`toAgentEvent` 逐行等价迁至 `packages/core/src/adapt.ts`（仅 import 改 `./contract.ts`），UI `src/adapter/from-pi.ts` 删除退役；`applyEvent` reducer 按要求**留在 UI**。**连带改动**：`check:adapter` 的 import 由 UI 的 from-pi 改为 core 的 adapt.ts（验收脚本非 UI 运行时，不违反约束 #4）。**② SSE 批处理**（core `server.ts`）：`message_update` 进全局 pending 快照 + 20ms 定时器（落在 16–33ms 区间），同窗口只留最新快照；**其余一切事件（含终态）先 `flushBatch()` 再立即 push**，故终态不丢、不与批处理乱序；core 自产的 `approval_request/approval_settled` 走 `dispatchAgent`，同样先 flush 后立即下发。**③ UI**：新增 `services/agent-transport.ts`（手写 fetch+ReadableStream 读 SSE —— EventSource 不能带 Authorization 头）；`feature-flags.ts` 加 `isLiveEnabled()`（读 `?live=1`，默认 false）与 `getLiveConfig()`（读 `?core=` / `?token=`）；`chat-store` **五方法签名与 mock 分支一行未改**，live 分支内部走 transport + `applyEvent`；`window.__chatStore` 在 live 下挂真实 store 实例（dev 下行为不变）。**④ 偏差**：`agent_end` 未进 C0 冻结的 AgentEvent 全集，adapt 仍按原 UI 行为返回 null（streaming 由 `message_end`／`agent_settled` 解除），**不改 C0 契约**；live 页仍以 `INITIAL_SESSION` 7 条 mock 起步（真历史属 C4），`?live=1` 只替换消息通道 —— 故 live-smoke 断言严格限定「发送后**新增**」的消息（首版扫全量会被 mock 文本误判为通过，已修）。 | **live-smoke 真跑通（未降级）**：`packages/ui/scripts/live-smoke.mjs`（npm `live:smoke`），CDP 驱动 → 起 core（真实模型）→ 同源托管 UI dist → `?live=1&token=` 发送 → **12/12 断言全绿**（8 项 CDP：store 挂真实实例／发送按钮触发／新增 assistant 块含文本／等待期观察到 streaming=true／streaming 最终解除／消息数增加／DOM 渲染出新增 `message-item[data-role=assistant]` 且文本非空／DOM streaming 解除；4 项传输层），证据 `packages/ui/_live-smoke-evidence.json`（含 origin http://127.0.0.1:5188、真实模型回复原文、steps/assertions/transport）。**批处理实证**：原始 Pi `message_update` **137** → SSE 实发 **34**（**合并率 0.752**），末帧为 `agent_settled`、其后 0 条 update。**全量回归**：accept:m1（19 steps、「全部通过」true）／m2 **32/32**（dev 5180）／m3 **15/15**／m4 **16/16**（dev 5180）／m5 **21/21**；check:cn **20/20**；check:adapter **32/32**。**双绿**：ui `tsc --noEmit -p tsconfig.app.json` EXIT=0（`--listFiles` 实检 58 个 ui/src + 契约 contract.ts，非假绿）；core `tsc --noEmit -p tsconfig.json` EXIT=0；`vite build` 6.90s（清 tsbuildinfo+dist 后）。**dist grep**：`pi-coding-agent`／`@agent/core`／`createAgentSession` 仅命中 mock 展示文案 3 处，**无真实 import**；live 代码（`/events` `/prompt` `/abort` `/approve` `__chatStore`）已入包。**三个坑**（全在 live-smoke 首跑踩到）：① `window.setText is not a function` —— cdp.mjs 的 `SET_TEXT_HELPER` 只声明局部函数未挂 window，改为自建 `window.__LT`；② 批处理基线在发送前读 `run/events.jsonl` 恒为 0 → 误判「放大」，改为生成结束后读；③ 证据汇总把本地旧 evidence 当基线叠加 → 开跑先删旧证据文件并整体重算 summary。**遗留**：`.workbuddy/tmp-clean-build.mjs`（Wave-1 遗留临时脚本，未清，见报告）；live 页初始会话仍为 mock（C4 接真历史）。 |

## 五、主控复核栏（主控填写）

> 复核日期：2026-09-23。**全部判据独立复跑通过（不采信执行方回报），C0/C1 复核通过 ✅**
>
> | 命令 | 结果 |
> |---|---|
> | `tsc --noEmit -p tsconfig.app.json`（packages/ui） | EXIT=0 |
> | `check:adapter` | **32/32**（24 既有 + 8 新增） |
> | `accept:m2`（M2_ORIGIN=http://127.0.0.1:5180，dev 5180） | **32/32** |
> | `accept:m4`（M4_ORIGIN=http://127.0.0.1:5180） | **16/16** |
> | core `tsc --noEmit -p tsconfig.json` | EXIT=0 |
> | `core-security-check` | **5/5**（401/401/403/200/ok:true） |
> | `core-smoke`（真实模型） | 通过，108 事件（start=3/update=97/end=1/settled=1） |
> | `vite build` | 6.6s（首次复跑卡渲染 18min，清 tsbuildinfo+dist 后即刻恢复——台账坑复现）；dist grep 仅 mock 文案命中，**无真实 core/pi import** |
> | 抽查代码 | `server.ts` 安全段（Bearer 401 / Host 白名单 403）与 `reduce.ts` approval 分支（乐观 resolved）实现与 S3 语义一致 |
>
> 备注：① 执行方保留 `output:string` 字段属合理偏差（守住既有 check:adapter 断言）；② 端口口径备注——
> vite.config.ts 现写 5173，台账口径 5180 需显式 `--port 5180 --strictPort` 启动（本次按台账执行）；
> ③ 冒烟一prompt 3 条 message_start 与 S1「一 prompt 多 assistant 消息」实测一致。
