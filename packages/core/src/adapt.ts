/**
 * Pi 原生事件 → 我们的 `AgentEvent`（core 侧用）。
 *
 * 为什么放在 core（S4 决策「UI 不认识 Pi」，翻译关在 core 里）：
 * 这一层是纯函数，可以用真实事件 dump 回放做单测，不需要起服务。
 * core 是独立 Node 进程，允许 import pi 包类型；但这里只 `import type` 共享契约，
 * 不引入任何运行时依赖（UI 侧的 `toAgentEvent` 已退役，统一收口到此处）。
 *
 * 实测字段形状见 `.plan/survey/S1-event-mapping.md`。
 */

import type { AgentContentPart, AgentEvent, AgentMessage, AgentMessageRole } from "./contract.ts";

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
	return !!value && typeof value === "object";
}

function asContent(value: unknown): AgentContentPart[] {
	if (!Array.isArray(value)) return [];
	const out: AgentContentPart[] = [];
	for (const part of value) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") out.push({ type: "text", text: part.text });
		else if (part.type === "thinking" && typeof part.thinking === "string")
			out.push({ type: "thinking", thinking: part.thinking });
		else if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string")
			out.push({
				type: "toolCall",
				id: part.id,
				name: part.name,
				arguments: isRecord(part.arguments) ? (part.arguments as Record<string, unknown>) : {},
			});
	}
	return out;
}

/** 工具结果 / 输出：content[] 里的 text 拼起来 */
function textOfContent(value: unknown): string {
	return asContent(value)
		.filter((part): part is Extract<AgentContentPart, { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function asMessage(value: unknown): AgentMessage | null {
	if (!isRecord(value)) return null;
	const role = value.role;
	if (role !== "system" && role !== "user" && role !== "assistant" && role !== "toolResult") return null;
	const message: AgentMessage = { role: role as AgentMessageRole, content: asContent(value.content) };
	if (typeof value.toolCallId === "string") message.toolCallId = value.toolCallId;
	if (typeof value.toolName === "string") message.toolName = value.toolName;
	if (typeof value.isError === "boolean") message.isError = value.isError;
	if (typeof value.timestamp === "number") message.timestamp = value.timestamp;
	return message;
}

/**
 * 把一条 Pi 原始事件翻译成我们的 `AgentEvent`。
 * 返回 null 表示「该事件与 UI 无关」，调用方直接跳过（例如 compaction_* 与 queue_update 等）。
 */
export function toAgentEvent(raw: unknown): AgentEvent | null {
	if (!isRecord(raw) || typeof raw.type !== "string") return null;

	switch (raw.type) {
		case "message_start":
		case "message_update":
		case "message_end": {
			const message = asMessage(raw.message);
			if (!message) return null;
			return { type: raw.type, message } as AgentEvent;
		}
		case "tool_execution_start":
			if (typeof raw.toolCallId !== "string") return null;
			return {
				type: "tool_execution_start",
				toolCallId: raw.toolCallId,
				toolName: typeof raw.toolName === "string" ? raw.toolName : "",
				args: isRecord(raw.args) ? (raw.args as Record<string, unknown>) : {},
			};
		case "tool_execution_update":
			if (typeof raw.toolCallId !== "string") return null;
			return {
				type: "tool_execution_update",
				toolCallId: raw.toolCallId,
				output: textOfContent(isRecord(raw.partialResult) ? raw.partialResult.content : undefined),
			};
		case "tool_execution_end":
			if (typeof raw.toolCallId !== "string") return null;
			return {
				type: "tool_execution_end",
				toolCallId: raw.toolCallId,
				output: textOfContent(isRecord(raw.result) ? raw.result.content : undefined),
				isError: raw.isError === true,
			};
		case "turn_start":
		case "turn_end":
		case "agent_start":
		case "agent_settled":
			return { type: raw.type } as AgentEvent;
		default:
			return null;
	}
}
