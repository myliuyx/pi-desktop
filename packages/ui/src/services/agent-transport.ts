/**
 * 真实链路传输层（C2）—— 浏览器经 core 与真实模型对话。
 *
 * 设计纪律（S6 + 硬约束 #2）：
 * - 本文件是 UI 运行时代码，**只 `import type` 契约**（AgentEvent），绝不 import
 *   `pi-coding-agent` / `@agent/core` 运行时 / `node:*`（vite build 后 dist 无这些痕迹）；
 * - 仅用浏览器原生 `fetch` + 流式读取 SSE（EventSource 不能带 Authorization 头，故手写）；
 * - 默认 `baseUrl` 为相对路径 ""（core 同源托管 UI 时零配置）；dev 下可用 `?core=`
 *   覆盖（但跨源受 core 安全模型限制，生产形态是 core 同源 serve）。
 */

import type { AgentEvent } from "@/adapter/pi-events";
import type {
  ModelsPayload,
  ResourcesPayload,
  SessionLoadResult,
  SessionSummary,
  ThinkingLevelName,
  ToolsPayload,
} from "@/mock/types";
import type {
  CatalogPayload,
  ModelTestRequest,
  ModelTestResult,
  ProviderModelsRequest,
  ProviderModelsResult,
  ProvidersPayload,
  ProvidersSaveResult,
  PutProvidersRequest,
} from "@/mock/provider-contract";

/**
 * 浏览器侧唯一依赖的传输契约（S6 §三草案，C2 落地子集 + C4/C5 补全会话与 04/05 屏）。
 *
 * ⚠️ C4 对 `loadSession` 返回值的口径：S6 §三写的是 `Promise<Session>`，
 * 这里返回 `SessionLoadResult`（= `Session` 的超集：多带 `tokenUsage` 与映射统计）。
 * 结构上可直接当 `Session` 用，且省掉 UI 为拿 token 用量再查一次清单。
 */
export interface TransportHooks {
  /** SSE 连接失败 / 断开（含重连期间） */
  onConnectionError?: (message: string) => void;
  /** 重连成功 */
  onConnectionRestored?: () => void;
}

/**
 * `GET /sessions` 的返回（C4 新增 `cwd` 之后）。
 *
 * - `cwd`：core 进程**真实生效的工作目录**（`runtime.getCwd()`，即 `CORE_CWD` 或
 *   `process.cwd()`）。UI 侧**只读展示**，且**取不到时必须显式降级**，
 *   绝不许回落成本地记录值 —— 用本地值冒充"当前会话目录"就是造一个很像真的假事实
 *   （同「无模型别回落 mock modelId」的铁律）。
 * - `sessions`：当前目录的历史会话清单；清单为空时也保证是数组（调用方无需判 null）。
 */
export interface SessionListResult {
  cwd: string | null;
  sessions: SessionSummary[];
}

export interface AgentTransport {
  /** 发送一条用户消息 */
  sendMessage(text: string): Promise<void>;
  /** 中止当前流式输出 */
  abort(): Promise<void>;
  /** 回收授权（Pi 的 select/confirm/input 应答） */
  resolveApproval(requestId: string, choice: string): Promise<void>;
  /** 取消授权（独立方法，不污染 resolveApproval 语义；C3 授权闭环才真正生效） */
  cancelApproval(requestId: string): Promise<void>;
  /** 订阅 core 下发的 AgentEvent 流；返回取消订阅函数 */
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /** 注册连接状态回调（由 chat-store 在 ensureLive 时调用；传输层因此不依赖任何 store） */
  setHooks(hooks: TransportHooks): void;

  /* ---------------------------------------------------------------- C4 · 会话 */
  /** 当前工作目录的历史会话清单 + core 的真实 cwd（Sidebar 在 live 形态下的数据源） */
  listSessions(): Promise<SessionListResult>;
  /** 按 id 加载历史会话（返回 `Message[]` + 标题/时间/token 用量） */
  loadSession(id: string): Promise<SessionLoadResult>;
  /** 续接最近一次会话（只读） */
  continueRecentSession(): Promise<SessionLoadResult>;

  /* ------------------------------------------------- C5 · 04/05 屏数据源 */
  /** 04 屏：扩展 / 提示词 / 技能三类（已按信任门过滤项目本地资源） */
  listResources(): Promise<ResourcesPayload>;
  /** 05 屏：可选模型 + 当前模型 + 思考档位 + `settings.json` 现值 */
  listModels(): Promise<ModelsPayload>;
  /** 05 屏：切换模型（core 侧写回 `settings.json`） */
  setModel(provider: string, modelId: string): Promise<ModelsPayload>;
  /** 05 屏：切换思考档位（core 侧写回 `settings.json`） */
  setThinkingLevel(level: ThinkingLevelName): Promise<ModelsPayload>;

  /* ------------------------------------------------- C6 · 04 屏工具开关 */
  /** 04 屏：当前启用的工具名与可启用全集（live 形态下开关初始态的数据源） */
  listActiveTools(): Promise<ToolsPayload>;
  /** 04 屏：设置启用工具集（core 转发 Pi 的 `setActiveToolsByName`，下一 agent 轮次生效） */
  setActiveTools(names: string[]): Promise<ToolsPayload>;

  /* ------------------------------------------------- C2 · 模型接真（设置弹窗） */
  /** 设置弹窗：读 models.json + sidecar 合并清单（D6：apiKey 原文）；失败抛错（UI 回落 mock） */
  listProviders(): Promise<ProvidersPayload>;
  /** 设置弹窗：全量替换写回（按 enabled 拆分 models.json / sidecar）；fallbackApplied 时带 warning */
  saveProviders(req: PutProvidersRequest): Promise<ProvidersSaveResult>;
  /** 设置弹窗：内置目录检索（models.dev 快照，不出网），供「导入模型…」 */
  searchCatalog(query: string): Promise<CatalogPayload>;
  /** 设置弹窗：一次性最小真实请求（max_tokens:1）测连通性；不落盘、不改当前选择 */
  testModel(req: ModelTestRequest): Promise<ModelTestResult>;
  /** 设置弹窗：拉取该 Provider 的真实模型清单（`GET {baseUrl}/models`）供「导入模型…」勾选 */
  listProviderModels(req: ProviderModelsRequest): Promise<ProviderModelsResult>;
}

export interface LiveConfig {
  /** core 基址；同源时填 "" */
  baseUrl: string;
  /** Bearer token（来自 run/core.json，经 `?token=` 注入页面） */
  token: string;
}

function isAgentEvent(value: unknown): value is AgentEvent {
	if (!value || typeof value !== "object") return false;
	const t = (value as { type?: unknown }).type;
	return typeof t === "string";
}

export class HttpAgentTransport implements AgentTransport {
  private listeners = new Set<(e: AgentEvent) => void>();
  private esAbort: AbortController | null = null;
  private hooks: TransportHooks = {};
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private outageNotified = false;

  constructor(private readonly cfg: LiveConfig) {}

  setHooks(hooks: TransportHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  /** 同一断线周期内只通知一次，避免退避重试把提示刷屏；恢复后由成功分支复位 */
  private notifyOutage(message: string): void {
    if (this.outageNotified) return;
    this.outageNotified = true;
    this.hooks.onConnectionError?.(message);
  }

  /** 指数退避重连（1s → 2s → … 上限 30s）；无订阅者或已有定时器时不动 */
  private scheduleReconnect(): void {
    if (this.listeners.size === 0 || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectSse();
    }, delay);
  }

  private authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.token}` };
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    if (!this.esAbort && !this.reconnectTimer) void this.connectSse();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.disconnectSse();
    };
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event);
  }

  private async connectSse(): Promise<void> {
    const ctrl = new AbortController();
    this.esAbort = ctrl;
    const url = `${this.cfg.baseUrl}/events`;
    try {
      const res = await fetch(url, { headers: this.authHeader(), signal: ctrl.signal });
      if (!res.ok || !res.body) {
        console.error("[live] SSE 连接失败:", res.status);
        this.esAbort = null;
        this.notifyOutage(`与 core 的事件流连接失败（HTTP ${res.status}），正在重连…`);
        this.scheduleReconnect();
        return;
      }
      // 连上：以「是否通知过断线」为恢复信号 —— 首次连接即失败再重试成功也能提示恢复
      if (this.outageNotified) this.hooks.onConnectionRestored?.();
      this.reconnectAttempts = 0;
      this.outageNotified = false;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (isAgentEvent(event)) this.emit(event);
          } catch {
            /* 忽略坏行 */
          }
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        console.error("[live] SSE 异常:", e);
        this.notifyOutage(`与 core 的事件流中断，正在重连…`);
      }
    } finally {
      if (this.esAbort === ctrl) this.esAbort = null;
      // 正常读完（core 重启导致流结束）也要重连；被 abort 断开则不重连
      if (!ctrl.signal.aborted) this.scheduleReconnect();
    }
  }

  private disconnectSse(): void {
    this.esAbort?.abort();
    this.esAbort = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.outageNotified = false;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, { headers: this.authHeader() });
    if (!res.ok) throw new Error(`core ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeader() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`core ${path} -> ${res.status}`);
    try {
      return (await res.json()) as T;
    } catch {
      return null as T;
    }
  }

  private async put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...this.authHeader() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`core ${path} -> ${res.status}`);
    try {
      return (await res.json()) as T;
    } catch {
      return null as T;
    }
  }

  /**
   * C2 端点响应解包：core 对「业务失败但不 500」的端点返回 `{ error }`（无 `ok` 字段），
   * 成功返回 `{ ok: true, ...payload }`。这里把前者转成 throw，调用方 catch 后走回落分支。
   * （`ModelTestResult` 的 `ok:false` 带 `error` 属正常业务结果，有 `ok` 字段，不会误伤。）
   */
  private unwrap<T>(body: unknown): T {
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      !("ok" in body)
    ) {
      throw new Error(String((body as { error: unknown }).error));
    }
    return body as T;
  }

  sendMessage(text: string): Promise<void> {
    return this.post("/prompt", { text }) as Promise<void>;
  }

  abort(): Promise<void> {
    return this.post("/abort", {}) as Promise<void>;
  }

  resolveApproval(requestId: string, choice: string): Promise<void> {
    return this.post("/approve", { requestId, choice }) as Promise<void>;
  }

  cancelApproval(requestId: string): Promise<void> {
    // C3：独立端点（不再借用 /approve 的保留值）—— core 侧分辨「取消」与「拒绝」两种语义：
    // 取消会让扩展读到「用户取消」（select → undefined / confirm → false），与选某个选项不同。
    return this.post("/cancel-approval", { requestId }) as Promise<void>;
  }

  /* ------------------------------------------------------------------ C4 */

  async listSessions(): Promise<SessionListResult> {
    // core 的响应是 `{ ok, cwd, sessions }`（server.ts:324）；清单为空时也必须返回数组
    const body = await this.get<{ cwd?: unknown; sessions?: SessionSummary[] }>("/sessions");
    return {
      // 空串 / 非字符串一律视为「拿不到」⇒ null，由调用方显式降级（不在此处编一个值）
      cwd: typeof body?.cwd === "string" && body.cwd.length > 0 ? body.cwd : null,
      sessions: Array.isArray(body?.sessions) ? body.sessions : [],
    };
  }

  loadSession(id: string): Promise<SessionLoadResult> {
    return this.post<SessionLoadResult>("/sessions/load", { id });
  }

  continueRecentSession(): Promise<SessionLoadResult> {
    return this.post<SessionLoadResult>("/sessions/continue-recent", {});
  }

  /* ------------------------------------------------------------------ C5 */

  listResources(): Promise<ResourcesPayload> {
    return this.get<ResourcesPayload>("/resources");
  }

  listModels(): Promise<ModelsPayload> {
    return this.get<ModelsPayload>("/models");
  }

  setModel(provider: string, modelId: string): Promise<ModelsPayload> {
    return this.post<ModelsPayload>("/models/select", { provider, modelId });
  }

  setThinkingLevel(level: ThinkingLevelName): Promise<ModelsPayload> {
    return this.post<ModelsPayload>("/thinking", { level });
  }

  /* ------------------------------------------------------------------ C6 */

  listActiveTools(): Promise<ToolsPayload> {
    return this.get<ToolsPayload>("/tools/active");
  }

  setActiveTools(names: string[]): Promise<ToolsPayload> {
    return this.post<ToolsPayload>("/tools/active", { names });
  }

  /* ------------------------------------------------------------------ C2 */

  async listProviders(): Promise<ProvidersPayload> {
    return this.unwrap<ProvidersPayload>(await this.get("/providers"));
  }

  async saveProviders(req: PutProvidersRequest): Promise<ProvidersSaveResult> {
    return this.unwrap<ProvidersSaveResult>(await this.put("/providers", req));
  }

  async searchCatalog(query: string): Promise<CatalogPayload> {
    return this.unwrap<CatalogPayload>(
      await this.get(`/models/catalog?q=${encodeURIComponent(query)}`),
    );
  }

  async testModel(req: ModelTestRequest): Promise<ModelTestResult> {
    return this.unwrap<ModelTestResult>(await this.post("/models/test", req));
  }

  async listProviderModels(req: ProviderModelsRequest): Promise<ProviderModelsResult> {
    // 上游失败时 core 回的是 200 + {ok:false,error}（不是抛出），所以这里直接透传
    return this.unwrap<ProviderModelsResult>(await this.post("/providers/models", req));
  }
}
