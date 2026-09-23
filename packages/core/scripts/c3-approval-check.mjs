/**
 * C3 · 授权闭环 + 项目扩展信任门 —— 检查脚本（node 直跑，不引框架）。
 *
 * 覆盖规格书 §1.5 的三个判据，**三条都留证据**（`run/c3-evidence.json`）：
 *   ① 真实授权往返：core 用夹具 agentDir（含全局 approval-gate 扩展）+ 真实模型启动，
 *      prompt 触发 bash → SSE 收 `approval_request` → POST /approve 应答「拒绝」→ 收
 *      `approval_settled`；断言不挂死且事件序列完整（被拒后仍走 tool_execution_start/end，isError）。
 *   ② 幂等：同一 requestId 二次 POST → `accepted:false`、服务不报错；未知 id 同样静默；
 *      另对「活跃未决请求」走一次 POST /cancel-approval → `accepted:true` + `settled(cancelled)`。
 *   ③ 信任门三态：造含 `.pi/extensions/` 的临时 cwd，`never`→加载 0 / `always`→加载 1 /
 *      `ask`→出现信任提问，「拒绝」后为 0；另补 `ask+信任`→1 与 `ask+超时`→0（超时即安全默认）。
 *
 * 用法（在 packages/core 下）：
 *   npm run check:c3          （= node scripts/c3-approval-check.mjs）
 *   ARK_API_KEY 经 `pi/_poc/.env.local` 注入子进程，**绝不写进任何文件**。
 *
 * 写作纪律（`.plan/engineering-pitfalls.md` §二）：长跑要后台/硬超时；断言键不用数字开头；
 * 证据必须落盘；「期望值从 fixture 现读」，不写死模型行为（模型可能多次重试 bash）。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, "..");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
const mainPath = path.join(coreDir, "src", "main.ts");
const envLocal = path.resolve(coreDir, "..", "..", "pi", "_poc", ".env.local");
const modelsPath = path.resolve(coreDir, "..", "..", "pi", "_poc", "models.json");
const fixtureDir = path.join(coreDir, "test", "fixtures", "agentdir-ext");
const fixtureExtSrc = path.join(fixtureDir, "extensions", "approval-gate.ts");
const runDir = path.join(coreDir, "run");
const evidencePath = path.join(runDir, "c3-evidence.json");
fs.mkdirSync(runDir, { recursive: true });

/** 一次 prompt 的硬超时（模型被连续拒绝时会换写法重试，必须封顶，否则脚本挂死） */
const PROMPT_HARD_MS = Number(process.env.C3_HARD_MS ?? 240_000);
/** 单次请求超时 */
const HTTP_TIMEOUT_MS = 15_000;
const TOKEN = process.env.C3_TOKEN ?? "c3-token";
const PROMPT = process.env.C3_PROMPT ?? "请务必调用 bash 工具列出当前目录下的文件，只输出前 3 个文件名，不要解释。";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c3-approval-"));

const checks = [];
const check = (name, pass, detail) => {
	checks.push({ name, pass: !!pass, detail });
	console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

/* ---------------------------------------------------------------------------
 * HTTP / SSE 小工具
 * ------------------------------------------------------------------------- */

function request(port, method, p, body, timeoutMs = HTTP_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		const headers = { Authorization: `Bearer ${TOKEN}` };
		let payload;
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			payload = JSON.stringify(body);
		}
		const req = http.request(
			{ host: "127.0.0.1", port, path: p, method, headers, timeout: timeoutMs },
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

async function waitForHealth(port, ok, timeoutMs = 40_000) {
	const t0 = Date.now();
	for (;;) {
		try {
			const r = await request(port, "GET", "/health");
			if (r.status === 200 && r.json && ok(r.json)) return r.json;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() - t0 > timeoutMs) return null;
		await sleep(300);
	}
}

/** 连上 SSE（fetch + ReadableStream）；每帧回调，返回 { frames, close } */
async function openSse(port, onFrame) {
	const frames = [];
	const ctrl = new AbortController();
	const task = (async () => {
		const res = await fetch(`http://127.0.0.1:${port}/events`, {
			headers: { Authorization: `Bearer ${TOKEN}` },
			signal: ctrl.signal,
		});
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
				frames.push(ev);
				if (onFrame) await onFrame(ev, frames);
			}
		}
	})().catch((e) => {
		if (!ctrl.signal.aborted) console.error("[c3] SSE 异常:", e.message);
	});
	return {
		frames,
		close: async () => {
			ctrl.abort();
			await task.catch(() => {});
		},
	};
}

/* ---------------------------------------------------------------------------
 * 起一个 core 实例
 * ------------------------------------------------------------------------- */

function launchCore({ name, cwd, agentDir, port, trustTimeoutMs }) {
	const logPath = path.join(runDir, `c3-core-${name}.log`);
	const logFd = fs.openSync(logPath, "w");
	const child = spawn(process.execPath, ["--env-file=" + envLocal, tsxPath, mainPath], {
		cwd,
		env: {
			...process.env,
			CORE_TOKEN: TOKEN,
			CORE_PORT: String(port),
			CORE_MODELS_PATH: modelsPath,
			CORE_AGENT_DIR: agentDir,
			...(trustTimeoutMs ? { CORE_TRUST_TIMEOUT_MS: String(trustTimeoutMs) } : {}),
		},
		stdio: ["ignore", "ignore", logFd],
	});
	return {
		child,
		logPath,
		async close() {
			child.kill("SIGTERM");
			await Promise.race([
				new Promise((r) => child.once("exit", r)),
				sleep(4000).then(() => child.kill("SIGKILL")),
			]);
			fs.closeSync(logFd);
		},
	};
}

/** 造一个临时 agentDir：settings.json（指定 defaultProjectTrust）+ 可选全局扩展 */
function makeAgentDir(name, { defaultProjectTrust, globalExtension = false }) {
	const dir = path.join(tmpRoot, `${name}-agentdir`);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultProjectTrust }, null, 2));
	if (globalExtension) {
		const extDir = path.join(dir, "extensions");
		fs.mkdirSync(extDir, { recursive: true });
		fs.copyFileSync(fixtureExtSrc, path.join(extDir, "approval-gate.ts"));
	}
	return dir;
}

/** 造一个临时 cwd：`.pi/extensions/approval-gate.ts`（= 项目本地扩展，受信任门管辖） */
function makeProjectCwd(name) {
	const cwd = path.join(tmpRoot, `${name}-cwd`);
	fs.mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
	fs.copyFileSync(fixtureExtSrc, path.join(cwd, ".pi", "extensions", "approval-gate.ts"));
	return cwd;
}

/* ---------------------------------------------------------------------------
 * 判据① + ②：真实授权往返 + 幂等
 * ------------------------------------------------------------------------- */

const evidence = {
	startedAt: new Date().toISOString(),
	model: process.env.PI_MODEL ?? "deepseek-v4-flash",
	prompt: PROMPT,
	judgments: {},
};

async function caseApprovalRoundTrip() {
	const PORT = 5197;
	// agentDir 用夹具（全局扩展）→ 授权不问信任门；cwd 用 coreDir（无项目本地资源，不触发信任门）
	const agentDir = makeAgentDir("roundtrip", { defaultProjectTrust: "ask", globalExtension: true });
	const core = launchCore({ name: "roundtrip", cwd: coreDir, agentDir, port: PORT });
	const result = { pass: false };
	try {
		const health0 = await waitForHealth(PORT, (h) => h.extensions !== null);
		check("①core 启动就绪（/health.extensions 非空）", !!health0, health0);
		check(
			"①无项目本地资源时不触发信任门（reason=no-project-resources，且不问 UI）",
			health0 && health0.trust && health0.trust.reason === "no-project-resources" && health0.trust.asked === false,
			health0 && health0.trust,
		);

		/** 每一笔授权都要应答 —— 不应答会永久挂死（spike 实踩） */
		let answerCount = 0;
		const idempotency = { secondApprove: null, unknownApprove: null, unknownCancel: null, liveCancel: null };
		const approvalEvents = [];
		const settledEvents = [];
		const answered = new Map(); // requestId → 应答方式

		const sse = await openSse(PORT, async (ev) => {
			if (ev.type === "approval_request") approvalEvents.push(ev);
			if (ev.type === "approval_settled") settledEvents.push(ev);
			if (ev.type !== "approval_request") return;
			answerCount += 1;
			const n = answerCount;
			await sleep(200);
			if (n === 1) {
				// 判据①：拒绝；并顺手把幂等三条打完（同一 run 内取证）
				const first = await request(PORT, "POST", "/approve", { requestId: ev.requestId, choice: "拒绝" });
				answered.set(ev.requestId, { how: "approve:拒绝", response: first.json });
				const second = await request(PORT, "POST", "/approve", { requestId: ev.requestId, choice: "拒绝" });
				idempotency.secondApprove = second.json;
				const unknown = await request(PORT, "POST", "/approve", { requestId: "c3-unknown-id", choice: "拒绝" });
				idempotency.unknownApprove = unknown.json;
				const unknownCancel = await request(PORT, "POST", "/cancel-approval", { requestId: "c3-unknown-id-2" });
				idempotency.unknownCancel = unknownCancel.json;
			} else if (n === 2) {
				// 判据②：对「活跃未决请求」走取消 → 必须被受理并下发 settled(cancelled)
				const cancel = await request(PORT, "POST", "/cancel-approval", { requestId: ev.requestId });
				answered.set(ev.requestId, { how: "cancel", response: cancel.json });
				idempotency.liveCancel = cancel.json;
			} else {
				const again = await request(PORT, "POST", "/approve", { requestId: ev.requestId, choice: "拒绝" });
				answered.set(ev.requestId, { how: "approve:拒绝", response: again.json });
			}
		});

		const t0 = Date.now();
		/*
		 * ★ `/prompt` 是**长请求**：core 要等整个 agent run 结束才回响应（不是 202）。
		 * 首次实跑用了默认 15s 超时 → 模型稍慢就 ClientRequest timeout（脚本缺陷，非产品缺陷）。
		 * 这里给它与硬超时同量级的预算。
		 */
		const promptRes = await request(PORT, "POST", "/prompt", { text: PROMPT }, PROMPT_HARD_MS + 20_000);
		// 等 agent_settled（终态）或硬超时
		while (Date.now() - t0 < PROMPT_HARD_MS) {
			if (sse.frames.some((f) => f.type === "agent_settled")) break;
			await sleep(400);
		}
		await sleep(1200);

		const types = sse.frames.map((f) => f.type);
		const firstApproval = approvalEvents[0] ?? null;
		const firstSettled = firstApproval
			? settledEvents.find((s) => s.requestId === firstApproval.requestId)
			: null;
		const idx = (pred) => types.findIndex(pred);
		const iApproval = types.indexOf("approval_request");
		const iSettled = firstApproval
			? sse.frames.findIndex((f) => f.type === "approval_settled" && f.requestId === firstApproval.requestId)
			: -1;
		const iToolStart = idx((t) => t === "tool_execution_start");
		const iToolEnd = idx((t) => t === "tool_execution_end");
		const iSettledEnd = idx((t) => t === "agent_settled");
		const toolEnds = sse.frames.filter((f) => f.type === "tool_execution_end");

		Object.assign(result, {
			port: PORT,
			promptHttpStatus: promptRes.status,
			elapsedMs: Date.now() - t0,
			授权请求数: approvalEvents.length,
			已应答数: answered.size,
			首个请求: firstApproval,
			首个结算: firstSettled,
			事件序列: types,
			tool_execution_start: types.filter((t) => t === "tool_execution_start").length,
			tool_execution_end: toolEnds.length,
			isError的工具结果数: toolEnds.filter((f) => f.isError === true).length,
			幂等: idempotency,
			无消息更新: types.filter((t) => t === "message_update").length,
		});

		check("①SSE 收到 approval_request（method=select，选项含「拒绝」）", !!firstApproval && firstApproval.method === "select" && Array.isArray(firstApproval.options) && firstApproval.options.includes("拒绝"), firstApproval);
		check("①应答「拒绝」被受理（accepted:true）", answered.get(firstApproval?.requestId)?.response?.accepted === true, answered.get(firstApproval?.requestId)?.response);
		check("①收到 approval_settled{resolution:accepted}（core 造的事件，Pi 不回显）", firstSettled?.resolution === "accepted", firstSettled);
		check("①被拒后仍走完整工具事件（tool_execution_start 与 end 都在）", iToolStart >= 0 && toolEnds.length >= 1, { toolStart: iToolStart, toolEnd: iToolEnd });
		check("①被拒的工具调用 isError=true（状态由适配层映射为 error）", toolEnds.some((f) => f.isError === true), result.isError的工具结果数);
		/*
		 * ★ 实测修正（本轮取证）：Pi 的顺序是
		 *   tool_execution_start → approval_request → approval_settled → tool_execution_end
		 * —— **`tool_execution_start` 先于授权提问**（`tool_call` hook 是在执行包装内部被调用的），
		 * 所以断言不能写成「start 在 settled 之后」。判定口径改为：
		 * 提问 → 结算 → 工具结束（被拒结果）→ 会话终态，且 start/end 都出现过。
		 */
		check(
			"①事件顺序：approval_request → approval_settled → tool_execution_end → agent_settled（tool_execution_start 早于提问，见证据）",
			iApproval >= 0 && iSettled > iApproval && iToolEnd > iSettled && iSettledEnd > iToolEnd && iToolStart >= 0,
			{ iToolStart, iApproval, iSettled, iToolEnd, iSettledEnd },
		);
		check("①不挂死：收到 agent_settled 终态", iSettledEnd >= 0, { elapsedMs: result.elapsedMs });

		check("②幂等：同一 requestId 二次 POST /approve → accepted:false（不报错）", idempotency.secondApprove?.ok === true && idempotency.secondApprove?.accepted === false, idempotency.secondApprove);
		check("②未知 requestId → accepted:false（静默忽略）", idempotency.unknownApprove?.ok === true && idempotency.unknownApprove?.accepted === false, idempotency.unknownApprove);
		check("②未知 requestId 的 /cancel-approval → accepted:false（静默忽略）", idempotency.unknownCancel?.ok === true && idempotency.unknownCancel?.accepted === false, idempotency.unknownCancel);
		const liveCancelSettled = settledEvents.filter((s) => s.resolution === "cancelled");
		check(
			"②活跃未决请求的 /cancel-approval → accepted:true 且下发 settled(cancelled)",
			idempotency.liveCancel === null || (idempotency.liveCancel?.accepted === true && liveCancelSettled.length >= 1),
			{ liveCancel: idempotency.liveCancel, cancelled结算数: liveCancelSettled.length },
		);

		result.pass =
			!!firstApproval &&
			firstSettled?.resolution === "accepted" &&
			toolEnds.length >= 1 &&
			iSettledEnd > iToolEnd &&
			idempotency.secondApprove?.accepted === false &&
			idempotency.unknownApprove?.accepted === false &&
			idempotency.unknownCancel?.accepted === false;

		await sse.close();
	} catch (e) {
		result.error = String(e && e.stack ? e.stack : e);
		check("①真实授权往返执行无异常", false, result.error);
	} finally {
		await core.close();
	}
	return result;
}

/* ---------------------------------------------------------------------------
 * 判据③：信任门三态（never / always / ask）
 * ------------------------------------------------------------------------- */

const TRUST_DECLINE = "不信任（本次不加载）";
const TRUST_ACCEPT = "信任并加载项目本地扩展";
/** 哨兵：该用例不选选项，而是对「活跃未决请求」走 POST /cancel-approval（判据②的实弹取证） */
const TRUST_CANCEL = "__cancel__";

async function caseTrust({ name, port, defaultProjectTrust, answer, trustTimeoutMs, expectLoaded }) {
	const cwd = makeProjectCwd(name);
	const agentDir = makeAgentDir(name, { defaultProjectTrust, globalExtension: false });
	const core = launchCore({ name, cwd, agentDir, port, trustTimeoutMs });
	const out = { name, defaultProjectTrust, answer: answer ?? "(不应答，等超时)", cwd };
	try {
		// ★ 先等服务 listen 再连 SSE：/health 在会话就绪前就可用（会话在等信任门裁决）。
		//   顺序不能反 —— 连早了 ECONNREFUSED 会让 ask 态提问无人应答，直接落到超时。
		const alive = await waitForHealth(port, () => true, 30_000);
		const questions = [];
		const settled = [];
		let sse = null;
		// 无论是否应答都连 SSE：既取证据，也覆盖「提问早于连接」的补发路径
		sse = await openSse(port, async (ev) => {
			if (ev.type === "approval_request") {
				questions.push(ev);
				if (answer) {
					await sleep(150);
					const r =
						answer === TRUST_CANCEL
							? await request(port, "POST", "/cancel-approval", { requestId: ev.requestId })
							: await request(port, "POST", "/approve", { requestId: ev.requestId, choice: answer });
					settled.push({ 应答: answer, response: r.json, requestId: ev.requestId });
				}
			}
			if (ev.type === "approval_settled") settled.push({ 帧: ev });
		});

		const health = await waitForHealth(port, (h) => h.extensions !== null, trustTimeoutMs ? trustTimeoutMs + 40_000 : 40_000);
		await sleep(300);
		await sse.close();
		Object.assign(out, {
			health,
			trust: health?.trust ?? null,
			extensions: health?.extensions ?? null,
			serverAlive: !!alive,
			提问数: questions.length,
			提问标题: questions[0]?.title,
			提问选项: questions[0]?.options,
			提问timeoutMs: questions[0]?.timeoutMs,
			结算帧: settled.map((s) => s.帧 ?? s),
			应答响应: settled.filter((s) => s.response).map((s) => s.response),
			coreLog: path.relative(coreDir, core.logPath),
		});
	} catch (e) {
		out.error = String(e);
	} finally {
		await core.close();
	}

	// 判据口径（逐例声明，别用 defaultProjectTrust 反推 —— ask 的两种答案结论相反）
	check(
		`③信任门 [${name}]：加载扩展数 = ${out.extensions}（期望 ${expectLoaded === "positive" ? ">0" : "0"}）`,
		expectLoaded === "positive" ? out.extensions > 0 : out.extensions === 0,
		out.extensions,
	);
	check(
		`③信任门 [${name}]：trusted=${out.trust?.trusted} reason=${out.trust?.reason}`,
		!!out.trust,
		out.trust,
	);
	if (defaultProjectTrust === "ask") {
		check(
			`③信任门 [${name}]：出现信任提问且标题明示「将加载并执行项目本地扩展」`,
			out.提问数 >= 1 && String(out.提问标题 ?? "").includes("将加载并执行项目本地扩展"),
			{ 提问数: out.提问数, 标题: out.提问标题 },
		);
	} else {
		check(`③信任门 [${name}]：不打扰用户（提问数 0）`, out.提问数 === 0, out.提问数);
	}
	return out;
}

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */

let exitCode = 1;
try {
	console.log(`[c3] 临时目录 ${tmpRoot}`);
	console.log("[c3] 判据① 真实授权往返 + 判据② 幂等（真实模型，可能需要 1~3 分钟）…");
	evidence.judgments["①真实授权往返+②幂等"] = await caseApprovalRoundTrip();

	console.log("[c3] 判据③ 信任门三态（不需模型，逐个起 core）…");
	const trustCases = [
		{ name: "never", port: 5198, defaultProjectTrust: "never", expectLoaded: "zero" },
		{ name: "always", port: 5199, defaultProjectTrust: "always", expectLoaded: "positive" },
		{ name: "ask-decline", port: 5200, defaultProjectTrust: "ask", answer: TRUST_DECLINE, expectLoaded: "zero" },
		{ name: "ask-accept", port: 5201, defaultProjectTrust: "ask", answer: TRUST_ACCEPT, expectLoaded: "positive" },
		{ name: "ask-timeout", port: 5202, defaultProjectTrust: "ask", trustTimeoutMs: 5000, expectLoaded: "zero" },
		{ name: "ask-cancel", port: 5203, defaultProjectTrust: "ask", answer: TRUST_CANCEL, expectLoaded: "zero" },
	];
	evidence.judgments["③信任门"] = [];
	for (const c of trustCases) evidence.judgments["③信任门"].push(await caseTrust(c));

	// 判据③的补充断言（跨用例）
	const byName = Object.fromEntries(evidence.judgments["③信任门"].map((t) => [t.name, t]));
	check("③会话：never=0 / always>0 / ask+拒绝=0 / ask+信任>0 / ask+超时=0（安全默认）", byName.never?.extensions === 0 && byName.always?.extensions > 0 && byName["ask-decline"]?.extensions === 0 && byName["ask-accept"]?.extensions > 0 && byName["ask-timeout"]?.extensions === 0, {
		never: byName.never?.extensions,
		always: byName.always?.extensions,
		ask_decline: byName["ask-decline"]?.extensions,
		ask_accept: byName["ask-accept"]?.extensions,
		ask_timeout: byName["ask-timeout"]?.extensions,
	});
	check(
		"③活跃未决请求的 /cancel-approval 实弹取证：accepted:true + settled(cancelled) + 不加载",
		byName["ask-cancel"]?.应答响应?.[0]?.accepted === true &&
			(byName["ask-cancel"]?.结算帧 ?? []).some((f) => f?.resolution === "cancelled") &&
			byName["ask-cancel"]?.extensions === 0,
		{ 应答: byName["ask-cancel"]?.应答响应, 结算帧: byName["ask-cancel"]?.结算帧, extensions: byName["ask-cancel"]?.extensions },
	);
	check("③超时按不信任收尾并下发 settled(cancelled)", byName["ask-timeout"]?.trust?.reason === "cancelled" && (byName["ask-timeout"]?.结算帧 ?? []).some((f) => f?.resolution === "cancelled"), byName["ask-timeout"]?.结算帧);
	check("③ask+拒绝：结论 reason=user-declined", byName["ask-decline"]?.trust?.reason === "user-declined", byName["ask-decline"]?.trust);
	check("③ask+信任：结论 reason=user-accepted", byName["ask-accept"]?.trust?.reason === "user-accepted", byName["ask-accept"]?.trust);

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
	console.error("[c3] 脚本异常:", e && e.stack ? e.stack : e);
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
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		/* 忽略 */
	}
}

console.log(
	exitCode === 0
		? "\nC3 授权闭环 + 信任门 检查全部通过"
		: `\nC3 检查失败 ${checks.filter((c) => !c.pass).length} 项：\n - ${checks.filter((c) => !c.pass).map((c) => c.name).join("\n - ")}`,
);
process.exit(exitCode);
