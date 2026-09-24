/**
 * 验收脚本的凭证注入（2026-09-24）。
 *
 * 背景：core 侧的 `--env-file` 用法已删除（那是早期开发时把 POC 的 `.env.local` 注进子进程的
 * 遗留做法）—— `packages/core/package.json` 的 `smoke` 已变成裸 `node …/tsx src/main.ts`。
 * 但验收脚本仍然需要一个**已配置凭证**的 provider：Pi 的 `getAvailableSnapshot()` 只收录
 * 「有凭证」的 provider，而 c3~c6 / providers-check / live:smoke / probe:* 都会真的发一次
 * 请求（夹具里的 `models.json` 写的是 `"apiKey": "$ARK_API_KEY"`）。
 *
 * 口径（与 README 的 `export ARK_API_KEY=<key>` 完全一致，**优先级从高到低**）：
 *   1. 脚本显式给的 `extra`（如 CORE_TOKEN / CORE_AGENT_DIR）；
 *   2. 调用方 shell 里已有的变量（`ARK_API_KEY=… npm run check:c6`）；
 *   3. 本机遗留密钥文件 `pi/_poc/.env.local`（`pi/` 整体 gitignore；缺失不算错，
 *      只是需要真实凭证的断言会如实变红 —— 不会假绿）。
 * 密钥只在**测试进程内**传递，绝不写进任何被提交的文件。
 *
 * UI 包的脚本同样 import 本文件（`packages/ui/scripts/*.mjs` → `../../core/scripts/lib/…`）：
 * 两个包共用一套口径，避免各写一份解析逻辑（本项目吃过「两处同口径、改一处忘另一处」的亏）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
/** packages/core/scripts/lib → 仓库根 */
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const LEGACY_ENV_FILE = path.join(repoRoot, "pi", "_poc", ".env.local");

let legacyCache = null;
let warned = false;

function legacyVars() {
  if (legacyCache) return legacyCache;
  legacyCache = {};
  try {
    for (const line of fs.readFileSync(LEGACY_ENV_FILE, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      legacyCache[m[1]] = value;
    }
  } catch {
    /* 文件不存在 / 不可读：留空对象，由断言如实失败 */
  }
  return legacyCache;
}

/**
 * 组装被启动 core 的子进程 env：`{ ...遗留文件, ...process.env, ...extra }`。
 * 每次都重新评估 `process.env`（脚本里可能中途改过），遗留文件只解析一次。
 */
export function childEnv(extra = {}) {
  const env = { ...legacyVars(), ...process.env, ...extra };
  if (!env.ARK_API_KEY && !warned) {
    warned = true;
    console.error(
      "[harness] 未找到 ARK_API_KEY（shell 未 export，且 pi/_poc/.env.local 也没有）——" +
        "夹具里的 provider 会被 Pi 视作「无凭证」，需要真实模型的断言会失败。",
    );
  }
  return env;
}

/** 遗留密钥文件路径（个别脚本要把它复制进夹具时用得上） */
export const LEGACY_ENV_PATH = LEGACY_ENV_FILE;

/** 真实模型清单夹具（`"apiKey": "$ARK_API_KEY"` 的插值原文就在这里） */
export const POC_MODELS_FIXTURE = path.join(repoRoot, "pi", "_poc", "models.json");

/**
 * 把真实模型清单夹具复制进 `<agentDir>/models.json`，返回是否成功。
 *
 * `CORE_MODELS_PATH` 覆盖口删除后，清单**只能**经 Pi 的约定位置 `<agentDir>/models.json` 给到
 * core —— 所以每个 core 实例的临时 agentDir 都要放一份副本（这也顺带保证验收**绝不碰**
 * `~/.pi/agent`）。原件缺失时返回 false：core 会自建空清单，需要真实模型的断言会如实变红。
 */
export function seedModelsJson(agentDir) {
  fs.mkdirSync(agentDir, { recursive: true });
  try {
    fs.copyFileSync(POC_MODELS_FIXTURE, path.join(agentDir, "models.json"));
    return true;
  } catch {
    return false;
  }
}
