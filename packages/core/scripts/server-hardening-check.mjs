/**
 * server-hardening-check —— core HTTP 面的 **live 实弹**健壮性检查。
 *
 * 为什么需要它（两条真实漏洞的回归防线）：
 *   P0-1 畸形百分号编码（`GET /%`）会让 decodeURIComponent 抛 URIError；
 *         `createServer(async …)` 的 rejected promise 无人 await，而 main.ts 没有
 *         unhandledRejection 兜底 ⇒ **一条请求打死整个 core 进程**。
 *         实测（review 阶段）：GET /% → 进程退出 code=1。
 *         桌面版更严重：core 一死 desktop/src/main.ts 会弹窗并 app.quit()，用户应用被关掉。
 *   P0-2 `apiKey` 以 `!` 开头会经 execSync 走 shell；入口 /models/test 与
 *         /providers/models 直接收请求体 ⇒ **单请求任意命令执行**（无需任何前置条件）。
 *
 * 覆盖：
 *   D1/D2/D3  畸形编码 GET /% /%zz /a%2 ⇒ 400，且**进程仍存活**（这是 P0-1 的核心断言）；
 *   D4        合法百分号编码（/%E4%B8%AD）仍正常 200（SPA 回退没被改坏）；
 *   D5        投毒后 /health 仍 200 且服务可用（不是只证明"没死"）；
 *   D6        对照：正常 SPA 回退 GET / 在投毒前后行为一致；
 *   K1        POST /models/test 带 apiKey="!echo …" ⇒ 400（且**命令没有执行**）；
 *   K2        POST /providers/models 带 apiKey="!…" ⇒ 400；
 *   K3        非 `!` 前缀的 apiKey（$ENV / 字面量）仍然照常受理（没把功能一起砍掉）；
 *   K4        显式证明 shell 没被执行 —— 落盘标记文件必须不存在。
 *
 * 端口：5220（避开 trust-policy 的 5210、c3 的 5197-5204）。
 * ⚠️ 与所有会起 core 的脚本同规：**必须串行跑**（core 启动即清空 run/events.jsonl）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, seedModelsJson } from "./lib/credentials.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, "..");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
const mainPath = path.join(coreDir, "src", "main.ts");
const runDir = path.join(coreDir, "run");
const evidencePath = path.join(runDir, "server-hardening-evidence.json");

const PORT = 5220;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TOKEN = "server-hardening-token";
const MARKER = "PIWORKBENCH_HARDENING_P0_2_9317";
const PROOF = path.join(os.tmpdir(), `hardening-p02-proof-${process.pid}.txt`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "server-hardening-"));
const agentDir = path.join(tmpRoot, "agentdir");
fs.mkdirSync(agentDir, { recursive: true });
seedModelsJson(agentDir);

const checks = [];
const check = (name, pass, detail) => {
	checks.push({ name, pass: !!pass, detail });
	console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

/* --------------------------------------------------------------------------- */
/* core 实例                                                                   */
/* --------------------------------------------------------------------------- */

fs.mkdirSync(runDir, { recursive: true });
const logPath = path.join(runDir, "server-hardening-core.log");
const logFd = fs.openSync(logPath, "w");
const child = spawn(process.execPath, [tsxPath, mainPath], {
	cwd: coreDir,
	env: childEnv({ CORE_TOKEN: TOKEN, CORE_PORT: String(PORT), CORE_AGENT_DIR: agentDir, CORE_RUN_DIR: tmpRoot }),
	stdio: ["ignore", logFd, logFd],
});
let exited = false;
let exitInfo = "";
child.on("exit", (code, sig) => {
	exited = true;
	exitInfo = `code=${code} signal=${sig}`;
});

async function closeCore() {
	child.kill("SIGTERM");
	await Promise.race([new Promise((r) => child.once("exit", r)), sleep(5000).then(() => child.kill("SIGKILL"))]);
	try {
		fs.closeSync(logFd);
	} catch {
		/* 已关 */
	}
}

async function req(method, p, body) {
	const headers = { Authorization: `Bearer ${TOKEN}` };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	try {
		const res = await fetch(`${ORIGIN}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
		const raw = await res.text();
		let json = null;
		try {
			json = JSON.parse(raw);
		} catch {
			/* 非 JSON */
		}
		return { status: res.status, json, raw };
	} catch (e) {
		return { status: 0, json: null, raw: String(e) };
	}
}

async function waitForHealth(timeoutMs = 60_000) {
	const t0 = Date.now();
	for (;;) {
		try {
			const r = await req("GET", "/health");
			if (r.status === 200) return r.json;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() - t0 > timeoutMs) return null;
		await sleep(300);
	}
}

/**
 * 原始 socket 发 HTTP —— 畸形路径**不能**走 fetch：
 * fetch/undici 会按 URL 规范把 `/%` 当非法 URL 直接本地抛错，根本发不出请求，
 * 于是断言变成"测客户端"而不是"测 core"。这正是 review 阶段 dos-probe 用 net 的原因。
 */
function rawGet(target) {
	return new Promise((resolve) => {
		const sock = net.connect(PORT, "127.0.0.1");
		let buf = "";
		let done = false;
		const finish = (v) => {
			if (done) return;
			done = true;
			try {
				sock.destroy();
			} catch {
				/* 已断 */
			}
			resolve(v);
		};
		sock.setTimeout(5000, () => finish("TIMEOUT"));
		sock.on("error", (e) => finish(`SOCKET_ERR ${e.code}`));
		sock.on("connect", () => {
			sock.write([`GET ${target} HTTP/1.1`, `Host: 127.0.0.1:${PORT}`, "Connection: close", "", ""].join("\r\n"));
		});
		sock.on("data", (d) => {
			buf += d.toString("latin1");
			if (buf.includes("\r\n\r\n")) finish(buf.split("\r\n")[0]);
		});
		sock.on("close", () => finish(buf ? buf.split("\r\n")[0] : "CLOSED_EMPTY"));
	});
}

/* --------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* --------------------------------------------------------------------------- */

const evidence = { startedAt: new Date().toISOString(), tmpRoot, port: PORT, steps: {} };
let exitCode = 1;

console.log(`[server-hardening] 临时目录 ${tmpRoot}`);
console.log("[server-hardening] 启动 core…");
try {
	const h0 = await waitForHealth();
	check("D0 core 启动就绪（/health 200）", !!h0, h0);
	if (!h0) throw new Error("core 未就绪");

	/* ---- 对照：投毒前 SPA 回退正常 ---- */
	const spa0 = await rawGet("/");
	evidence.steps.D_control_before = spa0;
	check("D0b 对照 GET / ⇒ 200（投毒前 SPA 回退正常）", /^HTTP\/1\.1 200/.test(String(spa0)), spa0);

	/* ---- D1/D2/D3 畸形编码：400 且进程存活 ---- */
	const malformed = ["/%", "/%zz", "/a%2"];
	const dResults = [];
	for (const target of malformed) {
		const r = await rawGet(target);
		dResults.push({ target, response: r, alive: !exited });
		await sleep(500);
		// 每个载荷后都立刻验存活 —— 三个载荷的响应都在但进程已死，是最典型的漏网形状
		if (exited) break;
	}
	evidence.steps.D_malformed = dResults;
	for (const { target, response, alive } of dResults) {
		check(`D 畸形编码 ${target} ⇒ 400（不是 5xx、不是断连）`, /^HTTP\/1\.1 400/.test(String(response)), response);
	}
	check("D1 投毒后进程仍存活（P0-1 核心断言）", !exited, { exited, exitInfo });

	/* ---- D4 合法百分号编码仍 200（没把正常路径改坏） ---- */
	const legit = await rawGet("/%E4%B8%AD");
	evidence.steps.D_legit = legit;
	check("D4 合法编码 /%E4%B8%AD ⇒ 200（SPA 回退未被误伤）", /^HTTP\/1\.1 200/.test(String(legit)), legit);

	/* ---- D5 投毒后服务仍真实可用（不只是"没死"） ---- */
	const h1 = await req("GET", "/health");
	evidence.steps.D_health_after = h1.json;
	check("D5 投毒后 /health 仍 200 且 ok=true", h1.status === 200 && h1.json?.ok === true, h1.json);
	const spa1 = await rawGet("/");
	check("D6 投毒后 SPA 回退仍 200（对照一致）", /^HTTP\/1\.1 200/.test(String(spa1)), spa1);

	/* ---- K1/K2/K3/K4 apiKey `!` 前缀 ---- */
	const cmdBody = (apiKey) => ({ baseUrl: "http://127.0.0.1:1", modelId: "x", api: "openai-completions", apiKey });
	const k1 = await req("POST", "/models/test", cmdBody(`!echo ${MARKER} > "${PROOF}"`));
	evidence.steps.K1 = k1.json;
	check("K1 /models/test 带 apiKey='!…' ⇒ 400", k1.status === 400, { status: k1.status, body: k1.json });

	const k2 = await req("POST", "/providers/models", { baseUrl: "http://127.0.0.1:1", apiKey: `!echo ${MARKER} > "${PROOF}"` });
	evidence.steps.K2 = k2.json;
	check("K2 /providers/models 带 apiKey='!…' ⇒ 400", k2.status === 400, { status: k2.status, body: k2.json });

	/* K3 非 `!` 前缀仍照常受理 —— 证明不是"把所有 apiKey 都拒了" */
	const k3 = await req("POST", "/models/test", cmdBody("$DEFINITELY_UNSET_ENV_VAR"));
	evidence.steps.K3 = k3.json;
	check(
		"K3 非 '!' 前缀（$ENV）仍受理 ⇒ 非 400（没把功能一起砍掉）",
		k3.status !== 400,
		{ status: k3.status, body: k3.json },
	);

	/* K4 硬证据：命令确实没被执行（落盘标记文件必须不存在） */
	await sleep(500);
	const executed = fs.existsSync(PROOF);
	evidence.steps.K4 = { proofPath: PROOF, executed };
	check("K4 shell 未被执行（落盘标记文件不存在）", !executed, { proofPath: PROOF, executed });

	evidence.finishedAt = new Date().toISOString();
	evidence.summary = {
		assertions: checks.length,
		passed: checks.filter((c) => c.pass).length,
		failed: checks.filter((c) => !c.pass).length,
	};
	evidence.checks = checks;
	fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
	console.log(`\n=== 断言汇总：${evidence.summary.passed}/${evidence.summary.assertions} 通过 ===`);
	console.log(`== 证据已写入 ${path.relative(coreDir, evidencePath)} ==`);
	exitCode = evidence.summary.failed === 0 ? 0 : 1;
} catch (e) {
	console.error("[server-hardening] 脚本异常:", e && e.stack ? e.stack : e);
	evidence.error = String(e);
	evidence.checks = checks;
	try {
		fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
	} catch {
		/* 忽略 */
	}
	exitCode = 1;
} finally {
	await closeCore();
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		/* 忽略 */
	}
	try {
		fs.rmSync(PROOF, { force: true });
	} catch {
		/* 忽略 */
	}
}

console.log(
	exitCode === 0
		? "\n服务端健壮性检查全部通过"
		: `\n服务端健壮性检查失败 ${checks.filter((c) => !c.pass).length} 项：\n - ${checks.filter((c) => !c.pass).map((c) => c.name).join("\n - ")}`,
);
process.exit(exitCode);
