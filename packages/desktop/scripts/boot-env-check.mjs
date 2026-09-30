/**
 * bootCore env 白名单回归 —— `check:boot-env`（CR-072，POSIX only 同 file-perms 口径：win32 记
 * SKIP-POSIX-ONLY 不计 FAIL）。
 *
 * 背景（CR-072）：桌面壳 bootCore 透传宿主 CORE_*，宿主若设 CORE_HOST=0.0.0.0（README 自托管口径）
 * 内嵌 core 会绑 0.0.0.0（内网可达）。修复 = bootCore env 白名单化（buildBootCoreEnv）：桌面壳对
 * core env 完全收敛，显式钉死 CORE_HOST=127.0.0.1 / CORE_ALLOWED_HOSTS="" / 删 CORE_TOKEN（core
 * 随机 UUID）/ 显式 CORE_AGENT_DIR，并对残留 CORE_* 告警。
 *
 * 判据两段：
 *   [纯函数 · 全平台] buildBootCoreEnv 的覆写/删除/告警（不起进程）——先红态这段即红；
 *   [起真实 core · 仅 POSIX] 复刻 VP-08 配方：从脚本位置解析仓库根，spawn
 *     `node <core>/node_modules/tsx/dist/cli.mjs <core>/src/main.ts`，env 经 buildBootCoreEnv，
 *     等 /health，`ss -tln` 断言**仅绑 127.0.0.1**；两次（宿主带 / 不带 CORE_HOST=0.0.0.0）。
 *
 * 隔离纪律：端口只取 54200–54299（起前探活），run/agent 指 /tmp/r0-t6/**，CORE_TOKEN 用假串，
 * 零真实出网、不碰真实 ~/.pi/agent；结束杀进程、清目录。
 * 用法：npm run check:boot-env；失败非 0 退出。
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBootCoreEnv } from "../src/boot-env.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// packages/desktop/scripts → 仓库根
const repoRoot = path.resolve(here, "..", "..", "..");
const tsx = path.join(repoRoot, "packages", "core", "node_modules", "tsx", "dist", "cli.mjs");
const coreMain = path.join(repoRoot, "packages", "core", "src", "main.ts");

const TMP = "/tmp/r0-t6";
const RUN = path.join(TMP, "run");
const AGENT = path.join(TMP, "agent");
const UI_DIST = path.join(TMP, "ui");
const HOST_TOKEN = "r0-t6-host-token"; // 假 token，模拟宿主注入

const POSIX = process.platform !== "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const skipped = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};
const skip = (name) => {
  skipped.push(name);
  console.log(`  - ${name}（SKIP-POSIX-ONLY）`);
};

/* ==================================================================
 * 一、纯函数（全平台）：buildBootCoreEnv 白名单化
 * ================================================================== */
const CLEAN = { PATH: "/usr/bin", HOME: "/home/u" };
const HOSTILE = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  CORE_HOST: "0.0.0.0",
  CORE_ALLOWED_HOSTS: "evil.example.com",
  CORE_TOKEN: HOST_TOKEN,
  CORE_AGENT_DIR: "/tmp/should-be-ignored",
  CORE_CWD: "/etc",
};
const IN = { runDir: RUN, uiDist: UI_DIST, agentDir: AGENT, port: "PORT_PLACEHOLDER" };

{
  const r = buildBootCoreEnv({ ...IN, port: "54200", parentEnv: HOSTILE });
  check("P1 敌对 CORE_HOST=0.0.0.0 被覆写为 127.0.0.1", r.env.CORE_HOST === "127.0.0.1", r.env.CORE_HOST);
  check("P2 敌对 CORE_ALLOWED_HOSTS 被清空为 \"\"", r.env.CORE_ALLOWED_HOSTS === "", r.env.CORE_ALLOWED_HOSTS);
  check("P3 宿主 CORE_TOKEN 不透传（删除，core 生成随机 UUID）", !("CORE_TOKEN" in r.env), "CORE_TOKEN" in r.env ? r.env.CORE_TOKEN : "(absent)");
  check("P4 CORE_AGENT_DIR 钉死为桌面壳指定目录（宿主值被忽略）", r.env.CORE_AGENT_DIR === AGENT, r.env.CORE_AGENT_DIR);
  check("P5 残留 CORE_* 被登记告警（含 HOST/TOKEN/AGENT_DIR/CWD）",
    r.warnings.includes("CORE_HOST") && r.warnings.includes("CORE_TOKEN") && r.warnings.includes("CORE_AGENT_DIR") && r.warnings.includes("CORE_CWD"),
    r.warnings);
}
{
  const r = buildBootCoreEnv({ ...IN, port: "54200", parentEnv: CLEAN });
  check("P6 干净宿主（无 CORE_*）→ 无告警", r.warnings.length === 0, r.warnings);
  const rw = buildBootCoreEnv({ ...IN, port: "54200", parentEnv: { ...HOSTILE, NODE_OPTIONS: "--garbage" } });
  check("P7 非 CORE_* 宿主变量（PATH/HOME）照常透传，NODE_OPTIONS 不带进子进程",
    rw.env.PATH === "/usr/bin" && rw.env.HOME === "/home/u" && rw.env.NODE_OPTIONS === "", { PATH: rw.env.PATH, NODE_OPTIONS: rw.env.NODE_OPTIONS });
  check("P8 ELECTRON_RUN_AS_NODE 恒置 1", rw.env.ELECTRON_RUN_AS_NODE === "1", rw.env.ELECTRON_RUN_AS_NODE);
}

/* ==================================================================
 * 二、起真实 core，ss -tln 断言仅绑 127.0.0.1（仅 POSIX）
 * ================================================================== */
function pickPort() {
  return new Promise((resolve, reject) => {
    const attempt = (p) => {
      if (p > 54299) return reject(new Error("54200–54299 无可用端口"));
      const srv = net.createServer();
      srv.once("error", () => attempt(p + 1));
      srv.listen(p, "127.0.0.1", () => srv.close(() => resolve(p)));
    };
    attempt(54200);
  });
}
function readCoreJson() {
  try {
    return JSON.parse(fs.readFileSync(path.join(RUN, "core.json"), "utf8"));
  } catch {
    return null;
  }
}
function healthOk(port, token) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/health", method: "GET", timeout: 5000, headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}
/** 返回该端口在 ss -tln 里的本地地址列表（如 ["127.0.0.1"] / ["0.0.0.0"]） */
function ssAddrs(port) {
  const out = execSync("ss -tlnH", { encoding: "utf8" });
  const addrs = [];
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const local = cols[3]; // Local Address:Port
    if (!local) continue;
    const idx = local.lastIndexOf(":");
    if (local.slice(idx + 1) !== String(port)) continue;
    addrs.push(local.slice(0, idx));
  }
  return addrs;
}
async function bootAndProbe(label, extraParentEnv, port) {
  fs.rmSync(path.join(RUN, "core.json"), { force: true });
  const { env } = buildBootCoreEnv({ runDir: RUN, uiDist: UI_DIST, agentDir: AGENT, port: String(port), parentEnv: { ...process.env, ...extraParentEnv } });
  const child = spawn(process.execPath, [tsx, coreMain], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (c) => (stderr += c.toString()));
  try {
    let info = null;
    for (let i = 0; i < 100 && !info; i++) {
      info = readCoreJson();
      if (!info) await sleep(300);
    }
    if (!info) {
      check(`${label} core 就绪（读到 core.json）`, false, stderr.slice(-300));
      return;
    }
    const addrs = ssAddrs(info.port);
    check(`${label} ss -tln 仅绑 127.0.0.1（无 0.0.0.0/::/*）`, addrs.length >= 1 && addrs.every((a) => a === "127.0.0.1"), addrs);
    check(`${label} /health 200（用 core.json 里的随机 token）`, await healthOk(info.port, info.token), { port: info.port });
    if (extraParentEnv && "CORE_TOKEN" in extraParentEnv) {
      check(`${label} 宿主注入的 CORE_TOKEN 未透传（token 非宿主值）`, info.token !== HOST_TOKEN, info.token);
    }
  } finally {
    child.kill("SIGTERM");
    await sleep(500);
    child.kill("SIGKILL");
  }
}

if (POSIX) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(RUN, { recursive: true });
  fs.mkdirSync(AGENT, { recursive: true });
  fs.mkdirSync(UI_DIST, { recursive: true });
  fs.writeFileSync(path.join(UI_DIST, "index.html"), "<!doctype html><title>r0</title>");
  const port = await pickPort();
  console.log(`[boot-env] 仓库根 ${repoRoot}\n[boot-env] 端口 ${port}，run/agent=${TMP}`);
  await bootAndProbe("S1 宿主带 CORE_HOST=0.0.0.0", { CORE_HOST: "0.0.0.0", CORE_TOKEN: HOST_TOKEN }, port);
  await bootAndProbe("S2 宿主不带 CORE_HOST", {}, port);
} else {
  skip("S1/S2 起 core + ss -tln 绑定断言（win32 无 ss；纯函数 P1–P8 已在上面跑过）");
}

/* ---------------- 汇总 ---------------- */
const failed = checks.filter((c) => !c.pass);
fs.rmSync(TMP, { recursive: true, force: true });
if (failed.length > 0) {
  console.error(`\nboot-env 检查失败 ${failed.length} 项（跳过 ${skipped.length} 项）：`);
  for (const c of failed) console.error(`  ✗ ${c.name}`);
  process.exit(1);
}
console.log(`boot-env 检查全部通过：${checks.length} 项${skipped.length ? `（跳过 ${skipped.length} 项）` : ""}`);
