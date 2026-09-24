/**
 * 第二批（C2）模型接真 —— UI 草稿类型 ⇄ core 契约类型 转换层。
 *
 * 左侧 `ModelProviderConfig` / `ModelConfig`（mock/model-config.ts，UI 编辑态，字段含
 * `imageInput` 布尔、`cost`、`advanced` 等）与右侧 `ProviderEntry` / `ProviderModelEntry`
 * （core 契约，对齐 models.json 原生 schema：`input` 数组、`cost`、`compat`、
 * `endpointOverride`）之间的互转。
 *
 * 该层是 live 形态下「读 GET /providers → 编辑 → PUT /providers」的桥；mock 形态不触碰。
 */

import type {
	ModelApiType,
	ModelConfig,
	ModelHeader,
	ModelProviderConfig,
} from "@/mock/model-config";
import type {
	CatalogEntry,
	ProviderEntry,
	ProviderModelEntry,
	ProvidersPayload,
	PutProvidersRequest,
} from "@/mock/provider-contract";

/* ---------------------------------------------------------------------------
 * Headers：ModelHeader[] ⇄ Record<string,string>
 * ------------------------------------------------------------------------- */

export function headersToRecord(headers: ModelHeader[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const h of headers) if (h.name.trim()) out[h.name] = h.value;
	return out;
}

function recordToHeaders(rec?: Record<string, string>): ModelHeader[] {
	if (!rec) return [];
	return Object.entries(rec).map(([name, value], i) => ({ key: `h-${i}`, name, value }));
}

/* ---------------------------------------------------------------------------
 * Model：ModelConfig ⇄ ProviderModelEntry
 * ------------------------------------------------------------------------- */

/**
 * 空串 / 纯空白 ⇒ **省略该键**（返回 undefined 供条件展开用）。
 *
 * 依据 Pi 的 models.json 原生 schema（`provider-composer` / `model-config` 的
 * TypeBox 定义）：`name` / `baseUrl` / `apiKey` / `api` 都是
 * `Type.Optional(Type.String({ minLength: 1 }))` —— **可选，但只要出现就必须 ≥1 字符**。
 *
 * 所以写空串不是「没填」，而是**非法值**，而且代价是**整份文件**校验失败：
 * Pi 的 `ModelConfig.load` 一旦校验不过就返回空 Map，于是**所有** Provider 一起从
 * 可用集合里消失（2026-09-24 实踩：新增模型未填「名称」，导致已配好的 Provider 全没了，
 * 而 UI 状态条还显示「保存成功」）。
 */
function nonEmpty(v: string | undefined): string | undefined {
	return typeof v === "string" && v.trim() ? v : undefined;
}

function modelToEntry(m: ModelConfig): ProviderModelEntry {
	return {
		id: m.id,
		// name 可选：留空时省略，让 Pi 回落到 id（写 "" 会让整份文件非法）
		...(nonEmpty(m.name) ? { name: m.name } : {}),
		reasoning: m.reasoning,
		input: m.imageInput ? ["text", "image"] : ["text"],
		/*
		 * 0 = 表单未填 ⇒ **省略字段**，交给 Pi 的默认值（contextWindow 128000 / maxTokens 16384）。
		 *
		 * 不能原样传 0：Pi 的 `modelFromJson` 对 `<= 0` 直接 throw
		 * （`invalid contextWindow` / `invalid maxTokens`），且它的默认值只在字段**缺省**时生效。
		 * 一旦 throw，该 Provider 会被从可用集合里摘掉 —— 表现是「保存成功、状态条还是绿的，
		 * 但模型列表空了、也不会自动选型」，用户完全无从自查。
		 */
		...(m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
		...(m.maxTokens > 0 ? { maxTokens: m.maxTokens } : {}),
		cost: { ...m.cost },
		...(m.advanced.headers.length ? { headers: headersToRecord(m.advanced.headers) } : {}),
		...(m.advanced.compatibility ? { compat: m.advanced.compatibility } : {}),
		...(m.advanced.endpointOverride ? { endpointOverride: m.advanced.endpointOverride } : {}),
	};
}

function entryToModel(e: ProviderModelEntry): ModelConfig {
	return {
		id: e.id,
		// 缺省（Pi 会回落到 id）→ 表单显示为空 = 「未填」，与 modelToEntry 省略空串的语义闭环
		name: e.name ?? "",
		reasoning: e.reasoning,
		imageInput: Array.isArray(e.input) && e.input.includes("image"),
		contextWindow: e.contextWindow ?? 0,
		maxTokens: e.maxTokens ?? 0,
		cost: {
			input: e.cost?.input ?? 0,
			output: e.cost?.output ?? 0,
			cacheRead: e.cost?.cacheRead ?? 0,
			cacheWrite: e.cost?.cacheWrite ?? 0,
		},
		advanced: {
			endpointOverride: e.endpointOverride ?? "",
			compatibility: e.compat ?? "",
			headers: recordToHeaders(e.headers),
		},
	};
}

/* ---------------------------------------------------------------------------
 * Provider：ModelProviderConfig ⇄ ProviderEntry
 * ------------------------------------------------------------------------- */

export function providersToEntries(draft: ModelProviderConfig[]): ProviderEntry[] {
	return draft.map((p) => ({
		id: p.id,
		// 同 modelToEntry：这些字段 optional 但 minLength 1，空串会让**整份文件**校验失败
		...(nonEmpty(p.name) ? { name: p.name } : {}),
		...(nonEmpty(p.baseUrl) ? { baseUrl: p.baseUrl } : {}),
		...(nonEmpty(p.apiKey) ? { apiKey: p.apiKey } : {}),
		...(nonEmpty(p.api) ? { api: p.api } : {}),
		headers: headersToRecord(p.headers),
		enabled: p.enabled,
		/*
		 * `model.id` 是 schema 里**唯一必填**的字段（`Type.String({ minLength: 1 })`），
		 * 空 id 的模型行是「待配置」占位（左栏显示「待配置」徽标），尚未成为真实模型 ——
		 * 发出去必然让整份文件非法，故这里不发（用户补上 id 后即随下一次保存落盘）。
		 */
		models: p.models.filter((m) => nonEmpty(m.id)).map(modelToEntry),
	}));
}

export function entriesToProviders(payload: ProvidersPayload): ModelProviderConfig[] {
	return payload.providers.map((e) => ({
		id: e.id,
		// 缺省 = 未填，回落到空串（表单语义）；core 侧读回时已按 id / 默认值兜过底
		name: e.name ?? "",
		baseUrl: e.baseUrl ?? "",
		apiKey: e.apiKey ?? "",
		api: (e.api as ModelApiType) || "openai-completions",
		headers: recordToHeaders(e.headers),
		enabled: e.enabled,
		models: e.models.map(entryToModel),
	}));
}

export function buildPutRequest(draft: ModelProviderConfig[]): PutProvidersRequest {
	return { providers: providersToEntries(draft) };
}

/* ---------------------------------------------------------------------------
 * 目录条目 → 模型表单字段（「填入模型信息」回填）
 * ------------------------------------------------------------------------- */

export function catalogToModelFields(c: CatalogEntry): Partial<ModelConfig> {
	return {
		id: c.id,
		name: c.name && c.name !== c.id ? c.name : c.id,
		reasoning: c.reasoning,
		imageInput: Array.isArray(c.input) && c.input.includes("image"),
		contextWindow: c.contextWindow ?? 0,
		maxTokens: c.maxTokens ?? 0,
		cost: {
			input: c.cost?.input ?? 0,
			output: c.cost?.output ?? 0,
			cacheRead: c.cost?.cacheRead ?? 0,
			cacheWrite: c.cost?.cacheWrite ?? 0,
		},
	};
}
