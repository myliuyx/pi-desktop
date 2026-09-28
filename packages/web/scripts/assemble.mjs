/**
 * 组装 npm 发布包：把兄弟包的构建产物拷进本包 tarball 目录。
 *
 * 前置：packages/core/dist（tsc 产物）与 packages/ui/dist（vite 产物）必须已存在 ——
 * 各自 `npm run build` 产出；CI（build.yml publish job）按 ui → core → assemble 顺序保证。
 * 拷进来的 dist/ 与 ui/ 都在 .files 白名单里、且被 gitignore（构建产物不入库）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 新鲜度闸：源码里最新的文件比产物里最新的文件还新 = 产物过期，拒绝组装。
 *
 * 2026-09-28 实锤事故：本机 core/dist 停在 9-25（没有 /skills /packages 路由），
 * 手工 assemble 把它拷进包里，配上 9-28 的新 UI —— 设置弹窗技能 Tab 的
 * GET /skills 落进旧 server 的 SPA 回退，前端拿到 200 + index.html，
 * 报「读取技能清单失败（HTTP 200）」。CI 的 ui → core → assemble 顺序天然
 * 新鲜，这个闸只管本机手工 assemble：点名要求先 build，而不是把过期产物
 * 悄悄装进桌面 / npm 包。目录缺失不拦（下游已有的缺失检查会点名）。
 */
function newestMtime(root, exts) {
	let newest = 0;
	const walk = (dir) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (exts.some((x) => e.name.endsWith(x))) {
				const ms = fs.statSync(p).mtimeMs;
				if (ms > newest) newest = ms;
			}
		}
	};
	walk(root);
	return newest;
}

function assertFresh(srcDir, distDir, srcExts, distExts, name, buildHint) {
	const srcNewest = newestMtime(srcDir, srcExts);
	const distNewest = newestMtime(distDir, distExts);
	if (srcNewest === 0 || distNewest === 0 || srcNewest <= distNewest) return;
	console.error(
		`[assemble] ✗ ${name}产物已过期（源码的改动晚于产物）：\n` +
			`  最新源码：${new Date(srcNewest).toLocaleString()}\n` +
			`  现有产物：${new Date(distNewest).toLocaleString()}\n` +
			`  先执行 ${buildHint}，再重新 assemble。`,
	);
	process.exit(1);
}

assertFresh(
	path.resolve(pkgRoot, "..", "core", "src"),
	path.resolve(pkgRoot, "..", "core", "dist"),
	[".ts"],
	[".js"],
	"core/dist",
	"packages/core 下的 npm run build",
);
assertFresh(
	path.resolve(pkgRoot, "..", "ui", "src"),
	path.resolve(pkgRoot, "..", "ui", "dist"),
	[".ts", ".tsx", ".css"],
	[".html", ".js", ".css"],
	"ui/dist",
	"packages/ui 下的 npm run build",
);

const jobs = [
	{ from: path.resolve(pkgRoot, "..", "core", "dist"), to: path.join(pkgRoot, "dist"), name: "core/dist" },
	{ from: path.resolve(pkgRoot, "..", "ui", "dist"), to: path.join(pkgRoot, "ui"), name: "ui/dist" },
];

for (const { from, to, name } of jobs) {
	if (!fs.existsSync(from)) {
		console.error(`[assemble] 缺少 ${name}（${from}）—— 先在对应包里 npm run build`);
		process.exit(1);
	}
	fs.rmSync(to, { recursive: true, force: true });
	fs.cpSync(from, to, { recursive: true });
	console.log(`[assemble] ${name} → ${path.relative(pkgRoot, to)}`);
}
console.log("[assemble] 组装完成，可 npm publish");
