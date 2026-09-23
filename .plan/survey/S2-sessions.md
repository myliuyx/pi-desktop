# S2 · 会话与持久化（梳理结论）

> 日期：2026-09-23　阶段：Pi 梳理 S2（`pi-survey-plan.md`）
> 前置：S0（`survey/S0-our-contract.md`）、S4（`survey/S4-transport-decision.md`）
> **本阶段比原估（3h）短得多**，原因见 §一：Pi 把会话持久化整个做好了，且 API 是公开的。
> 方法同 S1/S3：**结论标出处（`文件:行号`）**；本阶段未跑真实 dump（见 §七）。

---

## 一、结论速览（先给）

1. **★ 会话持久化 Pi 已经全部做好了，我们不需要自建任何存储。**
   Pi 自动把会话存到 `~/.pi/agent/sessions/`，按工作目录组织（`docs/usage.md:79`），
   并提供公开的 `SessionManager` 静态方法做列举 / 打开 / 续接 / 按 id 查找。
2. **`SessionInfo` → 我们的 `SessionSummary` 字段完全够用，不需要改类型**（见 §三）。
3. **★ 但发现一处真实的、原估里没有的工作量**：**加载历史会话 ≠ 重放事件**。
   会话文件里存的是 **`SessionEntry[]`（另一种形状）**，需要一份**独立的 entry → Block 映射**，
   而适配层现有的 `reduce.ts` 只处理**实时事件流**。这两条路径不能互相替代（见 §四）。
4. **两个正式验收入口（`?empty=1` / `?stress=N`）建议保留**，理由与处置同 MCP（§五）。

---

## 二、Pi 侧的现成能力（实测 API）

`core/session-manager.ts` 的 `SessionManager`（类定义 L898）：

| 我们要的 | Pi 现成 API | 出处 |
|---|---|---|
| 会话存哪 | 自动存 `~/.pi/agent/sessions/<encoded-cwd>/` | `docs/usage.md:79`；`session-manager.ts:1755` 注释 |
| **列举当前目录会话** | `static async list(cwd, sessionDir?, onProgress?, signal?) → SessionInfo[]` | L1758-1763 |
| **列举全部目录会话** | `static async listAll(onProgress?, signal?) → SessionInfo[]`（另有 `sessionDir` 重载） | L1779-1785 |
| **加载指定会话** | `static open(path, sessionDir?, cwdOverride?) → SessionManager` | L1624 |
| 按 id 找文件 | `static findById(cwd, id, sessionDir?) → string \| undefined` | L1732 |
| 续接最近 | `static continueRecent(cwd, sessionDir?) → SessionManager` | L1651 |
| 新建 | `static create(cwd, sessionDir?, options?) → SessionManager` | L1613 |
| 分支/克隆 | `static forkFrom(...)`（L1673）/ `createBranchedSession(leafId)`（L1489） | — |
| 会话标题 | 实例 `getSessionName() → string \| undefined` | L1226 |
| 会话 id / 文件 | `getSessionId()`（L1063）/ `getSessionFile()`（L1067） | — |
| 是否落盘 | `isPersisted()`（L1047）/ `usesDefaultSessionDir()`（L1059） | — |
| **读内容** | `getEntries() → SessionEntry[]`（L1377）/ `getHeader()`（L1367）/ `getTree()`（L1386） | — |

**→ Sidebar 的历史列表 = `SessionManager.list(cwd)` 直接喂；`loadSession` = `open(path)`。**
原型里那份 8 条 `SESSION_SUMMARIES` 是纯占位，接真数据时整体退场。

---

## 三、字段映射（`SessionInfo` → `SessionSummary`）

Pi（`session-manager.ts:196-208`）：

```ts
export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;              // session_info 条目里的用户自定义显示名
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}
```

我们（`packages/ui/src/mock/types.ts:134-140`）：

| 我们的 `SessionSummary` | 来源 | 结论 |
|---|---|---|
| `id` | `SessionInfo.id` | ✅ 直取 |
| `title` | `name ?? firstMessage` | ⚠️ **需决策**：Pi 的 `name` 是可选的用户显示名；没有时用 `firstMessage`（首条消息）兜底 —— 这正是各家的通行做法，建议就这么定 |
| `updatedAt` | `modified.getTime()` | ✅ 但要**显式转 epoch ms**：Pi 给的是 `Date` 对象，过 HTTP/SSE 会变成 ISO 字符串，core 侧统一转 |
| `messageCount` | `messageCount` | ✅ 直取 |

**→ 四个字段全部有来源，`SessionSummary` / `Session` 不需要改结构。**
`Session.updatedAt`（`types.ts:130`）同理。

⚠️ 注意 `Sidebar.tsx:16` 目前消费 `SESSION_LIST_NOW` 作为「相对时间的冻结锚点」；
接真数据后换成 `Date.now()`，`formatRelativeTime` 本身不动（`pi-integration-points.md:55` 已记）。

---

## 四、★ 真实工作量：加载历史会话需要**另一份映射**

这是本阶段最有价值的发现，原估里没有。

| 路径 | 输入形状 | 现有实现 |
|---|---|---|
| **实时**（发消息后） | Pi **事件** `AgentSessionEvent`（`message_update` / `tool_execution_*` …） | `adapter/reduce.ts` 的 `applyEvent` **已落地** |
| **回放**（打开历史会话） | Pi **`SessionEntry[]`**（`SessionEntry` 定义在 `session-manager.ts:165`：`SessionMessageEntry` / `ThinkingLevelChangeEntry` / `ModelChangeEntry` / `UsageEntry` / `SessionInfoEntry` / `CustomMessageEntry` / `LabelChangeEntry` …） | **没有** |

**→ 两条路径的输入完全不同，不能复用同一个 reducer。** 打开历史会话时要新写一份
`entries → Message[] / Block[]` 的映射（纯函数，可与 `reduce.ts` 并列放在
`packages/core/src/adapter/`）。

要处理的差异（至少）：

1. **entry 是树结构的**（有 `id` / `parentId`，见 `getTree()` L1386、`getBranch()` L1336）——
   Pi 的会话是可分支的（`/tree` / `/fork` / `/clone`）。**我们只渲染单条 active 分支**
   （`getBranch()` 或 `buildContextEntries()` L1352），**还是要在 UI 上暴露分支**？
   这是要拍的板（原型没有分支 UI）。
2. **非消息类 entry 要跳过或改语义**：`ModelChangeEntry` / `ThinkingLevelChangeEntry` /
   `UsageEntry` 不是消息，但 `UsageEntry` 可以喂我们的 `TokenUsage`。
3. **`CustomMessageEntry.display`** 控制是否展示（`session-manager.ts:152-154`），要遵守。
4. `SessionMessageEntry` 的 `message` 形状 ≈ 实时事件的 `message`，**这部分可以复用**。

**建议**：先只做「单条 active 分支 + 消息类 entry」，分支 UI 与 usage 回填留到 S6 之后，
并在文档里显式标注未覆盖（防止下一个人以为已全覆盖）。

---

## 五、两组正式验收入口的去留（本阶段必须裁决）

| 入口 | 用途 | 建议 | 理由 |
|---|---|---|---|
| `?stress=N`（`App.tsx:74-81`） | 验收 2-2：600 条消息下虚拟滚动生效 | **保留** | 它是**纯 UI 压测**，与数据源无关。接真数据后更没法造 600 条真实消息 —— 保留 mock 会话恰恰是唯一可行的压测手段 |
| `?empty=1`（`App.tsx:103-108`） | 验收 5-7：空状态不塌陷 | **保留** | 验收要求**可复现**。真数据下「无会话」虽天然存在，但无法保证每次跑验收时 Pi 侧就是空的 |

**处置方式与 MCP 一致（`pi-survey-plan.md` §五「保留 mock 分支供回归」）**：

- **默认**：`chat-store` 从 `mock/sessions.ts` 的 `INITIAL_SESSION` 切到**真实会话**
  （首次启动 = 新建空会话；`Sidebar` 读 `SessionManager.list()`）
- **保留**：`mock/sessions.ts` 整份不删，`?stress=` / `?empty=` 仍走它 → `accept:m2` 的
  「按 `INITIAL_SESSION` 的 7 条消息逐条断言」继续可用，**断言一行不改**
- `INITIAL_SESSION_TITLE` / `INITIAL_TOKEN_USAGE` 同理随 mock 分支保留

⚠️ **但这不是纯加参数就能解决的**：`chat-store` 的**初始态**要改（现在写死加载 `INITIAL_SESSION`），
且 `Sidebar` 的数据源要换。**这会动到 `accept:m2` 的核心输入**，属于必须显式决策的一类
（见 §六的验收影响）。

---

## 六、影响面

| 项 | 结论 |
|---|---|
| **动我们哪些文件** | `store/chat-store.ts`（初值 + `loadSession` 内部）、`components/shell/Sidebar.tsx`（列表数据源 + 相对时间锚点）、`mock/sessions.ts`（**保留，不删**） |
| **是否碰不动清单** | **不碰 testid**（Sidebar 的条目 testid 不变，只换数据）。`lib/layout.ts` / `tokens.css` / G1–G8 无涉及 |
| **影响哪些验收** | ⚠️ **`accept:m2` 的 2-1**（「按 `INITIAL_SESSION` 的 7 条消息逐条断言」）与 **`accept:m5` 的 5-7**（空会话）依赖 mock。按 §五的处置（保留 mock 分支 + 参数入口）两者都能继续跑。**`probe-r7` 不受影响**（只依赖「同时存在 user 与 assistant 消息」+ 纯 UI 交互） |
| **新增 core 接口** | `listSessions()` / `loadSession(id)` 已在 `AgentTransport` 草案里（`S4-transport-decision.md:63-64`），**签名不用改** |
| **新增 core 内部工作** | ① `SessionInfo → SessionSummary` 转换；② **`SessionEntry[] → Message[]` 映射（§四，新增工作量）** |

---

## 七、本阶段未覆盖 / 待验

1. **未跑真实 dump**：`SessionManager.list()` / `open()` 的实际返回未实测（本阶段只读源码）。
   建议并入 core 骨架 spike 一起验（见 `pi-survey-plan.md` 的 spike 记录）。
2. **分支会话的 UI 归属未定**（§四·1）：Pi 支持 `/tree` / `/fork` / `/clone`，
   原型没有分支 UI。**要拍的板**。
3. **`UsageEntry` 能否回填 `TokenUsage` 四字段**（尤其 `contextWindow` —— S1 §八 已记
   Pi 的 `message.usage` 里没有它）。
4. **会话文件损坏/旧版本**的处理：`readSessionHeaderForDiscovery` 是 best-effort（L1747 注释），
   失败时 `list()` 会跳过该文件 —— UI 要不要提示？未定。
5. **删除会话**：`session-selector.ts` 里有 `onDeleteSession`（L842），说明 Pi 支持；
   我们的 Sidebar 目前没有删除入口。**要拍的板**（原型没有该交互）。

**本阶段明确不做**：不改 `packages/ui` 代码；不写 core。
