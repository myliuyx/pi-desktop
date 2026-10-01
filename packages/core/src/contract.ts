/**
 * 共享契约 —— UI 与 core 之间唯一的类型边界。
 *
 * 设计纪律（C0 规格 + S6 §三）：
 * 1. **纯类型、零 import**：本文件不引入任何运行时依赖（不含 pi-coding-agent、
 *    node:*, core 运行时代码）。UI 只能 `import type` 它，从而 vite build 后
 *    dist 里绝不出现 core/pi 痕迹（硬约束 #2）。
 * 2. Block 七型 / Message / SessionSummary / TokenUsage / PlanStepStatus
 *    字段签名原样搬自 `packages/ui/src/mock/types.ts`（M2 冻结契约），不改任何字段。
 * 3. AgentEvent 全集原样搬自 `packages/ui/src/adapter/pi-events.ts`，并做三处修订：
 *    - 新增 `approval_request` / `approval_settled`（我们的形状，非 Pi 9 变体）；
 *    - `tool_execution_end`：补 `result` 形状 `{ content; details? }`、`isError`，
 *      明确不设 `exitCode` / `truncated`（spike-tools 实证事件里没有）；另补顶层扁平
 *      `details`（task-tool-diff-preview.md，edit 的展示用 diff 走这里到 UI）。
 *    - `tool_execution_update`：补 `partialResult` 对象 `{ content; details? }`，非 string。
 *
 * ⚠️ 偏差记录（执行方）：为守住「check:adapter 既有断言一行不改」的硬约束，
 * `tool_execution_end` / `_update` 仍保留 `output: string` 字段（reducer 与既有翻译器
 * 都消费它、且 adapter-check 断言精确比对 `{output}`，见 task C0 决策）。`result` /
 * `partialResult` 作为**可选**字段补进类型，与规格修订一致且不破坏既有期望值。
 */

/* ---------------------------------------------------------------------------
 * 消息流 Block —— 与 Pi 事件一一对应
 * ------------------------------------------------------------------------- */

export type MessageRole = "user" | "assistant";

/** 执行计划单步状态 */
export type PlanStepStatus = "pending" | "running" | "done" | "failed";

/** 终端步骤 / 工具调用状态 */
export type ToolStatus = "running" | "success" | "error";

/** ← `message_update` → `text_delta` */
export interface TextBlock {
  type: "text";
  content: string;
  /** 流式进行中 */
  streaming?: boolean;
}

/** ← `message_update` → `thinking_delta` */
export interface ThinkingBlock {
  type: "thinking";
  content: string;
  /** 默认是否折叠 */
  collapsed?: boolean;
  /**
   * 该思考段是否仍在流式增长（**仅实时 reducer 设置**，mock / 历史加载不设）。
   * `ThinkingCard` 据此「思考中自动展开、思考结束自动收起」；缺省时回退 `collapsed` 默认行为。
   */
  streaming?: boolean;
}

/** ← `message_update` → `toolcall_delta` */
export interface ToolCallBlock {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  status?: ToolStatus;
}

/** ← `tool_execution_start` / `_update` / `_end` */
export interface TerminalBlock {
  type: "terminal";
  toolCallId: string;
  command: string;
  output: string;
  exitCode?: number;
  status: ToolStatus;
  /** 输出被截断（给出「查看完整内容」入口） */
  truncated?: boolean;
  /** 截断时省略的内容行数 */
  hiddenLineCount?: number;
  /**
   * 默认是否折叠内容（命令行 + 输出）。
   * **仅实时 reducer / 历史加载设置 `true`**（实时执行终端不宜刷屏，点开才看）；
   * mock 演示（01 屏会话 / 03 屏运行详情）不设 → 默认展开，验收 2-7 与 03 屏期望不变。
   */
  collapsed?: boolean;
  /**
   * 工具结果的结构化详情（Pi `ToolResultMessage.details` 原样透传，task-tool-diff-preview.md）。
   * 上游各工具 details 形状各异：edit 为 `{ diff, patch, firstChangedLine }`（展示用 diff，
   * 格式 `+行号 内容`/`-行号 内容`/` 行号 内容`）、write/bash 等为 undefined/空对象。
   * **无 details 不写键**（adapter-check 对事件形状做精确断言）；UI 按
   * `toolName==="edit" && typeof details.diff==="string"` 守卫收窄，缺省回落 output 文本。
   */
  details?: Record<string, unknown>;
}

/** ← Extension UI Protocol 的 `select` / `confirm` 请求-响应 */
export interface ApprovalBlock {
  type: "approval";
  /**
   * 授权请求 id —— **由 core 生成**（`crypto.randomUUID()`，照 Pi `rpc-mode.ts:99`）。
   * Pi SDK 模式不产生 id，所以别把它当成 Pi 给的（S3 §五 C 的注释修订）。
   */
  requestId: string;
  title: string;
  message?: string;
  /** 如 ["允许", "拒绝"] */
  options: string[];
  /**
   * A1 新增（可选，mock / 旧事件不填 → 渲染行为不变）：请求形态。
   * `select`/`confirm` 渲染 options 按钮；`input` 渲染单行输入框 + 提交按钮（二者互斥）。
   * 取值与 `AgentEvent.approval_request.method` 一致（core 的 `ui.select/confirm/input`）。
   */
  method?: "select" | "confirm" | "input";
  /** A1 新增（可选）：`input` 的占位提示（core 侧 `input(title, placeholder?)` 原样下发） */
  placeholder?: string;
  /** 有值即表示已决（UI 乐观写入；Pi 不回显结果） */
  resolved?: string;
  /**
   * C3 新增（可选，既有 mock 数据不填 → 行为不变）：
   * 请求自带的超时毫秒数。UI 据此渲染倒计时与「已超时」失效态 ——
   * Pi 到点会自行以默认值收尾，用户再点会被静默丢弃（S3 §3.2「点了没反应」）。
   */
  timeoutMs?: number;
}

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
}

/** 自建能力（Pi 不内置 plan mode） */
export interface PlanBlock {
  type: "plan";
  steps: PlanStep[];
}

/**
 * 历史回放里的图片块（元数据，**不含字节**）—— 2026-10-01 图片真缩略图批次。
 *
 * 定位三元组 (sessionId, entryId, partIndex) 指向磁盘 session JSONL 里的那个
 * image part；浏览器拿它向 `GET /sessions/image` 换原图。
 *
 * ⚠️ 为什么没有 `data` 字段：base64 内联进 `/sessions/load` 响应会让最坏情况
 * 85MB/条消息（8 张 × 8MB × 1.33）打在这个**目前零限制**的接口上
 * （docs/reviews/2026-09-29-global-review/packets/RP-02.md 汇总表第 12 行「读 body（无上限）」
 *   + RP02-02 finding 的 :143 实测 5MB 被完整缓冲）。
 * 定位到字节是 core 端职责，不该由载荷体积承担。
 */
export interface ImageBlock {
  type: "image";
  /** 会话内稳定标识（UI key / testid 用） */
  id: string;
  /** 源图片 MIME（png/jpeg/gif/webp/bmp） */
  mimeType: string;
  /** 原始字节数（UI 可据此提示"图片较大"） */
  bytes: number;
  sessionId: string;
  entryId: string;
  /** 该 image part 在 `entry.message.content[]` 里的下标 */
  partIndex: number;
}

export type Block =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | TerminalBlock
  | ApprovalBlock
  | PlanBlock
  | ImageBlock;

export type BlockType = Block["type"];

/* ---------------------------------------------------------------------------
 * 会话
 * ------------------------------------------------------------------------- */

export interface Message {
  id: string;
  role: MessageRole;
  blocks: Block[];
  /** epoch ms */
  timestamp: number;
  /**
   * 本条消息的 token 计量（仅 assistant 且计量已到达时存在 —— 实时通道随
   * `message_end` 到达，历史会话由 entry 映射回填；user 消息 / 中途中止的
   * 消息没有该字段，渲染层据此不显示用量 footer）。
   */
  usage?: MessageUsage;
  /**
   * 生成这条回复的模型（仅 assistant；Pi `AssistantMessage.model`，请求时已定，
   * 实时通道随 `message_start` 到达）。user 消息 / 压缩摘要 / 旧会话文件没有
   * 该字段，渲染层据此不显示模型标签（同 usage 的诚实展示纪律）。
   */
  model?: string;
  /**
   * 实际响应的模型 id（仅 assistant；Pi `AssistantMessage.responseModel`，
   * 随 `message_end` 到达）。路由/别名场景下与 `model` 不同；展示口径取
   * `responseModel ?? model`（2026-09-27 用户裁决），两者都在时 title 里写明。
   */
  responseModel?: string;
  /**
   * 模型请求失败信息（仅 assistant；Pi `AssistantMessage.stopReason === "error"`
   * 时的 `errorMessage`，此时 content 通常为空壳）。出现即渲染错误框
   * （2026-09-28 用户裁决：失败要直接可见，不许静默）。user 主动中止（aborted）
   * 与流式中的 pending 不算失败，不设此字段。
   */
  errorMessage?: string;
  /**
   * 粘贴图片批次（task-composer-paste-image.md §5.3）：user 消息的**待发附件快照**，
   * **UI 乐观回显专用** —— 仅 chat-store 本地回显时写入，core 的序列化/实时事件
   * **恒不写**。
   *
   * 2026-10-01 更新：历史回放**不再**用 `[图片]` 占位文本，改走 `Block` 里的
   * `ImageBlock`（元数据 + 按需取图）。本字段仍只服务于「刚发出、尚未刷新」
   * 的乐观回显。
   */
  attachments?: { id: string; dataUrl: string }[];
}

export interface Session {
  id: string;
  title: string;
  /** epoch ms */
  updatedAt: number;
  messages: Message[];
}

/** 侧边栏历史会话条目（不含消息体） */
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

/**
 * C4 · 加载单个会话的响应体（`POST /sessions/load`）。
 *
 * 规格书 §2.1 要求「返回 `Message[]`」—— `messages` 就是这个 `Message[]`，
 * 外层多包一层是为了**顺带带上标题/更新时间/token 用量**（`UsageEntry → TokenUsage` 的产物），
 * 否则 UI 侧拿到消息后还得再查一次清单才能显示标题。**不含任何 pi 类型**。
 */
export interface SessionLoadResult {
  /** 会话 id（`SessionInfo.id`） */
  id: string;
  /** `name ?? firstMessage`（与 `SessionSummary.title` 同一口径） */
  title: string;
  /** epoch ms */
  updatedAt: number;
  messages: Message[];
  /** 由会话里的 usage 条目/助手消息 usage 汇总（无数据时四项为 0） */
  tokenUsage: TokenUsage;
  /** 映射期统计（复核用：跳过了哪些非消息 entry、是否命中主干） */
  stats: SessionLoadStats;
}

/** `SessionEntry[]` → `Message[]` 的映射统计（`S2 §四` 要求显式标注未覆盖项） */
export interface SessionLoadStats {
  /** 参与映射的 entry 数（主干上） */
  entryCount: number;
  /** 产出的消息数 */
  messageCount: number;
  /** 被跳过的 entry 类型 → 条数（`model_change` / `label` / `session_info` …） */
  skipped: Record<string, number>;
  /** tokenUsage 的来源：`assistant-usage` | `usage-entries` | `none` */
  usageSource: "assistant-usage" | "usage-entries" | "none";
  /** 是否从树结构上取了主干（当前恒为 true；分支 UI 记为后期，`S6 §四·4`） */
  mainBranchOnly: boolean;
}

/* ---------------------------------------------------------------------------
 * Token 统计
 * ------------------------------------------------------------------------- */

/** ← `get_session_stats` 的 tokens + contextUsage */
export interface TokenUsage {
  /** 最近一次 assistant 请求的输入 tokens（已含历史上下文；累加会重复，故取最近一次） */
  input: number;
  /** 最近一次 assistant 请求的输出 tokens */
  output: number;
  /**
   * 会话累计 token 消耗（ΣPi `totalTokens` —— **含 `cacheRead` / `cacheWrite`**）。
   * 注意：它 ≥ `input + output`（后两者是最近一次 API 计量的输入/输出，不含 cache）。
   */
  total: number;
  /** 当前模型上下文窗口大小 */
  contextWindow: number;
  /**
   * 当前**已用**上下文 tokens（Pi `AgentSession.getContextUsage().tokens`，随对话增长）。
   *
   * 可选；缺失时 `TokenStats` 回落显示 `contextWindow`（验收 2-14 的 `128k`）。
   * 两个来源都会填：① `usage` 事件的实时快照；② 历史会话加载时由 `foldUsage`
   * 按 Pi `calculateContextTokens` 同式（`totalTokens || input+output+cacheRead+cacheWrite`）算出。
   * **仅当两侧都未知**（mock 数据、刚压缩完的下一次回复前）才缺省 —— 避免下发 0 的假数据。
   */
  contextTokens?: number;
  /**
   * 最近一次 assistant 请求的缓存命中 tokens（F2；「>0 才写」纪律同 contextTokens）。
   *
   * 口径沿 `sessions.ts` foldUsage 注释：cacheRead **不并入 input**、已含在 `total` 里，
   * 展示时与 input 并列、不相加。取「最近一次」与 input/output 同口径（累加会重复计）。
   */
  cacheRead?: number;
  /** 最近一次 assistant 请求的缓存写入 tokens（F2；>0 才写） */
  cacheWrite?: number;
  /**
   * 会话累计输入 tokens（Σ 各次 assistant 请求的 `input`；task-context-ring-token-popover.md D1）。
   *
   * 与 `input`（最近一次）并存：环悬停浮框的明细面板用累计口径（参考图四行加总=总计）。
   * 累计四项**直接写、0 合法**（「会话无缓存」是真事实，区别于最近一次 cache 两项的
   * 「>0 才写」反假数据纪律）。
   */
  inputSum?: number;
  /** 会话累计输出 tokens（Σ 各次 `output`；口径同 `inputSum`） */
  outputSum?: number;
  /** 会话累计缓存命中 tokens（Σ 各次 `cacheRead`；口径同 `inputSum`） */
  cacheReadSum?: number;
  /** 会话累计缓存写入 tokens（Σ 各次 `cacheWrite`；口径同 `inputSum`） */
  cacheWriteSum?: number;
  /**
   * 会话累计费用美元（Σ pi-ai `usage.cost.total`——按每次请求的模型单价算好的值，
   * 模型中途切换天然正确）。**>0 才写**：0 = 模型没配单价（或旧会话 jsonl 无 cost 字段），
   * 消费方（浮框费用行）按缺省/≤0 整行隐藏。
   */
  costTotal?: number;
}

/**
 * 单条 assistant 消息的 token 计量（pi-ai `Usage` 的投影；F2 · task-chat-feedback-and-usage.md §3.1）。
 *
 * 与 `TokenUsage` 的差异：这里是**逐条消息**的真实计量（无 contextWindow / contextTokens 语义），
 * 字段名对齐 pi-ai（`totalTokens → total` 投影为我们的命名）。
 * `total` 含 cacheRead/cacheWrite —— 展示时各项并列、不相加（决策 D5）。
 */
export interface MessageUsage {
  /** 本次请求的输入 tokens（已含历史上下文与缓存部分之外的新增） */
  input: number;
  /** 本次请求的输出 tokens */
  output: number;
  /** pi-ai `totalTokens`（含 cacheRead / cacheWrite，故 ≥ input + output） */
  total: number;
  /** 缓存命中 tokens（>0 才写） */
  cacheRead?: number;
  /** 缓存写入 tokens（>0 才写） */
  cacheWrite?: number;
}

/* ---------------------------------------------------------------------------
 * AgentEvent 全集（UI 唯一消费的事件协议；由 core 把 Pi 事件翻译成此形状）
 * ------------------------------------------------------------------------- */

export type AgentContentPart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export type AgentMessageRole = "system" | "user" | "assistant" | "toolResult";

export interface AgentMessage {
  role: AgentMessageRole;
  content: AgentContentPart[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
  /** 原始事件的 message.usage 透传（仅 assistant 的 message_end 携带；adapt.ts 的 usageOf 产出，出现即四项俱全） */
  usage?: MessageUsage;
  /** 请求的模型 id（仅 assistant；Pi `AssistantMessage.model`，message_start 即有，adapt.ts 透传） */
  model?: string;
  /** 实际响应的模型 id（仅 assistant；Pi `AssistantMessage.responseModel`，message_end 才确定） */
  responseModel?: string;
  /**
   * 模型请求失败信息（仅 assistant 的 error 消息；Pi `AssistantMessage.errorMessage`，
   * adapt.ts 仅在 stopReason === "error" 时透传）。reducer 据此挂到 Message.errorMessage
   * 出错误框（2026-09-28 用户裁决：失败要直接可见，不许静默）。
   */
  errorMessage?: string;
}

/** 工具结果内容（与 Pi 事件 result.content 同构） */
export interface ToolResultContent {
  type: "text";
  text: string;
}

export type AgentEvent =
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage }
  | { type: "message_end"; message: AgentMessage }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      output: string;
      /** 修订：partialResult 是对象 `{content:[...], details?:{}}`，非 string（spike 实证） */
      partialResult?: { content: ToolResultContent[]; details?: unknown };
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      output: string;
      isError: boolean;
      /**
       * 工具结果的结构化详情（task-tool-diff-preview.md）：`result.details` 的扁平透传，
       * 与 `output`（content 的文本扁平）同款口径 —— reducer/TerminalBlock 直接消费扁平字段，
       * 不撑开可选的 `result` 整体（避免每个事件双份 payload）。edit 为
       * `{ diff, patch, firstChangedLine }`；无 details 不写键（adapter-check 精确断言）。
       */
      details?: Record<string, unknown>;
      /** 修订：result 形状 = { content:[{type:"text",text}], details? }；明确不设 exitCode/truncated */
      result?: { content: ToolResultContent[]; details?: unknown };
    }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "agent_start" }
  | { type: "agent_settled" }
  /** 新增：会话用量快照（每次 assistant 消息结束后下发；UI 的 TokenStats 消费） */
  | { type: "usage"; usage: TokenUsage }
  /** 新增：授权请求（我们的形状，非 Pi 9 变体）。method 对应 select/confirm/input */
  | {
      type: "approval_request";
      requestId: string;
      method: "select" | "confirm" | "input";
      title: string;
      options?: string[];
      message?: string;
      /** C3 补：`input` 的占位提示（S3 §五 A 的草案形状，原 C0 契约漏了） */
      placeholder?: string;
      /** C3 补：扩展传入 `opts.timeout` 时的倒计时毫秒数（UI 据此渲染失效态） */
      timeoutMs?: number;
    }
  /** 新增：授权已结算（UI 乐观写 resolved；Pi 不回显结果） */
  | {
      type: "approval_settled";
      requestId: string;
      resolution: "accepted" | "cancelled";
    }
  /** 新增：工作目录已热切换（D7，POST /cwd 成功后广播；UI 收到后重拉会话清单与 cwd 展示） */
  | { type: "cwd_changed"; cwd: string }
  /** C8 新增：包操作进度（安装/移除/更新；core 由 setProgressCallback 桥接直接生成） */
  | PackageProgressEvent
  /** S1-S2 新增：技能安装进度（克隆/定位/拷贝阶段文案；core 直发，同 package_progress 管道） */
  | SkillProgressEvent;

/* ---------------------------------------------------------------------------
 * C6 · 04 屏工具开关（`GET /tools/active` / `POST /tools/active {names}`）
 *
 * API 依据（@earendil-works/pi-coding-agent@0.99.2，`core/agent-session.d.ts`）：
 * - 读取：`getActiveToolNames(): string[]`（d.ts:337，当前启用清单的 getter）；
 * - 写入：`setActiveToolsByName(toolNames: string[]): void`（d.ts:349，0.86→0.87 未改名；
 *   "Changes take effect on the next agent turn" —— 下一个 agent 轮次生效）；
 * - 可启用全集：`getAllTools(): ToolInfo[]`（d.ts:341，`ToolInfo` 含 `name`，
 *   types.d.ts:1279 —— 注册表里未知名字会被 setter 静默忽略，故 core 侧先自行校验、未知名回 400）。
 * ------------------------------------------------------------------------- */

export interface ToolsPayload {
  /** 当前启用的工具名（`getActiveToolNames()`） */
  active: string[];
  /** 注册表里可启用的全部工具名（`getAllTools()`，含内置四个与扩展注册的工具） */
  available: string[];
}

/* ---------------------------------------------------------------------------
 * C5 · 04 屏数据源（`GET /resources`）
 * ------------------------------------------------------------------------- */

/** 04 屏单条清单项 —— 扩展 / 提示词 / 技能三类共用一份形状（分组由字段名承担） */
export interface ResourceEntry {
  id: string;
  /** 展示名（扩展=文件名、提示词=`/name`、技能=skill name） */
  name: string;
  description: string;
  /** 来源标记：`用户目录` / `项目内` / `临时`（对应 Pi 的 `SourceInfo.scope`） */
  source?: string;
}

export interface ResourcesPayload {
  /** 与 Pi 的 `getExtensions()` 对应（已过滤 hidden 与未信任的项目本地） */
  extensions: ResourceEntry[];
  /** 与 Pi 的 `getPrompts().prompts` 对应 */
  prompts: ResourceEntry[];
  /** 与 Pi 的 `getSkills().skills` 对应 */
  skills: ResourceEntry[];
  /** 本次会话的信任结论（`null` = 会话尚未就绪） */
  trust: { trusted: boolean; reason: string } | null;
  /**
   * 该目录**本来**就有「需要信任」的项目本地资源（Pi 的
   * `hasTrustRequiringProjectResources(cwd)` 判定，纯谓词、无副作用）。
   *
   * ⚠️ 实测：未信任时 Pi **根本不会加载**项目本地资源，所以它们在
   * `getExtensions()/getSkills()/getPrompts()` 里就已经不存在了 ——
   * 「有没有东西被按信任门拦下」只能靠这个谓词 + `trust` 组合判断，
   * 不能靠「过滤前后条数差」（那个差值恒为 0）。
   */
  projectResourcesExist: boolean;
  /** 项目本地资源是否因「未信任」被拦下（= `projectResourcesExist && !trust.trusted`） */
  projectTrustBlocked: boolean;
  /**
   * 我们从 loader 返回的清单里**主动剔除**的条目数（`scope === "project"` 且未信任）。
   * 实测通常为 0（Pi 已先一步不加载），保留它是为了覆盖「Pi 返回了项目本地条目但我们不放行」的情况。
   */
  filteredProjectCount: number;
}

/* ---------------------------------------------------------------------------
 * C5 · 05 屏数据源（`GET /models` / `POST /models/select` / `POST /thinking`）
 *
 * 注意（实测）：`ModelRuntime.getModels()` 返回全部内置目录（本机 1496 条，绝大多数无凭证），
 * 故只列 `getAvailableSnapshot()`（已配置凭证的）—— 与 Pi 的 `/model` 选择器口径一致。
 * ------------------------------------------------------------------------- */

/** 与 UI 的 `ModelOption`（`mock/types.ts`）字段一一对应，避免 UI 侧再转一次 */
export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  /**
   * Provider 的**展示名**（models.json 里那条记录的 `name`，缺省回落 id）。
   *
   * 为什么要单独给出：`provider` 是**内部 key**（`provider-1790227472338` 这种），
   * 拿它当分组标题显示给用户是错的（2026-09-24 用户反馈「模型选择的 provider 显示不对」）。
   * UI 分组/标签一律用本字段，`provider` 只用于跨 provider 去重与请求参数。
   */
  providerLabel?: string;
  /** 模型是否支持思考（Pi 的 `Model.reasoning`）—— 05 屏「支持 Max」标记的 live 口径 */
  supportsXhigh?: boolean;
  /**
   * 输入模态（Pi `Model.input`，粘图批次 2026-09-30 补）：UI 据此做「当前模型
   * 不支持图片输入则禁止粘贴」的门控（规格书 D2）。可选 = 旧版 payload 没有；
   * 消费方对缺省**宽松放行**（不能因字段缺失把门控做成全面禁贴）。
   */
  input?: ("text" | "image")[];
  /**
   * 模型上下文窗口（tokens，Pi `Model.contextWindow`；2026-10-01 上下文环真值批次补）。
   *
   * 可选 = 旧版 payload 没有，或该模型在 `models.json` 里没显式配（Pi 会用自身默认值，
   * 但那不是"我们能断言的事实"，消费方按未知处理）；**`>0` 才由 core 写入**，
   * 0 / 脏值一律不写键（同 `supportsXhigh` 的"缺省即没有"纪律）。
   *
   * 消费方：输入框底行上下文占用环的**窗口分母**（此前用 UI 侧 mock 演示值 128000，
   * 是假事实）。唯一真值来源就是这里。
   */
  contextWindow?: number;
}

/** 思考档位（字面量集合与 UI `mock/types.ts` 的 `ThinkingLevel` 一致；core 侧独立声明，避免跨包运行时依赖） */
export type ThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelsPayload {
  /** 可选模型（`getAvailableSnapshot()`；空数组时 UI 回落 mock 清单） */
  models: ModelInfo[];
  /** 当前生效模型 */
  current: { provider: string; modelId: string } | null;
  /**
   * **当前生效**的思考档位（Pi 会按模型能力夹取 —— 本机模型 `reasoning:false`，恒为 `off`）。
   * 05 屏的激活态优先用 `settings.thinkingLevel`（用户所选），见下。
   */
  thinkingLevel: ThinkingLevelName;
  /** 当前模型支持的档位（`session.getAvailableThinkingLevels()`） */
  availableThinkingLevels: ThinkingLevelName[];
  /**
   * `settings.json` 里**既有字段**的现值（切换后可直接在此观察到写回结果）：
   * `defaultProvider` / `defaultModel` / `defaultThinkingLevel`。
   */
  settings: {
    provider: string | null;
    modelId: string | null;
    thinkingLevel: ThinkingLevelName | null;
  };
  /** 本机是否检测到会话（未就绪时为 false，UI 据此回落 mock） */
  ready: boolean;
}

/* ---------------------------------------------------------------------------
 * C2 · 第二批：模型接真（Provider 读写 / 目录 / 测试）
 *
 * 读写 core 侧 models.json（启用 provider）+ 同目录 sidecar `models-disabled.json`
 * （禁用 provider 完整配置原文）。字段名对齐 models.json 原生 schema（用 `cost`
 * 而非第一批 mock 的 `pricing`；`input` 用 `["text","image"]` 数组而非布尔）。
 * 本段与 UI 的 `@/mock/provider-contract.ts` 是同一组类型的「core 权威 / UI 副本」关系。
 * ------------------------------------------------------------------------- */

/** 单个模型的配置（对齐 Pi `models.json` 的 model 节点原生 schema） */
export interface ProviderModelEntry {
  /** 模型 id（Provider 内唯一）。**schema 里唯一必填字段**（minLength 1） */
  id: string;
  /**
   * 模型显示名。**可选 = 未填**：Pi 的原生 schema 是
   * `Optional(String({minLength:1}))` —— 可选，但一旦出现就必须 ≥1 字符。
   * 空串属于**非法值**且会让整份 models.json 校验失败（所有 Provider 一起消失），
   * 故「未填」必须表达为**缺省**，由 Pi 回落到 `id`。
   */
  name?: string;
  /** 是否支持推理 / 思考 */
  reasoning: boolean;
  /** 输入模态（对齐 models.json 原生 `input: ("text"|"image")[]`） */
  input: ("text" | "image")[];
  /**
   * 上下文窗口（tokens）。
   *
   * **可选 = 「未填」**（2026-09-24 实踩后修）：Pi 的 `modelFromJson` 对 `<= 0` 直接 throw
   * （`invalid contextWindow`），而它自己的默认值（128000 / 16384）**只在字段缺省时**生效。
   * 所以「用户没填」必须表达为**缺省**，不能表达为 0 —— 否则整个 Provider 会被判非法、
   * 从可用集合里摘掉，表现为「保存成功但模型全没了」的静默失败。
   */
  contextWindow?: number;
  /** 最大输出 tokens（语义同上：缺省 = 用 Pi 默认值，0 是非法值而非「未填」） */
  maxTokens?: number;
  /** 每百万 tokens 价格四列（对齐 models.json 原生 `cost`） */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** 模型级 Headers（对齐 models.json 原生 `headers`） */
  headers?: Record<string, string>;
  /**
   * 兼容性标记（对齐 models.json 原生 `compat`，可选）。
   *
   * ⚠️ 必须是**对象**，不是字符串（CR-029）：上游 Pi 的 `ProviderCompatSchema`
   * （`@earendil-works/pi-coding-agent` `dist/core/model-config.js`，源码锚点
   * `pi/packages/coding-agent/src/core/model-config.ts` `ProviderCompatSchema = Type.Union([...])`，
   * OpenAI/Responses/Anthropic 三个成员**全可选字段**的 Type.Object；pi HEAD 35180b9）对
   * 模型级 `compat` 的类型是对象联合。写字符串会让 `ModelConfig.load` 判整份文件非法
   * （`providers.size === 0` ⇒ 所有 Provider 集体消失）。
   *
   * 该联合成员字段多且随上游版本浮动，故此处按「**二级透传**」建模为开放对象：只约束其为
   * 可 JSON 序列化的普通对象，**具体字段与取值的合法性由保存前的 `ModelConfig.load` 预检兜底**
   * （core `providers.ts` save 路径，非法即 4xx 拒绝落盘），不在此处穷举上游 schema。
   */
  compat?: ProviderCompat;
  /**
   * 高级：API 端点覆盖（UI 表单「高级设置」字段，非 models.json 标准字段，原样透传）。
   * 写回时作为 model 节点的扩展键保留，读回再回填表单。
   */
  endpointOverride?: string;
}

/**
 * 模型级 `compat` 对象（二级透传形状，见 {@link ProviderModelEntry.compat}）。
 * 合法成员 = 上游 `ProviderCompatSchema` 三个全可选对象联合之一；此处不穷举字段，
 * 由 `ModelConfig.load` 在保存前统一校验（core `providers.ts`）。
 */
export type ProviderCompat = Record<string, unknown>;

/** 一个 Provider（模型服务）的配置（`GET /providers` 与 `PUT /providers` 共用形状） */
export interface ProviderEntry {
  /** Provider id（= models.json 里 providers 记录的 key） */
  id: string;
  /** 显示名。**可选 = 未填**（同 `ProviderModelEntry.name`：空串会让整份文件非法） */
  name?: string;
  /** Base URL。**可选 = 未填**（同上；缺省时 Pi 用该 provider 的默认端点） */
  baseUrl?: string;
  /**
   * API key 原文（D6：本地单用户 + 127.0.0.1 + Bearer/Host 白名单，不脱敏）。
   *
   * **可选 = 未填**：schema 为 `Optional(String({minLength:1}))`。空串会让整份 models.json
   * 校验失败 —— 即「顺手加了个还没配 key 的 Provider，把已配好的全弄没了」（2026-09-24 实踩）。
   * 另注：Pi 口径下「无凭证 = 未配置」，缺省该项的 Provider 其模型不进可用清单。
   */
  apiKey?: string;
  /** API 类型（openai-completions / openai-responses / anthropic-messages）。可选 = 用默认 */
  api?: string;
  /** Provider 级 Headers（对齐 models.json 原生 `headers`） */
  headers: Record<string, string>;
  /** 是否启用（禁用 = 存 sidecar，Pi 眼中不存在） */
  enabled: boolean;
  models: ProviderModelEntry[];
}

/** `GET /providers` 响应体 */
export interface ProvidersPayload {
  providers: ProviderEntry[];
  /** 当前生效模型（`settings.json` 的 defaultProvider / defaultModel） */
  current: { provider: string; modelId: string } | null;
  /** 会话是否已就绪（未就绪时 UI 回落 mock） */
  ready: boolean;
}

/** `PUT /providers` 请求体（全量替换写回） */
export interface PutProvidersRequest {
  providers: ProviderEntry[];
}

/** `PUT /providers` 响应体（在 `ProvidersPayload` 基础上附回退标记） */
export interface ProvidersSaveResult {
  providers: ProviderEntry[];
  current: { provider: string; modelId: string } | null;
  ready: boolean;
  /** 当前生效模型被删、已回退到可用清单第一个时为 true */
  fallbackApplied: boolean;
  /** `fallbackApplied` 时的告警文案（否则省略） */
  warning?: string;
}

/** `GET /models/catalog?q=` 单条目录结果（内置目录元数据，不出网） */
export interface CatalogEntry {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** `GET /models/catalog?q=` 响应体 */
export interface CatalogPayload {
  query: string;
  results: CatalogEntry[];
}

/** `POST /models/test` 请求体（用表单里的 provider/model 配置构造一次性最小请求） */
export interface ModelTestRequest {
  baseUrl: string;
  /** API key 原文（`!`/`$ENV` 插值由 core 解析，不落盘、不改当前选择） */
  apiKey: string;
  /** API 类型（决定请求路径与报文形态） */
  api: string;
  /** Provider 级 Headers */
  headers?: Record<string, string>;
  /** 被测模型 id */
  modelId: string;
}

/**
 * `POST /providers/models` 请求体 —— 拉取某个 Provider 的**真实模型清单**。
 *
 * 与 `ModelTestRequest` 同一套凭证解析（`!` / `$ENV` 由 core 解析，不落盘），
 * 区别只是发的是 `GET {baseUrl}/models` 而不是一次最小对话请求。
 */
export interface ProviderModelsRequest {
  baseUrl: string;
  apiKey: string;
  api: string;
  /** Provider 级 Headers（逐条透传到上游） */
  headers?: Record<string, string>;
}

/** `POST /providers/models` 响应体 */
export interface ProviderModelsResult {
  ok: boolean;
  /** 上游返回的模型 id 清单（已 trim / 去重 / 保序） */
  models: string[];
  /** `ok=false` 时的错误文案（带目标 host，口径同 `POST /models/test`） */
  error?: string;
  /** 实际请求的地址（自查用：确认打到了哪个 host / 路径） */
  endpoint?: string;
}

/** `POST /models/test` 响应体（D7：最小真实请求，max_tokens:1，费用忽略不计） */
export interface ModelTestResult {
  ok: boolean;
  /** 端到端耗时（ms） */
  latencyMs: number;
  /** `ok=false` 时的错误文案 */
  error?: string;
}

/* ---------------------------------------------------------------------------
 * C7 · 设置弹窗 · 技能 Tab（`GET /skills` / `POST /skills/toggle`）
 *
 * 口径：**不是** `GET /resources` 的已加载子集（那是 04 屏「技能与工具」的清单），
 * 而是包管理器 `resolve()` 的**全量**解析结果 —— 已被禁用的技能也在列
 * （enabled:false），否则开关一关条目就从清单里消失、再也打不开
 * （0.99.2 的 resolve 内部跑 addAutoDiscoveredResources，每条自带 enabled 标志）。
 * ------------------------------------------------------------------------- */

/** 单条技能清单项 */
export interface SkillListItem {
  /** 展示名（SKILL.md frontmatter `name`；损坏文件回落技能目录名） */
  name: string;
  /** frontmatter `description`（缺失为空串 —— 不造展示假数据） */
  description: string;
  /**
   * SKILL.md 绝对路径 —— **toggle 的定位键**（请求原样回传，core 按它写
   * `!${path}` 排除模式；模式匹配两侧都过 toPosixPath 归一，Windows 原样可写）。
   */
  path: string;
  /** 展示分组：user=「全局」/ project=「项目」（参考图口径；包技能按安装域落组） */
  scope: "user" | "project";
  /** toggle 写法分叉的判据：top-level=目录发现 / package=插件包贡献 */
  origin: "top-level" | "package";
  /** 仅 origin=package：归属包的 source 串（写进该包对象过滤器的 skills 模式） */
  packageSource?: string;
  /**
   * 仅 origin=top-level 且技能目录内有 `.pi-source.json` 时存在：安装来源仓库
   * （`owner/repo`，core 安装时写入，S6）。**与 packageSource 语义不同**——
   * 那是「由哪个插件包贡献」，这是「这个目录是从哪个 GitHub 仓库装的」。
   * 缺省 = legacy 安装（S6 之前装的，无记录），UI 按 legacy 口径处理。
   */
  source?: string;
  /** 当前是否启用 */
  enabled: boolean;
}

/** `GET /skills` 响应体 */
export interface SkillsPayload {
  skills: SkillListItem[];
  /** 信任结论（null = 会话未就绪；未信任时项目技能不列，与 /resources 同语义） */
  trust: { trusted: boolean; reason: string } | null;
  projectResourcesExist: boolean;
  projectTrustBlocked: boolean;
  /** 被「未信任」剔除的项目本地技能条数（与 /resources 的 filteredProjectCount 同口径） */
  filteredProjectCount: number;
}

/** `POST /skills/toggle` 请求体 */
export interface SkillToggleRequest {
  /** SkillListItem.path 原样回传 */
  path: string;
  /** true=启用（移除 `!路径` 模式）/ false=禁用（追加 `!路径` 模式） */
  enabled: boolean;
}

/** `POST /skills/toggle` 响应体（切换后的最新清单，UI 直接整体替换免二次拉取） */
export interface SkillToggleResult {
  skills: SkillsPayload;
}

/* ---------------------------------------------------------------------------
 * S1-S2 · 设置弹窗「添加技能」（`GET /skills/search` / `POST /skills/install`）
 *
 * 搜索 = skills.sh 公开 API 的 core 只读代理（`GET /api/search?q=`，2026-09-29
 * 实测无需鉴权；详情接口 401 不可用，故结果只有 name/source/installs 三样）。
 * 安装 = git clone 官方 skills CLI 同款通道：`--depth 1` 克隆 GitHub 仓库 →
 * 全树发现 SKILL.md 按 **frontmatter `name`** 匹配（skills.sh 的 skillId 就是
 * frontmatter name，≠ 仓库目录名，2026-09-29 实证）→ 技能目录整体拷到
 * `~/.pi/agent/skills/<dir>/`（user）或 `<cwd>/.pi/skills/<dir>/`（project）。
 * ------------------------------------------------------------------------- */

/** `GET /skills/search` 结果项（skills.sh 搜索响应的字段白名单映射） */
export interface SkillSearchEntry {
  /** 归属仓库（`owner/repo`；个别条目非此形态——非 GitHub 源，安装端点会拒绝） */
  source: string;
  /** 技能标识 = 目标仓库 SKILL.md frontmatter 的 `name`（install 的定位键） */
  skillId: string;
  /** 展示名（skills.sh 原文；通常与 skillId 一致） */
  name: string;
  /** skills.sh 累计安装量（展示用） */
  installs: number;
}

/** `GET /skills/search?q=` 响应体 */
export interface SkillSearchPayload {
  results: SkillSearchEntry[];
}

/** `POST /skills/install` 请求体 */
export interface SkillInstallRequest {
  /** 归属仓库，严格 `owner/repo`（core 固定拼 `https://github.com/<source>.git`） */
  source: string;
  /** 要安装的技能（skills.sh 搜索结果的 skillId 原样回传） */
  skillId: string;
  /** user = `~/.pi/agent/skills/`；project = `<cwd>/.pi/skills/` */
  scope: "user" | "project";
}
/** `POST /skills/install` 响应体（安装并 reload 后的最新清单，UI 整体替换） */
export interface SkillInstallResult {
  skills: SkillsPayload;
  /** 落盘后的技能目录绝对路径（UI 选中定位用） */
  installedPath: string;
  /** SKILL.md frontmatter 的 name（= 清单里新条目的 name，选中匹配键） */
  skillName: string;
}

/**
 * SSE · 技能安装进度（克隆 → 定位 → 拷贝阶段文案）。
 * 与 PackageProgressEvent 同构同管道（core 直发，不经 toAgentEvent 翻译）。
 */
export interface SkillProgressEvent {
  type: "skill_progress";
  action: "install";
  /** `owner/repo/skillId`（定位排错用） */
  source: string;
  /** 阶段文案（「正在克隆仓库…」等） */
  message?: string;
}

/* ---------------------------------------------------------------------------
 * C8 · 设置弹窗 · 插件 Tab（`GET /packages` / `POST /packages/*` / `POST /session/reload`）
 *
 * 数据源：`DefaultPackageManager.listConfiguredPackages()`（settings `packages`
 * 数组的 user+project 全量，含 installedPath）× `resolve()`（按 metadata.source
 * 归属到包的资源明细）× 安装目录 package.json（name/version/description）。
 * 开关语义 = 0.99.2 对象形 PackageSource：`{source, autoload:false}` = 整包禁用。
 * ------------------------------------------------------------------------- */

/** 包贡献的单条资源（extensions/skills/prompts/themes 通用形状） */
export interface PackageResourceRef {
  /** 展示名（扩展=文件名去后缀、技能=目录名、提示词/主题=文件名去后缀） */
  name: string;
  /** 绝对路径 */
  path: string;
  enabled: boolean;
}

/** 单个已配置插件包的详情 */
export interface PackageDetail {
  /** 配置的 source 串（`git:host/path`、`npm:spec`、本地绝对路径……原样） */
  source: string;
  scope: "user" | "project";
  /** 当前是否启用（对象形 `autoload:false` = 禁用） */
  enabled: boolean;
  /** 安装路径（本地包=解析后的路径；npm/git=安装目录；missing 时缺省） */
  installedPath?: string;
  /** 包名（安装目录 package.json 的 name；本地无 package.json 回落目录名） */
  name?: string;
  /** 已安装版本（package.json version；缺失不设键 —— 不造假数据） */
  version?: string;
  /** 包描述（package.json description；缺失不设键） */
  description?: string;
  /** loaded=有扩展已加载 / installed=在装但无扩展加载 / missing=settings 有但未安装 */
  status: "loaded" | "installed" | "missing";
  /** 该包贡献的资源（按 resolve() 的 metadata.source 归属过滤；含被禁用条目） */
  resources: {
    extensions: PackageResourceRef[];
    skills: PackageResourceRef[];
    prompts: PackageResourceRef[];
    themes: PackageResourceRef[];
  };
  /** 资源摘要（如「1扩展·14技能」；四类全 0 =「无」） */
  resourceSummary: string;
}

/** `GET /packages` 响应体 */
export interface PackagesPayload {
  packages: PackageDetail[];
  /** 全量四类**启用**计数（底部统计条「2 ext · 14 skills · …」口径，参考图2） */
  totals: { extensions: number; skills: number; prompts: number; themes: number };
  /** core 当前 cwd（项目级包的 CWD 字段展示用） */
  cwd: string;
}

/** `POST /packages/toggle` 请求体（整包启用/禁用） */
export interface PackageToggleRequest {
  source: string;
  scope: "user" | "project";
  enabled: boolean;
}
/** `POST /packages/toggle` 响应体（切换后的最新清单，UI 整体替换） */
export interface PackageToggleResult {
  packages: PackagesPayload;
}

/** `POST /packages/remove` 请求体 */
export interface PackageRemoveRequest {
  source: string;
  scope: "user" | "project";
}
/** `POST /packages/remove` 响应体（移除并落盘后的最新清单） */
export interface PackageRemoveResult {
  packages: PackagesPayload;
}

/** `POST /session/reload` 响应体（重新加载会话：重读 settings+资源+扩展，历史保留） */
export interface SessionReloadResult {
  ok: boolean;
}

/* ----- C8 · B2：安装 / 检查更新（npm/git 源需联网；本地路径包离线可用） ----- */

/** `POST /packages/install` 请求体（source=npm:/git:/本地路径；local=true 装到项目级） */
export interface PackageInstallRequest {
  source: string;
  local?: boolean;
}
/** `POST /packages/install` 响应体（安装并落盘后的最新清单） */
export interface PackageInstallResult {
  packages: PackagesPayload;
}

/** 可更新项（0.99.2 PackageUpdate：npm=registry 有新版 / git=远端有新提交；本地包不参与） */
export interface PackageUpdateEntry {
  source: string;
  displayName: string;
  type: "npm" | "git";
  scope: "user" | "project";
}

/** `POST /packages/check-updates` 响应体（需联网；本地路径包自动跳过） */
export interface PackageUpdatesPayload {
  updates: PackageUpdateEntry[];
}

/** `POST /packages/update` 请求体（缺 source = 更新全部已配置包） */
export interface PackageUpdateRequest {
  source?: string;
}
/** `POST /packages/update` 响应体（更新后的最新清单） */
export interface PackageUpdateResult {
  packages: PackagesPayload;
}

/**
 * SSE · 包操作进度（安装/移除/更新进行中）。
 * 由 `DefaultPackageManager.setProgressCallback` 桥接 core 事件管道直接生成，
 * 不经 toAgentEvent 翻译（与 usage/cwd_changed 同类）。
 */
export interface PackageProgressEvent {
  type: "package_progress";
  action: "install" | "remove" | "update" | "clone" | "pull";
  source: string;
  /** 进度文案（Pi 原生 withProgress 的 message 原文） */
  message?: string;
}
