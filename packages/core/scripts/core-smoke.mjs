/**
 * core 真实模型冒烟 —— node 直跑。起服务 → POST /prompt（真实模型，要求「不用工具」）→
 * 经 SSE 收集事件，断言 message_start ≥1、message_update 若干、agent_end 与 agent_settled 各 ≥1，
 * 并把事件统计写入 packages/core/run/smoke-report.json（真实冒烟证据）。
 *
 * key 仅经 env 注入（--env-file=pi/_poc/.env.local）。模型走 ark-coding/deepseek-v4-flash。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, "..");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
const envLocal = path.resolve(coreDir, "..", "..", "pi", "_poc", ".env.local");
const modelsPath = path.resolve(coreDir, "..", "..", "pi", "_poc", "models.json");
const runDir = path.join(coreDir, "run");
fs.mkdirSync(runDir, { recursive: true });

const PORT = 5194;
const TOKEN = "smoke-token";
const PROMPT = "用一句话介绍 Pi 项目，不要使用任何工具。";
const HARD_MS = Number(process.env.SMOKE_HARD_MS ?? 180000);

function request(method, p, { token, host, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (host) headers["Host"] = host;
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: p, method, headers, timeout: 10000 },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function waitForUp() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = async () => {
      try {
        await request("GET", "/health");
        resolve();
      } catch {
        if (Date.now() - t0 > 30000) reject(new Error("server 未就绪（30s 超时）"));
        else setTimeout(tick, 300);
      }
    };
    tick();
  });
}

const child = spawn(
  process.execPath,
  ["--env-file=" + envLocal, tsxPath, "src/main.ts"],
  {
    cwd: coreDir,
    env: { ...process.env, CORE_TOKEN: TOKEN, CORE_PORT: String(PORT), CORE_MODELS_PATH: modelsPath },
    stdio: "ignore",
  },
);

const events = [];
const fails = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await waitForUp();
  console.log("[smoke] 服务就绪，连接 SSE …");

  // 连接 SSE（流永不结束，拿到响应头即视为已连接）
  await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/events", method: "GET", headers: { Authorization: `Bearer ${TOKEN}`, Host: `127.0.0.1:${PORT}` } },
      (res) => {
        let buf = "";
        res.on("data", (c) => {
          buf += c.toString();
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            try {
              events.push(JSON.parse(line.slice(6)));
            } catch {}
          }
        });
        res.on("error", reject);
        resolve(); // 响应头已到，连接建立
      },
    );
    req.on("error", reject);
    req.end();
  });

  console.log("[smoke] POST /prompt …");
  const post = await request("POST", "/prompt", { token: TOKEN, host: `127.0.0.1:${PORT}`, body: { text: PROMPT } });
  console.log("[smoke] /prompt 返回", post.status, post.body);

  // 等 agent_settled 或硬超时
  const t0 = Date.now();
  while (Date.now() - t0 < HARD_MS) {
    if (events.some((e) => e.type === "agent_settled")) break;
    await sleep(500);
  }
  await sleep(800);

  const count = (t) => events.filter((e) => e.type === t).length;
  const report = {
    总事件数: events.length,
    message_start: count("message_start"),
    message_update: count("message_update"),
    agent_end: count("agent_end"),
    agent_settled: count("agent_settled"),
    approval_request: count("approval_request"),
  };

  const check = (label, cond) => {
    if (cond) console.log(`  ✓ ${label}`);
    else {
      fails.push(label);
      console.log(`  ✗ ${label}`);
    }
  };
  check("message_start ≥ 1", report.message_start >= 1);
  check("message_update 若干（≥1）", report.message_update >= 1);
  check("agent_end 各 1（≥1）", report.agent_end >= 1);
  check("agent_settled 各 1（≥1）", report.agent_settled >= 1);

  fs.writeFileSync(path.join(runDir, "smoke-report.json"), JSON.stringify(report, null, 2));
  console.log("\n[smoke] 事件统计:", JSON.stringify(report));

  const ok = fails.length === 0;
  console.log(ok ? "\n冒烟全部通过" : `\n冒烟失败 ${fails.length} 项`);
  return ok ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error("[smoke] 异常:", e.message);
  code = 1;
} finally {
  child.kill("SIGTERM");
}
process.exit(code);
