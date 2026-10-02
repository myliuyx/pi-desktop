#!/usr/bin/env node
/**
 * package-linux.mjs —— 打 Linux 包（AppImage + deb）的薄包装。
 *
 * 全部逻辑在 `package-desktop.mjs`，本文件只固定目标平台，让「打包 Linux」
 * 是一条不需要记参数的命令。`package-desktop.mjs linux` 与本文件等价。
 *
 * ## 平台前提
 *
 * 三平台里唯一**在 Linux 宿主上原生可跑**的目标：AppImage 与 deb 的工具链
 * （appimagetool、fpm 等）electron-builder 会自行下载，不依赖系统 wine。
 * 故本脚本在任意宿主上都能直接跑，不会触发 wine 预检失败。
 *
 * 用法：node scripts/package-linux.mjs [--skip-build]
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inner = spawnSync(process.execPath, [path.join(root, "scripts", "package-desktop.mjs"), "linux", ...process.argv.slice(2)], {
	cwd: root,
	stdio: "inherit",
});
process.exit(inner.status ?? 1);
