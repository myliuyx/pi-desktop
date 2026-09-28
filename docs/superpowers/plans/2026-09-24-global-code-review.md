# pi-desktop 全局 Code Review 执行方案

> **For agentic workers:** 执行时按 review packet 独立取上下文；每包只输出经证据筛选的候选问题和结构化摘要。发现问题后不要顺手改代码，修复必须作为后续独立阶段执行。

**Goal:** 对 `pi-desktop` 当前版本做一次覆盖正确性、安全与隐私、架构与可维护性、产品体验、性能、测试与发布能力的全面体检，并产出可复现、可分级、可分批修复的审查报告。

**Architecture:** 采用“风险域优先 + 关键场景穿线 + 全文件覆盖矩阵”的混合审查。core 与 UI 先通过契约和事件流建立系统地图，再分别审查高风险子系统，最后用 mock/live/CDP 场景验证跨层问题；所有候选项统一进入 finding ledger，经复现、分级、去重后再进入最终报告。

**Tech Stack:** Node.js 22.19+、TypeScript 5.7、React 19、Vite 6、Zustand 5、Zod 间接依赖的 Pi SDK（`@earendil-works/pi-coding-agent`）、HTTP + SSE、CDP 验收脚本。

**Spec:** 本文档的“范围与成功标准”“审查契约”“严重度与证据规则”即本轮 review 的需求基线。

## Global Constraints

- 本阶段只做 review，不修改生产代码、测试、配置、依赖或用户配置。
- 当前基线为 `main` / `10c0ec7`；执行时重新记录 `HEAD`、分支和工作区状态，不假设该提交不变。
- 历史 `.plan/2026-09-24-fix-review-plan.md` 只作为线索库；其中旧问题必须基于当前代码重新确认，禁止直接抄入新报告。
- 任何发现都必须包含具体场景、位置、影响和验证证据；“看起来不安全”“可能有问题”不能作为 finding。
- 不在报告、命令输出或日志中复制真实 API key、Bearer token、模型请求头或完整 provider 凭证。
- 不调用真实模型、不产生 API 费用、不修改 `~/.pi/agent`，除非用户另行明确授权。
- 浏览器验收在隔离工作区运行，避免脚本改写仓库内 tracked evidence 文件。
- `node_modules/`、构建产物、运行日志和历史 evidence JSON 默认不逐行审查；仅在它们影响运行时、测试可信度或安全边界时纳入。
- Pi 上游源码/类型声明只做针对性契约核验，不开展上游全仓 review。
- 审查顺序按风险动态调整，但最终必须让每个生产源文件在覆盖矩阵中有明确状态。

---

## 1. 推荐方法与备选方法

### 方案 A：按目录逐文件审查

- 优点：直观，覆盖感强。
- 缺点：容易把时间花在 mock、样式和低风险展示代码上；跨 core/UI 的状态问题需要最后才暴露。
- 适用：文件量很小，或用户只要求逐文件 lint 式检查。

### 方案 B：按架构/风险域审查

- 优点：优先覆盖安全、凭证、授权、会话一致性和恢复能力，产出可直接转成修复批次。
- 缺点：若不维护覆盖矩阵，可能漏掉低风险文件中的局部缺陷。
- 适用：以交付风险和整改路线为目标的全面体检。

### 方案 C：按用户场景做黑盒穿线

- 优点：能直接验证“用户是否能完成配置、对话、授权、会话恢复、技能开关”等完整体验。
- 缺点：难以发现未触发的分支、配置兼容问题、供应链和维护性风险。
- 适用：产品验收与体验走查。

### 采用方案：B 为主，C 为穿线，覆盖矩阵兜底

1. 先画清 core/UI 契约、状态所有权和关键数据流。
2. 优先审查 P0/P1 风险域。
3. 用 mock/live/CDP 场景验证跨层行为。
4. 最后按覆盖矩阵扫完剩余文件，确保“全面”不是口号。
5. 所有候选项统一复现、去重和分级，避免各包各自下结论。

---

## 2. 项目边界与当前规模

### 纳入审查

- `packages/core/src/**/*.ts`：进程入口、HTTP/SSE、Pi session、授权/信任、会话持久化、Provider/模型、工具和资源。
- `packages/ui/src/**/*.{ts,tsx,css}`：路由、transport、adapter/reducer、Zustand store、页面、组件、mock 和样式。
- `packages/{core,ui}/package.json`、锁文件、TypeScript/Vite 配置。
- `packages/{core,ui}/scripts/**`：测试是否真正测到目标、断言是否可能假绿、脚本是否污染环境。
- `README.md`、`docs/pi-agent-core-调研.md`、`packages/ui/TESTING.md`：实现、文档与预期是否漂移。
- 最近 30–50 次提交及高频变更文件：作为风险排序信号，不把提交历史本身当缺陷证据。

### 默认排除

- `packages/*/node_modules/**`。
- `packages/*/dist/**`、`*.tsbuildinfo`、运行日志、截图、临时探针产物。
- tracked evidence JSON 的业务内容；只检查其生成机制、可重复性和是否可能造成“证据漂移”。
- `.plan/` 中已执行完的详细修复步骤；只提取未闭环线索。
- 外部 Pi 仓库的全量代码。

### 初始热点（需在 review 中验证，不预判为缺陷）

- `packages/core/src/providers.ts`：约 943 行，文件 I/O、JSONC、凭证、SSRF/出网请求、模型刷新等职责集中。
- `packages/core/src/session.ts`：约 629 行，初始化、信任门、Pi session 重建、usage 和 runtime facade 高度耦合。
- `packages/core/src/server.ts`：约 521 行，认证、Host、路由、请求体、静态托管和 SSE 同处。
- `packages/core/src/sessions.ts`、`contract.ts`：会话映射和跨包契约的关键边界。
- `packages/ui/src/store/chat-store.ts`：约 421 行，mock/live 双模式、异步副作用和消息状态集中。
- `packages/ui/src/screens/settings/ModelProvidersTab.tsx`、`services/agent-transport.ts`：设置交互和长连接恢复热点。
- `packages/ui/src/adapter/reduce.ts`：事件顺序、幂等性和历史回放的核心。

生产 TS/TSX/CSS 初始合计约 1.58 万行、90 个文件（基线 `10c0ec7`；执行时按实际 `HEAD` 重新统计）。规模标尺：10 个 review packet、5 个浏览器验收 + 1 个 live smoke。该规模允许分片深审，不需要用抽样代替全局 review；数字仅作进度标定，不改变审查范围。

---

## 3. 审查契约与成功标准

### 必须回答的问题

1. 未授权请求能否读取/修改会话、模型配置或触发 Agent 行为？
2. Host、静态 token 注入、跨源、内网绑定和 CORS 组合是否存在绕过或信息泄漏？
3. Provider 配置、API key、`!command`、`$ENV`、自定义 header 和上游 URL 是否可能造成命令执行、SSRF、泄密或持久化损坏？
4. 授权请求是否可能丢失、重复、错绑、超时后仍生效，或在项目未信任时执行工具？
5. 启动、加载、续接、重建、切换模型、abort、SSE 重连期间，活动 session 和 UI 状态是否可能分叉？
6. SSE 分片、乱序、重复、终态缺失和重连丢事件时，reducer/store 是否会卡死、重复消息或错误显示 token？
7. mock 与 live 是否存在相同交互但不同状态/错误语义？
8. 页面是否覆盖 loading、empty、error、stale、disabled、timeout、permission denied 和 destructive confirmation？
9. 大消息量、流式输出、Markdown/Shiki、频繁重连是否导致明显卡顿或资源泄漏？
10. 现有 typecheck/断言/CDP/live 脚本是否存在假绿、污染环境、未执行路径或无法重复的问题？
11. 文档、配置、依赖和实际运行方式是否一致；当前项目距离 README 描述的“桌面版”还有哪些发布阻断项？
12. 每个生产源文件是否已经被审查、明确排除，或转交其他 packet？

### 完成标准

- 所有生产源文件进入覆盖矩阵，没有“未说明的漏项”；矩阵中每个文件有唯一责任 packet（`server.ts`、`session.ts`、`chat-store.ts` 等被多包引用的文件指定主审包，其余包只读引用并注明来源）。
- 架构/契约/状态流有可复核的映射。
- P0/P1 候选均有复现步骤或足够直接的代码证据。
- 每个最终 finding 都有：严重度、置信度、位置、场景、影响、建议和回归测试方向。
- 基线命令的 PASS/FAIL/未执行及环境原因均有记录。
- 历史问题、重复问题和误报已去重。
- 最终报告明确“已确认问题”和“尚未覆盖/受限项”，不把未执行写成通过。
- review 阶段不产生源码 diff；若命令产生非 ignored 文件，在隔离工作区清理，不修改用户工作区。

---

## 4. Review Packets 与文件分工

每个 packet 有独立输入、问题清单和输出。优先使用只读子代理执行 packet；主会话只接收结构化摘要。若当前 harness 无法以 `pi-desktop` 为根创建隔离工作树，则按 packet 在主会话顺序执行，仍使用相同的上下文边界和落盘规则。

### RP-00：基线、仓库卫生与验证能力

**主要文件：**
- `packages/core/package.json`、`packages/ui/package.json`
- 两个锁文件、TS/Vite 配置
- `packages/ui/TESTING.md`
- 根 `.gitignore`、README

**检查：**
- Node/npm 版本约束、脚本入口、依赖安装与锁文件一致性。
- typecheck/build/断言/CDP/live 的依赖关系及环境前置条件。
- 测试是否写入 tracked 文件、用户配置或真实网络。
- CI、lint、format、coverage、依赖审计机制是否存在（若无，记录工程能力缺口，不直接等同业务 bug）。
- ignored/tracked 运行产物和 evidence 是否会污染仓库。

**输出：** 基线结果表、测试可信度清单、仓库卫生候选问题。

### RP-01：系统架构、契约与状态所有权

**主要文件：**
- `packages/core/src/contract.ts`
- `packages/ui/src/mock/types.ts`
- `packages/ui/src/mock/provider-contract.ts`
- `packages/ui/src/adapter/pi-events.ts`（18 行 type-only re-export shim，rg 级核对，不占深度阅读预算）
- `packages/ui/src/services/agent-transport.ts`
- `packages/core/src/server.ts`
- `packages/core/src/session.ts`
- `packages/ui/src/store/chat-store.ts`、`ui-store.ts`

**检查：**
- HTTP 路由、请求/响应、SSE 事件和 mock 类型的对应关系。
- 单一真相来源与重复契约（type-only re-export、镜像类型、字符串/联合类型漂移）。
- core session、Pi AgentSession、UI draft、Zustand store 的状态所有权。
- 初始化顺序、ready 门、mock/live gate、页面参数对启动状态的影响。
- 模块依赖方向、循环依赖风险、跨包越界引用。
- `pi-events.ts` 从 `../../../core/src/contract.ts` 跨包源码 re-export 类型：确认仅 type-only（编译期擦除、UI 产物不依赖 core 源码路径），并核对 `check:contract` 断言是否真正覆盖该漂移点。

**输出：** 系统上下文图、端点/事件矩阵、状态所有权表、架构候选问题。

### RP-02：HTTP/SSE 服务边界与网络安全

**主要文件：**
- `packages/core/src/server.ts`
- `packages/core/src/main.ts`
- `packages/ui/src/services/agent-transport.ts`、`live-transport.ts`（22 行，rg 级核对）
- `packages/ui/src/lib/feature-flags.ts`
- core security/smoke 脚本

**检查：**
- Bearer 校验是否覆盖所有有副作用或敏感端点，方法与路径匹配是否可绕过。
- Host 白名单、DNS rebinding、CORS/Origin、内网绑定、IPv4/IPv6/端口/大小写边界。
- 静态资源公开、HTML token 注入、source map、缓存头、目录穿越、SPA fallback。
- 请求体大小/超时/并发/backpressure；恶意或损坏 JSON；错误详情泄漏。
- SSE 客户端隔离、心跳、慢客户端、关闭、半开连接、重复连接和资源释放。
- `CORE_HOST=0.0.0.0` 与 `CORE_ALLOWED_HOSTS` 的实际威胁模型是否与文档一致。

**输出：** 威胁模型、端点鉴权矩阵、网络边界候选问题。

### RP-03：授权、信任门与工具执行安全

**主要文件：**
- `packages/core/src/ui-context.ts`
- `packages/core/src/trust.ts`
- `packages/core/src/tools.ts`（39 行；执行逻辑在上游 Pi `setActiveToolsByName`，上游对未知名静默忽略——审查重点是 core 侧预校验与端点 400 路径）
- `packages/core/src/resources.ts`
- `packages/core/src/session.ts`
- `packages/ui/src/components/chat/ApprovalCard.tsx`
- `packages/ui/src/store/chat-store.ts`、`adapter/reduce.ts`
- C3 相关脚本

**检查：**
- requestId 生成、pending map、settle/cancel/timeout、重复响应和晚到响应。
- SSE 早到/晚到/重放时授权卡是否丢卡、重复卡或错挂到其他消息。
- 项目 `never/always/ask` 语义、未信任时项目扩展/技能/提示词是否可能加载或执行。
- abort 与授权并发、用户取消与拒绝语义、超时默认值是否安全。
- 工具启停只在下一 turn 生效的 UI 口径是否准确，是否存在未注册工具静默丢失。
- approval 与 tool execution 的顺序/终态是否可能让 UI 显示成功但实际未执行。

**输出：** 授权状态机、信任/工具安全矩阵、候选问题。

### RP-04：Provider、模型配置、凭证与出网请求

**主要文件：**
- `packages/core/src/providers.ts`
- `packages/core/src/models.ts`
- `packages/core/src/session.ts` 中模型初始化/切换路径
- `packages/core/src/contract.ts` Provider 契约
- UI 的 provider contract、表单、设置保存和 import panel
- `providers-check.mjs`、C5 脚本

**检查：**
- `models.json` / sidecar 的读取、合并、原子写、并发保存、崩溃恢复和未知字段保留。
- JSONC parser 对字符串、转义、Unicode、BOM、注释、尾逗号和恶意大文件的处理。
- `!command` 的执行边界、超时、stdout/stderr、shell 注入和错误泄漏。
- `$VAR` / `${VAR}` 诊断、缺失变量、重复变量、空 key、本地无鉴权模型。
- `baseUrl`/自定义 header 引发 SSRF、localhost/metadata 地址访问、协议混淆和超大响应风险。
- 凭证是否通过 API/HTML/SSE/日志/evidence 暴露；禁用 provider sidecar 是否安全。
- 保存、refresh、fallback、首次自动选型、部分写入失败的事务一致性。
- UI 全量 PUT 是否可能覆盖并发修改或未知配置。

**输出：** 文件/凭证数据流、失败原子性矩阵、候选问题。

### RP-05：会话持久化、活动 session 与 Pi 生命周期

**主要文件：**
- `packages/core/src/sessions.ts`
- `packages/core/src/session.ts`
- `packages/core/src/models.ts`
- `packages/core/src/contract.ts`
- UI `chat-store.ts`、Sidebar 相关组件
- C4/C6、usage-branch 脚本

**检查：**
- `SessionManager.open/list/getBranch/getEntries` 使用口径与历史/实时一致性。
- session id、文件路径、cwd、encoded session dir、title、updatedAt、messageCount。
- `loadSession`（只读）与 `continueRecentSession`（可能重建）语义是否被 UI 混用。
- 启动加载最近会话只调用 load、不切换 core 活动 session 的分叉风险。
- rebuild 时 model/thinking/extensions/usage/pending approvals/listeners 的继承和释放。
- prompt/load/continue/model switch/abort/dispose 并发与旧事件串入新 session。
- 特殊 entry、分支、compaction、model change、usage entry 和未知 Pi 版本字段。
- 空会话、损坏 JSONL、跨项目会话和 id 冲突处理。

**输出：** 会话生命周期图、状态分叉矩阵、候选问题。

### RP-06：Transport、事件适配、reducer 与 store 一致性

**主要文件：**
- `packages/core/src/adapt.ts`、`server.ts` 事件批处理
- `packages/ui/src/services/agent-transport.ts`
- `packages/ui/src/adapter/pi-events.ts`（契约形状归 RP-01 主审，本包只审事件消费与乱序处理）、`reduce.ts`
- `packages/ui/src/store/chat-store.ts`、`models-store.ts`、`notice-store.ts`
- adapter/contract 断言脚本

**检查：**
- SSE chunk 边界、`\r\n`、多行 data、decoder flush、坏行、心跳和断线重连。
- message start/update/end、turn/agent settled、usage、tool start/update/end 的顺序依赖。
- 重复事件、缺失终态、乱序终态、重连后事件缺口、pending approval 重放。
- reducer 幂等性、toolCallId 归属、assistant 多 turn、abort 后迟到事件。
- Zustand 异步竞态、乐观更新回滚、stale closure、订阅重复注册、unmount 清理。
- core `dispatchAgent` 白名单与 `AgentEvent` 联合类型未来漂移。
- mock/live 双路径是否共享同一状态不变量。

**输出：** 事件时序表、可接受/不可接受序列、状态不变量、候选问题。

### RP-07：UI 页面、交互状态与 mock/live 产品体验

**主要文件：**
- `packages/ui/src/App.tsx`
- `store/ui-store.ts`、`chat-store.ts`
- Workbench、RunDetail、Skills、Tokens、Shells、Settings 相关 screen/dialog/component
- `live-transport.ts`、mock 数据和 feature flags

**按场景走查：**
1. 首次启动、无模型、模型配置完成、自动选型、测试失败。
2. 发送、连续发送、abort、断线、core 重启、恢复后消息缺失。
3. select/confirm/input 授权、重复点击、取消、超时、刷新页面。
4. 会话列表、加载、续接、跨项目、空/坏会话、活动 session 切换。
5. 工具和资源读取、未信任项目、工具开关下一 turn 生效。
6. 设置保存、校验、fallback warning、凭证诊断、导入模型。
7. loading/empty/error/stale/disabled 状态、键盘操作、焦点、ARIA、深浅主题、窄屏。
8. 浏览器刷新、直接 hash、query 参数、设置弹窗跨屏状态。
9. 600+ 消息、虚拟列表、滚动跟随、流式更新、Markdown/代码高亮。

**输出：** 场景覆盖表、UI 状态矩阵、mock/live 差异、候选问题。

### RP-08：性能、资源、前端安全与可访问性

**主要文件：**
- MessageList、Markdown、highlight、layout、Shiki 初始化
- 全局 store 与高频流式 reducer
- transport/server 的流和资源管理
- Dialog/Menu/Tabs/Button 等交互原语
- `globals.css`、`tokens.css`、`shiki.css`

**检查：**
- 流式 snapshot 导致全树复制的复杂度；长会话内存与 GC；600 消息是否真的虚拟化。
- 动态 import/高亮语言缓存；超大工具输出/思考块的截断与 DOM 风险。
- Markdown/raw HTML/XSS/危险 URL；代码块和链接 target；token/secret 展示。
- listener/timer/AbortController/Object URL 泄漏。
- 键盘可达、focus trap、屏幕阅读器语义、颜色对比、reduced motion。
- 避免把纯审美建议升级为 bug；只记录有用户影响或明确标准依据的问题。

**输出：** 性能基线/测量项、安全与 a11y 检查表、候选问题。

### RP-09：测试、依赖、文档与发布成熟度

**主要文件：**
- 全部 `packages/core/scripts/**`、`packages/ui/scripts/**`
- package manifests/锁文件
- README、设计调研、TESTING、`.gitignore`
- 近期高频变更文件和历史 evidence 生成方式

**检查：**
- 单元/契约/集成/CDP/live 各层覆盖和断言强度，是否存在“只检查存在、不检查语义”的假绿。
- 脚本是否依赖固定端口、真实用户目录、真实 API key、系统 Chrome、时间/网络。
- 脚本退出码、超时、清理、并行安全、重复运行稳定性。
- npm scripts 是否覆盖 CI 可执行路径；无 lint/format/coverage/CI 的影响分级。
- 直接/传递依赖版本、重复版本、lockfile、废弃/高风险依赖；网络审计失败时明确未执行。
- Pi 0.x API 漂移策略、版本锁定、升级验证。
- README 与实际能力（本地 browser core、可选 Electron、跨平台 shell）是否一致。
- 缺少自动打包、签名、更新、崩溃恢复、日志、配置迁移时，区分“当前形态合理”与“桌面发布阻断”。

**输出：** 测试能力矩阵、依赖/发布风险、文档漂移、工程建议。

---

## 5. 分阶段执行顺序

### Phase 0：冻结基线与建立覆盖矩阵

1. 记录 Git `HEAD`、分支、状态、Node/npm/OS。
2. 创建所有生产源文件（基线约 90 个）的 coverage rows，初始状态为 `not-reviewed`。
3. 运行无副作用基线；浏览器/真实链路命令放隔离工作区。
4. 基线失败先登记，不立即推断根因；后续 packet 解释或复现。
5. **Checkpoint A：** 用户可看到基线是否健康及环境限制。

### Phase 1：架构与契约优先

1. 完成 RP-01。
2. 产出端点/事件/状态所有权基线，后续 packet 以此为共同坐标系。
3. **Checkpoint B：** 若系统边界或产品语义与用户预期冲突，先停下确认，不继续用错误假设审查。

### Phase 2：P0/P1 风险域深审

优先顺序：

1. RP-02 网络与服务边界。
2. RP-03 授权、信任与工具。
3. RP-04 凭证、Provider 与出网。
4. RP-05 会话与 Pi 生命周期。
5. RP-06 transport/event/store 一致性。

这些 packet 可在只读、上下文隔离的前提下并行；共享发现只通过 finding ledger 汇总，不共享整仓原始上下文。

**Checkpoint C：** 所有 P0/P1 候选先完成复现/反证和安全分级，再进入中低风险审查。

### Phase 3：产品场景与性能穿线

1. 执行 RP-07 的场景矩阵。
2. 执行 RP-08 的性能、安全和可访问性检查。
3. 使用现有 mock/CDP 脚本验证 UI；live 场景只使用隔离 agentDir 和可控假服务，不使用真实模型。
4. 对 UI 发现回溯 core transport，确认是 UI、core 还是契约根因。

### Phase 4：测试、依赖、文档与剩余覆盖

1. 执行 RP-09。
2. 按 coverage matrix 清理 `not-reviewed`；剩余文件逐个审查，不能以“低风险”直接批量标绿。
3. 复查高频变更模块，验证近期修复是否引入新回归。
4. 复查历史 `.plan` 中的“已知缺口”，只保留当前仍成立且有证据的项。

### Phase 5：统一复核与最终报告

1. 同一根因跨 packet 去重，保留完整影响面。
2. 对所有 P0/P1 和行为敏感的 P2 进行独立复核或最小复现。
3. 检查每条 finding 的文件行号在最终 `HEAD` 仍有效。
4. 验证报告没有密钥、token 或私人路径。
5. 输出整改路线，但不在本阶段实施。

---

## 6. 基线命令矩阵

命令从对应 package 目录运行。执行时记录退出码、关键输出和耗时；PASS/FAIL 与 NOT RUN 必须区分。

### Core 确定性/本地检查

```bash
npm run typecheck
npm run security-check
npm run smoke:check
npm run check:usage-branch
npm run check:providers
npm run check:c3
npm run check:c4
npm run check:c5
npm run check:c6
```

说明：C3–C6 若依赖固定环境、端口、系统资源或缺失夹具，应记录具体阻断原因；不得将其写成产品失败，也不得省略。

### UI 确定性检查

```bash
npm run typecheck
npm run check:format
npm run check:cn
npm run check:adapter
npm run check:contract
npm run build
```

### UI 浏览器检查（隔离工作区）

```bash
npm run accept:m1
npm run accept:m2
npm run accept:m3
npm run accept:m4
npm run accept:m5
```

说明：这些脚本可能更新 tracked evidence；必须先确认隔离工作区。它们验证 DOM/交互，不自动证明 live core 正确性。

### Live 检查（仅无真实密钥的隔离环境）

```bash
npm run live:smoke
```

说明：若脚本会读取真实用户 agentDir、真实 key 或产生模型费用，跳过并记录 NOT RUN。必要时后续用本地假 OpenAI-compatible 服务和临时 `CORE_AGENT_DIR` 补做，不修改用户配置。

### 现有探针/诊断脚本（按 packet 分流，隔离工作区运行）

```bash
# RP-05 会话加载：npm run probe:c4
# RP-07 屏幕走查：npm run probe:c5、probe:settings、probe:onboarding、shots:m1
# RP-03 授权输入：npm run probe:auth
# RP-04 凭证/保存 live 验证：npm run probe:settings:live
# 未接入 npm scripts、需 node 直跑：scripts/probe-c3-countdown.mjs（RP-03 授权超时）、
# scripts/probe-mcp-gate.mjs（RP-03 信任门）、scripts/probe-r7.mjs、scripts/m5-selfcheck.mjs、
# scripts/shots-r7.mjs、scripts/m1-diagnose.mjs、scripts/m1-diagnose-zero.mjs、
# scripts/diag-send-icon.mjs（RP-07 排障）
```

说明：这些脚本多数依赖 Chrome、固定端口或临时 agentDir，与 `accept:*` 同样在隔离工作区运行；它们是对应 packet 的验证工具，不作为独立基线门槛。Phase 0 只清点存在性与可运行性，不在本阶段全量执行。

### 可选供应链检查

```bash
npm audit --omit=dev --json
```

说明：需要网络；失败/不可用只记为 NOT RUN。不要自动执行 `npm audit fix`，也不要更新锁文件。

---

## 7. Finding 分级与证据规则

### 严重度

- **P0 / Critical**：可直接导致未授权敏感操作、凭证/会话大规模泄漏、任意命令执行、持久化破坏或核心服务完全不可用。
- **P1 / High**：核心工作流在常见操作下产生错误结果、状态分叉、数据丢失、授权绕过，或稳定性明显不足。
- **P2 / Medium**：特定边界条件下的错误、误导状态、显著体验/性能问题，或高价值测试与维护缺口。
- **P3 / Low**：低影响可维护性、可读性、文档漂移或改进建议，不应与功能缺陷混为一谈。

严重度按**影响和可达性**判定，不按修复工作量判定。

### 置信度

- **Confirmed**：已复现，或代码路径直接且无未检查的可达性条件。
- **Probable**：调用链和条件充分，但缺少运行环境复现。
- **Suspected**：只有风险信号；最终报告前必须升级证据或删除。

### Finding 模板

```markdown
### CR-编号：简短、具体的标题

- Severity: P0/P1/P2/P3
- Confidence: Confirmed/Probable
- Area: RP-xx
- Affected: 受影响版本/平台/模式
- Location: `path:line`
- Preconditions: 触发前提
- Reproduction: 最小步骤或验证命令
- Expected / Actual: 期望与实际
- Impact: 数据、安全、可靠性、体验或维护影响
- Root cause: 根因与跨层传播路径
- Recommendation: 最小修复方向（不在本阶段实施）
- Regression test: 应增加的断言/场景
- Evidence: 日志、断言输出或直接代码引用（已脱敏）
```

### 不进入最终 finding 的内容

- 纯个人风格偏好。
- 没有用户影响或明确依据的“不够优雅”。
- 仅由关键词搜索命中但没有可达路径的猜测。
- 历史 finding 的无证据复述。
- 同一根因的多个重复表述。

---

## 8. 上下文与 Token 控制

### 产物目录

执行时建议创建：

```text
docs/reviews/2026-09-24-global-review/
├── README.md                 # 最终执行摘要与导航
├── baseline.md               # 环境、命令结果、受限项
├── architecture.md           # 架构、端点、事件、状态所有权
├── coverage.md               # 每个生产源文件的审查状态
├── findings.md               # 唯一 finding ledger
├── scenarios.md              # 产品场景与 mock/live 结果
└── remediation-roadmap.md    # 修复优先级与批次建议
```

不在产物中保存子代理完整对话、整文件 dump、未脱敏日志或大段重复源码。

### 每个 packet 的输入限制

- 优先读取 packet 指定的主文件；其他文件先用 `rg` 定位，再按需读最小片段。
- 单个执行上下文尽量不超过 8 个主要输入文件；超过时按子流程继续拆分。
- 子代理只返回：系统摘要、候选 finding、覆盖文件、未覆盖原因、建议下一步；不返回整份源码。
- 主会话只保留当前 packet、finding ledger 摘要和下一个 packet 所需上下文。
- 每阶段结束写一次 handoff；即使会话中断，新会话只读 `README/baseline/architecture/coverage/findings` 即可接续。
- 完成一个 packet 后不再为写总结重新通读全仓。

### 建议执行方式

1. 主会话负责基线、架构和最终裁决。
2. RP-02–RP-09 在上下文隔离下按 packet 执行；相互独立的包可并行。
3. 每包先做静态阅读，再只运行能证实/反证候选的最小命令。
4. 不让执行者直接修代码；所有变更进入后续 remediation plan，经用户批准后再实施。

当前环境的自动子代理隔离可用性在执行前（Phase 0 第 1 步）实测：本仓库自身即 Git 根，且 `.superpowers/` 已在 `.gitignore` 中（0547b61），历史上“父目录不是 Git 仓库导致隔离失败”的条件已消除。实测可用则 RP-02–RP-09 按包并行；仍不可用则顺序执行 packet，不以牺牲覆盖面为代价强行并行。

---

## 9. 检查点与停止条件

### 用户可见检查点

- **A — 基线：** 环境、验证能力、明确阻断项。
- **B — 系统地图：** 架构与状态模型得到确认。
- **C — 高风险结论：** P0/P1 候选、证据和误报剔除结果。
- **D — 全面覆盖：** 所有生产文件和场景矩阵均有状态。
- **E — 最终报告：** findings、覆盖限制、整改路线。

默认完成 A–D 后直接生成最终报告，不要求每个检查点都等待用户选择；只有出现方向冲突或高风险环境动作时才暂停。

### 必须停止并请用户确认

- 发现疑似真实凭证或 token：立即脱敏、停止传播原文，单独报告位置和处置建议。
- 任何命令将修改真实 `~/.pi/agent`、真实 provider 配置或产生模型费用。
- 需要删除/覆盖用户文件、终止非本项目进程、开放公网端口或执行破坏性 PoC。
- 发现产品语义存在两种合理解释，且不同解释会改变严重度或修复方案。
- 需要把 review 扩展为 Pi 上游全仓审计或开始直接修代码。

### 环境受限处理

- Chrome、假服务、临时端口、网络或 Node 版本不满足时，标记 NOT RUN。
- 可用最小自包含测试替代时，在不污染仓库的前提下补充；否则保留限制，不猜测结果。
- 外部依赖文档与本地类型冲突时，以当前锁定版本类型/运行结果为准，并记录上游版本。

---

## 10. 最终交付物

1. **执行摘要**：整体健康度、最危险问题、主要系统优点。
2. **基线报告**：所有命令 PASS/FAIL/NOT RUN 与环境限制。
3. **架构与状态图**：关键组件、端点、事件、数据和状态所有权。
4. **Finding ledger**：去重、分级、含复现与建议的完整问题列表。
5. **覆盖矩阵**：所有生产源文件、测试脚本和关键用户场景的审查状态。
6. **测试缺口与误报说明**：哪些结论已验证，哪些受环境限制。
7. **整改路线**：按 P0→P3、依赖关系和风险收益分批；每批给出建议测试，不在本阶段实施。

最终报告不会只给“代码质量建议”列表，而会回答：当前版本能否安全交付、哪些核心场景可信、最大风险在哪里、修复应按什么顺序开始。
