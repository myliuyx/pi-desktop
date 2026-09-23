# task-M6 · Pi 对接实现规格书（第二阶段：C3–C5）

> 日期：2026-09-23　分支：`dev-m6`　预算：~10h（C6 收尾另批）
> 前置：第一阶段 C0–C2 已复核通过（见 `task-M6-C0-C2.md` §五）；本规格书沿用其**全局约束**（§零）
> 纪律：执行方实现后 progress 只标「待主控复核」；主控独立复跑、不采信回报。
> 实现分两波派发：**Wave-3 = C3**；**Wave-4 = C4 + C5**（C3 复核通过后再派，避免并行改 `chat-store`）。

---

## 零、全局约束（沿用第一阶段，新增两条）

1. 不动清单照旧：全部 `data-testid`、`lib/layout.ts`、`tokens.css`、G1–G8、8 屏六路由。
2. **默认形态仍是 mock**；真实链路一律由 URL 参数门控（现有 `?live=1&core=&token=` 已就位）。
   既有验收期望值一行不改；accept:m1~m5 + check:cn + check:adapter 最终必须全绿。
3. UI 运行时禁止 import `node:*` / pi 包 / core 运行时代码（type-only 契约除外）。
4. 不碰 `pi/`（上游 clone）与 `.workbuddy/`（记忆文件）；`ARK_API_KEY` 只从 `pi/_poc/.env.local` 经 env 注入。
5. **每次 shell 调用显式 `cd`**（cwd 不延续）；`git commit` 消息写临时文件 + `-F`；npm 用 `npm.cmd`。
   **shim bash 的 `for` 循环里不认 `VAR=x cmd` 前缀**（会 127 假失败）→ 批量跑用 `export VAR=...` 或逐条命令。
6. `vite build` 卡 rendering 超 5 分钟 → 杀进程、删 `*.tsbuildinfo` 与 `dist`、重跑。
7. **新增**：所有新增端点必须走既有安全三件套（Bearer + Host 白名单 + 无 CORS），漏一个即返工。
8. **新增**：每波各提交一次；规格书 §四 执行记录逐行填「待主控复核」。

---

## 一、C3 · 授权闭环 + 项目扩展信任门（~3h）

> 依据：`survey/S3-tool-approval.md`（授权通道 = core 实现 `ExtensionUIContext`）、
> `decision-rulings-2026-09-23.md` A 节（信任门 A3）、`spike-core-2026-09-23.md` §三·1/§三·2。

### 1.1 core 侧：授权通道转正（`src/ui-context.ts`）

从 `session.ts` 里的最小实现升级为独立模块：

- `select/confirm/input` → 生成 `requestId`（`crypto.randomUUID()`，**我们自己生成**，Pi SDK 模式不给 id）
  → SSE 下发 `approval_request`（含 `method/title/options?/message?/timeoutMs?`）→ 返回 Promise；
- `POST /approve {requestId, choice}`：**幂等 delete-then-resolve**（照 `rpc-mode.ts:776-781`：
  先 delete 再 resolve；未知/已决/过期一律静默 `accepted:false` 不报错）；
- resolve 的同时**下发 `approval_settled {requestId, resolution: "accepted"}`**（UI 乐观收卡用；
  注意 Pi 不回显授权结果，这个事件是我们造的）；
- **新增 `POST /cancel-approval {requestId}`**（S6 契约 §三·1）：resolve 后下发
  `approval_settled {resolution:"cancelled"}`；未知识别静默忽略。
- **超时**：`opts.timeout` 存在时随事件下发 `timeoutMs`；core 到点自动 resolve 默认值并下发
  `settled(cancelled)`（对齐 `rpc-mode.ts:115-120` 的语义）。
- 其余 `ExtensionUIContext` 方法保持安全空实现（S3 §2.6）。

### 1.2 core 侧：信任门 A3（`src/trust.ts`）

- 机制依据：`resource-loader.ts:388-400` —— `reload({ resolveProjectTrust })` **两段式**；
  SDK 默认**不走**信任门（`createAgentSession` 内部的 `resourceLoader.reload()` 未传该回调）。
  实现路径自选（`resourceLoaderReloadOptions` / `createAgentSessionServices` + `fromServices` 等），
  **必须在执行记录里写明选了哪条路径与依据**。
- 语义（用户裁决 A3）：读 `agentDir/settings.json` 的 `defaultProjectTrust`：
  - `"ask"`（默认）→ 用 `uiContext` 向 UI 发起一次 `confirm/select`（同一授权通道，
    标题须明示「将加载并执行项目本地扩展」）→ 结果 `settingsManager.setProjectTrusted(...)`；
  - `"never"` → 不信任（项目本地扩展/包不加载）；
  - `"always"` → 直接信任。
- 判定谓词用 `hasTrustRequiringProjectResources(cwd)`（无项目资源时不必提问）。
- 同时把「本次会话的信任结论」暴露给 04 屏数据源（C5 用）：未信任时**不列**项目本地扩展。

### 1.3 UI 侧

- `ApprovalCard` 接真实 `approval_request` / `approval_settled`（reducer 分支已就位）：
  倒计时/失效态（超时后卡片置灰不可点，避免"点了没反应"，S3 §四·5）；拒绝时**明示理由**
  （B2 裁决：拒绝理由写进 block 原因/UI 文案）。
- 授权请求的应答走 `transport.resolveApproval(requestId, choice)`；取消走 `cancelApproval`（新增到 transport）。
- **不改** `ApprovalCard` 的 testid 与既有 mock 行为。

### 1.4 测试夹具（必须入库，供复现）

新建 `packages/core/test/fixtures/agentdir-ext/`：
- `settings.json`（可为空对象；由测试脚本覆写 `defaultProjectTrust`）
- `extensions/approval-gate.ts` —— 逼出授权的最小扩展（可参照 `pi/examples/extensions/permission-gate.ts`，
  **但代码要落进我们仓库**，不依赖 gitignore 的 `pi/`）。

### 1.5 判据

1. **真实授权往返**：`core` 用该 fixture agentDir 启动（`CORE_AGENT_DIR`）+ 真实模型，prompt 触发 bash →
   SSE 收到 `approval_request` → 脚本 POST `/approve` 应答「拒绝」→ 收到 `approval_settled`；
   **断言不挂死、事件序列完整**（被拒后仍走 `tool_execution_start/end`，`isError:true`）。
2. **幂等**：同一 `requestId` 二次 POST → `accepted:false`，服务不报错。
3. **信任门三态**：造一个含 `.pi/extensions/` 的临时 cwd，
   `never` → 加载数 0；`always` → 加载数 >0；`ask` → 出现信任提问且「拒绝」后为 0（三条各留证据）。
4. 回归全绿（accept:m1~m5 + check:cn/adapter + 两包 tsc + build 隔离）。

---

## 二、C4 · 会话列表与加载（~4h）

> 依据：`survey/S2-sessions.md`。**关键**：「加载历史」与「重放实时事件」是两条路径 ——
> 会话文件里是 `SessionEntry[]`，需**独立映射**为 `Message[]`，实时 reducer 不可复用。

### 2.1 core 侧（`src/sessions.ts` + 端点）

- 封装 `SessionManager.list/listAll/open/findById/continueRecent`；
- `SessionEntry[] → Message[]` 独立映射（含非消息类 entry：`UsageEntry` → `TokenUsage`、
  `CustomMessageEntry.display`）；entry 是树结构 → **取主干**（分支 UI 记为后期，`S6 §四·4`）；
- `SessionInfo → SessionSummary`：`title = name ?? firstMessage`、`updatedAt` 由 `Date` 转 epoch ms
  （四字段全有来源，**不改类型**）；
- 端点：`GET /sessions`（清单）、`POST /sessions/load {id}`（返回 `Message[]`）、
  `POST /sessions/continue-recent`（续接最近）。

### 2.2 UI 侧

- `chat-store.loadSession` 内部改走 transport（**签名冻结**）；live 模式下 `listSessions()` 供 Sidebar；
- Sidebar 数据源在 live 形态下换成真实清单，**mock 形态与 `?empty=1` 行为不变**；
- 不改任何 testid。

### 2.3 判据

1. 跑一次真实会话（产生新的 `~/.pi/agent/sessions/...` 文件）后：`GET /sessions` 至少含 1 条且字段完整；
2. `POST /sessions/load` 返回的 `Message[]` 在 UI 中渲染出 ≥1 条消息（CDP 断言，新增证据文件）；
3. 回归全绿。

---

## 三、C5 · 04/05 屏接真数据（~3h）

> 依据：`pi-survey-plan.md` S5 段（04 屏三类数据 Pi 全给）、`pi-integration-points.md` 第七·八节。

### 3.1 core 侧

- `src/resources.ts`：`resourceLoader.getExtensions()` / `getSkills().skills` / `getPrompts().prompts`
  （入口 `get resourceLoader()`）；**按 C3 的信任结论过滤项目本地扩展**；
- `src/models.ts`：列模型（`ModelRuntime`）、切换模型、思考档位（写回 `settings.json` 的既有字段）；
- 端点：`GET /resources`、`GET /models`、`POST /models/select`、`POST /thinking`。

### 3.2 UI 侧

- 04 屏在 live 形态下用 `/resources` 真实数据（三类分组结构不变）；**MCP 区块仍由 `?mcp=1` 门控**（不因 live 而开启）；
- 05 屏 model/thinking 两个分组在 live 形态下用 `/models` 真实数据并可切换；
- 默认 mock 形态与所有 testid **一行不改**；验收 4-2/4-3/4-5/4-6 的期望值不动（live 是新增形态）。

### 3.3 判据

1. live 下 `GET /resources` 三类齐全（各 ≥1 条，扩展数受信任门影响）；
2. live 下 `GET /models` ≥1 个模型，UI 可切换且 core 侧确认写回；
3. 回归全绿（含 `accept:m4` 的 4-4 —— MCP 仍须带 `?mcp=1` 跑）。

---

## 四、执行记录（执行方填写，主控复核前只标「待主控复核」）

| 波 | 步 | 状态 | 关键决策/偏差 | 证据 |
|---|---|---|---|---|
| Wave-3 | C3 | 待主控复核 | **信任门实现路径（§1.2 要求写明）**：自建 `DefaultResourceLoader` + 显式 `reload({ resolveProjectTrust })` 两段式，再交给 `createAgentSession({ resourceLoader })`。依据：SDK 的 `createAgentSession` 内部 reload **不传该回调 = 无门**（裁决单 A·2 归因 + `sdk.js:77-78`），故门只能由入口显式触发；我们**不自创机制**，裁决规则照 Pi：`hasTrustRequiringProjectResources(cwd)` + `settingsManager.getDefaultProjectTrust()`（ask 经 uiContext 提问、never/always 直接定论），结论写回 `settingsManager.setProjectTrusted()`。Pi 现成的 `resolveProjectTrusted()` 未从包顶层导出、且其选项集是 CLI 口径（Trust／Trust parent／session-only），故只用其语义、不复用其函数。**被迫的结构变更**：启动顺序改为「先 `startServer` 再 `await ready`」（ask 态提问发生在会话创建之前，否则提问无人应答、启动死锁），窗口由 SSE 未决授权补发兜住（顺带修了刷新丢卡）。**契约偏差（2 处，均向后兼容）**：`ApprovalBlock` 补可选 `timeoutMs`（卡片倒计时的唯一数据来源）、`approval_request` 补可选 `placeholder`（S3 §五 A 草案形状，C0 漏了）。**实测纠正 1 条**：Pi 的顺序是 `tool_execution_start → approval_request → approval_settled → tool_execution_end`（`tool_call` hook 在执行包装内被调用），**不是**「先提问再 start」——S3 §3.3 只说了 start/end 都在，未说谁先。**未做**：`input` 型授权卡仍无输入控件（卡片只有选项按钮，属既有 UI 缺口，记为遗留）。**既存问题（非本轮引入，交主控裁决）**：`core-smoke` 的 `agent_end ≥1` 断言自 C2 起必红 —— C2 决定「`agent_end` 不进 C0 冻结的 AgentEvent 全集」（C0-C2 规格书 §四 C2 行「④ 偏差」），而原始 dump 里 `agent_end` 仍是 1 条（本轮 `run/events.jsonl` 实证），适配层按 C2 口径返回 null；C1 时 SSE 推的是原始事件故当时为绿。修法二选一（改适配映射新增 agent_end 事件 / 改冒烟断言口径），**均属 C2 口径，本轮未动**。 | `run/reg-c3.txt`（36/36）、`run/c3-evidence.json`（三判据原始帧序列+归因）、`run/reg-m1.txt`…`reg-m5.txt`（m2 32/32 含 2-8 授权卡）、`run/reg-cn.txt`（20/20）、`run/reg-adapter.txt`（35 项，其中 C3 新增 3 项）、`run/reg-c3-ui.txt` + `packages/ui/_probe-c3-evidence.json`（UI 倒计时/失效态 CDP 探针 **4/4**，新增 `packages/ui/scripts/probe-c3-countdown.mjs`）、`run/reg-security.txt`（5/5）、`run/tsc-core.txt`、`run/tsc-ui.txt`、`run/build-isolation.txt`（严格层 0 命中）、夹具 `packages/core/test/fixtures/agentdir-ext/` |
| Wave-4 | C4 | 待主控复核 | **映射独立成模块（`S2 §四` 的核心要求）**：`SessionEntry[] → Message[]` 写在 `core/src/sessions.ts`，**不复用** UI 的实时 reducer（两者输入形状不同：entry 树 vs 事件流，硬复用会静默错字段）。口径：`message(user/assistant)`→`Message`；`message(toolResult)`→按 `toolCallId` 挂到**宿主 assistant 消息**的 `terminal` 块（宿主未命中则挂最近一条 assistant，避免结果整条丢失）；`custom_message` 的 `display===false` 跳过、否则转 assistant 文本；`usage` 条目**仅在分支上无消息级 usage 时兜底**（两处 usage 不等价，不叠加）；`compaction`/`branch_summary`→带前缀的 assistant 文本（历史不出现「凭空少一段」）；`system` 消息与 `model_change`/`thinking_level_change`/`session_info` 等跳过并计入 `stats.skipped`。**树结构取主干**：`SessionManager.getBranch()`（leaf→root 单条 active 分支），旁支不渲染也不丢（仍在文件里），分支/fork UI 明确记后期。**`SessionInfo→SessionSummary`**：`title = name ?? firstMessage ?? "(未命名会话)"`、`updatedAt = info.modified` 的 `Date→epoch ms`（HTTP 过不了 Date）、`messageCount` 原样；**`SessionSummary` 字段未改**。`TerminalBlock.exitCode/truncated` **刻意不填**（会话 entry 里没有这两个字段，编 0/1 会显示「假成功」）。**UI 侧**：`chat-store.loadSession` **签名冻结**（`(session: Session) => void`），live 形态内部改走 transport（只取 `id`/`title`，消息体由 core 的 `POST /sessions/load` 回填），新增 `loadSessionById`/`refreshSessions`/`sessionSummaries`/`liveSessionId`（全部新增，未改名未删项）；Sidebar 的 mock 形态一行未改（仍用 `SESSION_SUMMARIES` + 冻结锚点 `SESSION_LIST_NOW`），live 才换真实清单 + `Date.now()`；**mock 形态不绑点击 = 行为零变化**，testid 与两行结构不变。**偏差**：无新增/变更既有端点契约，仅新增 3 个端点与 2 个契约类型；`?empty=1`/`?stress=` 既有行为未动。**遗留**：`continue-recent` **只读**（不重建活动 `AgentSession`，故不会把后续 prompt 写进旧会话；真正 switchSession/navigateTree 需重建会话与扩展绑定，`S6 §四` 未要求）。 | `run/reg-c4.txt`（**25/25**：真实会话落盘→清单 4 字段完整且 `updatedAt` 为 epoch ms；`load` 回读 prompt 原文；**合成会话**逐条验主干/旁支/toolResult 合并/display/usage 兜底/统计记账；未知 id→404；continue-recent 可用；无 token→401、错 Host→403）、`run/c4-evidence.json`（清单原文 + 映射结果 + 统计）、`packages/ui/_probe-c4-evidence.json` + `packages/ui/scripts/probe-c4-session-load.mjs`（CDP **7/7**：live Sidebar 渲真实清单且 mock 演示会话零混入；点历史项后 store 换成 core 的会话、**DOM 真渲染出 ≥1 条 `message-item`** 且 user 气泡含 prompt 原文、`tokenUsage.contextWindow=128000` 来自 core） | 
| Wave-4 | C5 | 待主控复核 | **04 屏数据源**：`core/src/resources.ts` 封装 `getExtensions()`／`getPrompts().prompts`／`getSkills().skills`（入口 `resourceLoader`），`hidden===true` 的扩展不列。**信任门过滤口径（实测纠正 1 条）**：未信任时 Pi **根本不加载**项目本地资源 ⇒ 它们在 `getExtensions()` 里**本就不存在**，所以「过滤前后条数差」（`filteredProjectCount`）实测恒为 0，**它不是判据**；真正的判据是 `hasTrustRequiringProjectResources(cwd)` 谓词 + `trust` 组合 → payload 给 `projectResourcesExist` / `projectTrustBlocked`（UI 据此说明原因），另保留 `filteredProjectCount` 仅覆盖「Pi 返回了项目本地条目而我们不放行」的情形。**05 屏数据源**：`core/src/models.ts` 只列 `ModelRuntime.getAvailableSnapshot()`（= 有凭证可用的模型；`getModels()` 本机 **1496 条**、绝大多数无凭证，与 Pi 自己的 `/model` 口径一致，记为实测取舍）；`select` 走 `session.setModel(model, { persist: true })`、`setThinking` 走 `setThinkingLevel(level, { persist: true })`，**写回 `settings.json` 的既有字段** `defaultProvider`/`defaultModel`/`defaultThinkingLevel`（不自造配置项）；**实测第 2 条**：本机模型 `reasoning:false` ⇒ `availableThinkingLevels=['off']`，`setThinkingLevel("high")` 后**生效值仍 `off`，但 `defaultThinkingLevel` 已写 `"high"`**，故 payload 同时给「生效值」与「用户所选」两个字段，05 屏激活态用后者（否则又是「点了没反应」）。**UI 侧**：04 屏 live 只替换 `entries`（`label`/`note`/分组顺序/testid 全沿用 `SKILL_GROUPS`，DOM 与默认形态同构），**MCP 区块仍只由 `?mcp=1` 门控、不因 live 打开**；05 屏 live 用真实模型清单并可切换、芯片仍是 mock 契约的 Low/High/Max 三档（一行未改），**live 初始无激活项** = 该目录尚无 `defaultThinkingLevel` 时的诚实口径（不拿 mock 的「默认 High」冒充真实偏好），点击后由 core 写回并立即激活。**偏差**：`ResourcesPayload` 新增 `projectResourcesExist` / `projectTrustBlocked` 两字段（纯新增）。 | `run/reg-c5.txt`（**26/26**：三类各 ≥1 且字段完整；**信任门双向** never→项目本地不列且 `projectTrustBlocked=true`／always→列出且来源标「项目内」；`/models` ≥1、`current` 在清单内；**core 侧确认写回** —— 切换模型后响应 `settings` 与临时 `agentDir/settings.json` 的 `defaultProvider/defaultModel` 均实写目标值，思考档位同理写 `defaultThinkingLevel`；非法档位/不存在模型→400、无 token→401、错 Host→403）、`run/c5-evidence.json`、`packages/ui/_probe-c5-evidence.json` + `packages/ui/scripts/probe-c5-live-screens.mjs`（CDP **8/8**：04 屏三组各 ≥1 条且来源「用户目录」、mock 独有条目零混入、`?mcp=1` 下 MCP 区块照旧渲染；05 屏模型清单 ≥2 条全部来自 core、切到 `ark-coding-alt` 后 `settings.json` 实写、点 High 后 `defaultThinkingLevel=high` 且芯片激活） |

## 五、主控复核栏（主控填写）

> **C3 复核（2026-09-23）：通过 ✅**（全部判据独立复跑，不采信执行方回报）
>
> | 命令 | 结果 |
> |---|---|
> | `check:c3`（core） | **36/36** —— ① 真实授权往返（拒绝路径事件序列完整、不挂死：`approval_request → settled → tool_execution_end`，被拒工具 `isError=true`）② 幂等四例（二次/未知 approve、未知/活跃 cancel）③ **信任门五态全对**：never→0、always→1、ask+拒绝→0、ask+信任→1、ask+超时→0、ask+cancel→0，提问标题均明示「将加载并执行项目本地扩展」 |
> | `probe-c3-countdown`（UI，CDP） | **4/4** —— 超时卡两按钮置灰不可点、倒计时文案「已超时」、理由明示 |
> | `accept:m1` / `m2` / `m3` / `m4` / `m5` | 全通过（无 `: false`）/ 32/32 / 15/15 / 16/16 / 21/21 |
> | `check:cn` / `check:adapter` | 20/20 / **35 项**（32 + C3 新增 3） |
> | core / ui `tsc --noEmit -p` | EXIT=0 / EXIT=0 |
> | `core-security-check` | 5/5（安全三件套未被新端点破坏） |
> | `vite build` + dist 隔离 | 10.53s；无指向 pi/core 的 import（唯一命中仍是 mock 消息里的示例代码字符串，非真实引用） |
>
> ⚠️ **主控本轮修掉一处遗留红灯（重要）**：`core-smoke` 自 C2 起一直 **EXIT=1** ——
> 它断言 Pi 原始事件 `agent_end`，而 C2 起 SSE 下发的是**我们自己的 `AgentEvent`**
> （`agent_end` 不在契约里，终态由 `agent_settled` 承担）。已由**主控（非实现方）**修正：
> 改为断言 `agent_settled ≥ 1` + **新增「`agent_settled` 之后无 `message_update`」**（终态顺序），
> 修正后 4/4 通过、EXIT=0。**教训**：C2 复核时只复跑了 live-smoke，漏跑上一阶段已建的
> `core-smoke` → 复核清单必须覆盖**全部既有脚本**，不能只跑本阶段新增的。
>
> 备注：实现方上报的「`tool_execution_start` 早于 `approval_request`」实序已按实测定稿注释；
> 信任门实现路径 = 自建 `DefaultResourceLoader` + 显式 `reload({resolveProjectTrust})` 两段式后
> 交 `createAgentSession({resourceLoader})`（依据 `sdk.js` 内部 reload 不传该回调 ＝ 无门）。
