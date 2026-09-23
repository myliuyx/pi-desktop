# 文档索引（唯一入口）

> 最后更新：2026-09-23
> **当前阶段**：**Pi 对接（M6）已完成（C0–C6）**，进入**日常使用 / 后续迭代**；
> 纯 UI 原型 M0–M5 此前已全部通过验收（8 屏六路由可演示）。
> **部署形态已裁决（2026-09-23）**：**本地起一个服务 + 浏览器访问，不涉及云端**；默认只绑 `127.0.0.1`，
> `0.0.0.0`（内网可访问）作为显式开关另议。**Electron 降级为可选外壳**（保留与否暂缓，不阻塞任何当前工作）。
> 本文件是文档的唯一入口。**新增文档必须登记到这里，否则视为不存在。**

---

## 一、读法（给未来的我 / AI 会话的硬规则）

1. **项目长期记忆 `.workbuddy/memory/MEMORY.md` 会自动注入**——不要重复读它，更不要读每日日志
   （`.workbuddy/memory/YYYY-MM-DD.md`）除非要追溯某次具体改动。
2. **不要通读 `.plan/`**。按任务类型只读 A 层对应的一两份；B 层按需；**C 层（archive）默认不读**。
3. 不确定读哪份时，先读本文件的表格，不要逐个打开文件"看看"。

---

## 二、A 层 · 活跃（当前阶段直接指导工作）

| 文档 | 什么时候读 |
|---|---|
| [`progress-M6.md`](./progress-M6.md) | **M6 验收记录（C0–C6 判据与证据索引、裁决落实、遗留清单、试用口径）** |
| [`task-M6-C6.md`](./task-M6-C6.md) | **M6 第三阶段（C6 收尾）规格书**（已执行，§四 待主控复核）——三条遗留归置（工具开关接 Pi / continue-recent 限时评估 / 分支 UI 记后期）+ `check:c6` 全链路端到端终验 + 文档收口 |
| [`task-M6-C3-C5.md`](./task-M6-C3-C5.md) | **M6 第二阶段（C3–C5）规格书**（已完成并通过复核）
| [`task-M6-C0-C2.md`](./task-M6-C0-C2.md) | **M6 第一阶段（C0–C2）规格书**（已完成并通过复核）
| [`survey/S6-integration-design.md`](./survey/S6-integration-design.md) | **动 `packages/core` 的实现蓝图（S6 汇总，唯一开工入口）**——总体架构、core 模块规划、AgentTransport/AgentEvent 契约定稿（含三条实测修订）、mock 去留统一裁决（全保留+URL 参数惯例）、安全五条、C0–C6 落地顺序（~24h，建议立项 M6，**预算待拍板**）、开工前置与未验清单 |
| [`decision-rulings-2026-09-23.md`](./decision-rulings-2026-09-23.md) | **core 的信任门与授权中断设计前必读（两条均已裁决 2026-09-23）**——A 扩展信任门：**A3 跟随 Pi**（归因已实证：信任门是 `reload({resolveProjectTrust})` 显式两段式，SDK 默认绕过）；B 拒绝后重试：**暂不做**，Pi 有公开 `abort()`、后期扩展零障碍；B2 拒绝理由明示随 core 顺手带上 |
| [`spike-core-2026-09-23.md`](./spike-core-2026-09-23.md) | **动 core 实现前必读**——纯 Node + SDK + `uiContext` + HTTP/SSE 已实测跑通；含**两条必须裁决项**（项目本地扩展的信任门⚠️安全、拒绝授权后的重试循环）与三处被推翻的判断 |
| [`survey/S2-sessions.md`](./survey/S2-sessions.md) | **动会话列表 / `loadSession` / Sidebar 前必读**——Pi 的 `SessionManager` 现成 API 清单、`SessionInfo`→`SessionSummary` 映射、**「加载历史 ≠ 重放事件」这条新增工作量**、两个验收入口的去留 |
| [`survey/S3-tool-approval.md`](./survey/S3-tool-approval.md) | **动 core 的授权/终端链路前必读**——授权通道真实形态（core 实现 `ExtensionUIContext` 而非解析事件）、`hasUI` 陷阱、幂等语义实证、终端卡片字段来源、两个真实缺口 |
| [`survey/S4-transport-decision.md`](./survey/S4-transport-decision.md) | **动 core 包前必读**——传输层选型结论（独立 core 进程 + HTTP/SSE）、`AgentTransport` 接口草案、四个必做设计点 |
| [`survey/S1-event-mapping.md`](./survey/S1-event-mapping.md) | **写适配层前必读**——Pi 事件→Block 映射表、实测与文档的三处不一致、对 chat-store 的冲击 |
| [`survey/S0-our-contract.md`](./survey/S0-our-contract.md) | 梳理 Pi 的靶子——我们这侧冻结的契约：Block 六型字段、chat-store 五方法语义、92 个 testid 清单 |
| [`pi-integration-points.md`](./pi-integration-points.md) | **任何"接 Pi / 换 mock / 改数据链路"的工作**。含逐文件替换点、模型配置对接口径、思考档位、不动清单 |
| [`pi-survey-plan.md`](./pi-survey-plan.md) | 梳理 Pi、决定对接顺序时。六阶段，每阶段绑定"动我们哪些文件 + 影响哪些验收" |
| [`poc-pi-2026-09-22.md`](./poc-pi-2026-09-22.md) | 需要 Pi 可行性证据、环境坑、复现方式时。结论：Electron 内真实会话已跑通 |

## 三、B 层 · 按需参考（改 UI / 令牌 / 验收时才读）

| 文档 | 什么时候读 |
|---|---|
| [`engineering-pitfalls.md`](./engineering-pitfalls.md) | 写/改**验收脚本**时、改**布局与 `cn()` 工具类**时、要**从上游类型推断字段形状**时——9 条教训 + 7 条脚本规则（2026-09-23 从 MEMORY.md 迁出，因 MEMORY 有注入体积上限） |
| [`ui-rulings.md`](./ui-rulings.md) | 改布局或交互前——**防回退台账**，记录 R1–R10 逐条裁决 |
| [`screens.md`](./screens.md) | 需要 8 屏定义、组件清单、mock 数据结构时 |
| [`design-tokens.md`](./design-tokens.md) | 动颜色/令牌时。颜色唯一来源仍是 `packages/ui/src/styles/tokens.css` |
| [`acceptance-criteria.md`](./acceptance-criteria.md) | 需要验收标准总纲时。实际验收跑 `packages/ui` 的 accept 脚本 |
| [`sync-verification-result.md`](./sync-verification-result.md) | 设计稿 ↔ 代码令牌同步的**单一权威来源** |
| [`docs/pi-agent-core-调研.md`](../docs/pi-agent-core-调研.md) | 需要选型理由、Pi 的风险清单、落地步骤原议 |

## 四、C 层 · 归档（历史，默认不读）

放在 [`archive/`](./archive/)。**只有在追溯"某个里程碑当时怎么定的"时才看**，日常不用打开。

| 文件 | 是什么 |
|---|---|
| `task-M1..M5.md` | 各里程碑的执行规格书（已完成） |
| `progress-M0..M5.md` | 各里程碑的验收记录与实测证据（已完成） |
| `development-plan.md` | M0–M5 总排期（净工时 69.5h 已用尽，缓冲 14h 未动用） |
| `README-prototype-2026-09-21.md` | 旧版 README（原型方案总览），**M3–M5 状态已过时**，仅作历史 |
| `sync-check-report.md` | 历史问题核查报告，问题已关闭，转为方法论留档 |
| `figma-reverse-sync-status.md` | 设计稿反向同步状态（已完成） |
| `m2-notes-B.md` | M2 执行方交接笔记（含一条被主控推翻的根因判断，有教训价值） |
| `diffs/` | M5 全屏走查差异清单、R7–R9 设计稿回写执行单 |
| `shots/` | M1 阶段截图证据（6 张） |

## 五、当前状态速览

- **原型**：M0–M5 全部完成并通过验收；8 屏六路由（00 令牌 / 01 工作台含源码态 / 03 运行详情 /
  04 技能与工具 / 05 设置 / 06 窗口壳）全部可演示
- **工时**：净工时 69.5h 用尽，**14h 缓冲未动用**
- **Pi 侧**：依赖已装、构建已通、POC 四步全过（Electron 44.4.3 内真实会话跑通）；
  **部署形态已定为「本地服务 + 浏览器」**，故 POC 的 asar 打包风险已移出关键路径
- **适配层已落地**：`packages/ui/src/adapter/`（`pi-events` / `from-pi` / `reduce`），
  带状态纯 reducer；`npm run check:adapter` = 24 项断言（真实会话 dump 回放）
- **已完成的梳理**：S0 契约 / S1 事件映射 / S2 会话持久化 / S3 授权闭环 / S4 传输层选型
  / **S6 汇总**（`survey/` 六份）；**只剩 S5 自建能力（已降级为产品决策，不阻塞）**
- **S2 已结**（`survey/S2-sessions.md`）：Pi 的 `SessionManager` 把持久化全做好了
  （`list` / `listAll` / `open` / `continueRecent` / `findById` 全部公开），
  `SessionInfo` → `SessionSummary` 四字段全有来源、**不用改类型**；
  但**「加载历史会话」与「重放实时事件」是两条不同路径**，需独立写
  `SessionEntry[] → Message[]` 映射（**原估里没有的新增工作量**）
- **S3 已结**（`survey/S3-tool-approval.md`）：① 授权通道是「core 实现 `ExtensionUIContext`
  接口」，**不是**消费 `extension_ui_request` 事件（后者只是 RPC 模式的序列化形式）；
  ② `hasUI` 由「是否注入 uiContext」推导，**漏注入 ⇒ 危险命令静默 block 且 UI 无感知**；
  ③ 工具授权是 Pi 扩展的事，我们只接界面。⚠️ 该阶段**未跑真实 dump**，补验清单见其 §八
- **⏸ MCP 已裁决暂缓，门控已落地**：默认不渲染、`?mcp=1` 开启（`src/lib/feature-flags.ts`），
  **恢复只需改一个返回值**。⚠️ `accept:m2`（2-11 / 2-12）与 `accept:m4`（4-4）**须带 `?mcp=1` 跑**；
  关闭态由 `scripts/probe-mcp-gate.mjs` 守卫。处置记录见 `pi-survey-plan.md` S5
- **★ 「自建能力」定义已收紧**：本项目是**给 Pi 套壳** —— 能力层归 Pi 的扩展生态（我们不写），
  呈现层归我们（读 Pi 的清单画界面 + 接 Pi 的提问）。
  04 屏「扩展 / 技能 / 提示词」三类数据 Pi 全都提供，**只有 MCP 区块没有数据源**
- **★ core 骨架 spike 已通过（2026-09-23）**，见 `spike-core-2026-09-23.md`：
  「纯 Node 进程 + Pi SDK + 注入 `uiContext` + HTTP/SSE」**实测跑通**（授权往返 4 次全闭环），
  S4 选型不再是纸面结论。顺带补掉 S3 两条待验、**推翻 S3 三处判断**（`exitCode`/`output` 取值路径
  全错，源于"从内部类型推事件形状"）。
  **新增两条必须裁决项 → 已裁决（2026-09-23，决策单 [`decision-rulings-2026-09-23.md`](./decision-rulings-2026-09-23.md)）**：
  ① **扩展信任门 = A3 跟随 Pi**：归因实证——信任门是 `resource-loader.ts:388-400`
  `reload({ resolveProjectTrust })` 显式两段式，CLI 入口传了、SDK 默认绕过；
  ⇒ core 必须显式传回调：`ask`（默认）→ 经 UI 提问、`never` → 忽略、`always` → 直接加载；
  ② **拒绝后重试循环：暂不做**。Pi 有公开 `abort()`（`agent-session.ts:1786`），
  「拒绝并停止」后期扩展零障碍；B2 拒绝理由明示随 core 顺手带上
- **★ M6 第一阶段（C0–C2）已完成并通过主控复核（2026-09-23，分支 `dev-m6`）**：
  `packages/core` 从无到有（HTTP+SSE + 安全三件套 + 持有 Pi 会话），
  **浏览器 `?live=1` 可与真实模型对话**（live-smoke 12/12，真实回复落 DOM、streaming 正确收尾，
  批处理合并率 ~0.78–0.81）；全量回归 m1~m5 + check:cn/adapter 全绿，dist 零 pi/core 真实引用。
  规格书与复核记录：[`task-M6-C0-C2.md`](./task-M6-C0-C2.md)。
  **试用**：`packages/core` 起 `npm run smoke`（写 `run/core.json` 的 port/token）→
  `packages/ui` 起 dev（`npm run dev -- --port 5180 --strictPort`）→ 浏览器开
  `http://127.0.0.1:5180/?live=1&core=http://127.0.0.1:<core端口>&token=<token>`
- **★ M6 第二阶段（C3–C5）已完成并通过主控复核（2026-09-23，分支 `dev-m6`）**：
  C3 授权闭环 + **信任门 A3**（`check:c3` 36/36：真实授权往返、幂等、信任门五态；
  UI 超时失效态探针 4/4）；C4 会话列表与加载（`check:c4` 25/25，`SessionEntry[]→Message[]`
  独立映射）；C5 04/05 屏真数据（`check:c5` 26/26，UI 探针 7/7 + 8/8）。
  规格书与复核记录：[`task-M6-C3-C5.md`](./task-M6-C3-C5.md)。
  ⚠️ 本轮修掉一处遗留红灯：`core-smoke` 自 C2 起因断言 `agent_end`（不在我们事件契约里）
  而 EXIT=1，已由主控改为 `agent_settled` + 终态顺序断言并转绿。
- **★ M6 第三阶段（C6 收尾）已执行（2026-09-23，分支 `dev-m6`，待主控复核）**：
  §1.1 工具开关接 Pi（`GET/POST /tools/active`，0.87.1 `getActiveToolNames`/`setActiveToolsByName`；
  UI live 开关读写真实状态）；§1.2 `continue-recent` **重建活动会话**（公开低险路径：
  `createAgentSession({sessionManager})`，续写落同一 session 文件）；§1.3 分支 UI 确认记后期。
  **总验收 `npm run check:c6`（core 包）33/33 全绿**：完整真实会话（授权闭环 + bash 成功）→
  会话落盘/加载 → 重建切换 → 工具开关往返（关 bash ⇒ 不出现 bash 调用）→ resources/models →
  复用 probe:c4/c5/live:smoke。全家桶终验全绿（m1~m5 / cn 20 / adapter 35 / c3 36 / c4 25 / c5 26 /
  security / smoke / 两包 tsc / build 隔离 0 命中）。
  验收记录：[`progress-M6.md`](./progress-M6.md)。
- **下一步**：**进入日常使用 / 后续迭代**（遗留清单见 progress-M6 §四：分支 UI、input 型授权卡、
  MCP 恢复开关等，均非阻断）。日常使用：`cd packages/core && npm run smoke` →
  浏览器开 `http://127.0.0.1:<core端口>/?live=1`（core 同源托管 ui/dist，**免 token**；
  dist 需先在 packages/ui `npm run build`）。
- **开工前必读**：`survey/S0-our-contract.md` → `survey/S1-event-mapping.md` →
  `survey/S4-transport-decision.md` → **`survey/S3-tool-approval.md`**（若动授权/终端链路）
  （四份加起来就能动手，不必通读 `.plan/`）
- **遗留（非阻断）**：06 屏缩略窗口文字不可读（有单壳全尺寸替代）、主包 520 kB、
  DEV 下 `window.__chatStore` 桩（接 Pi 时改回真实 UI 驱动）

---

## 六、文档纪律（从踩过的坑里长出来的）

1. **新文档必须登记到本索引**，否则下个会话找不到、也容易重复造。
2. **里程碑结束后**，把该里程碑的规格书与验收记录移入 `archive/`，根目录只留活跃文档。
3. **同一结论只放一处。** 状态类信息散落在 N 个文件里，必然"改了一部分、漏了一部分"
   （`sync-check-report.md` 就是这么来的）——需要多处引用时，只放指针，不放副本。
4. **写结论标出处**（`文件:行号`），不凭记忆或上一轮摘要。
5. 归档用 `git mv`（保留历史，随时可回溯），不要直接删内容文档。
