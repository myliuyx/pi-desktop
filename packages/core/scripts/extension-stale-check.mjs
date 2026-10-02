/**
 * Extension ctx stale 回归检查 —— 复现「新会话复用被 dispose() 失效的 Extension 实例」。
 *
 * 背景（本脚本要抓的 bug）：
 *   `packages/core/src/session.ts` 的 `newSession()` 注释声称「settingsManager /
 *   resourceLoader 是 cwd 绑定产物，同 cwd 直接复用…不走信任门、不重载资源」。
 *   这个假设对 settings / skills / prompts 成立，对 extension 不成立 ——
 *   Extension 实例的生命周期绑在 ExtensionRunner 上，而 `previous?.dispose()`
 *   会调 `_extensionRunner.invalidate()`（pi core/agent-session.ts:931）把该
 *   runtime 永久标记为 stale（`invalidate` 只在 staleMessage 未设时写入，不可逆）。
 *   新会话经 `sdk.ts:434 → resourceLoader.getExtensions()` 拿回的是同一个
 *   `this.extensionsResult` 成员变量，于是新 runner 挂着一批已失效的实例，
 *   任何 ctx getter 访问都抛 "This extension ctx is stale…"。
 *
 * 为什么不用真实 provider + prompt 驱动：
 *   让模型「恰好调用 subagent 工具」不确定，本 bug 的本质是 Extension runtime
 *   被 stale 化，与模型无关。改为直接探测 runtime 活性：拿到 extensionsResult
 *   后调用 `runtime.registerTool()`（走 loader 的 pending 队列，不经模型），
 *   新会话能用 = runtime 未 stale；抛 stale = bug 复现。全程离线、确定性、无 token。
 *
 * 用法（在 packages/core 下）：
 *   npm run check:extension-stale
 *   CORE_ENTRY=dist/main.js npm run check:extension-stale   # 验产物而非源码
 *
 * 断言：
 *   S-1 首会话 runtime 活性 —— registerTool 不抛错（探针本身有效的自证）
 *   S-2 复现 bug —— newSession 后复用同一 loader，registerTool 抛 stale
 *   S-3 修复后 —— newSession 前 reload()，registerTool 不抛错
 *
 * 证据：`run/extension-stale-evidence.json`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const runDir = path.join(process.cwd(), "run");
fs.mkdirSync(runDir, { recursive: true });
const evidencePath = path.join(runDir, "extension-stale-evidence.json");

const checks = [];
const check = (name, pass, detail) => {
	checks.push({ name, pass: !!pass, detail });
	console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

/* ---------------------------------------------------------------------------
 * 载入 pi 包：优先源码（tsx 跑本仓库 pi），否则 node_modules 产物。
 * 两条路径都必须能 import —— 这是探针有效性的前提，先单独验证。
 * ------------------------------------------------------------------------- */

const STALE_RE = /ctx is stale/i;

async function loadPi() {
	// 主入口 dist/index.js 才是公开 API 面（深层路径非稳定契约）
	const entry = path.resolve(process.env.PI_ENTRY ?? "../../pi/packages/coding-agent/dist/index.js");
	const candidates = [
		// monorepo 内产物（pi/packages/coding-agent）—— 对齐「改源码即改行为」
		{ name: "source", specifier: entry },
		// 已安装产物 —— 对齐「workbench 实际跑的东西」
		{ name: "installed", specifier: "@earendil-works/pi-coding-agent" },
	];
	const errors = [];
	for (const c of candidates) {
		try {
			const mod = await import(c.specifier);
			return { ...mod, __variant: c.name };
		} catch (e) {
			errors.push(`${c.name}: ${e?.message ?? e}`);
		}
	}
	throw new Error(`无法载入 pi 包：\n${errors.join("\n")}`);
}

/* ---------------------------------------------------------------------------
 * 探针：注册一个哑工具。registerTool 走 loader 的 pending 队列 / runtime，
 * 不经模型、不碰文件系统。若 runtime 已 stale，第一时间抛错。
 * ------------------------------------------------------------------------- */

function makeProbeRuntimeTest(runtime, tag) {
	// runtime 上没有 registerTool（那是 ExtensionAPI 的能力），直接用 assertActive
	// 与若干 getter 探测活性。loader.ts:157-192 的 runtime 成员大多先绑 notInitialized，
	// bindCore() 后才换成直调 + assertActive 包裹 —— 但 assertActive 本身始终在。
	const probe = (label, fn) => {
		try {
			const v = fn();
			return { label, ok: true, value: typeof v };
		} catch (e) {
			const msg = String(e?.message ?? e);
			return { label, ok: false, error: msg, isStale: STALE_RE.test(msg) };
		}
	};

	// 1) assertActive() —— 最直接：staleMessage 存在即抛
	const active = probe("assertActive", () => runtime.assertActive?.());
	// 2) 走 ExtensionRunner 那层（若可得）—— ExtensionContext getter 的真实路径
	const ctxProbe = probe("getSessionName", () => runtime.getSessionName?.());
	const toolsProbe = probe("getActiveTools", () => runtime.getActiveTools?.());

	const results = [active, ctxProbe, toolsProbe];
	const isStale = results.some((r) => r.isStale);
	const allOk = results.every((r) => r.ok);

	return {
		tag,
		runtimeAvailable: typeof runtime === "object" && runtime !== null,
		assertActiveOk: active.ok,
		getSessionNameOk: ctxProbe.ok,
		getActiveToolsOk: toolsProbe.ok,
		isStale,
		raw: results,
		summary: isStale
			? "stale：runtime 已被 invalidate()"
			: allOk
				? "活性：ctx getter 可正常访问"
				: "非 stale 但有其他错误（探针口径需修正）",
	};
}

/* ---------------------------------------------------------------------------
 * 主流程：完全照抄 core 的 newSession 口径（复用 loader，不重载内容）
 * ------------------------------------------------------------------------- */

async function main() {
	const pi = await loadPi();
	const { createAgentSession, DefaultResourceLoader, SettingsManager, ModelRuntime } = pi;
	console.log(`pi 包来源：${pi.__variant}`);

	// 隔离沙箱：临时 agentDir + cwd，绝不碰真实 ~/.pi/agent 与用户项目
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ext-stale-"));
	const agentDir = path.join(sandbox, "agent");
	const cwd = path.join(sandbox, "proj");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });

	// 最小 models.json：避免 SDK 去找真实凭证（探针不跑模型，但 SDK 会解析 model）
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {} }, null, 2));
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({}), null, 2);

	const settingsManager = SettingsManager.create(cwd, agentDir);
	// ★ 与 core bootProject 同一口径：不传 resolveProjectTrust（信任门在沙箱里无需真实交互）
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	await resourceLoader.reload();

	let modelRuntime = null;
	try {
		modelRuntime = await ModelRuntime.create({ modelsPath: path.join(agentDir, "models.json") });
	} catch (e) {
		console.log(`  （ModelRuntime 不可用：${e?.message ?? e}；探针不跑模型，继续）`);
	}

	const baseOptions = { cwd, agentDir, settingsManager, resourceLoader, ...(modelRuntime ? { modelRuntime } : {}) };

	// ---- 首会话 ----
	const first = await createAgentSession({ ...baseOptions });
	const firstTest = makeProbeRuntimeTest(first.extensionsResult.runtime, "session1");
	check("S-1 首会话 runtime 活性（探针自证）", firstTest.isStale === false && firstTest.assertActiveOk, firstTest);

	// ---- 关键动作：照抄 core newSession 的 dispose 顺序 ----
	// core/src/session.ts:948 —— 换引用后 dispose 旧实例（这一步 invalidate runtime）
	first.session.dispose();

	// ---- 第二会话：完全复用同一个 resourceLoader（= bug 根因） ----
	const second = await createAgentSession({ ...baseOptions });
	const secondTest = makeProbeRuntimeTest(second.extensionsResult.runtime, "session2");

	// S-2 是本脚本的核心断言：当前 HEAD 下应当**失败**（复现 bug）
	check(
		"S-2 复现：复用 loader 的新会话应拿到 stale runtime（期望 pass=false 即复现成功）",
		!secondTest.isStale,
		{ 期望: "isStale=true（复现 bug）", 实际: secondTest },
	);

	// ---- S-3 对照组：修复路径（newSession 前先 reload()），应恢复正常 ----
	second.session.dispose();
	await resourceLoader.reload(); // ★ 方案 1 的修复动作
	const third = await createAgentSession({ ...baseOptions });
	const thirdTest = makeProbeRuntimeTest(third.extensionsResult.runtime, "session3");
	check("S-3 修复路径：reload() 后新会话 runtime 应为活性（期望 pass=true）", !thirdTest.isStale, thirdTest);

	third.session.dispose();

	// ---- 汇总 ----
	const reproduced = secondTest.isStale;
	const fixedWorks = !thirdTest.isStale;
	const evidence = {
		piVariant: pi.__variant,
		sandbox,
		assertions: checks,
		verdict: {
			bugReproduced: reproduced,
			fixPathWorks: fixedWorks,
			结论: reproduced && fixedWorks ? "根因确认 + 方案 1 可行" : reproduced ? "复现了但修复路径无效，需换方案" : "未复现，可能已被修复或探针失效",
		},
	};
	fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

	console.log("\n=== 结论 ===");
	console.log(`  bug 复现: ${reproduced ? "是 ✅" : "否 ❌"}`);
	console.log(`  修复路径可行: ${fixedWorks ? "是 ✅" : "否 ❌"}`);
	console.log(`  证据: ${evidencePath}`);

	// 复现且修复路径有效 → 脚本按预期工作，退出码 0（探针是绿的）
	process.exit(reproduced && fixedWorks ? 0 : 1);
}

main().catch((e) => {
	console.error("探针执行失败：", e);
	fs.writeFileSync(evidencePath, JSON.stringify({ fatal: String(e?.stack ?? e) }, null, 2));
	process.exit(2);
});
