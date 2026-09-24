/**
 * core 安全三件套自检 —— node 直跑（不引框架）。
 *
 * 流程：spawn 起 core 服务（固定 token/port，凭证经 `childEnv` 注入），
 * 然后分别验证：无 token → 401、错 token → 401、错 Host → 403、带 token 正确 Host → 200 且 ok:true。
 * 验证完 kill 子进程并退出（EXIT 0=全绿，1=有失败）。
 *
 * 2026-09-24：`CORE_MODELS_PATH` 与 `--env-file` 用法均已删除 ——
 * 模型清单放在**临时 agentDir** 里（Pi 的约定位置），凭证由 `./lib/credentials.mjs` 注入。
 * 用临时 agentDir 而不是默认的 `~/.pi/agent`，顺带保证自检不会写用户的全局 Pi 配置。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, seedModelsJson } from "./lib/credentials.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, "..");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "core-security-"));
const agentDir = path.join(tmpRoot, "agentdir");
seedModelsJson(agentDir);
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));

const PORT = 5191;
const TOKEN = "test-token";

function request(method, p, { token, host } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (host) headers["Host"] = host;
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: p, method, headers, timeout: 5000 },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

function waitForUp() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = async () => {
      try {
        await request("GET", "/health"); // 任何响应（含 401）都表示已起来
        resolve();
      } catch {
        if (Date.now() - t0 > 30000) reject(new Error("server 未就绪（30s 超时）"));
        else setTimeout(tick, 300);
      }
    };
    tick();
  });
}

const fails = [];
function check(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    fails.push(label);
    console.log(`  ✗ ${label}  ${detail ?? ""}`);
  }
}

const child = spawn(
  process.execPath,
  [tsxPath, "src/main.ts"],
  {
    cwd: coreDir,
    env: childEnv({ CORE_TOKEN: TOKEN, CORE_PORT: String(PORT), CORE_AGENT_DIR: agentDir }),
    stdio: "ignore",
  },
);

let exitCode = 1;
try {
  await waitForUp();

  const noToken = await request("GET", "/health");
  check("无 token → 401", noToken.status === 401, `实际 ${noToken.status}`);

  const wrongToken = await request("GET", "/health", { token: "wrong" });
  check("错 token → 401", wrongToken.status === 401, `实际 ${wrongToken.status}`);

  const wrongHost = await request("GET", "/health", { token: TOKEN, host: "evil.example.com:" + PORT });
  check("错 Host → 403", wrongHost.status === 403, `实际 ${wrongHost.status}`);

  const ok = await request("GET", "/health", { token: TOKEN, host: "127.0.0.1:" + PORT });
  let parsed = null;
  try {
    parsed = JSON.parse(ok.body);
  } catch {}
  check("带 token + 正确 Host → 200", ok.status === 200, `实际 ${ok.status}`);
  check("/health 返回 JSON 含 ok:true", parsed && parsed.ok === true, ok.body);

  exitCode = fails.length === 0 ? 0 : 1;
} catch (e) {
  console.error("安全自检异常:", e.message);
  exitCode = 1;
} finally {
  child.kill("SIGTERM");
}

console.log(fails.length === 0 ? "\n安全三件套全部通过" : `\n安全自检失败 ${fails.length} 项：${fails.join("; ")}`);
process.exit(exitCode);
