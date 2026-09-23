/**
 * `ExtensionUIContext` 正式实现 —— 授权通道（C3 由 `session.ts` 里的最小实现转正）。
 *
 * 形态依据（`survey/S3-tool-approval.md`）：
 * - 授权通道**不是**消费 Pi 的 `extension_ui_request` 事件，而是 **core 自己实现
 *   `ExtensionUIContext` 接口**（`extension_ui_request` 只是 RPC 模式对该接口的序列化），
 *   core 经 `session.bindExtensions({ uiContext, mode: "rpc" })` 注入（S3 §2.3/§2.5）。
 * - **requestId 由我们自己生成**（Pi SDK 模式不给 id）—— 照抄 `rpc-mode.ts:99` 的 `crypto.randomUUID()`。
 * - **幂等**：`/approve` 先 delete 再 resolve（照 `rpc-mode.ts:776-781`）；未知/已决/过期 id
 *   一律静默 `accepted:false`、不报错。
 * - **Pi 不回显授权结果**（hook 返回值不是事件，S3 §3.3）→ `approval_settled` 是**我们造的**，
 *   供 UI 收卡（乐观写入；`ApprovalBlock.resolved` 本来就是 UI 侧乐观态）。
 * - **超时**：Pi 自己会用默认值收尾，但超时后 id 已从 Map 移除，用户再点会被静默丢弃
 *   （「点了没反应」，S3 §3.2）→ 我们同样到点收尾并**下发 `settled(cancelled)`**，
 *   让 UI 能立刻收卡（UI 侧另有倒计时兜底，见 `ApprovalCard`）。
 *
 * ⚠️ 我方 `pending` Map 比 Pi 的 `rpc-mode.ts:80-83` 多存一个 `method`：
 * 应答要按 method 还原成 `string | boolean` 两种语义（`confirm` 是布尔）。
 */

import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AgentEvent } from "./contract.ts";

export type ApprovalMethod = "select" | "confirm" | "input";

/** 授权请求事件（契约形状，非 Pi 的 9 变体） */
export type ApprovalRequestEvent = Extract<AgentEvent, { type: "approval_request" }>;

/**
 * `confirm` 的选项文案。
 * Pi 的 `confirm(title, message)` 不带选项，而 UI 的 `ApprovalBlock.options` 是必需字段
 * （卡片靠它渲染按钮）→ 我们替 Pi 补一套文案，并把「肯定答案」定死在下面这个常量上。
 */
export const CONFIRM_OPTIONS = ["允许", "拒绝"] as const;
/** `confirm` 的肯定答案：UI 传中文文案；`"true"` 是给按 RPC 语义应答的调用方留的口子 */
export const CONFIRM_AFFIRMATIVE = "允许";

interface PendingEntry {
	/** 已下发的请求事件（重放用） */
	event: ApprovalRequestEvent;
	resolve: (value: string | undefined) => void;
	/** 超时定时器；无限等待时为 null */
	timer: ReturnType<typeof setTimeout> | null;
}

/** 授权通道对外能力（core 内部用；`CoreRuntime` 转发其中一部分） */
export interface UiBridge {
	/** 注入给 Pi 的 uiContext（`bindExtensions` 用） */
	uiContext: ExtensionUIContext;
	/** 幂等应答：未决 → delete-then-resolve+settled(accepted)；否则 `accepted:false` */
	approve(requestId: string, choice: string): { accepted: boolean };
	/** 取消：未决 → delete+settled(cancelled) 并以「取消」结算；未知 id 静默忽略 */
	cancel(requestId: string): { accepted: boolean };
	/** 当前未决请求（SSE 新连接时补发；`dispose` 后为空） */
	listPending(): ApprovalRequestEvent[];
	pendingCount(): number;
	/** core 内部发起一次提问（信任门用；与扩展提问走同一条通道） */
	ask(title: string, options: string[], timeoutMs?: number): Promise<string | undefined>;
	/** 释放全部未决请求（进程退出/会话销毁时，避免扩展永久 await） */
	dispose(): void;
}

export function createUiBridge(opts: { emit: (event: AgentEvent) => void }): UiBridge {
	const pending = new Map<string, PendingEntry>();

	/**
	 * 结算一笔未决请求。**顺序有意为之**：
	 * ① 先 delete（防协议层重复，与 Pi 的 first-write-wins 一致）
	 * ② 先下发 `approval_settled` 再 resolve —— resolve 会让扩展立刻恢复执行。
	 *
	 * 实测到的整体顺序（C3 取证，见 `run/c3-evidence.json`）：
	 * `tool_execution_start → approval_request → approval_settled → tool_execution_end`
	 * —— `tool_execution_start` **先于**提问（`tool_call` hook 在执行包装内部被调用），
	 * 所以「先发 settled 再 resolve」保证的是「结算帧先于**结果帧**（_end）」，
	 * 而不是「先于整个工具事件流」。
	 */
	const settle = (requestId: string, resolution: "accepted" | "cancelled", value: string | undefined): boolean => {
		const entry = pending.get(requestId);
		if (!entry) return false; // 未知 / 已决 / 过期：静默忽略，不报错
		pending.delete(requestId);
		if (entry.timer) clearTimeout(entry.timer);
		opts.emit({ type: "approval_settled", requestId, resolution });
		entry.resolve(value);
		return true;
	};

	const dialog = (
		method: ApprovalMethod,
		title: string,
		extra: Partial<Pick<ApprovalRequestEvent, "options" | "message" | "placeholder">>,
		timeout?: number,
	): Promise<string | undefined> =>
		new Promise<string | undefined>((resolve) => {
			const requestId = randomUUID();
			const timeoutMs = typeof timeout === "number" && timeout > 0 ? timeout : undefined;
			const event: ApprovalRequestEvent = { type: "approval_request", requestId, method, title, ...extra };
			if (timeoutMs !== undefined) event.timeoutMs = timeoutMs;
			const timer =
				timeoutMs === undefined
					? null
					: setTimeout(() => {
							// 到点自动以「取消」收尾：下发 settled(cancelled) 并 resolve 默认值。
							// select/input 的默认值是 undefined（扩展读到「用户取消」而非「拒绝」）；
							// confirm 由下面的包装映射成 false —— 与 Pi `rpc-mode.ts:115-120` 的语义对齐。
							settle(requestId, "cancelled", undefined);
						}, timeoutMs);
			pending.set(requestId, { event, resolve, timer });
			opts.emit(event);
		});

	const uiContext = {
		select: (title: string, options: string[], o?: { timeout?: number }) =>
			dialog("select", title, { options }, o?.timeout),
		confirm: async (title: string, message: string, o?: { timeout?: number }) => {
			const value = await dialog("confirm", title, { message, options: [...CONFIRM_OPTIONS] }, o?.timeout);
			return value === CONFIRM_AFFIRMATIVE || value === "true";
		},
		input: (title: string, placeholder?: string, o?: { timeout?: number }) =>
			dialog("input", title, { placeholder }, o?.timeout),
		// notify 不进 SSE：契约无 notification 类型，UI reducer 消费不了；留日志便于排查。
		notify: (message: string) => {
			console.debug(`[core] uiContext.notify: ${message}`);
		},
		// 终端 / TUI 专属方法：安全空实现（S3 §2.6：**不可省略**，
		// 但也不能给 select/confirm/input 留空 —— 那会被扩展读成「用户取消了」）。
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: <T>(..._args: unknown[]): Promise<T> => Promise.resolve(undefined as unknown as T),
	} as unknown as ExtensionUIContext;

	return {
		uiContext,
		approve: (requestId, choice) => ({ accepted: settle(requestId, "accepted", choice) }),
		cancel: (requestId) => ({ accepted: settle(requestId, "cancelled", undefined) }),
		listPending: () => [...pending.values()].map((entry) => entry.event),
		pendingCount: () => pending.size,
		ask: (title, options, timeoutMs) => dialog("select", title, { options }, timeoutMs),
		dispose: () => {
			for (const entry of pending.values()) {
				if (entry.timer) clearTimeout(entry.timer);
				entry.resolve(undefined);
			}
			pending.clear();
		},
	};
}
