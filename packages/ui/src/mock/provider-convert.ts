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

function modelToEntry(m: ModelConfig): ProviderModelEntry {
	return {
		id: m.id,
		name: m.name,
		reasoning: m.reasoning,
		input: m.imageInput ? ["text", "image"] : ["text"],
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		cost: { ...m.cost },
		...(m.advanced.headers.length ? { headers: headersToRecord(m.advanced.headers) } : {}),
		...(m.advanced.compatibility ? { compat: m.advanced.compatibility } : {}),
		...(m.advanced.endpointOverride ? { endpointOverride: m.advanced.endpointOverride } : {}),
	};
}

function entryToModel(e: ProviderModelEntry): ModelConfig {
	return {
		id: e.id,
		name: e.name,
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
		name: p.name,
		baseUrl: p.baseUrl,
		apiKey: p.apiKey,
		api: p.api,
		headers: headersToRecord(p.headers),
		enabled: p.enabled,
		models: p.models.map(modelToEntry),
	}));
}

export function entriesToProviders(payload: ProvidersPayload): ModelProviderConfig[] {
	return payload.providers.map((e) => ({
		id: e.id,
		name: e.name,
		baseUrl: e.baseUrl,
		apiKey: e.apiKey,
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
