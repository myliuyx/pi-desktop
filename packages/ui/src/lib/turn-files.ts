/**
 * 轮次改动文件清单（task-turn-file-chips.md）—— 把一轮里 agent 实际写成功的文件
 * 收成 chips 数据（回复尾部「本次修改文件」行的数据源）。
 *
 * 纯函数、零副作用（同 lib/turns.ts 纪律）：零 React、零 store、不用 node:path
 * （浏览器端语义也不对），路径全部字符串操作，可被 scripts/turn-files-check.mjs
 * `node --experimental-strip-types` 直跑断言。
 *
 * 收录口径（规格书 §三.1，全部落进 check 断言）：
 * - 只认 `edit` / `write` 两工具的 `args.path`（D1=A：bash 产物不做快照 diff，不收集）；
 * - **配对过滤是本批唯一真坑**：args 在 toolCall part 出现时就有，但该次调用可能
 *   失败（terminal status==="error"）或被中止（terminal 没到）——只收录「按 toolCallId
 *   配对到 terminal 且 status==="success"」的调用，否则会把没写成的文件列出来骗人；
 * - 去重键 = 归一化路径；**首触保留**（同一文件先 edit 后 write 只留 edit=「修改」，
 *   已知的简化，规格书 §二自裁表）；顺序 = 首触顺序；
 * - `path` 归一化成 `/` 分隔；相对路径基于 cwd 绝对化（点击用它打开——绝对路径对
 *   core `/fs/read` 的 `path.resolve` 恒定正确，不随 cwd 热切换漂移）；
 *   cwd 为 null 且相对（mock 态可达）→ 原样收录；
 * - `display` 仅展示用：绝对路径在 cwd 下（Windows 大小写不敏感前缀比对）则截成
 *   相对，否则原样；相对路径本来就是相对形态。
 */

import type { Message } from "../mock/types.ts";
import type { TurnGroup } from "./turns.ts";

export interface TurnFileEntry {
	/** 归一化路径（分隔符统一 "/"；相对路径基于 cwd 绝对化）——点击打开用 */
	path: string;
	/** 展示路径：cwd 下则相对 cwd，否则归一化路径原样；相对输入即原样 */
	display: string;
	/** chip 主文本 = basename(display) */
	name: string;
	/** 收录来源工具（首触口径）：edit=「修改」/ write=「写入」 */
	tool: "edit" | "write";
}

/** 分隔符统一成 "/"，再吃掉结尾的 "/"（目录形态的 cwd 也能正确拼前缀） */
function normalize(p: string): string {
	const slashed = p.replace(/\\/g, "/");
	return slashed.length > 1 && slashed.endsWith("/") ? slashed.slice(0, -1) : slashed;
}

/** 绝对路径判定：POSIX 根（/…）或 Windows 盘符（X:/…，大小写不敏感） */
function isAbsolute(p: string): boolean {
	return p.startsWith("/") || /^[a-zA-Z]:\//.test(p);
}

/** cwd 前缀比对（Windows 盘符/目录大小写漂移实况 → 大小写不敏感）；命中返回截掉的相对段 */
function stripCwdPrefix(normalizedPath: string, normalizedCwd: string): string | null {
	if (normalizedCwd === "") return null;
	const p = normalizedPath.toLowerCase();
	const c = normalizedCwd.toLowerCase();
	if (c === "/") return normalizedPath.startsWith("/") ? normalizedPath.slice(1) : null;
	if (!p.startsWith(`${c}/`)) return null;
	return normalizedPath.slice(normalizedCwd.length + 1);
}

function basename(display: string): string {
	const idx = display.lastIndexOf("/");
	return idx >= 0 ? display.slice(idx + 1) : display;
}

/**
 * 收集一轮里写成功的文件。`turn` 来自 lib/turns.ts 的 groupTurns 产物；
 * `cwd` 传 chat-store 的 liveCwd（mock / 未接 live 时为 null，相对路径原样收录）。
 * 返回空数组 = 该轮无 chips（调用方不渲染行）。
 */
export function collectTurnFiles(messages: Message[], turn: TurnGroup, cwd: string | null): TurnFileEntry[] {
	// toolCallId → terminal status（turn 全范围配对；MessageList 的 per-message 配对表同款手法）
	const terminalStatus = new Map<string, string>();
	for (const idx of turn.assistantIndexes) {
		for (const block of messages[idx].blocks) {
			if (block.type === "terminal") terminalStatus.set(block.toolCallId, block.status);
		}
	}

	const normalizedCwd = cwd === null ? null : normalize(cwd);
	const byPath = new Map<string, TurnFileEntry>();

	for (const idx of turn.assistantIndexes) {
		for (const block of messages[idx].blocks) {
			if (block.type !== "tool_call") continue;
			if (block.toolName !== "edit" && block.toolName !== "write") continue;
			const rawPath = block.args.path;
			if (typeof rawPath !== "string" || rawPath.trim() === "") continue;
			// 失败 / 中止（没等到执行事件）的调用不上榜——「实际写成功」是唯一收录口径
			if (terminalStatus.get(block.toolCallId) !== "success") continue;

			const normalized = normalize(rawPath.trim());
			const absolute = isAbsolute(normalized);
			const fullPath = absolute
				? normalized
				: normalizedCwd !== null
					? `${normalizedCwd}/${normalized}`
					: normalized;
			if (byPath.has(fullPath)) continue;

			const display = absolute
				? (normalizedCwd !== null ? stripCwdPrefix(normalized, normalizedCwd) : null) ?? normalized
				: normalized;
			byPath.set(fullPath, {
				path: fullPath,
				display,
				name: basename(display),
				tool: block.toolName,
			});
		}
	}

	return [...byPath.values()];
}

/**
 * 流式闸门（2026-10-02 用户裁决，推翻规格书 §〇「流式中实时累积」）：整轮进行中
 * （send → agent_settled 全窗口）活动轮的 chips 压住不出——最终回复落地才显示。
 *
 * 活动轮 = lastTurnKey 指向的那段（进行中它恒为索引里最后一段）。活动轮尚未开口
 * （messages 尾条还是 user：下一问已发出、模型未回）时**不压**——此时索引里根本
 * 没有活动轮，lastTurnKey 实为上一轮，误压会把上一轮已显示的 chips 在整个等待
 * 空窗里熄掉。中止/断线后 inFlight 已复位（chat-store 同批清零纪律），轮次视为
 * 结束：已写成功的文件照常显示（诚实口径，不因没答完而吞掉实录）。
 *
 * 返回要从 chips 表剔除的轮次键；null = 不剔除。纯函数，供 turn-files-check 断言。
 */
export function inFlightSuppressedTurnKey(
	messages: Message[],
	lastTurnKey: string | null,
	inFlight: boolean,
): string | null {
	if (!inFlight || lastTurnKey === null) return null;
	const last = messages[messages.length - 1];
	return last !== undefined && last.role === "assistant" ? lastTurnKey : null;
}
