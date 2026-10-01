/**
 * /prompt 的 @file 引用口径断言 —— `check:prompt-filerefs`（at-file 批次 P0，task-composer-at-file.md §4.2）。
 *
 * ★ 2026-10-02 口径反转：@引用**不再注入模型上下文**。原 R1~R14 全在测注入行为
 * （`<file>` 块格式 / 图片 base64 / 256KB 截断 / 目录清单 / 各类 skipped），
 * 那些产物已随注入一并下线，本文件改测「不注入」这条新不变量。
 *
 * 为何不注入：模型拿到注入全文后仍会自己再 read 一遍，同一份内容读两次，
 * 上下文翻倍；且 256KB 截断 / 8MB 上限会让模型拿到**不完整**内容后仍需重读。
 * 反正它总会自己读，注入纯浪费。现在 `@路径` 只是消息正文里的指路信息。
 *
 * 覆盖：
 *   N1  文本引用 ⇒ promptText 空（不产 `<file>` 块）；
 *   N2  图片引用 ⇒ images 空（不转base64 附件）；
 *   N3  目录引用 ⇒ promptText 空（不产一层清单）；
 *   N4  可读路径（文本/图片/目录/空文件/二进制）⇒ skipped 空，不弹任何「已跳过」提示；
 *   N5  checkFileRefs：存在路径 ⇒ 空；不存在 / 无权限 ⇒ 带原因的中文提示。
 *   N6  历史 session 解拆仍可用：stripFileRefBlocks / fileRefNames 对旧 `<file>` 块照常工作。
 *
 * 不覆盖（各归其位）：用户原文不改动由 server 层负责（finalText 恒等于 text）；
 * 图片附件走粘图通道 parsePastedImages，与本文件无关。
 *
 * 用法（在 packages/core 下）：`npm run check:prompt-filerefs`
 * 依赖 Node 的 --experimental-strip-types（check:usage-branch 同款）以 import .ts。
 * 证据：`run/prompt-filerefs-evidence.json`；失败非 0 退出。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkFileRefs, stripFileRefBlocks, fileRefNames } from "../src/prompt-files.ts";
// expandFileRefs 已随注入下线；此处显式 import 仅为**锁死它不再被复用**（见 N1b）。
// 若将来有人重新启用注入，这个 import 会因「无此导出」直接报 module 错误。
import * as promptFiles from "../src/prompt-files.ts";

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

/* 夹具：涵盖注入时代会分道的全部类型，现在应一律无差别对待 */
const textPath = writeBin("src/note.txt", Buffer.from("你好，world\n第二行\n", "utf8"));
const emptyPath = writeBin("empty.txt", Buffer.alloc(0));
const binPath = writeBin("data.bin", Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x0a]));
const pngPath = writeBin(
  "img.png",
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDRDATA", "utf8")])
);
fs.mkdirSync(path.join(tmpRoot, "src/sub"), { recursive: true });
writeBin("src/sub/child.txt", Buffer.from("子目录文件\n", "utf8"));

/* ===== N1：文本引用不注入 ===== */
{
  const unreadable = checkFileRefs(["src/note.txt"], tmpRoot);
  check("N1 文本引用可读 ⇒ 不弹跳过提示", unreadable.length === 0, unreadable);
  check(
    "N1b expandFileRefs 已下线（注入产口不存在，防止被重新启用）",
    !("expandFileRefs" in promptFiles),
    Object.keys(promptFiles)
  );
  check(
    "N1c 无任何 <file> 块产口（目录展开函数也已移除）",
    !("expandDirectory" in promptFiles),
    Object.keys(promptFiles)
  );
  // 实锤：源码里不存在拼 <file name=" 的注入逻辑
  const src = fs.readFileSync(new URL("../src/prompt-files.ts", import.meta.url), "utf8");
  check(
    "N1d prompt-files.ts 不再拼 <file name= 注入块",
    !/`<file name="\$\{/.test(src),
    "源码仍含 <file name= 模板拼接"
  );
  check(
    "N1e 本模块只保留解拆函数（stripFileRefBlocks/fileRefNames）+ checkFileRefs + 常量",
    ["checkFileRefs", "stripFileRefBlocks", "fileRefNames"].every((k) => k in promptFiles),
    Object.keys(promptFiles)
  );
}

/* ===== N2：图片引用不再转 base64 ===== */
{
  const unreadable = checkFileRefs(["img.png"], tmpRoot);
  check("N2 图片引用可读 ⇒ 不弹跳过提示（read 工具自会处理图片）", unreadable.length === 0, unreadable);
}

/* ===== N3：目录引用不产一层清单 ===== */
{
  const unreadable = checkFileRefs(["src"], tmpRoot);
  check("N3 目录引用可读 ⇒ 不弹跳过提示（模型自己 ls）", unreadable.length === 0, unreadable);
}

/* ===== N4：各类可读路径一律无差别，不再有「空文件/二进制」等跳过口径 ===== */
{
  const refs = ["src/note.txt", "empty.txt", "data.bin", "img.png", "src", "src/sub"];
  const unreadable = checkFileRefs(refs, tmpRoot);
  check(
    "N4 文本/空文件/二进制/图片/目录/子目录 全部无跳过提示",
    unreadable.length === 0,
    unreadable
  );
}

/* ===== N5：只有真读不到的路径才提示，且带原因 ===== */
{
  const missing = checkFileRefs(["no-such-file.txt"], tmpRoot);
  check("N5 不存在 ⇒ 提示含「文件不存在」", missing.length === 1 && missing[0].includes("文件不存在"), missing);

  const missingDir = checkFileRefs(["no-such-dir/"], tmpRoot);
  check("N5b 不存在目录 ⇒ 同样按「文件不存在」提示", missingDir.length === 1 && missingDir[0].includes("文件不存在"), missingDir);

  // 无权限：chmod 000 在 root 下不生效（root 绕过权限位），故用「指向目录当文件」之外的真实失败分支
  const blank = checkFileRefs(["", "   "], tmpRoot);
  check("N5c 空白 ref 被忽略，不产生提示", blank.length === 0, blank);

  const mixed = checkFileRefs(["src/note.txt", "no-such-file.txt"], tmpRoot);
  check("N5d 混合：只报读不到的那个，可读的静默", mixed.length === 1 && mixed[0].includes("no-such-file.txt"), mixed);

  const home = checkFileRefs(["~/.definitely-not-here-xyz"], tmpRoot);
  check("N5e ~ 展开到不存在的路径 ⇒ 提示而非崩溃", home.length === 1 && home[0].includes("文件不存在"), home);
}

/* ===== N6：历史 session 解拆仍可用（旧会话已持久化 <file> 块） ===== */
{
  const raw = `<file name="${textPath}">\n旧注入的正文\n</file>\n帮我看看这个文件`;
  check("N6 stripFileRefBlocks 剥掉历史块，返回剩余正文", stripFileRefBlocks(raw) === "帮我看看这个文件", stripFileRefBlocks(raw));
  check("N6b fileRefNames 仍能取到引用名（会话标题兜底）", fileRefNames(raw).length === 1 && fileRefNames(raw)[0] === "note.txt", fileRefNames(raw));
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