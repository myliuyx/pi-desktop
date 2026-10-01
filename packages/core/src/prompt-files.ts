/**
 * @file 引用的处理（at-file 批次，task-composer-at-file.md §4.2）。
 *
 * ★ 2026-10-02 用户裁决：**@引用不再注入模型上下文**。
 *
 * 原实现把 @引用展开成 `<file name="绝对路径">内容</file>` 前置块（或把图片转 base64
 * 附件）拼进用户正文—— 实测问题：模型拿到全文后仍会**再调 read/ls 重读同一份内容**，
 * 一次交互把同一文件读两遍，上下文翻倍膨胀，且 256KB 截断 / 8MB 上限这些护栏反而
 * 让模型拿到**不完整**的内容后仍需重读。既然模型无论如何都会自己去读，注入就是纯浪费。
 *
 * 现在的口径：`@路径` 只作为**指路信息**留在消息文本里（`@test 帮我看下…`），
 * 模型自行调用 read / ls 取内容。read 工具本就支持图片（pi coding-agent
 * `core/tools/read.ts`：jpg/png/gif/webp/bmp → processImage → 结构化附件），
 * 且比原注入**多一层 autoResize 与「模型不支持图片」降级处理**，故图片能力不降反升。
 *
 * 保留的部分（各有其职，不属于注入）：
 * - `IMAGE_MAX_BYTES`：被server.ts 的粘图通道复用作传输层上限；
 * - `stripFileRefBlocks` / `fileRefNames`：**历史 session 解拆**——旧会话已把
 *   `<file>` 块持久化进 session 正文，不拆则侧栏标题漏出机器形态、侧栏预览折叠失效。
 *
 * @弹层补全、skippedFiles 通知语义均在 UI 侧，本文件不再产出 skipped。
 */

import fs from "node:fs";
import path from "node:path";
import { expandHome } from "./fs-list.ts";

/** 与上游 `@earendil-works/pi-ai` 的 ImageContent 同形（结构化兼容，可直接传 PromptOptions.images） */
export interface PromptImage {
	type: "image";
	/** base64 编码的图片数据 */
	data: string;
	mimeType: string;
}

/**
 * @file 引用的展开结果 —— 自 2026-10-02 起恒为空壳。
 *
 * 三个字段全部保留是为了**不破坏 server.ts 的既有调用形状**（解构取值照旧成立），
 * 新增字段一律返回空值/空数组：注入内容不产出，被跳过的引用也不再有。
 */
export interface ExpandedFileRefs {
	/** 恒为""：不再拼任何 `<file>` 前置块 */
	promptText: string;
	/** 恒为 []：不再把 @引用的图片转 base64 附件 */
	images: PromptImage[];
	/** 恒为 []：不再有「读不到/二进制/超限」的跳过口径（详见文件头） */
	skipped: string[];
}

/** 图片附件的原始字节上限（base64 后 ≈10.7MB）。
 *  ⚠️ 现仅用于 server.ts 的粘图通道传输层校验；UI 侧 lib/image-attach.ts 的同名常量
 *  与此同口径，改一处必须同步另一处。 */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 校验 @引用是否存在且可读，**仅用于给 UI 提示**，不产出任何注入内容。
 *
 * 为什么还要 stat：用户 @ 了一个不存在的路径，模型会自己 read 然后拿到「文件不存在」
 * 的报错来回问用户——多一轮往返。提前告知「这个路径当前读不到」体验更好。
 * 目录/大文件/二进制等一律**不拦**（模型自己有工具判断，且 read 支持图片）。
 */
export function checkFileRefs(refs: string[], cwd: string): string[] {
	const unreadable: string[] = [];
	for (const rawRef of refs) {
		const ref = rawRef.trim();
		if (!ref) continue;
		const target = path.resolve(cwd, expandHome(ref));
		try {
			fs.statSync(target);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException)?.code;
			unreadable.push(
				`${ref}（${code === "ENOENT" ? "文件不存在" : code === "EACCES" || code === "EPERM" ? "无权限" : "读取失败"}）`,
			);
		}
	}
	return unreadable;
}

/* ---------------------------------------------------------------------------
 * <file> 块的展示层拆解（历史会话解拆 + 会话标题兜底）
 *
 * ★ 自 2026-10-02 起本文件不再**产出** `<file>` 块（见文件头），但这两个函数
 * 必须留着：**旧 session 已把块持久化进正文**，不拆则 ① 会话标题以
 * `<file name="F:\…` 开头（侧栏/页头不可读）② 气泡与侧栏预览的折叠失效。
 *
 * 块的唯一产地曾是本文件，拆解与生产同源——格式若改动，两处必须同步。
 * ------------------------------------------------------------------------- */

/** 剥掉 @引用展开的 `<file …>…</file>` 块（含目录块），返回剩余正文（trim 过） */
export function stripFileRefBlocks(text: string): string {
	return text.replace(/<file\b[^>]*>[\s\S]*?<\/file>/g, "").trim();
}

/** 收集块引用的名字（basename 去重、按出现序）；纯引用无正文时的标题兜底素材 */
export function fileRefNames(text: string): string[] {
	const names: string[] = [];
	for (const m of text.matchAll(/<file\b[^>]*?\bname="([^"]*)"[^>]*>/g)) {
		// name 恒为绝对路径（win 反斜杠 / posix 斜杠都可能出现）；空段与裸盘符段（D:\ 没有 basename）滤掉
		const base = m[1]
			.split(/[\\/]/)
			.filter((seg) => seg && !/^[A-Za-z]:$/.test(seg))
			.pop();
		if (base && !names.includes(base)) names.push(base);
	}
	return names;
}
