/**
 * 会话标题兜底断言 —— `check:session-title`（2026-09-28 用户反馈修复）。
 *
 * 背景：首条消息是 @引用时，展开的 `<file name="F:\…">…</file>` 前置块直接进了
 * 会话标题（侧栏显示 `<file name="F:\DevelopWork\Wo…`）。修法在 core 出口处治理：
 * `toSessionSummary`（GET /sessions 清单）与 `titleOf`（/sessions/load）共用
 * `titleFallbackFromFirstMessage` —— 剥块取正文，纯引用无正文用引用名占位。
 *
 * 覆盖：
 *   T1  历史块形态（手写 `<file>` 前置块 + 正文）⇒ 标题 = 正文（解拆同源闭环）；
 *   T2  文件块 + 目录块混合 ⇒ 全剥；
 *   T3  纯引用单文件（win 反斜杠绝对路径）⇒ basename 占位；
 *   T4  纯引用多名 ⇒ 「首名 等 N 个引用」；
 *   T5  toSessionSummary：带块 firstMessage ⇒ 剥后正文；name 非空仍优先 name；
 *   T6  toSessionSummary：纯块 ⇒ 引用名占位；firstMessage 空 ⇒ 「(未命名会话)」；
 *   T7  普通消息（无块）原样返回 —— 修引用不能改坏普通首条消息的标题；
 *   T8  fileRefNames：posix 斜杠 / 去重 / 盘符根不产空名。
 *
 * 用法（在 packages/core 下）：`npm run check:session-title`（tsx 直跑 src，不起 core）。
 * 证据：`run/session-title-evidence.json`；失败非 0 退出。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileRefNames, stripFileRefBlocks } from "../src/prompt-files.ts";
import { titleFallbackFromFirstMessage, toSessionSummary } from "../src/sessions.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const runDir = path.join(here, "..", "run");
fs.mkdirSync(runDir, { recursive: true });
const evidencePath = path.join(runDir, "session-title-evidence.json");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-title-"));
fs.writeFileSync(path.join(tmpRoot, "note.txt"), "正文内容\n", "utf8");

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

const summaryOf = (first, name = "") =>
  toSessionSummary({ id: "s1", name, firstMessage: first, modified: "2026-09-28T10:00:00.000Z", messageCount: 3 });

/*
 * ★ 2026-10-02：@引用已停止注入（expandFileRefs 下线），但**旧 session 已把`<file>`
 * 块持久化进正文**，故本文件的场景全部存活（历史会话仍需正确拆解）。
 * 夹具改为**手写历史块字符串**（不再调产口）——格式即旧产口的真实产物：
 *   文本：<file name="绝对路径">\n{内容}\n</file>\n
 *   目录：<file name="绝对路径" type="directory">\n{清单}\n</file>\n
 */
const winPath = "F:\\DevelopWork\\pi-desktop\\packages\\core\\note.txt";
const posixPath = path.join(tmpRoot, "note.txt");
const fileBlock = (name, body) => `<file name="${name}">\n${body}\n</file>\n`;
const dirBlock = (name, body) => `<file name="${name}" type="directory">\n${body}\n</file>\n`;

/* ===== T1：历史块形态 ⇒ 剥块留正文（同源闭环） ===== */
{
  const raw = fileBlock(posixPath, "正文内容\n") + "@note.txt 帮我看看这个文件";
  check("T1 块前置 + 正文 ⇒ 标题 = 正文", titleFallbackFromFirstMessage(raw) === "@note.txt 帮我看看这个文件", {
    raw: raw.slice(0, 120),
    got: titleFallbackFromFirstMessage(raw),
  });
  check("T1b stripFileRefBlocks 直接口径一致", stripFileRefBlocks(raw) === "@note.txt 帮我看看这个文件", stripFileRefBlocks(raw));
}

/* ===== T2：文件块 + 目录块混合 ⇒ 全剥 ===== */
{
  const dir = path.join(tmpRoot, "sub");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "inner.txt"), "x", "utf8");
  const raw = fileBlock(posixPath, "正文内容\n") + dirBlock(dir, "inner.txt\n（仅一层，共 1 项）") + "看看这两个";
  check(
    "T2 文件块 + directory 块混合 ⇒ 全剥留正文",
    titleFallbackFromFirstMessage(raw) === "看看这两个" && raw.includes('type="directory"'),
    { got: titleFallbackFromFirstMessage(raw), rawHead: raw.slice(0, 80) },
  );
}

/* ===== T3：纯引用单文件 ⇒ basename 占位 ===== */
{
  const raw = `<file name="F:\\DevelopWork\\WorkBuddyWork\\Tiktok_auto\\.plan">\nREADME.md\n</file>\n`;
  check("T3 纯引用单文件（win 路径）⇒ basename 占位", titleFallbackFromFirstMessage(raw) === ".plan", titleFallbackFromFirstMessage(raw));
}

/* ===== T4：纯引用多名 ⇒ 「首名 等 N 个引用」 ===== */
{
  const raw =
    `<file name="C:\\repo\\a.md">\nx\n</file>\n` +
    `<file name="/home/u/repo/b.md">\ny\n</file>\n` +
    `<file name="C:\\repo\\a.md">\nz\n</file>\n`;
  check("T4 多名 ⇒ 首名 等 N 个引用（去重）", titleFallbackFromFirstMessage(raw) === "a.md 等 2 个引用", titleFallbackFromFirstMessage(raw));
}

/* ===== T5：toSessionSummary —— 带块 firstMessage / name 优先 ===== */
{
  const s = summaryOf(`<file name="F:\\x\\.plan">\n…\n</file>\n@.plan 看看都有哪些计划`);
  check("T5 带块 firstMessage ⇒ 标题 = 剥后正文", s.title === "@.plan 看看都有哪些计划", s.title);
  const named = summaryOf(`<file name="F:\\x\\.plan">\n…\n</file>\n`, "手起的名");
  check("T5b name 非空仍优先于 firstMessage", named.title === "手起的名", named.title);
}

/* ===== T6：toSessionSummary —— 纯块占位 / 空占位 ===== */
{
  const pure = summaryOf(`<file name="F:\\x\\报告.docx">\n…\n</file>\n`);
  check("T6 纯块无正文 ⇒ 引用名占位", pure.title === "报告.docx", pure.title);
  const empty = summaryOf("   ");
  check("T6b firstMessage 空 ⇒ (未命名会话)", empty.title === "(未命名会话)", empty.title);
}

/* ===== T7：普通消息原样（回归保护） ===== */
{
  const plain = "帮我看看当前这个项目。";
  check("T7 无块普通消息 ⇒ 原样返回", titleFallbackFromFirstMessage(plain) === plain, titleFallbackFromFirstMessage(plain));
  const indented = "  第一问  ";
  check("T7b trim 后返回", titleFallbackFromFirstMessage(indented) === "第一问", titleFallbackFromFirstMessage(indented));
}

/* ===== T8：fileRefNames 细节口径 ===== */
{
  const names = fileRefNames(
    `<file name="/home/u/repo/b.md">\ny\n</file>\n<file name="C:\\a.md">\nx\n</file>\n<file name="C:\\a.md">\nx\n</file>\n<file name="D:\\">\nroot\n</file>\n`,
  );
  check("T8 posix/win 混排、去重、盘符根滤空", JSON.stringify(names) === JSON.stringify(["b.md", "a.md"]), names);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

const evidence = { startedAt: new Date().toISOString(), checks };
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

const failed = checks.filter((c) => !c.pass).length;
if (failed > 0) {
  console.error(`\nsession-title 检查失败 ${failed} 项（证据：${evidencePath}）`);
  process.exit(1);
}
console.log(`session-title 检查全部通过：${checks.length} 项（证据：${evidencePath}）`);
