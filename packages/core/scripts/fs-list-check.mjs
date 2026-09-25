/**
 * /fs/list 目录浏览端点检查 —— `check:fs-list`（dir-picker 批次 P0 验收，task-dir-picker.md §5.1）。
 *
 * 覆盖（单 core 串行请求，CORE_CWD 不设 ⇒ 缺省列目录 = 进程 cwd 夹具）：
 *   F1  无 token ⇒ 401（API_ROUTES 鉴权生效）；
 *   F2  缺省 path ⇒ path === core 进程 cwd；
 *   F3  已知结构 ⇒ 仅列目录、排除文件、含隐藏目录、码元排序（.hidden < alpha < beta）；
 *   F4  entries[].path 均为绝对路径且以 target 为前缀；
 *   F5  parent === dirname(target)；从夹具逐级向上，根的 parent === null；
 *   F6  不存在路径 ⇒ 400「目录不存在」；
 *   F7  文件路径 ⇒ 400「不是目录」；
 *   F8  501 个子目录 ⇒ 恰 500 条 + truncated: true；
 *   F9  path=~ ⇒ 展开 os.homedir()；
 *   F10 path=.（相对）⇒ 解析到 core cwd；
 *   F11 win32：非根目录无 drives 字段，盘根 drives 非空；POSIX：列 "/" 不崩且无 drives。
 *
 * 用法（在 packages/core 下）：`npm run check:fs-list`
 * 证据：`run/fs-list-evidence.json`；失败非 0 退出。
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
const evidencePath = path.join(runDir, "fs-list-evidence.json");
fs.mkdirSync(runDir, { recursive: true });

const PORT = Number(process.env.FS_LIST_PORT ?? 5231);
const TOKEN = process.env.FS_LIST_TOKEN ?? "fs-list-token";
const HTTP_TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fs-list-"));

/* ---------------------------------------------------------------------------
 * 夹具：core 以 cwd-fixture 为进程 cwd；browsing/ 为确定性结构；many/ 有 501 个子目录
 * ------------------------------------------------------------------------- */
const coreCwd = path.join(tmpRoot, "cwd-fixture");
const browsingDir = path.join(coreCwd, "browsing");
fs.mkdirSync(browsingDir, { recursive: true });
fs.mkdirSync(path.join(browsingDir, "alpha"));
fs.mkdirSync(path.join(browsingDir, "beta"));
fs.mkdirSync(path.join(browsingDir, ".hidden"));
fs.writeFileSync(path.join(browsingDir, "file.txt"), "不是目录");
const manyDir = path.join(coreCwd, "many");
fs.mkdirSync(manyDir, { recursive: true });
for (let i = 0; i < 501; i++) fs.mkdirSync(path.join(manyDir, `d${String(i).padStart(3, "0")}`));

const checks = [];
const check = (name, pass, detail) => {
	checks.push({ name, pass: !!pass, detail });
	console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

function request(p, { token = TOKEN, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
	return new Promise((resolve, reject) => {
		const headers = {};
		if (token) headers.Authorization = `Bearer ${token}`;
		const req = http.request(
			{ host: "127.0.0.1", port: PORT, path: p, method: "GET", headers, timeout: timeoutMs },
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
		req.end();
	});
}

const list = (target, opts) => request(`/fs/list${target ? `?path=${encodeURIComponent(target)}` : ""}`, opts);

async function waitForHealth(timeoutMs = 60_000) {
	const t0 = Date.now();
	for (;;) {
		try {
			const r = await request("/health");
			if (r.status === 200) return r.json;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() - t0 > timeoutMs) return null;
		await sleep(300);
	}
}

/* 起 core：agentDir 隔离（绝不碰 ~/.pi/agent），进程 cwd = 夹具 */
function bootCore() {
	const agentDir = path.join(tmpRoot, "agentdir");
	fs.mkdirSync(agentDir, { recursive: true });
	seedModelsJson(agentDir);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));
	const logFd = fs.openSync(path.join(runDir, "fs-list.log"), "w");
	return spawn(process.execPath, mainArgs, {
		cwd: coreCwd,
		env: childEnv({ CORE_TOKEN: TOKEN, CORE_PORT: String(PORT), CORE_AGENT_DIR: agentDir }),
		stdio: ["ignore", "ignore", logFd],
	});
}

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */

const evidence = { startedAt: new Date().toISOString(), checks: [] };
const child = bootCore();
try {
	const health = await waitForHealth();
	check("前置 core 正常启动", !!health, health);
	if (!health) throw new Error("core 未能在 60s 内就绪");

	/* ===== F1：无 token ⇒ 401 ===== */
	{
		const r = await list(browsingDir, { token: "" });
		check("F1 无 token ⇒ 401（API_ROUTES 鉴权生效）", r.status === 401, { status: r.status });
	}

	/* ===== F2：缺省 path ⇒ core 进程 cwd ===== */
	{
		const r = await list("");
		check(
			"F2 缺省 path ⇒ path === core 进程 cwd",
			r.status === 200 && r.json?.path === coreCwd,
			{ status: r.status, got: r.json?.path, want: coreCwd },
		);
	}

	/* ===== F3：已知结构 ⇒ 仅目录 / 排文件 / 含隐藏 / 码元排序 ===== */
	{
		const r = await list(browsingDir);
		const names = Array.isArray(r.json?.entries) ? r.json.entries.map((e) => e.name) : null;
		check(
			"F3 entries 恰 [.hidden, alpha, beta]（排序+排文件+含隐藏）",
			r.status === 200 &&
				JSON.stringify(names) === JSON.stringify([".hidden", "alpha", "beta"]) &&
				r.json.path === browsingDir,
			{ status: r.status, names, want: [".hidden", "alpha", "beta"] },
		);
	}

	/* ===== F4：entries[].path 绝对且以 target 为前缀 ===== */
	{
		const r = await list(browsingDir);
		const ok =
			Array.isArray(r.json?.entries) &&
			r.json.entries.length > 0 &&
			r.json.entries.every((e) => path.isAbsolute(e.path) && e.path.startsWith(browsingDir));
		check("F4 entries[].path 均为绝对路径且以 target 为前缀", ok, r.json?.entries);
	}

	/* ===== F5：parent 链到根，根 parent === null ===== */
	{
		const r = await list(browsingDir);
		const okParent = r.json?.parent === coreCwd;
		let chainOk = true;
		let p = coreCwd;
		for (;;) {
			const parent = path.dirname(p);
			if (parent === p) break;
			const rr = await list(p);
			if (rr.json?.parent !== parent) {
				chainOk = false;
				break;
			}
			p = parent;
		}
		const root = await list(p);
		check("F5 browsing 的 parent === 夹具根", okParent, { got: r.json?.parent, want: coreCwd });
		check(
			"F5 逐级向上 parent 链正确，根的 parent === null",
			chainOk && root.json?.parent === null,
			{ chainOk, rootPath: root.json?.path, rootParent: root.json?.parent },
		);
	}

	/* ===== F6/F7：400 语义 ===== */
	{
		const missing = await list(path.join(coreCwd, "no-such-dir"));
		check(
			"F6 不存在路径 ⇒ 400「目录不存在」",
			missing.status === 400 && missing.json?.error?.includes("目录不存在"),
			{ status: missing.status, error: missing.json?.error },
		);
		const fileAsDir = await list(path.join(browsingDir, "file.txt"));
		check(
			"F7 文件路径 ⇒ 400「不是目录」",
			fileAsDir.status === 400 && fileAsDir.json?.error?.includes("不是目录"),
			{ status: fileAsDir.status, error: fileAsDir.json?.error },
		);
	}

	/* ===== F8：501 个子目录 ⇒ 恰 500 + truncated ===== */
	{
		const r = await list(manyDir);
		check(
			"F8 501 子目录 ⇒ entries.length === 500 且 truncated === true",
			r.status === 200 && r.json?.entries?.length === 500 && r.json?.truncated === true,
			{ status: r.status, count: r.json?.entries?.length, truncated: r.json?.truncated },
		);
	}

	/* ===== F9/F10：~ 展开与相对路径 ===== */
	{
		const home = await list("~");
		check("F9 path=~ ⇒ os.homedir()", home.status === 200 && home.json?.path === os.homedir(), {
			status: home.status,
			got: home.json?.path,
			want: os.homedir(),
		});
		const dot = await list(".");
		check("F10 path=. ⇒ 解析到 core cwd", dot.status === 200 && dot.json?.path === coreCwd, {
			status: dot.status,
			got: dot.json?.path,
			want: coreCwd,
		});
	}

	/* ===== F11：drives 字段 ===== */
	{
		const nonRoot = await list(manyDir);
		const driveRoot = path.parse(os.tmpdir()).root;
		const atRoot = await list(driveRoot);
		if (process.platform === "win32") {
			check(
				"F11 win32：非根目录无 drives；盘根 drives 非空数组",
				nonRoot.json?.drives === undefined &&
					Array.isArray(atRoot.json?.drives) &&
					atRoot.json.drives.length > 0,
				{ nonRootDrives: nonRoot.json?.drives, rootDrives: atRoot.json?.drives, driveRoot },
			);
		} else {
			const posixRoot = await list("/");
			check(
				"F11 POSIX：列 / 不崩、parent null、无 drives 字段",
				posixRoot.status === 200 &&
					posixRoot.json?.parent === null &&
					posixRoot.json?.drives === undefined,
				{ status: posixRoot.status, parent: posixRoot.json?.parent },
			);
		}
	}
} catch (e) {
	check("脚本异常终止", false, String(e));
} finally {
	child.kill("SIGTERM");
	await sleep(500);
}

evidence.finishedAt = new Date().toISOString();
evidence.checks = checks;
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

const failed = checks.filter((c) => !c.pass).length;
if (failed > 0) {
	console.error(`\nfs-list 检查失败 ${failed} 项（证据：${evidencePath}）`);
	process.exit(1);
}
console.log(`fs-list 检查全部通过：${checks.length} 项（证据：${evidencePath}）`);
