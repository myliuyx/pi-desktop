# core 骨架 spike 记录（2026-09-23）

> 目的：验证 S4 选定、S3 依赖、但**从未被任何实测覆盖**的那套架构 ——
> 「**纯 Node 进程** + Pi SDK + 注入 `ExtensionUIContext` + HTTP/SSE」能不能真跑起来。
> 顺带补掉 S3 §八 的两条待验项。
> 前置：S3（`survey/S3-tool-approval.md`）、S4（`survey/S4-transport-decision.md`）。
> **结论：全部通过。** 且意外发现一处**安全相关**行为（见 §三·4），建议优先裁决。

---

## 一、结论速览

| 验证项 | 结果 |
|---|---|
| 纯 Node 进程（无 Electron、无 TUI）跑通 SDK 会话 | ✅ |
| HTTP + SSE 传输（`127.0.0.1:5199`） | ✅ 授权经 SSE 下发、经 `POST` 回收，往返闭环 |
| `bindExtensions({ uiContext, mode: "rpc" })` 注入 | ✅ 扩展侧实测读到 `hasUI=true`、`mode=rpc` |
| `ctx.ui.select()` 提问 → 浏览器应答 → 扩展拿到返回值 | ✅ 4 次往返全部成功 |
| 幂等语义（照抄 Pi RPC 的 delete-then-resolve） | ✅ 首次生效、未知 id 静默忽略 |
| **S3 补验第 1 条**：拒绝授权后 UI 看到什么 | ✅ **已答**，且**推翻了初版猜测**（§三·1） |
| 会话耗时 | 13.9s / 17.4s（两次运行，**数值不稳定**，勿写死） |

---

## 二、复现方式

**资产**（`pi/` 整体 gitignore，不入库，与 POC 同惯例）：

| 文件 | 作用 |
|---|---|
| `pi/_poc/spike-core/spike.ts` | 纯 Node 进程：HTTP+SSE 服务 + `ExtensionUIContext` 最小实现 + 自动驱动 |
| `pi/_poc/spike-core/spike-tools.ts` | **「工具成功执行」dump**（2026-09-23 追加）：专用 `agentdir-tools/`（settings.json 配 `shellPath` 指向 PortableGit bash）+ `cwd` 不落 pi/（0 扩展）→ 产出 `result-tools.jsonl`，钉死成功终态形状（§五·1） |
| `pi/_poc/spike-core/agentdir/extensions/approval-gate.ts` | 逼出授权的扩展（照 `examples/extensions/permission-gate.ts` 改） |
| `pi/_poc/spike-core/result.jsonl` | 逐条明细（core↔ui 双向 + Pi 全部事件原文） |
| `pi/_poc/spike-core/stdout.txt` | 报告快照 |

**命令**（在 `pi/` 下）：

```bash
node --env-file=_poc/.env.local node_modules/tsx/dist/cli.mjs _poc/spike-core/spike.ts
```

⚠️ **必须后台跑**：模型可能反复重试工具调用，前台会被工具超时 SIGTERM 掉、拿不到报告
（第一次就踩了）。spike 内已加 `SPIKE_HARD_MS`（默认 180s）兜底。

---

## 三、★ 四个最有价值的发现

### 1. 拒绝授权后，UI 看到的是**完整的工具事件序列**，不是"什么都没有"

**实测**：被 block 的调用**仍然发出 `tool_execution_start` → `tool_execution_end`**，
只是 `result.content[0].text` 换成 block 原因、`isError: true`：

```jsonc
{"type":"tool_execution_end","toolName":"bash",
 "result":{"content":[{"type":"text","text":"Blocked by spike (auto-reject)"}],"details":{}},
 "isError":true}
```

**→ 影响**：`TerminalBlock` **不需要为「被拒绝」做任何特判** —— 它就是一条普通终端块
（输出 = 拒绝原因、状态 = error）。
**S3 §3.3 初版猜的「可能表现为该 toolCall 没有 `tool_execution_start`」是错的**，已在 S3 中纠正。

### 2. ★★ 拒绝授权的真实代价：模型会换写法反复重试

**实测**：模型被连续拒绝 4 次，**每次都换一种命令写法再试**：

```
ls | head -3
ls -1 | head -n 3
find . -maxdepth 1 -type f -o -maxdepth 1 -type d | head -3
pwd
```

两次运行分别烧掉 **6 个 turn / 5 次工具调用** 与 **5 个 turn / 4 次工具调用**。

**→ 这是产品级发现，原清单里没有**：用户每拒一次，模型就换个姿势再来 ——
**「拒绝」在当前形态下不是终点，而是一个循环的起点**。要么给「拒绝并停止本次任务」的选项，
要么在拒绝时给模型一条明确的拒绝原因（`block.reason` 是否进了模型上下文需要再验）。

**✅ 已裁决（2026-09-23）**：暂不做「拒绝并停止」（后期扩展；Pi 有公开 `abort()`，
`agent-session.ts:1786`，届时零障碍）；拒绝理由明示随 core 顺手带上。
详见 [`decision-rulings-2026-09-23.md`](./decision-rulings-2026-09-23.md) B 节。

### 3. `select` 的多行 title 形状已确认

实测原文：`"Allow this command?\n\n  ls | head -3"` —— 命令原文确实嵌在 `title` 里，
`\n\n` 分隔稳定。S3 §五·C 登记的「`ApprovalCard` 是整块渲染还是拆出等宽代码块」这条 UI 待拍板项
**依据已齐**（数据侧不用再等）。

### 4. ⚠️ **安全相关：项目本地扩展被自动加载并执行，未见信任交互**

**实测**：spike 里只提供了 **1 个**扩展（`agentdir/extensions/approval-gate.ts`），
但 `extensionsResult.extensions` 报 **5 个**，多出来的 4 个全部来自 **`pi/.pi/extensions/`**：

```
pi/.pi/extensions/import-repro.ts
pi/.pi/extensions/prompt-url-widget.ts
pi/.pi/extensions/redraws.ts
pi/.pi/extensions/tps.ts
```

原因是 spike 的 `cwd` 落在 `pi/`，而它们被当作**项目本地扩展**（`sdk.md:347`）加载。

**⚠️ 但 `usage.md:121-127` 写的规则是**：项目本地设置/资源需要信任；
非交互模式按 `defaultProjectTrust` 处理，`ask`（默认）与 `never` 会**忽略**这些项目资源。
**本次观察到的是：直接加载了，没有任何信任交互或报错。**

**→ 这是必须裁决的安全面**：扩展是**可执行代码**。我们的产品形态是
「用户在自己机器上起服务 + 浏览器访问」，如果用户**在任意含 `.pi/extensions/` 的目录里打开我们的 app**，
那些文件会被加载执行。

**✅ 已裁决（2026-09-23）**：选 **A3 跟随 Pi**，归因已源码实证 —— 信任门是
`resource-loader.ts:388-400` 的 `reload({ resolveProjectTrust })` 显式两段式，SDK 默认绕过（非 bug）；
core 须显式传回调。详见 [`decision-rulings-2026-09-23.md`](./decision-rulings-2026-09-23.md) A 节。

**待确认**（本轮只观察到现象，未做归因实验）：
- 是 SDK 模式**本就不走信任门**，还是本次 `settings.json` 的 `defaultProjectTrust` 恰为 `always`？
- 若确实不走门：我们是**主动加一道信任确认**（UI 上问一次，类似 Pi 的 `/trust`），
  还是**直接不加载项目本地扩展**（只认全局 `~/.pi/agent/extensions/`）？

建议：**在 core 实现之前把这条拍掉**，并对照 `docs/security.md`。

---

## 四、被推翻 / 纠正的判断（本轮）

| 出处在哪 | 原判断 | 实测后 |
|---|---|---|
| S3 §3.3 | 拒绝后「可能没有 `tool_execution_start`」 | **错**：有完整事件序列，输出换成 block 原因 |
| S3 §4.2 | `exitCode` ← `tool_execution_end.result.exitCode` | **错**：事件里 `result` 是 `{content, details}`，**没有 `exitCode`**（已改） |
| S3 §4.3 | `output` ← `_update.partialResult` → `_end.result.output` | **错**：取值路径是 `result.content[*].text`（已改） |
| S3 §2.5 | `mode` 填什么"待拍板" | **已定**：填 `"rpc"`，实测扩展读到 `mode=rpc` + `hasUI=true` |
| S3 §八·2 | `partialResult` 形状未验 | **已答**：对象 `{content: [...]}`，非 string |

**方法论提醒**：这次三处错误全部源于**从源码内部类型（`BashResult`）推断事件形状**。
教训与项目既有教训 #1 同族但方向相反 —— **不是"断言写错了"，是"推断的输入源不对"**：
**内部类型的形状 ≠ 事件里的形状，中间隔着一层打包。**

---

## 五、仍未验（不因本 spike 消失）

1. ~~**`exitCode` / `truncated` 在事件里的来源**~~ → **✅ 已销账（2026-09-23，spike-tools）**：
   给专用 agentDir 配 `shellPath`（本机 PortableGit bash）后，bash 与 read **首次成功执行**
   （`pi/_poc/spike-core/result-tools.jsonl`）。dump 证明：**事件里没有 `exitCode`、`truncated`，
   成功时连 `details` 都不存在** —— 成功终态的 `result` 只有 `content`（事件键 =
   `type/toolCallId/toolName/result/isError`）；`details: {}` 只出现在 `tool_execution_update`
   的 `partialResult` 里。
   **⇒ `TerminalBlock.exitCode` / `.truncated` 没有数据源**（三轮 dump 全一致：成功/失败/被拒皆无），
   UI 按 `isError` 表达成败即可；`shellPath` 的配置方式 = `<agentDir>/settings.json` 的
   `"shellPath"` 字段（`settings-manager.ts:237`，Pi 自身探测顺序见 `docs/windows.md`）。
   残余未知（低优先）：超长输出触发截断时 `details` 是否会带 `fullOutputPath` —— 未验，等 C2 遇到再说。
2. **`block.reason` 是否进了模型上下文** —— 若没进，模型只能靠猜为什么被拒（§三·2 的循环）。
3. **`opts.timeout` 的真实使用情况**（S3 §八·3）。
4. **多会话并发的 `requestId` 分区**（S3 §八·7）。
5. ~~**项目本地扩展的信任门**（§三·4，待归因）~~ → **已归因+裁决（2026-09-23）**：
   SDK 默认绕过 `resolveProjectTrust` 两段式，非 bug；裁决 A3 跟随 Pi，见决策单 A 节。

---

## 六、对后续的影响

- **S4 的架构选型得到实证支持**：独立 core 进程 + HTTP/SSE 这条路**在真机上跑通了**，
  不再是纸面结论。S6 汇总可以直接在此基础上写《Pi 对接设计》。
- **S3 的接口结论全部成立**（`uiContext` 注入、`hasUI`、幂等、`mode:"rpc"`），
  只有「事件字段级映射」那部分需要按 §四 修正 —— 已回写 S3。
- **新增两个必须裁决项**（都建议在 core 实现前拍掉）：
  ① 项目本地扩展的信任门（§三·4，安全）；
  ② 拒绝授权后的重试循环怎么收场（§三·2，产品）。
- **`packages/ui` 未改任何代码**；本 spike 的资产全部在 gitignore 的 `pi/` 下，与 POC 同惯例。
