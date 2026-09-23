/**
 * core 入口 —— 装配会话 + 起 HTTP/SSE 服务。
 *
 * 安全：随机 token 启动生成，写入 packages/core/run/core.json（run/ 已 gitignore）。
 * 模型 key 仅从环境变量注入（ARK_API_KEY，来源 pi/_poc/.env.local），绝不写进任何被提交文件。
 *
 * 启动（env 注入 key，执行方自定）：
 *   node --env-file=../../pi/_poc/.env.local \
 *        --env-file-if-exists=packages/core/run/core.local.env \
 *        node_modules/tsx/dist/cli.mjs src/main.ts
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCoreRuntime } from "./session.ts";
import { startServer } from "./server.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const runDir = path.join(here, "..", "run");
fs.mkdirSync(runDir, { recursive: true });

// 同源托管前端：默认 core 包上一级的 ui/dist；可用 CORE_UI_DIST 覆盖
const uiDist = process.env.CORE_UI_DIST
	? path.resolve(process.env.CORE_UI_DIST)
	: path.resolve(here, "..", "..", "ui", "dist");

const token = process.env.CORE_TOKEN ?? randomUUID();
const port = process.env.CORE_PORT ? Number(process.env.CORE_PORT) : 0;

/*
 * C3：**先起服务、再等会话就绪**。
 * 原因：`ask` 态的项目信任门（trust.ts）会在会话创建之前向 UI 提问，
 * 而提问要走 SSE/HTTP —— 若等服务就绪才 listen，提问必然没人应答、启动死锁
 *（提问早于首个 SSE 连接的那一小段窗口，由 server.ts 的未决请求补发兜住）。
 */
const boot = createCoreRuntime({
  agentDir: process.env.CORE_AGENT_DIR,
  modelsPath: process.env.CORE_MODELS_PATH,
  shellPath: process.env.CORE_SHELL_PATH,
  modelId: process.env.PI_MODEL,
  // C3：信任门提问等待上限（默认 120s，超时按「不信任」收尾）；测试用小值验证超时语义
  trustTimeoutMs: process.env.CORE_TRUST_TIMEOUT_MS ? Number(process.env.CORE_TRUST_TIMEOUT_MS) : undefined,
});

const handle = await startServer(boot.runtime, { port, token, uiDist });

// 写 run/core.json（含 token，绝不提交）
fs.writeFileSync(path.join(runDir, "core.json"), JSON.stringify({ port: handle.port, token }, null, 2));

// 事件落盘（真实冒烟证据）
const dumpPath = path.join(runDir, "events.jsonl");
fs.writeFileSync(dumpPath, "");
boot.runtime.onEvent((e) => {
  fs.appendFileSync(dumpPath, `${JSON.stringify(e)}\n`);
});

console.log(`[core] 监听 http://127.0.0.1:${handle.port}  (SSE: /events, 健康: /health)`);
console.log(`[core] 同源托管 UI: ${uiDist}${fs.existsSync(uiDist) ? "" : "（不存在，浏览器请用 ?core= 指向本服务）"}`);

try {
  await boot.ready;
} catch (e) {
  console.error("[core] 会话初始化失败:", e instanceof Error ? e.message : String(e));
  await handle.close();
  process.exit(1);
}

async function shutdown() {
  console.log("\n[core] 关闭中…");
  await handle.close();
  boot.runtime.dispose();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
