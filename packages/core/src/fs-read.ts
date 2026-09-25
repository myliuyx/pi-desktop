/**
 * 文件读取数据源（dir-file-preview 批次）—— `GET /fs/read` 的实现。
 *
 * 定位：**只读文本内容**，给侧栏文件树点开的右侧预览区当数据源。安全面零扩大：
 * 能拿到 token 的人本可经 agent 在这台机器上执行任意命令（含读任意文件），
 * 限长只读是严格更弱的能力（与 fs-list.ts 头部同一段安全论证）；端点进
 * API_ROUTES 自动获得 token + Host 白名单。
 *
 * 判定规则（与 fs-list 同口径）：
 * - `~` 前缀展开 os.homedir()（复用 fs-list 的 expandHome）；
 * - statSync 跟随符号链接（fs-list 列目录跟随，此处读内容跟随，两侧一致）；
 * - 目标不存在 / 不是普通文件 → 400；无权限 → 403（FileReadError 与 DirListError
 *   同型，server 据此回对应状态码，与意外错误 500 区分）；
 * - **二进制嗅探**：首 8KB 内出现 0x00 字节即判二进制（git 的同款启发式），
 *   binary:true 时 content 为空串——预览区据此给「不支持预览」占位；
 * - **限长**：FILE_READ_MAX_BYTES = 256KB。超出时只读前 256KB + truncated:true
 *   （用 open/read 定长读，绝不把 GB 级文件整读进内存）；截断点若落在多字节
 *   UTF-8 序列中间，回退到该序列起点之前，避免预览尾部凭空出现替换字符；
 * - size 恒为**真实文件大小**（stat 值，不受截断影响），预览区据此提示
 *   「仅显示前 N KB」。
 */

import fs from "node:fs";
import path from "node:path";
import { expandHome } from "./fs-list.ts";

export interface FileReadOk {
	ok: true;
	/** 归一化后的绝对路径 */
	path: string;
	/** 文件名（basename），预览区标题直接用 */
	name: string;
	/** 真实文件大小（字节；truncated 时 > content 的字节数） */
	size: number;
	/** 内容超出上限被截断 */
	truncated: boolean;
	/** 二进制时恒为空串 */
	content: string;
	/** 二进制文件（首 8KB 含 0x00）：预览区不渲染内容 */
	binary: boolean;
}

/** 可预期失败（server 据此回对应状态码，与意外错误 500 区分——DirListError 同型） */
export class FileReadError extends Error {
	constructor(
		public status: 400 | 403 | 500,
		message: string,
	) {
		super(message);
	}
}

/** 预览内容上限（字节）：256KB ≈ 数千行代码，预览场景足够且 shiki 渲染无压力 */
export const FILE_READ_MAX_BYTES = 256 * 1024;

/** 二进制嗅探窗口：首 8KB 出现 0x00 即判二进制 */
const BINARY_SNIFF_BYTES = 8 * 1024;

function errnoToError(e: unknown, target: string): FileReadError {
	const code = (e as NodeJS.ErrnoException)?.code;
	if (code === "ENOENT") return new FileReadError(400, `文件不存在：${target}`);
	if (code === "EACCES" || code === "EPERM") return new FileReadError(403, `无权限读取文件：${target}`);
	return new FileReadError(500, e instanceof Error ? e.message : String(e));
}

/**
 * 截断点若落在多字节 UTF-8 序列中间，回退到该序列起点之前。
 * （lead byte 按 0b11xxxx10 前缀判序列长度：0xxxxxxx=1 / 110xxxxx=2 / 1110xxxx=3 / 11110xxx=4）
 */
function cutAtCodepointBoundary(buf: Buffer): Buffer {
	if (buf.length === 0) return buf;
	let lead = buf.length - 1;
	while (lead >= 0 && (buf[lead] & 0xc0) === 0x80) lead--;
	if (lead < 0) return buf; // 整段都是续字节（不可能的合法 UTF-8），原样交由 toString 兜底
	const leadByte = buf[lead];
	const seqLen = leadByte < 0x80 ? 1 : leadByte < 0xe0 ? 2 : leadByte < 0xf0 ? 3 : 4;
	if (lead + seqLen <= buf.length) return buf;
	return buf.subarray(0, lead);
}

export function readTextFile(raw: string, fallbackCwd: string): FileReadOk {
	const target = path.resolve(expandHome(raw.trim()) || fallbackCwd);

	let st: fs.Stats;
	try {
		st = fs.statSync(target);
	} catch (e) {
		throw errnoToError(e, target);
	}
	if (!st.isFile()) throw new FileReadError(400, `不是文件：${target}`);

	const truncated = st.size > FILE_READ_MAX_BYTES;
	// 定长读：只把「会被预览的量」读进内存，不做整文件 readFile
	const want = Math.min(st.size, FILE_READ_MAX_BYTES);
	const buf = Buffer.alloc(want);
	if (want > 0) {
		let fd: number;
		try {
			fd = fs.openSync(target, "r");
		} catch (e) {
			throw errnoToError(e, target);
		}
		try {
			let read = 0;
			while (read < want) {
				const n = fs.readSync(fd, buf, read, want - read, read);
				if (n <= 0) break; // 文件被并发截短：按已读到的内容算（size 仍以 stat 为准）
				read += n;
			}
		} finally {
			fs.closeSync(fd);
		}
	}

	const binary = buf.subarray(0, Math.min(buf.length, BINARY_SNIFF_BYTES)).includes(0);
	const content = binary ? "" : cutAtCodepointBoundary(buf).toString("utf8");

	return {
		ok: true,
		path: target,
		name: path.basename(target),
		size: st.size,
		truncated,
		content,
		binary,
	};
}
