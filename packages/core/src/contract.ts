/**
 * 共享契约 —— UI 与 core 之间唯一的类型边界。
 *
 * 设计纪律（C0 规格 + S6 §三）：
 * 1. **纯类型、零 import**：本文件不引入任何运行时依赖（不含 pi-coding-agent、
 *    node:*, core 运行时代码）。UI 只能 `import type` 它，从而 vite build 后
 *    dist 里绝不出现 core/pi 痕迹（硬约束 #2）。
 * 2. Block 六型 / Message / SessionSummary / TokenUsage / PlanStepStatus
 *    字段签名原样搬自 `packages/ui/src/mock/types.ts`（M2 冻结契约），不改任何字段。
 * 3. AgentEvent 全集原样搬自 `packages/ui/src/adapter/pi-events.ts`，并做三处修订：
 *    - 新增 `approval_request` / `approval_settled`（我们的形状，非 Pi 9 变体）；
 *    - `tool_execution_end`：补 `result` 形状 `{ content; details? }`、`isError`，
 *      明确不设 `exitCode` / `truncated`（spike-tools 实证事件里没有）；
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

export type Block =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | TerminalBlock
  | ApprovalBlock
  | PlanBlock;

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
  | { type: "cwd_changed"; cwd: string };

/* ---------------------------------------------------------------------------
 * C6 · 04 屏工具开关（`GET /tools/active` / `POST /tools/active {names}`）
 *
 * API 依据（@earendil-works/pi-coding-agent@0.87.1，`core/agent-session.d.ts`）：
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
  /** 兼容性标记（对齐 models.json 原生 `compat`，可选） */
  compat?: string;
  /**
   * 高级：API 端点覆盖（UI 表单「高级设置」字段，非 models.json 标准字段，原样透传）。
   * 写回时作为 model 节点的扩展键保留，读回再回填表单。
   */
  endpointOverride?: string;
}

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
