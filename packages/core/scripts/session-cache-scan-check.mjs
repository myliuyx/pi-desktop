/**
 * 轻量会话扫描单测（scanSessionFileLight / readFirstUserText）。
 * 运行：npm run check:session-cache-scan
 *
 * 为什么要单测这一层：它是整个索引的「真值来源」—— 一旦数错 message 或读错 name，
 * 侧栏会静默显示错数字（假事实），而端点测试只证明「接口通了」。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSessionFileLight, readFirstUserText } from "../src/session-list-cache.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scan-check-"));
const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

function fixture(name, lines) {
  const f = path.join(tmpRoot, name);
  fs.writeFileSync(f, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return f;
}
const header = (id, cwd, ts) => ({ type: "session", version: 3, id, cwd, timestamp: ts });
const msg = (role, text, ts) => ({
  type: "message",
  id: `m-${ts}`,
  parentId: "x",
  timestamp: ts,
  message: { role, content: [{ type: "text", text }] },
});
const info = (n) => ({ type: "session_info", id: "i1", parentId: "x", timestamp: "2026-09-30T10:00:00.000Z", name: n });

/* ---------- A. 基本字段 ---------- */
const fA = fixture("a.jsonl", [
  header("id-A", "/proj/a", "2026-09-30T09:00:00.000Z"),
  msg("user", "帮我看看这个项目", "2026-09-30T09:00:01.000Z"),
  { type: "message", id: "m2", parentId: "m1", timestamp: "2026-09-30T09:00:02.000Z", message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: '输出——含 role":"user 的诱饵字符串' }] } },
  msg("assistant", "好的", "2026-09-30T09:00:03.000Z"),
  msg("user", "再来", "2026-09-30T09:00:09.000Z"),
]);
const rA = scanSessionFileLight(fA);
check("A1 id/cwd/created 取自 header", rA?.id === "id-A" && rA?.cwd === "/proj/a" && rA?.created === "2026-09-30T09:00:00.000Z", rA);
check("A2 messageCount 只数 type=message（含 toolResult）", rA?.messageCount === 4, rA?.messageCount);
check("A3 modified = 最后一条 message 的 timestamp", rA?.modified === Date.parse("2026-09-30T09:00:09.000Z"), rA?.modified);
check("A4 hasFirstUser 真（诱饵字符串不得误判）", rA?.hasFirstUser === true, rA);
check("A5 name 缺省为 null", rA?.name === null, rA?.name);

/* ---------- B. name 后写覆盖前写 ---------- */
const fB = fixture("b.jsonl", [header("id-B", "/proj/b", "2026-09-30T09:00:00.000Z"), info("旧名"), msg("user", "q", "2026-09-30T09:00:01.000Z"), info("新名")]);
check("B1 后写的 session_info.name 覆盖前写", scanSessionFileLight(fB)?.name === "新名", scanSessionFileLight(fB)?.name);

/* ---------- C. 显式清空 name ---------- */
const fC = fixture("c.jsonl", [header("id-C", "/proj/c", "2026-09-30T09:00:00.000Z"), info("有名字"), info("")]);
check("C1 显式空 name → null（与 Pi 语义一致）", scanSessionFileLight(fC)?.name === null, scanSessionFileLight(fC)?.name);

/* ---------- D. 无 header / 空文件 ---------- */
const fD = fixture("d.jsonl", [{ type: "message", id: "x", timestamp: "2026-09-30T09:00:00.000Z", message: { role: "user", content: [] } }]);
check("D1 无 header 的文件返回 null", scanSessionFileLight(fD) === null, scanSessionFileLight(fD));
const fE = path.join(tmpRoot, "e.jsonl");
fs.writeFileSync(fE, "");
check("D2 空文件返回 null", scanSessionFileLight(fE) === null, scanSessionFileLight(fE));

/* ---------- E. 跨块边界（>1MB 的单行，验证 carry 拼接） ---------- */
const big = "x".repeat(1_200_000);
const fF = fixture("f.jsonl", [
  header("id-F", "/proj/f", "2026-09-30T09:00:00.000Z"),
  { type: "message", id: "m1", parentId: "x", timestamp: "2026-09-30T09:00:01.000Z", message: { role: "user", content: [{ type: "text", text: big }] } },
  msg("assistant", "ok", "2026-09-30T09:00:02.000Z"),
]);
const rF = scanSessionFileLight(fF);
check("E1 跨 1MB 块边界的行被正确拼接", rF?.messageCount === 2 && rF?.modified === Date.parse("2026-09-30T09:00:02.000Z"), rF);

/* ---------- F. readFirstUserText ---------- */
check("F1 取首条 user 文本", readFirstUserText(fA) === "帮我看看这个项目", readFirstUserText(fA));
check("F2 无 user 消息 → null", readFirstUserText(fC) === null, readFirstUserText(fC));

/* ---------- G. 性能护栏 ---------- */
const t0 = performance.now();
scanSessionFileLight(fF);
const dt = performance.now() - t0;
check("G1 1.2MB 文件扫描 < 50ms", dt < 50, `${dt.toFixed(1)}ms`);

/* ---------- A6/A7. 诱饵免疫（Finding 2）：非 user 消息的嵌套 payload 含字面 "role":"user" ---------- */
const decoy = { type: "message", id: "m1", parentId: "x", timestamp: "2026-09-30T09:00:01.000Z", message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "普通输出" }], details: { role: "user" } } };
check("A6 诱饵行确实含字面 \"role\":\"user\"（保证测试有效性）", JSON.stringify(decoy).includes('"role":"user"'), JSON.stringify(decoy).slice(0, 200));
const fDecoy = fixture("decoy.jsonl", [header("id-decoy", "/proj/decoy", "2026-09-30T09:00:00.000Z"), decoy]);
const rDecoy = scanSessionFileLight(fDecoy);
check("A7 非 user 消息的嵌套 role=user 不误判 hasFirstUser", rDecoy?.hasFirstUser === false, rDecoy);

/* ---------- H. EOF 无尾换行（Finding 1） ---------- */
const fH = path.join(tmpRoot, "h.jsonl");
fs.writeFileSync(
  fH,
  [JSON.stringify(header("id-H", "/proj/h", "2026-09-30T09:00:00.000Z")), JSON.stringify(msg("user", "hi", "2026-09-30T09:00:05.000Z"))].join("\n"),
); // 故意不加尾换行
const rH = scanSessionFileLight(fH);
check("H1 末行无换行仍计入 messageCount", rH?.messageCount === 1, rH);
check("H2 末行无换行仍取到 modified", rH?.modified === Date.parse("2026-09-30T09:00:05.000Z"), rH?.modified);
const fH2 = path.join(tmpRoot, "h2.jsonl");
fs.writeFileSync(fH2, JSON.stringify(header("id-H2", "/proj/h2", "2026-09-30T09:00:00.000Z"))); // 仅一行 header，无换行
const rH2 = scanSessionFileLight(fH2);
check("H3 仅一行无换行 header 仍被识别", rH2?.id === "id-H2" && rH2?.created === "2026-09-30T09:00:00.000Z", rH2);
check("H4 readFirstUserText 末行无换行仍取到文本", readFirstUserText(fH) === "hi", readFirstUserText(fH));

/* ---------- I. 跨块边界的多字节字符（Finding 3） ---------- */
const BLOCK = 1 << 20;
const straddle = (startPrefix, filler, char, endSuffix, filePrefixBytes = 0) => {
  const budget = BLOCK - 1 - filePrefixBytes - Buffer.byteLength(startPrefix);
  const padding = filler.repeat(budget);
  return { line: startPrefix + padding + char + endSuffix, expected: padding + char };
};
// I1: readFirstUserText —— 3 字节汉字「中」首字节落在块边界前 1 字节
const u = straddle(
  '{"type":"message","id":"m1","parentId":"x","timestamp":"2026-09-30T09:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"',
  "A",
  "中",
  '"}]}}',
);
const fI = path.join(tmpRoot, "i.jsonl");
fs.writeFileSync(fI, u.line + "\n");
const gotI = readFirstUserText(fI);
check("I1 跨 1MB 边界的 3 字节汉字未被解码损坏", gotI === u.expected, gotI ? `len=${gotI.length} tail=${[...gotI.slice(-4)]}` : gotI);
// I2: scanSessionFileLight —— session_info.name 里的汉字跨边界
const headerJ = JSON.stringify(header("id-J", "/proj/j", "2026-09-30T09:00:00.000Z"));
const j = straddle(
  '{"type":"session_info","id":"i1","parentId":"x","timestamp":"2026-09-30T10:00:00.000Z","name":"',
  "B",
  "中",
  '"}',
  Buffer.byteLength(headerJ) + 1,
);
const fJ = path.join(tmpRoot, "j.jsonl");
fs.writeFileSync(fJ, headerJ + "\n" + j.line + "\n");
const rJ = scanSessionFileLight(fJ);
check("I2 跨 1MB 边界的 session_info.name 未被损坏", rJ?.name === j.expected, rJ?.name ? `len=${rJ.name.length} tail=${[...rJ.name.slice(-4)]}` : rJ?.name);

/* ---------- J. 键序变体（`type` 不在行首）---------- */
// Pi 实际写入是 `{"type":…` 打头；但合法 SessionEntry 的键序可能不同（本仓
// sessions-manage-check 的手写夹具就是 `{"id":…,"type":"message",…}`）。
// 判据必须键序无关，否则 messageCount=0 / name 丢失 / header 读不到 ⇒ 清单显错值。
const headerVariant = (id, cwd, ts) => ({ id, cwd, type: "session", version: 3, timestamp: ts });
const msgVariant = (role, text, ts) => ({
  id: `m-${ts}`, parentId: "x", timestamp: ts, type: "message",
  message: { role, content: [{ type: "text", text }] },
});
const infoVariant = (n) => ({ name: n, type: "session_info", id: "i1", parentId: "x", timestamp: "2026-09-30T10:00:00.000Z" });

const fK = fixture("k.jsonl", [
  headerVariant("id-K", "/proj/k", "2026-09-30T09:00:00.000Z"),
  msgVariant("user", "键序变体的首问", "2026-09-30T09:00:01.000Z"),
  msgVariant("assistant", "收到", "2026-09-30T09:00:02.000Z"),
  infoVariant("键序变体的名字"),
]);
const rK = scanSessionFileLight(fK);
check("J1 键序变体 header 仍读出 id/cwd（不返回 null）", rK?.id === "id-K" && rK?.cwd === "/proj/k", rK);
check("J2 键序变体 message 计入 messageCount", rK?.messageCount === 2, rK?.messageCount);
check("J3 键序变体 message 取到 modified（末条 timestamp）", rK?.modified === Date.parse("2026-09-30T09:00:02.000Z"), rK?.modified);
check("J4 键序变体 message 的 hasFirstUser 正确", rK?.hasFirstUser === true, rK);
check("J5 键序变体 session_info.name 被采纳", rK?.name === "键序变体的名字", rK?.name);
check("J6 readFirstUserText 对键序变体 message 取到首条 user 文本", readFirstUserText(fK) === "键序变体的首问", readFirstUserText(fK));

// 键序变体 + 诱饵：toolResult 的 details 里含字面 `"role":"user"`，不得误判
const decoyVariant = {
  id: "m1", parentId: "x", timestamp: "2026-09-30T09:00:01.000Z", type: "message",
  message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "普通输出" }], details: { role: "user" } },
};
const fKL = fixture("kl.jsonl", [headerVariant("id-KL", "/proj/kl", "2026-09-30T09:00:00.000Z"), decoyVariant]);
const rKL = scanSessionFileLight(fKL);
check("J7 键序变体诱饵：嵌套 role=user 不误判 hasFirstUser", rKL?.hasFirstUser === false && rKL?.messageCount === 1, rKL);
check("J8 键序变体诱饵：readFirstUserText 不返回诱饵文本", readFirstUserText(fKL) === null, readFirstUserText(fKL));

/* ---------- K. modified 严格对齐 Pi getMessageActivityTime ---------- */
// Pi 语义（dist/core/session-manager.js）：仅 role=user/assistant 且 "content" in message；
// 优先 message.timestamp（数字），否则顶层 entry.timestamp（ISO）；toolResult/system/toolCall 不抬高。
const msgWithMsgTs = (role, text, entryIso, msgTs, contentExtra) => ({
  type: "message",
  id: `m-${entryIso}`,
  parentId: "x",
  timestamp: entryIso,
  message: { role, content: contentExtra ?? [{ type: "text", text }], timestamp: msgTs },
});
const fMix = fixture("mix.jsonl", [
  header("id-MIX", "/proj/mix", "2026-09-30T09:00:00.000Z"),
  msgWithMsgTs("user", "问", "2026-09-30T10:00:00.000Z", 1000),
  msgWithMsgTs("assistant", "答", "2026-09-30T10:00:05.000Z", 2000),
  // toolResult 的 message.timestamp 远大于任何 user/assistant —— 绝不抬 modified
  msgWithMsgTs("toolResult", "", "2026-09-30T10:00:06.000Z", 9_999_999, [{ type: "text", text: "输出" }]),
  // system 同样不抬
  msgWithMsgTs("system", "", "2026-09-30T10:00:07.000Z", 9_999_998, ""),
  // assistant 内含 toolCall 块（toolCall 不是 entry role，不应影响 role 判定）
  msgWithMsgTs("assistant", "", "2026-09-30T10:00:08.000Z", 3000, [
    { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "echo hi" } },
  ]),
  // 末条 user 的 entry.timestamp 远晚于 message.timestamp —— 必须取 message.timestamp
  msgWithMsgTs("user", "末问", "2026-09-30T20:00:00.000Z", 4000),
]);
const rMix = scanSessionFileLight(fMix);
check("K1 modified 取 user/assistant 的 message.timestamp 最大值（=4000）", rMix?.modified === 4000, rMix?.modified);
check("K2 messageCount 仍计全部 type=message（含 toolResult/system）", rMix?.messageCount === 6, rMix?.messageCount);

// 末条 message 系统/toolResult 不抬高 modified：退化到上一条 user/assistant 的 entry.timestamp
const fTailTool = fixture("tail-tool.jsonl", [
  header("id-TAIL", "/proj/tail", "2026-09-30T09:00:00.000Z"),
  msg("user", "唯一 user", "2026-09-30T09:00:01.000Z"),
  { type: "message", id: "m2", parentId: "x", timestamp: "2026-09-30T09:00:09.000Z", message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "很晚的输出" }] } },
]);
const rTail = scanSessionFileLight(fTailTool);
check("K3 末条 toolResult 不抬高 modified（退化到 user entry.timestamp）", rTail?.modified === Date.parse("2026-09-30T09:00:01.000Z"), rTail?.modified);

// message.timestamp 缺失时退化 entry.timestamp（Pi 同款）
const fNoMsgTs = fixture("no-msg-ts.jsonl", [
  header("id-NOMSGTS", "/proj/nomsgts", "2026-09-30T09:00:00.000Z"),
  msg("user", "q", "2026-09-30T09:00:01.000Z"),
  msg("assistant", "a", "2026-09-30T09:00:05.000Z"),
]);
check("K4 message.timestamp 缺失时退化 entry.timestamp", scanSessionFileLight(fNoMsgTs)?.modified === Date.parse("2026-09-30T09:00:05.000Z"), scanSessionFileLight(fNoMsgTs)?.modified);

// 诱饵：toolResult 内容里含字面 "role":"assistant" 与数字 timestamp，不得抬 modified（快路径两头都不得误判）
const decoyAssistant = {
  type: "message",
  id: "m-decoy",
  parentId: "x",
  timestamp: "2026-09-30T09:00:02.000Z",
  message: {
    role: "toolResult",
    toolCallId: "t1",
    content: [{ type: "text", text: 'decoy {"role":"assistant","timestamp":9999999}' }],
    timestamp: 9_999_997,
  },
};
const fDecoyA = fixture("decoy-assistant.jsonl", [
  header("id-DEC", "/proj/dec", "2026-09-30T09:00:00.000Z"),
  msgWithMsgTs("user", "q", "2026-09-30T09:00:01.000Z", 1234),
  decoyAssistant,
]);
check("K5 toolResult 内容里的 assistant 诱饵不抬 modified", scanSessionFileLight(fDecoyA)?.modified === 1234, scanSessionFileLight(fDecoyA)?.modified);

/* ---------- L. readFirstUserText 抗 TOCTOU（Finding 2）---------- */
const fToc = fixture("tocu.jsonl", [header("id-TOC", "/proj/toc", "2026-09-30T09:00:00.000Z"), msg("user", "toctou 文本", "2026-09-30T09:00:01.000Z")]);
check("L1 readFirstUserText 正常读到文本", readFirstUserText(fToc) === "toctou 文本", readFirstUserText(fToc));
fs.rmSync(fToc);
let tocThrew = false;
let tocResult;
try {
  tocResult = readFirstUserText(fToc);
} catch {
  tocThrew = true;
}
check("L2 scan 之后文件消失：readFirstUserText 返回 null 而非抛异常", tocThrew === false && tocResult === null, { tocThrew, tocResult });

fs.rmSync(tmpRoot, { recursive: true, force: true });
const failed = checks.filter((c) => !c.pass);
console.log(`\n  ${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);