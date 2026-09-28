/**
 * Chrome 可执行文件路径解析 —— CDP 验收脚本的单一事实来源。
 *
 * ★ 为什么要抽这个模块（2026-09-28）：
 *   cdp.mjs 与 4 个 m1-* 脚本各自硬编码了
 *   `C:\Program Files\Google\Chrome\Application\chrome.exe`，
 *   在非 Windows 平台 spawn 必然 ENOENT（2026-09-28 在 Linux 上实锤：
 *   accept:m2 直接崩在 spawn 上，错误只说找不到 C 盘路径，完全指不出
 *   「本机其实装了 Chrome、在 /usr/bin/google-chrome」这个事实）。
 *   5 处同款硬编码散在 5 个文件里，改一处漏四处的教训已经吃过一次。
 *
 * 解析顺序（显式覆盖优先，逐级降级）：
 *   ① CHROME_PATH 环境变量 —— 显式指定，最高优先级，CI/容器里常用
 *   ② 平台默认候选路径 —— 各系统 Chrome 的标准安装位置
 *   ③ PATH 逐个探测       —— 覆盖 snap/flatpak/自编译等非标准安装
 *
 * 不下载 Chromium、不引入 puppeteer/playwright —— 沿用 cdp.mjs 原注释的判断：
 *   本机 storage.googleapis.com 不可达，且项目约定不随意新增依赖。
 *
 * 用法：
 * ```js
 * import { resolveChromePath } from "./chrome-path.mjs";
 * spawn(resolveChromePath(), [...]);
 * ```
 */
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** 各平台 Chrome 标准安装位置的候选（按命中概率排序） */
const CANDIDATES_BY_PLATFORM = {
	win32: [
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
		// 用户级安装（免管理员权限那种）
		join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
	],
	darwin: [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		join(process.env.HOME ?? "", "Applications", "Google Chrome.app/Contents/MacOS/Google Chrome"),
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	],
	linux: [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/opt/google/chrome/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		// snap / flatpak 安装的 Chrome
		"/snap/bin/chromium",
		"/var/lib/flatpak/exports/bin/com.google.Chrome",
		// 用户级安装
		join(process.env.HOME ?? "", ".local", "opt", "google-chrome", "chrome"),
	],
};

/** 某路径是否是可执行文件（不存在、不是文件、不可执行都算不可用） */
function isExecutable(p) {
	if (!p) return false;
	try {
		accessSync(p, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** 把 PATH 里每个目录都拼上可执行名试一遍（覆盖非标准安装位置） */
function findOnPath(names) {
	const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	for (const name of names) {
		for (const dir of entries) {
			const candidate = join(dir, name);
			if (isExecutable(candidate)) return candidate;
		}
	}
	return null;
}

/**
 * 解析本机 Chrome 路径；找不到就抛**可操作**的错误。
 *
 * 刻意不在模块顶层调用（顶层会连带 import 的 22 个脚本在启动阶段就炸），
 * 而是由各调用方在使用点调用 —— 导入本模块本身永远安全。
 *
 * @param {string} [override] 显式指定路径，优先级高于 CHROME_PATH 环境变量
 * @returns {string} 可执行文件的绝对/相对路径
 * @throws 找不到时抛错，错误信息含已试路径与补救办法
 */
export function resolveChromePath(override) {
	const tried = [];

	// ① 显式指定：函数参数 > 环境变量
	const explicit = (override ?? process.env.CHROME_PATH ?? "").trim();
	if (explicit) {
		if (isExecutable(explicit)) return explicit;
		tried.push(`${explicit}（来自 ${override ? "参数" : "CHROME_PATH 环境变量"}，但不可执行）`);
	}

	// ② 平台标准安装位置
	const platform = process.platform;
	const candidates = CANDIDATES_BY_PLATFORM[platform] ?? [];
	for (const c of candidates) {
		if (!c) continue; // 环境变量为空时 join 会产出相对路径，跳过
		if (isExecutable(c)) return c;
		tried.push(c);
	}

	// ③ PATH 兜底
	const names = platform === "win32" ? ["chrome.exe", "chrome"] : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
	const onPath = findOnPath(names);
	if (onPath) return onPath;
	tried.push(`PATH 中的 ${names.join(" / ")}`);

	// 全部落空：给能照着做的错误，而不是裸 ENOENT
	throw new Error(
		[
			`找不到 Chrome 可执行文件（platform=${platform}）。`,
			`已尝试：`,
			...tried.map((t) => `  - ${t}`),
			``,
			`补救办法（任选其一）：`,
			`  1) 指定路径后重跑，例如：`,
			`     ${platform === "win32" ? "set CHROME_PATH=C:\\\\path\\\\to\\\\chrome.exe" : platform === "darwin" ? "export CHROME_PATH=/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome" : "export CHROME_PATH=/usr/bin/google-chrome"} npm run accept:m2`,
			`  2) 安装 Chrome/Chromium 后确认它在 PATH 里（which google-chrome）。`,
		].join("\n"),
	);
}
