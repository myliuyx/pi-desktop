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

const token = process.env.CORE_TOKEN ?? randomUUID();
const port = process.env.CORE_PORT ? Number(process.env.CORE_PORT) : 0;

const runtime = await createCoreRuntime({
  agentDir: process.env.CORE_AGENT_DIR,
  modelsPath: process.env.CORE_MODELS_PATH,
  shellPath: process.env.CORE_SHELL_PATH,
  modelId: process.env.PI_MODEL,
});

const handle = await startServer(runtime, { port, token });

// 写 run/core.json（含 token，绝不提交）
fs.writeFileSync(path.join(runDir, "core.json"), JSON.stringify({ port: handle.port, token }, null, 2));

// 事件落盘（真实冒烟证据）
const dumpPath = path.join(runDir, "events.jsonl");
fs.writeFileSync(dumpPath, "");
runtime.onEvent((e) => {
  fs.appendFileSync(dumpPath, `${JSON.stringify(e)}\n`);
});

// 静态资源托管（同源：浏览器 transport baseUrl 用相对路径 ""，零配置）
// TODO(C2): serve packages/ui/dist when present.

console.log(`[core] 监听 http://127.0.0.1:${handle.port}  (SSE: /events, 健康: /health)`);

async function shutdown() {
  console.log("\n[core] 关闭中…");
  await handle.close();
  runtime.dispose();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
