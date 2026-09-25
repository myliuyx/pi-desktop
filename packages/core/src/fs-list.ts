/**
 * 目录浏览数据源（dir-picker 批次，task-dir-picker.md §4.1）—— `GET /fs/list` 的实现。
 *
 * 定位：**只读列名字**，给 UI 的「自定义路径」弹窗（仅目录）与侧栏文件树（目录+文件，
 * dir-tree 批次 task-sidebar-file-tree.md）当浏览数据源。安全面零扩大：
 * 能拿到 token 的人本可经 agent 在这台机器上执行任意命令，列名字是严格更弱的能力
 * （deploy.md 安全边界段已补记）；端点进 API_ROUTES 自动获得 token + Host 白名单。
 *
 * 判定规则（契约见 task-dir-picker.md §4.0 / task-sidebar-file-tree.md §4.0，UI 与
 * check 脚本两侧同源）：
 * - `~` 前缀展开 os.homedir()（path.resolve 不认 ~，而手输 ~ 是高频习惯；不支持 ~user）；
 * - 缺省只列**目录**：dirent.isDirectory 直接收；符号链接 statSync 跟随判定，断链跳过
 *   （不可达的链接不是可选项，也不该让整个请求失败）；`includeFiles` 时普通文件一并
 *   收入 `kind:"file"` 组（其余 socket/fifo 等仍不列——「不认识就不列」口径不变）；
 * - 排序用**码元比较**（lowercase 后逐码元），不用 localeCompare——ICU 各机差异会让
 *   check 脚本的排序断言在不同机器上漂移，验收判据必须确定性；
 * - 上限 DIR_LIST_MAX_ENTRIES=500，超出截断 + truncated 标记（防 System32 级目录卡死弹窗）；
 *   includeFiles 时目录组拼前、文件组拼后合并截断（目录优先的代价：文件可能整体被截掉，
 *   task-sidebar-file-tree.md §九已记）；
 * - parent = path.dirname(resolved)，等于自身（POSIX 根 / 盘根 / UNC 根）→ null；
 * - win32 盘符：仅当 parent===null（无法再上一级、唯一需要换盘的时刻）才枚举 A–Z，
 *   模块级缓存——existsSync 对断连网络盘可能秒级阻塞，不能每次列目录都付这个代价。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DirEntry {
	name: string;
	path: string;
	/** 条目类型（dir-tree 批次 §4.0 冻结）：两种模式恒返回，缺省路径恒为 "dir" */
	kind: "dir" | "file";
}

export interface DirListOk {
	ok: true;
	/** 归一化后的绝对路径（UI 回显到输入框，用户看到自己输入被解析成了什么） */
	path: string;
	/** 上一级目录；已在根（POSIX 根 / 盘根 / UNC 根）时为 null */
	parent: string | null;
	entries: DirEntry[];
	/** 子条目数超上限被截断时为 true */
	truncated?: boolean;
	/** 仅 win32 且 parent===null 时返回，如 ["C:\\","D:\\"] */
	drives?: string[];
}

/** 可预期失败（server 据此回对应状态码，与意外错误 500 区分——InvalidCwdError 同型先例 session.ts:164） */
export class DirListError extends Error {
	constructor(
		public status: 400 | 403 | 500,
		message: string,
	) {
		super(message);
	}
}

export const DIR_LIST_MAX_ENTRIES = 500;

/** `~`/`~/x` 展开 home；fs-read（文件预览）共用同一套路径口径 */
export function expandHome(raw: string): string {
	if (raw === "~") return os.homedir();
	if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(2));
	return raw;
}

let drivesCache: string[] | null = null;
function listDrives(): string[] {
	if (drivesCache) return drivesCache;
	const drives: string[] = [];
	for (let i = 65; i <= 90; i++) {
		const root = `${String.fromCharCode(i)}:\\`;
		try {
			// existsSync 对不存在的盘符返回 false；对断连网络盘可能阻塞——这正是缓存的理由
			if (fs.existsSync(root)) drives.push(root);
		} catch {
			/* 单个盘符探测失败不影响其余 */
		}
	}
	drivesCache = drives;
	return drives;
}

function errnoToError(e: unknown, target: string): DirListError {
	const code = (e as NodeJS.ErrnoException)?.code;
	if (code === "ENOENT") return new DirListError(400, `目录不存在：${target}`);
	if (code === "EACCES" || code === "EPERM") return new DirListError(403, `无权限读取目录：${target}`);
	return new DirListError(500, e instanceof Error ? e.message : String(e));
}

export interface ListDirectoriesOptions {
	/** true = 普通文件一并列入（`kind:"file"` 组，拼在目录组之后）；缺省 = 仅目录（dir-picker 现状） */
	includeFiles?: boolean;
}

export function listDirectories(raw: string, fallbackCwd: string, options: ListDirectoriesOptions = {}): DirListOk {
	const includeFiles = options.includeFiles === true;
	const target = path.resolve(expandHome(raw.trim()) || fallbackCwd);

	let st: fs.Stats;
	try {
		st = fs.statSync(target);
	} catch (e) {
		throw errnoToError(e, target);
	}
	if (!st.isDirectory()) throw new DirListError(400, `不是目录：${target}`);

	let dirents: fs.Dirent[];
	try {
		dirents = fs.readdirSync(target, { withFileTypes: true });
	} catch (e) {
		throw errnoToError(e, target);
	}

	const dirNames: string[] = [];
	const fileNames: string[] = [];
	for (const d of dirents) {
		if (d.isDirectory()) {
			dirNames.push(d.name);
			continue;
		}
		if (d.isSymbolicLink()) {
			try {
				// 跟随判定：指向目录进目录组，指向文件且 includeFiles 时进文件组，断链跳过
				const linked = fs.statSync(path.join(target, d.name));
				if (linked.isDirectory()) {
					dirNames.push(d.name);
				} else if (includeFiles && linked.isFile()) {
					fileNames.push(d.name);
				}
			} catch {
				/* 断链 / 不可达：跳过，不让它拖垮整个列表 */
			}
			continue;
		}
		if (includeFiles && d.isFile()) fileNames.push(d.name);
	}

	// 码元排序（lowercase 后），大小写同形时按原名兜底——确定性优先于语言学正确
	const byCodeUnit = (a: string, b: string) => {
		const la = a.toLowerCase();
		const lb = b.toLowerCase();
		if (la !== lb) return la < lb ? -1 : 1;
		return a < b ? -1 : a > b ? 1 : 0;
	};
	dirNames.sort(byCodeUnit);
	// 目录组恒拼在文件组前（task-sidebar-file-tree.md §4.0：截图口径「目录在前文件在后」）
	const names = includeFiles ? [...dirNames, ...fileNames.sort(byCodeUnit)] : dirNames;

	const truncated = names.length > DIR_LIST_MAX_ENTRIES;
	const entries = names.slice(0, DIR_LIST_MAX_ENTRIES).map((name, index) => ({
		name,
		path: path.join(target, name),
		kind: includeFiles && index >= dirNames.length ? ("file" as const) : ("dir" as const),
	}));

	const dirname = path.dirname(target);
	const result: DirListOk = {
		ok: true,
		path: target,
		parent: dirname === target ? null : dirname,
		entries,
	};
	if (truncated) result.truncated = true;
	if (result.parent === null && process.platform === "win32") {
		const drives = listDrives();
		if (drives.length > 0) result.drives = drives;
	}
	return result;
}
