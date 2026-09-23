/**
 * C5 · 04/05 屏数据源（`/resources` + `/models`）—— 检查脚本（node 直跑，不引框架）。
 *
 * 覆盖规格书 §3.3 的两个判据 + 信任门过滤的双向验证 + 新端点的安全负向用例：
 *
 *   ① `GET /resources` 三类齐全（扩展/提示词/技能各 ≥1），条目字段完整；
 *   ② **信任门过滤双向**：
 *      - `defaultProjectTrust=never` + 含 `.pi/extensions`、`.pi/skills` 的 cwd
 *        → 项目本地资源**不列**、`trust.trusted=false`、`projectTrustBlocked=true`；
 *      - `always` → 同样的资源**被列出**、来源标记「项目内」、`projectTrustBlocked=false`。
 *
 *      ⚠️ 实测口径：未信任时 Pi **根本不加载**项目本地资源，所以 `getExtensions()` 里
 *      它们本就不存在 —— 「有没有被信任门拦下」由 `hasTrustRequiringProjectResources(cwd)`
 *      谓词 + `trust` 组合判定（`projectResourcesExist && !trusted`），
 *      **不能**用「过滤前后条数差」（`filteredProjectCount` 恒为 0，它不是判据）。
 *   ③ `GET /models` 模型 ≥1、当前模型与 `settings.json` 现值可读；
 *   ④ `POST /models/select` 切换后 **core 侧确认写回**：响应 `settings.modelId` 变化 +
 *      临时 agentDir 的 `settings.json` 里 `defaultProvider` / `defaultModel` 实写成新值；
 *   ⑤ `POST /thinking` 同理写回 `defaultThinkingLevel`（并说明「生效档位被模型能力夹取」）；
 *   ⑥ 非法入参 → 400；无 token → 401；错 Host → 403（新端点照走安全三件套）。
 *
 * 夹具（**入库**，`test/fixtures/resources/`）：
 * - `extensions/demo-extension.ts`（user scope，不拦截任何工具）
 * - `skills/demo-skill/SKILL.md`、`prompts/demo-prompt.md`（user scope）
 * - `project/.pi/extensions/project-local.ts`、`project/.pi/skills/project-skill/SKILL.md`（project scope）
 *
 * 用法（在 packages/core 下）：`npm run check:c5`
 * 证据：`run/c5-evidence.json`
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
const fixtureDir = path.join(coreDir, "test", "fixtures", "resources");
const runDir = path.join(coreDir, "run");
const evidencePath = path.join(runDir, "c5-evidence.json");
fs.mkdirSync(runDir, { recursive: true });

const TOKEN = process.env.C5_TOKEN ?? "c5-token";
const HTTP_TIMEOUT_MS = 15_000;
/** 期望被选中的模型（models.json 里唯一有凭证的那个） */
const PROVIDER = process.env.C5_PROVIDER ?? "ark-coding";
const MODEL_ID = process.env.C5_MODEL ?? process.env.PI_MODEL ?? "deepseek-v4-flash";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c5-resources-"));

const checks = [];
const check = (name, pass, detail) => {
	checks.push({ name, pass: !!pass, detail });
	console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

/* ---------------------------------------------------------------------------
 * HTTP 小工具
 * ------------------------------------------------------------------------- */

function request(port, method, p, body, { token = TOKEN, host } = {}) {
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
			{ host: "127.0.0.1", port, path: p, method, headers, timeout: HTTP_TIMEOUT_MS },
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
			const r = await request(port, "GET", "/health");
			if (r.status === 200 && r.json && ok(r.json)) return r.json;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() - t0 > timeoutMs) return null;
		await sleep(300);
	}
}

/* ---------------------------------------------------------------------------
 * 夹具与 core 实例
 * ------------------------------------------------------------------------- */

/**
 * 造一个 agentDir：settings.json（指定 defaultProjectTrust）+ user scope 的
 * extensions/skills/prompts 三类夹具。
 */
function makeAgentDir(name, defaultProjectTrust) {
	const dir = path.join(tmpRoot, `${name}-agentdir`);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultProjectTrust }, null, 2));
	fs.cpSync(path.join(fixtureDir, "extensions"), path.join(dir, "extensions"), { recursive: true });
	fs.cpSync(path.join(fixtureDir, "skills"), path.join(dir, "skills"), { recursive: true });
	fs.cpSync(path.join(fixtureDir, "prompts"), path.join(dir, "prompts"), { recursive: true });
	return dir;
}

/** 造一个 cwd：含 `.pi/extensions` 与 `.pi/skills`（= 受信任门管辖的项目本地资源） */
function makeProjectCwd(name) {
	const cwd = path.join(tmpRoot, `${name}-cwd`);
	fs.cpSync(path.join(fixtureDir, "project"), cwd, { recursive: true });
	return cwd;
}

function launchCore({ name, cwd, agentDir, port }) {
	const logPath = path.join(runDir, `c5-core-${name}.log`);
	const logFd = fs.openSync(logPath, "w");
	const child = spawn(process.execPath, ["--env-file=" + envLocal, tsxPath, mainPath], {
		cwd,
		env: {
			...process.env,
			CORE_TOKEN: TOKEN,
			CORE_PORT: String(port),
			CORE_MODELS_PATH: modelsPath,
			CORE_AGENT_DIR: agentDir,
		},
		stdio: ["ignore", "ignore", logFd],
	});
	return {
		child,
		logPath,
		async close() {
			child.kill("SIGTERM");
			await Promise.race([new Promise((r) => child.once("exit", r)), sleep(4000).then(() => child.kill("SIGKILL"))]);
			fs.closeSync(logFd);
		},
	};
}

function readSettings(agentDir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
	} catch {
		return null;
	}
}

const names = (list) => list.map((e) => e.name);
const has = (list, name) => list.some((e) => e.name === name);

/* ---------------------------------------------------------------------------
 * 用例 A：never（未信任 ⇒ 项目本地资源必须被过滤）
 * ------------------------------------------------------------------------- */

async function caseNever() {
	const PORT = 5205;
	const agentDir = makeAgentDir("never", "never");
	const cwd = makeProjectCwd("never");
	const core = launchCore({ name: "never", cwd, agentDir, port: PORT });
	const out = { port: PORT, agentDir, cwd };
	try {
		const health = await waitForHealth(PORT, (h) => h.extensions !== null, 60_000);
		check("①core 启动就绪（/health.extensions 非空）", !!health, health);

		/* ---------------------------------------------------- GET /resources */
		const res = await request(PORT, "GET", "/resources");
		const body = res.json ?? {};
		out.resources = res.json;
		out.health = health;

		const ext = body.extensions ?? [];
		const prompts = body.prompts ?? [];
		const skills = body.skills ?? [];
		const fieldsComplete = [...ext, ...prompts, ...skills].every(
			(e) => typeof e.id === "string" && typeof e.name === "string" && typeof e.description === "string",
		);

		check("①GET /resources 200", res.status === 200, res.status);
		check("①三类齐全且各 ≥1 条（扩展 / 提示词 / 技能）", ext.length >= 1 && prompts.length >= 1 && skills.length >= 1, { extensions: ext.length, prompts: prompts.length, skills: skills.length });
		check("①条目字段完整（id / name / description，且带来源标记）", fieldsComplete && [...ext, ...prompts, ...skills].every((e) => typeof e.source === "string" && e.source.length > 0), [...ext, ...prompts, ...skills]);
		check("①user scope 夹具被列出（demo-extension / demo-skill / /demo-prompt）", has(ext, "demo-extension") && has(skills, "demo-skill") && has(prompts, "/demo-prompt"), { ext: names(ext), skills: names(skills), prompts: names(prompts) });

		/* --------------------------------------------- 信任门过滤（未信任方向） */
		check("②未信任：trust.trusted=false（reason=never）", body.trust?.trusted === false && body.trust?.reason === "never", body.trust);
		check("②未信任：项目本地扩展未列出（project-local）", !has(ext, "project-local"), names(ext));
		check("②未信任：项目本地技能未列出（project-skill）", !has(skills, "project-skill"), names(skills));
		check(
			"②未信任：projectResourcesExist=true 且 projectTrustBlocked=true（cwd 确实有被信任门拦下的项目本地资源）",
			body.projectResourcesExist === true && body.projectTrustBlocked === true,
			{ projectResourcesExist: body.projectResourcesExist, projectTrustBlocked: body.projectTrustBlocked },
		);

		/* ------------------------------------------------------ GET /models */
		const models = await request(PORT, "GET", "/models");
		const mBody = models.json ?? {};
		out.models = mBody;
		const list = mBody.models ?? [];
		check("③GET /models 200 且模型 ≥1", models.status === 200 && list.length >= 1, { status: models.status, count: list.length });
		check("③模型条目字段完整（id / label / provider）", list.every((m) => typeof m.id === "string" && typeof m.label === "string" && typeof m.provider === "string"), list);
		check("③current 非空且能在清单里找到", !!mBody.current && list.some((m) => m.id === mBody.current.modelId && m.provider === mBody.current.provider), mBody.current);
		check("③ready=true 且给出可用思考档位", mBody.ready === true && Array.isArray(mBody.availableThinkingLevels) && mBody.availableThinkingLevels.length >= 1, { ready: mBody.ready, available: mBody.availableThinkingLevels });

		/* ------------------------------------------------ POST /models/select */
		const target = list[0];
		const selected = await request(PORT, "POST", "/models/select", { provider: target.provider, modelId: target.id });
		const sBody = selected.json ?? {};
		const settingsAfterSelect = readSettings(agentDir);
		out.select = { target, response: sBody, settingsFile: settingsAfterSelect };
		const currentBefore = mBody.settings; // 切换前 settings.json 的现值（fixture 里只有 defaultProjectTrust → 两个字段都为 null）

		check("④POST /models/select 200 且 current 切到目标模型", selected.status === 200 && sBody.current?.modelId === target.id && sBody.current?.provider === target.provider, sBody.current);
		check(
			"④core 侧确认写回：响应 settings 与 agentDir/settings.json 的 defaultModel/defaultProvider 都被写成目标模型",
			sBody.settings?.modelId === target.id &&
				sBody.settings?.provider === target.provider &&
				settingsAfterSelect?.defaultModel === target.id &&
				settingsAfterSelect?.defaultProvider === target.provider,
			{ 切换前: currentBefore, 响应settings: sBody.settings, 文件: settingsAfterSelect },
		);

		/* --------------------------------------------------------- POST /thinking */
		const think = await request(PORT, "POST", "/thinking", { level: "high" });
		const thinkBody = think.json ?? {};
		const settingsAfterThink = readSettings(agentDir);
		out.thinking = { response: thinkBody, settingsFile: settingsAfterThink };
		check("⑤POST /thinking 200（档位=high）", think.status === 200, { status: think.status, body: thinkBody });
		check(
			"⑤core 侧确认写回：响应 settings.thinkingLevel=high 且 agentDir/settings.json 的 defaultThinkingLevel=high",
			thinkBody.settings?.thinkingLevel === "high" && settingsAfterThink?.defaultThinkingLevel === "high",
			{ 响应settings: thinkBody.settings, 文件: settingsAfterThink },
		);
		out.thinkingNote =
			"生效档位被模型能力夹取：本机 ark-coding/deepseek-v4-flash 的 reasoning=false ⇒ availableThinkingLevels=['off']，故 thinkingLevel（生效）仍为 off，而 defaultThinkingLevel（用户所选）已写为 high";

		/* ------------------------------------------------- 非法入参与安全负向 */
		const badLevel = await request(PORT, "POST", "/thinking", { level: "ultra" });
		const badModel = await request(PORT, "POST", "/models/select", { provider: "no-such", modelId: "x" });
		const noTokenRes = await request(PORT, "GET", "/resources", undefined, { token: "" });
		const noTokenThink = await request(PORT, "POST", "/thinking", { level: "low" }, { token: "" });
		const badHost = await request(PORT, "GET", "/models", undefined, { host: `evil.example.com:${PORT}` });
		out.negative = {
			非法档位: badLevel.status,
			不存在模型: badModel.status,
			无token_resources: noTokenRes.status,
			无token_thinking: noTokenThink.status,
			错Host: badHost.status,
		};
		check("⑥非法档位 → 400（白名单式校验）", badLevel.status === 400, badLevel.status);
		check("⑥不存在的模型 → 400", badModel.status === 400, badModel.status);
		check("⑥无 token → 401（/resources 与 /thinking 各一）", noTokenRes.status === 401 && noTokenThink.status === 401, out.negative);
		check("⑥错 Host → 403（防 DNS rebinding）", badHost.status === 403, badHost.status);
	} catch (e) {
		out.error = String(e && e.stack ? e.stack : e);
		check("用例 A 执行无异常", false, out.error);
	} finally {
		await core.close();
	}
	return out;
}

/* ---------------------------------------------------------------------------
 * 用例 B：always（已信任 ⇒ 项目本地资源必须被列出）
 * ------------------------------------------------------------------------- */

async function caseAlways() {
	const PORT = 5206;
	const agentDir = makeAgentDir("always", "always");
	const cwd = makeProjectCwd("always");
	const core = launchCore({ name: "always", cwd, agentDir, port: PORT });
	const out = { port: PORT };
	try {
		const health = await waitForHealth(PORT, (h) => h.extensions !== null, 60_000);
		const res = await request(PORT, "GET", "/resources");
		const body = res.json ?? {};
		out.health = health;
		out.resources = res.json;

		const ext = body.extensions ?? [];
		const skills = body.skills ?? [];
		check("②已信任：trust.trusted=true（reason=always）", body.trust?.trusted === true && body.trust?.reason === "always", body.trust);
		check("②已信任：项目本地扩展被列出且来源标记「项目内」", has(ext, "project-local") && ext.find((e) => e.name === "project-local")?.source === "项目内", { ext: names(ext), sources: ext.map((e) => `${e.name}:${e.source}`) });
		check("②已信任：项目本地技能被列出", has(skills, "project-skill"), names(skills));
		check(
			"②已信任：projectTrustBlocked=false（项目本地资源未被拦下）",
			body.projectTrustBlocked === false && body.filteredProjectCount === 0,
			{ projectTrustBlocked: body.projectTrustBlocked, filteredProjectCount: body.filteredProjectCount },
		);
		check("②已信任：扩展数 > 未信任时（项目本地扩展真的进来了）", ext.length >= 2, ext.length);
	} catch (e) {
		out.error = String(e && e.stack ? e.stack : e);
		check("用例 B 执行无异常", false, out.error);
	} finally {
		await core.close();
	}
	return out;
}

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */

const evidence = { startedAt: new Date().toISOString(), 夹具: path.relative(coreDir, fixtureDir), judgments: {} };
let exitCode = 1;
try {
	console.log(`[c5] 临时目录 ${tmpRoot}`);
	console.log("[c5] 用例 A：defaultProjectTrust=never（未信任 ⇒ 过滤项目本地资源）…");
	evidence.judgments.never = await caseNever();
	console.log("[c5] 用例 B：defaultProjectTrust=always（已信任 ⇒ 列入项目本地资源）…");
	evidence.judgments.always = await caseAlways();

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
	console.error("[c5] 脚本异常:", e && e.stack ? e.stack : e);
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
		? "\nC5 04/05 屏数据源 检查全部通过"
		: `\nC5 检查失败 ${checks.filter((c) => !c.pass).length} 项：\n - ${checks.filter((c) => !c.pass).map((c) => c.name).join("\n - ")}`,
);
process.exit(exitCode);
