# S6 · 《Pi 对接设计》（汇总定稿）

> 日期：2026-09-23　阶段：Pi 梳理 S6（`pi-survey-plan.md` §三·S6）
> 依据：`survey/S0-our-contract.md`、`S1-event-mapping.md`、`S2-sessions.md`、`S3-tool-approval.md`、
> `S4-transport-decision.md`、`spike-core-2026-09-23.md`（含两条已裁决项
> `decision-rulings-2026-09-23.md`）、`pi-integration-points.md`
> **本文是 Pi 对接的实现蓝图与唯一开工入口**；各专项结论仍在原 survey 文档，本文只做汇总与指针（不复制）。

---

## 一、总体架构（定稿，全部有实证）

```
浏览器（packages/ui，8 屏六路由，一行架构不改）
   │  只认 AgentTransport 接口 + 我们自己的 AgentEvent 类型（不 import Pi、不 import node:*）
   ▼
packages/core（普通 Node 进程，本地 HTTP + SSE，绑 127.0.0.1）
   │  ├─ 安全：一次性 token（Bearer）+ 拒绝跨来源 + 校验 Host 头（防 DNS rebinding）
   │  ├─ 实现 ExtensionUIContext（mode:"rpc"）——授权/提问的反向通道（S3、spike 实测闭环）
   │  ├─ 显式传 resolveProjectTrust 回调 —— 项目本地扩展信任门（裁决 A3，resource-loader.ts:388-400）
   │  ├─ Pi 事件 → AgentEvent 适配 + SSE 批处理（S4 §六·4）
   │  └─ 同时 serve 前端静态资源 → 同源，transport baseUrl 用相对路径 ""（用户零配置）
   ▼
Pi SDK（pi-coding-agent：AgentSession + bindExtensions + SessionManager + resourceLoader）
   ▼
模型端点（Pi 持有，~/.pi/agent/models.json；UI 永不直接请求模型 —— 两个 baseUrl 勿混，S4 §四）
```

- 传输选型 B（独立进程 + HTTP/SSE）：`S4 §一~§三`；**spike 已实测跑通**（`spike-core-2026-09-23.md` §一）。
- 形态：本地服务 + 浏览器（`S4 §八·1` 已裁决）；Electron 降级为可选外壳。
- **信任门（A3 裁决）**：core 必须显式传回调 —— `ask`（默认）→ 经 UI 提问；`never` → 忽略
  项目本地资源；`always` → 直接加载。判定谓词 `hasTrustRequiringProjectResources(cwd)`。
  机制见 `decision-rulings-2026-09-23.md` A·2（`resource-loader.ts:388-400` 两段式）。
- **拒绝后重试（B 裁决）**：暂不做「拒绝并停止」；Pi 有公开 `abort()`（`agent-session.ts:1786`），
  后期扩展零障碍。拒绝理由明示随 core 顺手带上。

---

## 二、`packages/core` 模块规划

| 文件（拟） | 职责 | 依据 |
|---|---|---|
| `server.ts` | HTTP + SSE 服务、路由、token/Host 校验、静态资源 serve | S4 §五/§六/§八·5 |
| `session.ts` | 持有 `AgentSession`；`prompt` / `abort()` / `bindExtensions({uiContext, mode:"rpc"})`；**Windows 需把 `shellPath` 写进 `<agentDir>/settings.json`**（实测生效，本机用 PortableGit bash；05 屏宜暴露此项） | `agent-session.ts:2610-2614`、`settings-manager.ts:237`、`docs/windows.md`、spike-tools |
| `ui-context.ts` | `ExtensionUIContext` 实现：select/confirm → SSE 下发 `approval_request` + 等 POST 回收（幂等照抄 delete-then-resolve） | S3 §二~§四；`rpc-mode.ts:776-781` |
| `adapt/` | Pi 事件 → `AgentEvent`（`toAgentEvent`，从 `packages/ui/src/adapter/` **上收**到 core） | S4 §四「reducer 落在 core 侧」 |
| `sessions.ts` | `SessionManager.list/listAll/open/continueRecent/findById` 封装 + `SessionEntry[] → Message[]` 映射（独立于实时 reducer） | S2；`session-manager.ts:1758/1779/1624/1651/1732` |
| `resources.ts` | 04 屏数据源：`getExtensions()` / `getSkills().skills` / `getPrompts().prompts` | `resource-loader.ts:41-42`、`agent-session.ts:1089/1779-1780` |
| `models.ts` | 05 屏模型配置透传（`models.json` + `$ARK_API_KEY` 插值；`ModelRuntime.create → setRuntimeApiKey → getModel`） | `pi-integration-points.md` 第七、八节 |
| `trust.ts` | `resolveProjectTrust` 回调实现（`ask` 态经 ui-context 发起提问并持久化按目录的选择） | 裁决 A3 |
| `full-output.ts` | `GET /tools/:toolCallId/full-output` —— Pi 给的 `fullOutputPath` 是本机临时文件，浏览器读不到 | S3 §六·8 |

**UI 侧改动清单**（实现期才动，本轮零改动）：`services/agent-transport.ts`（HTTP+SSE 实现）、
`chat-store` 五方法内部实现替换（**签名冻结**，S0）、Block 六型从 `mock/types.ts` 提升为共享契约
（type-only 引用）、DEV 下 `window.__chatStore` 桩改回真实 UI 驱动（范式同 MCP 门控）。

---

## 三、接口契约定稿（在 S4 §四草案上修订）

`AgentTransport`（UI 唯一依赖）：

```ts
export interface AgentTransport {
  // 会话
  listSessions(): Promise<SessionSummary[]>;
  loadSession(id: string): Promise<Session>;
  sendMessage(text: string): Promise<void>;
  abort(): Promise<void>;                      // ← 已实证：Pi 有公开 abort()，agent-session.ts:1786
  resolveApproval(requestId: string, choice: string): Promise<void>;
  cancelApproval(requestId: string): Promise<void>;  // ← 新增，见下
  // 模型
  listModels(): Promise<ModelOption[]>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  // 事件流
  subscribe(listener: (event: AgentEvent) => void): () => void;
}
```

修订三条（全部来自 S3/S2 实测，非拍脑袋）：

1. **新增 `cancelApproval(requestId)` 独立方法**：Pi 有三种应答形状
   （`rpc-types.ts:288-291`：value / confirmed / cancelled），而 `resolveApproval` 签名冻结（M2）
   —— 按既有教训 #3「给公共 API 加可选参不是向后兼容，优先新增独立方法」。
2. **事件新增 `approval_request` / `approval_settled`**（**我们的形状**，不是 Pi 的 9 变体）；
   `adapter/reduce.ts` 需补 approval 分支（现状没有）。`ApprovalBlock.resolved` 由 UI 乐观写入
   —— Pi 不回显授权结果（S3 §四·6，现状 mock 行为恰好正确）。
3. **`tool_execution_end` 字段修正**（spike + spike-tools 两轮实证）：事件里 `result` 只有
   `{content:[{type:"text",text}]}`，**没有 `exitCode`、`truncated`，成功时连 `details` 都不存在**
   （事件键 = `type/toolCallId/toolName/result/isError`）；`partialResult` 是对象 `{content:[...], details:{}}`。
   **⇒ `TerminalBlock.exitCode` / `.truncated` 无数据源，UI 按 `isError` 表达成败即可**
   （残余未知：超长输出截断时 details 是否带 fullOutputPath，低优先，C2 遇到再看）。
   被拒调用走完整 `tool_execution_start→_end`、`isError:true` —— **`TerminalBlock` 不特判被拒**。

注意两处同名不同义：`tool_call` hook 是 `event.input.command`，`tool_execution_*` 是
`event.args.command`（S3 §五·7）；授权卡 title 是多行 `\n\n` 分隔、命令嵌在其中
（spike 实测原文），`ApprovalCard` 拆等宽代码块渲染（数据侧依据已齐）。

---

## 四、core 内部四个必做设计点（S4 §六 + spike 修订）

1. **SSE 批处理**：一次会话 286 条 `message_update`（S1 实测）—— rAF 级 ~16-33ms 合并、
   同一 Block 只发最新快照；**终态信号（`agent_settled`）不参与合并、单独下发**，
   否则 UI 永远停在 streaming。
2. **授权通道**：core 实现 `ExtensionUIContext`（**不是**解析 `extension_ui_request` 事件）；
   **`hasUI` 陷阱**——漏注入 ⇒ 危险命令静默 block 且 UI 无授权卡（S3 §三·2）；
   Pi 侧超时后 id 已被移除 ⇒ **UI 必须自渲染倒计时/失效态**，否则「点了没反应」（S3 §四·5）。
3. **信任门**：按 A3 实现（§一）；04 屏扩展清单同语义过滤——未信任目录不列项目本地扩展。
4. **会话双路径**：实时事件走 reducer；历史加载走 `SessionEntry[] → Message[]` 独立映射
   （**实时 reducer 不能复用**，S2）。entry 是树结构（fork/clone）——原型无分支 UI，
   **取主干，树/分支支持记为后期**（S2 待拍板项就此收口）。

---

## 五、逐屏数据源（全部实证）

| 屏 | 数据源 | 备注 |
|---|---|---|
| 01 工作台 | 事件流（S1 映射）+ `?empty=1` mock 分支 | ApprovalCard/TerminalCard 按 §三·3 取字段 |
| 03 运行详情 | 同 01 事件流（步骤/状态映射见 S1） | |
| 04 技能与工具 | `resourceLoader` 三 getter（扩展/技能/提示词）；**MCP 区块维持门控 `?mcp=1`**（默认不渲染） | 工具 8 内置、默认启 4（read/bash/edit/write），`TOOL_ENTRIES` 已对齐 |
| 05 设置 | `models.ts` 透传 Pi 配置 | `pi-integration-points.md` 第七、八节已梳理完 |
| 00 / 06 | 不受影响 | |

---

## 六、mock 去留统一裁决（S1/S2/S5 一并收口）

**全部保留 mock 分支供回归**，沿用「URL 参数 + feature-flags」惯例，理由同一句话：
core 输出与 mock 数据同构（S4 §四，`AgentEvent` 自定义类型的直接回报），验收脚本不用 core 也能跑。

| mock 资产 | 处置 | 入口 |
|---|---|---|
| `?empty=1` / `?stress=N` | **保留**（S2 已建议）——`?stress=` 是纯 UI 压测，接真数据后没法造 600 条真实消息 | 惯例同 MCP |
| MCP 区块 | **维持门控**（已裁决暂缓，恢复 = `isMcpEnabled()` 返回 true） | `?mcp=1` |
| `INITIAL_SESSION` 7 条 / `SESSION_SUMMARIES` 8 条 / 04 屏 mock | 保留，`accept:m1~m5` 继续按 mock 断言；core 侧验收**另立**脚本（§八） | — |
| `check:adapter` 24 项 | 保留并**扩用例**（approval 分支 + spike 修正后的字段），**不改既有期望值** | fixture 现读 |

## 七、安全模型清单（core 实现的硬验收）

① 随机端口 + 端口文件；② 一次性 token（Bearer），**不能删**——客户端是浏览器、任意网页可请求
127.0.0.1；③ 拒绝跨来源 + **校验 Host 头防 DNS rebinding**；④ 项目本地扩展信任门（A3）；
⑤ token/端口文件不进仓库不进日志。（S4 §六/§八·5）

---

## 八、落地顺序与预算（建议）—— ✅ **全部完成（C0–C6，2026-09-23 同日三波执行并通过复核/待复核）**

| 步 | 内容 | 估时 | 实际 | 前置 |
|---|---|---|---|---|
| C0 | Block 六型提升共享契约 + `AgentEvent` 补 approval/字段修正 + `check:adapter` 扩用例 | ~2h | ✅ 完成（复核通过） | 无 |
| C1 | core 骨架转正：`server.ts` + 安全三件套 + 静态资源 + `session.ts`（prompt/abort） | ~4h | ✅ 完成（复核通过） | C0 |
| C2 | 事件适配上收 + SSE 批处理 + 终态单独下发；01 屏接真实会话 | ~4h | ✅ 完成（复核通过；复核顺手修掉 core-smoke 红灯） | C1 |
| C3 | `ui-context.ts` 授权闭环 + 信任门 A3 + 倒计时/失效态 | ~3h | ✅ 完成（check:c3 36/36） | C1 |
| C4 | `sessions.ts` 会话列表/加载/续接 + `SessionEntry[]→Message[]` 映射 + Sidebar 接真数据 | ~4h | ✅ 完成（check:c4 25/25） | C1 |
| C5 | 04 屏 `resources.ts` + 05 屏 `models.ts` | ~3h | ✅ 完成（check:c5 26/26） | C1 |
| C6 | ~~core 侧验收脚本（probe-core-*）~~ → 实际形态：三条遗留归置（工具开关接 Pi / continue-recent 重建 / 分支 UI 记后期）+ **总验收 `check:c6` 33/33**（全链路端到端 + UI 探针引用）+ 文档收口 | ~4h | ✅ 完成（待主控复核） | C2/C3/C4/C5 |

> C6 形态说明：本表初稿写的「probe-core-* 系列」在实际执行中并入了既有的 check:c3/c4/c5 体系，
> 最终以单一总验收 `npm run check:c6`（全链路端到端 + 引用 UI 探针）承载「全量联调」。
> 判据与证据见 `.plan/progress-M6.md`。

**合计 ~24h，超出既有 14h 缓冲** → 建议立项为 **M6（Pi 对接）里程碑**、单独走规格书与验收流程
（铁律不变：规格书主控写、验收脚本非实现方写）。**预算需用户拍板，本表仅为建议。**

顺序依据：C1 全程解锁其余步（spike 已验证骨架可行）；`shellPath` 配置已实测解决（§九·1），
core 实现时作为 Windows 启动配置项落在 C1。

---

## 九、开工前置与未验清单（不因 S6 消失）

| # | 事项 | 影响 | 建议时机 |
|---|---|---|---|
| ~~1~~ | ~~**给 Pi 配 `shellPath`**~~ | ✅ **已销账（2026-09-23）**：`<agentDir>/settings.json` 配 `"shellPath"` 指向本机 PortableGit bash 实测生效（`pi/_poc/spike-core/agentdir-tools/settings.json`）；core 落地方式见 §二 `session.ts` 行 | — |
| ~~2~~ | ~~「工具成功执行」dump~~ | ✅ **已销账（2026-09-23）**：`pi/_poc/spike-core/result-tools.jsonl` —— bash/read 成功终态 `result` 只有 `content`，**事件无 `exitCode`/`truncated`/`details`** ⇒ TerminalBlock 按 `isError` 表达成败（§三·3 已更新） | — |
| 3 | `block.reason` 是否进模型上下文 | 拒绝循环的 UX 判断（B 裁决暂不做，但值得顺手验） | 任意 spike |
| 4 | 多会话并发的 `requestId` 分区（S3 §八·7）、`opts.timeout` 实况（§八·3） | 多标签页同时用 app 时才暴露 | C6 联调 |
| 5 | 换 npm 发布包（非源码 monorepo）后重跑探针 | 依赖锁定的最终形态 | C1 开工前验证一次 |
| 6 | `window.__chatStore` 桩恢复真实 UI 驱动 | 不动清单已登记，范式同 MCP 门控 | C2 |
| 7 | 06 屏缩略窗不可读、主包 520 kB | 均非阻断，维持遗留 | 不排期 |

---

## 十、本阶段未覆盖

- core 实现细节（HTTP 框架选型、SSE 心跳/重连、批处理阈值实测）——随 C1 规格书定
- 分支会话（fork/clone/tree）的 UI —— 明确记为后期（§四·4）
- MCP、sub-agents、plan mode、to-dos、background bash 五项能力——均归 Pi 扩展生态，
  我们只在 04 屏呈现其清单（S5 定义收紧后的定位，`pi-survey-plan.md` S5 段）
