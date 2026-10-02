#!/usr/bin/env node
/**
 * package-desktop.mjs —— 三平台桌面打包（electron-builder）。
 *
 * ## 为什么需要它（既有 build-dist.mjs 不够）
 *
 * 根目录 `build-dist.mjs` 只负责**重出编译产物**（ui/dist、core/dist、desktop/dist、
 * web/dist），到 electron-builder 之前就停了。而 `packages/desktop/package.json` 的
 * `npm run dist` 是 `tsc && electron-builder`，**没有先出 ui/core 产物** ——
 * electron-builder 会把 `../ui/dist`、`../core/dist`、`../core/node_modules` 以
 * extraResources 打进安装包，产物过期就直接把旧代码装进包里。
 * 这正是 2026-09-28 实锤事故的形态（core/dist 停在 9-25，缺 /skills 路由）。
 *
 * 所以本脚本的口径是「先 `build-dist.mjs` 出产物，再 electron-builder」，
 * 与 `.github/workflows/build.yml` 的 step 顺序（ui → core → desktop → builder）同构。
 *
 * ## 三平台的真实能力边界（读 electron-builder 源码核实，非推测）
 *
 * electron-builder **不支持**在 Linux 上打 macOS 包：`packager.js:369` 对
 * `platform === MAC && process.platform === win32` 直接抛
 * `Build for macOS is supported only on macOS`。
 *
 * Windows 包在 Linux 上**可以**打，但 NSIS 阶段需要 wine
 * （`app-builder-lib/out/toolsets/wine.js:36-40`：非 mac 且非 win 时走系统 `wine`）。
 * 本脚本对 wine 的处理是**预检 + 明确报错**，不自动安装 —— 装 wine 要 root，
 * 而打包机通常是普通用户；自动 `sudo apt-get install` 属于擅自改用户机器，
 * 属于本项目明令避免的行为（`recent-dirs.ts` / `main.ts` 都有同款纪律注释）。
 *
 * ## 用法
 *
 *   node scripts/package-desktop.mjs            # 按当前平台自动选目标
 *   node scripts/package-desktop.mjs linux      # 强制 Linux（AppImage + deb）
 *   node scripts/package-desktop.mjs windows    # 强制 Windows（NSIS，需 wine）
 *   node scripts/package-desktop.mjs mac        # 强制 macOS（仅 macOS 宿主可跑）
 *   node scripts/package-desktop.mjs windows --skip-build   # 跳过产物重建（调试用）
 *
 * 任一步失败即非零退出，不留半成品假装成功。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";
/*
 * npx 同理：Windows 上必须走 npx.cmd（PATHEXT 才有 .cmd 扩展名可解析），
 * 非 Windows 直接用 npx。spawnSync 用 shell:false 时 Node 不做 PATHEXT 查找。
 */
const npxCmd = isWin ? "npx.cmd" : "npx";

/** 三平台的目标（electron-builder 的 target 名 + 产物扩展名），与 build.yml 的 upload 路径一致 */
const TARGETS = {
	windows: { builderFlag: "--win nsis", exts: [".exe"], label: "Windows / NSIS 安装包" },
	linux: { builderFlag: "--linux AppImage deb", exts: [".AppImage", ".deb"], label: "Linux / AppImage + deb" },
	mac: { builderFlag: "--mac dmg zip", exts: [".dmg", ".zip"], label: "macOS / dmg + zip（未签名）" },
};

/**
 * 当前平台能打什么。macOS 包只能在 macOS 宿主上出，其余两平台本机可行
 * （Windows 需 wine，见文件头说明）。
 *
 * @param {string | undefined} arg 命令行第一个非选项参数
 * @returns {keyof typeof TARGETS}
 */
function resolvePlatform(arg) {
	if (arg && !arg.startsWith("-") && arg in TARGETS) return arg;
	if (isWin) return "windows";
	if (process.platform === "darwin") return "mac";
	return "linux";
}

const platform = resolvePlatform(process.argv[2]);
const skipBuild = process.argv.includes("--skip-build");
const target = TARGETS[platform];

/**
 * wine 预检：只在「Linux 上打 Windows 包」这一种组合下需要。
 * electron-builder 会在 NSIS 阶段调 wine 跑卸载器生成，缺 wine 会中途才炸，
 * 报错信息绕；这里提前点名，报错文案说清怎么装。
 *
 * 依据（读 electron-builder 源码核实）：app-builder-lib/out/toolsets/wine.js:36-40
 * —— 非 mac 宿主且未设 ELECTRON_BUILDER_WINE_TOOLSET_DIR 时走系统 `wine`。
 *
 * @returns {boolean} 预检通过返回 true；不通过则已打印指引
 */
function checkWine() {
	if (platform !== "windows" || process.platform !== "linux") return true;
	const probe = spawnSync("wine", ["--version"], { stdio: "ignore", shell: false });
	if (probe.status === 0) return true;
	console.error(
		"\n[package] ✗ 在 Linux 上打 Windows 包需要 wine（electron-builder 的 NSIS 阶段要它生成卸载器）。\n" +
			"      本机未检测到 wine。三选一：\n" +
			"        1. 装系统 wine（需 root）：sudo apt-get install -y wine wine64\n" +
			"        2. 换 Windows 机器打包：node scripts/package-desktop.mjs windows\n" +
			"        3. 走 CI（已有三平台矩阵）：推送 v* tag 或手动触发 .github/workflows/build.yml\n" +
			"      本脚本不自动安装 —— 装系统级依赖要 root，打包机通常是普通用户。",
	);
	return false;
}

/** 产物是否产出：electron-builder 成功退出不等于一定有包（如目标被配置跳过） */
function collectArtifacts() {
	const releaseDir = path.join(root, "packages", "desktop", "release");
	if (!fs.existsSync(releaseDir)) return [];
	const found = [];
	for (const name of fs.readdirSync(releaseDir)) {
		if (target.exts.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()))) found.push(name);
	}
	return found.sort();
}

const t0 = Date.now();
console.log(`[package] 目标平台: ${platform}（${target.label}）`);
console.log(`[package] 宿主平台: ${process.platform}${platform === process.platform ? "（原生）" : "（跨平台）"}`);

/*
 * ★ macOS 宿主预检。electron-builder 不支持在非 macOS 宿主上打 macOS 包
 * （app-builder-lib/out/packager.js:369 对目标 MAC + 非 macOS 宿主直接抛
 * InvalidConfigurationError）。这里提前拦，理由有二：
 *   1. 不 rebuild 产物 —— 否则白跑十几秒 vite/tsc 再撞墙；
 *   2. 报错文案点名源码依据与三条出路，而不是让它死在打包中段的无关错误上。
 */
if (platform === "mac" && process.platform !== "darwin") {
	console.error(
		"\n[package] ✗ macOS 包只能在 macOS 宿主上打。\n" +
			"      electron-builder 不支持跨平台打 macOS 包（app-builder-lib/out/packager.js:369 对\n" +
			"      目标 MAC + 非 macOS 宿主直接抛 Build for macOS is supported only on macOS）。\n" +
			`      当前宿主是 ${process.platform}。三条出路：\n` +
			"        1. 换一台 Mac 跑：node scripts/package-mac.mjs\n" +
			"        2. 走 CI（已有三平台矩阵）：推送 v* tag，或在 Actions 页手动触发 build.yml\n" +
			"        3. 若必须在本机出包，需要 macOS 虚拟环境（本项目不覆盖该路径）\n",
	);
	process.exit(1);
}

if (!checkWine()) process.exit(1);

if (!skipBuild) {
	/*
	 * 先出全部编译产物。ui / core 的 dist 是 electron-builder 的 extraResources 输入，
	 * 产物过期 = 把旧代码装进安装包（build-dist.mjs 文件头记录的事故形态）。
	 * desktop 自己的 dist 也在这里出（build-dist.mjs 第 3 步），故后面不必再单独 tsc。
	 */
	console.log(`\n[package] [1/2] 重建编译产物（build-dist.mjs）…`);
	const build = spawnSync(process.execPath, [path.join(root, "build-dist.mjs")], {
		cwd: root,
		stdio: "inherit",
	});
	if (build.status !== 0) {
		console.error(`\n[package] ✗ 编译产物重建失败（exit=${build.status ?? build.error?.code}）——已停止，未进入打包。`);
		process.exit(build.status ?? 1);
	}
} else {
	console.log(`\n[package] [1/2] 跳过产物重建（--skip-build，请自行确认产物新鲜）`);
}

console.log(`\n[package] [2/2] electron-builder ${target.builderFlag} …`);
/*
 * 装依赖：electron-builder 是 desktop 的 devDependency，但 `--skip-build` 之外
 * 也可能因 node_modules 缺失而失败。这里只在 node_modules 缺失时装，避免每次
 * 都跑一遍慢的 npm ci。--publish never：不发 Release（发版由 CI 的 release job 做）。
 */
if (!fs.existsSync(path.join(root, "packages", "desktop", "node_modules"))) {
	console.log("[package] desktop/node_modules 缺失，先 npm ci …");
	const ci = spawnSync(npmCmd, ["ci"], { cwd: path.join(root, "packages", "desktop"), stdio: "inherit", shell: isWin });
	if (ci.status !== 0) {
		console.error(`\n[package] ✗ desktop 依赖安装失败（exit=${ci.status ?? ci.error?.code}）`);
		process.exit(ci.status ?? 1);
	}
}

const builder = spawnSync(npxCmd, ["electron-builder", target.builderFlag, "--publish", "never"], {
	cwd: path.join(root, "packages", "desktop"),
	stdio: "inherit",
	shell: isWin,
});
if (builder.status !== 0) {
	console.error(`\n[package] ✗ electron-builder 失败（exit=${builder.status ?? builder.error?.code}）`);
	process.exit(builder.status ?? 1);
}

const artifacts = collectArtifacts();
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n[package] ✓ 打包完成（${elapsed}s）`);
if (artifacts.length === 0) {
	// 不静默：electron-builder 退出 0 但没包 = 用户拿不到东西，必须点名
	console.error(`[package] ✗ electron-builder 退出 0 但 release/ 下没有 ${platform} 产物 ——视为失败，请查上方日志。`);
	process.exit(1);
}
console.log(`[package] 产物（packages/desktop/release/）：`);
for (const name of artifacts) {
	const size = (fs.statSync(path.join(root, "packages", "desktop", "release", name)).size / 1024 / 1024).toFixed(1);
	console.log(`  · ${name}  ${size} MB`);
}
if (platform === "mac") {
	console.log("[package] 提示：macOS 产物未签名，首次打开需右键 →「打开」绕过 Gatekeeper。");
}
