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
}

/** ← Extension UI Protocol 的 `select` / `confirm` 请求-响应 */
export interface ApprovalBlock {
  type: "approval";
  /** 对应授权请求 id */
  requestId: string;
  title: string;
  message?: string;
  /** 如 ["允许", "拒绝"] */
  options: string[];
  /** 有值即表示已决（UI 乐观写入；Pi 不回显结果） */
  resolved?: string;
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

/* ---------------------------------------------------------------------------
 * Token 统计
 * ------------------------------------------------------------------------- */

/** ← `get_session_stats` 的 tokens + contextUsage */
export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  contextWindow: number;
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
  usage?: Partial<TokenUsage>;
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
    };
