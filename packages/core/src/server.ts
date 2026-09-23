/**
 * core HTTP + SSE 服务 —— 绑定 127.0.0.1，安全三件套（S6 §七）：
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
import type { AgentEvent } from "./contract.ts";
import type { CoreRuntime } from "./session.ts";

export interface ServerHandle {
  port: number;
  token: string;
  close(): Promise<void>;
}

interface StartOptions {
  port?: number;
  token?: string;
  /** 允许的主机名（用于 Host 头校验），默认 127.0.0.1 与 localhost */
  allowedHosts?: string[];
  /** 前端静态资源目录（vite build 产物）；存在则同源托管 UI */
  uiDist?: string;
}

const API_ROUTES = new Set(["/health", "/events", "/prompt", "/abort", "/approve"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
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

	/** core 直接生成的 AgentEvent（uiContext 授权请求），已是契约形状，终态立即下发 */
	const dispatchAgent = (e: unknown) => {
		if (isRecord(e) && (e.type === "approval_request" || e.type === "approval_settled")) {
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
				res.writeHead(200, { "Content-Type": isHtml ? "text/html; charset=utf-8" : contentTypeOf(file) });
				res.end(buf);
			});
		};
		fs.stat(filePath, (err, st) => {
			if (!err && st.isFile()) {
				sendFile(filePath, false);
				return;
			}
			// SPA 回退：其余 GET 一律回 index.html（应用用 hash 路由，单页即可）
			sendFile(path.join(uiDist, "index.html"), true);
		});
	}

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${actualPort}`);
		const urlPath = url.pathname;
		const allowed = opts.allowedHosts ?? [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];

		// ② 防 DNS rebinding：校验 Host 头（对所有请求生效，含静态资源）
		const host = req.headers["host"];
		if (!host || !allowed.includes(host)) {
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
			return json(200, { ok: true, sseClients: sseClients.size, port: actualPort });
		}

		if (req.method === "GET" && urlPath === "/events") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			res.write(": connected\n\n");
			sseClients.add(res);
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

		// 静态资源（SPA）：仅处理 GET，其余返回 404
		if (req.method === "GET") {
			return serveStatic(res, urlPath);
		}

		return json(404, { error: "not found" });
	});

	return new Promise((resolve) => {
		server.listen(opts.port ?? 0, "127.0.0.1", () => {
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
