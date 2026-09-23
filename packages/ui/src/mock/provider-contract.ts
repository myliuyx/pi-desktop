/**
 * 第二批（C2）模型接真 —— UI 侧契约类型（core `contract.ts` 中同名类型的「UI 副本」）。
 *
 * 纪律：core 的 `contract.ts` 是权威源（纯类型零 import），本文件是其 UI 侧镜像，
 * 两者手动保持同步。之所以不复用 core 文件，是因为 `mock/types.ts` 是 M2 冻结契约
 * （禁止改动），而本项目 UI 一贯在本包内维护契约副本（见 `agent-transport.ts` 从
 * `@/mock/types` 取 `ModelsPayload` 的同样做法）。
 *
 * 字段名对齐 models.json 原生 schema（cost 而非 pricing；input 用 ["text","image"] 数组）。
 */

/** 单个模型（对齐 Pi models.json 的 model 节点原生 schema） */
export interface ProviderModelEntry {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	headers?: Record<string, string>;
	compat?: string;
	/** 高级：API 端点覆盖（UI 表单高级字段，原样透传） */
	endpointOverride?: string;
}

/** 一个 Provider（GET /providers 与 PUT /providers 共用形状） */
export interface ProviderEntry {
	id: string;
	name: string;
	baseUrl: string;
	/** API key 原文（D6：不脱敏） */
	apiKey: string;
	api: string;
	headers: Record<string, string>;
	enabled: boolean;
	models: ProviderModelEntry[];
}

/** GET /providers 响应体 */
export interface ProvidersPayload {
	providers: ProviderEntry[];
	current: { provider: string; modelId: string } | null;
	ready: boolean;
}

/** PUT /providers 请求体 */
export interface PutProvidersRequest {
	providers: ProviderEntry[];
}

/** PUT /providers 响应体（含回退标记） */
export interface ProvidersSaveResult {
	providers: ProviderEntry[];
	current: { provider: string; modelId: string } | null;
	ready: boolean;
	fallbackApplied: boolean;
	warning?: string;
}

/** GET /models/catalog?q= 单条目录结果 */
export interface CatalogEntry {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** GET /models/catalog?q= 响应体 */
export interface CatalogPayload {
	query: string;
	results: CatalogEntry[];
}

/** POST /models/test 请求体 */
export interface ModelTestRequest {
	baseUrl: string;
	apiKey: string;
	api: string;
	headers?: Record<string, string>;
	modelId: string;
}

/** POST /models/test 响应体 */
export interface ModelTestResult {
	ok: boolean;
	latencyMs: number;
	error?: string;
}
