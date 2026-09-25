/**
 * 「点开历史会话 = 切换活动会话」检查脚本 —— `check:sessions-load`（遗留 #8 修复的验收）。
 *
 * 修复前行为（2026-09-25 临时实例实证的缺口）：`POST /sessions/load` 纯只读，界面看的是
 * S1、core 活动会话仍是 S2 ⇒ 后续 `/prompt` 写进 S2 —— 用户在 S2 里看到一段没发生过的
 * 对话，S1 里发的消息刷新即失。
 * 修复后：load 即切（`rebuildSession` 同款手势，护栏 = 同文件 no-op / 流式中只读返回）。
 *
 * 覆盖（对应规格书 `.plan/task-sessions-load-switch.md` §三）：
 *   L-a  造两个会话 S1/S2（/prompt + /sessions/new + /prompt），记录各自 messageCount；
 *   L-b  `load(S1)` → 200 且内容可读（消息 ≥2、首条 user 原文命中）；
 *   L-c  在「查看 S1」下 `/prompt` 发言 ⇒ **S1 增长、S2 不变**（核心判据）；
 *        再次 `load(S1)` 能读回第三条发言原文（发言真的落盘在所看会话里）；
 *   L-d  流式中 `load` → 200（只读视图不被打断；护栏②的可见行为）；
 *   L-e  同文件 load no-op 不炸（看的就是活动会话时再 load 一次仍 200）。
 *
 * 为什么不并进 check:c4：那是 M6 冻结验收（改动面须重跑且期望值冻结），
 * 本脚本是修复批的独立判据，互不牵连。
 *
 * 用法（在 packages/core 下）：`npm run check:sessions-load`
 * 证据：`run/sessions-load-evidence.json`。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, seedModelsJson } from "./lib/credentials.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, "..");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
const mainPath = path.join(coreDir, "src", "main.ts");
// CORE_ENTRY：指向编译产物（如 dist/main.js）时以 node 直跑，验「产物可用」而非源码
const mainArgs = process.env.CORE_ENTRY ? [path.resolve(process.env.CORE_ENTRY)] : [tsxPath, mainPath];
const runDir = path.join(coreDir, "run");
const evidencePath = path.join(runDir, "sessions-load-evidence.json");
fs.mkdirSync(runDir, { recursive: true });

const PORT = Number(process.env.SESSIONS_LOAD_PORT ?? 5217);
const TOKEN = process.env.SESSIONS_LOAD_TOKEN ?? "sessions-load-token";
const P1 = "只回复两个字：收到";
const P2 = "只回复两个字：好的";
const P3 = "只回复两个字：明白";
const HTTP_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = Number(process.env.SESSIONS_LOAD_PROMPT_TIMEOUT_MS ?? 240_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-load-"));

const checks = [];
const check = (name, pass, detail) => {
	checks.push({ name, pass: !!pass, detail });
	console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

function request(method, p, body, { token = TOKEN, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
	return new Promise((resolve, reject) => {
		const headers = {};
		if (token) headers.Authorization = `Bearer ${token}`;
		let payload;
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			payload = JSON.stringify(body);
		}
		const req = http.request(
			{ host: "127.0.0.1", port: PORT, path: p, method, headers, timeout: timeoutMs },
			(res) => {
				let d = "";
				res.on("data", (c) => (d += c));
				res.on("end", () => {
					let json = null;
					try {
						json = JSON.parse(d);
					} catch {
						/* 非 JSON */
					}
					resolve({ status: res.statusCode, json, raw: d });
				});
			},
		);
		req.on("error", reject);
		req.on("timeout", () => req.destroy(new Error(`timeout(${timeoutMs}ms)`)));
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

async function waitForHealth(ok, timeoutMs = 60_000) {
	const t0 = Date.now();
	for (;;) {
		try {
			const r = await request("GET", "/health");
			if (r.status === 200 && r.json && ok(r.json)) return r.json;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() - t0 > timeoutMs) return null;
		await sleep(300);
	}
}

async function waitForStreaming(target, timeoutMs = 120_000) {
	const t0 = Date.now();
	for (;;) {
		try {
			const r = await request("GET", "/health");
			if (r.status === 200 && r.json?.streaming === target) return true;
		} catch {
			/* 瞬时失败忽略 */
		}
		if (Date.now() - t0 > timeoutMs) return null;
		await sleep(150);
	}
}

const list = async () => (await request("GET", "/sessions")).json?.sessions ?? [];
const userTextsOf = (result) =>
	(result?.messages ?? [])
		.flatMap((m) => (m.role === "user" ? m.blocks.filter((b) => b.type === "text").map((b) => b.content) : []))
		.join("|");

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */

const evidence = { startedAt: new Date().toISOString(), prompts: [P1, P2, P3], judgments: {} };

const agentDir = path.join(tmpRoot, "agentdir");
const cwd = path.join(tmpRoot, "project");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));
seedModelsJson(agentDir);

const logFd = fs.openSync(path.join(runDir, "sessions-load-core.log"), "w");
const child = spawn(process.execPath, mainArgs, {
	cwd,
	env: childEnv({ CORE_TOKEN: TOKEN, CORE_PORT: String(PORT), CORE_AGENT_DIR: agentDir }),
	stdio: ["ignore", "ignore", logFd],
});

let exitCode = 1;
try {
	console.log(`[sessions-load] 临时目录 ${tmpRoot}`);
	const health = await waitForHealth((h) => h.extensions !== null);
	check("前置·core 启动就绪", !!health, health);

	/* ================================================================ L-a · 造 S1/S2 */
	await request("POST", "/prompt", { text: P1 }, { timeoutMs: PROMPT_TIMEOUT_MS });
	await waitForStreaming(false, PROMPT_TIMEOUT_MS);
	const s1 = (await list())[0]?.id;
	const created = await request("POST", "/sessions/new", {});
	const s2 = created.json?.id;
	await request("POST", "/prompt", { text: P2 }, { timeoutMs: PROMPT_TIMEOUT_MS });
	await waitForStreaming(false, PROMPT_TIMEOUT_MS);
	const before = await list();
	const s1mc0 = before.find((s) => s.id === s1)?.messageCount;
	const s2mc0 = before.find((s) => s.id === s2)?.messageCount;
	check(
		"L-a 两会话就绪（S1/S2 各 ≥1 轮，活动 = S2）",
		!!s1 && !!s2 && s1 !== s2 && (s1mc0 ?? 0) >= 2 && (s2mc0 ?? 0) >= 2,
		{ s1: s1?.slice(0, 8), s1mc0, s2: s2?.slice(0, 8), s2mc0 },
	);

	/* ================================================================ L-b · load(S1) 可读 */
	const loaded = await request("POST", "/sessions/load", { id: s1 });
	check(
		"L-b load(S1) → 200 且内容可读（消息 ≥2、user 原文命中）",
		loaded.status === 200 && (loaded.json?.messages?.length ?? 0) >= 2 && userTextsOf(loaded.json).includes(P1),
		{ status: loaded.status, messages: loaded.json?.messages?.length, users: userTextsOf(loaded.json).slice(0, 80) },
	);

	/* ================================================================ L-c · 发言落进所看会话（核心判据） */
	await request("POST", "/prompt", { text: P3 }, { timeoutMs: PROMPT_TIMEOUT_MS });
	await waitForStreaming(false, PROMPT_TIMEOUT_MS);
	const after = await list();
	const s1mc1 = after.find((s) => s.id === s1)?.messageCount;
	const s2mc1 = after.find((s) => s.id === s2)?.messageCount;
	check(
		"L-c 查看谁发言就落在谁：S1 增长、S2 不变",
		(s1mc1 ?? 0) > (s1mc0 ?? 0) && s2mc1 === s2mc0,
		{ s1mc0, s1mc1, s2mc0, s2mc1 },
	);
	// 载回 S1 确认第三条发言真的在它的历史里
	const reloadS1 = await request("POST", "/sessions/load", { id: s1 });
	check(
		"L-c 再载回 S1 能读到第三条发言原文",
		reloadS1.status === 200 && userTextsOf(reloadS1.json).includes(P3),
		{ status: reloadS1.status, users: userTextsOf(reloadS1.json).slice(0, 120) },
	);

	/* ================================================================ L-d · 流式中 load 只读返回 */
	const promptPromise = request("POST", "/prompt", { text: P1 }, { timeoutMs: PROMPT_TIMEOUT_MS });
	const sawStreaming = await waitForStreaming(true);
	const duringLoad = sawStreaming ? await request("POST", "/sessions/load", { id: s2 }) : { status: -1 };
	await promptPromise;
	await waitForStreaming(false, PROMPT_TIMEOUT_MS);
	check(
		"L-d 流式中 load → 200（只读视图不被打断；此场景跳过重建）",
		duringLoad.status === 200,
		{ status: duringLoad.status, sawStreaming },
	);

	/* ================================================================ L-e · 同文件 load no-op */
	const sameFileLoad = await request("POST", "/sessions/load", { id: s1 });
	const afterSame = await list();
	check(
		"L-e 同文件（活动会话自身）再 load → 200 且清单计数稳定",
		sameFileLoad.status === 200 && afterSame.find((s) => s.id === s1)?.messageCount === afterSame.find((s) => s.id === s1)?.messageCount,
		{ status: sameFileLoad.status },
	);

	Object.assign(evidence.judgments, {
		准备: { s1: s1?.slice(0, 8), s1mc0, s2: s2?.slice(0, 8), s2mc0 },
		loadS1: { status: loaded.status, messages: loaded.json?.messages?.length },
		发言后: { s1mc1, s2mc1 },
		流式中load: { status: duringLoad.status, sawStreaming },
		清单终态: after.map((s) => ({ id: s.id.slice(0, 8), messageCount: s.messageCount })),
	});

	evidence.finishedAt = new Date().toISOString();
	evidence.summary = {
		assertions: checks.length,
		passed: checks.filter((c) => c.pass).length,
		failed: checks.filter((c) => !c.pass).length,
		failedNames: checks.filter((c) => !c.pass).map((c) => c.name),
	};
	evidence.checks = checks;
	fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
	console.log(`\n=== 断言汇总：${evidence.summary.passed}/${evidence.summary.assertions} 通过 ===`);
	console.log(`== 证据已写入 ${path.relative(coreDir, evidencePath)} ==`);
	exitCode = evidence.summary.failed === 0 ? 0 : 1;
} catch (e) {
	console.error("[sessions-load] 脚本异常:", e && e.stack ? e.stack : e);
	evidence.error = String(e);
	evidence.checks = checks;
	evidence.summary = { assertions: checks.length, passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length };
	try {
		fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
	} catch {
		/* 忽略 */
	}
	exitCode = 1;
} finally {
	try {
		child.kill("SIGTERM");
	} catch {
		/* 已退出 */
	}
	fs.closeSync(logFd);
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		/* 忽略 */
	}
}

console.log(
	exitCode === 0
		? "\n「点开即切换」检查全部通过"
		: `\n检查失败 ${checks.filter((c) => !c.pass).length} 项：\n - ${checks.filter((c) => !c.pass).map((c) => c.name).join("\n - ")}`,
);
process.exit(exitCode);
