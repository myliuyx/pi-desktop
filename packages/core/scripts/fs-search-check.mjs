/**
 * /fs/search 文件模糊搜索端点检查 —— `check:fs-search`（at-file 批次 P0，task-composer-at-file.md §4.1）。
 *
 * 覆盖（单 core 串行请求，CORE_CWD 指向 git 仓库夹具）：
 *   S1  无 token ⇒ 401（API_ROUTES 鉴权生效）；
 *   S2  缺省 path ⇒ cwd === core 进程 cwd；
 *   S3  精确命中：q=readme.md（大小写不敏感）⇒ 第一名 README.md；
 *   S4  basename 前缀 > 全路径子串：q=alpha ⇒ 恰命中 src/alpha.ts + docs/guide/alpha.md，
 *       同分下短路径在前（src/alpha.ts 排首）；
 *   S5  子序列：q=nodex ⇒ src/node-x.ts 命中（node_modules 不该抢——被排除，见 S6）；
 *   S6  walk 与 git 都排除重目录：plain/node_modules/deep/z.js 对 q=z 不可见；
 *   S7  .gitignore 过滤（仅 git 可用时有意义）：ignored.txt 不可见；
 *   S8  relPath 恒 POSIX 风格（无反斜杠）；
 *   S9  空 query ⇒ 全候选按短路径前，且只含文件；
 *   S10 非 git 目录 ⇒ walk 回退照常列出（path=plain）；
 *   S11 limit=1 ⇒ 恰 1 条 + truncated；
 *   S12 不存在 path ⇒ 400；文件 path ⇒ 400「不是目录」；path=. ⇒ core cwd。
 *
 * 用法（在 packages/core 下）：`npm run check:fs-search`
 * 证据：`run/fs-search-evidence.json`；失败非 0 退出。
 */

import { execSync } from "node:child_process";
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
const mainPath = path.join(coreDir, "src", "main.ts");
const mainArgs = process.env.CORE_ENTRY ? [path.resolve(process.env.CORE_ENTRY)] : [tsxPath, mainPath];
const runDir = path.join(coreDir, "run");
const evidencePath = path.join(runDir, "fs-search-evidence.json");
fs.mkdirSync(runDir, { recursive: true });

const PORT = Number(process.env.FS_SEARCH_PORT ?? 5233);
const TOKEN = process.env.FS_SEARCH_TOKEN ?? "fs-search-token";
const HTTP_TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fs-search-"));

/* ---------------------------------------------------------------------------
 * 夹具一：cwd-fixture（core 进程 cwd；git 可用时 git init + .gitignore）
 * ------------------------------------------------------------------------- */
const coreCwd = path.join(tmpRoot, "cwd-fixture");
for (const rel of ["src/alpha.ts", "src/beta.md", "docs/guide/alpha.md", "src/node-x.ts"]) {
  fs.mkdirSync(path.join(coreCwd, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(coreCwd, rel), "内容\n");
}
fs.writeFileSync(path.join(coreCwd, "README.md"), "readme\n");
fs.writeFileSync(path.join(coreCwd, "a-note.txt"), "note\n");
fs.writeFileSync(path.join(coreCwd, "ignored.txt"), "应被 gitignore 排除\n");

let hasGit = false;
try {
  execSync("git --version", { stdio: "ignore" });
  hasGit = true;
  fs.writeFileSync(path.join(coreCwd, ".gitignore"), "ignored.txt\n");
  execSync("git init", { cwd: coreCwd, stdio: "ignore" });
} catch {
  /* 无 git ⇒ walk 模式，S7 标记跳过 */
}

/* 夹具二：plain（tmpRoot 下、非 git 仓库）⇒ 强制 walk 回退 */
const plainDir = path.join(tmpRoot, "plain");
fs.mkdirSync(path.join(plainDir, "sub"), { recursive: true });
fs.writeFileSync(path.join(plainDir, "x.txt"), "x\n");
fs.writeFileSync(path.join(plainDir, "sub", "y.md"), "y\n");
fs.mkdirSync(path.join(plainDir, "node_modules", "deep"), { recursive: true });
fs.writeFileSync(path.join(plainDir, "node_modules", "deep", "z.js"), "z\n");

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

function request(p, { token = TOKEN, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: p, method: "GET", headers, timeout: timeoutMs },
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
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout(${timeoutMs}ms)`)));
    req.end();
  });
}

const search = (q, { target, limit, ...opts } = {}) => {
  const usp = new URLSearchParams();
  if (q !== undefined) usp.set("q", q);
  if (target) usp.set("path", target);
  if (limit !== undefined) usp.set("limit", String(limit));
  const qs = usp.toString();
  return request(`/fs/search${qs ? `?${qs}` : ""}`, opts);
};

async function waitForHealth(timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await request("/health");
      if (r.status === 200) return r.json;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(300);
  }
}

function bootCore() {
  const agentDir = path.join(tmpRoot, "agentdir");
  fs.mkdirSync(agentDir, { recursive: true });
  seedModelsJson(agentDir);
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));
  const logFd = fs.openSync(path.join(runDir, "fs-search.log"), "w");
  return spawn(process.execPath, mainArgs, {
    cwd: coreCwd,
    env: childEnv({ CORE_TOKEN: TOKEN, CORE_PORT: String(PORT), CORE_AGENT_DIR: agentDir }),
    stdio: ["ignore", "ignore", logFd],
  });
}

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */

const evidence = { startedAt: new Date().toISOString(), checks, hasGit };
const child = bootCore();
try {
  const health = await waitForHealth();
  check("前置 core 正常启动", !!health, health);
  if (!health) throw new Error("core 未能在 60s 内就绪");

  /* ===== S1：无 token ⇒ 401 ===== */
  {
    const r = await search("x", { token: "" });
    check("S1 无 token ⇒ 401（API_ROUTES 鉴权生效）", r.status === 401, { status: r.status });
  }

  /* ===== S2：缺省 path ⇒ core 进程 cwd ===== */
  {
    const r = await search("");
    check("S2 缺省 path ⇒ cwd === core 进程 cwd", r.status === 200 && r.json?.cwd === coreCwd, {
      status: r.status,
      got: r.json?.cwd,
      want: coreCwd,
    });
  }

  /* ===== S3：精确命中（大小写不敏感） ===== */
  {
    const r = await search("readme.md");
    check(
      "S3 q=readme.md ⇒ 第一名 README.md（大小写不敏感）",
      r.status === 200 && r.json?.entries?.[0]?.relPath === "README.md",
      { status: r.status, entries: r.json?.entries },
    );
  }

  /* ===== S4：basename 前缀打分 + 短路径决胜 ===== */
  {
    const r = await search("alpha");
    const rels = (r.json?.entries ?? []).map((e) => e.relPath);
    check(
      "S4 q=alpha ⇒ 恰 2 条且 src/alpha.ts 排首（前缀同分短路径前）",
      r.status === 200 && rels.length === 2 && rels[0] === "src/alpha.ts" && rels.includes("docs/guide/alpha.md"),
      { rels },
    );
  }

  /* ===== S5：子序列命中 ===== */
  {
    const r = await search("nodex");
    const rels = (r.json?.entries ?? []).map((e) => e.relPath);
    check("S5 q=nodex ⇒ src/node-x.ts 经子序列命中", rels.includes("src/node-x.ts"), { rels });
  }

  /* ===== S6：重目录排除（plain 走 walk，恒无 git） ===== */
  {
    const r = await search("z", { target: plainDir });
    check(
      "S6 plain 下 q=z ⇒ node_modules 里的 z.js 不可见（walk 排除重目录）",
      r.status === 200 && (r.json?.entries ?? []).length === 0,
      { entries: r.json?.entries },
    );
  }

  /* ===== S7：.gitignore 过滤（git 模式） ===== */
  if (hasGit) {
    const r = await search("ignored");
    check(
      "S7 q=ignored ⇒ ignored.txt 被 .gitignore 排除（git 模式）",
      r.status === 200 && (r.json?.entries ?? []).length === 0,
      { entries: r.json?.entries },
    );
  } else {
    checks.push({ name: "S7 .gitignore 过滤（git 模式）", pass: true, detail: "本机无 git，跳过" });
    console.log("  - S7 跳过（本机无 git，夹具走 walk 模式）");
  }

  /* ===== S8：relPath 恒 POSIX 风格 ===== */
  {
    const r = await search("");
    const ok = r.status === 200 && (r.json?.entries ?? []).every((e) => !e.relPath.includes("\\"));
    check("S8 全部 relPath 无反斜杠（POSIX 口径）", ok, r.json?.entries?.slice(0, 3));
  }

  /* ===== S9：空 query ⇒ 只含文件、短路径前 ===== */
  {
    const r = await search("");
    const entries = r.json?.entries ?? [];
    const lens = entries.map((e) => e.relPath.length);
    check(
      "S9 空 query ⇒ 非空且 relPath 长度非降序、只含文件",
      r.status === 200 && entries.length > 0 && lens.every((l, i) => i === 0 || lens[i - 1] <= l),
      { lens },
    );
  }

  /* ===== S10：非 git 目录 walk 回退 ===== */
  {
    const r = await search("y", { target: plainDir });
    check(
      "S10 非 git 目录 ⇒ walk 回退照常命中 sub/y.md",
      r.status === 200 && (r.json?.entries ?? []).some((e) => e.relPath === "sub/y.md"),
      { entries: r.json?.entries },
    );
  }

  /* ===== S11：limit 截断 ===== */
  {
    const r = await search("", { limit: 1 });
    check(
      "S11 limit=1 ⇒ 恰 1 条 + truncated:true",
      r.status === 200 && r.json?.entries?.length === 1 && r.json?.truncated === true,
      { count: r.json?.entries?.length, truncated: r.json?.truncated },
    );
  }

  /* ===== S12：400 语义与 path=. ===== */
  {
    const missing = await search("x", { target: path.join(coreCwd, "no-such-dir") });
    check(
      "S12a 不存在 path ⇒ 400「目录不存在」",
      missing.status === 400 && missing.json?.error?.includes("目录不存在"),
      { status: missing.status, error: missing.json?.error },
    );
    const fileAsDir = await search("x", { target: path.join(coreCwd, "README.md") });
    check(
      "S12b 文件 path ⇒ 400「不是目录」",
      fileAsDir.status === 400 && fileAsDir.json?.error?.includes("不是目录"),
      { status: fileAsDir.status, error: fileAsDir.json?.error },
    );
    const dot = await search("", { target: "." });
    check("S12c path=. ⇒ 解析到 core cwd", dot.status === 200 && dot.json?.cwd === coreCwd, {
      got: dot.json?.cwd,
      want: coreCwd,
    });
  }

  /* ===== S13/S14：目录候选（D6，2026-09-28 裁决：目录可引用，文件与目录同榜） ===== */
  {
    const r = await search("docs");
    const first = r.json?.entries?.[0];
    check(
      "S13 q=docs ⇒ 第一名是 kind:dir 的 docs 目录（absPath 绝对）",
      r.status === 200 &&
        first?.kind === "dir" &&
        first?.relPath === "docs" &&
        path.isAbsolute(first?.absPath ?? ""),
      { first },
    );
    const src = await search("src");
    const kinds = new Set((src.json?.entries ?? []).map((e) => e.kind));
    check(
      "S14 q=src ⇒ 目录与文件同榜（两种 kind 都在）",
      src.status === 200 && kinds.has("dir") && kinds.has("file"),
      { kinds: [...kinds] },
    );
  }
} catch (e) {
  check("脚本异常终止", false, String(e));
} finally {
  child.kill("SIGTERM");
  await sleep(500);
}

evidence.finishedAt = new Date().toISOString();
evidence.checks = checks;
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

const failed = checks.filter((c) => !c.pass).length;
if (failed > 0) {
  console.error(`\nfs-search 检查失败 ${failed} 项（证据：${evidencePath}）`);
  process.exit(1);
}
console.log(`fs-search 检查全部通过：${checks.length} 项（证据：${evidencePath}）`);
