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
	SettingsManager,
	createAgentSession,
	type AgentSession,
	type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import type {
	AgentEvent,
	ModelsPayload,
	ResourcesPayload,
	SessionLoadResult,
	SessionSummary,
} from "./contract.ts";
import { createModelsController, type ModelsController } from "./models.ts";
import { collectResources } from "./resources.ts";
import { continueRecentSession, listSessions, loadSessionById, type SessionRef } from "./sessions.ts";
import { DEFAULT_TRUST_TIMEOUT_MS, resolveProjectTrust, type TrustDecision } from "./trust.ts";
import { createUiBridge, type ApprovalRequestEvent, type UiBridge } from "./ui-context.ts";

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

	/* -------------------------------------------------------------------------
	 * C4 · 会话持久化（`sessions.ts` 的转发；均先等 ready，与 `prompt` 同口径）
	 * ----------------------------------------------------------------------- */
	/** 当前工作目录的会话清单（`all=true` 走 `listAll`，跨项目目录） */
	listSessions(options?: { all?: boolean }): Promise<SessionSummary[]>;
	/** 按 id 加载单个会话的 `Message[]`（找不到返回 null → 端点回 404） */
	loadSession(id: string): Promise<SessionLoadResult | null>;
	/** 续接最近一次会话（只读，不重建活动 AgentSession，见 `sessions.ts` 的语义边界） */
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

	dispose(): void;
}

export interface CoreBootstrap {
	runtime: CoreRuntime;
	/** 会话初始化完成（含信任门裁决）。失败时 reject。 */
	ready: Promise<void>;
}

export interface CreateRuntimeOptions {
	agentDir?: string;
	modelsPath?: string;
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

function resolveModelsPath(agentDir: string, envModelsPath?: string): string {
	if (envModelsPath) return envModelsPath;
	const inAgent = path.join(agentDir, "models.json");
	if (fs.existsSync(inAgent)) return inAgent;
	throw new Error(
		"未找到 models.json：请在 agentDir 放置 models.json，或经环境变量 CORE_MODELS_PATH 注入（core 只读、不复制）",
	);
}

export function createCoreRuntime(opts: CreateRuntimeOptions = {}): CoreBootstrap {
	const agentDir = opts.agentDir ?? path.join(os.homedir(), ".pi", "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const cwd = opts.cwd ?? process.cwd();

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

	/** 当前模型的上下文窗口（`TokenUsage.contextWindow` 的唯一来源；取不到记 0） */
	const contextWindow = (): number => session?.model?.contextWindow ?? 0;

	const models: ModelsController = createModelsController({
		getSession: () => session,
		getRuntime: () => modelRuntime,
		getSettings: () => settingsManager,
	});

	const ready = (async (): Promise<void> => {
		const modelsPath = resolveModelsPath(agentDir, opts.modelsPath);
		const apiKey = opts.apiKey ?? process.env.ARK_API_KEY;
		if (!apiKey) throw new Error("ARK_API_KEY 未设置（core 仅经 env 注入，绝不写进文件）");

		const runtime = await ModelRuntime.create({ modelsPath });
		await runtime.setRuntimeApiKey("ark-coding", apiKey);
		const model = runtime.getModel(
			opts.modelProvider ?? "ark-coding",
			opts.modelId ?? process.env.PI_MODEL ?? "deepseek-v4-flash",
		);
		if (!model) throw new Error("模型未解析到（检查 models.json 与 provider/model id）");
		modelRuntime = runtime;

		if (process.platform === "win32" && opts.shellPath) mergeShellPath(agentDir, opts.shellPath);

		// ★ 信任门 A3：SDK 的默认 reload 不传 resolveProjectTrust（= 无门），
		//   所以这里自建 loader 并显式走 Pi 的两段式（resource-loader.ts:263-273）。
		const settingsManagerCreated = SettingsManager.create(cwd, agentDir);
		settingsManager = settingsManagerCreated;
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settingsManagerCreated });
		await loader.reload({
			resolveProjectTrust: async ({ extensionsResult }: { extensionsResult: LoadExtensionsResult }) => {
				trust = await resolveProjectTrust({
					cwd,
					settingsManager: settingsManagerCreated,
					// 与扩展提问共用同一条通道（SSE 下发 approval_request → POST /approve 回收）
					ask: (title, options, timeoutMs) => bridge.ask(title, options, timeoutMs),
					timeoutMs: opts.trustTimeoutMs ?? DEFAULT_TRUST_TIMEOUT_MS,
				});
				console.log(
					`[core] 信任门：cwd=${trust.cwd} defaultProjectTrust=${trust.defaultProjectTrust} ` +
						`trusted=${trust.trusted} reason=${trust.reason} asked=${trust.asked} ` +
						`bootstrap扩展数=${extensionsResult.extensions?.length ?? 0} 耗时=${trust.elapsedMs}ms`,
				);
				return trust.trusted;
			},
		});
		resourceLoader = loader;

		const created = await createAgentSession({
			model,
			modelRuntime: runtime,
			agentDir,
			cwd,
			settingsManager: settingsManagerCreated,
			resourceLoader: loader,
		});
		session = created.session;
		extensionCount = created.extensionsResult.extensions?.length ?? 0;

		if (disposed) {
			session.dispose();
			return;
		}

		// ★ 关键一步（S3 §2.4 hasUI 陷阱）：不注入 uiContext 则 hasUI=false，
		//   扩展（如 permission-gate）会走「无 UI 直接 block」分支 —— 命令静默失败、
		//   UI 侧看不到任何授权卡。
		await session.bindExtensions({ uiContext: bridge.uiContext, mode: "rpc" });
		session.subscribe((event: unknown) => emitRaw(event));
		console.log(`[core] 会话就绪：加载到扩展 ${extensionCount} 个`);
	})();

	// ready 的 rejection 由 main.ts 显式处理；这里吞掉一份，避免「无人 await 时 unhandledRejection」
	ready.catch(() => {});

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
			return continueRecentSession(sessionRef(), { contextWindow: contextWindow() }).result;
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

		dispose: () => {
			disposed = true;
			bridge.dispose();
			session?.dispose();
		},
	};

	return { runtime, ready };
}
