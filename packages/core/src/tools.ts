/**
 * C6 · 04 屏工具开关 —— `AgentSession` 工具启用状态的读取与写入。
 *
 * API 依据（@earendil-works/pi-coding-agent@0.87.1，`core/agent-session.d.ts` 实查）：
 * - `getActiveToolNames(): string[]`（d.ts:337）—— 当前启用清单的 getter；
 * - `setActiveToolsByName(toolNames: string[]): void`（d.ts:349）—— 0.86 源码同名
 *   （`agent-session.ts:2972` 附近），0.87.1 未改名；
 * - `getAllTools(): ToolInfo[]`（d.ts:341）—— 注册表全集（含扩展注册的工具）。
 *
 * ⚠️ 上游语义：`setActiveToolsByName` 对**未注册名字静默忽略**（d.ts:345
 * "Unknown tool names are ignored"）—— 静默忽略会让「点了开关没生效」无人知晓
 * （教训 #1 的反面：这里必须在 core 侧先校验、未知名显式抛错 → 端点回 400）。
 * 另注：setter 会重建系统提示，"Changes take effect on the next agent turn"。
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ToolsPayload } from "./contract.ts";

/** 读取当前工具启用状态（`GET /tools/active`） */
export function getToolsState(session: AgentSession): ToolsPayload {
	return {
		active: session.getActiveToolNames(),
		available: session.getAllTools().map((t) => t.name),
	};
}

/**
 * 设置启用工具集（`POST /tools/active {names}`）。
 * 未注册的名字抛错（由端点转 400），**不依赖上游的静默忽略**。
 */
export function setToolsState(session: AgentSession, names: string[]): ToolsPayload {
	const known = new Set(session.getAllTools().map((t) => t.name));
	const unknown = names.filter((n) => !known.has(n));
	if (unknown.length > 0) {
		throw new Error(`未知工具名：${unknown.join("、")}（注册表中可用：${[...known].join("、")}）`);
	}
	session.setActiveToolsByName(names);
	return getToolsState(session);
}
