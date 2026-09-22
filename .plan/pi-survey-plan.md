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
| **S2** 会话与持久化 | ⏸ 未做 | — |
| **S3** 工具与授权闭环 | ⏸ 未做（**建议下一个做**，理由见下） | — |
| **S4** 传输层选型 | ✅ 完成 | `survey/S4-transport-decision.md` |
| **S5** 自建能力 | ⏸ 未做 | — |
| **S6** 汇总 | ⏸ 未做 | — |

**适配层已提前落地**（不等 S6）：`packages/ui/src/adapter/`（`pi-events.ts` / `from-pi.ts` / `reduce.ts`），
配套 `npm run check:adapter`（24 项断言，用真实会话 dump 回放）。

**下一个建议做 S3**：授权（ApprovalBlock 的 `resolveApproval`）是**唯一需要在 transport 上开反向通道**
的能力，而 S4 的接口草案还没包含它——早做能避免 core 接口返工。

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

| 项 | 内容 |
|---|---|
| **要拍的板** | MCP、plan mode、to-dos 这三个 Pi 不内置的能力怎么补；工具条 MCP 芯片与 04 屏的落点 |
| **读 Pi** | `docs/usage.md`（明确列出不内置的能力）、`examples/extensions/custom-provider-*` |
| **动我们哪些文件** | `mock/skills.ts`、`mock/composer.ts` 的 MCP 部分、`screens/SkillsScreen.tsx` |
| **影响哪些验收** | `accept:m4`（16 项）按 mock 数据断言 → 需同样做「保留 mock 分支 or 退役」决策 |
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
