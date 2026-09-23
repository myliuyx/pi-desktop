/**
 * 一次性 spike：block.reason 是否进模型上下文（backlog ⑥）。
 *
 * 流程：
 * 1. 起临时 core 子进程（CORE_AGENT_DIR 指向 pi/_poc/spike-core/agentdir-block-reason，
 *    其 approval-gate.ts 对 bash 一律返回 { block:true, reason:"BLOCKED-REASON-PROBE-20260923" }）；
 * 2. 连 SSE → POST /prompt（诱导模型调 bash）→ 收集全部事件；
 * 3. 事件 dump 到 run/spike-block-reason-events.jsonl；
 * 4. 读 agentdir-block-reason/sessions/ 下本次新产生的 session .jsonl，
 *    检查 block 之后的 toolResult 消息内容是否包含标记串。
 *
 * 运行：cd packages/core && node run/_spike-block-reason.mjs
 * key 仅经 env 注入（--env-file=pi/_poc/.env.local，node 子进程自带）。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, "..");
const repoDir = path.resolve(coreDir, "..", "..");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
const envLocal = path.join(repoDir, "pi", "_poc", ".env.local");
const modelsPath = path.join(repoDir, "pi", "_poc", "models.json");
const agentDir = path.join(repoDir, "pi", "_poc", "spike-core", "agentdir-block-reason");
const sessionsDir = path.join(agentDir, "sessions");

const MARKER = "BLOCKED-REASON-PROBE-20260923";
const PORT = 5196;
const TOKEN = "spike-block-reason-token";
const PROMPT = "请调用 bash 工具执行命令 echo hello，然后原样告诉我命令执行的结果。";
const HARD_MS = 180000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, p, { body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
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

function listSessionFiles() {
  if (!fs.existsSync(sessionsDir)) return [];
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(sessionsDir);
  return out;
}

const child = spawn(
  process.execPath,
  ["--env-file=" + envLocal, tsxPath, "src/main.ts"],
  {
    cwd: coreDir,
    env: {
      ...process.env,
      CORE_TOKEN: TOKEN,
      CORE_PORT: String(PORT),
      CORE_MODELS_PATH: modelsPath,
      CORE_AGENT_DIR: agentDir,
      CORE_SHELL_PATH: "C:/Users/myliu/.workbuddy/binaries/PortableGit/versions/1.2.0/bin/bash.exe",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.on("data", (c) => process.stdout.write("[core] " + c));
child.stderr.on("data", (c) => process.stdout.write("[core:err] " + c));

const events = [];
let code = 1;
try {
  await waitForUp();
  console.log("[spike] 服务就绪，连接 SSE …");

  await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/events", method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
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
        resolve();
      },
    );
    req.on("error", reject);
    req.end();
  });

  console.log("[spike] POST /prompt:", PROMPT);
  const post = await request("POST", "/prompt", { body: { text: PROMPT } });
  console.log("[spike] /prompt 返回", post.status, post.body);

  const t0 = Date.now();
  while (Date.now() - t0 < HARD_MS) {
    if (events.some((e) => e.type === "agent_settled")) break;
    await sleep(500);
  }
  await sleep(800);

  // 事件落盘（SSE 证据）
  const dumpPath = path.join(here, "spike-block-reason-events.jsonl");
  fs.writeFileSync(dumpPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  console.log(`[spike] SSE 事件 ${events.length} 条 → ${dumpPath}`);

  // session 证据：找本次运行新产生的 session 文件（脚本启动后 mtime 的、含标记串调用的）
  const startedAt = Date.now() - HARD_MS - 60000; // 宽容回看
  const files = listSessionFiles().filter((f) => fs.statSync(f).mtimeMs >= startedAt);
  console.log("[spike] 候选 session 文件:", files.length ? files.join(" ; ") : "（无）");

  const evidence = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== "message") continue;
      const m = entry.message;
      if (!m) continue;
      if (m.role === "toolResult") {
        const text = (m.content ?? []).map((c) => c.text ?? "").join("");
        evidence.push({ file: path.basename(f), role: "toolResult", toolName: m.toolName, isError: m.isError, text });
      }
      if (m.role === "assistant") {
        const parts = (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
        if (parts) evidence.push({ file: path.basename(f), role: "assistant", text: parts });
      }
    }
  }

  const toolResults = evidence.filter((e) => e.role === "toolResult");
  const withMarker = toolResults.filter((e) => e.text.includes(MARKER));
  const assistantMentions = evidence.filter((e) => e.role === "assistant" && e.text.includes(MARKER));

  console.log("\n===== spike 结论材料 =====");
  console.log(`toolResult 总数: ${toolResults.length}`);
  console.log(`含标记串的 toolResult: ${withMarker.length}`);
  for (const e of withMarker) {
    console.log(`  [session 证据] toolResult(${e.toolName}, isError=${e.isError}): "${e.text.slice(0, 200)}"`);
  }
  for (const e of assistantMentions) {
    console.log(`  [模型复述] assistant 文本: "${e.text.slice(0, 200)}"`);
  }

  if (toolResults.length === 0) {
    console.log("✗ 未捕获到任何 toolResult（模型可能未调 bash）");
  } else if (withMarker.length > 0) {
    console.log(`\n结论：block.reason **进入了**模型上下文 —— toolResult 文本即 reason 标记串（${MARKER}）`);
    code = 0;
  } else {
    console.log("\n结论：block.reason **未出现**在回给模型的 toolResult 中");
    code = 0; // 观察性 spike：结论无论正负都算跑通
  }
} catch (e) {
  console.error("[spike] 异常:", e);
  code = 1;
} finally {
  child.kill("SIGTERM");
}
process.exit(code);
