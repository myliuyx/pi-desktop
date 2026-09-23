/**
 * C2 · 第二批：模型接真 —— Provider 读写 models.json + sidecar、目录检索、模型测试。
 *
 * ## 设计要点（见 .plan/task-settings-c2.md）
 *
 * 1. **models.json 是 JSONC**：注释 / BOM / 尾逗号容忍（解析用 `parseJsonc`，写回用标准 JSON）。
 * 2. **侧栏 = sidecar（D9）**：Pi 无 per-provider 禁用概念。
 *    - 启用 provider → 写入 models.json 的 `providers` Record（Pi 眼中这才存在）；
 *    - 禁用 provider → 从 models.json 物理移除，完整配置原文写入同目录
 *      `models-disabled.json`（我们独有不涉及 Pi）；
 *    - `GET /providers` = 两文件合并，条目带 `enabled` 标志。
 * 3. **写回热载（S1）**：`PUT /providers` 后调 `modelRuntime.refresh({ allowNetwork: false })`
 *    重建 provider 组合，运行中的会话即时感知（无需重建会话，回归测试 6999 实证）。
 * 4. **回退（S1 边界）**：若 `settings.json` 当前生效模型被删，refresh 后从可用快照
 *    回退到第一个并写回 `settings.json`（复用 settings 既有字段写回路径），响应带 `fallbackApplied`。
 * 5. **凭证层语义（S2）**：apiKey 存原文即可（文件层 credential-blind，零展开风险）；
 *    `GET /providers` 按 D6 原文返回、不脱敏；`POST /models/test` 时才按 `!`/`$ENV` 解析以真正连测。
 * 6. **目录（catalog）**：`modelRuntime.getModels()` 内置目录（本机约 1496 条，不出网），
 *    按 id/name 不区分大小写匹配，上限 20 条，返回元数据供「填入模型信息」。
 * 7. **测试（D7）**：用请求体里的 provider/model 配置构造一次性最小请求（max_tokens:1），
 *    返回 ok/latency/error；**不落盘、不改当前选择**。
 *
 * 安全面：本模块只负责数据与协议；Bearer 401 / Host 403 由 server.ts 中间件统一覆盖。
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";import type {
	CatalogEntry,
	CatalogPayload,
	ModelTestRequest,
	ModelTestResult,
	ProvidersPayload,
	ProviderEntry,
	ProviderModelEntry,
	ProvidersSaveResult,
	PutProvidersRequest,
} from "./contract.ts";

/* ---------------------------------------------------------------------------
 * 依赖（与 models.ts 同构：全部惰性 getter，避免持有未就绪的 Pi 对象）
 * ------------------------------------------------------------------------- */

export interface ProvidersControllerDeps {
	/** 解析到的 models.json 绝对路径（CORE_MODELS_PATH 或 agentDir 内默认）；未解析为 null */
	getModelsPath(): string | null;
	/** 同目录 sidecar（禁用 provider 完整配置原文）路径；未解析 models 路径时为 null */
	getSidecarPath(): string | null;
	/** agentDir（settings.json 所在目录；仅在「可用清单为空需清空默认模型」时直写文件） */
	agentDir: string;
	/** Pi 的 ModelRuntime（GET /providers 之外的 catalog/test 与 refresh 需要；未就绪为 null） */
	getRuntime(): ModelRuntime | null;
	/**
	 * 回退当前生效模型 —— **复用既有 setModel 写 settings 路径**
	 * （`session.setModel(model, { persist: true })` ⇒ `settingsManager.setDefaultModelAndProvider`，
	 * 与 `POST /models/select` 完全同一条路）。会话 / 运行时未就绪或模型解析不到时返回 false。
	 */
	selectCurrent(provider: string, modelId: string): Promise<boolean>;
}

/* ---------------------------------------------------------------------------
 * JSONC 解析（注释 / BOM / 尾逗号容忍）
 * ------------------------------------------------------------------------- */

/**
 * 解析 JSONC 为 JS 值。支持：UTF-8 BOM 剥离、`//` 行注释、`/* *\/` 块注释、
 * 对象/数组字面量后的尾逗号。字符串内的注释/逗号字符不做处理（扫描器跳过字符串）。
 * 解析失败抛 Error（server 层捕获后返回结构化 `{ error }`，不 500）。
 */
export function parseJsonc(text: string): unknown {
	let src = text;
	if (src.charCodeAt(0) === 0xfeff) src = src.slice(1); // 去 BOM

	let out = "";
	let i = 0;
	let inString = false;
	let inLine = false;
	let inBlock = false;
	while (i < src.length) {
		const ch = src[i];
		const next = src[i + 1];
		if (inLine) {
			if (ch === "\n") {
				inLine = false;
				out += ch;
			}
			i++;
			continue;
		}
		if (inBlock) {
			if (ch === "*" && next === "/") {
				inBlock = false;
				i += 2;
			} else {
				i++;
			}
			continue;
		}
		if (inString) {
			out += ch;
			if (ch === "\\" && next !== undefined) {
				out += next;
				i += 2;
				continue;
			}
			if (ch === '"') inString = false;
			i++;
			continue;
		}
		// 不在字符串内
		if (ch === '"') {
			inString = true;
			out += ch;
			i++;
			continue;
		}
		if (ch === "/" && next === "/") {
			inLine = true;
			i += 2;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlock = true;
			i += 2;
			continue;
		}
		out += ch;
		i++;
	}
	// 去尾逗号：`,` 后仅空白再接 `}` 或 `]`
	out = out.replace(/,(\s*[}\]])/g, "$1");
	return JSON.parse(out);
}

/* ---------------------------------------------------------------------------
 * 原子写（临时文件 + rename，路径锁在同目录不越界）
 * ------------------------------------------------------------------------- */

function writeJsonAtomic(filePath: string, data: unknown): void {
	const dir = path.dirname(filePath);
	const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
	fs.renameSync(tmp, filePath);
}

/* ---------------------------------------------------------------------------
 * settings.json 当前生效模型读写（仅 defaultProvider / defaultModel 既有字段）
 * ------------------------------------------------------------------------- */

interface SettingsShape {
	defaultProvider?: string;
	defaultModel?: string;
	[key: string]: unknown;
}

function readSettings(agentDir: string): SettingsShape {
	const p = path.join(agentDir, "settings.json");
	try {
		const raw = fs.readFileSync(p, "utf8");
		const parsed = parseJsonc(raw);
		if (parsed && typeof parsed === "object") return parsed as SettingsShape;
	} catch {
		/* 无文件或坏文件 → 空对象 */
	}
	return {};
}

function setDefaultModel(agentDir: string, provider: string, modelId: string): void {
	const p = path.join(agentDir, "settings.json");
	const settings = readSettings(agentDir);
	if (provider && modelId) {
		settings.defaultProvider = provider;
		settings.defaultModel = modelId;
	} else {
		delete settings.defaultProvider;
		delete settings.defaultModel;
	}
	writeJsonAtomic(p, settings);
}

/* ---------------------------------------------------------------------------
 * 原生 models.json 记录 ⇄ ProviderEntry 互转
 * ------------------------------------------------------------------------- */

type NativeProviderRecord = Record<string, unknown>;
type NativeModelRecord = Record<string, unknown>;

function asString(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : fallback;
}
function asNumber(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function asBool(v: unknown): boolean {
	return v === true;
}
function asRecord(v: unknown): Record<string, string> {
	if (v && typeof v === "object" && !Array.isArray(v)) {
		const out: Record<string, string> = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			if (typeof val === "string") out[k] = val;
		}
		return out;
	}
	return {};
}

/** 原生 model 记录 → UI/契约用的 ProviderModelEntry（字段名对齐原生 schema：cost / input 数组） */
function nativeModelToEntry(rec: NativeModelRecord): ProviderModelEntry {
	const cost = (rec.cost ?? {}) as Record<string, unknown>;
	const input = Array.isArray(rec.input)
		? (rec.input.filter((x) => x === "text" || x === "image") as ("text" | "image")[])
		: [];
	return {
		id: asString(rec.id),
		name: asString(rec.name),
		reasoning: asBool(rec.reasoning),
		input: input.length ? input : ["text"],
		contextWindow: asNumber(rec.contextWindow),
		maxTokens: asNumber(rec.maxTokens),
		cost: {
			input: asNumber(cost.input),
			output: asNumber(cost.output),
			cacheRead: asNumber(cost.cacheRead),
			cacheWrite: asNumber(cost.cacheWrite),
		},
		...(Object.keys(asRecord(rec.headers)).length ? { headers: asRecord(rec.headers) } : {}),
		...(asString(rec.compat) ? { compat: asString(rec.compat) } : {}),
		...(asString(rec.endpointOverride) ? { endpointOverride: asString(rec.endpointOverride) } : {}),
	};
}

/** ProviderEntry → 原生 provider 记录（剔除 id/enabled；保留全部 model 原生字段） */
function entryToNativeProvider(p: ProviderEntry): NativeProviderRecord {
	return {
		name: p.name,
		baseUrl: p.baseUrl,
		apiKey: p.apiKey,
		api: p.api,
		headers: p.headers,
		models: p.models.map((m) => {
			const rec: NativeModelRecord = {
				id: m.id,
				name: m.name,
				reasoning: m.reasoning,
				input: m.input,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				cost: m.cost,
			};
			if (m.headers && Object.keys(m.headers).length) rec.headers = m.headers;
			if (m.compat) rec.compat = m.compat;
			if (m.endpointOverride) rec.endpointOverride = m.endpointOverride;
			return rec;
		}),
	};
}

/** 读取并合并 models.json + sidecar → ProviderEntry[] */
/**
 * ⚠️ 解析失败必须**抛出**，不能静默当空清单：
 * 「读不到 / 读不懂」与「清单确实是空的」是两回事。若把坏文件当成空清单返回，
 * UI 会显示「没有 Provider」，用户一点保存就把还躺在磁盘上的旧配置整份覆盖掉。
 * 据此 server 层把它转成结构化 `{ error }`（200 + error，不是 500），UI 回落 mock 并提示。
 */
function readMergedProviders(
	modelsPath: string | null,
	sidecarPath: string | null,
): ProviderEntry[] {
	const readRecordMap = (
		p: string | null,
		label: string,
		required: boolean,
	): Record<string, NativeProviderRecord> => {
		if (!p) {
			if (required) throw new Error(`未找到 ${label}（无法读取）`);
			return {};
		}
		let raw: string;
		try {
			raw = fs.readFileSync(p, "utf8");
		} catch (e) {
			if (required) throw new Error(`读取 ${label} 失败：${e instanceof Error ? e.message : String(e)}`);
			return {};
		}
		let parsed: unknown;
		try {
			parsed = parseJsonc(raw);
		} catch (e) {
			throw new Error(
				`${label} 解析失败（JSON / JSONC 语法错误，请检查文件内容）：${
					e instanceof Error ? e.message : String(e)
				}`,
			);
		}
		if (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).providers) {
			const providers = (parsed as { providers: unknown }).providers;
			if (providers && typeof providers === "object") {
				return providers as Record<string, NativeProviderRecord>;
			}
		}
		return {};
	};

	const enabled = readRecordMap(modelsPath, "models.json", true);
	const disabled = readRecordMap(sidecarPath, "models-disabled.json", false);
	const entries: ProviderEntry[] = [];

	for (const [id, rec] of Object.entries(enabled)) {
		entries.push({ id, enabled: true, ...nativeProviderToEntry(id, rec) });
	}
	for (const [id, rec] of Object.entries(disabled)) {
		if (id in enabled) continue; // 启用优先
		entries.push({ id, enabled: false, ...nativeProviderToEntry(id, rec) });
	}
	return entries;
}

function nativeProviderToEntry(id: string, rec: NativeProviderRecord): Omit<ProviderEntry, "id" | "enabled"> {
	const models = Array.isArray(rec.models) ? (rec.models as NativeModelRecord[]) : [];
	return {
		name: asString(rec.name, id),
		baseUrl: asString(rec.baseUrl),
		apiKey: asString(rec.apiKey),
		api: asString(rec.api, "openai-completions"),
		headers: asRecord(rec.headers),
		models: models.map(nativeModelToEntry),
	};
}

/* ---------------------------------------------------------------------------
 * 目录检索（catalog）
 * ------------------------------------------------------------------------- */

function modelToCatalogEntry(m: {
	id: string;
	name?: string;
	provider: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}): CatalogEntry {
	return {
		id: m.id,
		name: typeof m.name === "string" && m.name.trim() ? m.name : m.id,
		provider: m.provider,
		reasoning: m.reasoning === true,
		input: Array.isArray(m.input)
			? (m.input.filter((x) => x === "text" || x === "image") as ("text" | "image")[])
			: ["text"],
		contextWindow: asNumber(m.contextWindow),
		maxTokens: asNumber(m.maxTokens),
		cost: {
			input: asNumber(m.cost?.input),
			output: asNumber(m.cost?.output),
			cacheRead: asNumber(m.cost?.cacheRead),
			cacheWrite: asNumber(m.cost?.cacheWrite),
		},
	};
}

/* ---------------------------------------------------------------------------
 * 模型测试（一次性最小真实请求）
 * ------------------------------------------------------------------------- */

/** 解析 `!` / `$ENV` 插值（S2：凭证层语义，仅测试时按需解析，不落盘） */
function resolveCredential(raw: string): string {
	if (!raw) return raw;
		if (raw.startsWith("!")) {
			try {
				const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
				return execSync(raw.slice(1), { shell, timeout: 8000, encoding: "utf8" }).trim();
			} catch {
				return raw; // 解析失败则原样返回（测试结果自然反映鉴权失败）
			}
		}
	if (raw.startsWith("$")) {
		return raw.replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a, b) => process.env[a ?? b] ?? "");
	}
	return raw;
}

function buildTestEndpoint(baseUrl: string, api: string): string | null {
	const base = (baseUrl || "").replace(/\/+$/, "");
	if (!base) return null;
	if (api === "openai-responses") return `${base}/responses`;
	if (api === "anthropic-messages") return `${base}/messages`;
	// 默认 openai-completions
	return `${base}/chat/completions`;
}

function buildTestHeaders(req: ModelTestRequest): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	for (const [k, v] of Object.entries(req.headers ?? {})) headers[k] = v;
	const key = resolveCredential(req.apiKey);
	if (key) {
		if (req.api === "anthropic-messages") headers["x-api-key"] = key;
		else headers["Authorization"] = `Bearer ${key}`;
	}
	if (req.api === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
	return headers;
}

function buildTestBody(api: string, modelId: string): unknown {
	const model = modelId || "test";
	if (api === "openai-responses") {
		return { model, input: "hi", max_output_tokens: 1 };
	}
	if (api === "anthropic-messages") {
		return { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] };
	}
	return { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 };
}

/* ---------------------------------------------------------------------------
 * 控制器
 * ------------------------------------------------------------------------- */

export interface ProvidersController {
	/** `GET /providers`：读取并合并 models.json + sidecar；解析失败抛 Error（server 转 {error}） */
	list(): ProvidersPayload;
	/** `PUT /providers`：按 enabled 拆分原子写、refresh、回退检测 */
	save(req: PutProvidersRequest): Promise<ProvidersSaveResult>;
	/** `GET /models/catalog?q=`：内置目录检索（不出网） */
	catalog(query: string): CatalogPayload;
	/** `POST /models/test`：一次性最小真实请求（不落盘、不改当前选择） */
	test(req: ModelTestRequest): Promise<ModelTestResult>;
}

export function createProvidersController(deps: ProvidersControllerDeps): ProvidersController {
	const readCurrent = (): { provider: string; modelId: string } | null => {
		const s = readSettings(deps.agentDir);
		if (s.defaultProvider && s.defaultModel) {
			return { provider: s.defaultProvider, modelId: s.defaultModel };
		}
		return null;
	};

	const list = (): ProvidersPayload => {
		const modelsPath = deps.getModelsPath();
		if (!modelsPath) throw new Error("未解析到 models.json（CORE_MODELS_PATH 未设置或 agentDir 内不存在）");
		const entries = readMergedProviders(modelsPath, deps.getSidecarPath());
		return {
			providers: entries,
			current: readCurrent(),
			ready: deps.getRuntime() !== null,
		};
	};

	const save = async (req: PutProvidersRequest): Promise<ProvidersSaveResult> => {
		const modelsPath = deps.getModelsPath();
		const sidecarPath = deps.getSidecarPath();
		if (!modelsPath || !sidecarPath) {
			throw new Error("未解析到 models.json（无法写入）");
		}
		if (!Array.isArray(req.providers)) throw new Error("请求体缺少 providers 数组");

		const enabled: Record<string, NativeProviderRecord> = {};
		const disabled: Record<string, NativeProviderRecord> = {};
		for (const p of req.providers) {
			const rec = entryToNativeProvider(p);
			if (p.enabled) enabled[p.id] = rec;
			else disabled[p.id] = rec;
		}

		// 原子写（临时文件 + rename）；两文件都重写
		writeJsonAtomic(modelsPath, { providers: enabled });
		writeJsonAtomic(sidecarPath, { providers: disabled });

		// S1：热重载，重建 provider 组合（无需重建会话）
		await deps.getRuntime()?.refresh({ allowNetwork: false });

		// S1 边界：当前生效模型被删 → 回退到可用清单第一个。
		// runtime 未就绪时快照不可信（空数组 ≠ 全被删），跳过回退检测。
		const before = readCurrent();
		const runtime = deps.getRuntime();
		const snapshot = runtime?.getAvailableSnapshot() ?? [];
		let current = before;
		let fallbackApplied = false;
		let warning: string | undefined;

		if (before && runtime) {
			const stillThere = snapshot.some(
				(m) => m.provider === before.provider && m.id === before.modelId,
			);
			if (!stillThere) {
				if (snapshot.length > 0) {
					const first = snapshot[0];
					// 复用既有 setModel 写 settings 路径（persist:true ⇒ settingsManager 写回既有字段）
					const applied = await deps.selectCurrent(first.provider, first.id);
					if (applied) {
						current = { provider: first.provider, modelId: first.id };
						fallbackApplied = true;
						warning = `当前生效模型 ${before.provider}/${before.modelId} 已被删除，已回退到 ${first.provider}/${first.id}（新会话生效）`;
					} else {
						warning = `当前生效模型 ${before.provider}/${before.modelId} 已被删除，自动回退失败，请手动选择模型`;
					}
				} else {
					// 可用清单为空：Pi 的 setModel 无法表达「无模型」，只能直写 settings 清掉既有字段
					setDefaultModel(deps.agentDir, "", "");
					current = null;
					fallbackApplied = true;
					warning = `当前生效模型 ${before.provider}/${before.modelId} 已被删除，且无任何可用模型，请先添加并启用一个 Provider`;
				}
			}
		}

		const providers = readMergedProviders(modelsPath, sidecarPath);
		return {
			providers,
			current,
			ready: deps.getRuntime() !== null,
			fallbackApplied,
			warning,
		};
	};

	const catalog = (query: string): CatalogPayload => {
		const runtime = deps.getRuntime();
		if (!runtime) return { query, results: [] };
		const needle = query.trim().toLowerCase();
		const results: CatalogEntry[] = [];
		const all = runtime.getModels();
		for (const m of all) {
			if (
				!needle ||
				m.id.toLowerCase().includes(needle) ||
				(m.name && m.name.toLowerCase().includes(needle))
			) {
				results.push(modelToCatalogEntry(m));
				if (results.length >= 20) break;
			}
		}
		return { query, results };
	};

	const test = async (req: ModelTestRequest): Promise<ModelTestResult> => {
		const start = Date.now();
		const endpoint = buildTestEndpoint(req.baseUrl, req.api);
		if (!endpoint) {
			return { ok: false, latencyMs: Date.now() - start, error: "缺少有效的 Base URL" };
		}
		try {
			const res = await fetch(endpoint, {
				method: "POST",
				headers: buildTestHeaders(req),
				body: JSON.stringify(buildTestBody(req.api, req.modelId)),
				// D7：最小请求，长超时也无妨；给一个合理上限避免挂死
				signal: AbortSignal.timeout(20000),
			});
			const latencyMs = Date.now() - start;
			if (!res.ok) {
				return { ok: false, latencyMs, error: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}` };
			}
			return { ok: true, latencyMs };
		} catch (e) {
			return { ok: false, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
		}
	};

	return { list, save, catalog, test };
}
