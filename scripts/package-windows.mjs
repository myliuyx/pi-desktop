#!/usr/bin/env node
/**
 * package-windows.mjs —— 打 Windows 包（NSIS 安装包）的薄包装。
 *
 * 全部逻辑在 `package-desktop.mjs`，本文件只固定目标平台，让「打包 Windows」
 * 是一条不需要记参数的命令。`package-desktop.mjs windows` 与本文件等价。
 *
 * ## 平台前提（读 electron-builder 源码核实）
 *
 * - Windows 宿主：原生可跑，无需额外依赖。
 * - Linux 宿主：可跑，但 NSIS 阶段需要 wine（electron-builder 用它生成卸载器）。
 *   缺 wine 时本脚本会点名报错并给出三条出路，不自动装 —— 装 wine 要 root。
 * - macOS 宿主：electron-builder 支持（本脚本透传）。
 *
 * 用法：node scripts/package-windows.mjs [--skip-build]
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inner = spawnSync(process.execPath, [path.join(root, "scripts", "package-desktop.mjs"), "windows", ...process.argv.slice(2)], {
	cwd: root,
	stdio: "inherit",
});
process.exit(inner.status ?? 1);
