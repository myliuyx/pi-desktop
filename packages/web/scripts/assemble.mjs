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
