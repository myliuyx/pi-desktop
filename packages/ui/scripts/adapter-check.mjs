/**
 * 适配层回归断言 —— 用**真实 Pi 事件 dump** 回放，验证 Pi 事件 → UI Message[] 的映射。
 *
 * 为什么值得单独一个脚本：这类缺陷不报错、不影响 tsc、构建也通过，
 * 只表现为「消息流悄悄少一条 / 卡片一直转圈」，从代码上完全看不出来。唯一可靠的防线是断言。
 *
 * 运行：node --experimental-strip-types scripts/adapter-check.mjs
 * fixture 来源：真实会话 dump（pi/_poc/dump-events.ts，已精简掉 system prompt 等大字段）
 */

import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEvent, createDraft } from "../src/adapter/reduce.ts";
import { toAgentEvent } from "../src/adapter/from-pi.ts";

const here = dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
	const pathTo = join(here, "fixtures", name);
	return fs
		.readFileSync(pathTo, "utf8")
		.split("\n")
		.filter(Boolean)
		// dump 脚本会写 [dump] 开头的日志行，只取 JSON 事件
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line));
}

/** 回放整条事件流 */
function replay(events, draft = createDraft()) {
	let state = draft;
	let skipped = 0;
	for (const raw of events) {
		const event = toAgentEvent(raw);
		if (!event) {
			skipped++;
			continue;
		}
		state = applyEvent(state, event);
	}
	return { state, skipped };
}

const fails = [];
let passed = 0;
function check(label, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) passed++;
	else fails.push(`${label}\n    实际: ${JSON.stringify(actual)}\n    期望: ${JSON.stringify(expected)}`);
}

function blocksOfType(state, type) {
	return state.messages.flatMap((m) => m.blocks.filter((b) => b.type === type));
}

/* -------------------------------------------------------------------------
 * 一、纯文本会话（fx-pong）
 * ---------------------------------------------------------------------- */
{
	const events = loadFixture("pi-events-pong.jsonl");
	const { state, skipped } = replay(events);

	check("[pong] 只渲染 assistant 消息（system/user 被过滤）", state.messages.length, 1);
	check("[pong] assistant 消息含 thinking + text 两个 Block", state.messages[0].blocks.map((b) => b.type), [
		"thinking",
		"text",
	]);
	check("[pong] text 内容是 pong", blocksOfType(state, "text")[0].content, "pong");
	check("[pong] 终态 streaming=false", state.streaming, false);
	check("[pong] 终态无进行中的 assistant", state.currentAssistantId, null);
	check("[pong] 所有 text block 都不再 streaming", blocksOfType(state, "text").every((b) => b.streaming === false), true);
	check("[pong] 确实有事件被跳过（system/user/未知）", skipped > 0, true);
}

/* -------------------------------------------------------------------------
 * 二、工具会话（fx-tool）—— 多 turn 是关键
 * ---------------------------------------------------------------------- */
{
	const events = loadFixture("pi-events-tool.jsonl");
	const { state } = replay(events);

	const assistantCount = state.messages.filter((m) => m.role === "assistant").length;
	// 期望值一律从 fixture 现读（模型每次尝试的路径数不固定），不写死数字
	const starts = events.filter((e) => e.type === "tool_execution_start");
	const ends = events.filter((e) => e.type === "tool_execution_end");
	const expectedAssistants = events.filter((e) => e.type === "message_start" && e.message?.role === "assistant").length;

	check("[tool] assistant 消息数与 message_start 数一致", assistantCount, expectedAssistants);
	check("[tool] 一次 prompt 跨多个 turn（实测 ≥3）", assistantCount >= 3, true);

	const terminals = blocksOfType(state, "terminal");
	check("[tool] 终端块数 == tool_execution_start 数", terminals.length, starts.length);
	check("[tool] 首个终端块命令与事件一致", terminals[0].command, starts[0].args.command);
	check(
		"[tool] 终端块状态与 isError 一一对应",
		terminals.map((t) => t.status),
		ends.map((e) => (e.isError ? "error" : "success")),
	);
	check("[tool] 终端块有输出", terminals.every((t) => t.output.length > 0), true);
	check("[tool] 工具调用块数 == 工具执行数", blocksOfType(state, "tool_call").length, starts.length);
	check("[tool] 终态 streaming=false", state.streaming, false);
	check("[tool] 所有 text block 都不再 streaming", blocksOfType(state, "text").every((b) => b.streaming === false), true);
}

/* -------------------------------------------------------------------------
 * 三、纯函数性（reducer 不能改入参）
 * ---------------------------------------------------------------------- */
{
	const before = createDraft();
	const event = {
		type: "message_start",
		message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
	};
	const snapshot = JSON.stringify(before);
	const after = applyEvent(before, event);
	check("[纯函数] 入参未被修改", JSON.stringify(before), snapshot);
	check("[纯函数] 返回了新对象", after !== before, true);
	check("[纯函数] 入参 messages 未被追加", before.messages.length, 0);
	check("[纯函数] 新状态有一条消息", after.messages.length, 1);
}

/* -------------------------------------------------------------------------
 * 四、翻译器：无关事件应被丢弃
 * ---------------------------------------------------------------------- */
{
	check("[翻译] 未知事件返回 null", toAgentEvent({ type: "compaction_start", reason: "threshold" }), null);
	check("[翻译] 非法消息返回 null", toAgentEvent({ type: "message_start", message: { role: "weird" } }), null);
	check("[翻译] turn_start 透传", toAgentEvent({ type: "turn_start" }), { type: "turn_start" });
	check(
		"[翻译] tool_execution_end 抽取输出文本",
		toAgentEvent({
			type: "tool_execution_end",
			toolCallId: "c1",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		}),
		{ type: "tool_execution_end", toolCallId: "c1", output: "ok", isError: false },
	);
}

/* ---------------------------------------------------------------------- */
if (fails.length > 0) {
	console.error(`\n适配层断言失败 ${fails.length} 项：`);
	for (const f of fails) console.error(`  ✗ ${f}`);
	process.exit(1);
}
console.log(`适配层断言全部通过：${passed} 项`);
