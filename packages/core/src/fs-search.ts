/**
 * 文件模糊搜索数据源（at-file 批次，task-composer-at-file.md §4.1）—— `GET /fs/search` 的实现。
 *
 * 定位：给 Composer 的 @ 弹层当搜索数据源。安全面零扩大：能拿到 token 的人本可经
 * agent 在这台机器上执行任意命令（含读任意文件），**只读文件名** + 在 cwd 内搜是严格
 * 更弱的能力（fs-list.ts / fs-read.ts 头部同一段安全论证）；端点进 API_ROUTES
 * 自动获得 token + Host 白名单。
 *
 * 判定规则：
 * - 搜索范围 = `path` 参数（缺省 core cwd，与 /fs/list 同口径；UI 显式传 liveCwd，
 *   理由同文件树：根与「core 当前 cwd」是两个概念，并发切换时不依赖服务端时序）；
 * - 收集优先 `git ls-files -coz --exclude-standard`（尊重 .gitignore 且含未跟踪文件；
 *   `-z` 用 NUL 分隔——默认的 quotepath 转义会把中文文件名变成 `"\346\226..."`）；
 *   git 不可用 / 非 git 仓库 / 超时 ⇒ 回退递归 walk（跳重目录、深度与总量双上限，防大仓卡死；
 *   符号链接不跟随防环）。git 模式不逐个 stat 存在性（几万次 statSync 在 win 上百毫秒级）：
 *   index 里已删未 rm 的幽灵文件会漏到结果里，由引用时的 skipped 通知兜底；
 * - 只收**文件**（目录不可引用）；
 * - 匹配大小写不敏感（relPath 统一 / 分隔后比较）：basename 全等 > basename 前缀 >
 *   basename 子串 > 全路径子串 > 子序列；同分按 relPath 短者前，再码元序——确定性优先于
 *   语言学正确（fs-list 排序注释同源理由：ICU 各机差异会让 check 断言漂移）；
 * - query 为空不淘汰（@ 刚键入时的候选列表）：全部按「路径短者前」排序；
 * - 截断 top limit（缺省 50，上限 200）+ truncated 标记。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expandHome } from "./fs-list.ts";

export interface FsSearchEntry {
	name: string;
	/** 绝对路径（UI 的 title / 预览跳转用） */
	absPath: string;
	/** 相对搜索根的 POSIX 风格路径（@引用的展示与插入口径，core 端按自身 cwd 反解） */
	relPath: string;
	/**
	 * 条目类型。目录也可引用（2026-09-28 用户裁决 D6）：@目录 = 给模型一层目录清单
	 * （expandFileRefs 的 type="directory" 块），所以搜索候选**文件与目录同榜**。
	 */
	kind: "dir" | "file";
}

export interface FsSearchOk {
	ok: true;
	/** 归一化后的搜索根（绝对路径） */
	cwd: string;
	query: string;
	entries: FsSearchEntry[];
	/** 命中数超 limit 被截断时为 true */
	truncated?: boolean;
}

/** 可预期失败（server 据此回对应状态码，与意外错误 500 区分——DirListError 同型） */
export class FsSearchError extends Error {
	constructor(
		public status: 400 | 403 | 500,
		message: string,
	) {
		super(message);
	}
}

export const FS_SEARCH_DEFAULT_LIMIT = 50;
export const FS_SEARCH_MAX_LIMIT = 200;

/** walk 回退的总量上限（防大仓把请求拖成秒级） */
const WALK_MAX_FILES = 8000;
/** walk 回退的目录递归深度上限（文件在任意可达深度都收，限制的是目录层数） */
const WALK_MAX_DEPTH = 8;
/** walk 回退跳过的重目录（构建产物 / 运行数据 / 包管理——引用它们没有意义且数量巨大） */
const WALK_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "run", "target", ".venv", "coverage"]);

function errnoToError(e: unknown, target: string): FsSearchError {
	const code = (e as NodeJS.ErrnoException)?.code;
	if (code === "ENOENT") return new FsSearchError(400, `目录不存在：${target}`);
	if (code === "EACCES" || code === "EPERM") return new FsSearchError(403, `无权限读取目录：${target}`);
	return new FsSearchError(500, e instanceof Error ? e.message : String(e));
}

/** git 收集：成功返回相对路径数组（POSIX 分隔）；git 不可用 / 非 git 仓库 / 超时返回 null 走 walk */
function listViaGit(dir: string): string[] | null {
	try {
		const out = execFileSync("git", ["ls-files", "-coz", "--exclude-standard"], {
			cwd: dir,
			timeout: 5000,
			maxBuffer: 64 * 1024 * 1024,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return out
			.toString("utf8")
			.split("\0")
			.filter((p) => p.length > 0);
	} catch {
		return null;
	}
}

/** walk 收集：返回绝对路径数组（不跟符号链接；越界即停）。目录与文件都收（目录可引用，D6） */
function listViaWalk(dir: string): { abs: string; isDir: boolean }[] {
	const out: { abs: string; isDir: boolean }[] = [];
	const walk = (d: string, depth: number): void => {
		if (depth > WALK_MAX_DEPTH || out.length >= WALK_MAX_FILES) return;
		let dirents: fs.Dirent[];
		try {
			dirents = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return; // 单个目录不可读不拖垮整体
		}
		for (const de of dirents) {
			if (out.length >= WALK_MAX_FILES) return;
			const abs = path.join(d, de.name);
			if (de.isDirectory()) {
				if (WALK_SKIP_DIRS.has(de.name)) continue;
				out.push({ abs, isDir: true });
				walk(abs, depth + 1);
			} else if (de.isFile()) {
				out.push({ abs, isDir: false });
			}
		}
	};
	walk(dir, 0);
	return out;
}

/** 子序列判定：q 的字符按序全部出现在 s 中（双指针） */
function isSubsequence(q: string, s: string): boolean {
	let i = 0;
	for (let j = 0; i < q.length && j < s.length; j++) {
		if (q[i] === s[j]) i++;
	}
	return i === q.length;
}

/**
 * 匹配打分：-1 = 淘汰；分值分级见文件头。返回值只用于排序比较，量纲无意义。
 * relN / nameN 均已 toLowerCase；relN 统一 / 分隔（Windows 反斜杠不参与匹配）。
 */
function scoreOf(relN: string, nameN: string, q: string): number {
	if (!q) return 0;
	if (nameN === q) return 1000;
	if (nameN.startsWith(q)) return 900;
	if (nameN.includes(q)) return 800;
	if (relN.includes(q)) return 600;
	if (isSubsequence(q, relN)) return 300;
	return -1;
}

export interface SearchFilesOptions {
	limit?: number;
}

interface Candidate {
	absPath: string;
	relPath: string;
	name: string;
	kind: "dir" | "file";
}

export function searchFiles(
	raw: string,
	fallbackCwd: string,
	query: string,
	options: SearchFilesOptions = {},
): FsSearchOk {
	const target = path.resolve(expandHome(raw.trim()) || fallbackCwd);
	const limit =
		typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit >= 1
			? Math.min(Math.floor(options.limit), FS_SEARCH_MAX_LIMIT)
			: FS_SEARCH_DEFAULT_LIMIT;

	let st: fs.Stats;
	try {
		st = fs.statSync(target);
	} catch (e) {
		throw errnoToError(e, target);
	}
	if (!st.isDirectory()) throw new FsSearchError(400, `不是目录：${target}`);

	const viaGit = listViaGit(target);
	let candidates: Candidate[];
	if (viaGit !== null) {
		// git 模式：ls-files 只列文件，目录候选从文件路径推导父目录集合（去重）
		const dirSet = new Set<string>();
		for (const rel of viaGit) {
			let dir = path.posix.dirname(rel);
			while (dir && dir !== ".") {
				dirSet.add(dir);
				dir = path.posix.dirname(dir);
			}
		}
		candidates = [
			...viaGit.map((rel) => ({
				absPath: path.join(target, ...rel.split("/")),
				relPath: rel,
				name: path.posix.basename(rel),
				kind: "file" as const,
			})),
			...[...dirSet].map((rel) => ({
				absPath: path.join(target, ...rel.split("/")),
				relPath: rel,
				name: path.posix.basename(rel),
				kind: "dir" as const,
			})),
		];
	} else {
		candidates = listViaWalk(target).map(({ abs, isDir }) => ({
			absPath: abs,
			relPath: path.relative(target, abs).split(path.sep).join("/"),
			name: path.basename(abs),
			kind: isDir ? ("dir" as const) : ("file" as const),
		}));
	}

	const q = query.trim().toLowerCase();
	const scored: { score: number; candidate: Candidate }[] = [];
	for (const candidate of candidates) {
		const score = scoreOf(candidate.relPath.toLowerCase(), candidate.name.toLowerCase(), q);
		if (score >= 0) scored.push({ score, candidate });
	}

	scored.sort((a, b) => {
		if (a.score !== b.score) return b.score - a.score;
		const ra = a.candidate.relPath;
		const rb = b.candidate.relPath;
		if (ra.length !== rb.length) return ra.length - rb.length;
		const la = ra.toLowerCase();
		const lb = rb.toLowerCase();
		if (la !== lb) return la < lb ? -1 : 1;
		return ra < rb ? -1 : ra > rb ? 1 : 0;
	});

	const truncated = scored.length > limit;
	const entries = scored.slice(0, limit).map(({ candidate }) => ({
		name: candidate.name,
		absPath: candidate.absPath,
		relPath: candidate.relPath,
		kind: candidate.kind,
	}));

	const result: FsSearchOk = { ok: true, cwd: target, query, entries };
	if (truncated) result.truncated = true;
	return result;
}
