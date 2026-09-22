# Pi 作为 Agent Core 的可行性调研

> 调研日期：2026-09-21
> 调研对象：https://github.com/earendil-works/pi （已 clone 至 `./pi`）
> 结论：**可行，契合度高**，但有若干能力需自建，见第六、七节。

---

## 一、背景

本项目要落地的设计稿是「桌面 Agent · 跨平台设计系统」（Ardot 画布，fileId `728255468414716`）：通用任务自动化桌面 Agent，覆盖 macOS / Windows / Linux 三端，深浅双模式，共 8 屏，已迭代 12 轮。

核心界面形态：左侧边栏（历史会话 / 工作目录）+ 中间对话流（执行计划、终端步骤、授权卡片）+ 右侧预览区（预览效果 / 预览源码双 Tab）。

本轮调研要解决的是：Agent 运行时（Agent Core）能否直接用 Pi 这个开源项目，而不是自研。

---

## 二、整体技术架构建议

### 2.1 分层

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | **Electron** | Node 生态内嵌，MCP SDK / node-pty 等直接可用 |
| 架构 | **严格 C/S 分层** | UI 层禁止 import 任何 `node:*`，为 Web 版预留 |
| 前端 | React 19 + TypeScript + Vite 7 | |
| 样式 | Tailwind CSS v4 + CSS 变量令牌 | 对应 Figma `Theme` 变量集 |
| 组件 | shadcn/ui（Radix）等 headless | 不用 AntD / MUI，避免风格冲突 |
| 状态 | Zustand + TanStack Query | |
| 长列表 | @tanstack/react-virtual | 会话流消息量大 |
| 渲染 | react-markdown + Shiki + xterm.js | Shiki 天然支持深浅双主题 |
| 持久化 | better-sqlite3 + Drizzle | |

### 2.2 建议的 monorepo（pnpm workspace）

```
packages/
  core/       Agent 运行时（Node 环境）：Pi 会话、工具、终端、文件
  ui/         React 前端（纯浏览器环境，禁止 import node:*）
  desktop/    Electron 壳
  web/        Web server（后期）：把 core 包成 HTTP + SSE
```

### 2.3 为什么必须做成 C/S

后期若要做 Web 版，UI 层绝不能碰任何 Node API（`fs`、`child_process`、`node-pty`）。UI 只通过一个统一的 transport 接口与运行时通信，至于底层是本机进程还是远端服务器，UI 不需要知道。

统一 transport 最省事的办法：桌面版也在 `127.0.0.1` 起本地 HTTP + SSE server，前端代码与 Web 版完全一致（需处理端口占用与本地 token 校验）。

Electron 方案下更简单的做法是走主进程 IPC + `contextBridge`，见第四节；Web 版再换成 SSE。

### 2.4 壳层选型：Electron vs Tauri 2

| | Electron | Tauri 2 |
|---|---|---|
| 安装包体积 | 150MB+ | 10~15MB |
| 常驻内存 | 200~400MB | 60~120MB |
| 运行时 | 内置 Node + Chromium | Rust + 系统 WebView |
| Node 生态 | 直接可用 | 需 sidecar 打包 Node 二进制 |
| 三端一致性 | 高（自带 Chromium） | 中（Linux 依赖 WebKit2GTK） |
| 上手成本 | 低 | 中高（要写 Rust） |
| 同类产品 | Cursor、Claude Desktop、WorkBuddy | 多为轻量工具 |

选 Electron 的理由：Agent 类产品重度依赖 Node 生态，Tauri 要吃这些就得把 Node 当 sidecar 打包，省下的体积又还回去了，还多一层进程通信复杂度。

若走 C/S 架构，Tauri 的劣势会削弱一半（Node 全关在 core 里，Tauri 只负责拉起进程 + 提供 WebView），但 Node 二进制仍要打包，体积约为 10MB → 60~100MB。

---

## 三、Pi 项目概览

- **仓库**：`earendil-works/pi`（作者 Mario Zechner / badlogic），前身为 `pi-mono`
- **许可证**：MIT
- **版本**：0.86.1（pre-1.0），npm 发布极频繁
- **运行时要求**：Node `>=22.19.0`
- **官网**：pi.dev

### 3.1 包结构（npm workspaces）

| 包 | 说明 |
|---|---|
| `@earendil-works/pi-coding-agent` | 交互式 coding agent CLI **＋ SDK（本项目应依赖这个）** |
| `@earendil-works/pi-agent-core` | Agent 运行时，工具调用与状态管理（裸循环，工具需自己写） |
| `@earendil-works/pi-ai` | 统一多供应商 LLM API（OpenAI / Anthropic / Google …） |
| `@earendil-works/chord` | 应用组合运行时：服务、复制状态、RPC、插件 |
| `@earendil-works/pi-tui` | 终端 UI 库，含 win32 / darwin / linux native 模块 |
| `@earendil-works/pi-durable` | 持久化会话 / 任务 / 文档运行时 |
| `@earendil-works/pi-protocol` | **experimental**：路由信封、CBOR 编码、字节流分帧 |
| `@earendil-works/pi-client` | **experimental**：传输无关客户端 |
| `@earendil-works/pi-server` | **experimental**：本地 server |
| `@earendil-works/pi-session-backend-sqlite-node` | SQLite 会话后端（`node:sqlite`） |

### 3.2 关键判断：依赖 `pi-coding-agent`，不是 `pi-agent-core`

`pi-agent-core` 只有 Agent 循环，工具、会话、认证、设置都要自己写。而 `pi-coding-agent` 的 `createAgentSession()` 已经自带：

- 内置工具 `read` / `bash` / `edit` / `write`
- `SessionManager` 会话持久化（JSONL 树结构）
- `ModelRuntime`（OAuth + API key 管理）
- `SettingsManager`
- 扩展（extension）、技能（skills）、提示模板系统
- 自动压缩、自动重试

---

## 四、集成方案

### 4.1 进程架构

```
渲染进程 (React UI)  ←→  preload (contextBridge)  ←→  主进程 (Pi AgentSession)
   展示事件流              类型化 API                   createAgentSession
   授权卡片                禁止暴露 node:*              + ipcMain 事件转发
```

**电子集成走主进程直接 import，不要 spawn 子进程跑 RPC。** `packages/coding-agent/docs/rpc.md` 开头明确建议：

> If you're building a Node.js application, consider using `AgentSession` directly from `@earendil-works/pi-coding-agent` instead of spawning a subprocess.

### 4.2 SDK 基本用法

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  modelRuntime,
  cwd: process.cwd(),
  tools: ["read", "bash", "edit", "write"],
  customTools: [myTool],
  sessionManager: SessionManager.inMemory(),
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    // 流式文本
  }
});

await session.prompt("Hello");
```

### 4.3 Electron 版本兼容性

Pi 要求 Node `>=22.19.0`。Electron 内置 Node 版本：

- Electron 43.3.0 → Node **24.18.1**
- Electron 42.11.1 → Node **24.19.0**

均满足要求，无需额外处理。

### 4.4 RPC 模式（备选 / Web 版参考）

若需要子进程或跨进程通信，Pi 提供 `--mode rpc`：JSONL over stdin/stdout，命令下行、事件上行。该模式也完整定义了 Extension UI 子协议，是 Web 版对接的现成参考。

注意 framing：只能按 `\n` 切分，Node 的 `readline` **不符合协议要求**（它会额外切分 `U+2028` / `U+2029`）。

---

## 五、设计稿 UI 元素 ↔ Pi API 映射

契合度很高，几乎每个 UI 元素都有对应能力。

| 设计稿元素 | Pi 侧能力 | 备注 |
|---|---|---|
| 消息流流式渲染 | `message_update` → `text_delta` / `thinking_delta` / `toolcall_delta` | `message_end.message` 为权威结果 |
| 终端步骤卡片 | `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | `_update` 携带累积 partialResult，可直接替换显示 |
| Token 信息组（输入 / 输出 / 消耗 / 上下文） | `get_session_stats` → `tokens.input` / `tokens.output` / `tokens.total` / `contextUsage.tokens` / `contextUsage.contextWindow` / `contextUsage.percent` | 与设计稿四段几乎一一对应 |
| 思考强度芯片（Low / High / Max） | `set_thinking_level`：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` | `xhigh` / `max` 仅在模型支持时暴露 |
| 模型芯片 | `get_available_models` / `set_model` / `cycle_model` | |
| 技能芯片 | `get_commands` | 返回 extension / prompt / skill 三类 |
| **授权卡片** | Extension UI Protocol：`select` / `confirm` 请求-响应 | 官方示例即 *"Allow dangerous command?"* → `["Allow","Block"]` |
| 历史会话 | `SessionManager` + `get_tree` / `get_entries` / `switch_session` | `get_entries` 支持游标增量（`since`） |
| 会话分叉 | `fork` / `clone` / `get_fork_messages` | |
| 停止按钮 | `abort` | |
| 中断指令 | `steer`（当前 turn 的工具执行完后注入） | |
| 追加指令 | `follow_up`（agent 停止后注入） | |
| 上下文压缩 | `compact` / `set_auto_compaction` / `compaction_start` / `compaction_end` | |
| 侧边栏工作目录 | `cwd` 参数 | |

### 5.1 授权卡片的具体接法

Pi 的 Extension UI Protocol 提供了完整机制。Agent 侧调用 `ctx.ui.select()`，客户端收到：

```json
{ "type": "extension_ui_request", "id": "uuid-1", "method": "select",
  "title": "Allow dangerous command?", "options": ["Allow", "Block"], "timeout": 10000 }
```

客户端回：

```json
{ "type": "extension_ui_response", "id": "uuid-1", "value": "Allow" }
```

在 Electron 里就是：主进程收到请求 → IPC 推给渲染进程 → React 弹出授权卡片 → 用户点击 → 回传响应。

此外 `pi.on("tool_call", ...)` 返回 `{ block: true, reason }` 可直接阻断工具执行，是另一种更简单的拦截点。

### 5.2 事件类型全集

```
agent_start / agent_end / agent_settled
turn_start / turn_end
message_start / message_update / message_end
tool_execution_start / tool_execution_update / tool_execution_end
bash_execution_update
queue_update
compaction_start / compaction_end
auto_retry_start / auto_retry_end
summarization_retry_scheduled / _attempt_start / _finished
extension_error
```

---

## 六、Pi 未提供、需自建的能力

`packages/coding-agent/docs/usage.md` 原话：

> It intentionally does not include built-in **MCP**, **sub-agents**, **permission popups**, **plan mode**, **to-dos**, or **background bash**. You can build or install those workflows as extensions or packages.

逐项对照本项目设计稿：

| 缺失能力 | 影响 | 自建方案 |
|---|---|---|
| **MCP** | 设计稿工具条有「MCP」芯片 | 用 extension + `@modelcontextprotocol/sdk`，把 MCP 工具转成 `AgentTool` 注册 |
| 授权弹窗（permission popups） | 设计稿有授权卡片 | 走 Extension UI Protocol（`select` / `confirm`），机制已备好，只需前端实现 |
| plan mode（执行计划） | 设计稿有执行计划展示 | 用 extension 或自定义消息类型实现 |
| to-dos | — | 同上 |
| background bash | — | 同上 |

**另需注意**：Pi 本身没有内置权限系统，默认以启动用户与进程的权限运行。若要强隔离，需容器化（官方提供三种模式：Gondolin extension 微 VM、plain Docker、OpenShell）。

---

## 七、风险清单

| 风险 | 等级 | 说明与应对 |
|---|---|---|
| native 依赖打包 | **高** | `pi-coding-agent` 依赖 `pi-tui`（含 win32 / darwin / linux 三端 native 模块）与 `photon-node` 的 wasm。Electron 打 asar 时需验证能否正常加载。**这是唯一可能推翻方案的点，建议优先验证** |
| pre-1.0，API 不稳定 | 中 | 当前 0.86.1，npm 每几天一版。建议锁定版本 |
| `protocol` / `client` / `server` 为 experimental | 中 | 三包自述无兼容保证。主进程直连方案不依赖它们，可绕开 |
| 内部重构未完成 | 低 | `docs/mobile-handoff` 自述 7 个单元中 3 个有可用代码、4 个仅规格；`04-tool-output` / `05-assistant-output` 未实现；typecheck 基线约 788 个已有错误。属内部计划，不直接影响 SDK 使用 |
| Web 版能力不对等 | 中 | 文件系统与真实终端是桌面独有能力。Web 版要么功能裁剪，要么配云端沙箱（成本高）。此决策会反向影响 core 接口设计，需尽早定 |
| ai 包构建需联网 | 低 | `packages/ai` 构建时会拉取 provider model data，离线环境需 `build:offline` |

---

## 八、落地步骤建议

1. **验证 native 依赖（优先）**：在 `./pi` 执行 `npm install --ignore-scripts && npm run build`，然后建一个最小 Electron 骨架，跑通一次真实 Pi 会话，确认 native 模块与 wasm 能正常加载。
2. **封装 core**：把 `createAgentSession` 的事件流适配成 UI 需要的 transport 接口（桌面走 IPC，后期 Web 走 SSE）。
3. **做 UI 原型**：令牌层 → 三栏布局（含左右收起）→ 01 屏会话工作台 → 03/04/05 → 06 窗口壳。
4. **补自建能力**：MCP extension、授权卡片、执行计划。

### 本阶段已确认范围

**纯 UI 原型**：先用 mock 数据做 8 屏界面，不接后端、不接 LLM。Pi 接入留到设计定稿后。

---

## 附录：关键文件索引

本地 clone 路径 `./pi`：

| 文件 | 用途 |
|---|---|
| `README.md` | 项目总览、包列表、容器化说明 |
| `packages/agent/README.md` | pi-agent-core 的 Agent 事件模型、工具定义、钩子 |
| `packages/coding-agent/README.md` | coding-agent 功能列表与限制 |
| `packages/coding-agent/docs/rpc.md` | **最重要**：RPC 协议、事件类型全集、Extension UI Protocol |
| `packages/coding-agent/docs/usage.md` | 明确列出不内置的能力（MCP、plan mode 等） |
| `packages/coding-agent/docs/sdk.md` | SDK 用法 |
| `packages/coding-agent/examples/sdk/01-minimal.ts` ~ `13-session-runtime.ts` | 13 个渐进式 SDK 示例 |
| `packages/coding-agent/examples/sdk/README.md` | SDK 选项速查表 |
| `packages/protocol/README.md`、`packages/client/README.md`、`packages/server/README.md` | experimental 的 C/S 协议层 |
| `packages/agent/docs/mobile-handoff/README.md` | 内部重构计划与现状（含已知 bug） |

当前状态：已 clone，**未执行 `npm install`，无 `dist`**。
