# S4 · 传输层选型（决策）

> 日期：2026-09-22　修订：2026-09-23（第八节待定项 1 结项 + 第四节补 baseUrl 术语警告）　阶段：Pi 梳理 S4（`pi-survey-plan.md`）
> 依据：`protocol/README.md`、`client/README.md`、`server/README.md`、`coding-agent/docs/rpc.md`、
> 调研文档 `docs/pi-agent-core-调研.md` 2.3 节、POC 实测（`.plan/poc-pi-2026-09-22.md`）
> 前置：S0（`survey/S0-our-contract.md`）、S1（`survey/S1-event-mapping.md`）

---

## 一、结论（先给）

**选 B：独立 core 进程 + 本地 HTTP(POST) + SSE，UI 只认一层 `AgentTransport` 接口。**

| | 方案 |
|---|---|
| **采用** | **`packages/core` 起本地 HTTP + SSE；UI 通过 `AgentTransport` 接口调用，不 import 任何 `node:*`** |
| 不选 | A 同进程直连 + Electron IPC（Web 版要另做桥）／C `pi --mode rpc` over stdio ／D `protocol+client+server`（Chord） |

桌面版与将来的 Web 版**共用同一套 UI 代码与同一个 transport 实现**，只换 baseUrl 与鉴权方式。

---

## 二、候选对比

| 判据 | A 同进程直连 + IPC | **B 独立进程 + HTTP/SSE** | C Pi RPC over stdio | D protocol/client/server |
|---|---|---|---|---|
| UI 是否 import `node:*` | 否（走 contextBridge） | **否** | 否 | 否 |
| **Web 版能否复用同一套 UI** | 否，要另写桥 | **是，完全一致** | 部分（需 WebSocket 桥） | 是，但要写 Chord bindings |
| 调试直观度 | 差（要进主进程看） | **好（浏览器 Network 能看 SSE）** | 差 | 差 |
| 与 Pi experimental API 绑定 | 否 | 否 | 是（RPC 协议） | **是（Chord + 无兼容保证）** |
| 打包复杂度 | 低 | 中（端口 + token + 子进程生命周期） | 中 | 高 |
| 崩溃隔离 | 差（同进程，UI 崩=会话断） | **好（core 独立）** | 好 | 好 |
| asar 打包风险 | 在主进程内 | 隔离在 core（unpack 范围小） | 同 B | 同 B |
| POC 已验证 | ✅ Electron 主进程跑通 | ✅ Node 进程跑通 | 未验 | 未验 |

---

## 三、选 B 的四条理由

1. **Web 版零重写。** 调研文档 2.3 的核心诉求就是"UI 层绝不能碰 Node API，至于底层是本机进程还是远端服务器，
   UI 不需要知道"。B 天然满足：桌面是 `127.0.0.1`，Web 是远端域名，**同一份前端代码**。
2. **现有验收体系能直接延续。** `accept:m1~m5` 与 `probe-r7` 是 **CDP 驱动真实浏览器**的。
   若走 A（Electron IPC），验收必须套 Electron 壳才能跑通真实数据；走 B，浏览器直接连本地 core，
   **验收脚本不用改架构就能继续用**。（A 路线下这条会变成持续成本。）
3. **崩溃隔离与打包风险收敛。** Pi 的 native/wasm 全关在 core 进程里。asar 打包若出问题，
   unpack 范围只限 core，不污染 UI 包。
4. **不与 experimental API 绑定。** D 方案的 `protocol` / `client` / `server` 自述无兼容保证，
   且要求应用层自己实现 `SessionDirectory` / `SessionManagement` 与 Chord service bindings
   （`server/README.md` L5-13）——**投入大且会随 Pi 内部重构漂移**。

### 不选 A 的唯一遗憾

A 前期最省事（POC 就是这么跑的）。但它的省事是**把成本推到后面**：Web 版要另做一套桥，
且验收体系要迁进 Electron。**如果将来明确不做 Web 版，A 值得重新考虑**——这是一个显式 trade-off，不是绝对优劣。

---

## 四、`AgentTransport` 接口草案（UI 侧只认这个）

```ts
/** UI 唯一依赖的运行时接口。桌面 = 本地 HTTP+SSE，Web = 远端同源接口。 */
export interface AgentTransport {
  // 会话
  listSessions(): Promise<SessionSummary[]>;
  loadSession(id: string): Promise<Session>;
  sendMessage(text: string): Promise<void>;
  abort(): Promise<void>;
  resolveApproval(requestId: string, choice: string): Promise<void>;

  // 模型（对齐 pi-integration-points 第七节：配置由 Pi 侧持有）
  listModels(): Promise<ModelOption[]>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;

  // 事件流（S1 已列出的事件子集）
  subscribe(listener: (event: AgentEvent) => void): () => void;
}
```

要点：

- 方法名对齐 `chat-store` 的既有语义（`sendMessage` / `abortStream` / `resolveApproval` / `loadSession`），
  将来替换时 store 的外层行为不变
- `subscribe` 返回取消函数
- **★ 术语警告：本接口涉及的 `baseUrl` 是「UI ↔ core」的地址，不是「core ↔ 模型」的地址。**
  链路里有两个同名但无关的概念，混说会误导（2026-09-23 实踩）：

  | | ① AgentTransport 地址 | ② 模型端点地址 |
  |---|---|---|
  | 哪一段 | 浏览器 UI → core | core 内的 Pi 内核 → 模型厂商 |
  | 谁定义 | **我们**（就是本接口） | **Pi**（`~/.pi/agent/models.json`） |
  | 典型值 | `http://127.0.0.1:<port>` | `https://ark.cn-beijing.volces.com/api/coding/v3` |
  | UI 是否感知 | 是（transport 实现里） | **否**——UI 从不直接请求模型 |

  因此第一节「只换 baseUrl」、第七节「只换 baseUrl」均指 **①**。
  佐证：`packages/ui/src` 全量搜 `baseUrl|endpoint|http://|https://` 只命中
  `mock/sessions.ts:118` 一个 mock 文案链接 → **UI 侧目前零 baseUrl 概念**。
  另注：形态定为「本地服务 + 浏览器」后，core 可同时 serve 前端静态资源，
  此时 ① 用相对路径 `""` 即可，**用户零配置**（见第八节末）。

### ★ 事件协议用我们自己的类型，不 import Pi 包

初稿写的是"transport 透传 Pi 事件、UI 侧做适配"，**自相矛盾**（UI 就得认识 Pi 的事件形状，且要依赖
Node 包）。修正为：

- **`AgentEvent` 是我们自己定义的类型**（可与 Block 同构），core 与 UI 共享，**两边都不 import Pi 包**
- **core 负责 Pi 事件 → Block 的适配**（即 S1 裁定的那个 reducer 落在 core 侧）
- **UI 只做 state 合并 + 渲染**，完全不认识 Pi

这样做的三个好处：

1. UI 不依赖 `pi-coding-agent`（Node 包），打包干净
2. **现有 mock 数据与 core 输出同构** → `accept:m1~m5` 不用 core 也能继续跑 mock 回归，
   正好支撑「保留 mock 分支供回归」那条决策
3. Pi 升级导致事件形状变化时，**改动被关在 core 里**，UI 不受影响

代价：Block 六型要从 `packages/ui/src/mock/types.ts` 提升为**共享契约**
（UI 以 type-only 方式引用，不引实现代码，不违反"UI 不 import `node:*`"）。

---

## 五、`packages/core` 的职责边界

**做**：

- 持有 Pi 会话
- **跑 Pi 事件 → Block 的适配层**（S1 裁定的 reducer，用 dump fixture 回放做单测）
- 经 SSE 下发 Block 增量，暴露上面那几个 POST 端点
- 管进程生命周期与 token

**不做**：不碰渲染 / UI 结构编排；不把 Pi 的事件形状泄漏给 UI。

工程形态：桌面版由 Electron 主进程 **fork 一个 Node 子进程**跑 core（不必打成独立 exe），
或直接用 `utilityProcess`。Web 版把同样的 core 包成远端服务。

---

## 六、必须设计好的四个点（B 的成本都在这）

1. **端口**：随机端口 + 端口文件（或固定端口失败重试），避免占用冲突。
2. **本地 token**：启动时生成一次性随机 token，通过环境变量/临时文件交给 UI；
   所有请求带 `Authorization: Bearer <token>`，**拒绝跨来源调用**（否则本机任意网页都能驱动你的 Agent）。
3. **进程生命周期**：core 随 app 启停；core 崩溃要能被主进程感知并重启，且 UI 要能显示"运行时断开"。
4. **SSE 与事件量**：S1 实测**一次会话 286 个 `message_update`**。SSE 每条都发会打满连接 ——
   **core 侧先做批处理**（rAF 级 ~16-33ms 合并，同一 Block 只发最新快照）再下发；
   终态信号（对应 Pi 的 `agent_settled`）**不参与合并，必须单独下发**，否则 UI 会一直停在 streaming 态。

---

## 七、对现有代码的影响

- **`packages/ui` 现在零改动**（梳理期不动代码）
- 将来替换时：`chat-store` 的**方法名与外层语义不变**，内部从 `mock/stream.ts` 换成
  `transport.sendMessage()` + `transport.subscribe()`；适配层 reducer（S1 裁定）插在两者之间
- `packages/ui` 新增 `services/agent-transport.ts` 之类的实现，**仍不 import 任何 `node:*`**
- 验收脚本：`accept:m1~m5` / `probe-r7` 的 testid 契约不受影响；
  但 **mock 会话去留仍要单独决策**（`accept:m2` 按 `INITIAL_SESSION` 的 7 条消息断言 —— 见 S2）

---

## 八、待定与风险

1. ~~**是否做 Web 版未最终确认**~~ —— **已裁决（2026-09-23）**：
   **做，形态 = 本地起一个服务 + 浏览器访问，不涉及云端部署。**
   默认只绑 `127.0.0.1`（仅本机可访问）；`0.0.0.0`（内网可访问）作为**显式配置开关**另议。
   因此**方案 B 保持不动**——用户选的正是第四节那句「桌面是 `127.0.0.1`」那一支，
   而非「Web 是远端域名」那一支。连带结论：
   - **Electron 降级为可选外壳**（是否保留外壳暂缓裁决，它不阻塞 core / S2 / S3；
     无论哪种形态 core 都是普通 Node 进程）
   - **POC 遗留的 asar 打包风险不再位于关键路径上**（见 `poc-pi-2026-09-22.md` §六·1 的修订注）
   - 第六节的四条设计点**基本原样成立**，不需要 OAuth / CORS 白名单 / 多租户 / 计费
   - **但新增一条第六节漏掉的**：因为客户端是浏览器，必须**校验 `Host` 请求头防 DNS rebinding**，
     且第六节第 2 条的本地 token 从「上云才要」变成「浏览器这层攻击面才要」，**不能删**（见 §六·5）
2. **Electron 下 SSE 的代理/拦截**：需实测渲染进程能否直连 `127.0.0.1` 的 SSE（理论可以，但未验）。
   **注（2026-09-23）**：形态定为「本地服务 + 浏览器」后，这条降级为**非问题**——
   浏览器直连本机无中间代理，不存在 Electron 的代理/拦截环节；仅当将来真的启用 Electron 外壳时才需重看。
3. **Windows 下 Pi 的 bash 工具不可用**（S1 实测 `No bash shell found`，需配 `shellPath`）
   —— 这属于 core 的启动配置，要在 core 里显式处理，否则终端卡片永远报错。
4. **token 与端口文件的安全存放**：不要写进仓库或日志。

### 5.（2026-09-23 新增）本机 HTTP 服务的两条强制防护

形态定为「本地服务 + 浏览器」后，攻击面从「同进程 IPC」变成「一个真的 HTTP 端口」，故必须：

1. **本地 token 必留**：浏览器里**任意网页**都能向 `127.0.0.1` 发请求，
   不是「上云才需要鉴权」——这正是本节第 2 条原始动机（「否则本机任意网页都能驱动你的 Agent」）的兑现。
2. **校验 `Host` 请求头**：防 **DNS rebinding** —— 恶意域名解析到 `127.0.0.1` 即可绕过同源策略
   直接调本机 API。这是所有本机 HTTP 服务的标准动作，第六节初稿遗漏。

**建议**：core 同时 serve 前端静态资源 → 浏览器打开即同源页面，transport 的 `baseUrl` 用相对路径
`""`，**用户零配置**，并顺带免掉 CORS。仅当前端独立部署（vite dev / 独立静态站）时才需要
「端口文件 + 启动时注入地址」。

---

## 九、本阶段未覆盖

- core 的具体实现（HTTP 框架选型、SSE 心跳与重连、批处理阈值）—— 属实现期设计
- 会话持久化与存储位置（S2）
- 授权闭环在 transport 上怎么传（`extension_ui_request` 的双向应答）（S3）
