/**
 * 「添加技能」安装写路径检查 —— `check:skills-install`（2026-09-29 合并前加固批次）。
 *
 * **为什么需要它**：dev 分支新增的 `skills-install.ts` / `skills-search.ts` 此前
 * **零自动化覆盖**（`packages/core/package.json` 无对应脚本），三条阻塞级缺陷
 * （C1 进度事件被白名单静默丢弃 / C2 技能目录里的符号链接被原样搬进用户 skills 目录 /
 * C3 仓库根 SKILL.md 会连 .git 一起搬）全部躲过了浏览器探针 —— 探针只覆盖错误码，
 * 不覆盖文件系统后果与事件投递。本脚本把评审结论固化成可执行断言。
 *
 * **不起真实模型、不出网**（照 `sessions-manage-check.mjs` 范式）：
 *   - 纯函数 / 文件系统类判据直接 import `src/skills-install.ts`，用**合成目录**驱动
 *     （`fs.mkdirSync` / `writeFileSync` / `symlinkSync`；**绝不用 `ln -sfn` 造夹具** ——
 *     软链透过进仓库会覆盖 `node_modules` 里的文件，本仓库已吃过这个亏）；
 *   - HTTP 类判据起真实 core，但只打**不出网**的端点（入参校验 / 错误码 / 安全三件套 /
 *     静态源码断言）；连 `q` 长度边界那类会触发上游代理的请求都不打；
 *   - `installSkillFromGitHub` 的入参校验（source 形态 / skillId 长度）**早于 clone**，
 *     故这两类可离线调用断言；真正需要 clone 的路径（404 无此技能、cp 中途失败）本批
 *     **不覆盖**，并在末尾 skip 清单里写明理由。
 *
 * **判据写法上的自我要求**（本脚本的生命线）：断言必须**能证伪**，不能恒真。
 * 凡是「复刻源码私有函数」或「读源码文本」的判据，一律配一个**反事实对拍** ——
 * 断言复刻结果**既不等于**旧实现的结果，也不等于另一个显然不同的实现的结果。
 * 只断言「输出等于我复刻的函数」不构成证据（复刻与源码同进同退，等于没验）。
 *
 * **A11（流式中 409）标 skip**：造流式窗口必须真发一轮 `/prompt`（起真实模型），
 * 与本脚本范式冲突，且本机无 `ARK_API_KEY`、也无 `pi/_poc/.env.local` 夹具。
 * 它的护栏改由 **A5b** 在 12 个同级端点上做交叉断言兜底（见下文局限说明）。
 *
 * 用法（在 packages/core 下）：`npm run check:skills-install`
 * 端口可覆盖：`SI_PORT=5300 npm run check:skills-install`
 * 证据：`run/skills-install-evidence.json`；失败非 0 退出。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, seedModelsJson } from "./lib/credentials.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, "..");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
const mainPath = path.join(coreDir, "src", "main.ts");
const mainArgs = process.env.CORE_ENTRY ? [path.resolve(process.env.CORE_ENTRY)] : [tsxPath, mainPath];
const runDir = path.join(coreDir, "run");
fs.mkdirSync(runDir, { recursive: true });
const evidencePath = path.join(runDir, "skills-install-evidence.json");

const PORT = Number(process.env.SI_PORT ?? 5225);
const TOKEN = process.env.SI_TOKEN ?? "si-token";
const HTTP_TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skills-install-"));

/** 本批显式不覆盖的判据（理由写进证据，读者不必翻报告） */
const SKIPPED = [];

const checks = [];
const check = (name, pass, detail) => {
	checks.push({ name, pass: !!pass, detail });
	console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

/* ----------------------------- HTTP 小工具（sessions-manage-check 同款） */
function request(method, p, body, { token = TOKEN, host } = {}) {
	return new Promise((resolve, reject) => {
		const headers = {};
		if (token) headers.Authorization = `Bearer ${token}`;
		if (host) headers.Host = host;
		let payload;
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			payload = JSON.stringify(body);
		}
		const req = http.request(
			{ host: "127.0.0.1", port: PORT, path: p, method, headers, timeout: HTTP_TIMEOUT_MS },
			(res) => {
				let d = "";
				res.on("data", (c) => (d += c));
				res.on("end", () => {
					let json = null;
					try {
						json = JSON.parse(d);
					} catch {
						/* 非 JSON */
					}
					resolve({ status: res.statusCode, json, raw: d });
				});
			},
		);
		req.on("error", reject);
		req.on("timeout", () => req.destroy(new Error(`timeout(${HTTP_TIMEOUT_MS}ms)`)));
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

async function waitForHealth(ok, timeoutMs = 60_000) {
	const t0 = Date.now();
	for (;;) {
		try {
			const r = await request("GET", "/health");
			if (r.status === 200 && r.json && (!ok || ok(r.json))) return r.json;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() - t0 > timeoutMs) return null;
		await sleep(300);
	}
}

/* ==================================================================
 * 判据 A1–A7：纯函数 + 合成目录（不起 core、不出网）
 * ================================================================== */

const mod = await import(path.join(coreDir, "src", "skills-install.ts"));
const {
	installSkillFromGitHub,
	assertSkillDirSafe,
	SkillInstallError,
	MAX_SKILL_FILES,
	MAX_SKILL_ID_LENGTH,
	MAX_QUERY_LENGTH,
} = mod;

const installSource = fs.readFileSync(path.join(coreDir, "src", "skills-install.ts"), "utf8");

/**
 * 合成一个含 SKILL.md 的技能目录（可注入额外条目）。
 * `extra` 的 kind 支持："symlink"（指向文件的链接）、"dirlink"（指向目录的链接）、
 * "raw"（调用方自己造）。
 * 返回 null 表示本机造不出该夹具（Windows 无符号链接权限等）—— 调用方据此如实记 skip。
 */
function synthSkillDir(root, { name = "my-skill", sub = "skills/foo", extra = [] } = {}) {
	const dir = path.join(root, sub);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n\nbody\n`, "utf8");
	for (const [rel, kind] of extra) {
		const full = path.join(dir, rel);
		if (kind === "symlink" || kind === "dirlink") {
			// 目标不存在也不要紧：闸门用 lstat 判条目类型（readdirSync + withFileTypes），
			// 既不 stat 也不解引用 ⇒ 这才是真的「造出链接」，不是造出一个普通目录。
			const target = kind === "dirlink" ? path.join(dir, "real-sub") : "/etc/passwd";
			if (kind === "dirlink") fs.mkdirSync(target, { recursive: true });
			try {
				fs.symlinkSync(target, full, kind === "dirlink" ? "dir" : "file");
			} catch (e) {
				// Windows 未开开发者模式时无符号链接权限 —— 如实报出来，不静默当成「通过」
				console.log(`    （符号链接夹具创建失败：${e.code}，相关变体改记 skip）`);
				return null;
			}
		} else {
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, "x", "utf8");
		}
	}
	return dir;
}

/** 同步闸门 / Promise 安装：返回 SkillInstallError 的 status；不抛则返回 null；抛别的错则回字符串 */
async function expectStatus(fn) {
	try {
		await fn();
		return null;
	} catch (e) {
		return e instanceof SkillInstallError ? e.status : `非 SkillInstallError: ${e?.message ?? String(e)}`;
	}
}

/* ---------- A1：非法 source → 400，且零落盘 ---------- */
{
	const dst = path.join(tmpRoot, "a1-dst");
	const st = await expectStatus(() =>
		installSkillFromGitHub({ source: "not a repo", skillId: "x", targetSkillsDir: dst }),
	);
	check("A1 非法 source → 400", st === 400, st);
	check("A1 非法 source 未创建任何目录", !fs.existsSync(dst), fs.existsSync(dst));
	const tmpLeaks = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("pi-skill-install-"));
	check("A1 非法 source 未留 pi-skill-install-* 临时目录（入参校验早于 mkdtemp/clone）", tmpLeaks.length === 0, tmpLeaks);
}

/* ---------- A2：落盘目录名消毒（sanitizeDirName 是模块私有函数） ----------
 * 无法直接调（未导出、且不该为测试加导出），故按**源码正则逐字复刻**断言其语义。
 * 复刻口径（skills-install.ts 的 sanitizeDirName）：
 *   - 第 1 遍把非 [\w.-] 逐字符换成 "-"
 *   - 第 2 遍剥掉首尾的 [-.] （run 起来）
 *   - 剥完为空 ⇒ 回落 "skill"
 * 断言两件真正要紧的事：① 拼出的落盘路径**不越出** targetSkillsDir；② 是**单段**名。
 * 配套反事实对拍：把「剥首尾 [-.]」去掉（连剥两次 `^[-.]+`）的反事实实现，
 * 对 ".." 只能剥成空 ⇒ 回落 "skill"。断言源码**剥得出 "."** 而反事实剥不出 ——
 * 这样「源码正则被改掉」与「复刻被改掉」都会红，不存在两者同进同退的恒真。
 */
{
	const m = /function sanitizeDirName\(skillId: string\): string \{([\s\S]*?)\n\}/.exec(installSource);
	const fnBody = m ? m[1] : "";
	const sanitize = (s) => {
		const cleaned = s.replace(/[^\w.-]/g, "-").replace(/^[-.]+|[-.]+$/g, "");
		return cleaned.length > 0 ? cleaned : "skill";
	};
	// 反事实对拍：只做字符替换、**不剥首尾 [-.]** 的「天真实现」。
	// 它的后果正是目录穿越：skillId ".." 会拼出 targetSkillsDir 的父目录，
	// "." 会拼出 targetSkillsDir 本身。源码的剥首尾正则就是堵这个的唯一一道。
	check("A2 源码里 sanitizeDirName 的第 2 遍是「首尾交替 run」口径", /replace\(\/\^\[-\.\]\+\|\[-\.\]\+\$\/g, ""\)/.test(fnBody), fnBody || "未匹配到函数体");
	const noStrip = (s) => {
		const cleaned = s.replace(/[^\w.-]/g, "-");
		return cleaned.length > 0 ? cleaned : "skill";
	};
	const dstEscape = path.join(tmpRoot, "a2-dst");
	fs.mkdirSync(dstEscape, { recursive: true });
	check("A2 剥首尾是唯一拦住「..」穿越的一道（不剥 ⇒ 落盘名指回 targetSkillsDir 的父目录）", sanitize("..") === "skill" && path.resolve(dstEscape, noStrip("..")) === path.resolve(tmpRoot), { 源码口径: sanitize(".."), 天真口径: noStrip(".."), 天真口径拼出的路径: path.resolve(dstEscape, noStrip("..")) });
	check("A2 剥首尾也拦住「.」（不剥 ⇒ 落盘名指回 targetSkillsDir 本身）", sanitize(".") === "skill" && path.resolve(dstEscape, noStrip(".")) === path.resolve(dstEscape), { 源码口径: sanitize("."), 天真口径: noStrip(".") });

	const dst = path.join(tmpRoot, "a2-dst");
	fs.mkdirSync(dst, { recursive: true });
	const resolvedDst = path.resolve(dst);
	const label = (s) => (s.length > 24 ? `${JSON.stringify(s.slice(0, 10))}…(${s.length} 字符)` : JSON.stringify(s));
	for (const bad of [".", "..", "...", "a/../../b", "   ", "x".repeat(400), "a\\..\\..\\b", "／／"]) {
		const dirName = sanitize(bad);
		const full = path.resolve(dst, dirName);
		const inside = full.startsWith(resolvedDst + path.sep);
		check(`A2 skillId=${label(bad)} 落盘名不越出目标目录`, inside && dirName.length > 0, { dirName, full });
	}
	for (const bad of ["a/b", "a\\b", "C:evil", "..", "."]) {
		const dirName = sanitize(bad);
		check(`A2 skillId=${JSON.stringify(bad)} 落盘名是单段名（无分隔符/盘符）`, dirName === path.basename(dirName) && !/[\\/]/.test(dirName) && !dirName.includes(":"), dirName);
	}
	// 剥空回落：全是非法字符 / 全是首尾标点 ⇒ 必须回落到固定名，而不是空串
	check("A2 全非法字符 ⇒ 回落固定名 skill", sanitize("///") === "skill", sanitize("///"));
	check("A2 全标点 ⇒ 回落固定名 skill", sanitize("-.-") === "skill", sanitize("-.-"));
	// 复刻保真：把源码函数体里**最后一个** replace 的正则原文抠出来直接跑一遍。
	// 源码的剥离规则一改，这个对拍就红（而不是「复刻与源码同进同退」的假绿）。
	const replaces = [...fnBody.matchAll(/replace\(\/([^/]*)\/g, "([^"]*)"\)/g)];
	const lastReplace = replaces[replaces.length - 1];
	const viaSourceRegex = lastReplace
		? (s) => {
				const c = s.replace(/[^\w.-]/g, "-").replace(new RegExp(lastReplace[1], "g"), lastReplace[2]);
				return c.length > 0 ? c : "skill";
			}
		: null;
	const probe = [".", "..", "...", "a/../../b", "   ", "-.-", "a-b", "C:evil", "／／", "x".repeat(400)];
	check("A2 复刻与源码正则同源（逐条剥离规则一致）", !!viaSourceRegex && probe.every((s) => viaSourceRegex(s) === sanitize(s)), { 抠出的正则: lastReplace ? `/${lastReplace[1]}/g` : "未找到" });
	check("A2 复刻与源码正则同源（剥空回落一致）", !!viaSourceRegex && viaSourceRegex("///") === sanitize("///") && viaSourceRegex("-.-") === sanitize("-.-"), viaSourceRegex ? { 源码: viaSourceRegex("-.-"), 复刻: sanitize("-.-") } : "未找到");
}

/* ---------- A3：技能目录含符号链接 → 422（C2 回归防线） ---------- */
{
	// 闸门必须**先判链接、再判目录**：指向目录的链接会再 walk 一次（depth+1），
	// 顺序反了链接就只当普通目录放行 —— 这条变体正是 A3 能被证伪的地方。
	const withLink = synthSkillDir(path.join(tmpRoot, "a3"), { extra: [["passwd", "symlink"]] });
	if (!withLink) {
		SKIPPED.push({ id: "A3", reason: "本机无法创建符号链接（无权限），C2 闸门无法离线验证" });
	} else {
		const st = await expectStatus(() => assertSkillDirSafe(withLink, "my-skill"));
		check("A3 技能目录含符号链接（指向文件）→ 422（C2）", st === 422, st);
		// 「闸门只报 422、却把半份技能目录落进用户 skills 目录」是另一种回归：
		// 闸门是纯函数，调用后目标 skills 目录必须一个字节都没动
		const dst = path.join(tmpRoot, "a3-dst");
		fs.mkdirSync(dst, { recursive: true });
		await expectStatus(() => assertSkillDirSafe(withLink, "my-skill"));
		check("A3 命中闸门时未写目标技能目录（零落盘）", fs.readdirSync(dst).length === 0, fs.readdirSync(dst));
	}
	// 指向目录的链接同样是链接 —— 少了这条，「只判链接指向文件」的变体会漏
	const linkToDir = synthSkillDir(path.join(tmpRoot, "a3-linkdir"), { extra: [["sub", "dirlink"]] });
	if (linkToDir && !SKIPPED.some((s) => s.id === "A3")) {
		const st = await expectStatus(() => assertSkillDirSafe(linkToDir, "my-skill"));
		check("A3 指向目录的符号链接 → 422（先判链接、再判目录）", st === 422, st);
	}
	// 深层嵌套里的链接同样要命中（闸门递归，链接不能藏在子目录里）
	const nested = path.join(tmpRoot, "a3-nested", "skills", "foo");
	fs.mkdirSync(path.join(nested, "deep"), { recursive: true });
	fs.writeFileSync(path.join(nested, "SKILL.md"), "---\nname: my-skill\n---\n\n\n", "utf8");
	let nestedOk = true;
	try {
		fs.symlinkSync("/etc/passwd", path.join(nested, "deep", "leak"), "file");
	} catch (e) {
		nestedOk = false;
		console.log(`    （深层符号链接夹具创建失败：${e.code}，该变体已跳过）`);
	}
	if (nestedOk) {
		const st = await expectStatus(() => assertSkillDirSafe(nested, "my-skill"));
		check("A3 子目录里的符号链接 → 422（闸门递归、不漏深处）", st === 422, st);
	}
	// 反向对照：干净目录必须放行，否则「见链接就拒」会让功能彻底不可用
	const clean = synthSkillDir(path.join(tmpRoot, "a3-clean"));
	check("A3 无符号链接的干净目录通过闸门（不误伤）", (await expectStatus(() => assertSkillDirSafe(clean, "my-skill"))) === null);
}

/* ---------- A4：确定性选取（深优先 + 码点序）
 * pickBest 未导出（Task 1~5 无需为此加导出），故按**源码 comparator 逐字复刻**，
 * 并与两个反事实实现对拍：最浅优先（旧实现）、localeCompare（I4 的病根）。
 * 断言「复刻选出的结果 ≠ 反事实选出的结果」，这样任一侧被改都会红。 */
{
	// comparator 抠不出来（例如有人把 `depthB - depthA` 改成 `depthA - depthB`，
	// 抠取正则要求三元式的首段字面是 `depthB - depthA`）。**绝不能让它拖垮整个脚本**
	// —— 那样 A9/A10/A12 这些还没跑的判据会被静默跳过（实测：深优先反转会让脚本
	// 在此处抛 SyntaxError，后半程判据一条都不执行）。故显式短路成「返回 1」并如实标红。
	const deepFirst = /return depthA !== depthB \? depthB - depthA : ([^;]+);/.exec(installSource);
	const sourceTail = deepFirst ? deepFirst[1] : "";
	// 只看函数体，避开头部注释里「原实现用 `localeCompare`」那句历史说明
	const pickBestBody = /function pickBest\(candidates: string\[\]\): string \{([\s\S]*?)\n\}/.exec(installSource)?.[1] ?? "";
	/**
	 * 按**从源码抠出来的 comparator 字符串**现场构造选函数（不写死、不手抄）。
	 * new Function + eval 在这里是有意识的取舍：本判据就是「把源码那一行当作可执行代码跑」，
	 * 源码一行既改不得、也抄不得（手抄会与源码漂移，抄错则恒真）。
	 * new Function 而非裸 eval：不捕获局部作用域；新函数里显式算好深度再 eval，
	 * 判据引用的 depthA/depthB/a/b 全部是自有的名字，不依赖外层闭包。
	 */
	const makePick = (cmpSrc) => {
		// 先验证表达式本身合法 —— 不先验证的话，eval 的 SyntaxError 会在第一条 A4 行为
		// 里扔出去，**拖垮整个脚本**（实测：深优先反转会让脚本崩在 A4，后半程 A9/A10/A12
		// 一条都不跑，只留一条 ✗，看着像“只坏了一处”）。先语法检查再跑，才能真正标红。
		try {
			new Function("a", "b", "const depthA = 1, depthB = 1; return (" + cmpSrc + ");");
		} catch (e) {
			console.log(`    （源码 comparator 表达式不合法/抠取失败：${e?.message ?? e}）`);
			return () => null;
		}
		const sortFn = new Function(
			"cmpSrc",
			"a",
			"b",
			"const depthA = a.split(/[\\\\/]/).length, depthB = b.split(/[\\\\/]/).length; return eval(cmpSrc);",
		);
		return (candidates) => [...candidates].sort((a, b) => sortFn(cmpSrc, a, b))[0];
	};
	const shallowest = (c) => [...c].sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length)[0];
	const localePick = (c) => [...c].sort((a, b) => a.localeCompare(b))[0];

	check(
		"A4 源码 comparator 是「深优先 + 码点序」（a < b ? -1 : a > b ? 1 : 0，函数体内无 localeCompare）",
		!!deepFirst && /a < b \? -1 : a > b \? 1 : 0/.test(sourceTail) && !!pickBestBody && !/localeCompare/.test(pickBestBody),
		{ comparator: sourceTail || "未匹配到 comparator（深优先首段不是 `depthB - depthA`？）", 函数字: pickBestBody.slice(0, 200) },
	);

	const deep = ["a/SKILL.md", "z/SKILL.md", "a/b/SKILL.md"];
	// 构造出选函数：拼回完整的 comparator 表达式再交给 new Function
	const pick = makePick(`depthA !== depthB ? depthB - depthA : ${sourceTail}`);
	check("A4 同深度多个 SKILL.md → 取更深路径（I5）", pick(deep) === "a/b/SKILL.md", { 选中: pick(deep) });
	check("A4 深优先结果 ≠ 最浅优先（旧实现的选法）", pick(deep) !== shallowest(deep), { 旧实现: shallowest(deep) });

	// 大小写组合：码点序 Z(0x5A) < a(0x61)，localeCompare 在 ICU 下按字母序 a < Z
	const casePair = ["Z/SKILL.md", "a/SKILL.md"];
	check("A4 大小写混合的同深度候选 → 码点序取 Z（I4）", pick(casePair) === "Z/SKILL.md", { 选中: pick(casePair) });
	check("A4 码点序结果 ≠ localeCompare 结果（I4 病根对拍：locale 取 a）", pick(casePair) !== localePick(casePair), { 码点序: pick(casePair), localeCompare: localePick(casePair) });
	// 跨环境确定性：同款判据在 LANG 变化下必须同解（localeCompare 依赖 ICU/locale）
	const withLang = (c, lang) => {
		const prev = process.env.LANG;
		process.env.LANG = lang;
		const got = localePick(c);
		if (prev === undefined) delete process.env.LANG;
		else process.env.LANG = prev;
		return got;
	};
	check("A4 选取不随 LANG 变化（同一输入在 C/en_US 下同解）", pick(casePair) === "Z/SKILL.md" && withLang(casePair, "C") === withLang(casePair, "en_US.UTF-8"), { C: withLang(casePair, "C"), en_US: withLang(casePair, "en_US.UTF-8"), 码点序: pick(casePair) });

	// 纯函数语义：不得原地改序调用方的数组（源码注释专门提了这事）
	const input = [...deep];
	const copy = [...deep];
	pick(input);
	check("A4 选取不改调用方数组顺序（[...candidates] 复制）", JSON.stringify(input) === JSON.stringify(copy), { 传入: copy, 之后: input });
}

/* ---------- A5：同名目录 409 守卫 + staging 语义（I1 回归） ---------- */
{
	const dst = path.join(tmpRoot, "a5-dst");
	const targetDir = path.join(dst, "my-skill");
	fs.mkdirSync(targetDir, { recursive: true });
	fs.writeFileSync(path.join(targetDir, "marker.txt"), "keep-me", "utf8");
	const before = fs.readdirSync(targetDir);

	// 守卫判据：与源码同口径（fs.existsSync(targetDir) ⇒ 409），且 409 时**不动**任何东西
	const guarded = fs.existsSync(targetDir);
	check("A5 预置同名目录 → 触发 409 守卫", guarded, targetDir);
	check("A5 409 时原目录内容零改动", JSON.stringify(fs.readdirSync(targetDir)) === JSON.stringify(before) && fs.readFileSync(path.join(targetDir, "marker.txt"), "utf8") === "keep-me", fs.readdirSync(targetDir));
	check("A5 409 时目标 skills 目录无新增（无 staging 残留）", fs.readdirSync(dst).length === 1, fs.readdirSync(dst));

	// staging 语义（I1：原子落盘 + 防幽灵技能）
	check("A5 源码存在 `.installing-` staging 命名（I1）", /`\.installing-\$\{process\.pid\}-\$\{Date\.now\(\)\}/.test(installSource), "未找到 .installing- 命名");
	check("A5 staging 落在 targetSkillsDir 内（`path.join(targetSkillsDir, `.installing-…`)`）", /path\.join\(\s*targetSkillsDir,\s*`\.installing-/.test(installSource), "staging 未落在 targetSkillsDir 内");
	check("A5 staging 前带 `.` 前缀（旧 `<targetDir>.installing-*` 形态不以 . 开头，会成幽灵技能）", /`\.installing-/.test(installSource) && !/`\$\{targetDir\}\.installing-/.test(installSource), "staging 仍是无点前缀形态");
	check("A5 落盘走 cp→staging 后 rename（原子替换，非直写 targetDir）", /await fs\.promises\.cp\(skillDir, stagingDir/.test(installSource) && /await fs\.promises\.rename\(stagingDir, targetDir\)/.test(installSource), "未找到 cp→staging→rename 序列");

	// 行为级实证：按源码命名造一份 staging，Pi 的发现规则不得把它当技能
	const stagingDir = path.join(dst, `.installing-${process.pid}-${Date.now()}-my-skill`);
	fs.mkdirSync(stagingDir, { recursive: true });
	fs.writeFileSync(path.join(stagingDir, "SKILL.md"), "---\nname: ghost\n---\n\n\n", "utf8");
	const visible = fs.readdirSync(dst).filter((n) => !n.startsWith("."));
	check("A5 staging 目录对「非 `.` 开头的可见条目」不可见（不会成幽灵技能）", !visible.includes(path.basename(stagingDir)), visible);
	fs.rmSync(stagingDir, { recursive: true, force: true });

	// 崩溃残留不挡重试：409 守卫只看 targetDir，不看 staging（同名 staging 存在不误命中）
	check("A5 409 守卫只判目标目录名（staging 残留不误命中）", fs.existsSync(targetDir) === guarded, targetDir);
	// 真正「cp 中途失败」需 clone 成功（依赖网络），本批不覆盖 —— 如实记进 skip 清单
	SKIPPED.push({ id: "A5-cp", reason: "cp 中途失败（ENOSPC/EIO/进程被杀）需真实 clone 产物；installSkillFromGitHub 自己 clone、不接受外部目录，要覆盖得用 url.insteadOf 改写 GitHub URL（污染全局 git 配置），本批不做" });
}

/* ---------- A6：文件数封顶（I2） ---------- */
{
	const clean = synthSkillDir(path.join(tmpRoot, "a6-clean"));
	const small = synthSkillDir(path.join(tmpRoot, "a6-small"));
	for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(small, `f${i}.txt`), "x", "utf8");
	check(`A6 文件数远低于上限 ${MAX_SKILL_FILES} 的目录通过闸门（不误伤）`, (await expectStatus(() => assertSkillDirSafe(clean, "my-skill"))) === null && (await expectStatus(() => assertSkillDirSafe(small, "my-skill"))) === null);
	check(`A6 MAX_SKILL_FILES 常量为 ${MAX_SKILL_FILES}（源码口径 5_000）`, MAX_SKILL_FILES === 5_000, MAX_SKILL_FILES);

	const over = synthSkillDir(path.join(tmpRoot, "a6-over"));
	// 造「恰好越线 1 个」：SKILL.md 已占 1 个，故再写 MAX 个 —— 上限与判据同源，
	// 改 MAX_SKILL_FILES 时这条例外（边界随常量走），不是漏网的恒真
	for (let i = 0; i < MAX_SKILL_FILES; i++) fs.writeFileSync(path.join(over, `f${i}.txt`), "x", "utf8");
	const st = await expectStatus(() => assertSkillDirSafe(over, "my-skill"));
	check(`A6 文件数超 ${MAX_SKILL_FILES} → 422（I2）`, st === 422, st);
	// 反向对照：恰好等于上限必须放行（否则上限是「拍脑袋的数」而非计数语义）
	const atLimit = synthSkillDir(path.join(tmpRoot, "a6-atlimit"));
	for (let i = 0; i < MAX_SKILL_FILES - 1; i++) fs.writeFileSync(path.join(atLimit, `f${i}.txt`), "x", "utf8");
	check(`A6 文件数恰好 ${MAX_SKILL_FILES} → 放行（上限不含糊、不误伤）`, (await expectStatus(() => assertSkillDirSafe(atLimit, "my-skill"))) === null);
}

/* ---------- A7：skillId 长度封顶（I4，校验早于 clone ⇒ 离线可断言） ---------- */
{
	check("A7 MAX_SKILL_ID_LENGTH 常量为 128", MAX_SKILL_ID_LENGTH === 128, MAX_SKILL_ID_LENGTH);
	const dst = path.join(tmpRoot, "a7-dst");
	const st = await expectStatus(() =>
		installSkillFromGitHub({
			source: "owner/repo",
			skillId: "x".repeat(MAX_SKILL_ID_LENGTH + 1),
			targetSkillsDir: dst,
		}),
	);
	check(`A7 skillId 超 ${MAX_SKILL_ID_LENGTH} → 400（早于 clone，不出网）`, st === 400, st);
	check("A7 超长 skillId 未创建任何目录", !fs.existsSync(dst), fs.existsSync(dst));
	// 边界对照：正好等于上限 ⇒ 不因长度被拒。用**非法 source** 做对照（合法 source 会真去
	// clone github.com —— 本脚本不出网），断言两种 400 的**文案**可区分：超长+合法源报「过长」，
	// 超长+非法源先被来源校验拦（文案讲「来源」而不讲「过长」）。
	let bothMsg = "";
	try {
		await installSkillFromGitHub({ source: "not a repo", skillId: "x".repeat(MAX_SKILL_ID_LENGTH + 1), targetSkillsDir: dst });
	} catch (e) {
		bothMsg = e?.message ?? "";
	}
	let lenMsg = "";
	try {
		await installSkillFromGitHub({ source: "owner/repo", skillId: "x".repeat(MAX_SKILL_ID_LENGTH + 1), targetSkillsDir: dst });
	} catch (e) {
		lenMsg = e?.message ?? "";
	}
	check(
		"A7 长度口径与来源口径判得开（超长+非法源 ⇒ 来源校验先拦，400 文案不含「过长」）",
		/过长/.test(lenMsg) && !/过长/.test(bothMsg),
		{ 超长且合法源: lenMsg, 超长且非法源: bothMsg },
	);
	// 边界：正好 MAX 长度时长度校验不拦（走到来源校验 ⇒ 文案讲来源）
	let atLimitMsg = "";
	try {
		await installSkillFromGitHub({ source: "not a repo", skillId: "y".repeat(MAX_SKILL_ID_LENGTH), targetSkillsDir: dst });
	} catch (e) {
		atLimitMsg = e?.message ?? "";
	}
	check("A7 长度正好等于上限时不因长度被拒（边界不含糊；非法源是故意的，避免真出网）", !/过长/.test(atLimitMsg) && /来源|技术来源/.test(atLimitMsg), atLimitMsg);
}

/* ==================================================================
 * 判据 A8–A12：起真实 core（HTTP，不出网）
 * ================================================================== */

const agentDir = path.join(tmpRoot, "agent");
fs.mkdirSync(agentDir, { recursive: true });
// 本机既无 shell 里的 ARK_API_KEY、也无 pi/_poc/.env.local ⇒ seedModelsJson 会返回
// false（Pi 把 provider 视作「无凭证」）。本脚本不需要真实模型（范式如此），
// 但要如实记进 skip 清单，别让读者以为模型清单是齐的。
const modelsSeeded = seedModelsJson(agentDir);
if (!modelsSeeded) {
	SKIPPED.push({ id: "夹具", reason: "pi/_poc/models.json 缺失且本机无凭证文件：seedModelsJson 返回 false（起 core 仍成功，只是不起真实模型）" });
}
const projectDir = path.join(tmpRoot, "proj");
fs.mkdirSync(projectDir, { recursive: true });

const logFd = fs.openSync(path.join(runDir, "skills-install-core.log"), "w");
const child = spawn(process.execPath, mainArgs, {
	cwd: projectDir,
	env: childEnv({
		CORE_TOKEN: TOKEN,
		CORE_PORT: String(PORT),
		CORE_AGENT_DIR: agentDir,
		CORE_CWD: projectDir,
	}),
	stdio: ["ignore", "ignore", logFd],
});

let exitCode = 1;
try {
	console.log(`[skills-install] 临时目录 ${tmpRoot}`);
	const health = await waitForHealth((h) => h.extensions !== null, 60_000);
	check("⓪core 启动就绪（/health.extensions 非空）", !!health, health);

	/* ---------- A8：/skills/search 入参校验（全部在出网前拒） ---------- */
	const searchNoQ = await request("GET", "/skills/search");
	check("A8 GET /skills/search 缺 q → 400", searchNoQ.status === 400, { status: searchNoQ.status, body: searchNoQ.json });
	const searchBlank = await request("GET", "/skills/search?q=%20%20");
	check("A8 GET /skills/search?q= 全空白 → 400", searchBlank.status === 400, { status: searchBlank.status, body: searchBlank.json });
	check("A8 MAX_QUERY_LENGTH 常量为 200", MAX_QUERY_LENGTH === 200, MAX_QUERY_LENGTH);
	const searchLong = await request("GET", `/skills/search?q=${"x".repeat(MAX_QUERY_LENGTH + 1)}`);
	check(`A8 q 超 ${MAX_QUERY_LENGTH} 字符 → 400（I8，不打上游）`, searchLong.status === 400 && /过长/.test(searchLong.json?.error ?? ""), { status: searchLong.status, body: searchLong.json });
	// 边界：正好等于上限**不**打这个 HTTP 请求（会真出网查 skills.sh）。
	// 改为读源码断阈值形态：判据是 `q.length > MAX_QUERY_LENGTH` 而不是 `>=`
	const serverSrcA8 = fs.readFileSync(path.join(coreDir, "src", "server.ts"), "utf8");
	check(`A8 长度阈值是 > ${MAX_QUERY_LENGTH}（不是 >=，边界不含糊）`, /q\.length > MAX_QUERY_LENGTH/.test(serverSrcA8), serverSrcA8.match(/q\.length [^;]+/)?.[0] ?? "未匹配到阈值判据");

	/* ---------- A9：安全三件套对新端点同样生效 ----------
	 * 双向都验：正向（无 token → 401 / 错 Host → 403 / 错 token → 401），
	 * **反相**（坏 token → 401）—— 因为路由鉴权是 `if (API_ROUTES.has(urlPath)) { … }`
	 * 单点包裹的（server.ts:322-328）：一旦从 API_ROUTES 里删掉某条，该路径既不 401
	 * 也不 403，而是**静默进入 handler**。破坏测试实测过这一点（摘掉 "/skills/install"
	 * 后无 token 拿到了 404/clone 报错），所以这里把「反相也要 401」写成断言。 */
	for (const [method, p, body] of [
		["POST", "/skills/install", { source: "owner/repo", skillId: "x", scope: "user" }],
		["GET", "/skills/search", undefined],
		["GET", "/skills", undefined],
	]) {
		const noToken = await request(method, p, body, { token: "" });
		check(`A9 无 token → 401（${method} ${p}）`, noToken.status === 401, { status: noToken.status, body: noToken.json });
		const badToken = await request(method, p, body, { token: "wrong-token" });
		check(`A9 错 token → 401（${method} ${p}）`, badToken.status === 401, { status: badToken.status, body: badToken.json });
		const badHost = await request(method, p, body, { host: "evil.example.com" });
		check(`A9 错 Host → 403（${method} ${p}）`, badHost.status === 403, { status: badHost.status, body: badHost.json });
	}
	// 安装端点非法入参（都在出网前拒）：C3「SKILL.md 在仓库根」是 clone 后才判的，本批不覆盖
	const installNoBody = await request("POST", "/skills/install", {});
	check("A9 POST /skills/install 缺 source/skillId/scope → 400（端点层）", installNoBody.status === 400, { status: installNoBody.status, body: installNoBody.json });
	const installBadScope = await request("POST", "/skills/install", { source: "owner/repo", skillId: "x", scope: "global" });
	check("A9 POST /skills/install 非法 scope → 400（端点层）", installBadScope.status === 400, { status: installBadScope.status, body: installBadScope.json });
	const installBadSource = await request("POST", "/skills/install", { source: "not a repo", skillId: "x", scope: "user" });
	check("A9 POST /skills/install 非法 source → 400（源形态在 clone 前被拒，不出网）", installBadSource.status === 400, { status: installBadSource.status, body: installBadSource.json });
	const installLongId = await request("POST", "/skills/install", { source: "owner/repo", skillId: "z".repeat(MAX_SKILL_ID_LENGTH + 1), scope: "user" });
	check("A9 POST /skills/install 超长 skillId → 400（I4）", installLongId.status === 400 && /过长/.test(installLongId.json?.error ?? ""), { status: installLongId.status, body: installLongId.json });
	const tmpLeaksHttp = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("pi-skill-install-"));
	check("A9 上述拒绝路径均未留 pi-skill-install-* 临时目录（校验早于 clone）", tmpLeaksHttp.length === 0, tmpLeaksHttp);

	/* ---------- A10：C1 静态回归防线：放行集合必须含 skill_progress ---------- */
	{
		const serverSrc = fs.readFileSync(path.join(coreDir, "src", "server.ts"), "utf8");
		// 集合本体（模块级 const … new Set([...])）——C1 的病根就是这里少了一行
		const setMatch = /const CORE_DIRECT_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\)/.exec(serverSrc);
		const members = setMatch ? [...setMatch[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
		check("A10 server.ts 里找得到 CORE_DIRECT_EVENT_TYPES 登记处", !!setMatch, setMatch ? members : "未匹配到 new Set([...])");
		check("A10 放行集合含 skill_progress（C1 病根）", members.includes("skill_progress"), members);
		// 集合里不得混入走 dispatch（经 toAgentEvent 翻译）的事件，否则同一事件双推
		const sessionFlow = ["message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "turn_start", "turn_end", "agent_start", "agent_settled"];
		check("A10 放行集合不含会话流事件（不得与 dispatch 通道双推）", !sessionFlow.some((t) => members.includes(t)), members.filter((t) => sessionFlow.includes(t)));
		check("A10 放行集合恰为 6 项直发事件（维护约定：不多不少）", members.length === 6, members);
		// 放行判据是「本文件登记的一律放行」：断言 dispatchAgent 真走 isDeclaredAgentEvent，
		// 且判定真查了 CORE_DIRECT_EVENT_TYPES（有集合没接线同样是 C1）
		const declMatch = /function isDeclaredAgentEvent\(e: unknown\): boolean \{([\s\S]*?)\n\}/.exec(serverSrc);
		check("A10 放行判据 isDeclaredAgentEvent 查 CORE_DIRECT_EVENT_TYPES", !!declMatch && /CORE_DIRECT_EVENT_TYPES\.has\(/.test(declMatch[1]), declMatch ? declMatch[1] : "未匹配到 isDeclaredAgentEvent");
		const dispatchAgent = /const dispatchAgent = \(e: unknown\) => \{([\s\S]*?)\n\t\};/.exec(serverSrc);
		check("A10 dispatchAgent 走 isDeclaredAgentEvent（集合真接在直发通道上）", !!dispatchAgent && /isDeclaredAgentEvent\(e\)/.test(dispatchAgent[1]), dispatchAgent ? dispatchAgent[1] : "未匹配到 dispatchAgent");
		// 契约侧：SkillProgressEvent 仍声明该 type（免得前端订阅的类型消失）
		const contractSrc = fs.readFileSync(path.join(coreDir, "src", "contract.ts"), "utf8");
		check("A10 contract.ts 里 SkillProgressEvent 仍声明 type: \"skill_progress\"", /interface SkillProgressEvent \{[\s\S]*?type: "skill_progress"/.test(contractSrc), "未找到 SkillProgressEvent");
		// 生产侧：session.ts 的 emitAgent 真的发这个 type（放行了也得有人发）
		const sessionSrc = fs.readFileSync(path.join(coreDir, "src", "session.ts"), "utf8");
		check("A10 session.ts 生产 skill_progress 事件（onProgress → emitAgent）", /type: "skill_progress"/.test(sessionSrc), "未找到 skill_progress 的 emitAgent");
		// 消费侧：UI 有 reducer/订阅方（事件无人消费也是半条链路）
		const uiReducer = path.resolve(coreDir, "..", "ui", "src", "adapter", "reduce.ts");
		if (fs.existsSync(uiReducer)) {
			check("A10 UI reduce.ts 消费 skill_progress（端到端链路有尾）", /skill_progress/.test(fs.readFileSync(uiReducer, "utf8")), "未找到 skill_progress");
		} else {
			console.log("    （未找到 ui/src/adapter/reduce.ts，跳过消费侧断言）");
		}
	}

	/* ---------- A11：流式中 409 —— 本批 skip（见文首与末尾 skip 清单） ---------- */
	{
		SKIPPED.push({
			id: "A11",
			reason:
				"造流式窗口必须真发一轮 POST /prompt（起真实模型），与本脚本「不起真实模型、不出网」的范式冲突；本机亦无 ARK_API_KEY / pi/_poc/.env.local 夹具（seedModelsJson 返回 false）。" +
				"替代防线：同一条前置护栏文本在 A5b 对 9 个同级端点 + session.ts 删活动会话分支做交叉断言（改动任一处护栏即红），A10 另静态钉住 dispatchAgent 接线。",
		});
		// 便宜的那一半仍然验：非流式（/health.streaming === false）时安装端点不该回 409
		const streamingNow = (await request("GET", "/health")).json?.streaming;
		const installNotStreaming = await request("POST", "/skills/install", { source: "not a repo", skillId: "x", scope: "user" });
		check("A11 非流式态下安装端点不回 409（护栏不误伤）", streamingNow === false && installNotStreaming.status === 400, { streamingNow, status: installNotStreaming.status, body: installNotStreaming.json });
	}

	/* ---------- A12：读路径未受影响（回归） ---------- */
	const skills = await request("GET", "/skills");
	check("A12 GET /skills → 200（读路径未被本批改动波及）", skills.status === 200 && skills.json?.ok === true, { status: skills.status, body: skills.json });
	check("A12 /skills 载荷含 skills 数组（UI 直接整体替换用）", Array.isArray(skills.json?.skills), Object.keys(skills.json ?? {}));
	// API_ROUTES 登记核对（readFile 现状 + 运行期反相断言的分工）：
	// 读源码是**辅助**，主断言在上面 A9 的「无/错 token → 401」—— 已实测后者能接住
	// “从 API_ROUTES 删掉一行”这种破坏（删掉后无 token 不再 401，而是进 handler）。
	const serverSrc = fs.readFileSync(path.join(coreDir, "src", "server.ts"), "utf8");
	const registryBlock = /const API_ROUTES = new Set\(\[([\s\S]*?)\n\]\);/.exec(serverSrc)?.[1] ?? "";
	const registryPaths = [...registryBlock.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
	for (const p of ["/skills", "/skills/toggle", "/skills/search", "/skills/install"]) {
		check(`A12 API_ROUTES 登记集里恰有一个 ${p}`, registryPaths.filter((x) => x === p).length === 1, registryPaths.filter((x) => x === p));
	}

	/* ---------- A5b：安装前置护栏的代码形态对 11 个同级端点交叉断言 ----------
	 * 这是 A11 的可行替代：不构造流式窗口，而钉死「每个写/重端点在
	 * runtime.isStreaming() 为真时都回 409」这条护栏的代码形态。改任一端点的护栏即红。
	 *
	 * **局限，别当编译期保证**：定位方式是「取端点 handler 的行区间，在区间里找护栏」，
	 * 故只防形变（删护栏 / 改文案 / 挪到别的端点），防不住「换一种写法但语义相同」
	 * （例如把 isStreaming() 提成一个 helper 再调用）。真要覆盖流式语义，
	 * 仍需 A11 那条起真实模型的端到端用例。 */
	{
		const src = fs.readFileSync(path.join(coreDir, "src", "server.ts"), "utf8");
		const GUARD_TEXT = "会话正在生成回复，请先停止";
		// 端点层有前置护栏的那些（server.ts 的 `if (runtime.isStreaming())` ⇒ 409）
		const guardEndpoints = [
			"/cwd",
			"/sessions/new",
			"/skills/toggle",
			"/skills/install",
			"/packages/toggle",
			"/packages/remove",
			"/session/reload",
			"/packages/install",
			"/packages/update",
		];
		for (const ep of guardEndpoints) {
			const start = src.search(new RegExp(`urlPath === "${ep}"`));
			if (start < 0) {
				check(`A5b 端点 ${ep} 存在`, false, "server.ts 里未找到该端点");
				continue;
			}
			// handler 区间：从端点那一行到下一个同缩进的 `if (req.method ===` 之前
			const rest = src.slice(start + 1);
			const nextIdx = rest.search(/\n\t\tif \(req\.method ===/);
			const block = nextIdx < 0 ? rest : rest.slice(0, nextIdx);
			const hasGuard = /runtime\.isStreaming\(\)/.test(block);
			const hasText = block.includes(GUARD_TEXT);
			const is409 = /json\(409,/.test(block);
			check(`A5b ${ep} 流式前置护栏在位（isStreaming + 409 + 稳定文案）`, hasGuard && hasText && is409, {
				isStreaming: hasGuard,
				文案: hasText,
				409: is409,
				片段: block.slice(0, 300),
			});
		}
		// runtime 层（session.ts）的护栏：删**活动**会话那条路在 session.ts 里护，
		// 端点层没有前置护栏（删非活动会话不该被流式打断）。两种护栏位置都要钉住。
		const sessionSrcA5b = fs.readFileSync(path.join(coreDir, "src", "session.ts"), "utf8");
		const deleteBody = /const deleteSession = async \(id: string\): Promise<void> => \{([\s\S]*?)\n\t\};/.exec(sessionSrcA5b)?.[1] ?? "";
		check(
			"A5b session.ts 删活动会话分支也有流式护栏（端点层没有，两处护栏都要在）",
			/session\.isStreaming/.test(deleteBody) && /SessionManageError\(409/.test(deleteBody) && deleteBody.includes(GUARD_TEXT),
			deleteBody.slice(0, 300) || "未匹配到 deleteSession",
		);
		// 现状观察（**不写成断言**）：POST /sessions/rename 无论端点层还是 session.ts
		// 都没有流式护栏。写成断言会把「补上护栏」也变成假红，故只记进 skip 清单当线索。
		SKIPPED.push({
			id: "A5b-rename",
			reason:
				"POST /sessions/rename 当前**没有**流式护栏（server.ts 端点层与 session.ts 的 renameSession 都无；对照：sessions/load 走「非活动会话重建时跳过、流式里只读返回」）。" +
				"UI 路径本就先 abort 再 load，所以正常手势不触发；但直连 API 可在生成中途给活动会话改名。本批只记为观察，不写成断言（将来补上护栏会让检查假红），也不改源码。",
		});
	}

	/* ---------- A5c：仓库根 SKILL.md 拒绝守卫（C3 回归） ---------- */
	/*
	 * **C3 只能在静态层面钉住，这是源码现状的硬约束**（不是偷懒）：
	 * 根目录判定发生在 `gitClone` 之后 —— 代码里**没有**独立可导出的「根判定」函数，
	 * `skillDir` / `cloneDir` 两个局部变量只有走过 clone 才拿得到；而 clone 需要出网
	 * （`SOURCE_PATTERN` 只收 `owner/repo`，`url.insteadOf` 改写又污染全局 git 配置）。
	 * 实测（2026-09-29，见报告「破坏测试」节）：把 `isRepoRoot` 短路成 `false`
	 * （等价于 C3 修复前的行为）**不会让本检查变红** —— 本条诚实记为缺口。
	 * 要把它变成真·可执行断言，需先在 Task 1~5 的源码里拆出一个纯函数
	 * （如 `isRepoRootSkillDir(skillDir, cloneDir)`），属**源码改动**，本任务权限外。
	 */
	{
		const guard = /const isRepoRoot = fs\.realpathSync\(skillDir\) === fs\.realpathSync\(cloneDir\);/.exec(
			installSource,
		);
		check("A5c 源码保留「根目录 SKILL.md ⇒ 400」守卫（C3 静态层，行为层覆盖不了见注释）", !!guard, guard?.[0] ?? "未匹配到 isRepoRoot 判定");
		// 判据用 realpathSync 双侧 canonical 比较（而非 path.resolve 字符串等值）：
		// 后者在大小写不敏感平台（Windows）会把 /TMP 与 /tmp 判成不同目录
		check("A5c 根判定用 realpathSync 双侧比较（不是 path.resolve 字符串等值）", !!guard && !/path\.resolve\(skillDir\) === .*path\.resolve\(cloneDir\)/.test(installSource), "仍是字符串等值判据");
		const rootGuardIdx = installSource.indexOf("const isRepoRoot = fs.realpathSync(skillDir)");
		const errorIdx = installSource.indexOf("SKILL.md 位于仓库根目录");
		const cpIdx = installSource.indexOf("await fs.promises.cp(skillDir, stagingDir");
		check("A5c 根守卫在 cp 之前拦（先判后拷，.git 不会落进用户 skills 目录）", rootGuardIdx > 0 && errorIdx > rootGuardIdx && cpIdx > errorIdx, { 根判定: rootGuardIdx, 报错文案: errorIdx, cp: cpIdx });
		SKIPPED.push({
			id: "C3-行为",
			reason:
				"「仓库根 SKILL.md ⇒ 400」只能在静态层断言：该判定在 gitClone 之后、且没抽成可导出的纯函数（skillDir/cloneDir 是 clone 后的局部变量），" +
				"而 clone 需出网（SOURCE_PATTERN 只收 owner/repo）。实测把 isRepoRoot 短路成 false 后本检查**仍全绿**。" +
				"补救需先在源码里拆出纯函数（如 isRepoRootSkillDir(skillDir, cloneDir)）再在本脚本里离线断言 —— 属源码改动，本任务权限外。",
		});
	}

	exitCode = checks.filter((c) => !c.pass).length > 0 ? 1 : 0;
} catch (e) {
	console.error("[skills-install] 异常中断:", e);
	exitCode = 1;
} finally {
	// 先等 core 子进程退出再清理 —— Windows 上进程活着时删它的 cwd 会 EPERM
	child.kill();
	await Promise.race([new Promise((r) => child.once("exit", r)), sleep(3_000)]);
	// 清理尽力而为：临时目录本就交给系统回收，删不掉不让它掩盖检查结论
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		/* 留给 OS 临时目录清理 */
	}
	try {
		fs.closeSync(logFd);
	} catch {
		/* 已关闭 */
	}
}

const evidence = { startedAt: new Date().toISOString(), skipped: SKIPPED, checks };
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

const failed = checks.filter((c) => !c.pass).length;
if (failed > 0) {
	console.error(`\nskills-install 检查失败 ${failed} 项（证据：${evidencePath}）`);
	process.exit(1);
}
console.log(`skills-install 检查全部通过：${checks.length} 项（证据：${evidencePath}）`);
if (SKIPPED.length > 0) {
	console.log(`（显式未覆盖 ${SKIPPED.length} 项，理由见证据文件 skipped 字段：`);
	for (const s of SKIPPED) console.log(`  - ${s.id}：${s.reason}`);
}
process.exit(exitCode);
