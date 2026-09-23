/**
 * C4 · 会话列表与加载 —— 检查脚本（node 直跑，不引框架）。
 *
 * 覆盖规格书 §2.3 的两个判据 + 两条自加的必要覆盖（**新端点照走安全三件套**）：
 *   ① `GET /sessions`：跑一次真实会话后清单 ≥1 条且四字段完整（`updatedAt` 必须是 epoch ms 数字）；
 *   ② `POST /sessions/load`：真实会话返回的 `Message[]` ≥1 条且消息结构完整；
 *   ③ **合成会话文件的映射覆盖（确定性，不依赖模型行为）**：
 *      手工写一份 `.jsonl` 到临时会话目录，逐条验证
 *      `message`/`toolResult` 合并/`custom_message.display`/`usage`/`model_change`
 *      与 **树结构取主干**（旁支消息不得出现）；
 *   ④ `POST /sessions/continue-recent` 可用；未知 id → 404；
 *   ⑤ 安全三件套对新端点同样生效（无 token → 401、错 Host → 403）。
 *
 * 为什么要有 ③（关键）：判据 ①② 只能证明「接口通了」，而 C4 的真正难点是
 * **`SessionEntry[] → Message[]` 的独立映射**（`survey/S2-sessions.md` §四）。
 * 靠真实模型只能得到 user+assistant 两条，覆盖不到 toolResult 合并、display:false、
 * usage 汇总与分支裁剪 —— 这些正是最容易写错、且错了不会报错的地方。
 *
 * 用法（在 packages/core 下）：`npm run check:c4`
 * 证据：`run/c4-evidence.json`（含清单原文、映射结果、映射统计、断言逐条）。
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
const runDir = path.join(coreDir, "run");
const evidencePath = path.join(runDir, "c4-evidence.json");
fs.mkdirSync(runDir, { recursive: true });

const PORT = Number(process.env.C4_PORT ?? 5204);
const TOKEN = process.env.C4_TOKEN ?? "c4-token";
const PROMPT = process.env.C4_PROMPT ?? "只回复四个字：已收到，不要调用任何工具。";
const PROMPT_HARD_MS = Number(process.env.C4_HARD_MS ?? 240_000);
const HTTP_TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c4-sessions-"));

const checks = [];
const check = (name, pass, detail) => {
	checks.push({ name, pass: !!pass, detail });
	console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

/* ---------------------------------------------------------------------------
 * HTTP 小工具（带 token / 可指定 Host，用于安全负向用例）
 * ------------------------------------------------------------------------- */

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

/* ---------------------------------------------------------------------------
 * 合成会话文件（判据③）—— 覆盖真实模型给不出的 entry 形状
 * ------------------------------------------------------------------------- */

const T0 = Date.UTC(2026, 8, 23, 10, 0, 0);
const ts = (i) => new Date(T0 + i * 60_000).toISOString();

/** 合成会话：主干 e1→e2→e3→e4→e5→e6→e7→e8→e9，旁支 e2b 挂在 e2 下但**不在主干上** */
function synthEntries(cwd) {
	const base = (id, parentId, i) => ({ id, parentId, timestamp: ts(i) });
	return [
		{
			type: "session",
			version: 3,
			id: "c4-synth-session",
			timestamp: ts(0),
			cwd,
		},
		// 1 用户提问
		{ ...base("e1", null, 1), type: "message", message: { role: "user", content: [{ type: "text", text: "第一问" }] } },
		// 2 助手回答 + 一个 toolCall（工具结果随后单独成 entry）
		{
			...base("e2", "e1", 2),
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "回答一" },
					{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "echo hi" } },
				],
			},
		},
		// 2b ★ 旁支：parentId 指向 e2，但主干（leaf=e9）不经过它 —— 不得出现在结果里
		{
			...base("e2b", "e2", 3),
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "旁支回答（不应出现在主干）" }] },
		},
		// 3 工具结果（应合并进 e2 那条 assistant 消息的 terminal 块）
		{
			...base("e3", "e2", 4),
			type: "message",
			message: { role: "toolResult", toolCallId: "tc-1", toolName: "bash", content: [{ type: "text", text: "hi" }] },
		},
		{ ...base("e4", "e3", 5), type: "message", message: { role: "user", content: [{ type: "text", text: "主线第二问" }] } },
		// 5 扩展隐藏消息：display:false ⇒ 必须跳过
		{
			...base("e5", "e4", 6),
			type: "custom_message",
			customType: "c4-hidden",
			content: "隐藏的扩展消息",
			display: false,
		},
		// 6 扩展可见消息：display:true ⇒ 保留
		{
			...base("e6", "e5", 7),
			type: "custom_message",
			customType: "c4-visible",
			content: "扩展注入的可见消息",
			display: true,
		},
		// 7 usage 条目（消息上没有 usage ⇒ 应当由它兜底汇总）
		{
			...base("e7", "e6", 8),
			type: "usage",
			kind: "message",
			provider: "ark-coding",
			model: "deepseek-v4-flash",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
		// 8 模型切换（非消息类 ⇒ 跳过并计数）
		{ ...base("e8", "e7", 9), type: "model_change", provider: "ark-coding", modelId: "deepseek-v4-flash" },
		// 9 助手收尾（**最后一条 entry = leaf ⇒ 主干到此**）
		{ ...base("e9", "e8", 10), type: "message", message: { role: "assistant", content: [{ type: "text", text: "回答二" }] } },
	];
}

/** 会话目录里第一份真实会话文件（core 跑完 prompt 后由 Pi 写入） */
function firstRealSessionFile(agentDir) {
	const sessionsRoot = path.join(agentDir, "sessions");
	if (!fs.existsSync(sessionsRoot)) return null;
	for (const dir of fs.readdirSync(sessionsRoot)) {
		const full = path.join(sessionsRoot, dir);
		if (!fs.statSync(full).isDirectory()) continue;
		const files = fs.readdirSync(full).filter((f) => f.endsWith(".jsonl"));
		if (files.length > 0) return path.join(full, files[0]);
	}
	return null;
}

/** 文本抽取：把 load 回来的 Message[] 拍平成「一块一段」的字符串数组 */
function textsOf(messages) {
	const out = [];
	for (const m of messages) {
		for (const b of m.blocks) {
			if (b.type === "text") out.push(b.content);
			else if (b.type === "terminal") out.push(`[terminal ${b.toolCallId}] ${b.command} => ${b.output}`);
		}
	}
	return out;
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
// 无项目本地资源 ⇒ 不触发信任门（本脚本只验会话，不重复 C3 的信任门用例）
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));

const logFd = fs.openSync(path.join(runDir, "c4-core.log"), "w");
const child = spawn(process.execPath, ["--env-file=" + envLocal, tsxPath, mainPath], {
	cwd,
	env: {
		...process.env,
		CORE_TOKEN: TOKEN,
		CORE_PORT: String(PORT),
		CORE_MODELS_PATH: modelsPath,
		CORE_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "ignore", logFd],
});

let exitCode = 1;
try {
	console.log(`[c4] 临时目录 ${tmpRoot}`);
	const health = await waitForHealth((h) => h.extensions !== null, 60_000);
	check("①core 启动就绪（/health.extensions 非空）", !!health, health);

	/* ================================================================ 判据①：真实会话产出 */
	console.log("[c4] 跑一次真实会话（真实模型，约 10~60s）…");
	const t0 = Date.now();
	const promptRes = await request("POST", "/prompt", { text: PROMPT });
	const realSessionFile = firstRealSessionFile(agentDir);
	check("①真实会话已落盘（<agentDir>/sessions/**.jsonl 存在）", !!realSessionFile, realSessionFile && path.relative(tmpRoot, realSessionFile));

	const listRes = await request("GET", "/sessions");
	const sessions = listRes.json?.sessions ?? [];
	const fieldsComplete = sessions.every(
		(s) =>
			typeof s.id === "string" &&
			s.id.length > 0 &&
			typeof s.title === "string" &&
			s.title.trim().length > 0 &&
			typeof s.updatedAt === "number" &&
			Number.isFinite(s.updatedAt) &&
			typeof s.messageCount === "number",
	);
	// epoch ms 量级（2026 年约 1.78e12）：写成 ISO 字符串或秒级都不满足
	const epochOk = sessions.every((s) => s.updatedAt > 1e12 && s.updatedAt < 4e12);

	check("①GET /sessions 返回 200 且 ≥1 条", listRes.status === 200 && sessions.length >= 1, { status: listRes.status, count: sessions.length });
	check("①清单字段完整（id / title / updatedAt / messageCount 四字段）", fieldsComplete, sessions);
	check("①updatedAt 是 epoch ms 数字（不是 ISO 字符串 / 秒）", epochOk, sessions.map((s) => s.updatedAt));

	/* ================================================================ 判据②：加载真实会话 */
	const real = sessions.find((s) => s.messageCount > 0) ?? sessions[0];
	const loadReal = await request("POST", "/sessions/load", { id: real?.id });
	const realMessages = loadReal.json?.messages ?? [];
	const messagesWellFormed = realMessages.every(
		(m) =>
			typeof m.id === "string" &&
			(m.role === "user" || m.role === "assistant") &&
			Array.isArray(m.blocks) &&
			typeof m.timestamp === "number" &&
			m.timestamp > 1e12,
	);
	const userText = realMessages
		.flatMap((m) => (m.role === "user" ? m.blocks.filter((b) => b.type === "text").map((b) => b.content) : []))
		.join("");

	check("②POST /sessions/load 返回 200 且 messages ≥1", loadReal.status === 200 && realMessages.length >= 1, { status: loadReal.status, count: realMessages.length });
	check("②每条消息结构完整（id / role / blocks / timestamp=epoch ms）", messagesWellFormed, realMessages.map((m) => ({ id: m.id, role: m.role, blocks: m.blocks.length, timestamp: m.timestamp })));
	check("②能读回用户消息原文", userText.includes(PROMPT.slice(0, 6)), userText.slice(0, 120));
	check("②返回体带 tokenUsage 与映射统计（stats）", !!loadReal.json?.tokenUsage && !!loadReal.json?.stats, { tokenUsage: loadReal.json?.tokenUsage, stats: loadReal.json?.stats });

	/* ================================================================ 判据③：合成会话的确定性映射 */
	console.log("[c4] 写合成会话文件，验证 SessionEntry[] → Message[] 的独立映射…");
	const realFileDir = path.dirname(realSessionFile);
	const realHeader = JSON.parse(fs.readFileSync(realSessionFile, "utf8").split("\n")[0]);
	const synthPath = path.join(realFileDir, "2026-09-23T10-00-00-000Z_c4-synth-session.jsonl");
	// header 的 cwd 用**真实会话 header 里的原字符串**，避免路径写法差异导致 list() 的 cwd 过滤把它剔掉
	const synth = synthEntries(realHeader.cwd);
	fs.writeFileSync(synthPath, synth.map((e) => JSON.stringify(e)).join("\n") + "\n");

	const listRes2 = await request("GET", "/sessions");
	const sessions2 = listRes2.json?.sessions ?? [];
	check("①合成会话进入清单（清单 ≥2 条）", sessions2.length >= 2, sessions2.map((s) => ({ id: s.id, messageCount: s.messageCount })));

	const loadSynth = await request("POST", "/sessions/load", { id: "c4-synth-session" });
	const synthMessages = loadSynth.json?.messages ?? [];
	const synthTexts = textsOf(synthMessages);
	const joined = synthTexts.join("\n");
	const e2Message = synthMessages.find((m) => m.blocks.some((b) => b.type === "tool_call" && b.toolCallId === "tc-1"));
	const terminal = e2Message?.blocks.find((b) => b.type === "terminal");

	check("③合成会话加载成功（200）", loadSynth.status === 200, loadSynth.status);
	check(
		"③主干正确：只走 leaf 的父链（含 e1/e2/e4/e6/e9 → 5 条消息）",
		synthMessages.length === 5,
		{ count: synthMessages.length, texts: synthTexts.map((t) => t.slice(0, 24)) },
	);
	check("③旁支消息未出现（树结构取主干）", !joined.includes("旁支回答"), synthTexts);
	check("③主干其余消息齐全（第一问 / 回答一 / 主线第二问 / 可见扩展消息 / 回答二）", ["第一问", "回答一", "主线第二问", "扩展注入的可见消息", "回答二"].every((t) => joined.includes(t)), synthTexts);
	check(
		"③toolResult 合并进对应 assistant 消息（terminal 块带 command/output）",
		!!terminal && terminal.command === "echo hi" && terminal.output === "hi" && terminal.status === "success",
		terminal,
	);
	check("③custom_message.display=false 被跳过 / display=true 保留", !joined.includes("隐藏的扩展消息") && joined.includes("扩展注入的可见消息"), synthTexts);
	check(
		"③usage 条目兜底汇总成 TokenUsage（input=10 output=5 total=15，含 contextWindow）",
		loadSynth.json?.tokenUsage?.input === 10 &&
			loadSynth.json?.tokenUsage?.output === 5 &&
			loadSynth.json?.tokenUsage?.total === 15 &&
			loadSynth.json?.tokenUsage?.contextWindow > 0,
		loadSynth.json?.tokenUsage,
	);
	check(
		"③映射统计如实记账（usageSource=usage-entries，skipped 里 custom_message:hidden / usage / model_change 各 1）",
		loadSynth.json?.stats?.usageSource === "usage-entries" &&
			loadSynth.json?.stats?.skipped?.["custom_message:hidden"] === 1 &&
			loadSynth.json?.stats?.skipped?.usage === 1 &&
			loadSynth.json?.stats?.skipped?.model_change === 1 &&
			loadSynth.json?.stats?.mainBranchOnly === true,
		loadSynth.json?.stats,
	);
	check("③合成会话标题回落首条 user 消息（title = name ?? firstMessage）", loadSynth.json?.title === "第一问", loadSynth.json?.title);

	/* ================================================================ 判据④：404 / continue-recent */
	const missing = await request("POST", "/sessions/load", { id: "no-such-session-id" });
	check("④未知 id → 404（不 500、不挂死）", missing.status === 404, { status: missing.status, body: missing.json });

	const recent = await request("POST", "/sessions/continue-recent", {});
	const recentMessages = recent.json?.messages ?? [];
	check("④continue-recent 返回 200 且 id 在清单内", recent.status === 200 && sessions2.some((s) => s.id === recent.json?.id), { status: recent.status, id: recent.json?.id, listed: sessions2.map((s) => s.id) });
	check("④continue-recent 带回消息（≥1 条）", recentMessages.length >= 1, { count: recentMessages.length, id: recent.json?.id });

	/* ================================================================ 判据⑤：新端点的安全三件套 */
	const noToken = await request("GET", "/sessions", undefined, { token: "" });
	const badHost = await request("GET", "/sessions", undefined, { host: `evil.example.com:${PORT}` });
	const noTokenLoad = await request("POST", "/sessions/load", { id: "x" }, { token: "" });
	check("⑤无 token → 401（GET /sessions）", noToken.status === 401, noToken.status);
	check("⑤无 token → 401（POST /sessions/load）", noTokenLoad.status === 401, noTokenLoad.status);
	check("⑤错 Host → 403（防 DNS rebinding）", badHost.status === 403, badHost.status);

	Object.assign(evidence.judgments, {
		启动: { port: PORT, health, elapsedMs: Date.now() - t0 },
		真实会话: {
			promptHttpStatus: promptRes.status,
			会话文件: realSessionFile && path.relative(tmpRoot, realSessionFile),
			清单: sessions,
			加载: { status: loadReal.status, messageCount: realMessages.length, tokenUsage: loadReal.json?.tokenUsage, stats: loadReal.json?.stats },
		},
		合成会话: {
			文件: path.relative(tmpRoot, synthPath),
			清单: sessions2,
			加载: {
				status: loadSynth.status,
				title: loadSynth.json?.title,
				messageCount: synthMessages.length,
				texts: synthTexts,
				tokenUsage: loadSynth.json?.tokenUsage,
				stats: loadSynth.json?.stats,
			},
		},
		continueRecent: { status: recent.status, id: recent.json?.id, messageCount: recentMessages.length, 清单首条: sessions2[0]?.id },
		安全负向: { 无token_sessions: noToken.status, 无token_load: noTokenLoad.status, 错Host: badHost.status },
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
	console.error("[c4] 脚本异常:", e && e.stack ? e.stack : e);
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
		? "\nC4 会话列表与加载 检查全部通过"
		: `\nC4 检查失败 ${checks.filter((c) => !c.pass).length} 项：\n - ${checks.filter((c) => !c.pass).map((c) => c.name).join("\n - ")}`,
);
process.exit(exitCode);
