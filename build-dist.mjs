#!/usr/bin/env node
/**
 * build-dist.mjs —— 一键重出全部编译产物，防「改了源码忘 build」的产品脱节。
 *
 * ## 背景（2026-09-28 实锤事故）
 *
 * core/dist（tsc）与 ui/dist（vite）是 gitignore 的手工刷新产物，desktop dev
 * 与 web assemble 都直接吃它们；而 CORE_PORT=5190 验收链路用 tsx 直跑 core
 * 源码、不经过 dist——改了源码不重 build，5190 不当场暴露，桌面/web 形态却会
 * 跑旧产物：当时 core/dist 停在 9-25 缺 /skills 路由，GET /skills 落进旧 server
 * 的 SPA 回退返回 200 + index.html，设置弹窗技能/插件 Tab 报「读取技能清单
 * 失败（HTTP 200）」。
 *
 * ## 它做什么
 *
 * 把四步按依赖序一次跑齐（全量不跳步：合计约 10s，换「跑完必新鲜」的确定性）：
 *
 *   [1/4] packages/ui       vite build  → ui/dist（含删除守卫放行变量）
 *   [2/4] packages/core     tsc build   → core/dist（/skills /packages 全套路由）
 *   [3/4] packages/desktop  tsc build   → desktop/dist（electron 主进程 + preload）
 *   [4/4] packages/web      assemble    → web/dist + web/ui（内置新鲜度闸兜底）
 *
 * 任一步失败即停、非零退出；web assemble 里的新鲜度闸是最后防线——若哪一步
 * 产物没跟上源码，会被它点名拒绝而不是悄悄装进桌面/npm 包。
 *
 * 用法：仓库根 `node build-dist.mjs`
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";

const steps = [
	{
		label: "packages/ui（vite → ui/dist，前端构建产物）",
		cwd: "packages/ui",
		script: "build",
		// vite 清空 outDir 会被仓库删除守卫拦下（tiktok-ui-conventions 口径），显式放行
		env: { CODEBUDDY_SAFE_DELETE_ENABLED: "0" },
	},
	{ label: "packages/core（tsc → core/dist，桌面/web 的后台服务）", cwd: "packages/core", script: "build" },
	{ label: "packages/desktop（tsc → desktop/dist，electron 主进程 + preload）", cwd: "packages/desktop", script: "build" },
	{ label: "packages/web（assemble → web/dist + web/ui，npm 包组装）", cwd: "packages/web", script: "assemble" },
];

const t0 = Date.now();
for (const [i, step] of steps.entries()) {
	console.log(`\n[build-dist] [${i + 1}/${steps.length}] ${step.label}`);
	// Windows 的 .cmd 必须经 shell 调起；命令全是本文件的常量（无用户输入），拼接无注入面，
	// 且避开 Node 22 对「shell:true + 参数数组」的 DEP0190 弃用告警
	const res = spawnSync(`${npmCmd} run ${step.script}`, {
		cwd: path.join(root, step.cwd),
		stdio: "inherit",
		shell: isWin,
		env: { ...process.env, ...step.env },
	});
	if (res.status !== 0) {
		console.error(
			`\n[build-dist] ✗ 步骤 ${i + 1}/${steps.length} 失败（${step.label}，exit=${res.status ?? res.error?.code}）` +
				`——已停止，请先解决再重跑。`,
		);
		process.exit(res.status ?? 1);
	}
}

console.log(
	`\n[build-dist] ✓ 全部产物已就绪（总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）：` +
		`ui/dist、core/dist、desktop/dist、web/dist + web/ui。` +
		`桌面形态 packages/desktop 下 npm run dev；web 形态 node packages/web/bin/pi-web.mjs。`,
);
