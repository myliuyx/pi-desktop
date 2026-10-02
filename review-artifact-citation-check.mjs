/**
 * 临时校验脚本（review 用，跑完即删）：
 * 从 docs/CODE_REVIEW_2026-10.md 抽出所有 `path:line` / `path:line-line` 引用，
 * 逐条核对文件是否存在、行号是否在文件范围内，并打印该行内容供人工判断。
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const report = fs.readFileSync(path.join(root, "docs", "CODE_REVIEW_2026-10.md"), "utf8");

/** 匹配形如 `packages/core/src/server.ts:333` 或 `:333-341`；路径可含中间 segments/scripts/ */
const RE = /((?:packages|docs|scripts|\.github)\/[\w./@-]+\.(?:ts|tsx|mjs|json|yml|md|css)):(\d+)(?:[-,](\d+))?/g;

const seen = new Map();
let m;
while ((m = RE.exec(report)) !== null) {
	const [, file, l1, l2] = m;
	const key = `${file}:${l1}${l2 ? "-" + l2 : ""}`;
	if (!seen.has(key)) seen.set(key, { file, l1: Number(l1), l2: l2 ? Number(l2) : null });
}

let ok = 0;
const problems = [];

for (const { file, l1, l2 } of seen.values()) {
	const abs = path.join(root, file);
	if (!fs.existsSync(abs)) {
		problems.push({ key: `${file}:${l1}`, issue: "文件不存在" });
		continue;
	}
	const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
	if (l1 < 1 || l1 > lines.length) {
		problems.push({ key: `${file}:${l1}`, issue: `行号越界（文件共 ${lines.length} 行）` });
		continue;
	}
	if (l2 !== null && (l2 < l1 || l2 > lines.length)) {
		problems.push({ key: `${file}:${l1}-${l2}`, issue: `结束行号越界（文件共 ${lines.length} 行）` });
		continue;
	}
	ok++;
}

console.log(`引用总数（去重后）= ${seen.size}   通过 = ${ok}   有问题 = ${problems.length}`);
if (problems.length) {
	console.log("\n有问题的引用：");
	for (const p of problems) console.log(`  ${p.key}  →  ${p.issue}`);
} else {
	console.log("全部引用：文件存在且行号在范围内。");
}

// 逐个打印引用行内容，供人工核对语义是否匹配（只打印前 60 条，避免刷屏）
console.log("\n----- 逐条内容抽查（前 60 条）-----");
let i = 0;
for (const { file, l1, l2 } of seen.values()) {
	if (i++ >= 60) break;
	const lines = fs.readFileSync(path.join(root, file), "utf8").split(/\r?\n/);
	const text = lines[l1 - 1].trim();
	console.log(`${file}:${l1}${l2 ? "-" + l2 : ""}`);
	console.log(`    ${text.slice(0, 110)}`);
}

/* ---------------------------------------------------------------------------
 * 第二轮：裸文件名引用（如 `Markdown.tsx:122`、`main.ts:447-452`）
 * 这类引用没有路径，必须靠全仓文件名索引解析——歧义（同名多份）要报出来，
 * 因为 `main.ts` 在 core 与 desktop 各有一份，最容易指错。
 * ------------------------------------------------------------------------- */
const EXCLUDE = /\\(node_modules|dist|build|release|\.git|pi)\\/;
const byName = new Map();
(function walk(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (EXCLUDE.test(p + path.sep)) continue;
		if (e.isDirectory()) walk(p);
		else if (/\.(ts|tsx|mjs|json|yml|md|css)$/.test(e.name)) {
			if (!byName.has(e.name)) byName.set(e.name, []);
			byName.get(e.name).push(path.relative(root, p));
		}
	}
})(root);

const BARE = /`([\w.-]+\.(?:ts|tsx|mjs|json|yml|md|css)):(\d+)(?:[-,](\d+))?`/g;
const bareSeen = new Map();
let b;
while ((b = BARE.exec(report)) !== null) {
	const key = `${b[1]}:${b[2]}${b[3] ? "-" + b[3] : ""}`;
	if (!bareSeen.has(key)) bareSeen.set(key, { name: b[1], l1: Number(b[2]), l2: b[3] ? Number(b[3]) : null });
}

console.log("\n===== 裸文件名引用核查 =====");
const bareProblems = [];
let bareOk = 0;
for (const { name, l1, l2 } of bareSeen.values()) {
	const candidates = byName.get(name) ?? [];
	if (candidates.length === 0) {
		bareProblems.push(`${name}:${l1} → 仓内找不到该文件名`);
		continue;
	}
	const fits = candidates.filter((rel) => {
		const n = fs.readFileSync(path.join(root, rel), "utf8").split(/\r?\n/).length;
		return l1 >= 1 && l1 <= n && (l2 === null || (l2 >= l1 && l2 <= n));
	});
	if (fits.length === 0) {
		bareProblems.push(`${name}:${l1}${l2 ? "-" + l2 : ""} → 行号在所有同名文件中都越界（${candidates.join(", ")}）`);
		continue;
	}
	bareOk++;
	if (candidates.length > 1) {
		console.log(`  ⚠ 歧义：${name}:${l1} → 同名 ${candidates.length} 份：${candidates.join(" | ")}（行号在 ${fits.length} 份中成立）`);
	}
}
console.log(`裸引用（去重）= ${bareSeen.size}  通过 = ${bareOk}  有问题 = ${bareProblems.length}`);
for (const p of bareProblems) console.log(`  ✗ ${p}`);
