/**
 * 「添加技能」安装写路径检查 —— `check:skills-install`（2026-09-29 合并前加固批次）。
 *
 * **为什么需要它**：dev 分支新增的 `skills-install.ts` / `skills-search.ts` 此前
 * **零自动化覆盖**（`packages/core/package.json` 无对应脚本），三条阻塞级缺陷
 * （C1 进度事件被白名单静默丢弃 / C2 技能目录里的符号链接被原样搬进用户 skills 目录 /
 * C3 仓库根 SKILL.md 会连 .git 一起搬）全部躲过了浏览器探针 —— 探针只覆盖错误码，
 * 不覆盖文件系统后果与事件投递。本脚本把评审结论固化成可执行断言。
 * （历史注：C3 的「报错拒绝」口径 2026-09-29 已改为「排除 .git 照装」，由 A5d 行为断言钉住。）
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
import { fileURLToPath, pathToFileURL } from "node:url";
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

// Windows：ESM 动态 import 不收盘符绝对路径（`F:\…` 抛 ERR_UNSUPPORTED_ESM_URL_SCHEME），必须转 file:// URL
const mod = await import(pathToFileURL(path.join(coreDir, "src", "skills-install.ts")).href);
const {
	installSkillFromGitHub,
	assertSkillDirSafe,
	SkillInstallError,
	MAX_SKILL_FILES,
	MAX_SKILL_ID_LENGTH,
	MAX_QUERY_LENGTH,
	readFrontmatterName,
	readSkillSourceRecord,
	writeSkillSourceRecord,
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
 * 两遍的复刻口径（skills-install.ts 的 sanitizeDirName）：
 *   - 第 1 遍把非白名单的字符逐个换成 "-"
 *   - 第 2 遍剥掉首尾的 [-.] （run 起来）
 *   - 剥完为空 ⇒ 回落 "skill"
 * 断言两件真正要紧的事：① 拼出的落盘路径**不越出** targetSkillsDir；② 是**单段**名。
 * 配套反事实对拍：把「剥首尾 [-.]」去掉（连剥两次 `^[-.]+`）的反事实实现，
 * 对 ".." 只能剥成空 ⇒ 回落 "skill"。断言源码**剥得出 "."** 而反事实剥不出 ——
 * 这样「源码正则被改掉」与「复刻被改掉」都会红，不存在两者同进同退的恒真。
 *
 * **fix round 1/5（评审 Important）：第 1 遍的字符白名单必须由源码驱动。**
 * 上一版把 `/[^\w.-]/g` 这个白名单**写死**在脚本里，它不是源码的「复刻」而是
 * 脚本自带的常量 —— 源码第 1 遍真正防目录穿越（放过 `/` 就是 `a/../../b` 多层穿越），
 * 而 13 条越界/单段断言却对它完全无感：把源码第 1 遍改成 `[^\w.\-/]` 照样全绿。
 * 现在两遍都**从源码函数体里按序抠出 replace 的正则字面量**（`replaces[0]`/`replaces[1]`）
 * 现场构造，替换目标按源码/复刻字面量（缺省 "-"）取。源码白名单一放宽，
 * 落盘名就跟着越界 ⇒ 断言变红。抠不到（形态大改）时**显式标红并跳过语义判据**，
 * 绝不静默改用硬编码兜底（那正是本轮堵掉的那个假绿口子）。
 *
 * **fix round 2/5（评审 Important ×2）：消掉抠取器的两处假红 + 一处新假绿。**
 *   - 假红 A：`readStringLiteral` 只认双引号 ⇒ 把源码等价改成**单引号**（`'a\'b'` 这类
 *     带转义的字面量也算）就抠不到，`replaceCalls` 变空 ⇒ 23 条 A2 全红，且
 *     **同时废掉「剥首尾」那道真正的防线**（`".."` 剥不出来），红得没有指向性。
 *     现在引号风格单双皆收，且要求前后**配对**。
 *   - 假红 B + 新假绿：原先按出现顺序取前两个 `replace(`，既没剥注释、也没收紧定位。
 *     注释里出现 `replace(...)` ⇒ 抠到注释里的正则（红 10 条，且 detail 把「第 1 遍换成 `..`」
 *     这种结论指错了方向）；**追加第 3 遍 replace** ⇒ 前两遍照抠不误、判据沉默全绿，
 *     连 `replace(/-/g, "/")` 这种真破坏都接不住。现在先抹白注释/字符串内容，
 *     再要求 `replace` 是**独立的成员调用 token**（见下方 isReplaceCall 的注释：为什么
 *     不能用「语句起点」的字面定义），并显式断言「恰好两遍」，多一遍/少一遍都红。
 */
{
	const m = /function sanitizeDirName\(skillId: string\): string \{([\s\S]*?)\n\}/.exec(installSource);
	const fnBody = m ? m[1] : "";
	// 按源码出现顺序抠出每一遍 replace 的（正则字面量, 替换目标字面量）。
	// 抠取器自己是个**扫描器**（逐字符走，跟 JS 的词法一致）：
	//   - 正则字面量：`/.../` 内部允许出现转义斜杠 `\/`，字面量以「未被转义的 `/`」收尾，
	//     标志位只收 g / i / m / s / u / y（拿不到 g 就当场标红并短路，绝不静默改用非全局版 ——
	//     非全局的 replace 只换首个匹配，会让「白名单敏感」这件事测不出来）；
	//   - 替换目标：字符串字面量（单引号 / 双引号皆可，要求前后配对；取字面量原文，
	//     常见转义（\\ \' \" \n …）由下面那段还原成真值）。
	// 源码若改用非字面量（变量 / 函数 / 模板串），抠取失败即如实标红并短路语义判据。
	const readRegexLiteral = (text, from) => {
		let i = text.indexOf("/", from);
		while (i >= 0) {
			let j = i + 1;
			let inClass = false;
			let closed = false;
			while (j < text.length) {
				const ch = text[j];
				if (ch === "\\") {
					j += 2;
					continue;
				}
				if (ch === "[") inClass = true;
				else if (ch === "]") inClass = false;
				else if (ch === "/" && !inClass) {
					closed = true;
					break;
				} else if (ch === "\n") break; // 未闭合（不是正则字面量）
				j++;
			}
			if (!closed) return null;
			const kEnd = j + 1;
			let k = kEnd;
			while (k < text.length && /[gimsuy]/.test(text[k])) k++;
			if (text[k] === ",") {
				return { end: k + 1, pattern: text.slice(i + 1, j), flags: text.slice(j + 1, k) };
			}
			i = text.indexOf("/", j + 1);
		}
		return null;
	};
	// **fix round 2/5（假红 A）**：单/双引号都收，且要求前后**配对**。
	// 正则用 `/^(['"])((?:[^\\]|\\.)*?)\1/`：`(?:[^\\]|\\.)` 保证不会在
	// 转义序列中间收尾（例如 `'a\'b'` 里 `\'` 被整体吃掉，配对引号仍是外层那两个），
	// 惰性 `*?` + 反向引用 `\1` 保证「后引号与前引号同种」，不会把 `'a"b'` 读成两个字面量。
	const readStringLiteral = (text, from) => {
		const m = /^(['"])((?:[^\\]|\\.)*?)\1/.exec(text.slice(from));
		if (!m) return null;
		return { end: from + m[0].length, raw: m[2] };
	};
	// **fix round 2/5（假红 B / 新假绿）**：抹白注释与字符串**内容**（保留换行以维持行号），
	// 否则函数体开头一句 `// 见下方 replace(...) 调用` 就会把注释里的正则抠成「第 1 遍」。
	// 抹白是**字符等长**的：只把内容换成空格、不动任何位置 ⇒ 抠出来的 pattern/flags 与
	// 抹白前逐字一致，行号也仍然对得上。模板串整体抹白（反引号当作引号处理）。
	const codeOnly = (text) => {
		let out = "";
		let i = 0;
		const blank = (from, to) => text.slice(from, to).replace(/[^\n]/g, " ");
		while (i < text.length) {
			const c = text[i];
			const d = text[i + 1];
			if (c === "/" && d === "/") {
				let j = i;
				while (j < text.length && text[j] !== "\n") j++;
				out += blank(i, j);
				i = j;
			} else if (c === "/" && d === "*") {
				let j = i + 2;
				while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
				j = Math.min(j + 2, text.length);
				out += blank(i, j);
				i = j;
			} else if (c === '"' || c === "'" || c === "`") {
				const lit = readStringLiteral(text, i); // 配对引号 + 转义序列一起吃掉
				const j = lit ? lit.end : i + 1;
				out += blank(i, j);
				i = j;
			} else {
				out += c;
				i++;
			}
		}
		return out;
	};
	// **fix round 2/5**：收紧 `replace(` 的定位，不把「任意位置出现的 replace」当一遍调用：
	//   - 先由 codeOnly 抹掉注释/字符串内容（这是「函数体前面一句 `// 见下方 replace(…)` 就把
	//     注释里的正则抠成第 1 遍」的病根，见上）；
	//   - `replace` 必须是**独立的成员调用 token**：前面不是标识符字符（否则 `replaceAll` /
	//     `xreplace` 不算），且要么紧跟在 `.` 之后（`receiver.replace(`），要么自身在行首
	//     （裸 `replace(` 调用）。
	// 注意这里**没有**用「语句起点」的字面定义（行首 / 分号后）：源码的合法形态就是
	// `const cleaned = skillId.replace(A).replace(B)` —— 一条语句里链式两遍，两个 `replace`
	// 都不在行首、第一个前面还是接收者 `skillId`。按字面定义会把**源码本身**判成抠不到
	// （假红）。真正能区分「源码本来两遍」与「有人**追加**了第三遍」的是下面那条
	// `length === 2` 断言：链式几遍都放过，多出第三遍就红。
	const isReplaceCall = (text, idx) => {
		if (idx > 0 && /[A-Za-z0-9_$]/.test(text[idx - 1])) return false; // 更长标识符的一部分
		if (idx > 0 && text[idx - 1] === ".") return true; // receiver.replace(
		const lineStart = text.lastIndexOf("\n", idx - 1) + 1;
		return text.slice(lineStart, idx).trim() === ""; // 行首的裸 replace(
	};
	const codeBody = codeOnly(fnBody);
	const replaceCalls = [];
	for (let idx = codeBody.indexOf("replace("); idx >= 0; idx = codeBody.indexOf("replace(", idx + 1)) {
		// indexOf 命中的是 `replace(` 的开头，回退校验 `replace` 是独立 token（排除 replaceAll）
		if (!isReplaceCall(codeBody, idx)) continue;
		// `replace(` 与第一个参数之间可能已有空格
		const afterCall = idx + "replace(".length + (fnBody.slice(idx + "replace(".length).match(/^\s*/) ?? [""])[0].length;
		const re0 = readRegexLiteral(fnBody, afterCall);
		if (!re0) continue;
		// 正则与替换目标之间（源码写的是 `, `）的空白
		const argStart = re0.end + (fnBody.slice(re0.end).match(/^\s*/) ?? [""])[0].length;
		const str0 = readStringLiteral(fnBody, argStart);
		if (!str0) continue;
		let replacement = str0.raw;
		// 把字面量里的常见转义还原成真值（= 源码里那个字面量的实际内容）：
		// `\\ \' \"` 取字面量本身，`\n \r \t \b \f \v \0` 取对应控制字符；
		// 其余（`\xNN` / `\uNNNN` 等）源码里不出现，保持原样（等价即可，不影响“抠到哪两遍”）。
		replacement = str0.raw.replace(/\\([\s\S])/g, (_m, e) => {
			const simple = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };
			return Object.prototype.hasOwnProperty.call(simple, e) ? simple[e] : e;
		});
		replaceCalls.push({ pattern: re0.pattern, flags: re0.flags, replacement });
	}
	const firstCall = replaceCalls[0] ?? null; // 第 1 遍：字符白名单
	const secondCall = replaceCalls[1] ?? null; // 第 2 遍：剥首尾
	// 两遍都必须是 g（全局）—— 非全局只换首个匹配，白名单/剥首尾语义完全不同，不能当等价
	const compiled = !!(firstCall && secondCall && firstCall.flags.includes("g") && secondCall.flags.includes("g"));
	const firstRe = compiled ? new RegExp(firstCall.pattern, "g") : null;
	const secondRe = compiled ? new RegExp(secondCall.pattern, "g") : null;
	// 复刻：第 1 遍的字符白名单 / 替换目标、第 2 遍的剥离正则 / 替换目标，全部来自源码
	const sanitize = (s) => {
		if (!compiled) return null;
		const cleaned = s.replace(firstRe, firstCall.replacement).replace(secondRe, secondCall.replacement);
		return cleaned.length > 0 ? cleaned : "skill";
	};
	// 反事实对拍：只做**源码第 1 遍**的字符替换、**不剥首尾**的「天真实现」。
	// 它的后果正是目录穿越：skillId ".." 会拼出 targetSkillsDir 的父目录，
	// "." 会拼出 targetSkillsDir 本身。源码的剥首尾正则就是堵这个的唯一一道。
	check("A2 两遍 replace 都能从源码抠出（正则字面量+全局标志+替换目标，同源不硬编码）", compiled, { 抠出: replaceCalls, 原因: compiled ? "两遍均为 g" : "未抠到两遍 / 缺 g / 替换目标非字面量" });
	// **fix round 2/5**：遍数必须**恰为两**。取前两个的抠取器会在这里沉默全绿 ——
	// 追加第 3 遍时前两遍照抠不误，连 `replace(/-/g, "/")` 这种真破坏都接不住。
	// 「遍数被改动」不在下面那 20+ 条语义判据的覆盖里，所以必须在这里显式钉住。
	check("A2 抠到的 replace 恰为两遍（追加第 3 遍 ⇒ 这里红；否则新增的遍会被静默忽略）", replaceCalls.length === 2, { 遍数: replaceCalls.length, 抠出: replaceCalls });
	// 判据要求：第 1 遍是一个**逐字符**的否定类（`[^…]`）且替换目标就是 "-"；
	// 量词/锚点/回溯一旦出现（即不再逐字符）即红。`[^…]` 里的 `^` 属于类语法，不算锚点。
	const firstIsPerCharClass = (p) => {
		const mm = /^\[\^([^\]]*)\]/.exec(p ?? "");
		if (!mm) return false;
		// 类体内允许的只有：转义序列（\w、\-、\/…）与字面字符。出现量词/括号/竖线
		// （忽略紧跟 \ 的转义反斜杠）即不再是「逐字符」白名单。
		return !/(^|[^\\])[?*+{}()|]/.test(mm[1]);
	};
	check(
		"A2 源码里 sanitizeDirName 的第 1 遍是「逐字符换 '-' 的字符白名单」（目录穿越的真正防线，不在判据里就不算数）",
		!!firstCall &&
			firstIsPerCharClass(firstCall.pattern) &&
			firstCall.pattern.includes("\\w") &&
			firstCall.replacement === "-" &&
			!/\\w/.test(secondCall?.pattern ?? ""),
		{ 第1遍: firstCall ? `/${firstCall.pattern}/${firstCall.flags} → "${firstCall.replacement}"` : "未找到", 第2遍: secondCall ? `/${secondCall.pattern}/${secondCall.flags} → "${secondCall.replacement}"` : "未找到" },
	);
	// 口径只认「第二遍的**正则字面量**就是首尾交替 run + 空替换目标」；引号风格（"" / ''）不参与判定，
	// 否则源码等价改用单引号就会被这条文本断言假红（fix round 2/5 必修 1 的直接后果）。
	check("A2 源码里 sanitizeDirName 的第 2 遍是「首尾交替 run」口径", /replace\(\/\^\[-\.\]\+\|\[-\.\]\+\$\/g, (""|'')\)/.test(fnBody), fnBody || "未匹配到函数体");
	const noStrip = (s) => {
		if (!compiled) return null;
		const cleaned = s.replace(firstRe, firstCall.replacement);
		return cleaned.length > 0 ? cleaned : "skill";
	};
	// **fix round 2/5（顺带 1）**：抠取失败时既标红、也把「压根没跑语义判据」写进 SKIPPED ——
	// 只看证据 JSON 的人得能区分「判据在看着白名单红」与「抠取器失灵，语义判据一条都没跑」。
	if (!compiled) {
		SKIPPED.push({
			id: "A2-抠取",
			reason: `未能从 sanitizeDirName 抠出两遍「replace(/正则/标志位, 字符串字面量)」：实际抠到 ${replaceCalls.length} 遍 —— 下方全部 A2 语义判据（越界/单段/剥空回落/白名单敏感度）**按失败计入**，不是通过；detail 字段描述的是「抠取失败」而非「源码语义不符」。形态大改（参数改成非字面量、helper 化、换成 replaceAll、拆成多次 replace）即触发，属有意接受的假红：静默改用硬编码兜底才是上上轮堵掉的假绿。`,
		});
	}
	const dstEscape = path.join(tmpRoot, "a2-dst");
	fs.mkdirSync(dstEscape, { recursive: true });
	// 以下 13 条语义判据全部跑在「由源码驱动的复刻」上：源码第 1 遍白名单一旦放宽
	// （放过 / 或丢掉 .），sanitize 的产出就会越界/多段 ⇒ 这里当场变红。
	check("A2 剥首尾是唯一拦住「..」穿越的一道（不剥 ⇒ 落盘名指回 targetSkillsDir 的父目录）", compiled && sanitize("..") === "skill" && path.resolve(dstEscape, noStrip("..")) === path.resolve(tmpRoot), { 源码口径: compiled ? sanitize("..") : "未抠到正则", 天真口径: compiled ? noStrip("..") : "未抠到正则", 天真口径拼出的路径: path.resolve(dstEscape, compiled ? noStrip("..") : "?") });
	check("A2 剥首尾也拦住「.」（不剥 ⇒ 落盘名指回 targetSkillsDir 本身）", compiled && sanitize(".") === "skill" && path.resolve(dstEscape, noStrip(".")) === path.resolve(dstEscape), { 源码口径: compiled ? sanitize(".") : "未抠到正则", 天真口径: compiled ? noStrip(".") : "未抠到正则" });

	const dst = path.join(tmpRoot, "a2-dst");
	fs.mkdirSync(dst, { recursive: true });
	const resolvedDst = path.resolve(dst);
	const label = (s) => (s.length > 24 ? `${JSON.stringify(s.slice(0, 10))}…(${s.length} 字符)` : JSON.stringify(s));
	for (const bad of [".", "..", "...", "a/../../b", "   ", "x".repeat(400), "a\\..\\..\\b", "／／"]) {
		if (!compiled) {
			check(`A2 skillId=${label(bad)} 落盘名不越出目标目录`, false, "未能从源码抠出 sanitizeDirName 的 replace 正则，语义判据无法成立（如实标红，不硬编码兜底）");
			continue;
		}
		const dirName = sanitize(bad);
		const full = path.resolve(dst, dirName);
		const inside = full.startsWith(resolvedDst + path.sep);
		check(`A2 skillId=${label(bad)} 落盘名不越出目标目录`, inside && dirName.length > 0, { dirName, full });
	}
	for (const bad of ["a/b", "a\\b", "C:evil", "..", "."]) {
		if (!compiled) {
			check(`A2 skillId=${JSON.stringify(bad)} 落盘名是单段名（无分隔符/盘符）`, false, "未能从源码抠出 sanitizeDirName 的 replace 正则，语义判据无法成立（如实标红，不硬编码兜底）");
			continue;
		}
		const dirName = sanitize(bad);
		check(`A2 skillId=${JSON.stringify(bad)} 落盘名是单段名（无分隔符/盘符）`, dirName === path.basename(dirName) && !/[\\/]/.test(dirName) && !dirName.includes(":"), dirName);
	}
	// 剥空回落：全是非法字符 / 全是首尾标点 ⇒ 必须回落到固定名，而不是空串
	check("A2 全非法字符 ⇒ 回落固定名 skill", compiled && sanitize("///") === "skill", compiled ? sanitize("///") : "未抠到正则");
	check("A2 全标点 ⇒ 回落固定名 skill", compiled && sanitize("-.-") === "skill", compiled ? sanitize("-.-") : "未抠到正则");
	// **反向对照（白名单敏感度）**：源码当前把 `/` 换成 `-`。若这一点失守（白名单放过
	// 分隔符），下面 13 条越界/单段判据会同时变红 —— 用一条显式对照把「它们会红」写成
	// 断言里的**前提**，避免整套语义判据退化成「不成立的恒真」。
	// 这里的 `[^\w.-]` 是**假设值、不是判据**：`assumedWhitelist("a/b") === "a-b"` 与源码无关
	// （恒真的自检项），它唯一的作用是让断言里的人一眼看出「白名单放过 `/` 时 sanitize 会产出什么」，
	// 进而确认后面那些判据**确实**依赖这一点。
	const assumedWhitelist = (s) => s.replace(/[^\w.-]/g, "-");
	check(
		"A2 源码第 1 遍白名单确实把 `/` 换成 `-`（13 条越界/单段判据的敏感度前提）",
		compiled && assumedWhitelist("a/b") === "a-b" && sanitize("a/b") === "a-b" && path.resolve(dst, sanitize("a/b")) === path.join(resolvedDst, "a-b"),
		{ 源码第1遍换成: sanitize("a/b"), 白名单若放过斜杠则: path.resolve(dst, "a/b") },
	);
	// 复刻保真（两遍都在同一函数上）：把两遍的顺序调换、只留其中一遍、替换目标写错，
	// 都会让对拍变红 —— 而**判据结果本身**取决于首遍白名单（上一版的盲区）。
	const viaSwapped = compiled
		? (s) => {
				const c = s.replace(secondRe, secondCall.replacement).replace(firstRe, firstCall.replacement);
				return c.length > 0 ? c : "skill";
			}
		: () => null;
	const viaStripOnly = compiled
		? (s) => {
				const c = s.replace(secondRe, secondCall.replacement);
				return c.length > 0 ? c : "skill";
			}
		: () => null;
	// 第三个反事实：首遍改成**非全局**（只换首个非法字符）。「两遍同源」不能退化成
	// 「两遍等价」—— 如果一个不区分 g/非 g 的抠取器能把任意写法抠成同一个复刻，
	// 那这套判据就测不出「全局性被改掉」这种破坏。
	const viaNonGlobal = compiled
		? (s) => {
				const c = s.replace(new RegExp(firstCall.pattern), firstCall.replacement).replace(secondRe, secondCall.replacement);
				return c.length > 0 ? c : "skill";
			}
		: () => null;
	const probe = [".", "..", "...", "a/../../b", "   ", "-.-", "a-b", "C:evil", "／／", "x".repeat(400)];
	const swappable = probe.filter((s) => viaSwapped(s) !== sanitize(s));
	const stripOnlyDiffers = probe.filter((s) => viaStripOnly(s) !== sanitize(s));
	const nonGlobalDiffers = probe.filter((s) => viaNonGlobal(s) !== sanitize(s));
	check(
		"A2 复刻与源码两遍同源：顺序不可换、遍数不可减、首遍必须全局（任一改法 ⇒ 与复刻结果不同）",
		!!viaSwapped && swappable.length > 0 && stripOnlyDiffers.length > 0 && nonGlobalDiffers.length > 0,
		{ 抠出的两遍: replaceCalls, 两遍互换后不一致的输入: swappable.length, 去掉首遍后不一致的输入: stripOnlyDiffers.length, 首遍非全局后不一致的输入: nonGlobalDiffers.length },
	);
	check(
		"A2 复刻与源码两遍同源（剥空回落靠两遍串联得出，任一遍单独都算不出）",
		compiled && sanitize("///") === "skill" && sanitize("   ") === "skill" && viaStripOnly("///") !== sanitize("///") && viaStripOnly("   ") !== sanitize("   "),
		{ 两遍串联: sanitize("///"), 只剥首尾: viaStripOnly("///"), 两遍串联空格: sanitize("   "), 只剥首尾空格: viaStripOnly("   ") },
	);
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
	// 安装端点非法入参（都在出网前拒）。「SKILL.md 在仓库根」曾是 clone 后才判的（C3），
	// 现已改为排除 .git 照装，由 A5d 行为断言覆盖，端点层无需再补
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

	/* ---------- A5d：`.git` 排除 filter 的行为断言（C3 取代） ----------
	 * 原 C3 是「根目录 SKILL.md ⇒ 400 拒绝」，2026-09-29 裁决改为「排除 .git 照装」。
	 * 本组**真跑一次 cp**（不出网、不 clone），断言落盘结果 —— 取代原 A5c 的
	 * 静态文本断言（原组自认「短路成 false 仍全绿」，即零行为覆盖）。
	 * 断言不能只判「.git 没了」：还要钉住**没顺手排掉别的**。 */
	{
		// 夹具：根目录 SKILL.md + 同级 README + scripts/ 子目录 + .git/ + .gitignore
		// —— 复刻 shirenchuang/web-content-fetcher 的真实形态
		const root = path.join(tmpRoot, "a5d");
		fs.mkdirSync(path.join(root, ".git", "objects"), { recursive: true });
		fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(root, "SKILL.md"), "---\nname: web-content-fetcher\n---\n\nbody\n", "utf8");
		fs.writeFileSync(path.join(root, "README.md"), "readme\n", "utf8");
		fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n", "utf8");
		fs.writeFileSync(path.join(root, "scripts", "fetch.py"), "print(1)\n", "utf8");
		fs.writeFileSync(path.join(root, ".git", "objects", "abc"), "obj\n", "utf8");

		// 排除 .git 的 filter：与 skills-install.ts 里那行**同口径**（basename 判等）
		const filter = (src) => path.basename(src) !== ".git";
		const out = path.join(tmpRoot, "a5d-out");
		await fs.promises.cp(root, out, { recursive: true, filter });

		const outTop = fs.readdirSync(out);
		check("A5d .git 目录未落盘（cp filter 生效）", !outTop.includes(".git"), outTop);
		check("A5d 根目录 SKILL.md 已落盘（不是把整个技能排掉了）", fs.existsSync(path.join(out, "SKILL.md")), outTop);
		check("A5d 同级 README.md 已落盘（只排 .git，不是只搬 SKILL.md）", fs.existsSync(path.join(out, "README.md")), outTop);
		check("A5d 子目录 scripts/fetch.py 已落盘（技能要的脚本要跟着走）", fs.existsSync(path.join(out, "scripts", "fetch.py")), outTop);
		check("A5d .gitignore 已落盘（basename 判等不误伤 .gitignore）", fs.existsSync(path.join(out, ".gitignore")), outTop);

		// 反事实对拍：不过滤的话 .git 一定会被搬进来（否则「.git 没了」这条可能恒真）
		const naiveOut = path.join(tmpRoot, "a5d-naive");
		await fs.promises.cp(root, naiveOut, { recursive: true });
		check("A5d 反事实对拍：不过滤时 .git 确实会被搬进来（证明判据非恒真）", fs.existsSync(path.join(naiveOut, ".git")), fs.readdirSync(naiveOut));

		// 嵌套 .git（submodule 场景）：只判首段名能命中，深度无关
		const nestedRoot = path.join(tmpRoot, "a5d-nested");
		fs.mkdirSync(path.join(nestedRoot, "sub", ".git"), { recursive: true });
		fs.writeFileSync(path.join(nestedRoot, "SKILL.md"), "---\nname: my-skill\n---\n\nbody\n", "utf8");
		fs.writeFileSync(path.join(nestedRoot, "sub", "SKILL.md"), "---\nname: sub-skill\n---\n\nbody\n", "utf8");
		const nestedOut = path.join(tmpRoot, "a5d-nested-out");
		await fs.promises.cp(nestedRoot, nestedOut, { recursive: true, filter });
		const nestedGitLanded = fs.existsSync(path.join(nestedOut, "sub", ".git"));
		check("A5d 嵌套 .git（submodule）也被排除（只判首段名，与深度无关）", !nestedGitLanded, nestedGitLanded ? "sub/.git 落盘了" : "sub/.git 未落盘");

		// 本次改动的目的：根目录 SKILL.md 能被定位到（frontmatter name = 技能定位键）
		check(
			"A5d 根目录 SKILL.md 的 frontmatter name 可被读出（本次改动后此类仓库可装）",
			readFrontmatterName(path.join(root, "SKILL.md")) === "web-content-fetcher",
			{ 读到: readFrontmatterName(path.join(root, "SKILL.md")) },
		);

		// Windows 防线：`.git` 排除 filter 必须用 `path.basename`（按平台实现），
		// 不能自己切路径——`src.split("/").pop()` 对 `C:\repo\.git` 不切分，会**静默放行**，
		// 把 .git 整棵搬进用户 skills 目录。
		// 2026-09-30 修正：原判据拿**生产 filter**（宿主平台的 path.basename）直接判
		// `C:\repo\.git`，在 posix 平台上它**必然为假**——posix basename 只认 `/`，
		// 拿到的是整串 `C:\repo\.git`（≠ ".git" ⇒ 「放行」）。这不是生产缺陷：
		// win32 上 path.basename 即 win32 实现，天然命中；但判据混淆了「filter 实现」与
		// 「filter 在 win32 上的行为」，于是任何非 Windows CI 都假红（本版 CI 即栽在这）。
		// 现按平台语义对拍：`path.win32.basename` 才是 win32 上 path.basename 的真值。
		const winish = "C:\\repo\\.git";
		const posixish = "C:/repo/.git";
		const notGit = "C:/repo/.gitignore";
		const winBasename = (p) => path.win32.basename(p); // win32 上 path.basename 的等价物
		const posixBasename = (p) => path.posix.basename(p); // posix 上 path.basename 的等价物
		// ① Windows 平台语义：反斜杠路径同样命中 .git（用 win32 basename 判等）
		check(
			"A5d Windows 平台上过滤器用 basename 判等，反斜杠路径同样命中 .git（Windows 防线）",
			winBasename(winish) === ".git" && winBasename(winish) !== ".gitignore" && winBasename(notGit) !== ".git",
			{ 反斜杠basename: winBasename(winish), 正斜杠basename: winBasename(posixish), 误伤gitignore: winBasename(notGit) === ".git" },
		);
		// ② posix 平台语义：正斜杠路径同样命中 .git（本机 cp 行为，见上方真跑判据）
		check(
			"A5d posix 平台上过滤器用 basename 判等，正斜杠路径命中 .git 且不误伤 .gitignore",
			posixBasename(posixish) === ".git" && posixBasename(notGit) === ".gitignore" && posixBasename(notGit) !== ".git",
			{ 正斜杠basename: posixBasename(posixish), gitignore: posixBasename(notGit) },
		);
		// ③ 防线本体：为什么必须用 basename 而不是「自己切路径」。
		//    真实的 Windows 静默失效面 = 按硬编码 `/` 切分 win32 路径：
		//    `src.split("/").pop()` 对 `C:\repo\.git` 不切分，pop 回整串
		//    （≠ ".git" ⇒ 过滤器放行，.git 被整棵搬进用户 skills 目录）。
		//    basename 由 path 内部按平台实现，win32 上认反斜杠，故不会踩这个坑。
		//    反事实对拍：naive 写法在 win32 路径上放行（防线存在）、
		//    在 posix 路径上拦住（说明判据能区分两种写法，不是恒真）。
		const naiveBySplit = (src) => src.split("/").pop() !== ".git"; // 被「简化」掉的写法
		const byBasename = (src) => winBasename(src) !== ".git"; // 生产写法
		check(
			"A5d 防线本体：win32 下按 '/' 切分路径会放行 .git（静默失效写法），basename 判等拦下",
			naiveBySplit(winish) === true && naiveBySplit(posixish) === false && byBasename(winish) === false,
			{ naive放行win32: naiveBySplit(winish), naive拦下posix: naiveBySplit(posixish) === false, basename拦下: byBasename(winish) === false },
		);
		// ④ 源码接线：生产 filter 必须真的是「basename 判等」。复刻与源码会同进同退，
		//    故拆成两半：判据只保证「basename 版拦得住、split 版拦不住」，
		//    这一条把**生产源码那行**钉成 basename 版（源码被简化即红）。
		const srcFilter = /filter:\s*\(src\)\s*=>\s*path\.basename\(src\)\s*!==\s*"\.git"/.test(installSource);
		const srcSimplified = /filter:\s*\(src\)\s*=>\s*(?:src\.split\(\s*"\/"\s*\)\.pop\(\)|!src\.split\(\s*"\/"\s*\)\.pop\(\)\s*===\s*"?\.git"?)/.test(installSource);
		check(
			"A5d 源码接线：skills-install.ts 的 cp filter 确为 path.basename 判等（被改成 split 切分即红）",
			srcFilter && !srcSimplified,
			{ basenameFilter: srcFilter, split简化出现: srcSimplified },
		);
	}

	/* ---------- A13：安装来源记录 .pi-source.json（S6） ----------
	 * 写路径语义（覆盖伪造面 / 读取容错 / staging 原子序）+ Pi 发现容忍 + 409 富化锚点。
	 * 全部离线可测：helper 是纯 fs、Pi 的 loadSkillsFromDir 直接 import、409 行为级需
	 * clone（出网）由探针 L12 覆盖，这里做静态锚点断言。 */
	{
		// ① 覆盖语义：仓库自带的同名记录被 core 真值覆盖（伪造面关闭）
		const a13Write = path.join(tmpRoot, "a13-write");
		fs.mkdirSync(a13Write, { recursive: true });
		fs.writeFileSync(path.join(a13Write, ".pi-source.json"), '{"source":"evil/repo"}', "utf8");
		writeSkillSourceRecord(a13Write, "shirenchuang/web-content-fetcher", "web-content-fetcher");
		const rec = readSkillSourceRecord(a13Write);
		check(
			"A13 写入覆盖仓库自带同名记录（伪造面关闭：source/skillId 为 core 真值）",
			rec?.source === "shirenchuang/web-content-fetcher" && rec?.skillId === "web-content-fetcher" && typeof rec?.installedAt === "string",
			rec,
		);
		check(
			"A13 SKILL_SOURCE_FILENAME 常量即 .pi-source.json（改名会连带破坏 /skills 读路径契约）",
			mod.SKILL_SOURCE_FILENAME === ".pi-source.json",
			mod.SKILL_SOURCE_FILENAME,
		);

		// ② 读取容错：无文件 / 坏 JSON / source 非串 → undefined 且不 throw（读路径坏了不能打挂 /skills）
		const a13Missing = path.join(tmpRoot, "a13-missing");
		const a13Broken = path.join(tmpRoot, "a13-broken");
		const a13Empty = path.join(tmpRoot, "a13-empty-source");
		fs.mkdirSync(a13Missing, { recursive: true });
		fs.mkdirSync(a13Broken, { recursive: true });
		fs.mkdirSync(a13Empty, { recursive: true });
		fs.writeFileSync(path.join(a13Broken, ".pi-source.json"), "{not json", "utf8");
		fs.writeFileSync(path.join(a13Empty, ".pi-source.json"), '{"source":""}', "utf8");
		let a13Tolerant = true;
		let rMissing, rBroken, rEmpty;
		try {
			rMissing = readSkillSourceRecord(a13Missing);
			rBroken = readSkillSourceRecord(a13Broken);
			rEmpty = readSkillSourceRecord(a13Empty);
		} catch {
			a13Tolerant = false;
		}
		check(
			"A13 读取容错：无文件/坏 JSON/空 source → undefined 且不 throw",
			a13Tolerant && rMissing === undefined && rBroken === undefined && rEmpty === undefined,
			{ rMissing, rBroken, rEmpty },
		);

		// ③ C2 闸门扫 dot 文件：.pi-source.json 符号链接 → 422（staging 写记录无链接劫持面）
		try {
			const a13Link = path.join(tmpRoot, "a13-symlink");
			fs.mkdirSync(a13Link, { recursive: true });
			fs.writeFileSync(path.join(a13Link, "SKILL.md"), "---\nname: a13\n---\n", "utf8");
			fs.symlinkSync(a13Missing, path.join(a13Link, ".pi-source.json"), "file");
			let threw = null;
			try {
				assertSkillDirSafe(a13Link, "a13");
			} catch (e) {
				threw = e;
			}
			check(
				"A13 C2 闸门扫 dot 文件：.pi-source.json 符号链接 → 422（写记录无劫持面）",
				threw instanceof SkillInstallError && threw.status === 422,
				{ status: threw?.status ?? null },
			);
			fs.rmSync(path.join(a13Link, ".pi-source.json"), { force: true });
		} catch (e) {
			SKIPPED.push({
				id: "A13-symlink",
				reason: `本机无法创建符号链接（${e.code ?? e.message}），dot 文件链接闸门无法离线验证（与 A3 同款缺口，如实记 skip）`,
			});
		}

		// ④ Pi 发现容忍：带 .pi-source.json 的技能目录照常被发现（记录对 Pi 不可见）。
		// 布局按真实形态：skills/<名>/SKILL.md（Pi 的发现从 skills 根递归找**子目录**里的
		// SKILL.md；根调用不把根下直放的 SKILL.md 当技能——首版判据测错形状曾 0 结果）。
		// 夹具 frontmatter 必须带 description：Pi 的加载器要求必填（缺它 skill=undefined，
		// 实测 diagnostics 报 "description is required"——与记录无关，别误判成容忍性回归）。
		const a13PiRoot = path.join(tmpRoot, "a13-pi-root");
		const a13Pi = path.join(a13PiRoot, "a13-pi-skill");
		fs.mkdirSync(a13Pi, { recursive: true });
		fs.writeFileSync(
			path.join(a13Pi, "SKILL.md"),
			"---\nname: a13-pi-skill\ndescription: a13 discovery fixture\n---\n\nbody\n",
			"utf8",
		);
		writeSkillSourceRecord(a13Pi, "owner/repo", "a13-pi-skill");
		const piMod = await import("@earendil-works/pi-coding-agent");
		const discovered = piMod.loadSkillsFromDir({ dir: a13PiRoot, source: "user" });
		check(
			"A13 Pi 发现容忍：.pi-source.json 不影响 loadSkillsFromDir（恰 1 个技能、name 不变）",
			discovered.skills.length === 1 && discovered.skills[0].name === "a13-pi-skill",
			{ count: discovered.skills.length, names: discovered.skills.map((s) => s.name), diag: discovered.diagnostics },
		);

		// ⑤ 原子序 + 409 富化锚点（静态；行为级 409 需 clone，由探针 L12 覆盖）
		check(
			"A13 记录写入在 staging 内、rename 前（I1 原子序：写失败 = rm staging 整体失败）",
			installSource.indexOf("writeSkillSourceRecord(stagingDir") > -1 &&
				installSource.indexOf("writeSkillSourceRecord(stagingDir") <
					installSource.indexOf("await fs.promises.rename(stagingDir, targetDir)"),
			{
				write: installSource.indexOf("writeSkillSourceRecord(stagingDir"),
				rename: installSource.indexOf("await fs.promises.rename(stagingDir, targetDir)"),
			},
		);
		check(
			"A13 409 文案锚点前缀保留 + 富化读已装来源（S6）",
			installSource.includes("已存在同名技能目录：") &&
				installSource.includes("；已装来源：") &&
				/readSkillSourceRecord\(targetDir\)/.test(installSource),
			"锚点前缀=探针/判据匹配串，不得改动",
		);
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
