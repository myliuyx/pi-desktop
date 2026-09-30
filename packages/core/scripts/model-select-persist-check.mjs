/**
 * 模型切换后活动模型持久化 —— `check:model-select`（CR-038，P1）。
 *
 * ## 为什么需要它
 * 用户在设置页 `POST /models/select` 切到模型 B：`session.setModel(B)` 只改了**当前会话**
 * 的模型与 settings.json，却从不回写 core 的闭包 `activeModel`（session.ts:398，唯一赋值点
 * 在 ready 流程 :676）。而 newSession(:808) / rebuildSession(:716) / switchCwd→bootProject(:601)
 * 三处 createAgentSession 都**显式传 `model: activeModel`**（上游 sdk.js：显式 model 覆盖历史/
 * settings 恢复）—— 于是切到 B 后新建/打开历史/切目录，活动模型**静默回退**成启动模型 A，
 * 新会话首条落盘 `model_change` 也写成 A（重启读 settings 才恢复 B，前后行为不一致）。
 *
 * 本脚本起**隔离 core**（端口 54100 段、/tmp/r0-t3、假 provider 双模型 A/B、假 token、
 * baseUrl 本地不可达），复现后固化为断言：
 *   select B 之后，依次 newSession / 打开历史会话 / switchCwd，`GET /models.current.modelId`
 *   **恒为 B**；且新会话首条落盘 `model_change` 为 B。
 * 修复前这些恒为 A（红），修复后恒为 B（绿）。
 *
 * **不发真实请求 / 不出网 / 零费用**：prompt 只用于把 model_change 落到新会话文件（写入发生在
 * 发起 LLM 调用之前、同步完成），随即 `POST /abort` 取消在途生成——baseUrl 是本地不可达端点，
 * 从不触达任何真实上游；不起真实模型。
 *
 * 用法（在 packages/core 下）：`npm run check:model-select`。
 * 端口可覆盖：`MS_PORT=54110 npm run check:model-select`；证据：`run/model-select-evidence.json`。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, "..");
const runDir = path.join(coreDir, "run");
fs.mkdirSync(runDir, { recursive: true });
const evidencePath = path.join(runDir, "model-select-evidence.json");

const TOKEN = "r0-test-token";
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const PROVIDER = "fakeco";
const MODEL_A = "model-A";
const MODEL_B = "model-B";

/** 在 54100–54199 段内找一个空闲端口（宿主 OS 探活），找不到即抛（不占用固定端口硬冲突）。 */
async function pickPort() {
  for (let p = Number(process.env.MS_PORT ?? 54100); p <= 54199; p++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(p, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
    if (free) return p;
  }
  throw new Error("54100–54199 无空闲端口");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 隔离根（本任务固定 /tmp/r0-t3 前缀，跑前清、跑后清）
const base = "/tmp/r0-t3";
fs.rmSync(base, { recursive: true, force: true });
const agentDir = path.join(base, "agent");
const coreRunDir = path.join(base, "run");
const cwd = path.join(base, "cwd");
const cwd2 = path.join(base, "cwd2");
for (const d of [agentDir, coreRunDir, cwd, cwd2]) fs.mkdirSync(d, { recursive: true });

fs.writeFileSync(
  path.join(agentDir, "models.json"),
  JSON.stringify(
    {
      providers: {
        [PROVIDER]: {
          baseUrl: "http://127.0.0.1:9", // 本地不可达端点，绝不触达真实上游
          api: "openai-completions",
          apiKey: TOKEN,
          models: [
            { id: MODEL_A, reasoning: false, input: ["text"], cost: COST },
            { id: MODEL_B, reasoning: false, input: ["text"], cost: COST },
          ],
        },
      },
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(agentDir, "settings.json"),
  JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL_A }),
);

const PORT = await pickPort();

function req(method, p, body, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${TOKEN}` };
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const r = http.request(
      { host: "127.0.0.1", port: PORT, path: p, method, headers, timeout: timeoutMs },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(d);
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode, json, raw: d });
        });
      },
    );
    r.on("error", reject);
    r.on("timeout", () => r.destroy(Object.assign(new Error("timeout"), { __timeout: true })));
    if (payload) r.write(payload);
    r.end();
  });
}

const current = async () => (await req("GET", "/models")).json?.current ?? null;
const modelId = async () => (await current())?.modelId ?? null;

function sessionFiles() {
  const files = [];
  const root = path.join(agentDir, "sessions");
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (fp.endsWith(".jsonl")) files.push(fp);
    }
  })(root);
  return files;
}
function modelChangeOf(file) {
  const lines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return lines.find((l) => (l.type ?? l.entryType) === "model_change") ?? null;
}

const child = spawn("node", ["node_modules/tsx/dist/cli.mjs", "src/main.ts"], {
  cwd: coreDir,
  env: { ...process.env, CORE_PORT: String(PORT), CORE_TOKEN: TOKEN, CORE_RUN_DIR: coreRunDir, CORE_AGENT_DIR: agentDir, CORE_CWD: cwd },
  stdio: ["ignore", "ignore", "ignore"],
  detached: true, // 独立进程组：结束时按 group 一次性 SIGKILL，收掉 tsx 派生的整棵子树
});
// 兜底看门狗：绝不悬挂 CI（无论何路径，90s 后强制杀核并退出）
const watchdog = setTimeout(() => {
  killCore();
  console.error("check:model-select 看门狗超时（90s）强杀 core");
  process.exit(2);
}, 90_000);
watchdog.unref();
const killCore = () => {
  clearTimeout(watchdog);
  try {
    process.kill(-child.pid, "SIGKILL"); // 进程组（POSIX）：收 tsx 全部子进程
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* noop */
    }
  }
};
const cleanup = () => {
  killCore();
  fs.rmSync(base, { recursive: true, force: true });
};
process.on("exit", () => {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* 进程可能已退 */
  }
});

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

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
  if (!up) throw new Error("隔离 core 未在规定时间内就绪");

  check("boot current = model-A", (await modelId()) === MODEL_A, await current());

  const sel = await req("POST", "/models/select", { provider: PROVIDER, modelId: MODEL_B });
  check("select B 生效（current = model-B）", sel.status === 200 && (await modelId()) === MODEL_B, await current());

  /* ---- newSession 后恒 B ---- */
  await req("POST", "/sessions/new");
  check("① newSession 后 current 恒为 model-B", (await modelId()) === MODEL_B, await current());

  /* ---- 把新会话的首条 model_change 落到磁盘（写入在 LLM 调用前同步完成），随即 abort 取消在途 ---- */
  // baseUrl 本地不可达 → 客户端短超时即断，服务端 model_change 早已同步落盘；abort 恢复 isStreaming。
  await req("POST", "/prompt", { text: "ping" }, 2500).catch(() => {});
  let s1 = null;
  let mc = null;
  for (let i = 0; i < 20; i++) {
    const files = sessionFiles().sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (files.length) {
      s1 = files[0];
      mc = modelChangeOf(s1);
      if (mc) break;
    }
    await sleep(200);
  }
  check(
    "② 新会话首条落盘 model_change = model-B",
    !!mc && mc.modelId === MODEL_B,
    mc ?? { s1: s1 ? path.basename(s1) : null },
  );

  // 取消在途生成（baseUrl 不可达，abort 即恢复 isStreaming=false），保证后续 newSession/load/cwd 不被护栏拦
  await req("POST", "/abort", {}, 3000).catch(() => {});
  await sleep(400);

  /* ---- 再次 newSession 后恒 B ---- */
  await req("POST", "/sessions/new");
  check("③ (abort 后) newSession 后 current 恒为 model-B", (await modelId()) === MODEL_B, await current());

  /* ---- 打开历史会话（load ②里落盘的那条）后恒 B ---- */
  const s1Id = s1 ? path.basename(s1, ".jsonl") : null;
  const sessions = (await req("GET", "/sessions")).json?.sessions ?? [];
  const target = s1Id ? sessions.find((s) => s.id === s1Id) ?? sessions[sessions.length - 1] : sessions[sessions.length - 1];
  if (!target?.id) {
    check("④ load 历史会话后 current 恒为 model-B", false, { reason: "无历史会话可加载", sessions: sessions.length });
  } else {
    const ld = await req("POST", "/sessions/load", { id: target.id });
    check("④ load 历史会话后 current 恒为 model-B", ld.status === 200 && (await modelId()) === MODEL_B, await current());
  }

  /* ---- switchCwd 后恒 B ---- */
  const cw = await req("POST", "/cwd", { dir: cwd2 });
  check("⑤ switchCwd 后 current 恒为 model-B", cw.status === 200 && (await modelId()) === MODEL_B, await current());
} catch (e) {
  check("（运行异常）", false, { error: e instanceof Error ? e.message : String(e) });
} finally {
  cleanup();
}

const evidence = { startedAt: new Date().toISOString(), port: PORT, checks };
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

const failed = checks.filter((c) => !c.pass).length;
if (failed > 0) {
  console.error(`\nmodel-select 检查失败 ${failed} 项（证据：${evidencePath}）`);
  process.exit(1);
}
console.log(`model-select 检查全部通过：${checks.length} 项（证据：${evidencePath}）`);
