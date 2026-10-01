/**
 * 轮次改动文件纯函数断言（task-turn-file-chips.md §三.4）—— 不需要浏览器。
 * 运行：npm run check:turn-files
 * 口径出处：lib/turn-files.ts 注释与 .plan/task-turn-file-chips.md §二/§三.1。
 */
import { groupTurns } from "../src/lib/turns.ts";
import { collectTurnFiles } from "../src/lib/turn-files.ts";

let seq = 0;
const user = () => ({ id: `u${++seq}`, role: "user", timestamp: 0, blocks: [{ type: "text", content: "q" }] });
const assistant = (blocks) => ({ id: `a${++seq}`, role: "assistant", timestamp: 0, blocks });
const text = (content) => ({ type: "text", content });
/** tool_call 块：name 缺省 bash；args 整体可传 */
const call = (id, name = "bash", args = {}) => ({ type: "tool_call", toolCallId: id, toolName: name, args });
/** terminal 块：status 缺省 success（edit/write 要「实际写成功」才收录） */
const term = (id, status = "success") => ({ type: "terminal", toolCallId: id, command: "", output: "", status });

let failed = 0;
function check(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failed++;
	console.log(
		`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`,
	);
}

/** 造一轮（user + 若干 assistant），返回该轮 TurnGroup */
function oneTurn(...assistants) {
	const msgs = [user(), ...assistants];
	return { msgs, turn: groupTurns(msgs, "s1")[0] };
}

/* 1. 成功 edit 收录：tool=edit、name=basename */
{
	const { msgs, turn } = oneTurn(
		assistant([call("t1", "edit", { path: "src/app.ts", edits: [] }), term("t1")]),
		assistant([text("done")]),
	);
	check("1 edit 收录", collectTurnFiles(msgs, turn, null), [
		{ path: "src/app.ts", display: "src/app.ts", name: "app.ts", tool: "edit" },
	]);
}

/* 2. 成功 write 收录：tool=write（cwd=null 相对路径原样，mock 兜底形态） */
{
	const { msgs, turn } = oneTurn(
		assistant([call("t1", "write", { path: "lib/new.ts", content: "x" }), term("t1")]),
		assistant([text("done")]),
	);
	check("2 write 收录（cwd=null 相对原样）", collectTurnFiles(msgs, turn, null), [
		{ path: "lib/new.ts", display: "lib/new.ts", name: "new.ts", tool: "write" },
	]);
}

/* 3. bash / read 等其他工具不收录 */
{
	const { msgs, turn } = oneTurn(
		assistant([
			call("t1", "bash", { command: "ls" }),
			term("t1"),
			call("t2", "read", { path: "src/a.ts" }),
			term("t2"),
		]),
		assistant([text("done")]),
	);
	check("3 bash/read 不收录", collectTurnFiles(msgs, turn, null), []);
}

/* 4. 失败（error）terminal 不收录——没写成的文件不许上榜 */
{
	const { msgs, turn } = oneTurn(
		assistant([call("t1", "edit", { path: "src/a.ts" }), term("t1", "error")]),
		assistant([text("done")]),
	);
	check("4 error 不收录", collectTurnFiles(msgs, turn, null), []);
}

/* 5. 未完结（running）terminal 不收录 */
{
	const { msgs, turn } = oneTurn(
		assistant([call("t1", "write", { path: "src/b.ts", content: "x" }), term("t1", "running")]),
		assistant([text("done")]),
	);
	check("5 running 不收录", collectTurnFiles(msgs, turn, null), []);
}

/* 6. 未配对（没有 terminal，中止流）不收录 */
{
	const { msgs, turn } = oneTurn(
		assistant([call("t1", "edit", { path: "src/c.ts", edits: [] })]),
		assistant([text("done")]),
	);
	check("6 未配对不收录", collectTurnFiles(msgs, turn, null), []);
}

/* 7. 同文件先 edit 后 write：去重成一条，首触 tool=edit 保留 */
{
	const { msgs, turn } = oneTurn(
		assistant([call("t1", "edit", { path: "src/d.ts" }), term("t1")]),
		assistant([call("t2", "write", { path: "src/d.ts", content: "x" }), term("t2")]),
		assistant([text("done")]),
	);
	const files = collectTurnFiles(msgs, turn, null);
	check("7 去重成一条", files.length, 1);
	check("7 首触 tool=edit", files[0]?.tool, "edit");
}

/* 8. 反斜杠与正斜杠同文件：归一后去重；display 归一分隔符 */
{
	const { msgs, turn } = oneTurn(
		assistant([
			call("t1", "edit", { path: "src\\e.ts" }),
			term("t1"),
			call("t2", "write", { path: "src/e.ts", content: "x" }),
			term("t2"),
		]),
		assistant([text("done")]),
	);
	const files = collectTurnFiles(msgs, turn, null);
	check("8 归一去重成一条", files.length, 1);
	check("8 分隔符统一", files[0]?.path, "src/e.ts");
}

/* 9. 相对路径基于 cwd 绝对化（点击打开用）；display 保持相对 */
{
	const { msgs, turn } = oneTurn(
		assistant([call("t1", "write", { path: "src/f.ts", content: "x" }), term("t1")]),
		assistant([text("done")]),
	);
	check("9 相对基于 cwd 绝对化", collectTurnFiles(msgs, turn, "F:/proj"), [
		{ path: "F:/proj/src/f.ts", display: "src/f.ts", name: "f.ts", tool: "write" },
	]);
}

/* 10. 绝对路径在 cwd 下（盘符大小写漂移）→ display 截成相对 */
{
	const { msgs, turn } = oneTurn(
		assistant([call("t1", "edit", { path: "f:/proj/src/g.ts" }), term("t1")]),
		assistant([text("done")]),
	);
	check("10 cwd 下绝对截相对（大小写不敏感）", collectTurnFiles(msgs, turn, "F:/proj"), [
		{ path: "f:/proj/src/g.ts", display: "src/g.ts", name: "g.ts", tool: "edit" },
	]);
}

/* 11. cwd 外的绝对路径：path/display 原样（归一分隔符） */
{
	const { msgs, turn } = oneTurn(
		assistant([call("t1", "write", { path: "C:\\other\\h.ts", content: "x" }), term("t1")]),
		assistant([text("done")]),
	);
	check("11 cwd 外原样", collectTurnFiles(msgs, turn, "F:/proj"), [
		{ path: "C:/other/h.ts", display: "C:/other/h.ts", name: "h.ts", tool: "write" },
	]);
}

/* 12. cwd=null + 相对：mock 兜底（同案例 2 集中锁一次数组形态）已覆盖；这里锁
     cwd=null + 绝对：display 绝对原样 */
{
	const { msgs, turn } = oneTurn(
		assistant([call("t1", "edit", { path: "/etc/hosts" }), term("t1")]),
		assistant([text("done")]),
	);
	check("12 cwd=null 绝对原样", collectTurnFiles(msgs, turn, null), [
		{ path: "/etc/hosts", display: "/etc/hosts", name: "hosts", tool: "edit" },
	]);
}

/* 13. 多 assistant 消息跨条收集 + 首触顺序（edit → write → edit） */
{
	const { msgs, turn } = oneTurn(
		assistant([call("t1", "edit", { path: "a.ts" }), term("t1")]),
		assistant([call("t2", "write", { path: "b.ts", content: "x" }), term("t2")]),
		assistant([call("t3", "edit", { path: "c.ts" }), term("t3"), text("done")]),
	);
	check(
		"13 跨条收集 + 首触顺序",
		collectTurnFiles(msgs, turn, null).map((f) => `${f.path}:${f.tool}`),
		["a.ts:edit", "b.ts:write", "c.ts:edit"],
	);
}

/* 14. 纯文本轮 / 空 turns → 空数组（不渲染行的口径） */
{
	const { msgs, turn } = oneTurn(assistant([text("直接回答")]));
	check("14 纯文本轮空数组", collectTurnFiles(msgs, turn, "F:/proj"), []);
}

/* 15. args.path 非字符串 / 空白：跳过不收录 */
{
	const { msgs, turn } = oneTurn(
		assistant([
			call("t1", "edit", { path: 42 }),
			term("t1"),
			call("t2", "write", { path: "   ", content: "x" }),
			term("t2"),
			call("t3", "edit", {}),
			term("t3"),
		]),
		assistant([text("done")]),
	);
	check("15 非法 path 跳过", collectTurnFiles(msgs, turn, "F:/proj"), []);
}

/* 16. path 带首尾空白：trim 后收录 */
{
	const { msgs, turn } = oneTurn(
		assistant([call("t1", "write", { path: "  src/i.ts  ", content: "x" }), term("t1")]),
		assistant([text("done")]),
	);
	check("16 trim 后收录", collectTurnFiles(msgs, turn, null)[0]?.path, "src/i.ts");
}

/* 17. cwd 尾带分隔符（目录形态）：拼前缀不出 // */
{
	const { msgs, turn } = oneTurn(
		assistant([call("t1", "write", { path: "src/j.ts", content: "x" }), term("t1")]),
		assistant([text("done")]),
	);
	check("17 cwd 尾分隔符归一", collectTurnFiles(msgs, turn, "F:/proj/")[0]?.path, "F:/proj/src/j.ts");
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
