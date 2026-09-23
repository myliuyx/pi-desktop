# 决策单 · spike 产出的两条必须裁决项（2026-09-23）

> 来源：`spike-core-2026-09-23.md` §三·2 / §三·4。~~建议在 core 正式实现之前拍掉~~ **已裁决（2026-09-23，见两处决议栏）**。

---

## 裁决项 A（⚠️ 安全）：项目本地扩展的信任门

### A·1 事实（spike 实测）

- spike 只提供 1 个扩展，`extensionsResult.extensions` 却报 **5 个**：多出的 4 个来自
  `pi/.pi/extensions/`（cwd 落在 `pi/`，被当**项目本地扩展**加载，`sdk.md:347`）。
- **但 `usage.md:121-127` 说**：项目本地资源需信任；非交互模式按 `defaultProjectTrust` 处理，
  `ask`（默认）与 `never` 应**忽略**它们。实测是**直接加载执行，无任何信任交互或报错**——与文档不符，**未归因**。
- 风险：扩展是**可执行代码**。产品形态是「用户在自己机器上起服务 + 浏览器访问」⇒
  **在任意含 `.pi/extensions/` 的目录里打开 app，其中文件就会被执行**（类比 VS Code Workspace Trust 要防的场景）。

### A·2 归因实验（✅ 已做，2026-09-23，纯源码实证无模型调用）

**结论：信任门存在，但不是自动的 —— 是 CLI 入口显式触发的，SDK 模式默认绕过。**

- 机制在 `resource-loader.ts:388-400`：`reload({ resolveProjectTrust })` **两段式** ——
  先 `loadProjectTrustExtensions()`（`L380-386`，强制 `setProjectTrusted(false)` 做 bootstrap 加载，
  把项目本地扩展/包挡在外面、只载全局与临时扩展）→ 调用方传入的 `resolveProjectTrust` 回调裁决 →
  `setProjectTrusted(result)` 后全量 reload。
- **只有传了这个回调的入口才有门**：CLI 主入口 `main.ts:745` 传了；`package-manager-cli.ts:773` 传了
  （其中 `defaultProjectTrust` 取自 `settingsManager.getDefaultProjectTrust()`，`package-manager-cli.ts:777`）。
- **spike 直接用 SDK 构造会话、没传回调** → 走的是「无门」路径，项目本地扩展按可信加载 ——
  与 spike 观察到的现象完全吻合（既不是 Pi 的 bug，也不是环境恰为 `always`）。
- 旁证：`runner.ts:317` 的 `isProjectTrustedFn` 默认 `() => true`；扩展 ctx 上的
  `isProjectTrusted()`（`extensions/types.ts:335`）来自 `agent-session.ts:2790` 的直通透传。
- 判定「某目录是否需要信任」的现成谓词：`hasTrustRequiringProjectResources(cwd)`
  （`interactive-mode.ts:4038` 用法可参照）。

### A·3 选项对比

| 方案 | 做法 | 优点 | 缺点 / 代价 |
|---|---|---|---|
| **A1 信任门（推荐）** | 首次在含 `.pi/extensions/` 的目录启动时，UI 弹一次信任确认（列出将加载的扩展文件）；选择按目录持久化；拒绝则本次不加载 | 安全可控；兼容已有 Pi 项目扩展用户；范式有业界先例（VS Code Workspace Trust） | 需要新增：core 侧「先列后载」两段式加载 + UI 信任卡 + 持久化存储；工作量最大（估 0.5–1d） |
| **A2 一律不加载** | core 只认全局 `~/.pi/agent/extensions/`，项目本地扩展不加载（可在设置里显式加白名单目录） | 最安全、实现最简单（core 一处判断）；无 UI 新组件 | 与 Pi 生态不兼容——现有 Pi 用户的**项目扩展会静默失效**，可能被当成 bug 报 |
| **A3 跟随 Pi 设置** | 读 `settings.json` 的 `defaultProjectTrust`：`ask` → 我们弹 UI 问一次；`never` → 忽略；`always` → 直接加载 | 与 Pi 语义对齐，不发明新机制 | 依赖 A·2 归因结论（SDK 是否真读该配置）；`always` 用户仍裸奔；信任持久化还是要我们自己做 |
| **A4 先禁用、观察后放开** | 本期按 A2 收口，留 feature flag（同 MCP 门控范式 `?ext=1`），S6 后再决定是否做 A1 | 本周不阻塞 core；有回头路 | 项目扩展用户继续不可用；flag 多一个要养 |

### A·4 推荐

**先做 A·2 归因实验，再在 A1 / A3 里选**：
- 若 SDK 真不读 `defaultProjectTrust` → **A1**（我们的信任门就是唯一防线，不能省）；
- 若 SDK 会读且语义可用 → **A3**（`ask` 态由我们的 UI 补上弹窗）。
无论选哪个，**本轮底线一致：默认配置下，未经用户确认的项目本地扩展不得执行**。
工程上倾向 A4 的收口节奏：core 实现期先按 A2 落地 + flag，信任门（A1/A3）排进 core 之后的迭代。

### A·5 决议栏

> **裁决：A3 —— 跟随 Pi（用户拍板，2026-09-23）。**
> 理由（用户原话大意）：我们本来就是打算给 Pi 做一层壳，授权/信任语义应与 Pi 一致，不另发明机制。
> 归因实验结论：**SDK 模式不自动触发信任门**；门 = `reload({ resolveProjectTrust })` 两段式，
> 由入口显式传入（详见 A·2）。
> **对 core 实现的硬要求**：core 必须显式传 `resolveProjectTrust` 回调 ——
> `ask` 态（默认）经我们的 UI 向用户提问（走既有 `ctx.ui` 提问通道，与 ApprovalCard 同一条 SSE 往返）；
> `never` → 忽略项目本地资源；`always` → 直接加载。判定谓词用 `hasTrustRequiringProjectResources(cwd)`。
> 这样「shell」定位下我们一行信任逻辑都不用发明，只把 Pi 的提问渲染出来。
> 日期：2026-09-23

---

## 裁决项 B（产品）：拒绝授权后的重试循环怎么收场

### B·1 事实（spike 实测）

- 模型被连续拒绝 4 次，**每次换一种命令写法再试**：
  `ls | head -3` → `ls -1 | head -n 3` → `find . -maxdepth 1 …` → `pwd`；
  两次运行分别烧掉 **6 turn / 5 次工具调用** 与 **5 turn / 4 次工具调用**。
- **「拒绝」当前是循环起点，不是终点。**
- 待验：**`block.reason` 是否进了模型上下文**（§五·2）。若没进，模型是在盲猜被拒原因，怎么改措辞都没用。

### B·2 选项对比

| 方案 | 做法 | 优点 | 缺点 / 代价 |
|---|---|---|---|
| **B1 授权卡三键（推荐）** | `ApprovalCard` 从「允许 / 拒绝」扩为「**允许 / 拒绝一次 / 拒绝并停止本次任务**」 | 控制权给用户；语义诚实（现在的「拒绝」其实就是「再给模型一次机会」）；符合我们「呈现层归我们」的定位 | 需确认 Pi 侧有无中断 turn 的公开 API（abort/stop）——**未验**，是 B1 的前置；UI 多一个按钮 + 状态流转 |
| **B2 拒绝理由明示** | 拒绝时把明确理由（用户输入或默认文案）写进 block 原因，让模型知道自己该放弃 | 实现便宜；对「误拒」场景也更友好 | 单独用治不了循环——模型仍可能再试；且依赖「block.reason 进上下文」这一待验事实 |
| **B3 连续 N 次拒绝自动终止** | 同一工具连续被拒 N 次（建议 N=2~3）后 core 自动停 turn | 不依赖模型自觉；防御性兜底 | N 不好定；可能误伤「用户就想让它换思路」的合法流程；需新计数逻辑 |
| **B4 现状不动** | 什么都不改 | 零成本 | 用户体验已实测糟糕：连拒 4 次白烧 5–6 turn 的 token 与时间 |

### B·3 推荐

**B1 + B2 组合**：
- `ApprovalCard` 增加第三个动作「拒绝并停止」（B1），同时拒绝文案里明示原因（B2）；
- B3 作为可选项记入 S6，先不实现；
- **两个前置实验并进**（可与裁决项 A 的归因实验同一轮 spike 做，~30min）：
  1. Pi 有无公开的中断 turn 的 API（搜 SDK 文档/类型里的 abort/stop/interrupt）；
  2. 拒绝后 dump 模型收到的消息序列，确认 `block.reason` 是否进上下文。
- 若 B1 的前置（中断 API）不存在 → 降级为 **B2 + B3(N=3)**。

### B·4 决议栏

> **裁决：暂不做「拒绝并停止」，记为后期扩展（用户拍板，2026-09-23）。**
> 用户原判断「Pi 应该没（中断 API）」——**源码实证：有**。`agent-session.ts:1786` 公开
> `async abort(): Promise<void>`（注释原文 "Abort current operation and wait for agent to become idle"；
> 另 `agent-session.ts:259` 流式时 `prompt` 支持 `"steer"`（打断）入队方式）。
> → **B1 将来做没有任何障碍**，且只是我们 UI 加一个按钮 + 调 `abort()`，不属「自建能力」。
> 执行口径：当前不动（现状 B4）；**若验收/试用中证明重试循环确实难受，再按 B1+B2 落**
> （B1 前置已消失）。B2（拒绝理由明示）成本极低，随 core 实现顺手带上，不单独立项。
> 日期：2026-09-23

---

## 拍板后的动作清单（给 S6 / core 实现）

1. 回填两处决议栏，并把结论同步到 `.plan/README.md` 状态速览与 `spike-core-2026-09-23.md` §三。
2. 若选 A 系信任门：core 的扩展加载要走「**先列清单 → UI 确认 → 再加载**」两段式，
   04 屏的扩展清单数据源（`resourceLoader.getExtensions()`）也要按同一信任语义过滤。
3. 若选 B1：`ApprovalCard` 组件加第三动作，chat-store / 适配层要为「停止」补一个事件或状态
   （注意 reducer 里 `agent_settled` 才收尾的既有语义，别造出第二条收尾路径）。
4. 两个归因/前置实验并入下一轮 spike，产物照惯例放 `pi/_poc/`、结论回写本文档。
