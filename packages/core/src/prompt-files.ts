/**
 * /prompt 的 @file 引用展开（at-file 批次，task-composer-at-file.md §4.2）。
 *
 * 语义对齐上游 pi CLI 的 `processFileArguments`（pi/packages/coding-agent/src/cli/
 * file-processor.ts）：文本文件拼 `<file name="绝对路径">\n内容\n</file>\n` 前置块、
 * 图片转 base64 附件（AgentSession.prompt 的 PromptOptions.images）。该函数未从
 * `@earendil-works/pi-coding-agent` 包入口导出（exports 白名单拦截深路径），故按同
 * 语义在此实现；差异点见下。
 *
 * 与 CLI 的刻意差异（web 场景不能让一条坏引用吞掉整条消息，CLI 是 process.exit(1)）：
 * - 读不到 / 不是文件 / 二进制 / 过大 ⇒ **跳过并记入 skipped**（UI 弹通知），不阻塞发送；
 * - 空文件跳过（CLI 静默跳过，此处记入 skipped 让用户知道引用没生效）；
 * - 文本限长：复用 readTextFile 的 256KB 上限与 UTF-8 截断边界，超限在块尾注明——
 *   防止单个巨型文件挤爆模型上下文（CLI 无此限）；
 * - 图片不做 autoResize（CLI 的 processImage 依赖 pi-ai 内部模块），仅 8MB 上限内原样
 *   base64，超限跳过。
 */

import fs from "node:fs";
import path from "node:path";
import { expandHome } from "./fs-list.ts";
import { FileReadError, readTextFile } from "./fs-read.ts";

/** 与上游 `@earendil-works/pi-ai` 的 ImageContent 同形（结构化兼容，可直接传 PromptOptions.images） */
export interface PromptImage {
	type: "image";
	/** base64 编码的图片数据 */
	data: string;
	mimeType: string;
}

export interface ExpandedFileRefs {
	/** 所有 file 块拼接结果（每块自带尾随换行；调用方直接前置拼在用户文本前） */
	promptText: string;
	images: PromptImage[];
	/** 被跳过的引用（用户输入原样 + 括注原因），UI 弹通知用 */
	skipped: string[];
}

/** 图片附件的原始字节上限（base64 后 ≈10.7MB，超出即让 agent 自己用 read 工具读） */
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** 魔数嗅探窗口：png 8 字节签名 / webp 12 字节 RIFF….WEBP，取最大 */
const SNIFF_BYTES = 12;

interface ImageKind {
	mimeType: string;
}

/** 魔数判定（判定结果只区分「图片走附件」与「其余走文本」，不做更细的 mime 推断） */
function detectImage(head: Buffer): ImageKind | null {
	const starts = (bytes: number[]) => bytes.every((b, i) => head[i] === b);
	if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mimeType: "image/png" };
	if (starts([0xff, 0xd8, 0xff])) return { mimeType: "image/jpeg" };
	if (starts([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || starts([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
		return { mimeType: "image/gif" };
	// webp = "RIFF" + 4 字节长度 + "WEBP"
	if (starts([0x52, 0x49, 0x46, 0x46]) && startsWithOffset(head, 8, [0x57, 0x45, 0x42, 0x50]))
		return { mimeType: "image/webp" };
	return null;
}

function startsWithOffset(head: Buffer, offset: number, bytes: number[]): boolean {
	return bytes.every((b, i) => head[offset + i] === b);
}

export function expandFileRefs(refs: string[], cwd: string): ExpandedFileRefs {
	const blocks: string[] = [];
	const images: PromptImage[] = [];
	const skipped: string[] = [];

	for (const rawRef of refs) {
		const ref = rawRef.trim();
		if (!ref) continue;
		const skip = (reason: string) => skipped.push(`${ref}（${reason}）`);
		const target = path.resolve(cwd, expandHome(ref));

		let st: fs.Stats;
		try {
			st = fs.statSync(target);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException)?.code;
			skip(code === "ENOENT" ? "文件不存在" : code === "EACCES" || code === "EPERM" ? "无权限" : "读取失败");
			continue;
		}
		if (!st.isFile()) {
			skip("不是文件");
			continue;
		}
		if (st.size === 0) {
			skip("空文件");
			continue;
		}

		// 魔数嗅探：读首 12 字节定走图片附件还是文本块
		let head: Buffer;
		try {
			head = Buffer.alloc(Math.min(st.size, SNIFF_BYTES));
			let read = 0;
			const fd = fs.openSync(target, "r");
			try {
				while (read < head.length) {
					const n = fs.readSync(fd, head, read, head.length - read, read);
					if (n <= 0) break;
					read += n;
				}
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			skip("读取失败");
			continue;
		}

		const image = detectImage(head);
		if (image) {
			if (st.size > IMAGE_MAX_BYTES) {
				skip("图片超过 8MB");
				continue;
			}
			try {
				images.push({
					type: "image",
					data: fs.readFileSync(target).toString("base64"),
					mimeType: image.mimeType,
				});
			} catch {
				skip("读取失败");
			}
			continue;
		}

		// 文本：复用 readTextFile（256KB 限长 + 0x00 二进制嗅探 + UTF-8 截断边界）。
		// ⚠️ 传已 resolve 的绝对路径 target，不传 ref——readTextFile 的 fallbackCwd 只在
		// raw 为空时生效，相对 raw 一律按 core 进程 cwd 解析（fs-read 既有语义），
		// 热切换过 cwd 后会解析到错误目录。
		try {
			const r = readTextFile(target, cwd);
			if (r.binary) {
				skip("二进制文件不支持引用");
				continue;
			}
			// BOM 剥离对齐 CLI 的 stripBom（readTextFile 是预览口径，不剥 BOM）
			const content = r.content.replace(/^\ufeff/, "");
			const tail = r.truncated ? "\n[… 文件过大，仅注入前 256KB …]" : "";
			blocks.push(`<file name="${r.path}">\n${content}${tail}\n</file>\n`);
		} catch (e) {
			skip(e instanceof FileReadError ? (e.status === 403 ? "无权限" : e.message) : "读取失败");
		}
	}

	return { promptText: blocks.join(""), images, skipped };
}
