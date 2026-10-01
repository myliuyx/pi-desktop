/**
 * 斜杠命令纯逻辑断言 —— 确定性、不起 core、不装模型。
 * 运行：npm run check:slash-commands
 * 依赖 tsx 以 import .ts。
 */

import {
	BUILTIN_SLASH_COMMANDS,
	buildSlashCommandsPayload,
	matchBuiltinCommand,
	scopeOfSource,
} from "../src/slash-commands.ts";
import { toAgentEvent } from "../src/adapt.ts";

const checks = [];
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	checks.push(ok);
	console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`}`);
};

/* ---------------- matchBuiltinCommand ---------------- */
const hit = (t) => {
	const m = matchBuiltinCommand(t);
	return m ? { name: m.command.name, args: m.args } : null;
};

check("精确匹配 /reload", hit("/reload"), { name: "reload", args: "" });
check("带参数 /compact", hit("/compact 帮我保留最近的改动"), { name: "compact", args: "帮我保留最近的改动" });
check("前后空白不误伤", hit("  /reload  "), { name: "reload", args: "" });
check("未知命令不吞", hit("/unknown"), null);
check("前缀不误吞（/reloading）", hit("/reloading"), null);
check("无前导斜杠不匹配", hit("reload"), null);
check("非斜杠普通文本不匹配", hit("hello world"), null);

/* ---------------- scopeOfSource ---------------- */
check("package 来源", scopeOfSource({ scope: "user", origin: "package" }), "package");
check("user/top-level", scopeOfSource({ scope: "user", origin: "top-level" }), "user");
check("project/top-level", scopeOfSource({ scope: "project", origin: "top-level" }), "project");
check("temporary 无标签", scopeOfSource({ scope: "temporary", origin: "top-level" }), undefined);
check("缺 sourceInfo", scopeOfSource(undefined), undefined);

/* ---------------- buildSlashCommandsPayload ---------------- */
const base = {
	isStreaming: false,
	isCompacting: false,
	skillsEnabled: true,
	extensionCommands: [{ name: "think-zh", description: "中文思考提示词", scope: "user" }],
	skills: [
		{ name: "skill:brainstorming", description: "设计前必读", scope: "package" },
		{ name: "skill:web-content-fetcher", description: "", scope: "user" },
	],
};

const p = buildSlashCommandsPayload(base);
check("内置命令名与顺序", p.commands.filter((c) => c.source === "builtin").map((c) => c.name), ["reload", "compact"]);
check("compact 带 argumentHint", p.commands.find((c) => c.name === "compact").argumentHint, "<instructions>");
check("reload 无 argumentHint（不写键）", "argumentHint" in p.commands.find((c) => c.name === "reload"), false);
check("builtinAvailable=true", p.builtinAvailable, true);
check("分组顺序 builtin→extension→skill", p.commands.map((c) => c.source), ["builtin", "builtin", "extension", "skill", "skill"]);
check("扩展 scope 透传", p.commands.find((c) => c.name === "think-zh").scope, "user");
check("空描述保留空串", p.commands.find((c) => c.name === "skill:web-content-fetcher").description, "");

const conflict = buildSlashCommandsPayload({ ...base, extensionCommands: [{ name: "reload", description: "冲突项" }] });
check("与 builtin 同名的扩展被剔除", conflict.commands.some((c) => c.source === "extension" && c.name === "reload"), false);

const off = buildSlashCommandsPayload({ ...base, skillsEnabled: false });
check("技能开关关：无 skill 项", off.commands.some((c) => c.source === "skill"), false);

const streaming = buildSlashCommandsPayload({ ...base, isStreaming: true });
check("流式中 builtinAvailable=false", streaming.builtinAvailable, false);
check("流式中 builtin available=false", streaming.commands.filter((c) => c.source === "builtin").every((c) => c.available === false), true);
check("流式中扩展仍 available=true", streaming.commands.find((c) => c.source === "extension").available, true);

const compacting = buildSlashCommandsPayload({ ...base, isCompacting: true });
check("压缩中 builtinAvailable=false", compacting.builtinAvailable, false);

check("注册表恰为 reload+compact", BUILTIN_SLASH_COMMANDS.map((c) => c.name), ["reload", "compact"]);

/* ---------------- adapt：compaction 翻译 ---------------- */
const startEv = toAgentEvent({ type: "compaction_start", reason: "manual" });
check("compaction_start → 契约事件", startEv, { type: "compaction_start", reason: "manual" });

const endEv = toAgentEvent({
	type: "compaction_end",
	reason: "manual",
	result: { summary: "已压缩前的摘要", firstKeptEntryId: "e1", tokensBefore: 100 },
	aborted: false,
	willRetry: false,
});
check("compaction_end → 契约事件（带 summary）", endEv, {
	type: "compaction_end",
	reason: "manual",
	summary: "已压缩前的摘要",
	aborted: false,
	willRetry: false,
});

const endErr = toAgentEvent({
	type: "compaction_end",
	reason: "threshold",
	aborted: true,
	willRetry: true,
	errorMessage: "boom",
});
check("compaction_end → 错误/中止透传", endErr, {
	type: "compaction_end",
	reason: "threshold",
	aborted: true,
	willRetry: true,
	errorMessage: "boom",
});

check("未知 reason 丢弃", toAgentEvent({ type: "compaction_start", reason: "weird" }), null);

const failed = checks.filter((ok) => !ok).length;
console.log(failed === 0 ? `\n全部通过（${checks.length} 项）` : `\n失败 ${failed}/${checks.length}`);
process.exitCode = failed === 0 ? 0 : 1;