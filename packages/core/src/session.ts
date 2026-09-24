/**
 * core 会话层 —— 持有 Pi 的 AgentSession，并把授权请求经事件管道广播给 SSE。
 *
 * 依据：spike-core/spike.ts 实证手法（ModelRuntime.create → setRuntimeApiKey → getModel；
 * createAgentSession → bindExtensions({ uiContext, mode: "rpc" })；session.subscribe 事件管道）。
 * Pi 的 npm 包 `@earendil-works/pi-coding-agent@^0.87.1`（以实际 TS 类型为准）。
 *
 * 运行环境：core 是独立 Node 进程，允许 node:* 与 pi 包（与 UI 包严格隔离）。
 *
 * ## C3 两处结构性变更
 *
 * ① **授权通道转正**：最小 uiContext 抽到 `ui-context.ts`（幂等 / 取消 / 超时 / 事件结算）。
 * ② **启动改为两段**（`createCoreRuntime()` 同步返回 `{ runtime, ready }`）：
 *    信任门（`ask` 态）会在**会话创建之前**向 UI 提问（`trust.ts`），而 HTTP/SSE 服务
 *    原先要等 `createCoreRuntime` 完成才起 —— 于是提问必然没人应答、启动死锁。
 *    现在 main.ts 先 `startServer(runtime)` 再 `await ready`，UI 才有机可乘；
 *    「提问早于 SSE 连接」这一窗口由 server.ts 的**未决请求补发**兜住。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
	type AgentSession,
	type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import type {
	AgentEvent,
	CatalogPayload,
	ModelTestRequest,
	ModelTestResult,
	ModelsPayload,
	ProviderModelsRequest,
	ProviderModelsResult,
	ProvidersPayload,
	ProvidersSaveResult,
	PutProvidersRequest,
	ResourcesPayload,
	SessionLoadResult,
	SessionSummary,
	ToolsPayload,
} from "./contract.ts";
import { isRecord, num } from "./guards.ts";
import { createModelsController, type ModelsController } from "./models.ts";
import { createProvidersController, type ProvidersController } from "./providers.ts";
import { collectResources } from "./resources.ts";
import { continueRecentSession, listSessions, loadSessionById, usageFromActiveBranch, type SessionRef } from "./sessions.ts";
import { DEFAULT_TRUST_TIMEOUT_MS, resolveProjectTrust, type TrustDecision } from "./trust.ts";
import { createUiBridge, type ApprovalRequestEvent, type UiBridge } from "./ui-context.ts";
import { getToolsState, setToolsState } from "./tools.ts";

export interface CoreRuntime {
	/** 发送一条用户消息（驱动模型）。会等会话就绪（信任门裁决在此期间完成）。 */
	prompt(text: string): Promise<void>;
	/** 中止当前会话（Pi 公开 API） */
	abort(): Promise<void>;
	/** 订阅 Pi 原始事件管道（未经翻译；core 侧再经 toAgentEvent 适配后下发 SSE） */
	onEvent(cb: (event: unknown) => void): () => void;
	/** 订阅 core 直接生成的 AgentEvent（如 uiContext 的 approval_request / approval_settled） */
	onAgentEvent(cb: (event: unknown) => void): () => void;
	/** 幂等回收授权：未识/已决/过期 id 一律静默 accepted:false */
	resolveApproval(requestId: string, choice: string): { accepted: boolean };
	/** 取消授权（独立方法，不污染 resolveApproval 的 choice 语义） */
	cancelApproval(requestId: string): { accepted: boolean };
	/** 当前未决授权请求 —— SSE 新连接时补发（信任门提问早于浏览器连接，不补发会永久丢卡） */
	getPendingApprovals(): ApprovalRequestEvent[];
	/** 信任门结论；ready 之前为 null（C5 的 04 屏数据源据此过滤项目本地扩展） */
	getTrust(): TrustDecision | null;
	/** 实际加载到的扩展数；ready 之前为 null（信任门三态的直接证据） */
	getExtensionCount(): number | null;
	/** 会话工作目录（`/sessions` 响应里带上，便于复核「列的是哪个目录的会话」） */
	getCwd(): string;
	/** 会话是否正在生成回复（POST /cwd 的 409 护栏判据；会话未就绪时恒 false） */
	isStreaming(): boolean;
	/**
	 * 运行期热切换工作目录（2026-09-24 D7 裁决，解禁原「不做热切换」）。
	 * `dir=null` = core 默认目录（`process.cwd()`，即 CORE_CWD 缺省时的启动值）。
	 * 成功 = 重建 cwd 绑定链（settings / 资源加载 / 信任门 / 会话）并广播 `cwd_changed`；
	 * 原会话按 Pi 规则留在原目录。目录无效抛 `InvalidCwdError`（端点回 400）；
	 * 流式中抛普通 Error（端点前置判据回 409）。
	 */
	switchCwd(dir: string | null): Promise<{ cwd: string; trust: TrustDecision }>;
	/**
	 * 当前生效模型；**无可用模型时为 null**（2026-09-24 起服务允许无模型启动，
	 * 此时服务可用、可进设置页配置，只是还不能对话）。`/health` 用它做运维可见性。
	 */
	getActiveModel(): { provider: string; modelId: string } | null;

	/* -------------------------------------------------------------------------
	 * C4 · 会话持久化（`sessions.ts` 的转发；均先等 ready，与 `prompt` 同口径）
	 * ----------------------------------------------------------------------- */
	/** 当前工作目录的会话清单（`all=true` 走 `listAll`，跨项目目录） */
	listSessions(options?: { all?: boolean }): Promise<SessionSummary[]>;
	/** 按 id 加载单个会话的 `Message[]`（找不到返回 null → 端点回 404） */
	loadSession(id: string): Promise<SessionLoadResult | null>;
	/**
	 * 续接最近一次会话。C6 起**会重建活动 AgentSession**（§1.2）：
	 * `createAgentSession({ sessionManager: SessionManager.open(file) })` 是公开路径
	 * （sdk.d.ts `sessionManager` 选项 + `sdk.js:230` 把历史消息灌进 agent state），
	 * 重建后续写 prompt 落在同一 session 文件。无历史会话时只返回空壳、不重建。
	 */
	continueRecentSession(): Promise<SessionLoadResult>;

	/* -------------------------------------------------------------------------
	 * C5 · 04/05 屏数据源（`resources.ts` / `models.ts` 的转发）
	 * ----------------------------------------------------------------------- */
	/** `resourceLoader` 三类清单（已按信任门过滤项目本地资源） */
	getResources(): Promise<ResourcesPayload>;
	/** 模型清单 + 当前模型 + 思考档位（读 `settings.json` 既有字段现值） */
	getModels(): Promise<ModelsPayload>;
	/** 切换模型并写回 `settings.json`（`defaultProvider` / `defaultModel`） */
	selectModel(provider: string, modelId: string): Promise<ModelsPayload>;
	/** 设置思考档位并写回 `settings.json`（`defaultThinkingLevel`） */
	setThinkingLevel(level: string): Promise<ModelsPayload>;

	/* -------------------------------------------------------------------------
	 * C2 · 第二批：模型接真（Provider 读写 / 目录 / 测试，见 .plan/task-settings-c2.md）
	 * ----------------------------------------------------------------------- */
	/** `GET /providers`：读取并合并 models.json + sidecar（启用标志） */
	listProviders(): ProvidersPayload;
	/** `PUT /providers`：按 enabled 拆分原子写回、refresh、回退检测 */
	saveProviders(req: PutProvidersRequest): Promise<ProvidersSaveResult>;
	/** `GET /models/catalog?q=`：内置目录检索（不出网） */
	searchCatalog(query: string): CatalogPayload;
	/** `POST /models/test`：一次性最小真实请求（不落盘、不改当前选择） */
	testModel(req: ModelTestRequest): Promise<ModelTestResult>;
	/** `POST /providers/models`：拉取该 Provider 的真实模型清单（不落盘、不改当前选择） */
	listProviderModels(req: ProviderModelsRequest): Promise<ProviderModelsResult>;

	/* -------------------------------------------------------------------------
	 * C6 · 04 屏工具开关（`tools.ts` 的转发）
	 * ----------------------------------------------------------------------- */
	/** 当前启用的工具名与可启用全集（`GET /tools/active`） */
	getTools(): Promise<ToolsPayload>;
	/** 设置启用工具集（`POST /tools/active {names}`；未注册名抛错 → 400） */
	setTools(names: string[]): Promise<ToolsPayload>;

	dispose(): void;
}

export interface CoreBootstrap {
	runtime: CoreRuntime;
	/** 会话初始化完成（含信任门裁决）。失败时 reject。 */
	ready: Promise<void>;
}

/** `switchCwd` 的可预期失败（目录不存在 / 不是目录）：server 据此回 400，与意外错误（500）区分 */
export class InvalidCwdError extends Error {}

export interface CreateRuntimeOptions {
	agentDir?: string;
	apiKey?: string;
	shellPath?: string;
	modelProvider?: string;
	modelId?: string;
	/** 项目目录（决定项目本地资源与信任门）。默认 process.cwd() */
	cwd?: string;
	/** 信任门提问等待上限（默认 DEFAULT_TRUST_TIMEOUT_MS） */
	trustTimeoutMs?: number;
}

/** Windows 下把 shellPath 合并写进 <agentDir>/settings.json（缺省不覆盖其他键） */
function mergeShellPath(agentDir: string, shellPath: string): void {
	const settingsPath = path.join(agentDir, "settings.json");
	let settings: Record<string, unknown> = {};
	try {
		const raw = fs.readFileSync(settingsPath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") settings = parsed as Record<string, unknown>;
	} catch {
		settings = {};
	}
	if (!settings.shellPath) {
		settings.shellPath = shellPath;
		fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
	}
}

/**
 * 空清单模板 —— 形状与 `PUT /providers` 写回的一致（`providers` 是 **Record**，不是数组）。
 * 单独立常量是为了让「首次运行自动创建」与「写入」两处不会各自漂移。
 */
const EMPTY_MODELS_JSON = `${JSON.stringify({ providers: {} }, null, 2)}\n`;

/**
 * models.json 路径解析（**只认 Pi 的约定位置**）。
 *
 * `<agentDir>/models.json`，其中 agentDir = `CORE_AGENT_DIR` / `~/.pi/agent`
 * —— 与 Pi 自己 `config.ts:541 getModelsPath()` 的口径完全一致。
 *
 * **不再有 `CORE_MODELS_PATH` 覆盖口**（2026-09-24 删除）：它是早期开发时为了把清单
 * 指到 `pi/_poc/` 才加的，属于历史包袱。验收脚本要隔离夹具时，把 `CORE_AGENT_DIR`
 * 指向临时目录即可（清单就在那个目录里），少一个入口就少一种「到底读的哪个文件」。
 *
 * 文件缺失时**创建空清单**而非抛错：正式形态下用户不该被迫手工建文件，
 * 服务照常起来、由设置页「添加 Provider」填内容（见 ready 的无模型分支）。
 * 用 `flag: "wx"` 独占创建 ⇒ 与用户手工建文件并发时不会覆盖对方。
 */
function resolveModelsPath(agentDir: string): string {
	const inAgent = path.join(agentDir, "models.json");
	if (!fs.existsSync(inAgent)) {
		try {
			fs.mkdirSync(path.dirname(inAgent), { recursive: true });
			fs.writeFileSync(inAgent, EMPTY_MODELS_JSON, { flag: "wx" });
			console.log(`[core] 已创建空的 models.json：${inAgent}（请在设置页添加 Provider）`);
		} catch (e) {
			// 并发下别人先建了 → 直接用；其他错误（权限等）不在文件系统层吞掉，
			// 交给后续 readProviderRecordMap 按「读取失败」抛出（GET /providers 回结构化 error）。
			if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") {
				console.error(`[core] 创建 models.json 失败：${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}
	return inAgent;
}

/** 读 settings.json 的 defaultProvider/defaultModel（Pi 既有字段）；缺失/损坏返回 null */
function readDefaultModel(agentDir: string): { provider: string; modelId: string } | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")) as {
			defaultProvider?: unknown;
			defaultModel?: unknown;
		};
		const provider = typeof parsed.defaultProvider === "string" ? parsed.defaultProvider : "";
		const modelId = typeof parsed.defaultModel === "string" ? parsed.defaultModel : "";
		return provider && modelId ? { provider, modelId } : null;
	} catch {
		return null;
	}
}

export function createCoreRuntime(opts: CreateRuntimeOptions = {}): CoreBootstrap {
	const agentDir = opts.agentDir ?? path.join(os.homedir(), ".pi", "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	// D7：let（原 const）—— switchCwd 运行期热切换会改写它；启动值 = opts.cwd ?? process.cwd()
	let cwd = opts.cwd ?? process.cwd();

	/*
	 * models.json 路径解析提前到外层，这样 `GET /providers` 即使会话尚未就绪也能读到文件
	 * （文件读不依赖 Pi 会话）。正式形态下该文件**缺失会被自动创建**（见 resolveModelsPath），
	 * 所以正常路径不再落到 null；保留 try/catch 只为兜住 mkdir/权限这类极端失败，
	 * 此时端点回结构化 {error} 而不是崩掉服务。
	 */
	let resolvedModelsPath: string | null = null;
	let resolvedSidecarPath: string | null = null;
	try {
		resolvedModelsPath = resolveModelsPath(agentDir);
		resolvedSidecarPath = path.join(path.dirname(resolvedModelsPath), "models-disabled.json");
	} catch {
		resolvedModelsPath = null;
		resolvedSidecarPath = null;
	}

	// 事件管道先建：HTTP 服务要能在会话就绪之前就订阅上（见文件头 ②）
	const rawListeners = new Set<(e: unknown) => void>();
	const agentListeners = new Set<(e: unknown) => void>();
	const emitRaw = (e: unknown) => {
		for (const cb of rawListeners) cb(e);
	};
	const emitAgent = (e: AgentEvent) => {
		for (const cb of agentListeners) cb(e);
	};

	const bridge: UiBridge = createUiBridge({ emit: emitAgent });

	let session: AgentSession | null = null;
	/** 启动时解析到的模型（§1.2 重建活动会话时原样传入，避免模型被会话头里的旧值意外替换） */
	let activeModel: AgentSession["model"] | null = null;
	let resourceLoader: DefaultResourceLoader | null = null;
	let modelRuntime: ModelRuntime | null = null;
	let settingsManager: SettingsManager | null = null;
	let trust: TrustDecision | null = null;
	let extensionCount: number | null = null;
	let disposed = false;

	/*
	 * C4：会话目录必须与 Pi 实际落盘目录一致（`<agentDir>/sessions/<encoded-cwd>/`）。
	 * `getDefaultSessionDir` **未从包顶层导出**（`index.d.ts` 无此符号），
	 * 所以不自己复刻路径算法（会随上游漂移），而是从活动会话的 SessionManager 上取真值。
	 */
	const sessionRef = (): SessionRef => ({ cwd, sessionDir: session?.sessionManager.getSessionDir() });

	/**
	 * 当前**真正可用**的模型 —— 无可用模型时归一成 null。
	 *
	 * 为什么需要它（2026-09-24 实查）：SDK 在「没有任何可用模型」时并不会让
	 * `session.model` 为 undefined，而是挂一个 `provider="unknown", id="unknown"`
	 * 的**占位模型**；直接透出去会让 `/health`、`/models` 报出一个并不存在的模型。
	 * 判据用「runtime 是否认得它」：`getModel(provider,id)` 对占位值返回 undefined。
	 * （与 `models.ts` 的 `list()` 同一口径，改一处记得改另一处。）
	 */
	const usableModel = (): AgentSession["model"] | null => {
		const m = session?.model;
		if (!m) return null;
		return modelRuntime?.getModel(m.provider, m.id) ? m : null;
	};

	/** 当前模型的上下文窗口（`TokenUsage.contextWindow` 的唯一来源；取不到记 0） */
	const contextWindow = (): number => usableModel()?.contextWindow ?? 0;

	/*
	 * 会话用量（TokenStats 数据源）：`input`/`output` 取最近一次 assistant 请求，
	 * `total` 历史累加。每次 assistant `message_end` 后经 `usage` 事件下发；
	 * 模型切换**不补发**（下次发消息自然带新的 contextWindow）。
	 */
	let usageInput = 0;
	let usageOutput = 0;
	let usageTotal = 0;

	const emitUsage = () => {
		/*
		 * contextTokens：Pi 的「已用上下文」（`getContextUsage().tokens`，随对话增长）。
		 * Pi 在压缩后、下一次 LLM 回复前返回 null —— 此时**不写该字段**，
		 * 让 UI 回落 contextWindow（与旧行为一致，不出现 0 的假数据）。
		 */
		const contextTokens = session?.getContextUsage()?.tokens;
		emitAgent({
			type: "usage",
			usage: {
				input: usageInput,
				output: usageOutput,
				total: usageTotal,
				contextWindow: contextWindow(),
				...(typeof contextTokens === "number" ? { contextTokens } : {}),
			},
		});
	};

	const trackUsage = (raw: unknown) => {
		if (!isRecord(raw) || raw.type !== "message_end") return;
		const message = raw.message;
		if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) return;
		usageInput = num(message.usage.input);
		usageOutput = num(message.usage.output);
		usageTotal += num(message.usage.totalTokens);
		emitUsage();
	};

	/** 切换活动会话后，用新会话的历史汇总重置累计（否则新消息会叠加旧会话的用量） */
	const resetUsageFromSession = () => {
		if (!session || !settingsManager) return;
		// getBranch 口径，与 POST /sessions/load 的 readSession 同源（不要改用 getEntries：
		// 那会把被弃旁支的用量折进来，见 sessions.ts 的 usageFromActiveBranch 注释）。
		const tokenUsage = usageFromActiveBranch(session.sessionManager, contextWindow());
		usageInput = tokenUsage.input;
		usageOutput = tokenUsage.output;
		usageTotal = tokenUsage.total;
	};

	const models: ModelsController = createModelsController({
		getSession: () => session,
		getRuntime: () => modelRuntime,
		getSettings: () => settingsManager,
	});

	/** C2 · Provider 读写 / 目录 / 测试控制器（惰性 getter，不持有未就绪的 Pi 对象） */
	const providers: ProvidersController = createProvidersController({
		getModelsPath: () => resolvedModelsPath,
		getSidecarPath: () => resolvedSidecarPath,
		agentDir,
		getRuntime: () => modelRuntime,
		// S1 边界回退：与 models.select 同一条路（session.setModel persist:true ⇒
		// settingsManager.setDefaultModelAndProvider 写 settings.json 既有字段）
		selectCurrent: async (provider, modelId) => {
			if (!session || !modelRuntime) return false;
			const model = modelRuntime.getModel(provider, modelId);
			if (!model) return false;
			await session.setModel(model, { persist: true });
			return true;
		},
	});

	/*
	 * 项目引导（cwd 绑定链）—— 启动与运行期热切换（switchCwd，D7）**共用同一条路**，
	 * 保证「切换后的目录」与「启动时的目录」行为完全一致（同一信任门、同一资源过滤口径）。
	 *
	 * 产物全部 cwd 绑定：SettingsManager → DefaultResourceLoader（信任门在其 reload
	 * 两段式里裁决）→ createAgentSession → bindExtensions → 事件订阅。
	 * **不改任何全局可变状态**：产物交调用方换引用（先换后 dispose 旧实例，rebuildSession 同规），
	 * 失败时半成品会话就地回收、旧会话不动。
	 * 前置条件：modelRuntime / activeModel 已就绪（ready 流程先于本函数）。
	 */
	const bootProject = async (
		dir: string,
	): Promise<{
		session: AgentSession;
		settingsManager: SettingsManager;
		resourceLoader: DefaultResourceLoader;
		trust: TrustDecision;
		extensionCount: number;
	}> => {
		if (!modelRuntime) throw new Error("modelRuntime 未就绪，无法引导项目会话");
		const modelRuntimeRef = modelRuntime;
		const settingsManagerCreated = SettingsManager.create(dir, agentDir);
		// ★ 信任门 A3：SDK 的默认 reload 不传 resolveProjectTrust（= 无门），
		//   所以这里自建 loader 并显式走 Pi 的两段式（resource-loader.ts:263-273）。
		const loader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager: settingsManagerCreated });
		let decision: TrustDecision | null = null;
		await loader.reload({
			resolveProjectTrust: async ({ extensionsResult }: { extensionsResult: LoadExtensionsResult }) => {
				decision = await resolveProjectTrust({
					cwd: dir,
					settingsManager: settingsManagerCreated,
					// 与扩展提问共用同一条通道（SSE 下发 approval_request → POST /approve 回收）
					ask: (title, options, timeoutMs) => bridge.ask(title, options, timeoutMs),
					timeoutMs: opts.trustTimeoutMs ?? DEFAULT_TRUST_TIMEOUT_MS,
				});
				console.log(
					`[core] 信任门：cwd=${decision.cwd} defaultProjectTrust=${decision.defaultProjectTrust} ` +
						`trusted=${decision.trusted} reason=${decision.reason} asked=${decision.asked} ` +
						`bootstrap扩展数=${extensionsResult.extensions?.length ?? 0} 耗时=${decision.elapsedMs}ms`,
				);
				return decision.trusted;
			},
		});
		if (!decision) throw new Error("信任门未产出结论（loader.reload 未回调 resolveProjectTrust）");
		const trustDecision: TrustDecision = decision;

		const created = await createAgentSession({
			// 无模型时**整个字段省略**（贴合 d.ts 的 `model?` 可选语义），SDK 自行走
			// findInitialModel → 拿不到就只给 modelFallbackMessage
			...(activeModel ? { model: activeModel } : {}),
			modelRuntime: modelRuntimeRef,
			agentDir,
			cwd: dir,
			settingsManager: settingsManagerCreated,
			resourceLoader: loader,
		});
		// SDK 的提示（如 "No models available. ..."）原样转出，便于运维定位
		if (created.modelFallbackMessage) console.warn(`[core] ${created.modelFallbackMessage}`);

		try {
			if (disposed) throw new Error("core 已停机，放弃挂接新会话");
			// ★ 关键一步（S3 §2.4 hasUI 陷阱）：不注入 uiContext 则 hasUI=false，
			//   扩展（如 permission-gate）会走「无 UI 直接 block」分支 ——
			//   命令静默失败、UI 侧看不到任何授权卡。
			await created.session.bindExtensions({ uiContext: bridge.uiContext, mode: "rpc" });
			created.session.subscribe((event: unknown) => {
				trackUsage(event);
				emitRaw(event);
			});
		} catch (e) {
			created.session.dispose();
			throw e;
		}
		return {
			session: created.session,
			settingsManager: settingsManagerCreated,
			resourceLoader: loader,
			trust: trustDecision,
			extensionCount: created.extensionsResult.extensions?.length ?? 0,
		};
	};

	const ready = (async (): Promise<void> => {
		const modelsPath = resolvedModelsPath ?? resolveModelsPath(agentDir);
		const runtime = await ModelRuntime.create({ modelsPath });

		/*
		 * 初始模型解析（不再硬编码 ark-coding/deepseek-v4-flash）：
		 *   显式指定（opts.modelProvider / PI_MODEL）> settings.json 的 defaultProvider/defaultModel
		 *   > 可用快照（已配置凭证）第一个。
		 * apiKey 变为**可选**：显式注入（opts.apiKey / ARK_API_KEY）仅用于 `$ARK_API_KEY`
		 *   插值场景；否则直接依赖 models.json 内联凭证（Pi 原生能力）。
		 */
		const fallback = readDefaultModel(agentDir);
		const provider = opts.modelProvider ?? fallback?.provider;
		const modelId = opts.modelId ?? process.env.PI_MODEL ?? fallback?.modelId;
		const snapshot = runtime.getAvailableSnapshot();

		let model = provider && modelId ? runtime.getModel(provider, modelId) : undefined;
		if (!model && modelId) model = snapshot.find((m) => m.id === modelId);
		if (!model) model = snapshot[0];

		/*
		 * ★ 无可用模型**不中止启动**（2026-09-24 改）：
		 * 首次运行的用户 models.json 是空的，若这里 throw，main.ts 会 exit(1) ——
		 * 用户连设置页都打不开，等于死锁（想配也得先有服务）。
		 * 现在改为：服务照常起，会话照样建（只是没有模型），由用户在设置页添加 Provider。
		 *
		 * 依据（published 包实查）：`createAgentSession` 的 `model` 是**可选**的
		 * （`core/sdk.d.ts:18 model?: Model<any>`）；无模型时 `core/sdk.js:107-113`
		 * 走 `findInitialModel` → 拿不到就只置 `modelFallbackMessage`、**不抛错**，
		 * 该分支 `thinkingLevel` 落 "off"、`agent.state.model` 为 undefined、
		 * 且 `appendModelChange` 有 `model &&` 守卫。
		 */
		if (!model) {
			console.warn(
				"[core] 当前没有可用模型：请到设置页「模型」添加并启用一个 Provider（服务照常启动，配好后即可对话）",
			);
		}

		const apiKey = opts.apiKey ?? process.env.ARK_API_KEY;
		if (apiKey && model) await runtime.setRuntimeApiKey(model.provider, apiKey);

		modelRuntime = runtime;
		activeModel = model ?? null;

		if (process.platform === "win32" && opts.shellPath) mergeShellPath(agentDir, opts.shellPath);

		// cwd 绑定链走 bootProject（与 switchCwd 共用，见其注释）；产物在此换全局引用
		const boot = await bootProject(cwd);
		session = boot.session;
		settingsManager = boot.settingsManager;
		resourceLoader = boot.resourceLoader;
		trust = boot.trust;
		extensionCount = boot.extensionCount;
		console.log(
			`[core] 会话就绪：加载到扩展 ${extensionCount} 个` +
				(activeModel
					? `；当前模型 ${activeModel.provider}/${activeModel.id}`
					: "；当前无模型（待设置页配置）"),
		);
	})();

	// ready 的 rejection 由 main.ts 显式处理；这里吞掉一份，避免「无人 await 时 unhandledRejection」
	ready.catch(() => {});

	/*
	 * C6 §1.2：重建活动会话（`continue-recent` 的落地路径，限时评估结论 = **有公开低险路径，做**）。
	 *
	 * API 依据（@earendil-works/pi-coding-agent@0.87.1 实查）：
	 * - `createAgentSession` 公开选项 `sessionManager`（`core/sdk.d.ts` CreateAgentSessionOptions）；
	 * - 传 `SessionManager.open(文件)` 时，`core/sdk.js:230` 会把会话历史灌进 agent state
	 *   （`messages: existingSession.messages`，同函数还有模型/思考档位恢复逻辑）；
	 * - `SessionManager.open(path, sessionDir?, cwdOverride?)`（session-manager.d.ts:369）；
	 * - 这正是 Pi CLI `--continue` 的同一条路（`main.d.ts` createSessionManager → open/continueRecent）。
	 * 扩展绑定（bindExtensions）与事件订阅在新实例上按启动路径同一套手法重做；
	 * 切换成功后才 dispose 旧实例。**不引入任何私有 API。**
	 * 判据（规格书 §1.2）：续写消息落在同一 session 文件 → `check:c6` 里以
	 * `GET /sessions` 的 messageCount 增长验证。
	 */
	const rebuildSession = async (sessionFile: string): Promise<void> => {
		if (!modelRuntime || !settingsManager || !resourceLoader) throw new Error("会话组件未就绪，无法重建");
		const manager = SessionManager.open(sessionFile, sessionRef().sessionDir, cwd);
		const created = await createAgentSession({
			model: activeModel ?? undefined,
			modelRuntime,
			agentDir,
			cwd,
			settingsManager,
			resourceLoader,
			sessionManager: manager,
		});
		const previous = session;
		session = created.session;
		extensionCount = created.extensionsResult.extensions?.length ?? extensionCount;
		// 与启动路径同口径：先换实例、绑扩展、订事件，最后才 dispose 旧实例
		await session.bindExtensions({ uiContext: bridge.uiContext, mode: "rpc" });
		session.subscribe((event: unknown) => {
			trackUsage(event);
			emitRaw(event);
		});
		resetUsageFromSession();
		previous?.dispose();
		console.log(`[core] 已切换活动会话：${sessionFile}`);
	};

	/*
	 * 运行期热切换工作目录（2026-09-24 D7 裁决，解禁原「不做清单 #1」）：
	 * UI 点「使用默认目录」/ 最近目录**立即生效**，不再承诺「下次启动」。
	 *
	 * 实现 = cwd 绑定链整体重建：`bootProject(新目录)` 产出全新的 settings / loader /
	 * 信任门 / 会话，成功后一次性换引用 → 广播 `cwd_changed` → 最后 dispose 旧会话
	 * （rebuildSession 同规：先换后丢）。bootProject 失败时旧会话原样保留 ——
	 * 绝不出现「新目录没建成、旧会话也丢了」的两头空。
	 *
	 * - `dir=null` = core 默认目录（`process.cwd()`，即 CORE_CWD 缺省时的启动值）；
	 * - 流式中拒绝（不偷偷中止正在生成的回复；端点另有前置判据回 409，这里是兜底）；
	 * - 同目录 no-op（不重建）；
	 * - 目录无效抛 `InvalidCwdError`（端点回 400，UI 原样透出文案）；
	 * - 未信任目录沿启动同一条信任门：bridge.ask 实时弹卡，拒绝/超时 = 按不信任加载
	 *   （**切换不失败**，与启动语义一致：信任只影响项目本地资源的加载与过滤）。
	 */
	const switchCwd = async (dir: string | null): Promise<{ cwd: string; trust: TrustDecision }> => {
		await ready;
		if (session?.isStreaming) {
			throw new Error("会话正在生成回复，请先停止再切换目录");
		}
		const target = path.resolve(dir ?? process.cwd());
		let st: fs.Stats;
		try {
			st = fs.statSync(target);
		} catch {
			throw new InvalidCwdError(`目录不存在：${target}`);
		}
		if (!st.isDirectory()) throw new InvalidCwdError(`不是目录：${target}`);
		if (target === cwd) {
			if (!trust) throw new Error("信任门未就绪");
			return { cwd, trust };
		}
		const previousCwd = cwd;
		const previousSession = session;
		const boot = await bootProject(target);
		session = boot.session;
		settingsManager = boot.settingsManager;
		resourceLoader = boot.resourceLoader;
		trust = boot.trust;
		extensionCount = boot.extensionCount;
		cwd = target;
		// 用量按新会话（空壳）重置；广播放在 dispose 旧会话**之后**，
		// 避免 UI 收到事件来拉清单时旧会话还占着位置（时序可观测的假状态）
		resetUsageFromSession();
		previousSession?.dispose();
		emitAgent({ type: "cwd_changed", cwd: target });
		console.log(`[core] 工作目录已切换：${previousCwd} → ${target}`);
		return { cwd: target, trust: boot.trust };
	};

	const runtime: CoreRuntime = {
		prompt: async (text: string) => {
			await ready;
			if (!session) throw new Error("会话未就绪");
			await session.prompt(text);
		},
		abort: async () => {
			await ready;
			await session?.abort();
		},
		onEvent: (cb) => {
			rawListeners.add(cb);
			return () => rawListeners.delete(cb);
		},
		onAgentEvent: (cb) => {
			agentListeners.add(cb);
			return () => agentListeners.delete(cb);
		},
		resolveApproval: (requestId, choice) => bridge.approve(requestId, choice),
		cancelApproval: (requestId) => bridge.cancel(requestId),
		getPendingApprovals: () => bridge.listPending(),
		getTrust: () => trust,
		getExtensionCount: () => extensionCount,
		getCwd: () => cwd,
		isStreaming: () => session?.isStreaming ?? false,
		switchCwd,
		getActiveModel: () => {
			// 与 contextWindow 同口径：占位模型（provider="unknown"）归一成 null
			const m = usableModel() ?? (activeModel && modelRuntime?.getModel(activeModel.provider, activeModel.id) ? activeModel : null);
			return m ? { provider: m.provider, modelId: m.id } : null;
		},

		/* ------------------------------------------------------------ C4 */
		listSessions: async (options = {}) => {
			await ready;
			return listSessions(sessionRef(), options);
		},
		loadSession: async (id) => {
			await ready;
			return loadSessionById(sessionRef(), id, { contextWindow: contextWindow() })?.result ?? null;
		},
		continueRecentSession: async () => {
			await ready;
			const loaded = continueRecentSession(sessionRef(), { contextWindow: contextWindow() });
			/*
			 * C6 §1.2：把活动会话切到「最近一次会话」（重建 AgentSession，见 rebuildSession 注释）。
			 * 两条护栏：① 没有历史会话（空壳、无 path）或最近会话没有任何消息 → 不重建（切过去无意义）；
			 * ② 最近会话就是当前活动会话 → 不重建（同文件，重建纯属浪费）。
			 */
			const currentFile = session?.sessionManager.getSessionFile();
			if (loaded.path && loaded.result.messages.length > 0 && loaded.path !== currentFile) {
				await rebuildSession(loaded.path);
			}
			return loaded.result;
		},

		/* ------------------------------------------------------------ C5 */
		getResources: async () => {
			await ready;
			if (!resourceLoader) throw new Error("resourceLoader 未就绪");
			// 信任结论随清单一起下发（未信任 ⇒ 项目本地资源不列，见 resources.ts 的过滤口径）
			return collectResources(resourceLoader, trust ? { trusted: trust.trusted, reason: trust.reason } : null, {
				cwd,
			});
		},
		getModels: async () => {
			await ready;
			return models.list();
		},
		selectModel: async (provider, modelId) => {
			await ready;
			return models.select(provider, modelId);
		},
		setThinkingLevel: async (level) => {
			await ready;
			return models.setThinking(level);
		},

		/* ------------------------------------------------------------ C2 */
		listProviders: () => {
			// 文件读不依赖会话就绪，可直接返回；runtime 未就绪时 ready=false（UI 据此回落 mock）
			return providers.list();
		},
		saveProviders: async (req) => {
			await ready;
			return providers.save(req);
		},
		searchCatalog: (query) => {
			// 目录来自 modelRuntime.getModels()，未就绪时返回空结果（UI 自行处理）
			return providers.catalog(query);
		},
		testModel: (req) => {
			// 真实最小请求，不依赖会话就绪、不落盘
			return providers.test(req);
		},
		listProviderModels: (req) => {
			// 拉上游 /models 清单，同样不依赖会话就绪、不落盘
			return providers.listModels(req);
		},

		/* ------------------------------------------------------------ C6 */
		getTools: async () => {
			await ready;
			if (!session) throw new Error("会话未就绪");
			return getToolsState(session);
		},
		setTools: async (names) => {
			await ready;
			if (!session) throw new Error("会话未就绪");
			return setToolsState(session, names);
		},

		dispose: () => {
			disposed = true;
			bridge.dispose();
			session?.dispose();
		},
	};

	return { runtime, ready };
}
