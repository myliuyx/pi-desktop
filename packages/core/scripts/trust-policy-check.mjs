/**
 * trust-policy-check —— 「项目扩展授权询问」开关的 **live 实弹**检查
 * （规格书 `.plan/task-trust-policy-switch.md` §四）。
 *
 * 为什么需要它（而不是只靠人工点 5190）：
 * §四 的四步原本是「起 core → 切目录 → 看浮层」的人工步骤，一旦人不在就会漂移。
 * 本脚本把它固化成可复跑的断言，**全程不需要真实模型**（不发消息、不调工具），
 * 因此不受 c3 判据①那种「模型不调工具」的环境波动影响。
 *
 * 覆盖：
 *   T1 出厂默认：`settings.json` 无该键 ⇒ `GET /trust-policy` = `{ask:false, policy:"always"}`；
 *   T2 夹具自造（A2）：cwd 含 `.pi/extensions` ⇒ 真的走到 policy 分支（`reason=always`），
 *      而不是被 `no-project-resources` 短路 —— 否则后面各步全是假绿；
 *   T3 开关打开 ⇒ 200 且 **落盘**（`await flush()`，C4）：磁盘上必须是 `"ask"`；
 *   T4 `POST {ask:"true"}` ⇒ 400（字符串不得混入）；
 *   T5 切目录即生效（无需重启）：ask 态切到另一含 `.pi` 的目录 ⇒ SSE 收到信任提问；
 *   T6 答「不信任」⇒ `reason=user-declined` 且项目扩展不加载（安全兜底未翻转）；
 *   T7 `never` 态：不提问、不加载（`reason=never`）；
 *   T8 `never` 写保护：POST 被 400 拒绝，且磁盘值**不被覆写**。
 *
 * 端口：5210（避开 c3 的 5197-5204）。证据：`packages/core/run/trust-policy-evidence.json`。
 *
 * ⚠️ 与所有会起 core 的脚本同规：**必须串行跑**（core 启动即清空 `run/events.jsonl`）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, seedModelsJson } from "./lib/credentials.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, "..");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
const mainPath = path.join(coreDir, "src", "main.ts");
const fixtureExtSrc = path.join(coreDir, "test", "fixtures", "agentdir-ext", "extensions", "approval-gate.ts");
const runDir = path.join(coreDir, "run");
const evidencePath = path.join(runDir, "trust-policy-evidence.json");

const PORT = 5210;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TOKEN = "trust-policy-token";
const TRUST_DECLINE = "不信任（本次不加载）";
const TRUST_TITLE_HEAD = "将加载并执行项目本地扩展";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trust-policy-"));

const checks = [];
const check = (name, pass, detail) => {
	checks.push({ name, pass: !!pass, detail });
	console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

/* ---------------------------------------------------------------------------
 * 夹具
 * ------------------------------------------------------------------------- */

const agentDir = path.join(tmpRoot, "agentdir");
fs.mkdirSync(agentDir, { recursive: true });
seedModelsJson(agentDir);

/** 出厂状态：settings.json **不含** defaultProjectTrust（复现未配置） */
const settingsPath = path.join(agentDir, "settings.json");
fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2));
const readSettings = () => {
	try {
		return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	} catch {
		return null;
	}
};

/** 造含 `.pi/extensions` 的目录 —— 缺了它，`hasTrustRequiringProjectResources` 判 false（A2） */
function makeProjectCwd(name) {
	const cwd = path.join(tmpRoot, `${name}-cwd`);
	fs.mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
	fs.copyFileSync(fixtureExtSrc, path.join(cwd, ".pi", "extensions", "approval-gate.ts"));
	return cwd;
}
const cwdA = makeProjectCwd("a");
const cwdB = makeProjectCwd("b");

/* ---------------------------------------------------------------------------
 * core 实例 + HTTP/SSE
 * ------------------------------------------------------------------------- */

function launchCore({ cwd }) {
	const logPath = path.join(runDir, "trust-policy-core.log");
	fs.mkdirSync(runDir, { recursive: true });
	const logFd = fs.openSync(logPath, "w");
	const child = spawn(process.execPath, [tsxPath, mainPath], {
		cwd,
		env: childEnv({ CORE_TOKEN: TOKEN, CORE_PORT: String(PORT), CORE_AGENT_DIR: agentDir }),
		stdio: ["ignore", logFd, logFd],
	});
	return {
		logPath,
		async close() {
			child.kill("SIGTERM");
			await Promise.race([new Promise((r) => child.once("exit", r)), sleep(5000).then(() => child.kill("SIGKILL"))]);
			try {
				fs.closeSync(logFd);
			} catch {
				/* 已关 */
			}
		},
	};
}

async function req(method, p, body) {
	const headers = { Authorization: `Bearer ${TOKEN}` };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await fetch(`${ORIGIN}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	const raw = await res.text();
	let json = null;
	try {
		json = JSON.parse(raw);
	} catch {
		/* 非 JSON */
	}
	return { status: res.status, json, raw };
}

async function waitForHealth(ok, timeoutMs = 60_000) {
	const t0 = Date.now();
	for (;;) {
		try {
			const r = await req("GET", "/health");
			if (r.status === 200 && r.json && ok(r.json)) return r.json;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() - t0 > timeoutMs) return null;
		await sleep(300);
	}
}

async function openSse(onFrame) {
	const ctrl = new AbortController();
	const task = (async () => {
		const res = await fetch(`${ORIGIN}/events`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ctrl.signal });
		if (!res.ok || !res.body) throw new Error(`SSE 连接失败：HTTP ${res.status}`);
		const reader = res.body.getReader();
		const dec = new TextDecoder();
		let buf = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			const parts = buf.split("\n\n");
			buf = parts.pop() ?? "";
			for (const part of parts) {
				const line = part.split("\n").find((l) => l.startsWith("data: "));
				if (!line) continue;
				let ev;
				try {
					ev = JSON.parse(line.slice(6));
				} catch {
					continue;
				}
				await onFrame(ev);
			}
		}
	})().catch((e) => {
		if (!ctrl.signal.aborted) console.error("[trust-policy] SSE 异常:", e.message);
	});
	return {
		task,
		async close() {
			ctrl.abort();
			await Promise.race([task, sleep(1000)]);
		},
	};
}

/** 等提问帧出现（轮询 frames 数组） */
async function waitFor(frames, predicate, timeoutMs = 30_000) {
	const t0 = Date.now();
	for (;;) {
		const hit = frames.find(predicate);
		if (hit) return hit;
		if (Date.now() - t0 > timeoutMs) return null;
		await sleep(200);
	}
}

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */

const evidence = { startedAt: new Date().toISOString(), tmpRoot, cwdA, cwdB, steps: {} };
let exitCode = 1;

console.log(`[trust-policy] 临时目录 ${tmpRoot}`);
console.log("[trust-policy] 启动 core（cwd = 夹具 A，含 .pi/extensions）…");
const core = launchCore({ cwd: cwdA });

try {
	const health0 = await waitForHealth((h) => h.extensions !== null);
	check("T0 core 启动就绪（/health.extensions 非空）", !!health0, health0);

	/* ---- T1/T2 出厂默认：不询问 + 自动信任 ---- */
	const p1 = await req("GET", "/trust-policy");
	evidence.steps.T1 = p1.json;
	check(
		"T1 出厂默认（未配置）：GET /trust-policy = {ask:false, policy:'always'}",
		p1.status === 200 && p1.json?.ask === false && p1.json?.policy === "always",
		p1.json,
	);
	evidence.steps.T2 = health0?.trust;
	check(
		"T2 夹具真的走到 policy 分支（reason=always，非 no-project-resources）",
		health0?.trust?.reason === "always" && health0?.trust?.trusted === true && health0?.trust?.asked === false,
		health0?.trust,
	);

	/* ---- T3 打开开关：200 + 落盘（C4 flush） ---- */
	const p3 = await req("POST", "/trust-policy", { ask: true });
	evidence.steps.T3 = { response: p3.json, onDisk: readSettings() };
	check(
		"T3 打开开关：返回 policy=ask 且**已落盘**（await flush() 生效）",
		p3.status === 200 && p3.json?.policy === "ask" && readSettings()?.defaultProjectTrust === "ask",
		{ response: p3.json, onDisk: readSettings() },
	);

	/* ---- T4 非布尔 ⇒ 400 ---- */
	const p4 = await req("POST", "/trust-policy", { ask: "true" });
	evidence.steps.T4 = p4.json;
	check("T4 POST ask='true'（字符串）⇒ 400", p4.status === 400, p4.status);

	/* ---- T5 切目录即生效：ask 态下出现信任提问 ---- */
	const frames = [];
	const sse = await openSse(async (ev) => {
		frames.push(ev);
	});
	// SSE 的 fetch 是异步的，等它真的连上再切目录，否则提问帧可能早于连接（漏帧）
	await sleep(500);
	/*
	 * ⚠️ 不能 `await` 这个 POST 再去应答：switchCwd **内部就会等提问有结论**，
	 * 直接 await 会一直挂到提问超时（120s）才返回 —— 那时 pending 已被清掉，
	 * 后面的 /approve 只能拿到 `accepted:false`（首跑就栽在这里）。
	 * 正确姿势：并发 —— 发请求的同时轮询 SSE 帧，拿到提问立刻应答，最后再收 switch 的结果。
	 */
	const swPromise = req("POST", "/cwd", { dir: cwdB });
	const question = await waitFor(frames, (ev) => ev.type === "approval_request");
	evidence.steps.T5 = { question };
	/* T5 的断言放在 T6 之后 —— 要等 switchCwd 的响应一起断言（见上面的并发注释） */

	/* ---- T6 答「不信任」⇒ user-declined 且不加载 ---- */
	if (question) {
		const approve = await req("POST", "/approve", { requestId: question.requestId, choice: TRUST_DECLINE });
		const settled = await waitFor(frames, (ev) => ev.type === "approval_settled");
		await sleep(500);
		const health1 = await req("GET", "/health");
		evidence.steps.T6 = { approve: approve.json, settled, trust: health1.json?.trust, extensions: health1.json?.extensions };
		check(
			"T6 答「不信任」⇒ reason=user-declined 且项目扩展不加载（安全兜底未翻转）",
			health1.json?.trust?.reason === "user-declined" && health1.json?.extensions === 0,
			{ trust: health1.json?.trust, extensions: health1.json?.extensions },
		);
		check("T6b 提问被受理（accepted:true）", approve.json?.accepted === true, approve.json);
	} else {
		check("T6 答「不信任」⇒ reason=user-declined 且项目扩展不加载（安全兜底未翻转）", false, "T5 未拿到提问");
	}

	/* switchCwd 的响应：提问被应答后才会返回，结论应当就是刚才那次应答 */
	const sw = await swPromise;
	evidence.steps.T5.switch = sw.json;
	check(
		"T5 切目录即生效（无需重启）：ask 态切到含 .pi 的目录 ⇒ 弹出信任提问",
		!!question && String(question.title ?? "").includes(TRUST_TITLE_HEAD) && sw.status === 200 && sw.json?.trust?.reason === "user-declined",
		{ status: sw.status, 提问数: frames.filter((f) => f.type === "approval_request").length, 标题: question?.title, trust: sw.json?.trust },
	);
	await sse.close();

	/* ---- T7/T8 never 态：不提问、不加载、POST 被拒且不覆写 ---- */
	fs.writeFileSync(settingsPath, JSON.stringify({ defaultProjectTrust: "never" }, null, 2));
	// 切目录即重建 SettingsManager ⇒ 重读 settings.json 的 never（无需重启 core）
	await req("POST", "/cwd", { dir: cwdA });
	await sleep(800);
	const health2 = await req("GET", "/health");
	const p7 = await req("GET", "/trust-policy");
	evidence.steps.T7 = { trust: health2.json?.trust, extensions: health2.json?.extensions, policy: p7.json };
	check(
		"T7 never 态：不提问、不加载（reason=never）",
		health2.json?.trust?.reason === "never" && health2.json?.extensions === 0 && p7.json?.policy === "never",
		{ trust: health2.json?.trust, extensions: health2.json?.extensions, policy: p7.json },
	);

	const p8 = await req("POST", "/trust-policy", { ask: false });
	evidence.steps.T8 = { status: p8.status, response: p8.json, onDisk: readSettings() };
	check(
		"T8 never 写保护：POST 被 400 拒绝，且磁盘值不被覆写",
		p8.status === 400 && readSettings()?.defaultProjectTrust === "never",
		{ status: p8.status, onDisk: readSettings() },
	);

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
	console.error("[trust-policy] 脚本异常:", e && e.stack ? e.stack : e);
	evidence.error = String(e);
	evidence.checks = checks;
	try {
		fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
	} catch {
		/* 忽略 */
	}
	exitCode = 1;
} finally {
	await core.close();
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		/* 忽略 */
	}
}

console.log(
	exitCode === 0
		? "\n信任策略开关 live 实弹 检查全部通过"
		: `\n信任策略开关 检查失败 ${checks.filter((c) => !c.pass).length} 项：\n - ${checks.filter((c) => !c.pass).map((c) => c.name).join("\n - ")}`,
);
process.exit(exitCode);
