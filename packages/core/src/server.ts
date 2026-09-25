/**
 * core HTTP + SSE 服务 —— 默认绑定 127.0.0.1（CORE_HOST 可放开），安全三件套（S6 §七）：
 * ① 随机 token（Bearer）；② 校验 Host 头防 DNS rebinding；③ 拒绝跨来源（无 CORS）。
 *
 * 事件管道：
 * - Pi 原始事件经 `toAgentEvent` 翻译成我们的 AgentEvent，再经 SSE 广播；
 * - `message_update` 做 16–33ms 合并（同 Block 只发最新快照），避免渲染风暴；
 * - 终态事件（agent_end / agent_settled / approval_request / tool_execution_* 的 start/end）
 *   不参与合并、立即下发，否则 UI 永远停在 streaming（S6 §四·1）。
 *
 * 同源托管：当 `uiDist` 存在时，core 直接 serve 前端静态资源，
 * 浏览器 transport baseUrl 用相对路径 ""（零配置）。静态资源**不要求 Bearer token**
 * （仅是 shell，数据端点才受保护）；API 端点反之必须带 token。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { toAgentEvent } from "./adapt.ts";
import type { AgentEvent, ModelTestRequest, ProviderModelsRequest, PutProvidersRequest } from "./contract.ts";
import { DirListError, listDirectories } from "./fs-list.ts";
import { isRecord } from "./guards.ts";
import { InvalidCwdError, type CoreRuntime } from "./session.ts";

export interface ServerHandle {
  port: number;
  token: string;
  close(): Promise<void>;
}

interface StartOptions {
  port?: number;
  token?: string;
  /** 绑定地址；默认 127.0.0.1。设 0.0.0.0 可对内网开放（需同步放宽 allowedHosts） */
  host?: string;
  /** 允许的主机名（Host 头校验，**不含端口**），默认 127.0.0.1 与 localhost */
  allowedHosts?: string[];
  /** 前端静态资源目录（vite build 产物）；存在则同源托管 UI */
  uiDist?: string;
}

const API_ROUTES = new Set([
	"/health",
	"/events",
	"/prompt",
	"/abort",
	"/approve",
	"/cancel-approval",
	// C4 · 会话列表与加载
	"/sessions",
	"/sessions/load",
	"/sessions/continue-recent",
	// 新建（换入）空白活动会话（task-new-session-page.md D7）
	"/sessions/new",
	// C5 · 04/05 屏数据源
	"/resources",
	"/models",
	"/models/select",
	"/thinking",
	// C2 · 第二批：模型接真（Provider 读写 / 目录 / 测试）
	"/providers",
	"/models/catalog",
	"/models/test",
	// 拉取 Provider 真实模型清单（设置页「导入模型…」）
	"/providers/models",
	// C6 · 04 屏工具开关接 Pi
	"/tools/active",
	// D7 · 工作目录运行期热切换
	"/cwd",
	// dir-picker · 自定义路径弹窗的浏览数据源（只读列子目录）
	"/fs/list",
]);

/** 从 Host 头取主机名：`1.2.3.4:5190` → `1.2.3.4`；`[::1]:5190` → `::1`；`localhost` → `localhost` */
function hostnameOf(hostHeader: string): string {
	const h = hostHeader.trim();
	if (h.startsWith("[")) {
		const end = h.indexOf("]");
		return end >= 0 ? h.slice(1, end) : h;
	}
	const colon = h.indexOf(":");
	return colon >= 0 ? h.slice(0, colon) : h;
}

function contentTypeOf(p: string): string {
	const ext = path.extname(p).toLowerCase();
	const map: Record<string, string> = {
		".html": "text/html; charset=utf-8",
		".js": "text/javascript; charset=utf-8",
		".mjs": "text/javascript; charset=utf-8",
		".css": "text/css; charset=utf-8",
		".json": "application/json; charset=utf-8",
		".svg": "image/svg+xml",
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".ico": "image/x-icon",
		".woff2": "font/woff2",
		".map": "application/json; charset=utf-8",
	};
	return map[ext] ?? "application/octet-stream";
}

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve) => {
		let d = "";
		req.on("data", (c) => (d += c));
		req.on("end", () => {
			try {
				resolve(JSON.parse(d || "{}"));
			} catch {
				resolve({});
			}
		});
	});
}

export function startServer(runtime: CoreRuntime, opts: StartOptions = {}): Promise<ServerHandle> {
	const token = opts.token ?? randomUUID();
	const sseClients = new Set<ServerResponse>();
	let actualPort = opts.port ?? 0;
	let batchTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingUpdate: AgentEvent | null = null;

	const push = (obj: unknown) => {
		const line = `data: ${JSON.stringify(obj)}\n\n`;
		for (const c of sseClients) c.write(line);
	};

	/** 冲掉待发的 message_update 快照（终态/其他事件前先下发最新进度） */
	const flushBatch = () => {
		if (batchTimer) {
			clearTimeout(batchTimer);
			batchTimer = null;
		}
		if (pendingUpdate) {
			push(pendingUpdate);
			pendingUpdate = null;
		}
	};

	/**
	 * SSE 批处理调度（S6 §四·1）：
	 * - message_update：同一窗口内只保留最新快照，~20ms 后下发一次；
	 * - 其余事件（含终态）：先冲掉待发 update，再立即下发。
	 */
	const BATCH_MS = 20;
	const dispatch = (raw: unknown) => {
		const event = toAgentEvent(raw);
		if (!event) return;
		if (event.type === "message_update") {
			pendingUpdate = event;
			if (!batchTimer) batchTimer = setTimeout(flushBatch, BATCH_MS);
		} else {
			flushBatch();
			push(event);
		}
	};

	/** core 直接生成的 AgentEvent（uiContext 授权请求 / 用量快照 / 目录热切换），已是契约形状，终态立即下发 */
	const dispatchAgent = (e: unknown) => {
		if (
			isRecord(e) &&
			(e.type === "approval_request" ||
				e.type === "approval_settled" ||
				e.type === "usage" ||
				e.type === "cwd_changed")
		) {
			flushBatch();
			push(e);
		}
	};

	runtime.onEvent(dispatch);
	runtime.onAgentEvent(dispatchAgent);

	function serveStatic(res: ServerResponse, urlPath: string): void {
		const uiDist = opts.uiDist;
		if (!uiDist) {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("UI dist 未构建");
			return;
		}
		let rel = decodeURIComponent(urlPath.split("?")[0]);
		if (rel === "/" || rel === "") rel = "/index.html";
		const filePath = path.normalize(path.join(uiDist, rel));
		// 防目录穿越
		if (filePath !== uiDist && !filePath.startsWith(uiDist + path.sep)) {
			res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("forbidden");
			return;
		}
		const sendFile = (file: string, isHtml: boolean) => {
			fs.readFile(file, (err, buf) => {
				if (err) {
					res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("not found");
					return;
				}
				let body = buf;
				if (isHtml) {
					/*
					 * 把同源 bootstrap token 注入 HTML：页面（feature-flags.getLiveConfig）优先读
					 * `window.__CORE_TOKEN__`，其次才读 `?token=`（供跨源 dev 场景覆盖）。
					 * ⇒ 用户只需要打开 `http://127.0.0.1:<port>/?live=1`，token 不再进 URL/收藏夹。
					 * 安全口径不变：Host 白名单 + Bearer 校验照旧；静态资源本就免鉴权，
					 * 注入不引入新攻击面（本机进程本就能读 run/core.json）。
					 */
					const inject = `<script>window.__CORE_TOKEN__=${JSON.stringify(token)};</script>`;
					body = Buffer.from(buf.toString("utf8").replace("</head>", `${inject}</head>`));
				}
				res.writeHead(200, { "Content-Type": isHtml ? "text/html; charset=utf-8" : contentTypeOf(file) });
				res.end(body);
			});
		};
		fs.stat(filePath, (err, st) => {
			if (!err && st.isFile()) {
				// HTML 判定按扩展名：index.html 真实存在时也必须注入 token（首跑实踩：
				// 只在 SPA 回退分支传 isHtml=true，导致 GET / 拿到的页面没有注入）
				sendFile(filePath, filePath.endsWith(".html"));
				return;
			}
			// SPA 回退：其余 GET 一律回 index.html（应用用 hash 路由，单页即可）
			sendFile(path.join(uiDist, "index.html"), true);
		});
	}

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${actualPort}`);
		const urlPath = url.pathname;
		// 白名单按「主机名」比对（与端口解耦）：默认仅本机。CORE_HOST=0.0.0.0 时
		// 需由 CORE_ALLOWED_HOSTS 显式追加内网 IP/域名（见 main.ts），否则内网请求 403。
		const allowed = opts.allowedHosts ?? ["127.0.0.1", "localhost"];

		// ② 防 DNS rebinding：校验 Host 头（对所有请求生效，含静态资源）
		const host = req.headers["host"];
		if (!host || !allowed.includes(hostnameOf(host))) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "forbidden host" }));
			return;
		}

		// ① 鉴权：Bearer token（仅对 API 端点生效；静态资源为公开 shell）
		if (API_ROUTES.has(urlPath)) {
			const auth = req.headers["authorization"];
			if (!auth || auth !== `Bearer ${token}`) {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "unauthorized" }));
				return;
			}
		}

		const json = (code: number, body: unknown) => {
			res.writeHead(code, { "Content-Type": "application/json" });
			res.end(JSON.stringify(body));
		};

		if (req.method === "GET" && urlPath === "/health") {
			// C3：补发信任门结论与扩展数 —— 信任门三态（never/always/ask）的直接证据来源。
			// 会话就绪前 trust / extensions 为 null（服务已可用，只是会话还在初始化）。
			// model：2026-09-24 起服务允许「无模型」启动（首启 models.json 为空），
			// 这里显式暴露 null，运维一眼能看出「服务活着但还没配模型」。
			return json(200, {
				ok: true,
				sseClients: sseClients.size,
				port: actualPort,
				extensions: runtime.getExtensionCount(),
				trust: runtime.getTrust(),
				model: runtime.getActiveModel(),
				// D7：运维可见性（流式中的会话正在生成回复；POST /cwd 据此 409）
				streaming: runtime.isStreaming(),
			});
		}

		if (req.method === "GET" && urlPath === "/events") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			res.write(": connected\n\n");
			sseClients.add(res);
			/*
			 * ★ C3：补发「连接之前就已下发」的未决授权请求。
			 * 场景一（必须）：ask 态信任门在会话创建前提问，而 core 此时才刚 listen，
			 * 浏览器/脚本还没连上 SSE —— 不补发则提问永久丢失、启动卡死到超时。
			 * 场景二（顺手）：页面刷新 / SSE 短暂断线重连后，未决授权卡还能重新出现。
			 */
			for (const pending of runtime.getPendingApprovals()) push(pending);
			const hb = setInterval(() => res.write(": ping\n\n"), 15000);
			req.on("close", () => {
				clearInterval(hb);
				sseClients.delete(res);
			});
			return;
		}

		if (req.method === "POST" && urlPath === "/prompt") {
			const body = (await readBody(req)) as { text?: string };
			try {
				await runtime.prompt(String(body.text ?? ""));
				return json(200, { ok: true });
			} catch (e) {
				return json(500, { ok: false, error: String(e) });
			}
		}

		if (req.method === "POST" && urlPath === "/abort") {
			await runtime.abort();
			return json(200, { ok: true });
		}

		if (req.method === "POST" && urlPath === "/approve") {
			const body = (await readBody(req)) as { requestId?: string; choice?: string };
			const r = runtime.resolveApproval(String(body.requestId ?? ""), String(body.choice ?? ""));
			return json(200, { ok: true, accepted: r.accepted });
		}

		// C3 新增：取消授权（与「拒绝」语义不同 —— 扩展读到的是「取消」而非某个选项文案）
		if (req.method === "POST" && urlPath === "/cancel-approval") {
			const body = (await readBody(req)) as { requestId?: string };
			const r = runtime.cancelApproval(String(body.requestId ?? ""));
			return json(200, { ok: true, accepted: r.accepted });
		}

		/* -----------------------------------------------------------------
		 * D7 · 工作目录运行期热切换（POST /cwd {dir?}）
		 * dir 缺省/空 = core 默认目录（process.cwd()）。流式中 409、目录无效 400，
		 * 成功回 `{ ok, cwd, trust }`；同时经 SSE 广播 `cwd_changed`（多标签页同步）。
		 * ----------------------------------------------------------------- */
		if (req.method === "POST" && urlPath === "/cwd") {
			const body = (await readBody(req)) as { dir?: string };
			// 前置护栏：不偷偷中止正在生成的回复（switchCwd 内还有同判据兜底）
			if (runtime.isStreaming()) {
				return json(409, { ok: false, error: "会话正在生成回复，请先停止再切换目录" });
			}
			const dir = typeof body.dir === "string" && body.dir.trim().length > 0 ? body.dir.trim() : null;
			try {
				const r = await runtime.switchCwd(dir);
				return json(200, { ok: true, cwd: r.cwd, trust: r.trust });
			} catch (e) {
				if (e instanceof InvalidCwdError) return json(400, { ok: false, error: e.message });
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		/* -----------------------------------------------------------------
		 * dir-picker · 目录浏览（GET /fs/list?path=...，task-dir-picker.md §4.1）
		 * 只读列名字，给「自定义路径」弹窗（仅目录）与侧栏文件树（dir-tree 批次
		 * task-sidebar-file-tree.md，?include=files 时文件一并列入）当数据源；
		 * 可预期失败由 DirListError 带状态码（400 不存在/不是目录、403 无权限），
		 * 与意外错误 500 区分。
		 * ----------------------------------------------------------------- */
		if (req.method === "GET" && urlPath === "/fs/list") {
			// 参数口径沿用 /sessions 的 all=1 先例：精确匹配才生效，其它取值同缺省（仅目录）
			const includeFiles = url.searchParams.get("include") === "files";
			try {
				return json(
					200,
					listDirectories(url.searchParams.get("path") ?? "", runtime.getCwd(), { includeFiles }),
				);
			} catch (e) {
				if (e instanceof DirListError) return json(e.status, { ok: false, error: e.message });
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		/* -----------------------------------------------------------------
		 * C4 · 会话列表与加载（S2：历史加载 ≠ 事件重放，映射在 sessions.ts）
		 * ----------------------------------------------------------------- */

		// 清单：默认当前工作目录；`?all=1` 跨项目目录（listAll）
		if (req.method === "GET" && urlPath === "/sessions") {
			const all = url.searchParams.get("all") === "1";
			try {
				const sessions = await runtime.listSessions({ all });
				return json(200, { ok: true, cwd: runtime.getCwd(), sessions });
			} catch (e) {
				return json(500, { ok: false, error: String(e), sessions: [] });
			}
		}

		// 加载：返回 `{ id, title, updatedAt, messages, tokenUsage, stats }`
		// —— `messages` 即规格书的 `Message[]`（外层带上标题/用量，省掉 UI 的二次请求）
		if (req.method === "POST" && urlPath === "/sessions/load") {
			const body = (await readBody(req)) as { id?: string };
			const id = String(body.id ?? "");
			if (!id) return json(400, { ok: false, error: "缺少 id" });
			try {
				const result = await runtime.loadSession(id);
				if (!result) return json(404, { ok: false, error: `会话不存在：${id}` });
				return json(200, { ok: true, ...result });
			} catch (e) {
				return json(500, { ok: false, error: String(e) });
			}
		}

		// 续接最近：读出内容并把活动会话切过去（C6 §1.2，重建路径见 session.ts 的 rebuildSession）
		if (req.method === "POST" && urlPath === "/sessions/continue-recent") {
			try {
				const result = await runtime.continueRecentSession();
				return json(200, { ok: true, ...result });
			} catch (e) {
				return json(500, { ok: false, error: String(e) });
			}
		}

		// 新建（换入）空白活动会话（task-new-session-page.md D7）：只换内存活动会话，
		// Pi 首条 entry 追加时才落盘文件 —— 调用时机由 UI 把握（草稿态首条消息发送时）。
		if (req.method === "POST" && urlPath === "/sessions/new") {
			// 前置护栏：不偷偷中止正在生成的回复（runtime.newSession 内还有同判据兜底）
			if (runtime.isStreaming()) {
				return json(409, { ok: false, error: "会话正在生成回复，请先停止再新建会话" });
			}
			try {
				const id = await runtime.newSession();
				return json(200, { ok: true, id });
			} catch (e) {
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		/* -----------------------------------------------------------------
		 * C5 · 04/05 屏数据源
		 * ----------------------------------------------------------------- */

		if (req.method === "GET" && urlPath === "/resources") {
			try {
				const resources = await runtime.getResources();
				return json(200, { ok: true, ...resources });
			} catch (e) {
				return json(500, { ok: false, error: String(e) });
			}
		}

		if (req.method === "GET" && urlPath === "/models") {
			try {
				const payload = await runtime.getModels();
				return json(200, { ok: true, ...payload });
			} catch (e) {
				return json(500, { ok: false, error: String(e) });
			}
		}

		if (req.method === "POST" && urlPath === "/models/select") {
			const body = (await readBody(req)) as { provider?: string; modelId?: string };
			const provider = String(body.provider ?? "");
			const modelId = String(body.modelId ?? "");
			if (!provider || !modelId) return json(400, { ok: false, error: "缺少 provider / modelId" });
			try {
				const payload = await runtime.selectModel(provider, modelId);
				return json(200, { ok: true, ...payload });
			} catch (e) {
				return json(400, { ok: false, error: String(e) });
			}
		}

		if (req.method === "POST" && urlPath === "/thinking") {
			const body = (await readBody(req)) as { level?: string };
			const level = String(body.level ?? "");
			if (!level) return json(400, { ok: false, error: "缺少 level" });
			try {
				const payload = await runtime.setThinkingLevel(level);
				return json(200, { ok: true, ...payload });
			} catch (e) {
				return json(400, { ok: false, error: String(e) });
			}
		}

		/* -----------------------------------------------------------------
		 * C6 · 04 屏工具开关（`tools.ts`；安全三件套经 API_ROUTES 同样生效）
		 * ----------------------------------------------------------------- */

		if (req.method === "GET" && urlPath === "/tools/active") {
			try {
				const payload = await runtime.getTools();
				return json(200, { ok: true, ...payload });
			} catch (e) {
				return json(500, { ok: false, error: String(e) });
			}
		}

		if (req.method === "POST" && urlPath === "/tools/active") {
			const body = (await readBody(req)) as { names?: unknown };
			if (!Array.isArray(body.names)) return json(400, { ok: false, error: "缺少 names 数组" });
			const names = body.names.map((n) => String(n));
			try {
				const payload = await runtime.setTools(names);
				return json(200, { ok: true, ...payload });
			} catch (e) {
				// 未注册的工具名 → 400（core 侧显式校验，不依赖上游的静默忽略）
				return json(400, { ok: false, error: String(e) });
			}
		}

		/* -----------------------------------------------------------------
		 * C2 · 第二批：模型接真（Provider 读写 / 目录 / 测试）
		 * 安全面（Bearer 401 + Host 403）经上方 API_ROUTES 统一覆盖。
		 * ----------------------------------------------------------------- */

		// 读取并合并 models.json + sidecar（带 enabled 标志）；解析失败返回结构化 {error}，不 500
		if (req.method === "GET" && urlPath === "/providers") {
			try {
				const payload = runtime.listProviders();
				return json(200, { ok: true, ...payload });
			} catch (e) {
				return json(200, { error: e instanceof Error ? e.message : String(e) });
			}
		}

		// 全量替换写回：按 enabled 拆分写 models.json / sidecar，refresh + 回退检测
		if (req.method === "PUT" && urlPath === "/providers") {
			const body = (await readBody(req)) as PutProvidersRequest;
			if (!body || !Array.isArray(body.providers)) {
				return json(400, { error: "请求体缺少 providers 数组" });
			}
			try {
				const result = await runtime.saveProviders(body);
				return json(200, { ok: true, ...result });
			} catch (e) {
				return json(200, { error: e instanceof Error ? e.message : String(e) });
			}
		}

		// 内置目录检索（不出网），按 id/name 不区分大小写匹配，上限 20 条
		if (req.method === "GET" && urlPath === "/models/catalog") {
			try {
				const q = url.searchParams.get("q") ?? "";
				const payload = runtime.searchCatalog(q);
				return json(200, { ok: true, ...payload });
			} catch (e) {
				return json(200, { error: e instanceof Error ? e.message : String(e) });
			}
		}

		// 一次性最小真实请求（max_tokens:1），不落盘、不改当前选择
		if (req.method === "POST" && urlPath === "/models/test") {
			const body = (await readBody(req)) as ModelTestRequest;
			if (!body || typeof body.baseUrl !== "string" || typeof body.modelId !== "string") {
				return json(400, { error: "请求体缺少 baseUrl / modelId" });
			}
			try {
				const result = await runtime.testModel(body);
				return json(200, result);
			} catch (e) {
				return json(200, { error: e instanceof Error ? e.message : String(e) });
			}
		}

		// 拉取该 Provider 的真实模型清单（GET {baseUrl}/models），不落盘、不改当前选择
		if (req.method === "POST" && urlPath === "/providers/models") {
			const body = (await readBody(req)) as ProviderModelsRequest;
			if (!body || typeof body.baseUrl !== "string") {
				return json(400, { error: "请求体缺少 baseUrl" });
			}
			try {
				const result = await runtime.listProviderModels(body);
				return json(200, result);
			} catch (e) {
				return json(200, { ok: false, models: [], error: e instanceof Error ? e.message : String(e) });
			}
		}

		// 静态资源（SPA）：仅处理 GET，其余返回 404
		if (req.method === "GET") {
			return serveStatic(res, urlPath);
		}

		return json(404, { error: "not found" });
	});

	return new Promise((resolve) => {
		server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
			const addr = server.address();
			actualPort = typeof addr === "object" && addr ? addr.port : opts.port ?? 0;
			resolve({
				port: actualPort,
				token,
				close: () =>
					new Promise<void>((r) => {
						if (batchTimer) clearTimeout(batchTimer);
						flushBatch();
						for (const c of sseClients) c.end();
						server.close(() => r());
					}),
			});
		});
	});
}
