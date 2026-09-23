/**
 * core 会话层 —— 持有 Pi 的 AgentSession，并把授权请求经事件管道广播给 SSE。
 *
 * 依据：spike-core/spike.ts 实证手法（ModelRuntime.create → setRuntimeApiKey → getModel；
 * createAgentSession → bindExtensions({ uiContext, mode: "rpc" })；session.subscribe 事件管道）。
 * Pi 的 npm 包 `@earendil-works/pi-coding-agent@^0.87.1`（以实际 TS 类型为准）。
 *
 * 运行环境：core 是独立 Node 进程，允许 node:* 与 pi 包（与 UI 包严格隔离）。
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ModelRuntime,
  createAgentSession,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

export interface CoreRuntime {
  /** 发送一条用户消息（驱动模型） */
  prompt(text: string): Promise<void>;
  /** 中止当前会话（Pi 公开 API） */
  abort(): Promise<void>;
  /** 订阅 Pi 原始事件管道（未经翻译；core 侧再经 toAgentEvent 适配后下发 SSE） */
  onEvent(cb: (event: unknown) => void): () => void;
  /** 订阅 core 直接生成的 AgentEvent（如 uiContext 的 approval_request，已是我们契约形状） */
  onAgentEvent(cb: (event: unknown) => void): () => void;
  /** 幂等回收授权：未识/已决/过期 id 一律静默 accepted:false（照 spike 手法） */
  resolveApproval(requestId: string, choice: string): { accepted: boolean };
  dispose(): void;
}

export interface CreateRuntimeOptions {
  agentDir?: string;
  modelsPath?: string;
  apiKey?: string;
  shellPath?: string;
  modelProvider?: string;
  modelId?: string;
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

export async function createCoreRuntime(opts: CreateRuntimeOptions = {}): Promise<CoreRuntime> {
  const agentDir = opts.agentDir ?? path.join(os.homedir(), ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });

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

  if (process.platform === "win32" && opts.shellPath) {
    mergeShellPath(agentDir, opts.shellPath);
  }

  const pending = new Map<string, { resolve: (v: string) => void; method: string }>();
  const rawListeners = new Set<(e: unknown) => void>();
  const agentListeners = new Set<(e: unknown) => void>();
  const emitRaw = (e: unknown) => {
    for (const cb of rawListeners) cb(e);
  };
  const emitAgent = (e: unknown) => {
    for (const cb of agentListeners) cb(e);
  };

  const uiContext = makeUiContext(pending, emitAgent);

  const { session } = await createAgentSession({
    model,
    modelRuntime: runtime,
    agentDir,
  });
  await session.bindExtensions({ uiContext, mode: "rpc" });

  session.subscribe((event: unknown) => emitRaw(event));

  return {
    prompt: (text: string) => session.prompt(text),
    abort: () => session.abort(),
    onEvent: (cb) => {
      rawListeners.add(cb);
      return () => rawListeners.delete(cb);
    },
    onAgentEvent: (cb) => {
      agentListeners.add(cb);
      return () => agentListeners.delete(cb);
    },
    resolveApproval: (requestId, choice) => {
      const entry = pending.get(requestId);
      if (!entry) return { accepted: false };
      pending.delete(requestId);
      entry.resolve(choice);
      return { accepted: true };
    },
    dispose: () => session.dispose(),
  };
}

/**
 * ExtensionUIContext 最小实现（C1 阶段）：select/confirm/input 生成 approval_request 事件，
 * 经 SSE 下发；POST /approve 回收后 resolve。其余方法是安全空实现（S3 §2.6）。
 * 完整授权闭环（倒计时/失效态/信任门）在 C3 落地。
 */
function makeUiContext(
  pending: Map<string, { resolve: (v: string) => void; method: string }>,
  emit: (e: unknown) => void,
): ExtensionUIContext {
  const dialog = (
    method: "select" | "confirm" | "input",
    title: string,
    extra: Record<string, unknown>,
    timeout?: number,
  ): Promise<string> =>
    new Promise<string>((resolve) => {
      const requestId = randomUUID();
      pending.set(requestId, { resolve, method });
      emit({ type: "approval_request", requestId, method, title, timeoutMs: timeout, ...extra });
    });

  return {
    select: (title: string, options: string[], opts?: { timeout?: number }) =>
      dialog("select", title, { options }, opts?.timeout),
    confirm: (title: string, message: string, opts?: { timeout?: number }) =>
      dialog("confirm", title, { message }, opts?.timeout),
    input: (title: string, placeholder?: string, opts?: { timeout?: number }) =>
      dialog("input", title, { placeholder }, opts?.timeout),
    notify: (message: string, _type?: unknown) => {
      // 通知不进 SSE（契约无 notification 类型，UI reducer 无法消费）；仅留日志便于排查。
      console.debug(`[core] uiContext.notify: ${message}`);
    },
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: <T>(..._args: unknown[]): Promise<T> => Promise.resolve(undefined as unknown as T),
  } as unknown as ExtensionUIContext;
}
