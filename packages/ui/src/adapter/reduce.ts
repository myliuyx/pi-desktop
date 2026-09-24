/**
 * Pi 事件 → UI `Message[]` 的适配层（S1 裁定的**带状态纯 reducer**）。
 *
 * 形态：`(state, event) => state`，输入确定、无副作用，可用真实事件 dump 回放做单测。
 * 为什么不是无状态纯函数：需要维护「当前 assistant 消息」与「按 toolCallId 索引的终端块」。
 * 为什么不是直接写 store：与 React / zustand 解耦才好单测。
 *
 * 依据：`.plan/archive/survey/S1-event-mapping.md`（映射表与实测结论）
 */

import type { ApprovalBlock, Block, Message, TerminalBlock } from "../mock/types.ts";
import type { AgentContentPart, AgentEvent, AgentMessage } from "./pi-events.ts";

export interface DraftState {
	messages: Message[];
	/** 当前正在流式输出的 assistant 消息 id；null 表示没有进行中的消息 */
	currentAssistantId: string | null;
	streaming: boolean;
}

export function createDraft(messages: Message[] = []): DraftState {
	return { messages, currentAssistantId: null, streaming: false };
}

/* ---------------------------------------------------------------------------
 * 内部工具
 * ------------------------------------------------------------------------- */

/** content[] → Block[]。streaming 只标在**最后一段** text 上（前面的已经写完）。 */
function blocksFrom(parts: AgentContentPart[], streaming: boolean): Block[] {
	const lastTextIndex = parts.reduce((acc, p, i) => (p.type === "text" ? i : acc), -1);
	const lastIndex = parts.length - 1;
	return parts.map((part, index): Block => {
		if (part.type === "text") {
			return { type: "text", content: part.text, streaming: streaming && index === lastTextIndex };
		}
		if (part.type === "thinking") {
			/*
			 * 思考段“进行中”的判定：流式中、且它是**当前最后一个 part**（正在增长的那段）。
			 * 一旦后面出现 text / toolCall，该思考段就不再是最后一段 → streaming=false，
			 * ThinkingCard 自动收起（「思考完了再收起」）。
			 */
			return {
				type: "thinking",
				content: part.thinking,
				collapsed: true,
				streaming: streaming && index === lastIndex,
			};
		}
		return {
			type: "tool_call",
			toolCallId: part.id,
			toolName: part.name,
			args: part.arguments,
			status: "running",
		};
	});
}

function isRenderable(message: AgentMessage): boolean {
	// system 不渲染；user 由调用方（UI 自己发的）管理，避免重复
	return message.role === "assistant";
}

function replaceMessage(messages: Message[], id: string, update: (message: Message) => Message): Message[] {
	return messages.map((m) => (m.id === id ? update(m) : m));
}

/** 找到某条消息里的终端块并更新；没找到原样返回 */
function updateTerminal(
	messages: Message[],
	toolCallId: string,
	update: (block: TerminalBlock) => TerminalBlock,
): Message[] {
	return messages.map((message) => ({
		...message,
		blocks: message.blocks.map((block) =>
			block.type === "terminal" && block.toolCallId === toolCallId ? update(block) : block,
		),
	}));
}

function lastAssistantId(messages: Message[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") return messages[i].id;
	}
	return null;
}

function findTerminalOwner(messages: Message[], toolCallId: string): string | null {
	for (const message of messages) {
		for (const block of message.blocks) {
			const isOwner =
				(block.type === "terminal" && block.toolCallId === toolCallId) ||
				(block.type === "tool_call" && block.toolCallId === toolCallId);
			if (isOwner) return message.id;
		}
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") return messages[i].id;
	}
	return null;
}

function textOf(message: AgentMessage): string {
	return message.content
		.filter((part): part is Extract<AgentContentPart, { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("");
}

/* ---------------------------------------------------------------------------
 * reducer
 * ------------------------------------------------------------------------- */

export function applyEvent(state: DraftState, event: AgentEvent): DraftState {
	switch (event.type) {
		case "agent_start":
			return { ...state, streaming: true };

		case "agent_settled": {
			const messages = state.currentAssistantId
				? replaceMessage(state.messages, state.currentAssistantId, (m) => ({
						...m,
						blocks: m.blocks.map((b) => (b.type === "text" ? { ...b, streaming: false } : b)),
					}))
				: state.messages;
			return { messages, currentAssistantId: null, streaming: false };
		}

		case "message_start": {
			if (!isRenderable(event.message)) return state;
			// 实测：一次 prompt 可产生多条 assistant 消息（多 turn），所以这里要能**追加**
			const id = `a-${state.messages.length}`;
			return {
				messages: [
					...state.messages,
					{
						id,
						role: "assistant",
						blocks: blocksFrom(event.message.content, true),
						timestamp: event.message.timestamp ?? 0,
					},
				],
				currentAssistantId: id,
				streaming: true,
			};
		}

		case "message_update": {
			if (!isRenderable(event.message) || !state.currentAssistantId) return state;
			const id = state.currentAssistantId;
			return {
				...state,
				messages: replaceMessage(state.messages, id, (m) => ({
					...m,
					blocks: blocksFrom(event.message.content, true),
				})),
			};
		}

		case "message_end": {
			if (!isRenderable(event.message)) return state;
			// toolResult 不渲染成消息，只用来补全终端块
			if (event.message.role === "toolResult" && event.message.toolCallId) {
				const toolCallId = event.message.toolCallId;
				const output = textOf(event.message);
				const status: TerminalBlock["status"] = event.message.isError ? "error" : "success";
				return {
					...state,
					messages: updateTerminal(state.messages, toolCallId, (block) => ({
						...block,
						output: output || block.output,
						status,
					})),
				};
			}
			const id = state.currentAssistantId;
			if (!id) return state;
			return {
				messages: replaceMessage(state.messages, id, (m) => ({
					...m,
					blocks: blocksFrom(event.message.content, false),
				})),
				currentAssistantId: null,
				streaming: false,
			};
		}

		case "tool_execution_start": {
			const ownerId = findTerminalOwner(state.messages, event.toolCallId);
			if (!ownerId) return state;
			const terminal: TerminalBlock = {
				type: "terminal",
				toolCallId: event.toolCallId,
				command: typeof event.args.command === "string" ? event.args.command : "",
				output: "",
				status: "running",
				// 实时执行的终端默认收起：不刷屏，用户点开才看命令与输出
				collapsed: true,
			};
			return {
				...state,
				messages: replaceMessage(state.messages, ownerId, (m) => ({ ...m, blocks: [...m.blocks, terminal] })),
			};
		}

		case "tool_execution_update":
			return {
				...state,
				messages: updateTerminal(state.messages, event.toolCallId, (block) => ({
					...block,
					// 文档：partialResult 是累积值，直接替换
					output: event.output,
				})),
			};

		case "tool_execution_end":
			return {
				...state,
				messages: updateTerminal(state.messages, event.toolCallId, (block) => ({
					...block,
					output: event.output || block.output,
					status: event.isError ? "error" : "success",
				})),
			};

	case "approval_request": {
		// 授权请求挂在当前流式 assistant 消息后（无则挂到最后一条 assistant）
		const ownerId = state.currentAssistantId ?? lastAssistantId(state.messages);
		if (!ownerId) return state;
		const block: ApprovalBlock = {
			type: "approval",
			requestId: event.requestId,
			title: event.title,
			message: event.message,
			options: event.options ?? [],
			// A1：请求形态与占位提示一并透传（缺省为 undefined，mock 行为不变）
			method: event.method,
			placeholder: event.placeholder,
			// C3：请求带超时时一并带下去，卡片据此渲染倒计时/失效态（无则不渲染，mock 行为不变）
			timeoutMs: event.timeoutMs,
			// resolved 不在这里写：未决态由 UI 渲染可点；结算见 approval_settled
		};
		return {
			...state,
			messages: replaceMessage(state.messages, ownerId, (m) => ({ ...m, blocks: [...m.blocks, block] })),
		};
	}

	case "approval_settled": {
		// 乐观写 resolved（Pi 不回显授权结果，UI 自己收卡）
		return {
			...state,
			messages: state.messages.map((m) => ({
				...m,
				blocks: m.blocks.map((block) =>
					block.type === "approval" && block.requestId === event.requestId
						? {
								...block,
								// 主控裁决（复核发现）：input 卡的乐观 resolved 是用户输入的原文，
								// settled(accepted) 覆写会把它冲成 "accepted"（卡片丢失「已提交：文本」）——
								// input 卡已有文本时不覆写。options 卡保持 C3 既有行为（settled 归一为
								// accepted/cancelled，accept 用例依赖此口径），一行未动。
								resolved:
									block.method === "input" && (block.resolved ?? "") !== ""
										? block.resolved
										: event.resolution,
							}
						: block,
				),
			})),
		};
	}

	case "turn_start":
	case "turn_end":
		return state;

	/*
	 * usage 是「会话用量快照」，reducer 只维护消息树 → 不改变状态、原样返回。
	 * 真正的消费在 store 层（chat-store 的 live 订阅把 event.usage 写进 tokenUsage）。
	 * **必须显式列出此 case**：AgentEvent 是判别联合，漏掉会让函数结尾缺少 return
	 * （TS2366），且运行时会返回 undefined，把 liveDraft 打坏、连带断掉 SSE。
	 */
	case "usage":
		return state;

	/*
	 * cwd_changed 是「工作目录已热切换」信号（D7），reducer 只维护消息树 → 原样返回。
	 * 真正的消费在 store 层（chat-store 收到后 refreshSessions 重拉清单与 liveCwd）。
	 * 同 usage：判别联合的新成员必须显式列出，否则 TS2366 + 运行时 undefined。
	 */
	case "cwd_changed":
		return state;
}
}
