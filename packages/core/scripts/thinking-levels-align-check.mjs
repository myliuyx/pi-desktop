/**
 * 思考档位全集与 Pi 的对齐检查 —— `check:thinking-levels`（2026-10-01）。
 *
 * ## 为什么需要它
 * `src/models.ts` 的 `THINKING_LEVELS` 原先是**手抄** Pi `core/defaults.ts` 的
 * `THINKING_LEVEL_OPTIONS`（7 档）的一只副本，没有任何断言守住。Pi 升版加/删一档时：
 *   - 少一档 ⇒ 副本里那一档被 `normalizeThinkingLevel` 当作**非法值丢弃**，
 *     `POST /thinking` 收 400，UI 里那档永远点不动；
 *   - 多一档 ⇒ 副本放行了一个 Pi 已不认的值，进了 settings.json 却生效不了。
 * 两类都是**静默**失配：没有任何报错，只有用户发现「有档位点不动」。
 *
 * 现在 `models.ts` 改为运行期从 Pi 真值加载（`import.meta.resolve` 绕开 `exports`），
 * 但**兜底字面量**还在（加载失败时用，见 models.ts 的 FALLBACK_THINKING_LEVELS 注释）。
 * 本脚本守住两件事：
 *   1. 兜底内容与当前安装的 Pi 一致（漂移即红）；
 *   2. 真值加载路径真的生效了、没在静默降级（否则修复等于没做）。
 *
 * ## 对齐源为什么是 `node_modules` 而不是 `pi/`
 * `pi/` 是 vendored clone 且被 `.gitignore:45` 整体忽略（换机 / CI 上可能根本不存在），
 * 而 `node_modules/@earendil-works/pi-coding-agent` 才是 core **实际运行**的那一份。
 * 断言必须对着运行时真相，否则等于没断言。
 *
 * ## 判据
 *   A · 全集一致：Pi 的 `THINKING_LEVEL_OPTIONS` 与 models.ts 兜底常量逐项相等
 *             （长度 + 顺序 + 值）。
 *   B · 真值路径生效：实际 import core 的 `dist/models.js`，断言导出的
 *      `THINKING_LEVELS` 与 Pi 逐项相等 —— 证明真值加载没静默降级。
 *   C · 默认档位：core 导出的默认档位与 Pi 的 `DEFAULT_THINKING_LEVEL` 一致。
 *   D · 解析器自检：⭐ 确认能从 Pi 的 `.d.ts` 抽到 `DEFAULT_THINKING_LEVEL: ThinkingLevel;`
 *      且 `defaults.js` 里该标识符确实存在。**两条都抽不到 ⇒ 判「解析失灵」并红**。
 *      —— 解析器悄悄失灵却报全绿，是本项目的头号教训（见
 *      `packages/ui/scripts/contract-mirror-check.mjs:20-24` 的原话）。
 *
 * **不起 core / 不出网 / 零费用**（只需 node + 已构建的 dist）。
 *
 * 用法（在 packages/core 下）：
 *   npm run check:thinking-levels
 *   证据：run/thinking-levels-align-evidence.json
 * 路径可覆盖（自查探针本身是否真的会红时用得上 —— 拿临时副本跑）：
 *   node scripts/thinking-levels-align-check.mjs <piPackageDir> <coreDistDir> <coreSrcFile>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, "..");
const runDir = path.join(coreDir, "run");
fs.mkdirSync(runDir, { recursive: true });
const evidencePath = path.join(runDir, "thinking-levels-align-evidence.json");

/** 路径默认值（可用命令行参数覆盖） */
const piPackageDir =
  process.argv[2] ?? path.join(coreDir, "node_modules", "@earendil-works", "pi-coding-agent");
const coreDistDir = process.argv[3] ?? path.join(coreDir, "dist");
const coreSrcFile = process.argv[4] ?? path.join(coreDir, "src", "models.ts");

const checks = [];
const check = (name, pass, detail) => {
	checks.push({ name, pass: !!pass, detail });
	console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

/* =========================================================================
 * 从 Pi 的 JS/D.TS 里抽字面量字符串数组与单个字面量字符串。
 *
 * ⚠️ 抽不到时一律返回 null（**不返回空数组**）：空数组与「真的就是空」无法区分，
 * 混进断言会造成假绿。所有调用点都必须显式处理 null。
 * ========================================================================= */

/**
 * 抽 `NAME: T = ["a", "b"];`（数组字面量，允许换行 / 尾逗号）。
 *
 * ⚠️ `export` 是**可选**的：core 的 `FALLBACK_THINKING_LEVELS` 是模块内私有常量（不导出），
 *   而 Pi 的 `THINKING_LEVEL_OPTIONS` 是导出的。写成 `export\s+const` 会让前者抽不到
 *   —— 这不是假绿而是**判红**（fail-closed），但仍会误报成「兜底缺失」，掩盖真正的漂移。
 */
function extractStringArray(source, name) {
	const re = new RegExp(`(?:export\\s+)?const\\s+${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\]`, "m");
	const m = re.exec(source);
	if (!m) return null;
	const items = [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
	// 只匹配到空 body 视为没抽到（`[]` 本身是合法但这里不该出现，抽不到更诚实）
	return items.length > 0 ? items : null;
}

/** 抽 `NAME: T = "value";`（`export` 同上可选） */
function extractStringLiteral(source, name) {
	const re = new RegExp(`(?:export\\s+)?const\\s+${name}\\b[^=]*=\\s*["']([^"']+)["']`, "m");
	const m = re.exec(source);
	return m ? m[1] : null;
}

/* =========================================================================
 * 读 Pi 侧的两个文件
 * ========================================================================= */

const pkgJsonPath = path.join(piPackageDir, "package.json");
if (!fs.existsSync(pkgJsonPath)) {
	console.error(`✗ 找不到 Pi 包：${pkgJsonPath}\n  提示：先在 packages/core 下 npm install`);
	fs.writeFileSync(evidencePath, JSON.stringify({ ok: false, error: "Pi 包不存在" }, null, 2));
	process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
const typesFile = path.join(piPackageDir, pkg.exports["."].types);
const entryFile = path.join(piPackageDir, pkg.exports["."].import);
const defaultsJs = path.join(path.dirname(entryFile), "core", "defaults.js");
const defaultsDts = path.join(path.dirname(typesFile), "core", "defaults.d.ts");

for (const f of [entryFile, defaultsJs, defaultsDts]) {
	if (!fs.existsSync(f)) {
		console.error(`✗ Pi 的 defaults 文件不存在：${f}\n  提示：Pi 可能改了目录结构，需同步 models.ts 的真值加载路径`);
		fs.writeFileSync(evidencePath, JSON.stringify({ ok: false, error: `缺文件 ${f}` }, null, 2));
		process.exit(1);
	}
}

const piJs = fs.readFileSync(defaultsJs, "utf8");
const piDts = fs.readFileSync(defaultsDts, "utf8");

/* =========================================================================
 * 判据 D · 解析器自检（必须先跑 —— 它是其它判据可信的前提）
 * ========================================================================= */

console.log("\n[判据 D] 解析器自检");
const dtsHasDefault = /export\s+declare\s+const\s+DEFAULT_THINKING_LEVEL\b[^:]*:\s*\w/.test(piDts);
const jsHasDefaultIdent = /\bDEFAULT_THINKING_LEVEL\b/.test(piJs);
const dtsHasOptions = /export\s+declare\s+const\s+THINKING_LEVEL_OPTIONS\b/.test(piDts);
check("能从 .d.ts 抽到 DEFAULT_THINKING_LEVEL 的类型声明", dtsHasDefault, { defaultsDts });
check("defaults.js 里存在 DEFAULT_THINKING_LEVEL 标识符", jsHasDefaultIdent, { defaultsJs });
check("能从 .d.ts 抽到 THINKING_LEVEL_OPTIONS 的声明", dtsHasOptions, { defaultsDts });

const parseOk = dtsHasDefault && jsHasDefaultIdent && dtsHasOptions;
if (!parseOk) {
	console.error(
		"\n✗ 解析器自检未通过 —— 本次结果**不可信**，不继续跑断言（否则会给假绿）。\n" +
			"  Pi 若改了 defaults 的导出形态，请同步更新本脚本的抽取正则。",
	);
	fs.writeFileSync(
		evidencePath,
		JSON.stringify({ ok: false, reason: "解析器自检未通过，断言中止", checks }, null, 2),
	);
	process.exit(1);
}

/* =========================================================================
 * 判据 A / C：Pi 真值
 * ========================================================================= */

console.log("\n[判据 A·C] Pi 真值");
const piLevels = extractStringArray(piJs, "THINKING_LEVEL_OPTIONS");
const piDefault = extractStringLiteral(piJs, "DEFAULT_THINKING_LEVEL");
check("抽到 Pi 的 THINKING_LEVEL_OPTIONS", Array.isArray(piLevels), { piLevels });
check("抽到 Pi 的 DEFAULT_THINKING_LEVEL", typeof piDefault === "string", { piDefault });

/* =========================================================================
 * 判据 A：core 源码里的兜底常量
 * ========================================================================= */

console.log("\n[判据 A] core 兜底常量 vs Pi");
const coreSrc = fs.existsSync(coreSrcFile) ? fs.readFileSync(coreSrcFile, "utf8") : "";
const fallbackLevels = extractStringArray(coreSrc, "FALLBACK_THINKING_LEVELS");
check("core 源码里能定位 FALLBACK_THINKING_LEVELS", Array.isArray(fallbackLevels), { coreSrcFile });
check(
	"兜底清单与 Pi 逐项相等（长度 + 顺序 + 值）",
	Array.isArray(fallbackLevels) && Array.isArray(piLevels) && sameSeq(fallbackLevels, piLevels),
	{ 兜底: fallbackLevels, Pi: piLevels },
);

/* =========================================================================
 * 判据 B / C：core 构建产物的**实际生效值**
 * ========================================================================= */

console.log("\n[判据 B·C] core 构建产物（真值加载路径是否生效）");
const coreModelsFile = path.join(coreDistDir, "models.js");
if (!fs.existsSync(coreModelsFile)) {
	console.error(
		`✗ 找不到 ${coreModelsFile} —— 请先 npm run build（判据 B/C 验的是构建产物）。`,
	);
	fs.writeFileSync(
		evidencePath,
		JSON.stringify({ ok: false, reason: "dist/models.js 不存在", checks }, null, 2),
	);
	process.exit(1);
}
const core = await import(new URL(`file://${coreModelsFile}`).href);
const coreLevels = core.THINKING_LEVELS;
check("core 导出的 THINKING_LEVELS 是非空数组", Array.isArray(coreLevels) && coreLevels.length > 0, {
	coreLevels,
});
check("core 生效清单与 Pi 逐项相等（证明真值加载未静默降级）", sameSeq(coreLevels, piLevels), {
	core: coreLevels,
	Pi: piLevels,
});
check("core 生效清单与自身兜底常量相等", sameSeq(coreLevels, fallbackLevels ?? []), {
	core: coreLevels,
	兜底: fallbackLevels,
});

/*
 * 判据 C · 默认档位。
 * models.ts 本轮**不导出** DEFAULT_THINKING_LEVEL（按用户裁决，首帧默认档位不接 Pi），
 * 故这里退一步断言「core 侧不存在一个写死的默认档位常量」—— 即 models.ts 里
 * 除 normalizeThinkingLevel 的 "off" 兜底外，没有别的硬编码档位。
 * 若将来接入，这里改成读 core.DEFAULT_THINKING_LEVEL 与 piDefault 比对。
 */
const srcHasHardcodedDefault = /export\s+const\s+DEFAULT_THINKING_LEVEL\b/.test(coreSrc);
check("core 未引入写死的 DEFAULT_THINKING_LEVEL（默认档位不接 Pi，按裁决）", !srcHasHardcodedDefault, {
	coreSrcFile,
});

/* =========================================================================
 * 汇总
 * ========================================================================= */

function sameSeq(a, b) {
	return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
}

const failed = checks.filter((c) => !c.pass);
const ok = failed.length === 0;
fs.writeFileSync(
	evidencePath,
	JSON.stringify(
		{
			ok,
			pkg: { name: pkg.name, version: pkg.version },
			piLevels,
			piDefault,
			fallbackLevels,
			coreLevels: Array.from(coreLevels ?? []),
			failed: failed.map((c) => c.name),
			checks,
		},
		null,
		2,
	),
);

console.log(
	`\n${ok ? "✓ 思考档位与 Pi 完全对齐" : `✗ ${failed.length} 项未通过`}` +
		`（Pi ${pkg.name}@${pkg.version}）\n== 证据已写入 ${evidencePath}`,
);
console.log(`  Pi 档位     : ${piLevels?.join(" / ")}`);
console.log(`  Pi 默认档位 : ${piDefault}`);
console.log(`  core 兜底   : ${fallbackLevels?.join(" / ")}`);
console.log(`  core 生效   : ${Array.from(coreLevels ?? []).join(" / ")}`);
process.exit(ok ? 0 : 1);
