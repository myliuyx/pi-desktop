#!/usr/bin/env node
/**
 * package-mac.mjs —— 打 macOS 包（dmg + zip）的薄包装。
 *
 * 全部逻辑在 `package-desktop.mjs`，本文件只固定目标平台，让「打包 macOS」
 * 是一条不需要记参数的命令。`package-desktop.mjs mac` 与本文件等价。
 *
 * ## ★ 平台硬约束：只能在 macOS 宿主上跑
 *
 * electron-builder 不支持在非 macOS 宿主上打 macOS 包。源码依据
 * （`app-builder-lib/out/packager.js:369`）：目标平台为 MAC 且宿主非 macOS 时
 * 直接抛 `Build for macOS is supported only on macOS`。
 *
 * 本脚本**提前**检查并给出可执行的出路，而不是让它跑到一半炸在 NSIS 之后的某个
 * 无关报错上。三条出路：
 *   1. 换一台 Mac 跑本脚本；
 *   2. 走 CI —— 仓库已有三平台矩阵（`.github/workflows/build.yml` 的
 *      `matrix.os: [windows-latest, macos-latest, ubuntu-latest]`），
 *      推送 `v*` tag 或在 Actions 页手动触发即可拿到 macOS 包；
 *   3. 若确实需要在 Linux 上出包，只能另起 macOS 虚拟环境 —— 本项目不覆盖该路径。
 *
 * 另注：仓库无签名/公证证书，产物为**未签名** dmg/zip，macOS 首开需
 * 右键 →「打开」绕过 Gatekeeper（README 与 build.yml 同款口径）。
 *
 * 用法：node scripts/package-mac.mjs [--skip-build]
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/*
 * 提前拦截（读 electron-builder 源码核实：packager.js:369 对非 macOS 宿主抛
 * InvalidConfigurationError）。在非 macOS 宿主上直接点名，不 spawn 一次注定失败的
 * 打包 —— 顺带省掉重建产物的十几秒。
 */
if (process.platform !== "darwin") {
	console.error(
		"\n[package-mac] ✗ macOS 包只能在 macOS 宿主上打。\n" +
			"      electron-builder 不支持跨平台打 macOS 包（app-builder-lib/out/packager.js:369\n" +
			"      对目标 MAC + 非 macOS 宿主直接抛 Build for macOS is supported only on macOS）。\n" +
			`      当前宿主是 ${process.platform}。三条出路：\n` +
			"        1. 换一台 Mac 跑：node scripts/package-mac.mjs\n" +
			"        2. 走 CI（已有三平台矩阵）：推送 v* tag，或在 Actions 页手动触发 build.yml\n" +
			"        3. 若必须在本机出包，需要 macOS 虚拟环境（本项目不覆盖该路径）\n",
	);
	process.exit(1);
}

const inner = spawnSync(process.execPath, [path.join(root, "scripts", "package-desktop.mjs"), "mac", ...process.argv.slice(2)], {
	cwd: root,
	stdio: "inherit",
});
process.exit(inner.status ?? 1);
