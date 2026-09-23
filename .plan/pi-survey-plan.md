# 梳理 Pi 的方案（pi-survey-plan）· v2 以我们的决策为锚

> 制定日期：2026-09-22　修订：同日（v1 以 Pi 为中心，缺少与我们项目的绑定，已重写）
> 背景：Pi 接入 POC 已通过（`.plan/poc-pi-2026-09-22.md`）。下一步是适配层，而适配层形状取决于
> Pi 的事件模型——不能凭想象开工。
> 配套：`.plan/pi-integration-points.md`（替换点清单）、`docs/pi-agent-core-调研.md`（选型调研）

## 当前进度（2026-09-22 收尾时）

| 阶段 | 状态 | 产物 |
|---|---|---|
| **S0** 冻结我方契约 | ✅ 完成 | `survey/S0-our-contract.md` |
| **S1** 事件→Block 映射 | ✅ 完成 | `survey/S1-event-mapping.md` |
| **S2** 会话与持久化 | ✅ 完成（2026-09-23） | `survey/S2-sessions.md` |
| **S3** 工具与授权闭环 | ✅ 完成（2026-09-23） | `survey/S3-tool-approval.md` |
| **S4** 传输层选型 | ✅ 完成 | `survey/S4-transport-decision.md` |
| **S5** 自建能力 | ⏸ 未做（**MCP 已单独裁决为「暂缓」**，见 S5 段内的「MCP 暂缓处置」） | — |
| **S6** 汇总 | ✅ 完成（2026-09-23） | `survey/S6-integration-design.md` |

**适配层已提前落地**（不等 S6）：`packages/ui/src/adapter/`（`pi-events.ts` / `from-pi.ts` / `reduce.ts`），
配套 `npm run check:adapter`（24 项断言，用真实会话 dump 回放）。

**S3 已完成（2026-09-23）**，产物 `survey/S3-tool-approval.md`。核心结论推翻了原先的预期：
授权不是「在 transport 上开反向通道去消费 Pi 的 `extension_ui_request` 事件」，
而是 **core 实现 `ExtensionUIContext` 接口**（`extension_ui_request` 只是 RPC 模式的序列化形式）。
另有两条必读发现：`hasUI` 陷阱（漏注入 `uiContext` → 危险命令静默 block）与
「工具授权由 extension 提供」这一产品级前提。**该阶段只做了源码实证、未跑真实 dump**，
补验清单见该文档 §八。

**S2 已完成（2026-09-23）**，产物 `survey/S2-sessions.md`，**比原估 3h 短得多** ——
Pi 的 `SessionManager` 把会话持久化整个做好了（`list` / `listAll` / `open` / `continueRecent` /
`findById` 全部公开 API，`session-manager.ts:1758/1779/1624/1651/1732`），
`SessionInfo` → `SessionSummary` 四字段全有来源、**不用改类型**。
但发现一处**原估里没有的新增工作量**：「加载历史会话」与「重放实时事件」是两条不同路径 ——
会话文件里存的是 `SessionEntry[]`，需要独立写 `SessionEntry[] → Message[]` 映射，
`adapter/reduce.ts` 的实时事件 reducer **不能复用**。

**下一步：S5 / S6 汇总 → 动 core 正式实现**。

### ★ core 骨架 spike（2026-09-23，已完成）

产物：`spike-core-2026-09-23.md`（资产在 gitignore 的 `pi/_poc/spike-core/`）。

**「纯 Node 进程 + Pi SDK + 注入 `ExtensionUIContext` + HTTP/SSE」实测跑通** ——
授权往返 4 次全闭环（SSE 下发 + POST 回收），扩展侧实测 `hasUI=true` / `mode=rpc`。
**唯一未证伪的架构级假设已销账**，S4 选型从纸面结论变成实测结论。

顺带：补掉 S3 两条待验（拒绝授权的终态、`partialResult` 形状），**推翻 S3 三处判断**
（`exitCode` / `output` 的取值路径全错 —— 根因是"拿内部类型 `BashResult` 推断事件形状"）。

**⚠️ 新增两条必须裁决项（建议都在 core 实现前拍掉）**：

1. **安全**：项目本地扩展 `.pi/extensions/*.ts` 被**自动加载并执行**，未见信任交互 ——
   与 `usage.md:121-127` 描述的信任门不符（本次只观察到现象，未归因）。
   扩展是可执行代码，而我们的形态是「用户在自己机器上起服务」→ 在含该目录的仓库里打开 app
   就会加载执行。**要么加一道 UI 信任确认，要么不加载项目本地扩展（只认全局）。**
2. **产品**：拒绝授权后模型会**换写法反复重试**（实测连拒 4 次、换 4 种命令、烧 5–6 个 turn）。
   「拒绝」当前不是终点而是循环起点 —— 需要「拒绝并停止」选项，或确认 `block.reason` 是否进了上下文。

**~~仍未验~~ → ✅ 已销账（2026-09-23 spike-tools）**：`exitCode`/`truncated` 的事件来源 ——
配 `shellPath` 后 bash/read 首次成功执行（`pi/_poc/spike-core/result-tools.jsonl`），
dump 证明**事件里根本没有这三个字段**（成功 `result` 只有 `content`）⇒ TerminalBlock 按
`isError` 表达成败。详见 `spike-core-2026-09-23.md` §五·1 与 `survey/S6-integration-design.md` §三·3。

---

## 零、v2 改了什么（为什么重写）

v1 回答的是「Pi 有哪些东西要读」，是**以 Pi 为中心**的。它缺三样东西：

1. 没把每个阶段绑定到**我们具体哪些文件会动**
2. 没考虑既有硬约束（G1–G8）与验收体系（accept:m1~m5 / probe-r7）怎么延续
3. 阶段按 Pi 的模块切（事件 / 会话 / 工具 / 传输 / 扩展），不是按**我们要拍什么板**切

v2 的调整：**先冻结我们这侧的契约（S0），之后每个阶段都是「Pi 的 X ↔ 我们的 Y」**，
并且每个阶段必须回答「动哪些文件、影响哪些验收、要不要动不动清单」。

---

## 一、为什么先出方案，而不是直接开梳

`pi/` 是 12 个包、1596 个文件的 monorepo，且自身仍在演进（0.86.1 pre-1.0；
`docs/mobile-handoff` 自述 7 个单元仅 3 个有可用代码）。**通读既不现实也不划算**——读完的部分
可能明天就变。正确做法是按"下一步要拍什么板"反向界定读什么，读够了就停。

---

## 二、S0 · 先冻结我们这侧的契约（0.5h，最先做）

**没有这一步，后面的梳理就是无的放矢**——不知道要往哪儿映射。

产出：一张对照表（落到 `.plan/survey/S0-our-contract.md`）

| 我们的东西 | 现状（已核实） | 梳理时要拿来对照什么 |
|---|---|---|
| Block 六型 | `TextBlock`(含 `streaming?`) / `ThinkingBlock`(collapsed) / `ToolCallBlock` / `TerminalBlock` / `ApprovalBlock` / `PlanBlock`；`mock/types.ts` L38/46/54/64/78/97 | Pi 的事件分别落进哪一型、字段够不够 |
| 计划步状态 | `PlanStepStatus = pending \| running \| done \| failed`（L19） | Pi 的 plan 事件能否表达这四态 |
| `chat-store` 五方法 | `sendMessage` / `abortStream` / `resolveApproval` / `loadSession` / `reset`（签名冻结） | Pi 侧能否一一对应实现 |
| 逐屏 testid 契约 | 已被 m1~m5 验收脚本依赖 | 若 Pi 的事件逼我们改组件结构，要显式评估 |
| UI 真正消费的字段 | grep 各卡片组件的消费点 | **只映射 UI 真正用的字段**，不做全量字段搬运 |

判据：拿着这张表，能问出「Pi 的某某事件需要哪些字段才能变成 Block」。

---

## 三、分阶段计划（每阶段 = 一个要拍的板）

### S1 · 事件 → Block 映射（4h）— 最先做，直接决定适配层

| 项 | 内容 |
|---|---|
| **要拍的板** | 适配层是**纯函数**还是**带状态机**？流式中「只更新最后一条 assistant 消息」的模式能否保持（虚拟滚动的动态测量依赖它的稳定性） |
| **读 Pi** | `coding-agent/docs/rpc.md`（事件类型全集）、`docs/sdk.md`、`examples/sdk/01..13` |
| **动我们哪些文件** | 新增适配层（新文件，不动现有组件）；`store/chat-store.ts`；`mock/stream.ts` 退役 |
| **影响哪些验收** | `accept:m2`（32 项）按 `INITIAL_SESSION` 的 7 条消息逐条断言 → **必须决策**：保留 mock 分支供回归，还是宣告退役归档证据。`probe-r7` 的 7 项只依赖"同时存在 user 与 assistant 消息"和纯 UI 交互，**与数据源无关，仍有效** |
| **完成判据** | 映射表 + 一次真实会话的事件 dump 验证（用 `pi/_poc/` 探针） |

### S2 · 会话与持久化（3h）

| 项 | 内容 |
|---|---|
| **要拍的板** | Sidebar 历史列表与「加载会话」接真实存储，还是保留 mock 分支？`?empty=1` / `?stress=N` 两个**正式验收入口**去留 |
| **读 Pi** | `docs/sessions.md`、`docs/session-format.md`、`durable`、`session-backends` |
| **动我们哪些文件** | `mock/sessions.ts`（整换或留导出开关）、`components/shell/Sidebar.tsx`、`chat-store.loadSession` |
| **影响哪些验收** | 需先核实 m1/m2/m5 对 `SESSION_SUMMARIES`（8 条）的依赖面再定 |
| **完成判据** | 会话列举 / 加载 / 续接方案 + 验收去留的显式决策 |

### S3 · 工具执行与授权闭环（3h）

| 项 | 内容 |
|---|---|
| **要拍的板** | 终端卡片的 command / output / exit code 从哪个事件取；授权应答的**幂等语义**怎么与 Pi 对齐（`resolveApproval` 已决 requestId 不覆盖） |
| **读 Pi** | `docs/extensions.md`（Extension UI Protocol：`select` / `confirm`）、`examples/extensions/*` |
| **动我们哪些文件** | 只动数据源，**组件结构不动**：`TerminalCard` / `ApprovalCard` 的输入、`chat-store.resolveApproval` |
| **影响哪些验收** | m2 中对卡片 testid 与内容的断言（组件不动则风险低） |
| **完成判据** | 两张卡片从事件到渲染的完整数据流 |

### S4 · 传输层选型（3h）— 要早于适配层落地定下来

| 项 | 内容 |
|---|---|
| **要拍的板** | **同进程直连** vs **独立进程 + HTTP/SSE**。决定 `core` 包接口边界，也决定「UI 层禁止 import `node:*`」怎么落地、Web 版怎么复用同一套 UI |
| **读 Pi** | `docs/rpc.md`、`protocol` / `client` / `server` 的 README（三者自述 experimental，主进程直连可绕开） |
| **动我们哪些文件** | 架构层：可能新增 `packages/core`；**UI 代码不动**，但从此只依赖统一 transport 接口 |
| **影响哪些验收** | 无（纯架构决策），但决定适配层的调用方式——**晚定会返工** |
| **完成判据** | 选型结论 + 理由 + transport 接口草案 |

### S5 · 自建能力（3h）

> ★ **2026-09-23 修订：「自建能力」这个词的定义要收紧，否则会误导。**
> 原表述读起来像「这些能力要我们自己补」，但本项目是**给 Pi 套壳**（S4 已定：UI 不 import Pi、
> core 包 Pi）——**能力层由 Pi 的扩展生态负责，我们几乎不写**。
> 我们只做两件事：**把 Pi 的清单读出来画成界面**、**把 Pi 的提问接上界面**（后者即 S3 的授权通道）。

两层要分开看：

| 层 | 谁做 | 我们要写什么 |
|---|---|---|
| **能力层**（MCP 客户端、plan mode 引擎…） | Pi 的扩展 / 包生态（装现成包或写扩展，都在 Pi 侧） | **不写** |
| **呈现层**（04 屏的清单与开关、授权卡…） | 我们（壳的本职） | **写** —— 数据从 Pi 读 |

**Pi 明确不内置的完整清单（6 项，`docs/usage.md:310` 原文）** —— 原清单只列了 3 项，漏了 3 项：

| # | 能力 | 原清单 | 备注 |
|---|---|---|---|
| 1 | MCP | ✅ 有 | **⏸ 已裁决暂缓（2026-09-23）** —— 见下方「MCP 暂缓处置」 |
| 2 | **sub-agents** | ❌ **漏** | 补入 |
| 3 | **permission popups** | ❌ **漏** | 补入；**S3 已给出接口方案**（core 实现 `ExtensionUIContext` + 反向通道） |
| 4 | plan mode | ✅ 有 | `examples/extensions/plan-mode/` 有现成示例可参考 |
| 5 | to-dos | ✅ 有 | `examples/extensions/todo.ts` 有现成示例 |
| 6 | **background bash** | ❌ **漏** | 补入 |

#### MCP 暂缓处置（2026-09-23 用户裁决）

> 用户原话：「MCP 暂时不管，可以先把代码注释掉，后期再说」。

**暂缓的理由**：Pi 无 MCP 概念（`docs/usage.md:310`），所以「有哪些 MCP 服务器」这份清单
**在 Pi 的 API 里没有任何来源**。装了第三方 MCP 扩展之后，那份清单归**那个扩展**管，
它是否会 / 以什么形式暴露给宿主，Pi 不作保证。**在没有来源的情况下继续展示 mock 数据属于误导。**

**牵连面（已 grep 实证，`packages/ui`）**：

| 类别 | 具体位置 |
|---|---|
| 类型契约 | `mock/types.ts:30-31`（`McpStatus`）、`:167-171`（`McpServer`） |
| mock 数据 | `mock/composer.ts:58-67`（`COMPOSER_MCP_SERVERS` 4 条 + `MCP_CONNECTED_COUNT`）；`mock/skills.ts:190-195`（`MCP_NOTE` + 类型再导出） |
| 组件（04 屏） | `screens/SkillsScreen.tsx`——③ MCP 区块（`mcp-note` / `mcp-list` / `mcp-server` / `mcp-count`）+ 头部摘要（L70-71「MCP N 个服务器」） |
| 组件（工具条） | `components/chat/ComposerToolbar.tsx:92-96`（`composer-chip-mcp` 芯片） |
| **验收** | ⚠️ **`accept:m2` 的 2-11**（工具条顺序**硬编码**含 `composer-chip-mcp`）+ **`accept:m4` 的 4-4**（5 条断言，含 `mcp-server` 数量 > 0） |

**⚠️ 两条硬约束**（必须显式裁决，不能静默改）：

1. **这会打破两项验收**（跨 m2 / m4 两个里程碑）。
   `pi-survey-plan.md` §五纪律给出的处置方式只有二选一：
   **保留 mock 分支供回归**（需要留一个开关/参数入口）或 **正式宣告退役并归档证据**。
2. **`不动清单` 明确覆盖「全部 `data-testid` 契约」** —— 移除区块即移除 testid，
   属于碰不动清单，按 §五纪律「碰到了必须停下来显式讨论」。

**三个可选方案（待用户拍板）**：

| 方案 | 做法 | 验收 | 恢复成本 |
|---|---|---|---|
| **A（已采纳 ✅）** | 加 `MCP_FEATURE_ENABLED` 开关，默认关；**开一个 `?mcp=1` 正式入口**（沿用 `?empty=1` / `?stress=N` 的既有惯例）供验收脚本使用 | **两条验收全绿，期望值一行不改** | 翻一个布尔值 |
| B | 物理注释掉组件代码 | 2-11 / 2-12 / 4-4 失败，需退役并归档证据 | 高（还要处理 unused import） |
| C | 区块保留在界面上，只在文案里标「暂缓」 | 全绿 | 零 |

#### 执行记录（2026-09-23，方案 A 已落地）

| 改动 | 内容 |
|---|---|
| **新增** `packages/ui/src/lib/feature-flags.ts` | `isMcpEnabled()`：读 `window.location.search` 的 `?mcp=1`。**默认 `false`**。放在 `lib/` 而非 store/mock —— 它不是 UI 状态（不该持久化）也不是 mock 数据，与 `?stress=` 同族 |
| `screens/SkillsScreen.tsx` | ③ MCP 区块与头部 MCP 摘要**一起**用 `mcpEnabled` 门控（避免出现「MCP 4 个服务器」却看不到列表的自相矛盾） |
| `components/chat/ComposerToolbar.tsx` | `composer-chip-mcp` 芯片门控 |
| `scripts/m2-acceptance.mjs` | 入口导航 `"/"` → `"/?mcp=1"`（L126/128）。理由：2-11 / 2-12 写死了三芯片与高度 `[32,32,32]`，那正是基线 → 带参数即**精确还原基线** |
| `scripts/m4-acceptance.mjs` | 04 屏导航 `"/#/skills"` → `"/?mcp=1#/skills"`（L305）。**4-7 的溢出检查故意不带参数** —— 它该测真正发布的默认形态 |
| **新增** `scripts/probe-mcp-gate.mjs` | 补上「关闭态」这个**此前无人覆盖**的缺口（m2/m4 只测打开态）。产出 `_probe-mcp-gate-evidence.json`，与 `probe-r7.mjs` 同惯例 |

**验证结果（主控实跑，非转述）**：

- `tsc --noEmit -p tsconfig.app.json` → EXIT=0，且 `--listFiles` 确认 369 个文件在编译范围内、
  三个改动文件与新增文件全部包含（排除裸 tsc 假绿）
- **`accept:m4` → 16/16 通过**（含 4-4）
- **`accept:m2` → 32/32 通过**（含 2-11「顺序正确」、2-12「三芯片高度均 32」）
- **`probe-mcp-gate` → 1/1 通过，13 条子断言全 true**：
  默认态零个 `mcp-server`、无 `mcp-note`/`mcp-list`/`mcp-count`、内容区正文不含 MCP 字样、
  技能三组与四个工具开关不受影响、工具条无 MCP 芯片；
  带参数时四项全部恢复且顺序还原为原 5 项

⚠️ **一条方法论记录**：探针首轮出现假失败「默认_正文不含MCP字样」。根因是**断言写得太宽** ——
用 `document.body.innerText` 整页取样，把侧边栏会话列表里的「整理 MCP 服务器配置」
（`mock/sessions.ts:269`）算了进来。按本项目教训 #1「失败的断言先怀疑断言本身」溯源后
改为限定 `[data-testid="skills-screen"]` 内容区取样即通过。**这是探针缺陷，不是产品缺陷。**

**恢复 MCP 的做法**（后期再说时）：让 `isMcpEnabled()` 返回 `true` 即可 ——
组件代码、testid 契约、mock 数据、验收断言全部原样保留，无需重写任何东西。

**★ 04 屏的三个分类全部可直接从 Pi 读 —— 不需要自建**（实测 API，见下表）：

| 04 屏分类（`mock/skills.ts:198-202`） | Pi 侧数据源 | 出处 |
|---|---|---|
| 扩展 | `resourceLoader.getExtensions()` | `core/resource-loader.ts:41` |
| 技能 | `resourceLoader.getSkills().skills` | `core/resource-loader.ts:42` |
| 提示词 | `getPrompts().prompts` | `core/agent-session.ts:1089` |

访问入口是公开的：`core/agent-session.ts:1779-1780` 的 `get resourceLoader()`。
**→ 04 屏「扩展 / 技能 / 提示词」三块是纯读；唯一没有数据源的是 MCP 区块。**

| 项 | 内容 |
|---|---|
| **要拍的板** | ① 「扩展」分类只做只读展示，还是可装可卸（`pi install` / `pi config` 那套）；② 工具条 MCP 芯片的落点（**受 MCP 暂缓影响**，见上方「MCP 暂缓处置」）；③ `permission popups` 要不要接（S3 已给接口方案） |
| **读 Pi** | `docs/usage.md`（设计原则 + 包命令）、`docs/packages.md`、`examples/extensions/plan-mode/`、`todo.ts` |
| **动我们哪些文件** | `mock/skills.ts`、`mock/composer.ts` 的 MCP 部分、`screens/SkillsScreen.tsx` |
| **影响哪些验收** | `accept:m4`（16 项）按 mock 数据断言 → 需同样做「保留 mock 分支 or 退役」决策。⚠️ **验收 4-4 要求 MCP 区块内含「自建能力」文案 —— 若改措辞会连带改验收** |
| **完成判据** | 补齐清单 + 每项成本 |

### S6 · 汇总（2h）

产出《Pi 对接设计》：适配层接口草案 + 落地顺序 + 验收策略（S1/S2/S5 的 mock 去留统一裁决）。

**合计约 18.5h 净工时**（含 S0 0.5h）。

### 顺序

S0 → **S1（最先，决定适配层）** → S4（早于适配层落地）→ S2 / S3 / S5（按开工顺序排）→ S6。

### 逐屏影响面

| 屏 | 受哪些阶段影响 |
|---|---|
| 01 工作台 | S1 / S2 / S3（消息流、会话、卡片） |
| 03 运行详情 | S1（步骤与状态映射） |
| 04 技能与工具 | S5 |
| 05 设置 | 模型配置已梳理完（`pi-integration-points.md` 第七、八节） |
| 00 令牌 / 06 窗口壳 | 不受影响 |

---

## 四、包地图（读哪些、不读哪些）

| 级别 | 包 |
|---|---|
| **A 必读** | `coding-agent`、`agent`（pi-agent-core）、`ai`（**只读接口层**，不读 provider 实现） |
| **B 按需** | `durable`、`session-backends`、`protocol` / `client` / `server` |
| **C 不读** | `tui`、`chord`、`telemetry`、`evals` |

**不读 C 类是最大的省力点。** `tui` 只作为 native 依赖风险存在，而这一点 POC 已经验证过了。

---

## 五、每个阶段结束必须自查的三问

1. **本阶段要改我们哪些文件？**（写进该阶段产物）
2. **有没有碰到不动清单？** 清单见下——碰到了必须停下来显式讨论，不静默改
3. **哪些验收脚本会失效？** 处置方式只能是二选一：保留 mock 分支供回归，或正式宣告退役并归档证据

### 不动清单（沿用既有决策）

- 全部 `data-testid` 契约（m1~m5 与 probe-r7 依赖）
- `lib/layout.ts` 全部常量（含 R9 的 `SEND_ICON_OPTICAL_SHIFT_X/Y`）、`styles/tokens.css`
- 硬约束 **G1–G8**（hex 只在 tokens.css / 无 `dark:` 变体 / 正文对比度 ≥4.5 辅助 ≥3 / 图标固定色 /
  不用 Tailwind 内置调色板 / 无横向滚动 / 键盘可达 / 折叠必须有过渡）
- 8 屏六路由的路由形态（`App.tsx` 未引入 react-router，暂不动）
- DEV 下的 `window.__chatStore` 桩——**接 Pi 后要改回真实 UI 驱动**（既有遗留项，本轮一并裁决）

---

## 六、方法与纪律

1. **先读 docs，必要时才读 src**；docs 与实测冲突时**以实测为准**。
2. **结论必须标出处**（`文件:行号`），禁止凭记忆或上一轮摘要写结论（本项目已多次因此出错）。
3. **事件形状的断言必须用真实会话 dump 验证**，不能只读文档。`pi/_poc/` 探针与 key 都现成。
4. 每阶段产一份 `.plan/survey/Sn-*.md`，**未复核前不并入主文档**。
5. 与既有决策冲突时**显式提出，不静默改**（典型：若 Block 六型不足以表达某类 Pi 事件，
   要讨论改 `mock/types.ts` 的代价，而不是在适配层里偷偷塞字段）。
6. 每阶段产物里写清「本阶段未覆盖什么」，防止下一个人误以为已全覆盖。

---

## 七、梳理期不做的事

- 不读 C 类包源码
- **不改 `packages/ui` 的代码**（S0 只产出对照表文档）
- 不提前写适配层（等 S1 映射表）
- 不升级 Pi 版本、不动 `pi/` 源码（它是 gitignore 的上游 clone）
