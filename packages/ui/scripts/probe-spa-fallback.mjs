/**
 * probe:spa-fallback —— SPA 回退伪装事故的回归探针（2026-09-28 review P1）。
 *
 * 背景（9-28 技能清单事故）：旧 core 没有 /skills 路由时，GET /skills 落进 SPA 回退返回
 * 200 HTML —— 前端 res.json() 解析失败，报出「HTTP 200」这种自相矛盾的错误。修复后 core
 * 对「API_ROUTES 声明了却没匹配上」的请求一律 404 JSON（server.ts 尾部拦截行），未声明
 * 路径的 GET 仍走 SPA 回退（应用用 hash 路由，单页即可）。
 *
 * 断言四条（纯 HTTP，不起浏览器；自起 core :5197，tsx 直跑源码，临时 run/agentdir）：
 *   A1 GET /prompt（已声明、无 GET 实现，带 token）→ 404 JSON 且 error 含「端点未实现」
 *      —— 修复前此请求回 200 HTML，是行为翻转的直接证据；
 *   A2 GET /nonexistent（未声明路径）→ 200 text/html —— SPA 回退保留，hash 路由不受影响；
 *   A3 GET /skills（已声明且已实现，带 token）→ 200 application/json —— 正常路径无回归；
 *   A4 GET /prompt 无 token → 401 —— 鉴权先于一切，顺序无回归。
 *
 * 证据：_probe-spa-fallback-evidence.json（已 gitignore，不入库）；失败非 0 退出。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv } from "../../core/scripts/lib/credentials.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(here, "..");
const coreDir = path.join(uiDir, "..", "core");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
/** ⚠️ 必须绝对路径：core 的 cwd 会被指到临时目录，相对路径会解析错（probe-c5 首跑实踩） */
const mainPath = path.join(coreDir, "src", "main.ts");

const CORE_PORT = Number(process.env.PROBE_SPA_CORE_PORT ?? 5197);
const TOKEN = process.env.PROBE_SPA_TOKEN ?? "probe-spa-token";
const evidencePath = path.join(uiDir, "_probe-spa-fallback-evidence.json");

/* ---- 临时 run/agentdir：core.json 与会话落盘全进临时目录，不碰仓库 run/（core.json 覆写竞态坑） ---- */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-spa-"));
const runDir = path.join(tmpRoot, "run");
const agentDir = path.join(tmpRoot, "agentdir");
fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(
	path.join(agentDir, "settings.json"),
	JSON.stringify({ defaultProjectTrust: "never" }, null, 2),
);

/* ---- HTTP 帮手：回 {status, contentType, body}；body 为解析后的 JSON（非 JSON 时 null） ---- */
function request(method, p, withToken = true) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port: CORE_PORT,
				path: p,
				method,
				headers: withToken ? { Authorization: `Bearer ${TOKEN}` } : {},
				timeout: 30_000,
			},
			(res) => {
				let d = "";
				res.on("data", (c) => (d += c));
				res.on("end", () => {
					let json = null;
					try {
						json = JSON.parse(d);
					} catch {
						/* 非 JSON（正是 A1/A2 要分辨的形态） */
					}
					resolve({
						status: res.statusCode,
						contentType: res.headers["content-type"] ?? "",
						json,
						raw: d,
					});
				});
			},
		);
		req.on("error", reject);
		req.on("timeout", () => req.destroy(new Error("timeout")));
		req.end();
	});
}

async function waitForHealth(timeoutMs = 60_000) {
	const t0 = Date.now();
	for (;;) {
		try {
			const r = await request("GET", "/health");
			if (r.status === 200 && r.json?.extensions !== null) return r.json;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() - t0 > timeoutMs) return null;
		await new Promise((r) => setTimeout(r, 300));
	}
}

/* ---- 断言记录（与 probe:settings:skills 同款口径：证据文件 + 控制台，非 0 退出） ---- */
const ctx = { startedAt: new Date().toISOString(), assertions: [] };
let failures = 0;
function assert(name, detail) {
	ctx.assertions.push({ name, detail, pass: Object.values(detail).every((v) => v !== false) });
	const failed = Object.entries(detail)
		.filter(([, v]) => v === false)
		.map(([k]) => k);
	const pass = failed.length === 0;
	if (!pass) failures += 1;
	console.log(
		`\n### [${pass ? "PASS" : "FAIL"}] ${name}\n${JSON.stringify(detail, null, 2)}${
			failed.length ? `\n  ✗ 未通过：${failed.join(", ")}` : ""
		}`,
	);
}

const logFd = fs.openSync(path.join(tmpRoot, "core-stderr.log"), "w");
const child = spawn(process.execPath, [tsxPath, mainPath], {
	cwd: tmpRoot,
	env: childEnv({
		CORE_TOKEN: TOKEN,
		CORE_PORT: String(CORE_PORT),
		CORE_AGENT_DIR: agentDir,
		CORE_RUN_DIR: runDir,
	}),
	stdio: ["ignore", "ignore", logFd],
});

try {
	const health = await waitForHealth();
	if (!health) throw new Error(`core 未就绪（端口 ${CORE_PORT}）`);

	/* ---- A1 声明路由漏实现：404 JSON，绝不回 SPA HTML ---- */
	const a1 = await request("GET", "/prompt");
	ctx.A1 = { status: a1.status, contentType: a1.contentType, body: a1.json };
	assert("A1 GET /prompt（已声明、无 GET 实现）→ 404 JSON 含「端点未实现」", {
		状态404: a1.status === 404,
		contentType是JSON: a1.contentType.includes("application/json"),
		error含端点未实现: typeof a1.json?.error === "string" && a1.json.error.includes("端点未实现"),
	});

	/* ---- A2 未声明路径：SPA 回退保留 ---- */
	const a2 = await request("GET", "/nonexistent-endpoint");
	ctx.A2 = { status: a2.status, contentType: a2.contentType };
	assert("A2 GET /nonexistent（未声明路径）→ 200 text/html（SPA 回退保留）", {
		状态200: a2.status === 200,
		contentType是HTML: a2.contentType.includes("text/html"),
	});

	/* ---- A3 正常路径无回归 ---- */
	const a3 = await request("GET", "/skills");
	ctx.A3 = { status: a3.status, contentType: a3.contentType };
	assert("A3 GET /skills（已声明且已实现）→ 200 application/json", {
		状态200: a3.status === 200,
		contentType是JSON: a3.contentType.includes("application/json"),
		ok为true: a3.json?.ok === true,
	});

	/* ---- A4 鉴权先于一切 ---- */
	const a4 = await request("GET", "/prompt", false);
	ctx.A4 = { status: a4.status, contentType: a4.contentType, body: a4.json };
	assert("A4 GET /prompt 无 token → 401 JSON（鉴权先于路由匹配）", {
		状态401: a4.status === 401,
		contentType是JSON: a4.contentType.includes("application/json"),
	});
} catch (e) {
	console.error("[probe-spa] 异常：", e?.message ?? e);
	ctx.failedAt = e?.message ?? String(e);
	failures += 1;
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

fs.writeFileSync(evidencePath, JSON.stringify(ctx, null, 2));
console.log(
	failures === 0
		? "\n== probe:spa-fallback 全部通过 =="
		: `\n== probe:spa-fallback 有 ${failures} 处失败（见上方 ✗ 与证据文件） ==`,
);
process.exit(failures === 0 ? 0 : 1);
