/**
 * mock 数据类型 —— 刻意对齐 Pi 的事件模型。
 *
 * 为什么要按 Pi 的事件结构设计：本阶段是纯前端原型（不接 LLM），但下阶段要接
 * `pi-coding-agent` 的 `createAgentSession()`。届时只需把真实事件流映射成这里的数据，
 * UI 组件一行都不用改。映射关系见 .plan/screens.md 第四节。
 *
 * ⚠️ 本文件是 M2 的**冻结契约**：字段名与语义已定稿，多个组件与并行执行方都以它为准。
 * 需要扩展时只允许**新增可选字段**并在下方注明，不要改名或改动已有字段的语义。
 */

/* ---------------------------------------------------------------------------
 * 枚举
 * ------------------------------------------------------------------------- */

export type MessageRole = "user" | "assistant";

/** 执行计划单步状态（验收 2-6 要求四态齐全） */
export type PlanStepStatus = "pending" | "running" | "done" | "failed";

/** 终端步骤 / 工具调用状态 */
export type ToolStatus = "running" | "success" | "error";

/**
 * 思考强度 —— 取值直接对齐 Pi 的 `set_thinking_level`。
 * 设计稿工具条只暴露 Low / High / Max 三档，但类型保留全集，避免下阶段接真数据时改类型。
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** MCP 服务器连接状态 */
export type McpStatus = "connected" | "disconnected";

/* ---------------------------------------------------------------------------
 * 消息流 Block —— 与 Pi 事件一一对应
 * ------------------------------------------------------------------------- */

/** ← `message_update` → `text_delta`。content 为 markdown 源码 */
export interface TextBlock {
  type: "text";
  content: string;
  /** 流式进行中：用于渲染光标与「正在输出」态 */
  streaming?: boolean;
}

/** ← `message_update` → `thinking_delta` */
export interface ThinkingBlock {
  type: "thinking";
  content: string;
  /** 默认是否折叠（原型里由用户点开） */
  collapsed?: boolean;
}

/** ← `message_update` → `toolcall_delta`（工具调用的参数累积） */
export interface ToolCallBlock {
  type: "tool_call";
  toolCallId: string;
  /** read / bash / edit / write，或 MCP 工具名 */
  toolName: string;
  args: Record<string, unknown>;
  status?: ToolStatus;
}

/** ← `tool_execution_start` / `_update` / `_end`（bash 输出流式累积） */
export interface TerminalBlock {
  type: "terminal";
  toolCallId: string;
  command: string;
  output: string;
  exitCode?: number;
  status: ToolStatus;
  /** 输出被截断（验收 2-7 要求给出「查看完整内容」入口） */
  truncated?: boolean;
  /** 截断时省略的内容行数，用于「还有 N 行」提示 */
  hiddenLineCount?: number;
}

/** ← Extension UI Protocol 的 `select` / `confirm` 请求-响应 */
export interface ApprovalBlock {
  type: "approval";
  /** 对应 Pi 的 `extension_ui_request.id` */
  requestId: string;
  title: string;
  message?: string;
  /** 如 ["允许", "拒绝"] */
  options: string[];
  /** 用户已经做出的选择；有值即表示已决（验收 2-8 要求已决后不可再点） */
  resolved?: string;
}

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
}

/** 自建能力（Pi 不内置 plan mode），仅 UI 侧的数据结构 */
export interface PlanBlock {
  type: "plan";
  steps: PlanStep[];
}

export type Block = TextBlock | ThinkingBlock | ToolCallBlock | TerminalBlock | ApprovalBlock | PlanBlock;

export type BlockType = Block["type"];

/**
 * Block 类型收窄。
 * 用途：`if (isBlock(block, "terminal")) { block.command }` —— 避免渲染层到处写 as 断言。
 */
export function isBlock<T extends BlockType>(block: Block, type: T): block is Extract<Block, { type: T }> {
  return block.type === type;
}

/* ---------------------------------------------------------------------------
 * 会话
 * ------------------------------------------------------------------------- */

export interface Message {
  id: string;
  role: MessageRole;
  blocks: Block[];
  /** epoch ms */
  timestamp: number;
}

export interface Session {
  id: string;
  title: string;
  /** epoch ms */
  updatedAt: number;
  messages: Message[];
}

/** 侧边栏历史会话条目（不含消息体，避免列表页加载整棵会话） */
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

/* ---------------------------------------------------------------------------
 * 工具条 / Token 统计
 * ------------------------------------------------------------------------- */

/** ← `get_session_stats` 的 tokens + contextUsage */
export interface TokenUsage {
  /** 输入 token，12.4k → 12400 */
  input: number;
  /** 输出 token */
  output: number;
  /** 合计消耗 */
  total: number;
  /** 上下文窗口上限，128k → 128000 */
  contextWindow: number;
}

/** ← `get_available_models` */
export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  /** 只有支持的模型才暴露 xhigh / max 档位（对齐 Pi 的说明） */
  supportsXhigh?: boolean;
}

/** 自建能力的展示位 —— Pi 不内置 MCP */
export interface McpServer {
  id: string;
  name: string;
  status: McpStatus;
  toolCount: number;
}
