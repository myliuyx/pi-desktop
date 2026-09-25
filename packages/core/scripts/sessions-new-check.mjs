/**
 * 新建会话（惰性建会话语义）检查脚本 —— `check:sessions-new`（node 直跑，不引框架）。
 *
 * 覆盖规格书 `.plan/task-new-session-page.md` §七 N-c1–N-c5 + 安全三件套：
 *   N-c1 `POST /sessions/new` → 200 `{ ok:true, id 非空 }`；
 *   N-c2 紧接 `GET /sessions`：清单**不含**该 id —— 「首条 entry 前不落盘」的文件级实证
 *        （整个惰性建会话语义 D6 的根基，别删；上游包行为一变它会红，而不是假绿）；
 *   N-c4 流式中 `POST /sessions/new` → 409（不偷偷中止正在生成的回复）；
 *   N-c3 一轮 `/prompt` 跑完 → 清单含该 id 且 messageCount ≥ 2；
 *   N-c5 再次 `/sessions/new` → 新 id ≠ 旧 id；旧会话仍可 `/sessions/load` 且
 *        messageCount 不变（换入不追加旧文件 —— prompt 落进的是新会话）。
 *
 * 为什么 N-c2 放在最前：它同时证明「/sessions/new 只换内存态」与「Pi 落盘时机」，
 * 这两条假设若被上游升级打破，UI 的「点击不创建会话」语义就整体失效 —— 必须让它
 * 成为最敏感的探针。
 *
 * 用法（在 packages/core 下）：`npm run check:sessions-new`
 * 证据：`run/sessions-new-evidence.json`（清单原文、id 对照、断言逐条）。
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
const evidencePath = path.join(runDir, "sessions-new-evidence.json");
fs.mkdirSync(runDir, { recursive: true });

const PORT = Number(process.env.SESSIONS_NEW_PORT ?? 5212);
const TOKEN = process.env.SESSIONS_NEW_TOKEN ?? "new-session-token";
const PROMPT = process.env.SESSIONS_NEW_PROMPT ?? "只回复四个字：已收到，不要调用任何工具。";
const PROMPT_TIMEOUT_MS = Number(process.env.SESSIONS_NEW_PROMPT_TIMEOUT_MS ?? 240_000);
const HTTP_TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-new-"));

const checks = [];
const check = (name, pass, detail) => {
	checks.push({ name, pass: !!pass, detail });
	console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

/* ---------------------------------------------------------------------------
 * HTTP 小工具（带 token / 可指定 Host / prompt 可配长超时）
 * ------------------------------------------------------------------------- */

function request(method, p, body, { token = TOKEN, host, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
	return new Promise((resolve, reject) => {
		const headers = {};
		if (token) headers.Authorization = `Bearer ${token}`;
		if (host) headers.Host = host;
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

/** 轮询到 streaming === 期望值（N-c4 的时序判据）；超时返回 null */
async function waitForStreaming(target, timeoutMs = 60_000) {
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

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */

const evidence = {
	startedAt: new Date().toISOString(),
	prompt: PROMPT,
	judgments: {},
};

const agentDir = path.join(tmpRoot, "agentdir");
const cwd = path.join(tmpRoot, "project");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
// 无项目本地资源 ⇒ 不触发信任门（本脚本只验会话语义，不重复 C3 的信任门用例）
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));
seedModelsJson(agentDir);

const logFd = fs.openSync(path.join(runDir, "sessions-new-core.log"), "w");
const child = spawn(process.execPath, mainArgs, {
	cwd,
	env: childEnv({
		CORE_TOKEN: TOKEN,
		CORE_PORT: String(PORT),
		CORE_AGENT_DIR: agentDir,
	}),
	stdio: ["ignore", "ignore", logFd],
});

let exitCode = 1;
try {
	console.log(`[sessions-new] 临时目录 ${tmpRoot}`);
	const health = await waitForHealth((h) => h.extensions !== null);
	check("前置·core 启动就绪（/health.extensions 非空）", !!health, health);

	/* ================================================================ N-c1 · 新建 → 200 + id */
	const r1 = await request("POST", "/sessions/new", {});
	const id1 = r1.json?.id;
	check("N-c1 POST /sessions/new → 200 { ok:true, id 非空 }", r1.status === 200 && r1.json?.ok === true && typeof id1 === "string" && id1.length > 0, { status: r1.status, body: r1.json });

	/* ================================================================ N-c2 · 未发消息 ⇒ 不落盘（语义根基） */
	const list0 = await request("GET", "/sessions");
	const ids0 = (list0.json?.sessions ?? []).map((s) => s.id);
	check("N-c2 首条 entry 前不落盘：清单不含新 id（D6 根基，上游行为变了这里会红）", list0.status === 200 && !ids0.includes(id1), { status: list0.status, ids: ids0, newId: id1 });

	/* ================================================================ N-c4 · 流式中 409 */
	// /prompt 是「跑完一轮才返回」的同步端点 —— 不 await 它，用 /health.streaming 抓流式窗口
	const promptPromise = request("POST", "/prompt", { text: PROMPT }, { timeoutMs: PROMPT_TIMEOUT_MS });
	const sawStreaming = await waitForStreaming(true);
	const duringStream = sawStreaming ? await request("POST", "/sessions/new", {}) : { status: -1, json: { error: "未抓到 streaming 窗口" } };
	const promptRes = await promptPromise;
	await waitForStreaming(false, PROMPT_TIMEOUT_MS);
	check(
		"N-c4 流式中 POST /sessions/new → 409（不偷偷中止）",
		duringStream.status === 409,
		{ status: duringStream.status, body: duringStream.json, promptStatus: promptRes.status },
	);

	/* ================================================================ N-c3 · 一轮对话后落盘进清单 */
	const list1 = await request("GET", "/sessions");
	const sessions1 = list1.json?.sessions ?? [];
	const mine1 = sessions1.find((s) => s.id === id1);
	check("N-c3 一轮 /prompt 后清单含新 id 且 messageCount ≥ 2", list1.status === 200 && !!mine1 && mine1.messageCount >= 2, { status: list1.status, sessions: sessions1.map((s) => ({ id: s.id, messageCount: s.messageCount })), newId: id1 });
	check("N-c3 清单字段完整（id / title / updatedAt / messageCount）", sessions1.every((s) => typeof s.id === "string" && typeof s.title === "string" && s.title.trim().length > 0 && typeof s.updatedAt === "number" && typeof s.messageCount === "number"), sessions1);

	/* ================================================================ N-c5 · 再新建：换入不追加旧文件 */
	const r2 = await request("POST", "/sessions/new", {});
	const id2 = r2.json?.id;
	check("N-c5 第二次 /sessions/new → 200 且新 id ≠ 旧 id", r2.status === 200 && typeof id2 === "string" && id2.length > 0 && id2 !== id1, { status: r2.status, id1, id2 });

	const list2 = await request("GET", "/sessions");
	const sessions2 = list2.json?.sessions ?? [];
	const ids2 = sessions2.map((s) => s.id);
	check("N-c5 第二个会话同样不落盘（清单含 id1、不含 id2）", ids2.includes(id1) && !ids2.includes(id2), { ids: ids2, id1, id2 });

	/*
	 * 「未被追加」的证据链（两层，口径分开——两者本就不该相等，详见清单侧注释）：
	 * - 清单级：id1 的 messageCount 是 Pi 的 entry 级计数（含 usage 等非消息 entry），
	 *   第二次新建**前后不变** ⇒ 换入 id2 后 core 的一切写入都落在 id2；
	 * - 内容级：载回 id1 仍是「一轮对话」形态 —— 恰好 1 条 user 消息（prompt 只出现
	 *   一次）、assistant ≥1。若 prompt 被错误追加进旧会话，user 数会变 2。
	 */
	const mine2 = sessions2.find((s) => s.id === id1);
	const loadOld = await request("POST", "/sessions/load", { id: id1 });
	const oldMessages = loadOld.json?.messages ?? [];
	const oldUserCount = oldMessages.filter((m) => m.role === "user").length;
	check("N-c5 旧会话清单计数未被追加（第二次新建前后一致）", list2.status === 200 && !!mine2 && mine2.messageCount === mine1?.messageCount, { listedBefore: mine1?.messageCount, listedAfter: mine2?.messageCount });
	check("N-c5 旧会话可载回且仍是一轮对话（恰 1 条 user 消息）", loadOld.status === 200 && oldMessages.length >= 2 && oldUserCount === 1, { status: loadOld.status, messages: oldMessages.length, userCount: oldUserCount });
	const oldText = (loadOld.json?.messages ?? [])
		.flatMap((m) => (m.role === "user" ? m.blocks.filter((b) => b.type === "text").map((b) => b.content) : []))
		.join("");
	check("N-c5 旧会话首条 user 消息原文可读回", oldText.includes(PROMPT.slice(0, 6)), oldText.slice(0, 120));

	/* ================================================================ 安全三件套（新端点照走） */
	const noToken = await request("POST", "/sessions/new", {}, { token: "" });
	const badHost = await request("POST", "/sessions/new", {}, { host: `evil.example.com:${PORT}` });
	check("安全·无 token → 401（POST /sessions/new）", noToken.status === 401, noToken.status);
	check("安全·错 Host → 403（防 DNS rebinding）", badHost.status === 403, badHost.status);

	Object.assign(evidence.judgments, {
		启动: { port: PORT, health },
		第一次新建: { status: r1.status, id: id1 },
		落盘前清单: (list0.json?.sessions ?? []).map((s) => s.id),
		流式中409: { status: duringStream.status, body: duringStream.json, promptStatus: promptRes.status },
		一轮后清单: sessions1.map((s) => ({ id: s.id, title: s.title, messageCount: s.messageCount })),
		第二次新建: { status: r2.status, id: id2 },
		载回旧会话: { status: loadOld.status, messageCount: oldMessages.length, userCount: oldUserCount, tokenUsage: loadOld.json?.tokenUsage },
		安全负向: { 无token: noToken.status, 错Host: badHost.status },
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
	console.error("[sessions-new] 脚本异常:", e && e.stack ? e.stack : e);
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
		? "\n新建会话（惰性建会话）检查全部通过"
		: `\n新建会话检查失败 ${checks.filter((c) => !c.pass).length} 项：\n - ${checks.filter((c) => !c.pass).map((c) => c.name).join("\n - ")}`,
);
process.exit(exitCode);
