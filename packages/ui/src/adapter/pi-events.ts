/**
 * Agent 事件协议 —— **我们自己的类型，不 import Pi 包**。
 *
 * 为什么要自己定义一层（S4 决策）：
 * 1. UI 不依赖 `pi-coding-agent`（Node 包），打包干净；
 * 2. 与 mock 数据同构 → 验收脚本不用 core 也能跑 mock 回归；
 * 3. Pi 升级导致事件形状变化时，改动被关在 core 里。
 *
 * 由 `packages/core` 把 Pi 事件翻译成这里的形状再下发。
 * 字段来源见 `.plan/survey/S1-event-mapping.md`。
 */

import type { TokenUsage } from "../mock/types.ts";

/** assistant 消息体里的一个内容片段（对应 Pi 的 `message.content[]`） */
export type AgentContentPart =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export type AgentMessageRole = "system" | "user" | "assistant" | "toolResult";

export interface AgentMessage {
	role: AgentMessageRole;
	content: AgentContentPart[];
	/** role=toolResult 时携带 */
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	timestamp?: number;
	usage?: Partial<TokenUsage>;
}

export type AgentEvent =
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| { type: "tool_execution_update"; toolCallId: string; output: string }
	| { type: "tool_execution_end"; toolCallId: string; output: string; isError: boolean }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "agent_start" }
	| { type: "agent_settled" };
