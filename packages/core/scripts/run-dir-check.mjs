/**
 * CORE_RUN_DIR 覆盖口检查 —— `check:run-dir`（打包批次 P1 验收，判据 B2）。
 *
 * 背景：运行时文件（core.json + events.jsonl）原来写死在源码旁 run/ —— 打包桌面端下
 * `__dirname` 落在只读介质（Electron asar / 安装目录），写入必炸。修复 = CORE_RUN_DIR
 * 覆盖口 + 坏值不崩（点名警告后回落默认，契约同 CORE_CWD）。
 *
 * 覆盖：
 *   R1  不设 env ⇒ 行为零变化：core.json 落默认 run/；
 *   R2  设 CORE_RUN_DIR=临时目录 ⇒ core.json + events.jsonl 落指定目录（且 port 命中）；
 *   R3  CORE_RUN_DIR 指向一个「已存在的文件」⇒ 打点警告、core 照常启动、文件回落默认 run/
 *       （坏值不崩）。
 *
 * 用法（在 packages/core 下）：`npm run check:run-dir`
 * 证据：`run/run-dir-evidence.json`；失败非 0 退出。
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
const defaultRunDir = path.join(coreDir, "run");
const evidencePath = path.join(defaultRunDir, "run-dir-evidence.json");
fs.mkdirSync(defaultRunDir, { recursive: true });

const PORT = Number(process.env.RUN_DIR_PORT ?? 5219);
const TOKEN = process.env.RUN_DIR_TOKEN ?? "run-dir-token";
const HTTP_TIMEOUT_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "run-dir-"));

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

async function waitForHealth(timeoutMs = 60_000) {
	const t0 = Date.now();
	for (;;) {
		try {
			const r = await request("GET", "/health");
			if (r.status === 200) return r.json;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() - t0 > timeoutMs) return null;
		await sleep(300);
	}
}

/** 起 core（每次独立 agentDir/临时 cwd），返回 child 与 stderr 收集器 */
function bootCore(extraEnv, logName) {
	const agentDir = path.join(tmpRoot, `agentdir-${logName}`);
	fs.mkdirSync(agentDir, { recursive: true });
	seedModelsJson(agentDir);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));
	const logFd = fs.openSync(path.join(defaultRunDir, logName), "w");
	const child = spawn(process.execPath, mainArgs, {
		cwd: fs.mkdtempSync(path.join(tmpRoot, `cwd-${logName}`)),
		env: childEnv({ CORE_TOKEN: TOKEN, CORE_PORT: String(PORT), CORE_AGENT_DIR: agentDir, ...extraEnv }),
		stdio: ["ignore", "ignore", logFd],
	});
	return { child, stderrPath: path.join(defaultRunDir, logName) };
}

const readCoreJson = (dir) => {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, "core.json"), "utf8"));
	} catch {
		return null;
	}
};

/* ---------------------------------------------------------------------------
 * 主流程（串行三段，共用同一端口：前一段必先杀干净再起下一段）
 * ------------------------------------------------------------------------- */

const evidence = { startedAt: new Date().toISOString(), judgments: {} };
let failed = 0;

/* ===== R1：不设 env ⇒ 行为零变化 ===== */
{
	fs.rmSync(path.join(defaultRunDir, "core.json"), { force: true });
	const { child } = bootCore({}, "run-dir-r1.log");
	const health = await waitForHealth();
	const coreJson = readCoreJson(defaultRunDir);
	check("R1 不设 CORE_RUN_DIR 时 core 正常启动", !!health, health);
	check("R1 core.json 落在默认 run/（行为零变化）", !!coreJson && coreJson.port === PORT, coreJson);
	child.kill("SIGTERM");
	await sleep(500);
}

/* ===== R2：设 CORE_RUN_DIR ⇒ 落指定目录 ===== */
{
	const target = path.join(tmpRoot, "custom-run");
	fs.rmSync(path.join(defaultRunDir, "core.json"), { force: true });
	const { child } = bootCore({ CORE_RUN_DIR: target }, "run-dir-r2.log");
	const health = await waitForHealth();
	const customJson = readCoreJson(target);
	check("R2 设 CORE_RUN_DIR 时 core 正常启动", !!health, health);
	check(
		"R2 core.json 落在指定目录且 port 命中",
		!!customJson && customJson.port === PORT,
		{ customJson, target },
	);
	check(
		"R2 events.jsonl 也在指定目录",
		fs.existsSync(path.join(target, "events.jsonl")),
		target,
	);
	check("R2 默认 run/ 不再写 core.json", !fs.existsSync(path.join(defaultRunDir, "core.json")));
	child.kill("SIGTERM");
	await sleep(500);
}

/* ===== R3：坏值（指向一个已存在的文件）⇒ 警告 + 回落，不崩 ===== */
{
	const badTarget = path.join(tmpRoot, "occupied.file");
	fs.writeFileSync(badTarget, "not a directory");
	fs.rmSync(path.join(defaultRunDir, "core.json"), { force: true });
	const { child, stderrPath } = bootCore({ CORE_RUN_DIR: badTarget }, "run-dir-r3.log");
	const health = await waitForHealth();
	const fallbackJson = readCoreJson(defaultRunDir);
	check("R3 CORE_RUN_DIR 指向文件时 core 仍启动（坏值不崩）", !!health, health);
	check("R3 core.json 回落默认 run/", !!fallbackJson && fallbackJson.port === PORT, fallbackJson);
	await sleep(300);
	const log = fs.readFileSync(stderrPath, "utf8");
	check(
		"R3 日志点名警告（不静默）",
		log.includes("CORE_RUN_DIR") && log.includes("警告"),
		log.split("\n").filter((l) => l.includes("警告")).join(" | ").slice(0, 200),
	);
	child.kill("SIGTERM");
	await sleep(500);
}

failed = checks.filter((c) => !c.pass).length;
fs.writeFileSync(
	evidencePath,
	JSON.stringify({ ...evidence, finishedAt: new Date().toISOString(), checks }, null, 2),
);
if (failed > 0) {
	console.error(`\nrun-dir 检查失败 ${failed} 项（证据：${evidencePath}）`);
	process.exit(1);
}
console.log(`run-dir 检查全部通过：${checks.length} 项（证据：${evidencePath}）`);
