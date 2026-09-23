/**
 * core HTTP + SSE 服务 —— 绑定 127.0.0.1，安全三件套（S6 §七）：
 * ① 随机 token（Bearer）；② 校验 Host 头防 DNS rebinding；③ 拒绝跨来源（无 CORS）。
 *
 * 事件管道：core 内部事件（Pi 原始事件 + 授权请求）经 /events 的 SSE 广播给浏览器。
 * 浏览器只允许同源（core serve 静态资源时同源），故不放开任何跨域头。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
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

  const push = (obj: unknown) => {
    const line = `data: ${JSON.stringify(obj)}\n\n`;
    for (const c of sseClients) c.write(line);
  };
  // 桥接 core 事件管道到 SSE
  runtime.onEvent((e) => push(e));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${actualPort}`);
    const allowed = opts.allowedHosts ?? [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];

    // ① 鉴权：Bearer token（浏览器是任意网页，127.0.0.1 可被任意页请求）
    const auth = req.headers["authorization"];
    if (!auth || auth !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // ② 防 DNS rebinding：校验 Host 头
    const host = req.headers["host"];
    if (!host || !allowed.includes(host)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden host" }));
      return;
    }

    // ③ 不放开任何跨域头（同源部署）
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/health") {
      return json(200, { ok: true, sseClients: sseClients.size, port: actualPort });
    }

    if (req.method === "GET" && url.pathname === "/events") {
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

    if (req.method === "POST" && url.pathname === "/prompt") {
      const body = (await readBody(req)) as { text?: string };
      try {
        await runtime.prompt(String(body.text ?? ""));
        return json(200, { ok: true });
      } catch (e) {
        return json(500, { ok: false, error: String(e) });
      }
    }

    if (req.method === "POST" && url.pathname === "/abort") {
      await runtime.abort();
      return json(200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/approve") {
      const body = (await readBody(req)) as { requestId?: string; choice?: string };
      const r = runtime.resolveApproval(String(body.requestId ?? ""), String(body.choice ?? ""));
      return json(200, { ok: true, accepted: r.accepted });
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
            for (const c of sseClients) c.end();
            server.close(() => r());
          }),
      });
    });
  });
}
