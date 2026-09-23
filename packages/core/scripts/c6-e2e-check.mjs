/**
 * C6 · 全链路端到端终验 —— **M6 的总验收**（node 直跑，不引框架；一层脚本串起全部能力）。
 *
 * 覆盖 task-M6-C6.md §二 的七步：
 *   ① 起 core（真实模型 + `test/fixtures/agentdir-ext` 夹具的 approval-gate 扩展）；
 *   ② 经 SSE+HTTP 走一轮**完整真实会话**：prompt（要求用 bash 执行 `echo c6-e2e-ok`）→
 *      授权 `approval_request` → 应答「允许」→ `tool_execution_start/end`（成功）→ `agent_settled`；
 *   ③ 会话落盘：`GET /sessions` 包含本轮（messageCount ≥2）；
 *   ④ `POST /sessions/load` 该会话 → 消息 ≥2 且含本轮 toolCall 的 terminal 块内容；
 *   ⑤ §1.2 `POST /sessions/continue-recent` **重建活动会话**：往会话目录写一份 mtime 更新的
 *      合成会话（≠ 当前活动会话）→ continue-recent 必须选中它（重建发生）→ 续写一条 prompt
 *      → **同一 session 文件** messageCount 增长（判据：续写落同一文件）；
 *   ⑥ §1.1 `GET /tools/active` 与 `POST /tools/active` 往返：关闭 bash → 发一条需 bash 的
 *      prompt → **不出现 bash 工具调用**（被关工具的行为符合预期）→ 恢复四个内置工具；
 *   ⑦ `GET /resources` 三类 ≥1、`GET /models` ≥1；安全三件套负向用例（401/403/400）；
 *   ⑧ UI 层复用既有探针（不重写）：`probe:c4` / `probe:c5` / `live:smoke` 各跑一遍。
 *
 * 运行前置：`packages/ui` 下已有 `dist`（⑧ 的探针经 core 同源托管 ui/dist）。
 * 用法（在 packages/core 下）：`npm run check:c6`
 * 证据：`run/c6-evidence.json`；失败非 0 退出。
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, "..");
const uiDir = path.join(coreDir, "..", "ui");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
const mainPath = path.join(coreDir, "src", "main.ts");
const envLocal = path.resolve(coreDir, "..", "..", "pi", "_poc", ".env.local");
const modelsPath = path.resolve(coreDir, "..", "..", "pi", "_poc", "models.json");
const fixtureExtSrc = path.join(coreDir, "test", "fixtures", "agentdir-ext", "extensions", "approval-gate.ts");
const fixtureResources = path.join(coreDir, "test", "fixtures", "resources");
const runDir = path.join(coreDir, "run");
const evidencePath = path.join(runDir, "c6-evidence.json");
fs.mkdirSync(runDir, { recursive: true });

const PORT = Number(process.env.C6_PORT ?? 5210);
const TOKEN = process.env.C6_TOKEN ?? "c6-token";
const HARD_MS = Number(process.env.C6_HARD_MS ?? 240_000);
const HTTP_TIMEOUT_MS = 15_000;
const BUILTINS = ["read", "bash", "edit", "write"];

const PROMPT_BASH = "这是 C6 端到端探针：请用 bash 工具执行命令 echo c6-e2e-ok，并把输出原样告诉我。";
const MARKER_BASH = "c6-e2e-ok";
const PROMPT_SECOND = "这是 C6 续接探针：只回复两个字「好的」，不要调用任何工具。";
const MARKER_SECOND = "C6 续接探针";
const PROMPT_TOOLS_GATED = "请用 bash 工具执行命令 echo tools-gated-check，并把输出告诉我。";
const SYNTH_ID = "c6-continue-target";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c6-e2e-"));
const startedAt = new Date().toISOString();

const checks = [];
const check = (name, pass, detail) => {
	checks.push({ name, pass: !!pass, detail });
	console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

/* ---------------------------------------------------------------------------
 * HTTP / SSE 小工具（与 c3/c4/c5 同款）
 * ------------------------------------------------------------------------- */

function request(port, method, p, body, { token = TOKEN, host, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
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

async function waitForHealth(port, ok, timeoutMs = 60_000) {
	const t0 = Date.now();
	for (;;) {
		try {
			const r = await request(port, "GET", "/health", undefined, { timeoutMs: 3000 });
			if (r.status === 200 && r.json && ok(r.json)) return r.json;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() - t0 > timeoutMs) return null;
		await sleep(300);
	}
}

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
		if (!ctrl.signal.aborted) console.error("[c6] SSE 异常:", e.message);
	});
	return {
		frames,
		close: async () => {
			ctrl.abort();
			await task.catch(() => {});
		},
	};
}

/** 长请求跑一轮会话并等 agent_settled（/prompt 是长请求：core 等整个 run 结束才响应） */
async function runRound(port, sse, text, hardMs = HARD_MS) {
	const t0 = Date.now();
	const settledBefore = sse.frames.filter((f) => f.type === "agent_settled").length;
	const promptRes = await request(port, "POST", "/prompt", { text }, hardMs + 20_000);
	while (Date.now() - t0 < hardMs) {
		const settled = sse.frames.filter((f) => f.type === "agent_settled").length;
		if (settled > settledBefore) break;
		await sleep(400);
	}
	await sleep(1200); // 等落盘
	return promptRes;
}

/** 把 Message[] 拍平成文本数组（text / terminal 输出） */
function textsOf(messages) {
	const out = [];
	for (const m of messages ?? []) {
		for (const b of m.blocks ?? []) {
			if (b.type === "text") out.push(b.content);
			else if (b.type === "terminal") out.push(`[terminal ${b.toolCallId}] ${b.command} => ${b.output}`);
		}
	}
	return out;
}

/* ---------------------------------------------------------------------------
 * 夹具装配：临时 agentDir（approval-gate + 三类资源）+ 临时 cwd（无项目本地资源）
 * ------------------------------------------------------------------------- */

const agentDir = path.join(tmpRoot, "agentdir");
const projectCwd = path.join(tmpRoot, "project");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(projectCwd, { recursive: true });

/**
 * Windows 下给 Pi 找一个可用的 bash（S6 §九·1：shellPath 写进 <agentDir>/settings.json 实测生效）。
 * 本脚本的 ②④ 两步依赖 bash 真实执行 `echo c6-e2e-ok`，找不到 bash 时如实记进证据并让相关断言失败。
 */
function detectShellPath() {
	if (process.env.C6_SHELL_PATH) return process.env.C6_SHELL_PATH;
	if (process.platform !== "win32") return undefined;
	const candidates = [
		"C:\\Program Files\\Git\\bin\\bash.exe",
		"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
	];
	const portableRoot = path.join(os.homedir(), ".workbuddy", "binaries", "PortableGit", "versions");
	try {
		for (const v of fs.readdirSync(portableRoot)) candidates.push(path.join(portableRoot, v, "bin", "bash.exe"));
	} catch {
		/* 无 PortableGit */
	}
	return candidates.find((p) => {
		try {
			return fs.statSync(p).isFile();
		} catch {
			return false;
		}
	});
}
const shellPath = detectShellPath();

// never：不触发信任门（信任门三态 C3 已覆盖；本脚本只验端到端链路）
const fixtureSettings = { defaultProjectTrust: "never" };
if (shellPath) fixtureSettings.shellPath = shellPath;
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(fixtureSettings, null, 2));
// 授权夹具（全局扩展）+ 04 屏三类资源的 user-scope 夹具（扩展/提示词/技能各 ≥1）
fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
fs.copyFileSync(fixtureExtSrc, path.join(agentDir, "extensions", "approval-gate.ts"));
fs.copyFileSync(path.join(fixtureResources, "extensions", "demo-extension.ts"), path.join(agentDir, "extensions", "demo-extension.ts"));
fs.mkdirSync(path.join(agentDir, "prompts"), { recursive: true });
fs.copyFileSync(path.join(fixtureResources, "prompts", "demo-prompt.md"), path.join(agentDir, "prompts", "demo-prompt.md"));
fs.cpSync(path.join(fixtureResources, "skills", "demo-skill"), path.join(agentDir, "skills", "demo-skill"), { recursive: true });

const logFd = fs.openSync(path.join(runDir, "c6-core.log"), "w");
const child = spawn(process.execPath, ["--env-file=" + envLocal, tsxPath, mainPath], {
	cwd: projectCwd,
	env: {
		...process.env,
		CORE_TOKEN: TOKEN,
		CORE_PORT: String(PORT),
		CORE_MODELS_PATH: modelsPath,
		CORE_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "ignore", logFd],
});

let uiProbeResults = null;

try {
	console.log(`[c6] 临时目录 ${tmpRoot}`);
	const health = await waitForHealth(PORT, (h) => h.extensions !== null);
	check("①core 启动就绪（/health.extensions 非空）", !!health, health);
	check("①夹具扩展已加载（扩展数 ≥2：approval-gate + demo-extension）", (health?.extensions ?? 0) >= 2, health?.extensions);

	/* ================================================================ ② 完整真实会话（授权闭环） */
	console.log("[c6] ②跑完整真实会话：bash → 授权「允许」→ 工具成功 → settled …");
	const approvals = [];
	const sse = await openSse(PORT, async (ev) => {
		if (ev.type !== "approval_request") return;
		approvals.push(ev);
		// 每一笔授权都要应答 —— 不应答会永久挂死（spike 实踩）
		await sleep(200);
		await request(PORT, "POST", "/approve", { requestId: ev.requestId, choice: "允许" });
	});

	await runRound(PORT, sse, PROMPT_BASH);
	const frames = sse.frames;
	const types = frames.map((f) => f.type);
	const bashStarts = frames.filter((f) => f.type === "tool_execution_start" && f.toolName === "bash");
	const bashStart = bashStarts[0];
	// ⚠️ 契约：tool_execution_end **没有 toolName 字段**（只有 start 带）—— 按 toolCallId 关联
	const bashIds = new Set(bashStarts.map((f) => f.toolCallId));
	const bashEnds = frames.filter((f) => f.type === "tool_execution_end" && bashIds.has(f.toolCallId));
	const bashSuccess = bashEnds.find(
		(f) => f.isError === false && `${f.output ?? ""}${JSON.stringify(f.result ?? {})}`.includes(MARKER_BASH),
	);
	const settledIdx = types.lastIndexOf("agent_settled");
	const startIdx = types.indexOf("tool_execution_start");

	check("②SSE 收到 approval_request（应答「允许」）", approvals.length >= 1, approvals.length);
	check("②tool_execution_start(bash) 出现", !!bashStart, types);
	check(
		"②tool_execution_end(bash) 成功且输出含 c6-e2e-ok",
		!!bashSuccess,
		bashEnds.map((f) => ({ isError: f.isError, result: f.result })),
	);
	check("②agent_settled 出现（终态）", settledIdx >= 0, types);
	check("②事件顺序：tool_execution_start 早于 agent_settled", startIdx >= 0 && settledIdx > startIdx, { startIdx, settledIdx });
	// C3 定稿实序：tool_execution_start → approval_request → approval_settled → tool_execution_end
	//（tool_call hook 在执行包装内被调用，不是「先提问再 start」）
	const approvalIdx = frames.findIndex((f) => f.type === "approval_request");
	check("②事件顺序：approval_request 发生在 start 之后、settled 之前（C3 定稿实序）", startIdx >= 0 && approvalIdx > startIdx && approvalIdx < settledIdx, { startIdx, approvalIdx, settledIdx });
	check("②bash shell 已找到（shellPath）", !!shellPath, shellPath ?? "未找到");

	/* ================================================================ ③ 会话落盘 */
	console.log("[c6] ③会话落盘与加载…");
	const listRes = await request(PORT, "GET", "/sessions");
	const sessions = listRes.json?.sessions ?? [];
	check("③GET /sessions ≥1 条", listRes.status === 200 && sessions.length >= 1, { status: listRes.status, count: sessions.length });

	// 找真实会话文件（排除后面才写的合成会话；此时只有真实会话）
	const sessionsRoot = path.join(agentDir, "sessions");
	const jsonlFiles = [];
	for (const dir of fs.readdirSync(sessionsRoot)) {
		const full = path.join(sessionsRoot, dir);
		if (!fs.statSync(full).isDirectory()) continue;
		for (const f of fs.readdirSync(full)) if (f.endsWith(".jsonl")) jsonlFiles.push(path.join(full, f));
	}
	check("③真实会话文件已落盘", jsonlFiles.length >= 1, jsonlFiles);
	const realSessionFile = jsonlFiles[0];
	const realHeader = JSON.parse(fs.readFileSync(realSessionFile, "utf8").split("\n")[0]);
	/** 会话目录（§1.2 的合成会话要写进这里） */
	const sessionDir = path.dirname(realSessionFile);

	/* ================================================================ ④ 加载 */
	const target = sessions.find((s) => s.messageCount >= 2) ?? sessions[0];
	const loadRes = await request(PORT, "POST", "/sessions/load", { id: target?.id });
	const loadMessages = loadRes.json?.messages ?? [];
	const loadTexts = textsOf(loadMessages);
	const terminalHit = (loadRes.json?.messages ?? [])
		.flatMap((m) => m.blocks ?? [])
		.find((b) => b.type === "terminal" && typeof b.output === "string" && b.output.includes(MARKER_BASH));
	check("④POST /sessions/load 返回 200 且消息 ≥2", loadRes.status === 200 && loadMessages.length >= 2, { status: loadRes.status, count: loadMessages.length });
	check("④能读回本轮 prompt 原文", loadTexts.some((t) => t.includes("C6 端到端探针")), loadTexts.map((t) => t.slice(0, 40)));
	check("④含本轮 toolCall 的 terminal 块且输出含 c6-e2e-ok", !!terminalHit, terminalHit ?? loadTexts);

	/* ================================================================ ⑤ §1.2 continue-recent 重建活动会话 */
	console.log("[c6] ⑤continue-recent 重建活动会话（写一份 mtime 更新的合成会话，逼出真实切换）…");
	// 合成会话：header 的 cwd 用真实会话 header 的原字符串（避免路径写法差异被 list() 的 cwd 过滤剔除）
	const tsBase = Date.now() - 10 * 60_000;
	const tsAt = (i) => new Date(tsBase + i * 60_000).toISOString();
	const synthEntries = [
		{ type: "session", version: 3, id: SYNTH_ID, timestamp: tsAt(0), cwd: realHeader.cwd },
		{ id: "s1", parentId: null, timestamp: tsAt(1), type: "message", message: { role: "user", content: [{ type: "text", text: "续接前的历史问题" }] } },
		{ id: "s2", parentId: "s1", timestamp: tsAt(2), type: "message", message: { role: "assistant", content: [{ type: "text", text: "续接前的历史回答" }] } },
	];
	const synthPath = path.join(sessionDir, `2026-09-23T23-59-00-000Z_${SYNTH_ID}.jsonl`);
	fs.writeFileSync(synthPath, synthEntries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	// findMostRecentSession 按 mtime 选取（session-manager.js 实查）→ 立即写盘即为最新
	const beforeCount = 2;

	const contRes = await request(PORT, "POST", "/sessions/continue-recent");
	const contJson = contRes.json ?? {};
	check("⑤continue-recent 选中的是**最近**会话（即合成会话，≠ 此前的活动会话）", contRes.status === 200 && contJson.id === SYNTH_ID, { status: contRes.status, id: contJson.id, messages: (contJson.messages ?? []).length });
	check("⑤返回内容含合成会话的历史消息", textsOf(contJson.messages).some((t) => t.includes("续接前的历史问题")), textsOf(contJson.messages).map((t) => t.slice(0, 30)));

	await runRound(PORT, sse, PROMPT_SECOND);
	// 判据：续写落在**同一 session 文件** —— 该文件 messageCount 增长 + 文件里真的有续写原文
	const listRes2 = await request(PORT, "GET", "/sessions");
	const sessions2 = listRes2.json?.sessions ?? [];
	const synthInfo = sessions2.find((s) => s.id === SYNTH_ID);
	check("⑤续写后合成会话的 messageCount 增长（2 → ≥3）", !!synthInfo && synthInfo.messageCount > beforeCount, { found: !!synthInfo, messageCount: synthInfo?.messageCount });
	const synthRaw = fs.readFileSync(synthPath, "utf8");
	check("⑤续写原文确实落在同一文件（文件内容含续探针标记）", synthRaw.includes(MARKER_SECOND), synthPath);
	const loadSynth2 = await request(PORT, "POST", "/sessions/load", { id: SYNTH_ID });
	check("⑤load 回读：同一会话既有历史又有续写", textsOf(loadSynth2.json?.messages).some((t) => t.includes("续接前的历史问题")) && textsOf(loadSynth2.json?.messages).some((t) => t.includes(MARKER_SECOND)), textsOf(loadSynth2.json?.messages).map((t) => t.slice(0, 30)));

	/* ================================================================ ⑥ §1.1 工具开关往返 */
	console.log("[c6] ⑥tools/active 往返：关 bash → 需 bash 的 prompt → 不出现 bash 调用 → 恢复 …");
	const toolsBefore = await request(PORT, "GET", "/tools/active");
	check("⑥GET /tools/active 返回 200 且含四个内置工具", toolsBefore.status === 200 && BUILTINS.every((n) => (toolsBefore.json?.active ?? []).includes(n)), toolsBefore.json);
	check("⑥available ≥4（可启用全集）", (toolsBefore.json?.available ?? []).length >= 4, toolsBefore.json?.available);

	// 只关 bash（read/edit/write 保留）—— 判据：需 bash 的 prompt 不出现 bash 工具调用
	const disableBash = await request(PORT, "POST", "/tools/active", { names: ["read", "edit", "write"] });
	check("⑥POST /tools/active 关掉 bash 后 active 生效（read/edit/write 在、bash 不在）", disableBash.status === 200 && !(disableBash.json?.active ?? []).includes("bash") && ["read", "edit", "write"].every((n) => (disableBash.json?.active ?? []).includes(n)), disableBash.json);

	const beforeGated = sse.frames.length;
	await runRound(PORT, sse, PROMPT_TOOLS_GATED);
	const gatedFrames = sse.frames.slice(beforeGated);
	const gatedBashCalls = gatedFrames.filter((f) => f.type === "tool_execution_start" && f.toolName === "bash");
	check("⑥关 bash 后发需 bash 的 prompt：不出现 bash 工具调用（拒执行/不出现该工具调用）", gatedBashCalls.length === 0 && gatedFrames.some((f) => f.type === "agent_settled"), gatedFrames.map((f) => f.type));

	const restoreRes = await request(PORT, "POST", "/tools/active", { names: BUILTINS });
	check("⑥恢复四个内置工具 → active 反映", restoreRes.status === 200 && BUILTINS.every((n) => (restoreRes.json?.active ?? []).includes(n)), restoreRes.json);

	const unknownRes = await request(PORT, "POST", "/tools/active", { names: ["no-such-tool"] });
	check("⑥未注册工具名 → 400（core 侧显式校验，不靠上游静默忽略）", unknownRes.status === 400, { status: unknownRes.status });
	const noToken = await request(PORT, "GET", "/tools/active", undefined, { token: "" });
	check("⑥无 token → 401", noToken.status === 401, noToken.status);
	const badHost = await request(PORT, "POST", "/tools/active", { names: [] }, { host: "evil.example:5210" });
	check("⑥错 Host → 403", badHost.status === 403, badHost.status);

	/* ================================================================ ⑦ resources / models */
	const resRes = await request(PORT, "GET", "/resources");
	const resources = resRes.json ?? {};
	check("⑦GET /resources 三类各 ≥1", resRes.status === 200 && (resources.extensions ?? []).length >= 1 && (resources.prompts ?? []).length >= 1 && (resources.skills ?? []).length >= 1, { extensions: (resources.extensions ?? []).length, prompts: (resources.prompts ?? []).length, skills: (resources.skills ?? []).length });
	const modelsRes = await request(PORT, "GET", "/models");
	check("⑦GET /models ≥1 且带当前模型", modelsRes.status === 200 && (modelsRes.json?.models ?? []).length >= 1 && !!modelsRes.json?.current, { count: (modelsRes.json?.models ?? []).length, current: modelsRes.json?.current });

	await sse.close();

	/* ================================================================ ⑧ UI 层（复用既有探针，不重写） */
	console.log("[c6] ⑧UI 层复用 probe:c4 / probe:c5 / live:smoke …");
	const distIndex = path.join(uiDir, "dist", "index.html");
	check("⑧ui/dist 已构建（探针前置）", fs.existsSync(distIndex), distIndex);
	const probes = [
		["probe:c4", "probe-c4-session-load.mjs"],
		["probe:c5", "probe-c5-live-screens.mjs"],
		["live:smoke", "live-smoke.mjs"],
	];
	uiProbeResults = [];
	for (const [name, file] of probes) {
		const t0 = Date.now();
		const r = spawnSync(process.execPath, [path.join(uiDir, "scripts", file)], {
			cwd: uiDir,
			encoding: "utf8",
			timeout: 420_000,
		});
		const tail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").slice(-6).join("\n");
		uiProbeResults.push({ name, file, exitCode: r.status, ms: Date.now() - t0, tail });
		check(`⑧${name} 全绿（EXIT=0）`, r.status === 0, { exitCode: r.status, tail });
	}
} catch (e) {
	check("脚本无异常", false, String((e && e.stack) || e));
} finally {
	child.kill("SIGTERM");
	await Promise.race([
		new Promise((r) => child.once("exit", r)),
		sleep(4000).then(() => child.kill("SIGKILL")),
	]);
	fs.closeSync(logFd);
}

const summary = {
	assertions: checks.length,
	passed: checks.filter((c) => c.pass).length,
	failed: checks.filter((c) => !c.pass).length,
};
console.log(`\n=== 断言汇总：${summary.passed}/${summary.assertions} 通过 ===`);

const evidence = {
	startedAt,
	finishedAt: new Date().toISOString(),
	model: process.env.PI_MODEL ?? "deepseek-v4-flash",
	shellPath: shellPath ?? null,
	prompts: { bash: PROMPT_BASH, second: PROMPT_SECOND, toolsGated: PROMPT_TOOLS_GATED },
	tmpRoot,
	summary,
	uiProbes: uiProbeResults,
	checks,
};
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
console.log(`[c6] 证据已落盘：${evidencePath}`);
process.exit(summary.failed === 0 ? 0 : 1);
