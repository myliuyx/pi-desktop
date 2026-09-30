/**
 * Provider compat 建模为**对象** + 保存预检 —— `check:compat`（CR-029，P1）。
 *
 * ## 为什么需要它
 * `models.json` 模型级 `compat` 被 core 契约误建模为 `string`（旧 `contract.ts:528`
 * `compat?: string`）。上游 Pi 的 `ProviderCompatSchema`（`@earendil-works/pi-coding-agent`
 * `dist/core/model-config.js`，源码锚点 `pi/packages/coding-agent/src/core/model-config.ts`，
 * HEAD 35180b9）是 OpenAI/Responses/Anthropic 三个**全可选字段对象**的联合 —— compat
 * **必须是对象**。两条伤害路径：
 *   (a) 字符串 compat 经 UI 写入 → `ModelConfig.load` 判整份文件非法、所有 Provider
 *       集体消失（一次编辑毁全部配置）；
 *   (b) 磁盘上合法对象 compat 经读入再保存时被 `asString` 静默丢弃，`supportsReasoningEffort`
 *       等字段退化。
 *
 * 本脚本把评审结论固化成三条可证伪断言（离线、不起 core、不出网，tsx 直导 src）：
 *   ① 合法**对象** compat 经 list→save→list 往返**不变**（deepEqual）；
 *   ② **字符串** compat 经 save 被拒（抛 `ProvidersValidationError`，status=400；server
 *      映射为 HTTP 4xx），且 models.json / sidecar **字节不变**、未触发 refresh
 *      （`getAvailableSnapshot()` 数量不变）；
 *   ③ 磁盘对象 compat 的 `supportsReasoningEffort` 等字段经 list→save 后**不被丢**
 *      （直接读回磁盘 JSON 断言字段仍在）。
 *
 * 先红后绿：本断言在修复前的旧代码上 ①②③ 全红——② save 不抛错（无预检）、①③ compat 被
 * `asString` 丢弃。修复后三项全绿。
 *
 * 用法（在 packages/core 下）：`npm run check:compat`（tsx 直跑 src，不起 core、无端口）。
 * 证据：`run/compat-object-evidence.json`；失败非 0 退出。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProvidersController } from "../src/providers.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, "..");
const runDir = path.join(coreDir, "run");
fs.mkdirSync(runDir, { recursive: true });
const evidencePath = path.join(runDir, "compat-object-evidence.json");

// 隔离：本次任务固定 /tmp/r0-t2 前缀（跑前 rm、跑后清），假 token/假 provider，零真实出网。
const base = "/tmp/r0-t2";
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(base, { recursive: true });
const agentDir = path.join(base, "agent");
fs.mkdirSync(agentDir, { recursive: true });
const modelsPath = path.join(agentDir, "models.json");
const sidecarPath = path.join(agentDir, "models-disabled.json");

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
function seed(models, disabled = {}) {
	fs.writeFileSync(modelsPath, JSON.stringify({ providers: models }, null, 2), "utf8");
	fs.writeFileSync(sidecarPath, JSON.stringify({ providers: disabled }, null, 2), "utf8");
}

// 假 runtime：只提供 save 路径会用到的 refresh / getAvailableSnapshot。快照计数固定，
// 用于断言「预检拒绝时未 refresh ⇒ 快照数量不变」。
const SNAPSHOT = [
	{ provider: "p1", id: "m1" },
	{ provider: "p1", id: "m2" },
];
let refreshCalls = 0;
const fakeRuntime = {
	refresh: async () => {
		refreshCalls += 1;
	},
	getAvailableSnapshot: () => SNAPSHOT,
	getModels: () => [],
};
const deps = {
	getModelsPath: () => modelsPath,
	getSidecarPath: () => sidecarPath,
	agentDir,
	getRuntime: () => fakeRuntime,
	selectCurrent: async () => false,
};

/** 保存是否被「预检」拒绝为 4xx（按错误名 + 状态码判定，不 import 错误类，保证旧代码上也能干净红） */
function isRejectedAs400(e) {
	return !!e && e.name === "ProvidersValidationError" && e.status === 400;
}

const checks = [];
const check = (name, pass, detail) => {
	checks.push({ name, pass: !!pass, detail });
	console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

/* ===== ①合法对象 compat：list → save → list 往返不变 ===== */
{
	const orig = { supportsReasoningEffort: true, supportsStore: true };
	seed({
		p1: {
			name: "Prov1",
			baseUrl: "http://127.0.0.1:9",
			apiKey: "r0-test-token",
			headers: {},
			models: [{ id: "m1", reasoning: true, input: ["text"], cost: COST, compat: orig }],
		},
	});
	const controller = createProvidersController(deps);
	const entry = controller.list().providers[0];
	await controller.save({ providers: [{ ...entry, enabled: true }] });
	const after = controller.list().providers[0];
	check(
		"① 合法对象 compat 往返不变",
		JSON.stringify(after.models[0].compat) === JSON.stringify(orig),
		{ got: after.models[0].compat ?? null, want: orig },
	);
}

/* ===== ③磁盘对象 compat 的字段不被丢（读回磁盘原文） ===== */
{
	const orig = { supportsReasoningEffort: true, supportsStore: true, maxTokensField: "max_completion_tokens" };
	seed({
		p1: {
			name: "Prov1",
			baseUrl: "http://127.0.0.1:9",
			apiKey: "r0-test-token",
			headers: {},
			models: [{ id: "m1", reasoning: true, input: ["text"], cost: COST, compat: orig }],
		},
	});
	const controller = createProvidersController(deps);
	const entry = controller.list().providers[0];
	await controller.save({ providers: [{ ...entry, enabled: true }] });
	const onDisk = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
	const compat = onDisk?.providers?.p1?.models?.[0]?.compat;
	check(
		"③ 磁盘对象 compat 字段不被丢（supportsReasoningEffort/maxTokensField）",
		compat && compat.supportsReasoningEffort === true && compat.maxTokensField === "max_completion_tokens",
		{ got: compat ?? null },
	);
}

/* ===== ②字符串 compat：save 被拒（4xx），磁盘 / sidecar / 快照均不变 ===== */
{
	// 基线：一条合法的对象 compat provider（pre-check 若走原路径应放行；这里测的是被拒路径）
	seed({
		p1: {
			name: "Prov1",
			baseUrl: "http://127.0.0.1:9",
			apiKey: "r0-test-token",
			headers: {},
			models: [{ id: "m1", reasoning: true, input: ["text"], cost: COST, compat: { supportsStore: true } }],
		},
	});
	const beforeModels = fs.readFileSync(modelsPath, "utf8");
	const beforeSide = fs.readFileSync(sidecarPath, "utf8");
	const beforeSnapshotCount = fakeRuntime.getAvailableSnapshot().length;
	refreshCalls = 0;

	const controller = createProvidersController(deps);
	let threw = null;
	try {
		await controller.save({
			providers: [
				{
					id: "p2",
					enabled: true,
					headers: {},
					models: [{ id: "m2", reasoning: false, input: ["text"], cost: COST, compat: "gpt-5" }],
				},
			],
		});
	} catch (e) {
		threw = e;
	}
	check(
		"② 字符串 compat 被拒（ProvidersValidationError 400）",
		isRejectedAs400(threw),
		{ threw: threw ? { name: threw.name, status: threw.status, msg: String(threw.message).slice(0, 160) } : null },
	);
	check("②b 拒绝后 models.json 字节不变", fs.readFileSync(modelsPath, "utf8") === beforeModels);
	check("②c 拒绝后 sidecar 字节不变", fs.readFileSync(sidecarPath, "utf8") === beforeSide);
	check(
		"②d 拒绝后未 refresh（getAvailableSnapshot 数量不变）",
		refreshCalls === 0 && fakeRuntime.getAvailableSnapshot().length === beforeSnapshotCount,
		{ refreshCalls, beforeSnapshotCount, afterSnapshotCount: fakeRuntime.getAvailableSnapshot().length },
	);
}

fs.rmSync(base, { recursive: true, force: true });

const evidence = { startedAt: new Date().toISOString(), checks };
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

const failed = checks.filter((c) => !c.pass).length;
if (failed > 0) {
	console.error(`\ncompat-object 检查失败 ${failed} 项（证据：${evidencePath}）`);
	process.exit(1);
}
console.log(`compat-object 检查全部通过：${checks.length} 项（证据：${evidencePath}）`);
