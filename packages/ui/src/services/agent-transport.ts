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
} from "@/mock/types";

/**
 * 浏览器侧唯一依赖的传输契约（S6 §三草案，C2 落地子集 + C4/C5 补全会话与 04/05 屏）。
 *
 * ⚠️ C4 对 `loadSession` 返回值的口径：S6 §三写的是 `Promise<Session>`，
 * 这里返回 `SessionLoadResult`（= `Session` 的超集：多带 `tokenUsage` 与映射统计）。
 * 结构上可直接当 `Session` 用，且省掉 UI 为拿 token 用量再查一次清单。
 */
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

  /* ---------------------------------------------------------------- C4 · 会话 */
  /** 当前工作目录的历史会话清单（Sidebar 在 live 形态下的数据源） */
  listSessions(): Promise<SessionSummary[]>;
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

  constructor(private readonly cfg: LiveConfig) {}

  private authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.token}` };
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    if (!this.esAbort) void this.connectSse();
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
        return;
      }
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
      if (!ctrl.signal.aborted) console.error("[live] SSE 异常:", e);
    } finally {
      if (this.esAbort === ctrl) this.esAbort = null;
    }
  }

  private disconnectSse(): void {
    this.esAbort?.abort();
    this.esAbort = null;
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

  async listSessions(): Promise<SessionSummary[]> {
    // core 的响应是 `{ ok, cwd, sessions }`；清单为空时也必须返回数组（UI 侧无需再判 null）
    const body = await this.get<{ sessions?: SessionSummary[] }>("/sessions");
    return Array.isArray(body?.sessions) ? body.sessions : [];
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
}
