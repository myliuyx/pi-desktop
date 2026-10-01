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
	/**
	 * 下一轮模型响应「已请求、尚未开始流式」（task-waiting-row-turn-start.md F1）。
	 * `turn_start` 置位 —— pi 在每轮 HTTP 请求发出前必发（首轮 agent-loop.ts:117、
	 * 第 2+ 轮 :205，均在工具结果回传完之后），工具执行期不置位，不会误显「等待模型回复」；
	 * assistant `message_start`（响应流已打开）与 `agent_settled`（整轮终态）清除。
	 * MessageList 的等待占位行据此覆盖上一轮 message_end 到本轮首字之间的 TTFB 空窗。
	 */
	awaitingModel: boolean;
}

export function createDraft(messages: Message[] = []): DraftState {
	return { messages, currentAssistantId: null, streaming: false, awaitingModel: false };
}

/* ---------------------------------------------------------------------------
 * 授权请求辅助（hostless-approval-overlay 批次）
 * ------------------------------------------------------------------------- */

/**
 * `approval_request` 是否有宿主可挂 —— 镜像下方 approval_request case 的宿主判据
 * （`currentAssistantId ?? 最后一条 assistant`）。
 *
 * 无宿主 = 事件进消息树会被 case 里的 `if (!ownerId) return state` **静默丢弃**。
 * 信任门提问恰恰发生在零消息时刻（cwd 切换/启动期，新建会话草稿态 liveDraft 为空树）
 * → chat-store 的 SSE 路由据此把无宿主事件改落顶层 `pendingApprovals`，由 App 级
 * ApprovalOverlay 渲染；有宿主照旧走消息树（流式工具审批行为零变化）。
 */
export function approvalRequestHasHost(state: Pick<DraftState, "messages" | "currentAssistantId">): boolean {
	return (state.currentAssistantId ?? lastAssistantId(state.messages)) !== null;
}

/**
 * `approval_request` 事件 → `ApprovalBlock`：消息树内嵌卡与全局浮层**共用一份映射**，
 * 口径只有一处（options 缺省归一为 `[]`；method/placeholder/timeoutMs 缺省透传为
 * undefined；resolved 不在此写 —— 未决态由渲染层可点，结算见 approval_settled）。
 */
export function approvalEventToBlock(event: Extract<AgentEvent, { type: "approval_request" }>): ApprovalBlock {
	return {
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
	};
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
			return { messages, currentAssistantId: null, streaming: false, awaitingModel: false };
		}

		case "message_start": {
			if (!isRenderable(event.message)) return state;
			// 实测：一次 prompt 可产生多条 assistant 消息（多 turn），所以这里要能**追加**
			// 壳在此刻先追加（模型名/时间戳先挂上）；渲染层把「首个可见块之前」的空壳整行
			// 藏掉（2026-09-28 裁决·方向A，见 MessageList shellHidden）—— 数据层照旧，
			// pending 判定 / currentAssistantId 挂载 / 事件回放断言均不受影响。
			// 此处顺路清 awaitingModel：响应流已打开，「等待下一轮」结束（占位行由
			// 空壳分支无缝接手，首个可见块到达后一并让位）
			const id = `a-${state.messages.length}`;
			return {
				messages: [
					...state.messages,
					{
						id,
						role: "assistant",
						blocks: blocksFrom(event.message.content, true),
						timestamp: event.message.timestamp ?? 0,
						// 模型是请求参数，message_start 即有 → 流式中左上角就能显示（比 usage 早）
						...(event.message.model ? { model: event.message.model } : {}),
					},
				],
				currentAssistantId: id,
				streaming: true,
				awaitingModel: false,
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
			// 模型请求失败直出（2026-09-28 用户裁决）：errorMessage 只在 message_end 出现，
			// 出现即挂到消息上（渲染层据此出错误框，空壳不再整行隐藏）。
			// 壳缺失时兜底追加而不是丢弃 —— 重连后只收到 end 的终态消息不再凭空消失。
			const errorPatch = event.message.errorMessage
				? { errorMessage: event.message.errorMessage }
				: {};
			if (!id) {
				const fallbackId = `a-${state.messages.length}`;
				return {
					messages: [
						...state.messages,
						{
							id: fallbackId,
							role: "assistant",
							blocks: blocksFrom(event.message.content, false),
							timestamp: event.message.timestamp ?? 0,
							...(event.message.model ? { model: event.message.model } : {}),
							...(event.message.usage ? { usage: event.message.usage } : {}),
							...errorPatch,
						},
					],
					currentAssistantId: null,
					awaitingModel: false,
					streaming: false,
				};
			}
			return {
				messages: replaceMessage(state.messages, id, (m) => ({
					...m,
					blocks: blocksFrom(event.message.content, false),
					/*
					 * F2：逐条计量随 message_end 挂回消息（消息 footer 的数据源）。
					 * usage 只在此刻到达 —— 流式中 footer 天然不渲染，数字不会中途跳动；
					 * 中止/失败的消息没有 usage，footer 不渲染（诚实展示）。
					 */
					...(event.message.usage ? { usage: event.message.usage } : {}),
					/*
					 * 模型标签（2026-09-27 用户裁决）：message_end 补挂/覆写 ——
					 * responseModel（实际响应模型）此刻才确定，展示口径取 responseModel ?? model。
					 */
					...(event.message.model ? { model: event.message.model } : {}),
					...(event.message.responseModel ? { responseModel: event.message.responseModel } : {}),
					...errorPatch,
				})),
				currentAssistantId: null,
				// awaitingModel 此刻本就为 false（message_start 已清），显式写为保证字段完整
				awaitingModel: false,
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
					// 结构化详情透传（task-tool-diff-preview.md）：edit 的展示用 diff；
					// 无则不写键，渲染层缺省回落 output 文本
					...(event.details ? { details: event.details } : {}),
				})),
			};

	case "approval_request": {
		// 授权请求挂在当前流式 assistant 消息后（无则挂到最后一条 assistant）。
		// 无宿主（信任门在空树时提问）不会走到这里 —— chat-store 的 SSE 路由已按
		// approvalRequestHasHost 把这类事件改落顶层 pendingApprovals（全局浮层渲染）。
		const ownerId = state.currentAssistantId ?? lastAssistantId(state.messages);
		if (!ownerId) return state;
		// 块构造与全局浮层共用 approvalEventToBlock（hostless-approval-overlay 批次收敛）
		const block: ApprovalBlock = approvalEventToBlock(event);
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

	/*
	 * turn_start：每轮模型请求发出前必发（时机依据见 DraftState.awaitingModel 注释）→
	 * 置位等待态，等待占位行据此覆盖 TTFB 空窗（2026-09-28 裁决，F1/F2）。
	 * turn_end 是轮次结束标记，reducer 只维护消息树与等待态 → 原样返回。
	 */
	case "turn_start":
		return { ...state, awaitingModel: true };
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

	/*
	 * C8：包操作进度（安装/移除/更新）不进会话状态 —— 消费方是设置弹窗的插件 Tab
	 *（自行订阅 transport 过滤该类型，弹窗内展示进度文案）。同上：新成员必须显式列出。
	 */
	case "package_progress":
		return state;

	case "compaction_start":
	case "compaction_end":
		/*
		 * 斜杠命令批次：压缩进度由 chat-store 的 SSE 订阅层消费（常驻 toast + compacting 标志），
		 * 不进消息树。此 reducer 对 AgentEvent 无 default —— 新成员必须显式列出，否则
		 * switch 非穷尽（TS2366）且运行时返回 undefined 会让调用方读 `.messages` 崩溃。
		 */
		return state;

	/*
	 * S2：技能安装进度（克隆/定位/拷贝阶段文案）不进会话状态 —— 消费方是设置弹窗
	 * 的技能 Tab（自行订阅 transport 过滤该类型）。同上：新成员必须显式列出。
	 */
	case "skill_progress":
		return state;
	}
}
