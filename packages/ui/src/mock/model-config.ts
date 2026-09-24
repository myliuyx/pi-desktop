/**
 * 模型管理（第一批 mock）的数据与类型。
 *
 * ★ 为什么独立成文件、不进 `mock/types.ts`：
 *   `types.ts` 是 M2 的**冻结契约**（C0 契约提升），第一批只做 UI + mock，
 *   不能为了新表单去改冻结类型。这里的 Provider / Model 形态是「将来接
 *   Pi 的 models.json」的草稿结构，字段与规格书 §一 schema 一一对应
 *   （provider: name/baseUrl/apiKey/api/headers；
 *    model: id/name/reasoning/input/contextWindow/maxTokens/cost{...}），
 *   但类型定义只活在本文件，避免污染契约。第二批接 core 时再决定如何合并。
 *
 * 颜色 / 尺寸一律不在此文件出现（G1 / 尺寸走 lib/layout.ts），这里只有数据。
 */

/** API 类型下拉选项（规格书 §一：openai-completions / openai-responses / anthropic-messages） */
export type ModelApiType = "openai-completions" | "openai-responses" | "anthropic-messages";

export const MODEL_API_TYPES: readonly ModelApiType[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;

/** 自定义 Header 行（Key: Value） */
export interface ModelHeader {
  /** 稳定的前端标识，便于 React key 与增删定位（不参与持久化） */
  key: string;
  name: string;
  value: string;
}

/** 单个模型的配置（对齐 Pi 的 models.json model 节点） */
export interface ModelConfig {
  /** 模型 id（对齐 Pi 的 AgentOptions.model）；**空串 = 待配置态** */
  id: string;
  /** 展示名 */
  name: string;
  /** 能力：推理 / 思考 */
  reasoning: boolean;
  /** 能力：图片输入 */
  imageInput: boolean;
  /** 上下文窗口（tokens） */
  contextWindow: number;
  /** 最大输出 tokens */
  maxTokens: number;
  /** 每百万 tokens 价格（四列：输入 / 输出 / 缓存读取 / 缓存写入） */
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** 高级设置（第一批做形不做逻辑） */
  advanced: {
    /** API 端点覆盖 */
    endpointOverride: string;
    /** 兼容性开关（文本，仅占位） */
    compatibility: string;
    /** 高级 Headers（与 Provider 层 Headers 独立） */
    headers: ModelHeader[];
  };
}

/** 一个 Provider（模型服务）的配置 */
export interface ModelProviderConfig {
  /** 前端稳定标识（不参与持久化） */
  id: string;
  /** Provider 名称 */
  name: string;
  /** Base URL */
  baseUrl: string;
  /** API key（以 ! 开头执行 shell 命令，或填写环境变量名） */
  apiKey: string;
  /** API 类型，默认 openai-completions */
  api: ModelApiType;
  /** 自定义 Headers */
  headers: ModelHeader[];
  /** 是否启用 */
  enabled: boolean;
  /** 该 Provider 下的模型清单 */
  models: ModelConfig[];
}

/* ---------------------------------------------------------------------------
 * mock 初始数据
 *
 * 四个 Provider 对齐规格书 §一示例：AliYun / SetFun / Local_Buddy / Ark_Plan，
 * 各含 1–3 个模型，字段齐全。价格数字为示意值（每百万 tokens）。
 * 模型「待配置 / 已配置」状态由 `id` 是否为空决定 —— 这里全部给足 id 表示已配置，
 * id 留空的状态由用户在表单里清空触发。
 * ------------------------------------------------------------------------- */

/** 生成稳定 key 的小工具（避免引入 uuid 依赖） */
function hk(prefix: string, i: number): string {
  return `${prefix}-h${i}`;
}

const aliyunModels: ModelConfig[] = [
  {
    id: "qwen-max",
    name: "Qwen Max",
    reasoning: true,
    imageInput: false,
    contextWindow: 32768,
    maxTokens: 8192,
    cost: { input: 2.5, output: 10, cacheRead: 0.6, cacheWrite: 1.2 },
    advanced: { endpointOverride: "", compatibility: "openai", headers: [] },
  },
  {
    id: "qwen-plus",
    name: "Qwen Plus",
    reasoning: false,
    imageInput: false,
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0.8, output: 2, cacheRead: 0.2, cacheWrite: 0.4 },
    advanced: { endpointOverride: "", compatibility: "openai", headers: [] },
  },
  {
    id: "qwen2.5-vl",
    name: "Qwen2.5-VL",
    reasoning: false,
    imageInput: true,
    contextWindow: 32768,
    maxTokens: 4096,
    cost: { input: 3, output: 9, cacheRead: 0.75, cacheWrite: 1.5 },
    advanced: { endpointOverride: "", compatibility: "openai", headers: [] },
  },
];

const setfunModels: ModelConfig[] = [
  {
    id: "sf-pro",
    name: "SetFun Pro",
    reasoning: true,
    imageInput: true,
    contextWindow: 200000,
    maxTokens: 16384,
    cost: { input: 4, output: 12, cacheRead: 1, cacheWrite: 2 },
    advanced: { endpointOverride: "", compatibility: "openai", headers: [] },
  },
  {
    id: "sf-lite",
    name: "SetFun Lite",
    reasoning: false,
    imageInput: false,
    contextWindow: 128000,
    maxTokens: 8192,
    cost: { input: 1, output: 3, cacheRead: 0.25, cacheWrite: 0.5 },
    advanced: { endpointOverride: "", compatibility: "openai", headers: [] },
  },
];

const localBuddyModels: ModelConfig[] = [
  {
    id: "llama-3.1-8b",
    name: "Llama 3.1 8B",
    reasoning: false,
    imageInput: false,
    contextWindow: 131072,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    advanced: { endpointOverride: "", compatibility: "openai", headers: [] },
  },
  {
    id: "qwen2.5-7b",
    name: "Qwen2.5 7B",
    reasoning: false,
    imageInput: false,
    contextWindow: 131072,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    advanced: { endpointOverride: "", compatibility: "openai", headers: [] },
  },
];

const arkPlanModels: ModelConfig[] = [
  {
    id: "doubao-pro",
    name: "Doubao Pro",
    reasoning: true,
    imageInput: true,
    contextWindow: 256000,
    maxTokens: 16384,
    cost: { input: 1.5, output: 6, cacheRead: 0.4, cacheWrite: 0.8 },
    advanced: { endpointOverride: "", compatibility: "openai", headers: [] },
  },
];

/** 各 Provider 的默认 Headers（示意，留空头表示无自定义） */
export const INITIAL_MODEL_PROVIDERS: ModelProviderConfig[] = [
  {
    id: "aliyun",
    name: "AliYun",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "sk-********************",
    api: "openai-completions",
    headers: [],
    enabled: true,
    models: aliyunModels,
  },
  {
    id: "setfun",
    name: "SetFun",
    baseUrl: "https://api.setfun.ai/v1",
    /*
     * 演示数据要自洽：`validateProviders()` 的规则是「**启用的** Provider 必须有 Base URL 与 API key」，
     * 这条是 enabled 的，就得有 key；否则 mock 形态下点「保存」会被自己的校验拦下
     * （probe:settings 的草稿/保存用例会因此假红）。空 key 只应出现在**停用**的项上（见下面两条）。
     */
    apiKey: "sk-********************",
    api: "openai-completions",
    headers: [{ key: hk("setfun", 0), name: "X-SetFun-Source", value: "desktop-agent" }],
    enabled: true,
    models: setfunModels,
  },
  {
    id: "local-buddy",
    name: "Local_Buddy",
    baseUrl: "http://localhost:11434/v1",
    apiKey: "",
    api: "openai-completions",
    headers: [],
    enabled: false,
    models: localBuddyModels,
  },
  {
    id: "ark-plan",
    name: "Ark_Plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKey: "",
    api: "openai-responses",
    headers: [],
    enabled: false,
    models: arkPlanModels,
  },
];

/**
 * 「导入模型…」在 **mock 形态**下的演示清单。
 *
 * 真实形态走 `POST /providers/models`（core 拉上游 `GET {baseUrl}/models`）。
 * mock 没有上游，但浮层的交互（筛选 / 全选 / 逐项勾选 / 「已添加」标记 / 计数）**不该因此测不到** ——
 * 所以给一份固定清单，让 `probe:settings` 能在不起 core 的前提下验完这条交互。
 *
 * 刻意包含 `qwen-max` / `qwen-plus` / `qwen2.5-vl` 三个**已存在于 AliYun** 的 id，
 * 这样 mock 下也能看到「已添加」徽标与禁用态勾选框（否则那条分支永远没人走）。
 * 全表 11 条 ⇒ 可勾选 8 条 —— 探针 P11 的期望值据此而来，改这张表记得同步。
 */
export const MOCK_DISCOVERED_MODELS: string[] = [
  "qwen-max",
  "qwen-plus",
  "qwen2.5-vl",
  "qwen3-coder-480b-a35b-instruct",
  "qwen3-max-preview",
  "deepseek-v3.2",
  "deepseek-r1-distill-qwen-32b",
  "kimi-k2-instruct",
  "glm-4.6",
  "minimax-m2",
  "doubao-seed-1.6",
];
