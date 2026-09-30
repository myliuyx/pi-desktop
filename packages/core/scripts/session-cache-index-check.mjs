/**
 * 会话索引层单测（listSessionsCached）。
 * 运行：npm run check:session-cache-index
 *
 * 覆盖：首拉全 miss → 落盘 → 重启后全 hit；改一个文件只重扫它；删文件索引收敛；
 * 坏索引静默冷重建；all 两种档位；索引文件权限 0600；并发两拉共享一次扫描。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSessionsCached, indexFilePath, resetIndexCacheForTests, flushIndexSaveForTests } from "../src/session-list-cache.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "index-check-"));
const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

const CWD = "/proj/alpha";
const agentDir = path.join(tmpRoot, "agent");
const sessionsRoot = path.join(agentDir, "sessions");
const sessionDir = path.join(sessionsRoot, "--proj-alpha--"); // 形状 = <agentDir>/sessions/<encoded-cwd>
fs.mkdirSync(sessionDir, { recursive: true });

const header = (id, cwd, ts) => ({ type: "session", version: 3, id, cwd, timestamp: ts });
const msg = (role, text, ts) => ({ type: "message", id: `m-${ts}`, parentId: "x", timestamp: ts, message: { role, content: [{ type: "text", text }] } });
function writeSession(dir, name, id, cwd, firstText, laterIso) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, [header(id, cwd, "2026-09-30T09:00:00.000Z"), msg("user", firstText, "2026-09-30T09:00:01.000Z"), msg("assistant", "ok", laterIso)].map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}
const f1 = writeSession(sessionDir, "2026-09-30T09-00-00-000Z_s1.jsonl", "s1", CWD, "第一个会话", "2026-09-30T09:00:05.000Z");
const f2 = writeSession(sessionDir, "2026-09-30T09-10-00-000Z_s2.jsonl", "s2", CWD, "第二个会话", "2026-09-30T09:10:05.000Z");

const ref = { cwd: CWD, sessionDir };
const ids = (r) => r.entries.map((e) => e.info.id).sort();

/* ---------- A. 首拉：全 miss + 排序 + 落盘 ---------- */
resetIndexCacheForTests();
const r1 = await listSessionsCached(ref);
check("A1 首拉 2 条", r1.entries.length === 2, r1.entries.length);
check("A2 首拉全 miss、无落盘", r1.stats.misses === 2 && r1.stats.hits === 0 && r1.stats.fromDisk === false, r1.stats);
check("A3 按 modified 降序", r1.entries[0].info.id === "s2", ids(r1));
check("A4 元数据字段正确", r1.entries.find((e) => e.info.id === "s1").info.messageCount === 2, r1.entries);
flushIndexSaveForTests(sessionDir); // 跳过写盘 debounce，才能断言落盘
check("A5 索引文件已落盘", fs.existsSync(indexFilePath(sessionDir)), indexFilePath(sessionDir));
check("A6 索引文件权限 0600", (fs.statSync(indexFilePath(sessionDir)).mode & 0o777) === 0o600, (fs.statSync(indexFilePath(sessionDir)).mode & 0o777).toString(8));

/* ---------- B. 重启（清内存）：全 hit ---------- */
resetIndexCacheForTests();
const r2 = await listSessionsCached(ref);
check("B1 重启后全 hit、fromDisk=true", r2.stats.hits === 2 && r2.stats.misses === 0 && r2.stats.fromDisk === true, r2.stats);
check("B2 结果与首拉一致", JSON.stringify(r2.entries) === JSON.stringify(r1.entries), ids(r2));

/* ---------- C. 改一个文件：只重扫它 ---------- */
fs.appendFileSync(f1, JSON.stringify(msg("user", "追加", "2026-09-30T09:30:00.000Z")) + "\n");
const r3 = await listSessionsCached(ref);
check("C1 只有改动的文件被重扫", r3.stats.misses === 1 && r3.stats.hits === 1, r3.stats);
check("C2 改动会话的 messageCount 更新", r3.entries.find((e) => e.info.id === "s1").info.messageCount === 3, r3.entries);

/* ---------- D. 删一个文件：索引收敛 ---------- */
fs.rmSync(f2);
const r4 = await listSessionsCached(ref);
check("D1 删除的文件不再出现", r4.entries.length === 1 && r4.entries[0].info.id === "s1", ids(r4));

/* ---------- E. 坏索引：静默冷重建 ---------- */
fs.writeFileSync(indexFilePath(sessionDir), "{ this is not json");
resetIndexCacheForTests();
const r5 = await listSessionsCached(ref);
check("E1 坏索引不抛错、冷重建成功", r5.entries.length === 1 && r5.stats.hits === 0, r5.stats);

/* ---------- F. all 两档 ---------- */
const otherDir = path.join(sessionsRoot, "--proj-beta--");
fs.mkdirSync(otherDir, { recursive: true });
writeSession(otherDir, "z.jsonl", "sz", "/proj/beta", "beta", "2026-09-30T08:00:05.000Z");
resetIndexCacheForTests();
const rCur = await listSessionsCached(ref, { all: false });
const rAll = await listSessionsCached(ref, { all: true });
check("F1 默认档只含当前 cwd", rCur.entries.every((e) => e.info.id === "s1"), ids(rCur));
check("F2 all=1 含其它 cwd", rAll.entries.some((e) => e.info.id === "sz"), ids(rAll));

/* ---------- G. 并发去重：同一 ref 并发共享一次扫描 ---------- */
resetIndexCacheForTests();
const [g1, g2] = await Promise.all([listSessionsCached(ref), listSessionsCached(ref)]);
check("G1 并发两拉共享一次扫描（misses 相同且等于文件数）", g1.stats.misses === g2.stats.misses && g1.stats.misses === g1.stats.files, { g1: g1.stats, g2: g2.stats });

fs.rmSync(tmpRoot, { recursive: true, force: true });
const failed = checks.filter((c) => !c.pass);
console.log(`\n  ${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);