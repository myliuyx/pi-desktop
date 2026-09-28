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
	PackageInstallRequest,
	PackageInstallResult,
	PackageRemoveRequest,
	PackageRemoveResult,
	PackageToggleRequest,
	PackageToggleResult,
	PackageUpdateRequest,
	PackageUpdateResult,
	PackagesPayload,
	PackageUpdatesPayload,
	ResourcesPayload,
	SessionLoadResult,
	SessionReloadResult,
	SessionSummary,
	SkillToggleRequest,
	SkillToggleResult,
	SkillsPayload,
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

/** `POST /cwd` 的成功返回（D7）：新 cwd + 该目录的信任门结论（UI 据此在提示里补「未信任」说明） */
export interface CwdSwitchResult {
  cwd: string;
  trust: { trusted: boolean } | null;
}

/** `GET /fs/list` 条目（dir-tree 批次 §4.0：kind 恒返回；dir-picker 旧 core 兼容由 listDirs 归一） */
export interface DirEntryResult {
  name: string;
  path: string;
  kind: "dir" | "file";
}

/** `GET /fs/list` 的成功返回（dir-picker 批次，契约 task-dir-picker.md §4.0 / dir-tree §4.0） */
export interface DirListResult {
  /** 归一化后的绝对路径（回显到弹窗输入框） */
  path: string;
  /** 上一级；已在根（POSIX 根 / 盘根 / UNC 根）时为 null */
  parent: string | null;
  /**
   * 缺省仅目录（dir-picker）；`includeFiles` 时目录组在前、文件组在后，
   * 各组按 name 码元排序；超 500 条已被 core 截断。
   */
  entries: DirEntryResult[];
  truncated: boolean;
  /** 仅 win32 且处于根目录时非 null，如 ["C:\\","D:\\"] */
  drives: string[] | null;
}

/** `GET /fs/read` 的成功返回（dir-file-preview 批次，core 的 fs-read.ts 为权威源） */
export interface FileReadResult {
  /** 归一化后的绝对路径 */
  path: string;
  /** 文件名（basename），预览区标题直接用 */
  name: string;
  /** 真实文件大小（字节；truncated 时 > content 的字节数） */
  size: number;
  /** 内容超出 256KB 上限被截断 */
  truncated: boolean;
  /** 二进制时恒为空串 */
  content: string;
  /** 二进制文件（首 8KB 含 0x00）：预览区不渲染内容 */
  binary: boolean;
}

/** `GET /fs/search` 条目（at-file 批次 §4.1，core 的 fs-search.ts 为权威源；目录也可引用，D6） */
export interface FsSearchEntryResult {
  name: string;
  /** 绝对路径（title / 调试展示用） */
  absPath: string;
  /** 相对搜索根的 POSIX 风格路径——@引用的展示与插入口径，core 端按自身 cwd 反解 */
  relPath: string;
  /** 目录（@ = 一层清单块）/ 文件（@ = `<file>` 内容块）；旧字段缺失回落 file */
  kind: "dir" | "file";
}

/** `GET /fs/search` 的成功返回（at-file 批次） */
export interface FsSearchResult {
  cwd: string;
  query: string;
  entries: FsSearchEntryResult[];
  truncated: boolean;
}

/** `POST /prompt` 的返回（at-file 批次 §4.2）：无 skippedFiles 时恒空数组 */
export interface PromptSendResult {
  /** 被跳过的 @file 引用（用户输入原样 + 括注原因），UI 据此弹通知 */
  skippedFiles: string[];
}

export interface AgentTransport {
  /**
   * 发送一条用户消息。`opts.fileRefs`（at-file 批次）= 消息文本中的 @引用文件列表，
   * core 展开成 `<file>` 块/图片附件后发给模型；缺省/空数组时请求体与旧版逐字节相同。
   * 返回 skippedFiles（core 读不到的引用），UI 据此弹通知。
   */
  sendMessage(text: string, opts?: { fileRefs?: string[] }): Promise<PromptSendResult>;
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
  /**
   * 新建（换入）一个空白活动会话（task-new-session-page.md §4.8 · D6/D7）：
   * 只换 core 内存里的活动会话，Pi 在首条 entry 追加时才落盘文件 ——
   * 所以调用时机是**草稿态首条消息发送时**（不是点「新建会话」按钮时）。
   * 返回新会话 id；流式中（409）等失败抛错，文案取 core 的 `{ error }` 原文。
   */
  newSession(): Promise<{ id: string }>;
  /**
   * 重命名会话（2026-09-28 用户需求：侧栏历史会话行内改名）：core 往会话文件追加
   * session_info name entry，清单/加载标题的 name 口径天然生效。失败（400 空标题 /
   * 404 会话不存在）抛错，文案取 core 的 `{ error }` 原文。
   */
  renameSession(id: string, title: string): Promise<void>;
  /**
   * 删除会话：core unlink 会话文件；目标 = 活动会话时 core 内部先换入空白会话。
   * 失败（404 不存在 / 409 流式中删除活动会话）抛错，文案取 core 的 `{ error }` 原文。
   */
  deleteSession(id: string): Promise<void>;
  /**
   * 运行期热切换工作目录（D7，2026-09-24 裁决）：`dir=null` = core 默认目录
   * （`process.cwd()`）。成功后 core 会经 SSE 广播 `cwd_changed`（UI 重拉清单）。
   * 流式中（409）/ 目录无效（400）抛错，错误文案取 core 的 `{ error }` 原文。
   */
  switchCwd(dir: string | null): Promise<CwdSwitchResult>;
  /**
   * 目录浏览（dir-picker 批次；dir-tree 批次加 `opts.includeFiles`）：`GET /fs/list?path=...`。
   * `path` 缺省（null/undefined/空串）= core 当前 cwd（服务端决定起始目录，UI 不猜）；
   * `includeFiles` = 文件一并列入（目录组在前、文件组在后，task-sidebar-file-tree.md §4.0）。
   * 旧 core 忽略该参数 ⇒ 只回目录且无 kind，此处按 "dir" 归一（§三 兼容性行）。
   * 失败（400 目录不存在 / 403 无权限 / 网络错）抛错，文案取 core 的 `{ error }` 原文。
   */
  listDirs(path?: string | null, opts?: { includeFiles?: boolean }): Promise<DirListResult>;
  /**
   * 文件读取（dir-file-preview 批次）：`GET /fs/read?path=...`。
   * 只读限长文本（256KB 上限，超限 truncated:true；二进制 binary:true 且 content 为空）。
   * 失败（400 不存在/不是文件 / 403 无权限 / 网络错）抛错，文案取 core 的 `{ error }` 原文。
   */
  readFile(path: string): Promise<FileReadResult>;
  /**
   * 文件模糊搜索（at-file 批次）：`GET /fs/search?q=&path=&limit=`。
   * `path` 恒传 liveCwd（根与「core 当前 cwd」是两个概念，同文件树口径）；
   * 只列文件，POSIX relPath；失败（400 不存在/不是目录 / 403 / 旧 core 无此路由）抛错。
   */
  searchFiles(path: string, query: string, limit?: number): Promise<FsSearchResult>;

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

  /* ------------------------------------------------- C7 · 设置弹窗 · 技能 Tab */
  /**
   * 设置弹窗 · 技能 Tab：**全量**清单（含被 `!路径` 模式禁用的条目 —— 与 04 屏
   * `listResources()` 的已加载子集是两回事）。失败抛错，文案取 core 的 `{ error }` 原文。
   */
  listSkills(): Promise<SkillsPayload>;
  /**
   * 设置弹窗 · 技能 Tab：切换启用态（core 写 settings 模式数组 → `session.reload()`）。
   * 返回切换后的**最新清单**（UI 直接整体替换，免二次拉取）。
   * 流式中（409）/ 技能不存在（404）抛错，文案取 core 的 `{ error }` 原文。
   */
  toggleSkill(req: SkillToggleRequest): Promise<SkillToggleResult>;

  /* ------------------------------------------------- C8 · 设置弹窗 · 插件 Tab */
  /**
   * 设置弹窗 · 插件 Tab：**全量**已配置包清单（user+project 双 scope，含未安装的
   * missing 项）+ 四类启用计数（底部统计条口径）。失败抛错，文案取 core 原文。
   */
  listPackages(): Promise<PackagesPayload>;
  /** 设置弹窗 · 插件 Tab：整包启用/禁用（settings 对象形 `{source, autoload:false}` → `session.reload()`）；返回最新清单 */
  togglePackage(req: PackageToggleRequest): Promise<PackageToggleResult>;
  /** 设置弹窗 · 插件 Tab：移除包（removeAndPersist；npm 卸载 / git 删克隆 / 本地仅删条目）；返回最新清单 */
  removePackage(req: PackageRemoveRequest): Promise<PackageRemoveResult>;
  /** 设置弹窗 · 插件 Tab：重新加载会话（`session.reload()`，重读 settings+资源+扩展，历史保留）；流式中 409 */
  reloadSession(): Promise<SessionReloadResult>;
  /**
   * 设置弹窗 · 插件 Tab（B2）：安装包（installAndPersist；npm/git 需联网，进度走 SSE
   * `package_progress`）。失败抛错（source 非法 / 网络 / git 缺失），文案取 core 原文。
   */
  installPackage(req: PackageInstallRequest): Promise<PackageInstallResult>;
  /** 设置弹窗 · 插件 Tab（B2）：检查更新（npm view / git ls-remote；本地路径包自动跳过）；失败抛错 */
  checkPackageUpdates(): Promise<PackageUpdatesPayload>;
  /** 设置弹窗 · 插件 Tab（B2）：更新包（缺 source = 全部已配置包）；失败抛错 */
  updatePackage(req: PackageUpdateRequest): Promise<PackageUpdateResult>;
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
      // 200 却非 event-stream = 旧 core 把 /events 落进 SPA 回退（200 HTML）：照读不报错的
      // 话表现为「连上了但永远没事件」的死等，这里与断线同口径处理（触发提示与重连）
      const sseCt = res.headers.get("content-type") ?? "";
      if (!res.ok || !res.body || !sseCt.includes("text/event-stream")) {
        console.error("[live] SSE 连接失败:", res.status, sseCt);
        this.esAbort = null;
        this.notifyOutage(
          res.ok && !sseCt.includes("text/event-stream")
            ? "与 core 的事件流连接异常（响应非 SSE 流，core 版本可能落后于前端），正在重连…"
            : `与 core 的事件流连接失败（HTTP ${res.status}），正在重连…`,
        );
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
    this.assertJson(res, `core ${path}`);
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeader() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`core ${path} -> ${res.status}`);
    this.assertJson(res, `core ${path}`);
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
    this.assertJson(res, `core ${path}`);
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

  /**
   * SPA 回退伪装识别点（2026-09-28 review P1 第二层纵深）：core 对全部数据端点（含错误
   * 响应）都回 application/json，唯独「API_ROUTES 声明了却没实现」的请求在旧 core 上会
   * 落进 SPA 回退回 200 HTML —— 此时 `!res.ok` 拦不住（状态码真是 200），res.json() 抛
   * SyntaxError 又把根因埋掉（9-28 技能清单事故「HTTP 200」文案的来源）。content-type
   * 由服务端写死、前端伪造不了，故在 res.json() 之前最先暴露真相。
   */
  private assertJson(res: Response, label: string): void {
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      throw new Error(`${label}（响应非 JSON，core 版本可能落后于前端）`);
    }
  }

  async sendMessage(text: string, opts?: { fileRefs?: string[] }): Promise<PromptSendResult> {
    // fileRefs 缺省/空时不带字段——请求体与旧版逐字节相同（旧 core 零风险）
    const refs = opts?.fileRefs && opts.fileRefs.length > 0 ? { fileRefs: opts.fileRefs } : {};
    const body = await this.post<{ ok?: boolean; skippedFiles?: unknown }>("/prompt", { text, ...refs });
    return {
      skippedFiles: Array.isArray(body?.skippedFiles)
        ? body.skippedFiles.filter((s): s is string => typeof s === "string")
        : [],
    };
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

  /**
   * task-new-session-page.md §4.8：`POST /sessions/new` 回 `{ ok, id }`。
   * 不借用通用 `this.post` 的裸透传 —— 失败时要拿 core 的 `{ error }` 原文
   * （「会话正在生成回复…」这类文案 UI 要原样给用户，switchCwd 同款手法）。
   */
  async newSession(): Promise<{ id: string }> {
    const body = await this.post<{ ok?: boolean; id?: unknown; error?: unknown }>("/sessions/new", {});
    if (!body?.ok || typeof body.id !== "string" || body.id.length === 0) {
      const detail = body && typeof body.error === "string" && body.error ? body.error : null;
      throw new Error(detail ?? "新建会话失败");
    }
    return { id: body.id };
  }

  /** 不用通用 `this.post`（丢 core 文案）：rename/delete 的 404/409 文案要原样给用户，switchCwd 同款手法。 */
  private async postSessionManage(path: "/sessions/rename" | "/sessions/delete", body: Record<string, string>): Promise<void> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeader() },
      body: JSON.stringify(body),
    });
    this.assertJson(res, `core ${path}`);
    const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: unknown } | null;
    if (!res.ok || !payload?.ok) {
      const detail = typeof payload?.error === "string" && payload.error ? payload.error : null;
      throw new Error(detail ?? `core ${path} -> ${res.status}`);
    }
  }

  async renameSession(id: string, title: string): Promise<void> {
    await this.postSessionManage("/sessions/rename", { id, title });
  }

  async deleteSession(id: string): Promise<void> {
    await this.postSessionManage("/sessions/delete", { id });
  }

  /**
   * D7：不通用 `this.post` —— 它对非 200 只给 `core /cwd -> 409`，丢掉 core 的
   * `{ error }` 友好文案（流式中 / 目录无效），而这两类失败 UI 要原样提示给用户。
   */
  async switchCwd(dir: string | null): Promise<CwdSwitchResult> {
    const res = await fetch(`${this.cfg.baseUrl}/cwd`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeader() },
      body: JSON.stringify(dir === null ? {} : { dir }),
    });
    this.assertJson(res, "切换工作目录失败");
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      cwd?: unknown;
      trust?: unknown;
      error?: unknown;
    } | null;
    if (!res.ok || !body?.ok || typeof body.cwd !== "string") {
      const detail = typeof body?.error === "string" && body.error ? body.error : null;
      throw new Error(detail ?? `切换工作目录失败（HTTP ${res.status}）`);
    }
    const trust = body.trust;
    return {
      cwd: body.cwd,
      trust:
        trust && typeof trust === "object" && typeof (trust as { trusted?: unknown }).trusted === "boolean"
          ? (trust as { trusted: boolean })
          : null,
    };
  }

  /**
   * task-dir-picker.md §4.2：不用通用 `this.get` —— 它对非 200 只给 `core /fs/list -> 400`，
   * 丢掉 core 的 `{ error }` 文案（「目录不存在：…」这类 UI 要原样给用户），switchCwd 同款手法。
   */
  async listDirs(path?: string | null, opts?: { includeFiles?: boolean }): Promise<DirListResult> {
    // 手拼 query 与原实现同款（encodeURIComponent 各段独立）；include=files 仅在显式要求时追加
    const parts: string[] = [];
    if (path && path.trim().length > 0) parts.push(`path=${encodeURIComponent(path)}`);
    if (opts?.includeFiles) parts.push("include=files");
    const query = parts.length > 0 ? `?${parts.join("&")}` : "";
    const res = await fetch(`${this.cfg.baseUrl}/fs/list${query}`, { headers: this.authHeader() });
    this.assertJson(res, "读取目录失败");
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      path?: unknown;
      parent?: unknown;
      entries?: unknown;
      truncated?: unknown;
      drives?: unknown;
      error?: unknown;
    } | null;
    if (!res.ok || !body?.ok || typeof body.path !== "string" || !Array.isArray(body.entries)) {
      const detail = typeof body?.error === "string" && body.error ? body.error : null;
      throw new Error(detail ?? `读取目录失败（HTTP ${res.status}）`);
    }
    const entries = body.entries.filter(
      (e): e is { name: string; path: string; kind: "dir" | "file" } =>
        !!e &&
        typeof e === "object" &&
        typeof (e as { name?: unknown }).name === "string" &&
        typeof (e as { path?: unknown }).path === "string",
      // kind 不在准入条件里：旧 core 无该字段，下方归一补 "dir"（§三 兼容性行）
    ).map((e) => ({ ...e, kind: (e as { kind?: unknown }).kind === "file" ? ("file" as const) : ("dir" as const) }));
    return {
      path: body.path,
      parent: typeof body.parent === "string" && body.parent.length > 0 ? body.parent : null,
      entries,
      truncated: body.truncated === true,
      drives: Array.isArray(body.drives) ? body.drives.filter((d): d is string => typeof d === "string") : null,
    };
  }

  /**
   * dir-file-preview：不用通用 `this.get` —— 它对非 200 只给 `core /fs/read -> 400`，
   * 丢掉 core 的 `{ error }` 文案（「文件不存在：…」这类 UI 要原样给用户），listDirs 同款手法。
   */
  async readFile(path: string): Promise<FileReadResult> {
    const res = await fetch(`${this.cfg.baseUrl}/fs/read?path=${encodeURIComponent(path)}`, {
      headers: this.authHeader(),
    });
    this.assertJson(res, "读取文件失败");
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      path?: unknown;
      name?: unknown;
      size?: unknown;
      truncated?: unknown;
      content?: unknown;
      binary?: unknown;
      error?: unknown;
    } | null;
    if (!res.ok || !body?.ok || typeof body.path !== "string" || typeof body.content !== "string") {
      const detail = typeof body?.error === "string" && body.error ? body.error : null;
      throw new Error(detail ?? `读取文件失败（HTTP ${res.status}）`);
    }
    return {
      path: body.path,
      name: typeof body.name === "string" ? body.name : path.split(/[\\/]/).pop() ?? path,
      size: typeof body.size === "number" ? body.size : 0,
      truncated: body.truncated === true,
      content: body.content,
      binary: body.binary === true,
    };
  }

  /**
   * at-file 批次：listDirs 同款手法（不通用 `this.get`——非 200 要拿 core 的 `{ error }`
   * 原文；旧 core 无此路由时由 assertJson 报「响应非 JSON」，SPA 回退伪装被当场识破）。
   */
  async searchFiles(path: string, query: string, limit?: number): Promise<FsSearchResult> {
    const parts: string[] = [`q=${encodeURIComponent(query)}`];
    if (path && path.trim().length > 0) parts.push(`path=${encodeURIComponent(path)}`);
    if (limit !== undefined) parts.push(`limit=${encodeURIComponent(String(limit))}`);
    const res = await fetch(`${this.cfg.baseUrl}/fs/search?${parts.join("&")}`, {
      headers: this.authHeader(),
    });
    this.assertJson(res, "搜索文件失败");
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      cwd?: unknown;
      query?: unknown;
      entries?: unknown;
      truncated?: unknown;
      error?: unknown;
    } | null;
    if (!res.ok || !body?.ok || !Array.isArray(body.entries)) {
      const detail = typeof body?.error === "string" && body.error ? body.error : null;
      throw new Error(detail ?? `搜索文件失败（HTTP ${res.status}）`);
    }
    const entries = body.entries.filter(
      (e): e is { name: string; absPath: string; relPath: string; kind?: unknown } =>
        !!e &&
        typeof e === "object" &&
        typeof (e as { name?: unknown }).name === "string" &&
        typeof (e as { absPath?: unknown }).absPath === "string" &&
        typeof (e as { relPath?: unknown }).relPath === "string",
    ).map((e) => ({
      name: e.name,
      absPath: e.absPath,
      relPath: e.relPath,
      // kind 不在准入条件里（同 dir-tree 批次的旧 core 兼容口径）：非 "dir" 一律回落 file
      kind: e.kind === "dir" ? ("dir" as const) : ("file" as const),
    }));
    return {
      cwd: typeof body.cwd === "string" ? body.cwd : "",
      query: typeof body.query === "string" ? body.query : query,
      entries,
      truncated: body.truncated === true,
    };
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

  /* ------------------------------------------------- C7 · 设置弹窗 · 技能 Tab */

  /**
   * C7：不用通用 `this.get` —— 它对非 200 只给 `core /skills -> 500`，丢掉 core 的
   * `{ error }` 文案（清单解析失败等原因 UI 要原样显示），switchCwd 同款手法。
   */
  async listSkills(): Promise<SkillsPayload> {
    const res = await fetch(`${this.cfg.baseUrl}/skills`, { headers: this.authHeader() });
    this.assertJson(res, "读取技能清单失败");
    const body = (await res.json().catch(() => null)) as
      | (SkillsPayload & { ok?: unknown; error?: unknown })
      | null;
    if (!res.ok || body?.ok !== true || !Array.isArray(body.skills)) {
      const detail = typeof body?.error === "string" && body.error ? body.error : null;
      throw new Error(detail ?? `读取技能清单失败（HTTP ${res.status}）`);
    }
    return body;
  }

  /**
   * C7：不用通用 `this.post` —— 流式中（409）/ 技能不存在（404）/ 写入失败（500）
   * 的 core `{ error }` 文案要原样抛给 UI 提示，通用版只给状态码。
   */
  async toggleSkill(req: SkillToggleRequest): Promise<SkillToggleResult> {
    const res = await fetch(`${this.cfg.baseUrl}/skills/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeader() },
      body: JSON.stringify(req),
    });
    this.assertJson(res, "切换技能失败");
    const body = (await res.json().catch(() => null)) as {
      ok?: unknown;
      skills?: SkillsPayload;
      error?: unknown;
    } | null;
    if (!res.ok || body?.ok !== true || !body.skills) {
      const detail = typeof body?.error === "string" && body.error ? body.error : null;
      throw new Error(detail ?? `切换技能失败（HTTP ${res.status}）`);
    }
    return { skills: body.skills };
  }

  /* ------------------------------------------------- C8 · 设置弹窗 · 插件 Tab */

  /** C8 通用解包：`{ ok:true, ...payload }` → payload；其余（含 core `{ error }` 原文）抛错 */
  private async unwrapPackages<T>(res: Response, fallbackLabel: string): Promise<T> {
    this.assertJson(res, fallbackLabel);
    const body = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null;
    if (!res.ok || (body as { ok?: unknown } | null)?.ok !== true) {
      const detail = typeof body?.error === "string" && body.error ? body.error : null;
      throw new Error(detail ?? `${fallbackLabel}（HTTP ${res.status}）`);
    }
    // ok===true 已在上方闸门验证；此处收窄回 T（error 字段是响应体多余键，调用方不读）
    return body as T;
  }

  private postPackages<T>(path: string, body: unknown, fallbackLabel: string): Promise<T> {
    return fetch(`${this.cfg.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeader() },
      body: JSON.stringify(body ?? {}),
    }).then((res) => this.unwrapPackages<T>(res, fallbackLabel));
  }

  async listPackages(): Promise<PackagesPayload> {
    const res = await fetch(`${this.cfg.baseUrl}/packages`, { headers: this.authHeader() });
    this.assertJson(res, "读取插件清单失败");
    const body = (await res.json().catch(() => null)) as
      | (PackagesPayload & { ok?: unknown; error?: unknown })
      | null;
    if (!res.ok || body?.ok !== true || !Array.isArray(body.packages)) {
      const detail = typeof body?.error === "string" && body.error ? body.error : null;
      throw new Error(detail ?? `读取插件清单失败（HTTP ${res.status}）`);
    }
    return body;
  }

  togglePackage(req: PackageToggleRequest): Promise<PackageToggleResult> {
    return this.postPackages<PackageToggleResult>("/packages/toggle", req, "切换插件失败");
  }

  removePackage(req: PackageRemoveRequest): Promise<PackageRemoveResult> {
    return this.postPackages<PackageRemoveResult>("/packages/remove", req, "移除插件失败");
  }

  reloadSession(): Promise<SessionReloadResult> {
    return this.postPackages<SessionReloadResult>("/session/reload", {}, "重新加载会话失败");
  }

  installPackage(req: PackageInstallRequest): Promise<PackageInstallResult> {
    return this.postPackages<PackageInstallResult>("/packages/install", req, "安装插件失败");
  }

  checkPackageUpdates(): Promise<PackageUpdatesPayload> {
    return this.postPackages<PackageUpdatesPayload>("/packages/check-updates", {}, "检查更新失败");
  }

  updatePackage(req: PackageUpdateRequest): Promise<PackageUpdateResult> {
    return this.postPackages<PackageUpdateResult>("/packages/update", req, "更新插件失败");
  }
}
