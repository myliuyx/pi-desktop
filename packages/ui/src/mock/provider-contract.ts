/**
 * 第二批（C2）模型接真 —— UI 侧契约类型（core `contract.ts` 中同名类型的「UI 副本」）。
 *
 * 纪律：core 的 `contract.ts` 是**权威源**（纯类型零 import），本文件是其 UI 侧镜像。
 * 镜像靠 `npm run check:contract`（`scripts/contract-mirror-check.mjs`）**自动齐平**：
 * 新增 / 改名 / 删字段都会在那里报出来，不再依赖「记得手动同步」——
 * 上一批加 `ProviderModelsRequest/Result` 与可选性改动时同时要改四处，就是靠人肉记的。
 *
 * 为什么不直接 `import type` core 的 contract.ts（`mock/types.ts` 对
 * `Block` / `Message` / `ModelInfo` 等就是这么做的）：
 * 那批是**事件/展示面**契约（UI 的渲染与 SSE 消费），而这批是**设置页控制面**契约
 * （`GET/PUT /providers` 的读写形状，含 `apiKey` 原文语义）—— 两者的读者、演进节奏、
 * 注释重点都不同（例如 `contextWindow` 的「缺省 = 未填」、`apiKey` 的环境变量插值），
 * 分文件才好各自写清。镜像不是零成本，所以配了上面的自动探针兜底。
 *
 * 字段名对齐 models.json 原生 schema（cost 而非 pricing；input 用 ["text","image"] 数组）。
 */

/** 单个模型（对齐 Pi models.json 的 model 节点原生 schema） */
export interface ProviderModelEntry {
	id: string;
	/**
	 * 显示名。**可选 = 未填**：Pi 原生 schema 是 `Optional(String({minLength:1}))` ——
	 * 可选，但一旦出现就必须 ≥1 字符；空串是非法值，会让**整份 models.json** 校验失败
	 * （所有 Provider 一起从可用集合消失）。故「未填」用缺省表达，由 Pi 回落到 `id`。
	 */
	name?: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	/**
	 * 上下文窗口 / 最大输出 tokens。
	 *
	 * **可选 = 「未填」**（2026-09-24 实踩后修）：Pi 对 `<= 0` 直接 throw
	 * （`invalid contextWindow` / `invalid maxTokens`），而它的默认值（128000 / 16384）
	 * 只在字段**缺省**时生效。表单里的 0 必须转成「省略字段」，不能原样发出去。
	 */
	contextWindow?: number;
	maxTokens?: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	headers?: Record<string, string>;
	compat?: string;
	/** 高级：API 端点覆盖（UI 表单高级字段，原样透传） */
	endpointOverride?: string;
}

/** 一个 Provider（GET /providers 与 PUT /providers 共用形状） */
export interface ProviderEntry {
	id: string;
	/** 显示名。**可选 = 未填**（空串会让整份 models.json 非法，见 ProviderModelEntry.name） */
	name?: string;
	/** Base URL。**可选 = 未填** */
	baseUrl?: string;
	/** API key 原文（D6：不脱敏）。**可选 = 未填**；缺省时 Pi 视作「未配置凭证」 */
	apiKey?: string;
	/** API 类型。**可选 = 用默认** */
	api?: string;
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

/**
 * POST /providers/models 请求体 —— 拉取某个 Provider 的真实模型清单（`GET {baseUrl}/models`）。
 * 与 `ModelTestRequest` 同一套凭证解析（`!` / `$ENV` 由 core 解析，不落盘）。
 */
export interface ProviderModelsRequest {
	baseUrl: string;
	apiKey: string;
	api: string;
	headers?: Record<string, string>;
}

/** POST /providers/models 响应体 */
export interface ProviderModelsResult {
	ok: boolean;
	/** 上游返回的模型 id 清单（已 trim / 去重 / 保序） */
	models: string[];
	error?: string;
	/** 实际请求的地址（自查用） */
	endpoint?: string;
}
