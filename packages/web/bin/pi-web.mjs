#!/usr/bin/env node
/**
 * pi-web CLI 入口 —— 一条命令起 Pi-Desktop 的自托管 web 形态。
 *
 * 装配形态：tarball 里 dist/ = packages/core 的 tsc 产物，ui/ = packages/ui 的
 * vite 产物（发布前由 scripts/assemble.mjs 组装，见 build.yml 的 publish job）。
 *
 * 这里只兜两个默认值（用户环境变量永远优先，用 if 而非 ??=，空串也算没配）：
 * - CORE_UI_DIST → 包内随发的 ui/（不兜底则 core 缺省路径指向源码仓布局，装完必 404）
 * - CORE_RUN_DIR → ~/.pi-web（core.json / events.jsonl 落全局 node_modules
 *   或用户 cwd 都不合适；家目录约定同上游 Pi 的 ~/.pi）
 * 其余环境变量（CORE_PORT / CORE_HOST / CORE_TOKEN / CORE_CWD / …）语义与
 * packages/core 完全一致，见仓库 README「环境变量」表。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");

if (!process.env.CORE_UI_DIST) {
	process.env.CORE_UI_DIST = path.join(pkgRoot, "ui");
}
if (!process.env.CORE_RUN_DIR) {
	process.env.CORE_RUN_DIR = path.join(os.homedir(), ".pi-web");
}
fs.mkdirSync(process.env.CORE_RUN_DIR, { recursive: true });

console.log(`[pi-web] 运行时目录: ${process.env.CORE_RUN_DIR}`);
await import(pathToFileURL(path.join(pkgRoot, "dist", "main.js")).href);
