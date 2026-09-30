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

fs.rmSync(tmpRoot, { recursive: true, force: true });
const failed = checks.filter((c) => !c.pass);
console.log(`\n  ${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);