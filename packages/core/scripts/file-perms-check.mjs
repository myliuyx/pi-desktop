/**
 * 敏感文件权限收敛 —— `check:file-perms`（CR-013 + CR-030，P2，同根因）。
 *
 * ## 为什么需要它
 * core 的承载目录与凭证/token 文件默认按**进程 umask** 落盘：在 umask=002 的开发机上
 * runDir=775、core.json（Bearer token）/ events.jsonl / models.json（明文 apiKey）/ sidecar
 * 全为 **664**——本机任意用户可读 ⇒ 读 token 得完整 API（≈RCE）、读 apiKey 冒用上游账户。
 * CR-013=core.json/events.jsonl，CR-030=models.json/sidecar，同根因（缺 mode/chmod）。
 *
 * 本脚本把结论固化为可证伪断言（起隔离 core、假 token/provider、不出网、`/tmp/r0-t4`）：
 *   - runDir = 0700（目录）；core.json / events.jsonl / models.json / sidecar = 0600（文件）；
 *   - **预置 664 的旧文件**被 chmod 兜底**修正**为 0600/0700（mkdir/write 的 mode 只作用于
 *     新建 inode，rename/truncate 保留旧权限，故必须有 chmod 兜底）。
 * 用 `process.umask(0o002)` 复刻受害环境：修复前这些文件/目录为 664/775（红），修复后恒 600/700（绿）。
 *
 * **POSIX only**：win32 无 POSIX 权限位语义，记 SKIP-POSIX-ONLY 并 **exit 0（不计 FAIL）**。
 *
 * 用法（在 packages/core 下）：`npm run check:file-perms`。
 * 端口可覆盖：`FP_PORT=54130 npm run check:file-perms`；证据：`run/file-perms-evidence.json`。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, "..");
const runDir = path.join(coreDir, "run");
fs.mkdirSync(runDir, { recursive: true });
const evidencePath = path.join(runDir, "file-perms-evidence.json");

const POSIX = process.platform !== "win32";

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

if (!POSIX) {
  checks.push({ name: "SKIP-POSIX-ONLY", pass: true, detail: "win32 无 POSIX 权限语义" });
  fs.writeFileSync(evidencePath, JSON.stringify({ skipped: true, reason: "win32" }, null, 2));
  console.log("check:file-perms: SKIP-POSIX-ONLY（win32 不支持 POSIX 权限位）");
  process.exit(0);
}

const TOKEN = "r0-test-token";
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** POSIX 权限位（`stat -c '%a'` 的 Node 等价） */
const perm = (p) => (fs.statSync(p).mode & 0o777).toString(8);

async function pickPort() {
  for (let p = Number(process.env.FP_PORT ?? 54120); p <= 54199; p++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(p, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
    if (free) return p;
  }
  throw new Error("54120–54199 无空闲端口");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 复刻受害环境：umask 002 ⇒ 新建文件 664 / 目录 775（修复前凭证明文即此权限）
process.umask(0o002);

const base = "/tmp/r0-t4";
fs.rmSync(base, { recursive: true, force: true });
const coreRunDir = path.join(base, "run");
const agentDir = path.join(base, "agent");
const cwd = path.join(base, "cwd");
for (const d of [coreRunDir, agentDir, cwd]) fs.mkdirSync(d, { recursive: true });
// 预置旧 664 文件/目录：测 chmod 兜底「已存在」分支
const coreJson = path.join(coreRunDir, "core.json");
const events = path.join(coreRunDir, "events.jsonl");
const modelsJson = path.join(agentDir, "models.json");
const sidecar = path.join(agentDir, "models-disabled.json");
fs.writeFileSync(coreJson, JSON.stringify({ port: 0, token: "stale" }));
fs.writeFileSync(events, "");
fs.writeFileSync(modelsJson, JSON.stringify({ providers: {} }));
for (const f of [coreJson, events, modelsJson]) fs.chmodSync(f, 0o664); // 明文旧权限
fs.chmodSync(coreRunDir, 0o775); // 旧目录权限

const PORT = await pickPort();
function req(method, p, body, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${TOKEN}` };
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers, timeout: timeoutMs }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(d);
        } catch {
          /* noop */
        }
        resolve({ status: res.statusCode, json, raw: d });
      });
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (payload) r.write(payload);
    r.end();
  });
}

const child = spawn("node", ["node_modules/tsx/dist/cli.mjs", "src/main.ts"], {
  cwd: coreDir,
  env: { ...process.env, CORE_PORT: String(PORT), CORE_TOKEN: TOKEN, CORE_RUN_DIR: coreRunDir, CORE_AGENT_DIR: agentDir, CORE_CWD: cwd },
  stdio: ["ignore", "ignore", "ignore"],
  detached: true,
});
const killCore = () => {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* noop */
    }
  }
};
const watchdog = setTimeout(() => {
  killCore();
  console.error("check:file-perms 看门狗超时（60s）");
  process.exit(2);
}, 60_000);
watchdog.unref();
process.on("exit", killCore);

try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await req("GET", "/health", undefined, 2000)).status === 200) {
        up = true;
        break;
      }
    } catch {
      /* 未起 */
    }
    await sleep(250);
  }
  if (!up) throw new Error("隔离 core 未就绪");

  // 触发一次保存：经 writeJsonAtomic 落 models.json + sidecar
  await req("PUT", "/providers", {
    providers: [
      {
        id: "p1",
        name: "P1",
        baseUrl: "http://127.0.0.1:9",
        api: "openai-completions",
        apiKey: TOKEN,
        enabled: true,
        headers: {},
        models: [{ id: "m1", reasoning: false, input: ["text"], cost: COST }],
      },
    ],
  });
  await sleep(300);

  check("runDir = 0700（目录，chmod 兜底修正 775）", perm(coreRunDir) === "700", { got: perm(coreRunDir) });
  check("core.json = 0600（Bearer token，chmod 兜底修正 664）", perm(coreJson) === "600", { got: perm(coreJson) });
  check("events.jsonl = 0600（chmod 兜底修正 664）", perm(events) === "600", { got: perm(events) });
  check("models.json = 0600（明文 apiKey，writeJsonAtomic）", perm(modelsJson) === "600", { got: perm(modelsJson) });
  check("models-disabled.json(sidecar) = 0600（writeJsonAtomic）", perm(sidecar) === "600", { got: perm(sidecar) });
} catch (e) {
  check("（运行异常）", false, { error: e instanceof Error ? e.message : String(e) });
} finally {
  killCore();
  clearTimeout(watchdog);
  fs.rmSync(base, { recursive: true, force: true });
}

const evidence = { startedAt: new Date().toISOString(), checks };
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
const failed = checks.filter((c) => !c.pass).length;
if (failed > 0) {
  console.error(`\nfile-perms 检查失败 ${failed} 项（证据：${evidencePath}）`);
  process.exit(1);
}
console.log(`file-perms 检查全部通过：${checks.length} 项（证据：${evidencePath}）`);
