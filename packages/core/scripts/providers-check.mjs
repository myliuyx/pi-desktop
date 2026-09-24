/**
 * 设置改版 · 第二批（模型接真）—— core 侧验收脚本（node 直跑，不引框架）。
 *
 * 规格书：`.plan/task-settings-c2.md` §四·4。判据由主控（非第二批实现方）书写，
 * **所有期望值从夹具/响应现读，不写死**。
 *
 * 覆盖：
 *   ① `GET /providers` 基本：200 / 字段完整 / `current` 可读 / `ready=true`；
 *   ② JSONC 容忍：BOM + 行注释 + 块注释 + 尾逗号 ⇒ 仍能解析出 provider；
 *   ③ 凭证原文保留（S2 + D6）：models.json 里写 `"$ARK_API_KEY"` ⇒ GET **按原文返回、不展开**；
 *   ④ sidecar 拆分写回（D9）：enabled → models.json、disabled → models-disabled.json，
 *      两文件内容各自正确，GET 合并后 `enabled` 标志正确；
 *   ⑤ 原子写：写回后同目录无 `.tmp` 残留；
 *   ⑥ 删除物理消失：PUT 里不含某 provider ⇒ models.json 里它真的不在了；
 *   ⑦ 保存后复读一致：改过的字段能从 `GET /providers` 原样读回；
 *   ⑧ 回退（S1 边界）：当前生效模型被删 ⇒ `fallbackApplied=true` + `current` 落到可用快照
 *      第一个 + `settings.json` 的 `defaultProvider/defaultModel` 被改写；
 *   ⑨ 坏文件：models.json 非法 ⇒ 结构化 `{error}` 且**不 500**；
 *   ⑩ 目录检索 `GET /models/catalog?q=`：命中 / 上限 20 / 字段完整；
 *   ⑪ 模型测试 `POST /models/test`：真实请求 ok / 不可达端点 ok=false 带 error / 缺参 400；
 *   ⑬ JSONC 字符串内容不被去尾逗号误伤：name 含 `, }` / `,]` 字样仍原样读回；
 *   ⑭ 非契约字段保留（S-extra）：provider/model 级契约之外的字段，PUT 保存后从磁盘并回；
 *   ⑫ 安全三件套：无 token 401、错 Host 403、PUT 缺数组 400。
 *
 * 夹具：**全部落在系统临时目录**（含 models.json 与 agentDir），绝不碰 `pi/_poc/models.json`——
 * 因为写回测试会真的覆盖它。
 *
 * 用法（在 packages/core 下）：`npm run check:providers`
 * 证据：`run/providers-evidence.json`
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv } from "./lib/credentials.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, "..");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
const mainPath = path.join(coreDir, "src", "main.ts");
const seedModelsPath = path.resolve(coreDir, "..", "..", "pi", "_poc", "models.json");
const runDir = path.join(coreDir, "run");
const evidencePath = path.join(runDir, "providers-evidence.json");
fs.mkdirSync(runDir, { recursive: true });

const PORT = Number(process.env.PVD_PORT ?? 5207);
const TOKEN = process.env.PVD_TOKEN ?? "pvd-token";
const HTTP_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pvd-check-"));
const agentDir = path.join(tmpRoot, "agentdir");
fs.mkdirSync(agentDir, { recursive: true });
/* 2026-09-24：CORE_MODELS_PATH 覆盖口已删 —— 清单只能落在 agentDir 里（Pi 的约定位置） */
const modelsPath = path.join(agentDir, "models.json");
const sidecarPath = path.join(agentDir, "models-disabled.json");

const checks = [];
const check = (name, pass, detail) => {
	checks.push({ name, pass: !!pass, detail });
	console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

/* ---------------------------------------------------------------------------
 * HTTP 小工具
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

async function waitForHealth(timeoutMs = 90_000) {
	const t0 = Date.now();
	for (;;) {
		try {
			const r = await request("GET", "/health");
			// extensions 非 null ⇒ 会话（进而 runtime）已就绪
			if (r.status === 200 && r.json && r.json.extensions !== null) return r.json;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() - t0 > timeoutMs) return null;
		await sleep(300);
	}
}

/* ---------------------------------------------------------------------------
 * 夹具
 * ------------------------------------------------------------------------- */

const ARK = {
	id: "ark-coding",
	name: "ark-coding",
	baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
	apiKey: "$ARK_API_KEY",
	api: "openai-completions",
	headers: {},
	enabled: true,
	models: [
		{
			id: "deepseek-v4-flash",
			name: "deepseek-v4-flash",
			reasoning: false,
			input: ["text"],
			contextWindow: 131072,
			maxTokens: 8192,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		},
	],
};

/** 第二个 provider（本地假端点，不联网；只为验证拆分写回与回退） */
const FAKE = {
	id: "local-echo",
	name: "local-echo",
	baseUrl: "http://127.0.0.1:1/v1",
	apiKey: "sk-fixture-only",
	api: "openai-completions",
	headers: {},
	enabled: true,
	models: [
		{
			id: "echo-mini",
			name: "echo-mini",
			reasoning: false,
			input: ["text"],
			contextWindow: 8192,
			maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	],
};

const writeModels = (text) => fs.writeFileSync(modelsPath, text, "utf8");

/** 初始 models.json：直接复制真实 fixture（含 `"$ARK_API_KEY"` 插值原文） */
writeModels(fs.readFileSync(seedModelsPath, "utf8"));

/** settings.json 预置当前生效模型（fallback 用例需要 `before` 非空） */
const writeSettings = (obj) =>
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ defaultProjectTrust: "never", ...obj }, null, 2),
	);
const readSettings = () => {
	try {
		return JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
	} catch {
		return null;
	}
};
writeSettings({ defaultProvider: "ark-coding", defaultModel: "deepseek-v4-flash" });

const readModelsFile = () => {
	try {
		return JSON.parse(fs.readFileSync(modelsPath, "utf8"));
	} catch {
		return null;
	}
};
const readSidecarFile = () => {
	try {
		return JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
	} catch {
		return { providers: {} };
	}
};
/*
 * 原子写的临时文件与 models.json **同目录** —— 2026-09-24 清单搬进 agentDir 后，
 * 这里必须跟着改成 agentDir，否则断言变成「扫了个空目录」恒真（假绿）。
 */
const tmpLeftovers = () => fs.readdirSync(agentDir).filter((f) => f.includes(".tmp"));

/* ---------------------------------------------------------------------------
 * 端点包装
 * ------------------------------------------------------------------------- */

const getProviders = (opts) => request("GET", "/providers", undefined, opts);
const putProviders = (providers) => request("PUT", "/providers", { providers });
const catalog = (q) => request("GET", `/models/catalog?q=${encodeURIComponent(q)}`);
const testModel = (body) => request("POST", "/models/test", body);

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */

const evidence = {
	startedAt: new Date().toISOString(),
	夹具: { 临时目录: tmpRoot, models: path.relative(coreDir, seedModelsPath) },
	judgments: {},
};

function launchCore() {
	const logPath = path.join(runDir, "providers-core.log");
	const logFd = fs.openSync(logPath, "w");
	const child = spawn(process.execPath, [tsxPath, mainPath], {
		cwd: coreDir,
		env: childEnv({
			CORE_TOKEN: TOKEN,
			CORE_PORT: String(PORT),
			CORE_AGENT_DIR: agentDir,
		}),
		stdio: ["ignore", "ignore", logFd],
	});
	return {
		logPath,
		async close() {
			child.kill("SIGTERM");
			await Promise.race([
				new Promise((r) => child.once("exit", r)),
				sleep(5000).then(() => child.kill("SIGKILL")),
			]);
			fs.closeSync(logFd);
		},
	};
}

let exitCode = 1;
let core = null;
try {
	console.log(`[providers] 临时目录 ${tmpRoot}`);
	console.log(`[providers] 启动 core（端口 ${PORT}）…`);
	core = launchCore();
	const health = await waitForHealth();
	check("⓪core 启动就绪（/health.extensions 非 null ⇒ runtime 已就绪）", !!health, health);
	if (!health) throw new Error("core 未就绪，后续判据无意义");

	/* ---------------------------------------------------- ① GET 基础 */
	const first = await getProviders();
	const firstBody = first.json ?? {};
	evidence.judgments["①GET 基础"] = { status: first.status, body: firstBody };
	const seedProviderIds = Object.keys(readModelsFile()?.providers ?? {});

	check("①GET /providers 200 且 ok=true", first.status === 200 && firstBody.ok === true, {
		status: first.status,
		ok: firstBody.ok,
	});
	check(
		`①providers 非空且与 models.json 记录数一致（${seedProviderIds.length} 条）`,
		Array.isArray(firstBody.providers) &&
			firstBody.providers.length === seedProviderIds.length &&
			seedProviderIds.every((id) => firstBody.providers.some((p) => p.id === id)),
		{ 响应: firstBody.providers?.map((p) => p.id), 文件: seedProviderIds },
	);
	check(
		"①条目字段完整（id / name / baseUrl / apiKey / api / enabled / models[]）",
		(firstBody.providers ?? []).every(
			(p) =>
				typeof p.id === "string" &&
				typeof p.name === "string" &&
				typeof p.baseUrl === "string" &&
				typeof p.apiKey === "string" &&
				typeof p.api === "string" &&
				typeof p.enabled === "boolean" &&
				Array.isArray(p.models),
		),
		firstBody.providers,
	);
	check(
		"①current 读自 settings.json 现值（预置 ark-coding/deepseek-v4-flash）",
		firstBody.current?.provider === "ark-coding" && firstBody.current?.modelId === "deepseek-v4-flash",
		firstBody.current,
	);
	check("①ready=true（runtime 已就绪）", firstBody.ready === true, firstBody.ready);

	/* --------------------------------- ② JSONC 容忍 + ③ 凭证原文保留 */
	writeModels(
		`﻿{
  // 行注释：这是给 UI 编辑器管的文件
  "providers": {
    "ark-coding": {
      "baseUrl": "https://ark.cn-beijing.volces.com/api/coding/v3", /* 块注释 */
      "api": "openai-completions",
      "apiKey": "$ARK_API_KEY",
      "models": [
        { "id": "deepseek-v4-flash" },
      ],
    },
  },
}
`,
	);
	const jsonc = await getProviders();
	const jsoncBody = jsonc.json ?? {};
	evidence.judgments["②JSONC容忍"] = { status: jsonc.status, body: jsoncBody };
	const jsoncHit = (jsoncBody.providers ?? []).find((p) => p.id === "ark-coding");
	check(
		"②JSONC 容忍：BOM + 行注释 + 块注释 + 尾逗号 ⇒ 仍解析出 ark-coding（无 error）",
		jsonc.status === 200 && !jsoncBody.error && !!jsoncHit,
		{ status: jsonc.status, error: jsoncBody.error, ids: jsoncBody.providers?.map((p) => p.id) },
	);
	check(
		"②JSONC 里的模型记录被读到（id=deepseek-v4-flash）",
		jsoncHit?.models?.some((m) => m.id === "deepseek-v4-flash"),
		jsoncHit?.models,
	);
	check(
		"③凭证原文保留：`$ARK_API_KEY` 按原文返回（文件层 credential-blind，不展开）",
		jsoncHit?.apiKey === "$ARK_API_KEY",
		jsoncHit?.apiKey,
	);

	/* ------------------------- ④ sidecar 拆分写回（启用 / 禁用各一边） */
	const putBoth = await putProviders([ARK, { ...FAKE, enabled: false }]);
	const putBothBody = putBoth.json ?? {};
	const modelsFileAfter = readModelsFile();
	const sidecarAfter = readSidecarFile();
	evidence.judgments["④sidecar拆分"] = {
		status: putBoth.status,
		body: putBothBody,
		modelsFile: modelsFileAfter,
		sidecarFile: sidecarAfter,
	};
	check("④PUT /providers 200 且 ok=true", putBoth.status === 200 && putBothBody.ok === true, {
		status: putBoth.status,
		body: putBothBody,
	});
	check(
		"④启用的 provider 写进 models.json（含 ark-coding），禁用的一个都不在里面",
		!!modelsFileAfter?.providers?.["ark-coding"] && !modelsFileAfter?.providers?.["local-echo"],
		Object.keys(modelsFileAfter?.providers ?? {}),
	);
	check(
		"④禁用的 provider 完整原文写进 sidecar models-disabled.json（含 baseUrl/apiKey）",
		sidecarAfter?.providers?.["local-echo"]?.baseUrl === FAKE.baseUrl &&
			sidecarAfter?.providers?.["local-echo"]?.apiKey === FAKE.apiKey,
		sidecarAfter?.providers ?? null,
	);
	const disabledFlag = (putBothBody.providers ?? []).find((p) => p.id === "local-echo");
	check(
		"④GET 合并结果里禁用项 enabled=false、启用项 enabled=true",
		disabledFlag?.enabled === false &&
			(putBothBody.providers ?? []).find((p) => p.id === "ark-coding")?.enabled === true,
		putBothBody.providers?.map((p) => `${p.id}:${p.enabled}`),
	);
	check(
		"⑤原子写无残留：同目录没有 `.tmp` 临时文件",
		tmpLeftovers().length === 0,
		tmpLeftovers(),
	);

	/* ----------------------------------------- ⑦ 保存后复读一致（改字段） */
	const renamed = { ...ARK, name: "ark-coding-renamed", apiKey: "$OTHER_KEY" };
	const putRenamed = await putProviders([renamed]);
	const reread = await getProviders();
	const renamedHit = (reread.json?.providers ?? []).find((p) => p.id === "ark-coding");
	evidence.judgments["⑦保存复读一致"] = {
		put: putRenamed.json,
		reread: reread.json,
		file: readModelsFile(),
	};
	check(
		"⑦保存后复读一致：改过的 name 与 apiKey 原样读回（且文件中的名字同步）",
		renamedHit?.name === "ark-coding-renamed" &&
			renamedHit?.apiKey === "$OTHER_KEY" &&
			readModelsFile()?.providers?.["ark-coding"]?.name === "ark-coding-renamed",
		{ 响应: renamedHit, 文件: readModelsFile()?.providers?.["ark-coding"] },
	);

	/* ------------------------------------------------ ⑥ 删除物理消失 */
	const putDeleted = await putProviders([ARK]); // 不再含 local-echo
	const afterDelete = readModelsFile();
	evidence.judgments["⑥删除物理消失"] = {
		modelsFile: afterDelete,
		sidecarFile: readSidecarFile(),
		providers: putDeleted.json?.providers?.map((p) => p.id),
	};
	check(
		"⑥从保存列表里移除 provider ⇒ models.json 与 sidecar 里都不再出现（真删除，不是软标记）",
		!afterDelete?.providers?.["local-echo"] && !readSidecarFile()?.providers?.["local-echo"],
		{ models: Object.keys(afterDelete?.providers ?? {}), sidecar: Object.keys(readSidecarFile()?.providers ?? {}) },
	);
	check(
		"⑥GET 也不再列出被删的 provider",
		!(putDeleted.json?.providers ?? []).some((p) => p.id === "local-echo"),
		putDeleted.json?.providers?.map((p) => p.id),
	);

	/* ----------------------------------------------------- ⑧ 回退 */
	// 当前生效 = ark-coding/deepseek-v4-flash；这次只保留 local-echo ⇒ 生效模型被删 ⇒ 应回退
	const putFallback = await putProviders([FAKE]);
	const fbBody = putFallback.json ?? {};
	const fbSettings = readSettings();
	evidence.judgments["⑧回退"] = { body: fbBody, settings: fbSettings };
	check(
		"⑧当前生效模型被删 ⇒ fallbackApplied=true 且给出 warning",
		fbBody.fallbackApplied === true && typeof fbBody.warning === "string" && fbBody.warning.length > 0,
		{ fallbackApplied: fbBody.fallbackApplied, warning: fbBody.warning },
	);
	check(
		"⑧current 回退到可用快照第一个（local-echo/echo-mini）",
		fbBody.current?.provider === "local-echo" && fbBody.current?.modelId === "echo-mini",
		fbBody.current,
	);
	check(
		"⑧settings.json 的 defaultProvider/defaultModel 被同步改写",
		fbSettings?.defaultProvider === "local-echo" && fbSettings?.defaultModel === "echo-mini",
		fbSettings,
	);

	/* ---------------------------------------------- ⑩ 目录检索 catalog */
	const catAll = await catalog("");
	const catDeepseek = await catalog("deepseek");
	evidence.judgments["⑩目录检索"] = {
		空查询: { status: catAll.status, count: catAll.json?.results?.length, sample: catAll.json?.results?.slice(0, 3) },
		deepseek: {
			status: catDeepseek.status,
			count: catDeepseek.json?.results?.length,
			first: catDeepseek.json?.results?.[0],
		},
	};
	check("⑩GET /models/catalog 200 且空查询有结果", catAll.status === 200 && (catAll.json?.results?.length ?? 0) > 0, {
		status: catAll.status,
		count: catAll.json?.results?.length,
	});
	check(
		"⑩结果上限 20 条（页码式收敛，不把 1496 条全倒给前端）",
		(catAll.json?.results?.length ?? 99) <= 20,
		catAll.json?.results?.length,
	);
	check(
		"⑩按关键词检索 deepseek：每条 id 或 name 都命中（不区分大小写）",
		(catDeepseek.json?.results?.length ?? 0) > 0 &&
			catDeepseek.json.results.every(
				(r) => r.id.toLowerCase().includes("deepseek") || (r.name ?? "").toLowerCase().includes("deepseek"),
			),
		catDeepseek.json?.results?.map((r) => r.id).slice(0, 5),
	);
	check(
		"⑩目录条目字段完整（id / name / provider / contextWindow / maxTokens / cost 四列）",
		(catDeepseek.json?.results ?? []).every(
			(r) =>
				typeof r.id === "string" &&
				typeof r.name === "string" &&
				typeof r.provider === "string" &&
				typeof r.contextWindow === "number" &&
				typeof r.maxTokens === "number" &&
				r.cost && typeof r.cost.input === "number",
		),
		catDeepseek.json?.results?.[0],
	);

	/* -------------------------------------------------- ⑪ 模型测试 */
	const unreachable = await testModel({
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "sk-none",
		api: "openai-completions",
		modelId: "echo-mini",
	});
	const missingModel = await testModel({ apiKey: "k", api: "openai-completions" });
	evidence.judgments["⑪模型测试"] = {
		不可达端点: { status: unreachable.status, body: unreachable.json },
		缺modelId: missingModel.status,
	};
	check(
		"⑪不可达端点 ⇒ 200 + ok=false + 带 error 文案（异常不冒泡成 500）",
		unreachable.status === 200 && unreachable.json?.ok === false && typeof unreachable.json?.error === "string",
		{ status: unreachable.status, body: unreachable.json },
	);
	check("⑪缺 baseUrl/modelId ⇒ 400（入参白名单式校验）", missingModel.status === 400, missingModel.status);

	// 真实最小请求（D7：max_tokens=1）：用 models.json 里唯一有凭证的那个 provider
	const realRes = await testModel({
		baseUrl: ARK.baseUrl,
		apiKey: "$ARK_API_KEY",
		api: ARK.api,
		modelId: ARK.models[0].id,
	});
	evidence.judgments["⑪模型测试"]["真实最小请求"] = { status: realRes.status, body: realRes.json };
	check(
		"⑪真实最小请求（$ARK_API_KEY 插值后连火山方舟，max_tokens=1）：ok=true 且返回 latencyMs",
		realRes.status === 200 && realRes.json?.ok === true && typeof realRes.json?.latencyMs === "number",
		{ status: realRes.status, body: realRes.json },
	);

	/* ----------------------------------------------- ⑨ 坏文件不 500 */
	writeModels("{ this is not json ,,, ");
	const badList = await getProviders();
	evidence.judgments["⑨坏文件"] = { status: badList.status, body: badList.json };
	check(
		"⑨models.json 非法 ⇒ GET 返回 200 + 结构化 {error}（绝不 500 / 不崩进程）",
		badList.status === 200 && typeof badList.json?.error === "string",
		{ status: badList.status, body: badList.json },
	);
	// 恢复成合法内容，确认服务仍在正常工作
	writeModels(JSON.stringify({ providers: { "ark-coding": ARK } }, null, 2));
	const recovered = await getProviders();
	evidence.judgments["⑨坏文件"].恢复后 = { status: recovered.status, ids: recovered.json?.providers?.map((p) => p.id) };
	check(
		"⑨修好文件后立刻恢复（core 每次读盘，不缓存坏状态）",
		recovered.status === 200 && (recovered.json?.providers ?? []).some((p) => p.id === "ark-coding"),
		recovered.json?.providers?.map((p) => p.id),
	);
	// sidecar 同理：它存着被禁用 provider 的完整原文，坏了也必须报错而不是装作空
	writeModels(JSON.stringify({ providers: { "ark-coding": ARK } }, null, 2));
	fs.writeFileSync(sidecarPath, "{ broken ,,, ", "utf8");
	const badSidecar = await getProviders();
	evidence.judgments["⑨坏文件"].sidecar坏 = { status: badSidecar.status, body: badSidecar.json };
	check(
		"⑨sidecar（models-disabled.json）非法 ⇒ 同样返回结构化 {error}，不静默丢掉禁用清单",
		badSidecar.status === 200 &&
			typeof badSidecar.json?.error === "string" &&
			badSidecar.json.error.includes("models-disabled.json"),
		{ status: badSidecar.status, body: badSidecar.json },
	);
	fs.rmSync(sidecarPath, { force: true });
	const sidecarCleared = await getProviders();
	check(
		"⑨sidecar 缺失（从未禁用过任何 provider 时的正常态）⇒ 不影响读取，仍返回启用清单",
		sidecarCleared.status === 200 &&
			(sidecarCleared.json?.providers ?? []).some((p) => p.id === "ark-coding"),
		sidecarCleared.json?.providers?.map((p) => p.id),
	);

	/* ------------------------- ⑬ JSONC 字符串内容不被去尾逗号误伤 + ⑭ 非契约字段保留 */
	const NAME_WITH_COMMA = "A, } B";
	const MODEL_NAME_WITH_COMMA = "m,] n";
	writeModels(`{
  "providers": {
    "ark-coding": {
      "name": "${NAME_WITH_COMMA}",
      "baseUrl": "${ARK.baseUrl}",
      "apiKey": "$ARK_API_KEY",
      "api": "openai-completions",
      "models": [
        { "id": "deepseek-v4-flash", "name": "${MODEL_NAME_WITH_COMMA}", },
      ],
    },
  },
}
`);
	const commaGet = await getProviders();
	const commaHit = (commaGet.json?.providers ?? []).find((p) => p.id === "ark-coding");
	evidence.judgments["⑬字符串内逗号"] = { status: commaGet.status, body: commaGet.json };
	check(
		"⑬JSONC 字符串值里的 `, }` 不被去尾逗号误伤（provider.name 原样读回）",
		commaGet.status === 200 && !commaGet.json?.error && commaHit?.name === NAME_WITH_COMMA,
		{ name: commaHit?.name, error: commaGet.json?.error },
	);
	check(
		"⑬model.name 里的 `,]` 同理（字符串内部是数据，不是语法）",
		commaHit?.models?.[0]?.name === MODEL_NAME_WITH_COMMA,
		commaHit?.models?.[0]?.name,
	);

	const EXTRA_PROVIDER = { customExtra: { keep: true, nested: { n: 1 } } };
	const EXTRA_MODEL = { internalNote: "do-not-drop", legacyFlags: [1, 2] };
	writeModels(
		JSON.stringify(
			{
				providers: {
					"ark-coding": {
						name: "ark-coding",
						baseUrl: ARK.baseUrl,
						apiKey: "$ARK_API_KEY",
						api: "openai-completions",
						headers: {},
						...EXTRA_PROVIDER,
						models: [{ ...ARK.models[0], ...EXTRA_MODEL }],
					},
				},
			},
			null,
			2,
		),
	);
	// 模拟 UI 形状的保存请求：只含契约字段（UI 表达不了 extra），只改契约字段 name
	const putExtras = await putProviders([{ ...ARK, name: "ark-coding-with-extras" }]);
	const fileAfterExtras = readModelsFile()?.providers?.["ark-coding"];
	evidence.judgments["⑭非契约字段保留"] = {
		put: putExtras.json,
		file: fileAfterExtras,
	};
	check(
		"⑭PUT 200 且 ok=true（带额外字段的文件可正常解析保存）",
		putExtras.status === 200 && putExtras.json?.ok === true,
		{ status: putExtras.status, error: putExtras.json?.error },
	);
	check(
		"⑭provider 级非契约字段保存后原样保留（customExtra 深度不变）",
		JSON.stringify(fileAfterExtras?.customExtra) === JSON.stringify(EXTRA_PROVIDER.customExtra),
		{ 期望: EXTRA_PROVIDER.customExtra, 实际: fileAfterExtras?.customExtra ?? null },
	);
	check(
		"⑭model 级非契约字段按 id 对位保留（internalNote / legacyFlags）",
		fileAfterExtras?.models?.[0]?.internalNote === EXTRA_MODEL.internalNote &&
			JSON.stringify(fileAfterExtras?.models?.[0]?.legacyFlags) === JSON.stringify(EXTRA_MODEL.legacyFlags),
		{ 实际: fileAfterExtras?.models?.[0] ?? null },
	);
	check(
		"⑭契约字段仍以请求为准（name 已改、model 规格字段未被 extra 合并污染）",
		fileAfterExtras?.name === "ark-coding-with-extras" &&
			fileAfterExtras?.models?.[0]?.contextWindow === ARK.models[0].contextWindow &&
			fileAfterExtras?.models?.[0]?.maxTokens === ARK.models[0].maxTokens,
		{ name: fileAfterExtras?.name, model: fileAfterExtras?.models?.[0] },
	);
	const extrasReread = await getProviders();
	check(
		"⑭保存后 GET 仍正常（extra 不进契约响应，但解析不炸）",
		extrasReread.status === 200 &&
			(extrasReread.json?.providers ?? []).some((p) => p.id === "ark-coding"),
		extrasReread.json?.providers?.map((p) => p.id),
	);

	/* --------------------------------------------- ⑫ 安全三件套 */
	const noToken = await getProviders({ token: "" });
	const badHostGet = await request("GET", "/providers", undefined, { host: `evil.example.com:${PORT}` });
	const badHostPut = await request("PUT", "/providers", { providers: [] }, { host: `evil.example.com:${PORT}` });
	const noArray = await request("PUT", "/providers", { nope: true });
	evidence.judgments["⑫安全"] = {
		无token: noToken.status,
		错Host_GET: badHostGet.status,
		错Host_PUT: badHostPut.status,
		缺数组: noArray.status,
	};
	check("⑫无 token ⇒ 401", noToken.status === 401, noToken.status);
	check(
		"⑫错 Host ⇒ 403（防 DNS rebinding，GET 与 PUT 各一）",
		badHostGet.status === 403 && badHostPut.status === 403,
		evidence.judgments["⑫安全"],
	);
	check("⑫PUT 缺 providers 数组 ⇒ 400", noArray.status === 400, noArray.status);

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
	console.error("[providers] 脚本异常:", e && e.stack ? e.stack : e);
	evidence.error = String(e);
	evidence.checks = checks;
	evidence.summary = {
		assertions: checks.length,
		passed: checks.filter((c) => c.pass).length,
		failed: checks.filter((c) => !c.pass).length,
	};
	try {
		fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
	} catch {
		/* 忽略 */
	}
	exitCode = 1;
} finally {
	if (core) await core.close();
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		/* 忽略 */
	}
}

console.log(
	exitCode === 0
		? "\n第二批 core 侧（providers）检查全部通过"
		: `\n第二批 core 侧检查失败 ${checks.filter((c) => !c.pass).length} 项：\n - ${checks
				.filter((c) => !c.pass)
				.map((c) => c.name)
				.join("\n - ")}`,
);
process.exit(exitCode);
