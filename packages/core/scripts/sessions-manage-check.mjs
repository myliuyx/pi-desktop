/**
 * 会话重命名 / 删除端点检查 —— `check:sessions-manage`（2026-09-28 用户需求：
 * 侧栏历史会话行内改名 + 删除）。
 *
 * **不起真实模型**（不学 c4 的判据① prompt）：会话文件用合成 .jsonl 手写进
 * `<agentDir>/sessions/<cwd-slug>/`（slug 规则照抄 pi session-manager.js:293：
 * `--${cwd 剥根后 [/\:]→"-"}--`），端点语义全部可离线断言：
 *
 *   R1  rename 非活动会话 ⇒ 200，清单标题变为新名、messageCount 不变；
 *   R2  rename 走 Pi session_info name entry ⇒ /sessions/load 的 title 同步（name 口径）；
 *   R3  rename 空串 / 纯空白 title ⇒ 400；
 *   R4  rename 未知 id ⇒ 404；缺 id / 缺 title ⇒ 400；
 *   R5  delete 非活动会话 ⇒ 200，清单少一条、文件真的没了；
 *   R6  delete 未知 id ⇒ 404；
 *   R7  活动会话链路：/sessions/new 拿到活动 id ⇒ rename 活实例分支 ⇒ 200 且落盘；
 *       delete 活动会话 ⇒ 200（core 内部先换入空白会话再 unlink），清单即净、
 *       /sessions/load 回 404、/health 仍健康（换入没把 core 搞坏）；
 *   R8  安全三件套照生效：无 token → 401、错 Host → 403（rename / delete 都要过）。
 *
 * 用法（在 packages/core 下）：`npm run check:sessions-manage`
 * 证据：`run/sessions-manage-evidence.json`；失败非 0 退出。
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
const mainArgs = process.env.CORE_ENTRY ? [path.resolve(process.env.CORE_ENTRY)] : [tsxPath, mainPath];
const runDir = path.join(coreDir, "run");
fs.mkdirSync(runDir, { recursive: true });
const evidencePath = path.join(runDir, "sessions-manage-evidence.json");

const PORT = Number(process.env.SM_PORT ?? 5221);
const TOKEN = process.env.SM_TOKEN ?? "sm-token";
const HTTP_TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-manage-"));

const checks = [];
const check = (name, pass, detail) => {
	checks.push({ name, pass: !!pass, detail });
	console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

/* ----------------------------- HTTP 小工具（c4 同款，带 token / Host 负向用例） */
function request(method, p, body, { token = TOKEN, host } = {}) {
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
			{ host: "127.0.0.1", port: PORT, path: p, method, headers, timeout: HTTP_TIMEOUT_MS },
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
		req.on("timeout", () => req.destroy(new Error("timeout")));
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

async function waitForHealth(ok, timeoutMs = 40_000) {
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

/* ----------------------------- 合成会话（c4 判据③同手法：手写 .jsonl） */

const T0 = Date.UTC(2026, 8, 28, 10, 0, 0);
const ts = (i) => new Date(T0 + i * 60_000).toISOString();

/** pi session-manager.js:293 的 cwd → 目录名规则（原样照抄，勿凭感觉改） */
function sessionsDirFor(agentDir, cwd) {
	const resolved = fs.realpathSync(path.resolve(cwd));
	const safePath = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(agentDir, "sessions", safePath);
}

function synthEntries(cwd, id, userText) {
	const base = (eid, parentId, i) => ({ id: eid, parentId, timestamp: ts(i) });
	return [
		{ type: "session", version: 3, id, timestamp: ts(0), cwd },
		{ ...base("m1", null, 1), type: "message", message: { role: "user", content: [{ type: "text", text: userText }] } },
		{ ...base("m2", "m1", 2), type: "message", message: { role: "assistant", content: [{ type: "text", text: "收到" }] } },
	];
}

/* ----------------------------- 主流程 */

const agentDir = path.join(tmpRoot, "agentdir");
const cwd = path.join(tmpRoot, "project");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));
seedModelsJson(agentDir);

const logFd = fs.openSync(path.join(runDir, "sessions-manage-core.log"), "w");
const child = spawn(process.execPath, mainArgs, {
	cwd,
	env: childEnv({ CORE_TOKEN: TOKEN, CORE_PORT: String(PORT), CORE_AGENT_DIR: agentDir }),
	stdio: ["ignore", "ignore", logFd],
});

let exitCode = 1;
try {
	console.log(`[sessions-manage] 临时目录 ${tmpRoot}`);
	const health = await waitForHealth((h) => h.extensions !== null, 60_000);
	check("⓪core 启动就绪（/health.extensions 非空）", !!health, health);

	// 合成两个会话：header.cwd 用 realpath（list() 按 cwd 过滤，路径写法差异会剔掉它）
	const realCwd = fs.realpathSync(path.resolve(cwd));
	const sessDir = sessionsDirFor(agentDir, cwd);
	fs.mkdirSync(sessDir, { recursive: true });
	const writeSynth = (id, userText) =>
		fs.writeFileSync(
			path.join(sessDir, `2026-09-28T10-00-00-000Z_${id}.jsonl`),
			synthEntries(realCwd, id, userText).map((e) => JSON.stringify(e)).join("\n") + "\n",
		);
	writeSynth("sm-sess-a", "第一问");
	writeSynth("sm-sess-b", "第二问");

	const list0 = await request("GET", "/sessions");
	const sessions0 = list0.json?.sessions ?? [];
	check("⓪两个合成会话进入清单", list0.status === 200 && sessions0.length === 2, sessions0.map((s) => ({ id: s.id, title: s.title })));
	const a0 = sessions0.find((s) => s.id === "sm-sess-a");
	check("⓪合成会话标题回落首条 user 消息", a0?.title === "第一问", a0);

	/* ============ R1：rename 非活动会话 ============ */
	const rename1 = await request("POST", "/sessions/rename", { id: "sm-sess-a", title: "自定义标题A" });
	check("R1 rename ⇒ 200", rename1.status === 200 && rename1.json?.ok === true, rename1);
	const list1 = await request("GET", "/sessions");
	const a1 = (list1.json?.sessions ?? []).find((s) => s.id === "sm-sess-a");
	check("R1 清单标题变为新名、messageCount 不变", a1?.title === "自定义标题A" && a1?.messageCount === 2, a1);

	/* ============ R2：rename 经 name entry 对加载标题同样生效 ============ */
	const load1 = await request("POST", "/sessions/load", { id: "sm-sess-a" });
	check("R2 /sessions/load 的 title 同步新名（getSessionName 口径）", load1.json?.title === "自定义标题A", load1.json?.title);
	check("R2 加载消息体不受影响（2 条）", (load1.json?.messages ?? []).length === 2, (load1.json?.messages ?? []).length);

	/* ============ R3/R4：rename 负向 ============ */
	const renameEmpty = await request("POST", "/sessions/rename", { id: "sm-sess-a", title: "   " });
	check("R3 纯空白 title ⇒ 400", renameEmpty.status === 400, renameEmpty);
	const renameMissingTitle = await request("POST", "/sessions/rename", { id: "sm-sess-a" });
	check("R4 缺 title ⇒ 400", renameMissingTitle.status === 400, renameMissingTitle);
	const renameUnknown = await request("POST", "/sessions/rename", { id: "sm-sess-nope", title: "x" });
	check("R4 未知 id ⇒ 404", renameUnknown.status === 404, renameUnknown);
	const renameMissingId = await request("POST", "/sessions/rename", { title: "x" });
	check("R4 缺 id ⇒ 400", renameMissingId.status === 400, renameMissingId);

	/* ============ R5：delete 非活动会话 ============ */
	const del1 = await request("POST", "/sessions/delete", { id: "sm-sess-b" });
	check("R5 delete ⇒ 200", del1.status === 200 && del1.json?.ok === true, del1);
	const list2 = await request("GET", "/sessions");
	check("R5 清单少一条且 A 还在", (list2.json?.sessions ?? []).length === 1 && (list2.json?.sessions ?? []).some((s) => s.id === "sm-sess-a"), list2.json?.sessions);
	const bFile = path.join(sessDir, `2026-09-28T10-00-00-000Z_sm-sess-b.jsonl`);
	check("R5 会话文件真的被 unlink", !fs.existsSync(bFile), bFile);

	/* ============ R6：delete 负向 ============ */
	const delUnknown = await request("POST", "/sessions/delete", { id: "sm-sess-nope" });
	check("R6 delete 未知 id ⇒ 404", delUnknown.status === 404, delUnknown);
	const delMissingId = await request("POST", "/sessions/delete", {});
	check("R6 delete 缺 id ⇒ 400", delMissingId.status === 400, delMissingId);

	/* ============ R7：活动会话链路（rename 活实例分支 / delete 先换入空白） ============ */
	// 真实 UI 路径 = 用户先点开一个有内容的会话（活动 = 磁盘上已有文件），再改名/删除。
	// （/sessions/new 的空白活动会话在首条 entry 前不落盘 —— Pi 纪律 —— 它既不进清单、
	//  也没有文件可删，侧栏永远列不到它，这两个 API 边角不可达、不作特殊化。）
	const loadA = await request("POST", "/sessions/load", { id: "sm-sess-a" });
	check("R7 load 合成会话为活动会话 ⇒ 200", loadA.status === 200 && (loadA.json?.messages ?? []).length === 2, loadA.status);
	const renameActive = await request("POST", "/sessions/rename", { id: "sm-sess-a", title: "活动会话改名" });
	check("R7 rename 活动会话（活实例分支）⇒ 200", renameActive.status === 200, renameActive);
	const list3 = await request("GET", "/sessions");
	const activeRow = (list3.json?.sessions ?? []).find((s) => s.id === "sm-sess-a");
	check("R7 活动会话改名已进清单（活实例 appendSessionInfo 落盘）", activeRow?.title === "活动会话改名", list3.json?.sessions);
	const delActive = await request("POST", "/sessions/delete", { id: "sm-sess-a" });
	check("R7 delete 活动会话 ⇒ 200（先换入空白再删）", delActive.status === 200, delActive);
	const list4 = await request("GET", "/sessions");
	check("R7 清单已净（活动会话文件被删）", (list4.json?.sessions ?? []).length === 0, list4.json?.sessions);
	const loadDeleted = await request("POST", "/sessions/load", { id: "sm-sess-a" });
	check("R7 已删会话 load ⇒ 404", loadDeleted.status === 404, loadDeleted.status);
	const health2 = await request("GET", "/health");
	check("R7 删除活动会话后 core 仍健康", health2.status === 200, health2.status);

	/* ============ R8：安全三件套对新区点同样生效 ============ */
	for (const ep of ["/sessions/rename", "/sessions/delete"]) {
		const noToken = await request("POST", ep, { id: "x" }, { token: "" });
		check(`R8 无 token → 401（POST ${ep}）`, noToken.status === 401, noToken.status);
		const badHost = await request("POST", ep, { id: "x" }, { host: "evil.example.com" });
		check(`R8 错 Host → 403（POST ${ep}）`, badHost.status === 403, badHost.status);
	}

	exitCode = checks.filter((c) => !c.pass).length > 0 ? 1 : 0;
} catch (e) {
	console.error("[sessions-manage] 异常中断:", e);
	exitCode = 1;
} finally {
	// 先等 core 子进程退出再清理 —— Windows 上进程活着时删它的 cwd 会 EPERM
	child.kill();
	await Promise.race([new Promise((r) => child.once("exit", r)), sleep(3_000)]);
	// 清理尽力而为：临时目录本就交给系统回收，删不掉不让它掩盖检查结论
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		/* 留给 OS 临时目录清理 */
	}
}

const evidence = { startedAt: new Date().toISOString(), checks };
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

const failed = checks.filter((c) => !c.pass).length;
if (failed > 0) {
	console.error(`\nsessions-manage 检查失败 ${failed} 项（证据：${evidencePath}）`);
	process.exit(1);
}
console.log(`sessions-manage 检查全部通过：${checks.length} 项（证据：${evidencePath}）`);
process.exit(exitCode);
