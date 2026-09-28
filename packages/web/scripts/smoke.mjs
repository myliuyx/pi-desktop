/**
 * pi-web 发布包冒烟：模拟用户「npm i -g 后跑 bin」的路径 ——
 * assemble → 子进程起 bin（隔离的临时 CORE_RUN_DIR / CORE_AGENT_DIR，
 * 绝不碰 packages/core/run 以免顶掉手工 core 的 token）→ 轮询 core.json
 * 拿随机端口与 token → Bearer 探 /health → 整树杀 → 清理。
 * 任何一步失败都非零退出，成功打印一句话摘要。
 */
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isWin = process.platform === "win32";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-smoke-"));
const runDir = path.join(tmpRoot, "run");
const agentDir = path.join(tmpRoot, "agent");

const die = async (msg, child) => {
	console.error(`[smoke] ✗ ${msg}`);
	if (child?.pid) killTree(child.pid);
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	process.exit(1);
};

function killTree(pid) {
	try {
		if (isWin) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
		else process.kill(-pid, "SIGKILL");
	} catch {
		/* 进程已退出 */
	}
}

// 1) 组装（core/ui 产物缺失会在 assemble 里点名报错）
await new Promise((resolve, reject) => {
	const p = spawn(process.execPath, [path.join(pkgRoot, "scripts", "assemble.mjs")], { stdio: "inherit" });
	p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`assemble exit ${code}`))));
}).catch((e) => die(e.message));

// 2) 起 bin（隔离环境：随机端口、临时运行时目录与 agent 目录）
const child = spawn(process.execPath, [path.join(pkgRoot, "bin", "pi-web.mjs")], {
	stdio: ["ignore", "pipe", "pipe"],
	...(isWin ? {} : { detached: true }),
	env: { ...process.env, CORE_RUN_DIR: runDir, CORE_AGENT_DIR: agentDir },
});
let stderr = "";
child.stderr.on("data", (c) => (stderr += c));
child.stdout.on("data", (c) => process.stdout.write(`  ${c}`));

// 3) 轮询 core.json（bin 起 core，core 落端口与 token）
const coreJson = path.join(runDir, "core.json");
let conn;
for (let i = 0; i < 100; i++) {
	await new Promise((r) => setTimeout(r, 200));
	if (fs.existsSync(coreJson)) {
		try {
			conn = JSON.parse(fs.readFileSync(coreJson, "utf8"));
			break;
		} catch {
			/* 写到一半，下一轮再读 */
		}
	}
	if (child.exitCode !== null) await die(`bin 提前退出（code ${child.exitCode}）\n${stderr}`, child);
}
if (!conn) await die(`20s 内未等到 core.json\n${stderr}`, child);

// 4) Bearer 探 /health
try {
	const res = await fetch(`http://127.0.0.1:${conn.port}/health`, {
		headers: { authorization: `Bearer ${conn.token}` },
	});
	if (!res.ok) await die(`/health 返回 ${res.status}`, child);
	const body = await res.json();
	console.log(`[smoke] /health 200 → ${JSON.stringify(body)}`);
} catch (e) {
	await die(`/health 请求失败：${e.message}`, child);
}

// 4.5) C7/C8 设置 Tab 的数据端点必须真实在线：过期产物没有这两个路由，
// GET 会落进 SPA 回退拿 200 + index.html（2026-09-28 事故形态，前端表现为
// 「读取技能清单失败（HTTP 200）」）—— /health 探不出来，这里一票拦下
for (const [ep, listKey] of [["/skills", "skills"], ["/packages", "packages"]]) {
	try {
		const res = await fetch(`http://127.0.0.1:${conn.port}${ep}`, {
			headers: { authorization: `Bearer ${conn.token}` },
		});
		const body = await res.json().catch(() => null);
		if (!res.ok || body?.ok !== true || !Array.isArray(body?.[listKey])) {
			await die(
				`${ep} 未通过（HTTP ${res.status}，ok=${body?.ok}）—— core 产物疑似过期（路由缺失落 SPA 回退）`,
				child,
			);
		}
		console.log(`[smoke] ${ep} 200 → ok:true（${body[listKey].length} 项）`);
	} catch (e) {
		await die(`${ep} 请求失败：${e.message}`, child);
	}
}

// 5) 整树杀 + 清理（events.jsonl 留在临时目录一并删除）
killTree(child.pid);
await new Promise((r) => setTimeout(r, 500));
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`[smoke] ✓ pi-web 可用（端口 ${conn.port}，随机 token），进程零残留，临时目录已清理`);
