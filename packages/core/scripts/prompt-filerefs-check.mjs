/**
 * /prompt 的 @file 引用展开断言 —— `check:prompt-filerefs`（at-file 批次 P0，task-composer-at-file.md §4.2）。
 *
 * 纯函数级（不起 core、不调模型）：expandFileRefs 是 /prompt 在 runtime.prompt 之前的
 * 独立步骤，展开正确性在此锁死；HTTP 侧（fileRefs 缺省逐字节不变 / skippedFiles 透传）
 * 由 probe 与既有 core-smoke 覆盖。
 *
 * 覆盖：
 *   R1  文本文件 ⇒ `<file name="绝对路径">\n内容\n</file>\n`，promptText 前置、用户文本拼接在 server 层（此处只管块本身）；
 *   R2  BOM 剥离（CLI stripBom 同款）；
 *   R3  多 ref 保序拼接；
 *   R4  空文件 ⇒ skipped「空文件」；
 *   R5  不存在 ⇒ skipped「文件不存在」；目录 ⇒ skipped「不是文件」；~ 指向不存在 ⇒ skipped 不崩；
 *   R6  二进制（非图片魔数）⇒ skipped「二进制文件不支持引用」；
 *   R7  png / jpg / gif / webp 魔数 ⇒ images[] mimeType 正确、data 为 base64；
 *   R8  扩展名 .png 但内容是文本 ⇒ 魔数优先 ⇒ 走文本块（不误判图片）；
 *   R9  >8MB 图片 ⇒ skipped「图片超过 8MB」；
 *   R10 >256KB 文本 ⇒ 块内截断注明；
 *   R11 images / promptText / skipped 三通道互不串（图片引用不产文本块）。
 *
 * 用法（在 packages/core 下）：`npm run check:prompt-filerefs`
 * 依赖 Node 的 --experimental-strip-types（check:usage-branch 同款）以 import .ts。
 * 证据：`run/prompt-filerefs-evidence.json`；失败非 0 退出。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandFileRefs } from "../src/prompt-files.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const runDir = path.join(here, "..", "run");
fs.mkdirSync(runDir, { recursive: true });
const evidencePath = path.join(runDir, "prompt-filerefs-evidence.json");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-filerefs-"));

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

const writeBin = (rel, buf) => {
  const p = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
};

/* 夹具 */
const textPath = writeBin("src/note.txt", Buffer.from("你好，world\n第二行\n", "utf8"));
const bomPath = writeBin("src/bom.txt", Buffer.from(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("有 BOM 的内容")]), "utf8"));
const emptyPath = writeBin("empty.txt", Buffer.alloc(0));
const binPath = writeBin("data.bin", Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x0a]));
const fakePngPath = writeBin("fake.png", Buffer.from("这其实是文本", "utf8"));
const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0x00, 0x00, 0x00, 0x0d]), Buffer.from("IHDRDATA", "utf8")]);
const pngPath = writeBin("img.png", pngBytes);
const jpgPath = writeBin("img.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
const gifPath = writeBin("img.gif", Buffer.from("GIF89a", "utf8"));
const webpPath = writeBin("img.webp", Buffer.concat([Buffer.from("RIFF", "utf8"), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from("WEBPVP8 ", "utf8")]));
const bigImagePath = writeBin("big.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8 * 1024 * 1024 + 1)]));
const bigTextPath = writeBin("big.log", Buffer.concat([Buffer.from("行\n".repeat(1), "utf8"), Buffer.alloc(256 * 1024 + 10, 0x41)]));

const expand = (refs) => expandFileRefs(refs, tmpRoot);

/* ===== R1：文本块格式 ===== */
{
  const r = expand(["src/note.txt"]);
  const want = `<file name="${textPath}">\n你好，world\n第二行\n\n</file>\n`;
  check("R1 文本 ⇒ <file> 块（绝对路径名 + 原样内容）", r.promptText === want, { got: r.promptText, want });
}

/* ===== R2：BOM 剥离 ===== */
{
  const r = expand(["src/bom.txt"]);
  check("R2 BOM 剥离后进块", r.promptText === `<file name="${bomPath}">\n有 BOM 的内容\n</file>\n`, r.promptText);
}

/* ===== R3：多 ref 保序 ===== */
{
  const r = expand(["src/bom.txt", "src/note.txt"]);
  const first = r.promptText.indexOf(bomPath);
  const second = r.promptText.indexOf(textPath);
  check("R3 多 ref 按输入顺序拼接", first !== -1 && second !== -1 && first < second, { first, second });
}

/* ===== R4：空文件 ===== */
{
  const r = expand(["empty.txt"]);
  check("R4 空文件 ⇒ skipped「空文件」且无块", r.promptText === "" && r.skipped.length === 1 && r.skipped[0].includes("空文件"), r.skipped);
}

/* ===== R5：不存在 / ~ ===== */
/* （目录不再 skip——D6 起 @目录 是合法引用，走 R12 的 directory 块） */
{
  const r = expand(["no-such.txt", "~/no-such-at-home.txt"]);
  check(
    "R5 不存在/~ ⇒ 两条 skipped、不崩",
    r.promptText === "" &&
      r.skipped.some((s) => s.includes("文件不存在")) &&
      r.skipped.some((s) => s.startsWith("~/no-such-at-home.txt")),
    r.skipped,
  );
}

/* ===== R6：二进制 ===== */
{
  const r = expand(["data.bin"]);
  check("R6 二进制 ⇒ skipped「二进制文件不支持引用」", r.promptText === "" && r.skipped[0]?.includes("二进制"), r.skipped);
}

/* ===== R7：图片魔数 ⇒ images ===== */
{
  const r = expand(["img.png", "img.jpg", "img.gif", "img.webp"]);
  const mimes = r.images.map((i) => i.mimeType);
  check(
    "R7 四种魔数 ⇒ images mimeType 恰 [png, jpeg, gif, webp]",
    JSON.stringify(mimes) === JSON.stringify(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    mimes,
  );
  const decoded = Buffer.from(r.images[0].data, "base64");
  check("R7b data 是 base64 且解码还原 png 字节", decoded.equals(pngBytes), { len: decoded.length });
  check("R7c 图片引用不产文本块", r.promptText === "" && r.skipped.length === 0, { text: r.promptText, skipped: r.skipped });
}

/* ===== R8：扩展名误导（魔数优先） ===== */
{
  const r = expand(["fake.png"]);
  check("R8 .png 扩展名但文本内容 ⇒ 走文本块不误判图片", r.promptText.includes("这其实是文本") && r.images.length === 0, r.promptText);
}

/* ===== R9：>8MB 图片 ===== */
{
  const r = expand(["big.png"]);
  check("R9 >8MB 图片 ⇒ skipped「图片超过 8MB」", r.images.length === 0 && r.skipped[0]?.includes("8MB"), r.skipped);
}

/* ===== R10：>256KB 文本截断 ===== */
{
  const r = expand(["big.log"]);
  check("R10 >256KB 文本 ⇒ 块内截断注明", r.promptText.includes("仅注入前 256KB") && r.promptText.length < 300 * 1024, { len: r.promptText.length });
}

/* ===== R11：混合引用三通道 ===== */
{
  const r = expand(["img.png", "src/note.txt", "empty.txt", "data.bin"]);
  check(
    "R11 混合 ⇒ images 1 / 块 1 / skipped 2，互不串",
    r.images.length === 1 &&
      r.promptText.includes(textPath) &&
      r.skipped.length === 2,
    { images: r.images.length, skipped: r.skipped },
  );
}

/* ===== R12：目录引用 ⇒ type="directory" 一层清单（D6，2026-09-28 裁决） ===== */
{
  // 夹具：src/ 下已有 note.txt、bom.txt（文件）+ 无子目录；再造 src/sub/ 验证目录在前
  fs.mkdirSync(path.join(tmpRoot, "src", "sub"), { recursive: true });
  writeBin("src/zz.log", Buffer.from("x", "utf8"));
  const r = expand(["src"]);
  const wantHead = `<file name="${path.join(tmpRoot, "src")}" type="directory">\nsub/\nbom.txt\nnote.txt\nzz.log\n`;
  check(
    "R12 目录 ⇒ directory 块、目录带 / 拼前、文件在后、码元排序",
    r.promptText.startsWith(wantHead) && r.promptText.includes("（仅一层，共 4 项）"),
    { got: r.promptText.slice(0, 160), wantHead },
  );
}

/* ===== R13：空目录 ⇒ 共 0 项（不 skip） ===== */
{
  fs.mkdirSync(path.join(tmpRoot, "empty-dir"), { recursive: true });
  const r = expand(["empty-dir"]);
  check(
    "R13 空目录 ⇒ 空清单 + 共 0 项、无 skipped",
    r.promptText.includes("type=\"directory\"") && r.promptText.includes("（仅一层，共 0 项）") && r.skipped.length === 0,
    { got: r.promptText, skipped: r.skipped },
  );
}

/* ===== R14：不存在目录 ⇒ skipped（stat 阶段拦截） ===== */
{
  const r = expand(["no-such-dir/"]);
  check(
    "R14 不存在目录 ⇒ skipped「文件不存在」",
    r.promptText === "" && r.skipped[0]?.includes("文件不存在"),
    r.skipped,
  );
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

const evidence = { startedAt: new Date().toISOString(), checks };
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

const failed = checks.filter((c) => !c.pass).length;
if (failed > 0) {
  console.error(`\nprompt-filerefs 检查失败 ${failed} 项（证据：${evidencePath}）`);
  process.exit(1);
}
console.log(`prompt-filerefs 检查全部通过：${checks.length} 项（证据：${evidencePath}）`);
