# Pi 斜杠命令接入调研（Pi Workbench）· 第二轮（已定稿）

> 调研日期：2026-10-03　**范围：只调研评估，未改任何产品代码。**
> 权威依据：`pi/`（**0.99.2**，与 `packages/core/node_modules` 实际安装版本一致）。
> 本文已含第一轮全部结论，并按用户最新截图 + 裁决收敛。

---

## 0. 本轮的结论摘要

用户已裁决范围：**这一版只接 `/reload` + `/compact`（builtin）＋ 扩展命令 ＋ 技能**，
参考图（截图）里的「扩展 / 技能」分栏补全菜单。
**代码设计必须为「以后接更多命令」留门** —— 这是本轮设计的首要约束。

三个必须先知道的**新发现**（第一轮没查到）：

| # | 发现 | 影响 |
|---|---|---|
| 1 | **`preflightResult` 回调公开可用**（`PromptOptions.preflightResult`，`agent-session.ts:308`） | `POST /prompt` 可以知道「这条 `/xxx` 是被扩展命令消费了(handled) / 排队了(queued) / 真发给模型了(started)」——**回执问题解决了**，UI 不会再出现「发出去没影」 |
| 2 | **compact 事件当前被 `adapt.ts` 丢弃**（`adapt.ts:98` 注释明说 compaction_* 返回 null） | 接 `/compact` 必须同时打通 `compaction_start/end` → UI，否则用户点了「没有任何反馈」 |
| 3 | `enableSkillCommands` 开关存在（`settings-manager.ts:1264`，默认 true） | 技能是否出现在菜单里，要跟这条开关走，不能无条件全列 |

---

## 1. 范围与 UI 参考图的对应

参考图是一个**分组卡片列表**：

```
扩展  (1)                          ← 分组标题 + 右侧计数
┌──────────────────────────────────────────────┐
│ /think-zh                                       │
│ 中文思考提示词：on | off | status | prompt <文本> | reset   ← 描述行（单行，超出截断）
└──────────────────────────────────────────────┘

技能  (15)
┌────────────┐┌────────────┐┌────────────┐
│ /skill:brainstorming │ │ /skill:dispatching-parallel- │ │ /skill:executing-plans │
│ You MUST use this…    │ │ Use when facing 2+…         │ │ Use when you have a…    │
└────────────┘└────────────┘└────────────┘   ← 三列网格
```

图里体现的 UI 规则（可直接落成实现约束）：

1. **一级列表 + 分组**：分组标题（扩展 / 技能 / …）+ 右侧计数；无计数的是内置命令（参考图没截到，推测为置顶单列区）。
2. **命令名一行（等宽/mono）+ 描述一行**，描述超长单行截断（CSS `truncate`，图里可见 `…`）。
3. **技能区是多列网格**（3 列），扩展区是单列宽卡 —— 说明「分组 → 布局」是数据驱动的，不是写死的。
4. 选中项有 **accent 色边框 + 高亮背景**（图里 `/skill:brainstorming` 被选中）。
5. 描述来自 `command.description` / `skill.description`，**没有真实描述就不显示**（不造占位文案）。

---

## 2. 三类命令的真实数据源（本轮逐个查证 0.99.2 源码）

### 2.1 builtin（23 条）—— `/reload` `/compact`

数据源 `core/slash-commands.ts`（`BUILTIN_SLASH_COMMANDS`）：

| 命令 | argumentHint | 我们的实现落点（已验证） |
|---|---|---|
| `/compact` | 无（实际支持可选指令） | `session.compact(instructions?)` —— `interactive-mode.ts:7010` 只是直接透传 |
| `/reload` | 无 | `session.reload()` —— `interactive-mode.ts:6402`；`interactive-mode.ts:6349` 两个前置检查 |

**两个命令的 pi 侧前置条件**（照抄即可，很便宜）：

```ts
// /reload (interactive-mode.ts:6350-6357)
if (session.isStreaming) → 拒绝「等当前回复结束」
if (session.isCompacting) → 拒绝「等压缩结束」
// 然后 session.reload({ beforeSessionStart })
```

**我们已有的现成能力**：`POST /session/reload`（`server.ts:883`）已实现 `session.reload()`，
且已带 `isStreaming → 409` 的护栏 ⇒ **`/reload` 的执行侧几乎零成本**。

`/compact` 则**完全没有**：`core/src` 里搜不到任何 compact 相关代码（`session.ts` / `server.ts` /
`contract.ts` 全无）。需要新增 runtime 方法 + 端点 + 契约类型。

### 2.2 扩展命令 —— 零新增执行通道，已白捡

执行路径（`agent-session.ts:1930`）：

```
session.prompt(text)                      ← expandPromptTemplates 默认 true
  └─ text.startsWith("/") → _tryExecuteExtensionCommand(text)   ← 立即执行，streaming 中也执行
       └─ extensionRunner.getCommand(name) → await command.handler(args, ctx)
```

清单来源（**全部公开可取**）：

```ts
session.extensionRunner.getRegisteredCommands(): ResolvedCommand[]
  // ResolvedCommand = RegisteredCommand & { invocationName }
  //   name / description? / getArgumentCompletions? / handler / sourceInfo / invocationName
```

**pi 自己怎么处理「builtin 与扩展同名」的**（`interactive-mode.ts:703-727`）：
扩展命令在补全菜单里**被剔除**（`builtinCommandNames.has(cmd.name)` 过滤），
并产出诊断警告：`Extension command '/model' conflicts with built-in interactive command. Skipping in autocomplete.`
⇒ **建议照抄：菜单里 builtin 优先，扩展同名项不显示。**

### 2.3 技能 —— 零新增执行通道，已白捡

展开路径（`agent-session.ts:2100`）：

```
_expandSkillCommand("/skill:brainstorming 帮我设计")
  ├─ 只认 "/skill:" 前缀
  ├─ name = 到第一个空格；args = 余下 trim
  ├─ 查 resourceLoader.getSkills().skills.find(s => s.name === skillName)
  ├─ 找不到 → **原样透传**（不报错！会当普通消息发给模型）
  └─ 命中 → <skill name=… location=…>\nReferences are relative to …\n\n正文\n</skill>
```

清单来源：`session.resourceLoader.getSkills().skills` → `{ name, description, filePath, baseDir, sourceInfo }`
（`Skill` 类型**已从 `index.d.ts` 导出**）。

**注意我们的现状**：`GET /skills` 已经返回了全部技能的 name/description/path/enabled
（`contract.ts:779 SkillListItem`，比 pi 的 `Skill` 还多一个 `enabled`）⇒
**技能清单可以直接复用现成端点**，不需要新造。

---

## 3. 设计方案（为「以后接更多命令」预留扩展位）

### 3.1 分层：命令 = 「静态元数据」+「执行方式」

参考 pi 的 `SlashCommandContribution`（`experimental/services/slash-commands-provider.ts`），
我们的命令表应该是**声明式数据 + 可选交互**，而不是一堆 if：

```ts
// 建议的契约形状（core/src/contract.ts）
type SlashCommandSource = "builtin" | "extension" | "skill";

interface SlashCommandItem {
  /** 展示名（不带前导斜杠）："reload" / "think-zh" / "skill:brainstorming" */
  name: string;
  description: string;          // 无则空串（不造占位）
  source: SlashCommandSource;
  /** 内置命令的参数提示，如 "<instructions>"；其余为空 */
  argumentHint?: string;
  /** 该命令当前是否可执行（流式中 / 压缩中 → builtin 置 false） */
  available: boolean;
  /** 仅扩展/技能：资源归属（用户目录 / 项目内 / 插件包），供 UI 打来源标签 */
  scope?: "user" | "project" | "package";
}

interface SlashCommandsPayload {
  commands: SlashCommandItem[];
  /** 会话是否可执行 builtin（流式中 / 压缩中 → false，UI 据此置灰） */
  builtinAvailable: boolean;
  /** 信任结论等（与 /resources 同语义，可复用现有 TrustHint） */
}
```

**扩展位设计的关键**（这是用户明确要求的）：

- `available` 字段 → 以后接 `/model` `/thinking` 这类「流式中禁用」的命令时零改动；
- `scope` 字段 → 以后接提示词模板（prompt）时直接复用；
- `argumentHint` → 以后接需要补全参数的命令时，UI 可再挂 `getArgumentCompletions` 通道；
- **不把 builtin 名字写死成两三个**，而是全量 23 条入表 + 用 `available`/一个 `implemented` 位筛。

### 3.2 执行：一张注册表，core 侧

```ts
// core/src/slash-commands.ts（新增文件）
const BUILTIN_IMPLS: Record<string, (args: string) => Promise<void>> = {
  reload: async () => { /* 转发已有 reloadSession() */ },
  compact: async (instructions) => { /* session.compact(instructions) */ },
  // 👇 以后加命令 = 这里加一行 + 菜单里自动出现（零改动 UI）
};
```

**刻意不复刻 pi 的 `if (text === "/xxx")` 长链**，也**不用 REST 17 端点**。
一个 `POST /slash-commands/execute { name, args }` 统一入口，加命令只动这一个文件。

### 3.3 执行：UI 侧分派（关键决策）

三条路径，**UI 必须能区分**：

| 命令种类 | 走哪条路 | UI 行为 |
|---|---|---|
| builtin（`/reload` `/compact`） | `POST /slash-commands/execute` | 触发态（等待/结果通知） |
| 技能 `/skill:x` | **`POST /prompt`**（pi 自动展开） | 与普通消息一致（渲染成 user 消息） |
| 扩展命令 `/foo` | **`POST /prompt`**（pi 自动派发） | 不产生消息（pi 语义），只弹通知 |

**为什么技能/扩展继续走 `/prompt` 而不是统一 execute 端点**：
它们的执行体在 pi 内部（`_expandSkillCommand` / `_tryExecuteExtensionCommand`），
我们没有也不该有第二个执行器；走 `/prompt` 零新增代码，且和 pi 的语义 100% 一致
（包括「技能找不到就原样透传」这种细节）。

### 3.4 回执：靠 `preflightResult`（新发现，价值很高）

core 现在的 `prompt()` 是 `session.prompt(text, images)`（`session.ts:125`），
**丢掉了 `preflightResult`**。接上后 `POST /prompt` 能告诉 UI 到底发生了什么：

```ts
// agent-session.ts:308 —— 公开的 PromptOptions 成员
preflightResult?: (disposition: PromptDisposition) => void;
// PromptDisposition = "handled" | "queued" | "started"
```

- `handled` = 被扩展命令消费（**没有消息发出**）→ UI 不应显示成一条用户消息，
  应弹「命令已执行」通知；
- `started` / `queued` = 真发给了模型 → 正常渲染。

⚠️ 注意「乐观回显」的现状：`chat-store.ts:419` 在 live 分支**先本地塞一条 user 消息**，
再发请求。若命令是 `handled`，UI 会留下一条**假消息**。
⇒ 这是本次必须一起解决的一处（要么先等回执再回显，要么拿到 `handled` 后撤回）。

### 3.5 UI 形态：分组卡片列表（对齐参考图）

放在 Composer 上方（沿用 `ComposerAtMenu` 的架构：portal + fixed + 锚定 composer 根盒向上弹）。

```
┌ / ──────────────────────────────────┐   ← 触发：光标处 token 以 / 开头（行首/空白后）
│ 扩展                       1        │   ← 分组标题 + 计数（右对齐灰字）
│ ┌───────────────────────────────┐  │
│ │ /think-zh                     │  │   ← 命令名 mono 一行
│ │ 中文思考提示词：on | off | …    │  │   ← 描述 truncate 一行
│ └───────────────────────────────┘  │
│ 技能                      15       │
│ ┌──────────┐┌──────────┐┌──────┐  │
│ │/skill:…  ││/skill:…  ││/skill│  │   ← 3 列网格
│ │You MUST… ││Use when… ││Use … │  │
│ └──────────┘└──────────┘└──────┘  │
└───────────────────────────────────┘
```

实现要点：
- **与 `@` 文件弹层互斥**（同一时刻只开一个）—— Composer 里两套 state 加一个仲裁点；
- 布局差异用数据驱动（`source === "skill" ? grid3 : 单列`），不写死两个组件；
- 描述空串 ⇒ 该行不渲染（诚实纪律，不造占位文案）；
- 键盘：↑↓ 移动 / Enter 或 Tab 确认 / Esc 关闭（与 `ComposerAtMenu.handleKey` 同款签名，
  可直接复用其骨架）；
- 选中插入行为：**插入命令名并补一个尾随空格**（`/skill:brainstorming `），
  与 `handleAtPick` 同款手法（区间替换 + rAF 聚焦）；
- **mock 形态**：按项目「同类豁免纪律」，mock 的命令清单**恒空** ⇒ 弹层不出现
  （演示面自然等于「没这个能力」），不另写一套。

### 3.6 计数与分组数据

- 扩展组计数 = `session.extensionRunner.getRegisteredCommands()` 去掉与 builtin 同名的
  （照抄 pi 的过滤规则，`:752`）；
- 技能组计数 = `resourceLoader.getSkills().skills.length`（**且要过 `getEnableSkillCommands()`**，
  `:795` —— 图里 15 条说明开关是开的）；
- 参考图里 builtin 区没有计数 ⇒ 内置命令区大概率不带计数（待你确认，见 §6）。

---

## 4. 必须一起解决的两处既有缺口

### 4.1 `adapt.ts` 丢弃 compact 事件（接 `/compact` 的硬前提）

`adapt.ts:98` 的注释明说：`compaction_*` 返回 null 跳过。
现状：自动压缩（threshold/overflow）发生时 UI **完全无感知**。
接 `/compact` 后用户会看到「点了按钮 → 什么都没发生」。

需要补的契约事件（形状取自 `agent-session.ts:203-215`）：

```ts
| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
| { type: "compaction_end"; reason: …; result: CompactionResult | undefined;
    aborted: boolean; willRetry: boolean; errorMessage?: string }
```

UI 侧：压缩中需要一个可见态（不可复用 `streaming`，那是「模型在跑」；建议独立 `compacting` 标志）
+ 结束后按 `result.summary` 渲染一条压缩摘要消息
（pi 的渲染口径见 `interactive-mode.ts:3638-3668`：清屏重渲 + 摘要消息 + 可能的用量提示）。

⚠️ 这会**顺带修好自动压缩的静默问题**，属于净收益。

### 4.2 `/compact` 与流式的关系

`session.compact()` **内部先 `await this.abort()`**（`agent-session.ts:2716`），
即「压缩会中止当前生成」。这一点必须让用户知道，否则像 bug。
pi 的 TUI 是把 `/compact` 放在 streaming 分支之前直接执行（不提示）。
⇒ **建议 UI 在流式中把 `/compact` 置灰 + tooltip 说明「会先停止当前生成」**（`available` 字段正好承载）。

---

## 5. 端点与契约的最小改动集（不写代码，仅列清单）

**core 侧**
1. `GET /slash-commands` → `SlashCommandsPayload`（列表；复用现有 skills 数据源 + 新查 extensionRunner）
2. `POST /slash-commands/execute` `{name, args}` → 目前只认 `reload` / `compact`
3. `runtime.prompt()` 接上 `preflightResult` → `POST /prompt` 响应体多一个 `disposition` 字段
4. `adapt.ts` 补 `compaction_start` / `compaction_end` 翻译 + `contract.ts` 加两个事件类型
5. `POST /slash-commands/execute` 的 `compact` 分支需 `session.compact()` 的 runtime 转发方法

**UI 侧**
1. `agent-transport.ts` 加 2 个方法 + `PromptSendResult` 加 `disposition`
2. `store/chat-store.ts`：`sendMessage` 处理 `handled`（撤回乐观回显 / 弹通知）+ `compacting` 标志
3. 新组件 `ComposerSlashMenu.tsx`（骨架抄 `ComposerAtMenu.tsx`）
4. `Composer.tsx`：`/` 触发检测 + 与 `@` 弹层互斥 + 按键路由
5. `MessageList`/reducer：compaction 事件的渲染（摘要消息）

---

## 6. 第二张参考图（完整菜单）解析 —— 用户已提供

```
斜杠命令 · 23 个命令                         [Tab / Enter 提示]
内置                                    7
  /auto-compact  /clone  /compact      ← 3 列网格自动换行
  /copy  /name  /reload
  /session
扩展                                    1
  /think-zh  中文思考提示词：on | off | status | prompt <文本> | reset
技能                                   15
  /skill:brainstorming  /skill:dispatching-parallel-agents  /skill:executing-plans  …
```

### 6.1 从图里读出的 6 条 UI 规则（可直接落成实现约束）

1. **头部**：`斜杠命令 · N 个命令` + 右上角 `Tab / Enter` 操作提示。
2. **三个分组，标题左 + 计数右**（`内置 7` / `扩展 1` / `技能 15`）。**内置组也带计数**。
3. **布局数据驱动**：内置与技能都是 **3 列网格**，扩展是 **单列宽卡**。
   图证：内置第一行 3 张卡（`auto-compact`/`clone`/`compact`），第二行 3 张
   （`copy`/`name`/`reload`），第三行 1 张（`session`）—— 是**纯网格自动换行**。
   ⇒ 布局规则 = `source === "extension" ? 单列 : 三列网格`。
4. **卡片形状**：命令名 mono 一行（可换行，如 `/skill:finishing-a-development-branch`）+ 描述 truncate 一行。
5. **选中态**：accent 色边框 + 高亮背景（图中 `/skill:dispatching-parallel-agents` 被选中）。
6. **计数口径**：内置 7 = **已实现数**（不是 pi 的 23 条）；技能 15 = 实际技能数；扩展 1 = 实际扩展命令数。

### 6.2 重要发现：`/auto-compact` 不是 pi 的 builtin

图里内置组有 `/auto-compact  切换自动上下文压缩（全局设置）`，
但 **pi 0.99.2 的 `BUILTIN_SLASH_COMMANDS` 里查无此条**（已 grep 确认，23 条里只有 `compact`）。
它的能力对应公开 SDK `session.setAutoCompactionEnabled(enabled)`（`core/agent-session.ts:3202`）
—— 项目设置页已有对应开关（`SettingsGeneralTab.tsx:173` 的 `setting:autoCompact`）。

⇒ **`/auto-compact` 是 Pi Workbench 自己加的命令**，不是 pi 内置。
这恰好验证了「命令表要可扩展」的设计要求，且它的实现成本极低（一个已公开的 getter/setter）。

### 6.3 我们 builtin 组的展示口径（唯一待定项）

我们只接了 2 条（`/reload` `/compact`），图里是 7 条：

- **A（保守，建议）**：菜单只列**已实现的** ⇒ 内置组计数 = 2。
- **B（对齐图）**：再接 `/copy` `/name` `/session` `/clone` 凑齐 7 条，计数 = 7。

这 4 条的落点均已核实可行，且 3 条有现成资产：

| 命令 | 落点（0.99.2 已验证） | 我们的现成资产 |
|---|---|---|
| `/copy` | `session.getLastAssistantText()` | 浏览器 `navigator.clipboard` |
| `/name` | `session.setSessionName()` | ✅ 已有 `POST /sessions/rename` |
| `/session` | `session.getSessionStats()` + `getContextUsage()` | ✅ 已有 `usage` SSE 事件大部分字段 |
| `/clone` | `runtimeHost.fork(leafId,{position:"at"})` | ⚠️ core 现有 `rebuildSession` 语义不同，需新增 |

其余 16 条 pi builtin（`settings`/`model`/`thinking`/`tree`/…）**一律不展示**——
在 Web 形态下要么无意义（`hotkeys`/`changelog`），要么需额外胶水。

**建议先按 A 做**（本轮承诺范围就是 2 条），但**命令表与 UI 一律按「已实现才出现」写**，
后续补 `/copy` `/name` `/session` `/clone` 只是加 core 注册表 + 中文描述，**UI 零改动**。

### 6.4 技能数 15 与本机实际完全对得上

本机实测：`~/.pi/agent/skills/` → **1 个**（`web-content-fetcher`）；
`~/.pi/agent/git/github.com/obra/superpowers/skills/` → **14 个**（插件包贡献）。
合计 **15** ⇒ 证明技能清单要**包含插件包贡献的技能**
（`resourceLoader.getSkills()` 本就含包技能，与 `GET /skills` 全量口径一致 ✅）。

另外 `/skill:brainstorming` 等 14 个 superpowers 技能与 `mock/plugins.ts:18-33`
已有的 mock 清单**逐条一致** ⇒ mock 形态可直接复用那份常量。

### 6.5 扩展 1 条：已定位到源

```
~/.pi/agent/local/pi-think-zh/extensions/index.ts:50
  pi.registerCommand("think-zh", {
    description: "中文思考提示词：on | off | status | prompt <文本> | reset",
    getArgumentCompletions: prefix => ["on","off","status","prompt","reset"] 过滤,
    handler: async (args, ctx) => { ... }
  })
```

- 图里描述与 `description` **逐字一致** ⇒ 描述行直接取 `command.description`，无需加工；
- `local/` 目录 ⇒ `sourceInfo.scope === "user"`、`origin === "top-level"`（非 package）
  ⇒ 与 superpowers 技能的“包归属”是不同来源，UI 标签可区分；
- ⚠️ **它注册了 `getArgumentCompletions`** ⇒ 第一版菜单只展示命令名即可，
  但**参数补全是现成的扩展位**（以后接 `/model <provider/model>` 时照同一机制实现）。

## 7. 用户已裁决的问题

| # | 问题 | 裁决 |
|---|---|---|
| 1 | `/compact` 是否支持？ | ✅ **pi 支持**，且支持可选附加说明（`/compact 帮我保留最近的改动`）—— 已确认 |
| 2 | 技能 / 扩展为空时怎么办？ | ✅ **直接不展示**（分组本身不渲染，不显示 0 计数、不留空分组） |
| 3 | 内置命令卡片口径 | 图已给出完整口径（§6.1），按图执行 |

## 8. 最终形态小结（本轮可直接进入实施）

```
斜杠命令 · N 个命令                          [Tab / Enter]
内置                                  {已实现数}
  三列网格：命令名 + 中文描述
扩展                                  {扩展命令数}
  单列宽卡：/命令名 + description（取 RegisteredCommand.description 原样）
技能                                  {技能数}
  三列网格：/skill:name + skill.description
```

分组为空 ⇒ 该分组不渲染（裁决 2）。描述为空 ⇒ 卡片只渲染命令名一行（不造占位文案）。

---

## 9. 证据索引（pi 0.99.2 源码，`pi/packages/coding-agent/src/`）

| 内容 | 位置 |
|---|---|
| 23 条 builtin 清单 | `core/slash-commands.ts` |
| builtin 分发 if 链 | `modes/interactive/interactive-mode.ts:2560-3260` |
| `/compact` 实现（纯透传） | `interactive-mode.ts:7010` |
| `/reload` 实现 + 两个前置检查 | `interactive-mode.ts:6349-6410` |
| 扩展命令执行 | `core/agent-session.ts:1930` → `:1574 _tryExecuteExtensionCommand` |
| 技能展开（含「找不到就透传」） | `core/agent-session.ts:2100 _expandSkillCommand` |
| `preflightResult` + `PromptDisposition` | `core/agent-session.ts:298-309`、`:163` |
| `session.compact()`（内部先 abort） | `core/agent-session.ts:2716` |
| `compaction_start/end` 事件形状 | `core/agent-session.ts:203-215` |
| `compaction_end` 的 UI 渲染口径 | `interactive-mode.ts:3623-3668` |
| 扩展命令清单 + builtin 冲突过滤 | `core/extensions/runner.ts:838`、`interactive-mode.ts:703-727` |
| `ResolvedCommand` 类型 | `core/extensions/types.ts:1525` |
| `enableSkillCommands` 开关 | `core/settings-manager.ts:1264` |
| pi 的补全菜单装配（含来源标签算法） | `interactive-mode.ts:665-810` |
| pi 的模糊匹配实现（参考，不建议引入） | `packages/tui/src/fuzzy.ts:100` |

**我们的对应现状**

| 内容 | 位置 |
|---|---|
| 已有 `/session/reload`（含 409 护栏） | `packages/core/src/server.ts:883`、`session.ts:1304` |
| 已有 `/skills`（含 enabled，技能清单可复用） | `packages/core/src/skills.ts`、`contract.ts:779` |
| `adapt.ts` 丢弃 compaction 事件 | `packages/core/src/adapt.ts:98` |
| `prompt()` 丢掉 preflightResult | `packages/core/src/session.ts:125` |
| `@` 弹层（骨架可抄） | `packages/ui/src/components/chat/ComposerAtMenu.tsx` |
| Composer 的 `/`-弹层接入点 | `packages/ui/src/components/chat/Composer.tsx:230`（`computeAtState` 旁） |
| live 乐观回显（handled 需处理） | `packages/ui/src/store/chat-store.ts:419` |
| 通知通道（命令结果走这里） | `packages/ui/src/store/notice-store.ts` |