/**
 * 图片字节数据源（2026-10-02 文件图片预览批次）—— `GET /fs/image` 的实现。
 *
 * 定位：**只读图片原始字节**，给侧栏文件树点开的右侧预览区当位图源。安全面零扩大：
 * 能拿到 token 的人本可经 agent 在这台机器上执行任意命令（含读任意文件），
 * 限长只读是严格更弱的能力（与 fs-list.ts / fs-read.ts 头部同一段论证）。
 *
 * 与 `fs-read.ts`（`/fs/read`）的分工：
 * - `/fs/read` 出**限长文本**，供源码高亮/Markdown/HTML-iframe；
 * - `/fs/image` 出**原始字节**，供 `<img>` 标签。两个端点并列，UI 按 kind 分流——
 *   图片若走 `/fs/read`，其 256KB 截断会把超过 256KB 的 PNG 腰斩成破图。
 *
 * 判定规则：
 * - 路径口径**照抄 fs-read.ts**（`expandHome` + `path.resolve` + statSync 跟随符号链接 +
 *   errno→400/403 映射），两侧不得漂移；
 * - **MIME 由魔数嗅探决定，绝不取扩展名** —— 扩展名可伪造（`.png` 里塞 HTML）、
 *   可缺失，且 `Content-Type` 是被直写 `res.writeHead` 的值域，必须来自代码常量；
 * - **限长** IMAGE_FILE_MAX_BYTES = 8MB（与 prompt-files.ts 的 IMAGE_MAX_BYTES 同值，
 *   粘贴图通道的传输层上限同一口径——预览不该比上传能看更大的图）；
 * - 超限回 413、非图片回 415，均由 ImageFileError 带状态码，server 据此回码，
 *   与意外 500 区分（FileReadError 同型先例）。
 */

import fs from "node:fs";
import path from "node:path";
import { expandHome } from "./fs-list.ts";
import { IMAGE_MAX_BYTES } from "./prompt-files.ts";

/** 预览图片字节上限：粘贴图通道 `IMAGE_MAX_BYTES` 的同值镜像，改一处必须同步另一处 */
export const IMAGE_FILE_MAX_BYTES = IMAGE_MAX_BYTES;

/** 可预期失败（server 据此回对应状态码，与意外错误 500 区分——FileReadError 同型） */
export class ImageFileError extends Error {
	constructor(
		public status: 400 | 403 | 413 | 415 | 500,
		message: string,
	) {
		super(message);
	}
}

export interface ImageFileOk {
	ok: true;
	/** 归一化后的绝对路径 */
	path: string;
	/** 文件名（basename），预览区标题直接用 */
	name: string;
	/** 真实文件大小（字节） */
	size: number;
	/** 魔数嗅探出的 MIME；值域 = MIME_WHITELIST，可直写 Content-Type */
	mimeType: string;
	/** 原始字节（不转 base64——`<img>` 直连字节流，省一次约 33% 的膨胀） */
	bytes: Buffer;
}

/**
 * MIME 白名单 = Chromium `<img>` 能可靠预览的集（png/jpeg/gif/webp/bmp）。
 * 与 `session.ts:102-108` 的 SESSION_IMAGE_MIME_WHITELIST 完全一致（会话历史图
 * 与目录树图片共用同一张集，防「粘贴能发的图、预览区反而打不开」的割裂）。
 * ICO/AVIF/HEIC 刻意不收——image-attach.ts 的上传白名单同样没有它们。
 */
const MIME_WHITELIST: ReadonlySet<string> = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/bmp",
]);

/**
 * 图片魔数 → MIME。**只用真实字节判定，扩展名不参与**。
 *
 * WEBP 是唯一要两段校验的：RIFF 是通用容器标签（wav/avi/webp 都长这样），
 * 只比对前 4 字节会把 wav 误判成 webp，故再取 bytes[8..12) 确认容器是 `WEBP`。
 */
function sniffMime(buf: Buffer): string | null {
	// 嗅探窗口 = 12 字节（最长需求 = WEBP 的 RIFF + 4B size + WEBP）
	const head = buf.subarray(0, Math.min(buf.length, 12));
	const eq = (offset: number, sig: number[]): boolean =>
		head.length >= offset + sig.length && sig.every((b, i) => head[offset + i] === b);

	// PNG：89 50 4e 47 0d 0a 1a 0a（8 字节定长签名，最可靠）
	if (eq(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	// JPEG：ff d8 ff（SOI 段头）
	if (eq(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
	// GIF："GIF8"（"GIF87a"/"GIF89a" 共前缀，4 字节够区分）
	if (eq(0, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
	// BMP："BM"
	if (eq(0, [0x42, 0x4d])) return "image/bmp";
	// WEBP：RIFF（前 4 字节）+ WEBP（bytes[8..12)），两段都对才算
	if (eq(0, [0x52, 0x49, 0x46, 0x46]) && head.subarray(8, 12).toString("latin1") === "WEBP") {
		return "image/webp";
	}
	return null;
}

function errnoToError(e: unknown, target: string): ImageFileError {
	const code = (e as NodeJS.ErrnoException)?.code;
	if (code === "ENOENT") return new ImageFileError(400, `文件不存在：${target}`);
	if (code === "EACCES" || code === "EPERM") return new ImageFileError(403, `无权限读取文件：${target}`);
	return new ImageFileError(500, e instanceof Error ? e.message : String(e));
}

export function readImageFile(raw: string, fallbackCwd: string): ImageFileOk {
	const target = path.resolve(expandHome(raw.trim()) || fallbackCwd);

	let st: fs.Stats;
	try {
		st = fs.statSync(target);
	} catch (e) {
		throw errnoToError(e, target);
	}
	if (!st.isFile()) throw new ImageFileError(400, `不是文件：${target}`);

	// 限长判在**读之前**（st.size 不花钱）：超限直接 413，绝不把 GB 级文件读进内存
	if (st.size > IMAGE_FILE_MAX_BYTES) {
		throw new ImageFileError(413, `图片过大（${st.size} 字节），暂不支持预览`);
	}

	let bytes: Buffer;
	try {
		// 图片已限 8MB，一次读完是可接受的上界（不像读源码要把 256KB 定长切分）
		bytes = fs.readFileSync(target);
	} catch (e) {
		throw errnoToError(e, target);
	}

	const mimeType = sniffMime(bytes);
	// 白名单再兜一层：sniffMime 的产物本就来自 5 种常量，这里是纵深防御
	//（防将来改魔数表时漏加白名单——漏了即 415，不会写出值域外的 Content-Type）
	if (!mimeType || !MIME_WHITELIST.has(mimeType)) {
		throw new ImageFileError(415, `不是可预览的图片格式：${target}`);
	}

	return {
		ok: true,
		path: target,
		name: path.basename(target),
		size: st.size,
		mimeType,
		bytes,
	};
}