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
import { listSessionsCached, indexFilePath, resetIndexCacheForTests, flushIndexSaveForTests, INDEX_VERSION, scanSessionFileLight } from "../src/session-list-cache.ts";

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

/* ---------- E2. 索引版本不符：静默丢弃 + 全冷重建 ---------- */
// 先正常拉一次并落盘一份健康索引
resetIndexCacheForTests();
await listSessionsCached(ref);
flushIndexSaveForTests(sessionDir);
const idxPath = indexFilePath(sessionDir);
const idxDisk = JSON.parse(fs.readFileSync(idxPath, "utf8"));
check("E2a 前置：索引已落盘且版本 = 当前 INDEX_VERSION", fs.existsSync(idxPath) && idxDisk.version === INDEX_VERSION, idxDisk.version);
// 手工改成一个不兼容版本（模拟旧版索引），写回
idxDisk.version = INDEX_VERSION + 1;
fs.writeFileSync(idxPath, JSON.stringify(idxDisk));
resetIndexCacheForTests();
const rE2 = await listSessionsCached(ref);
check("E2 版本不符不抛错、全冷重建（hits=0）", rE2.stats.hits === 0 && rE2.stats.misses === rE2.stats.files, rE2.stats);
check("E2 冷重建后 entries 内容仍正确", rE2.entries.length === 1 && rE2.entries[0].info.id === "s1" && rE2.entries[0].info.messageCount === 3, ids(rE2));

/* ---------- F. all 两档 ---------- */
const otherDir = path.join(sessionsRoot, "--proj-beta--");
fs.mkdirSync(otherDir, { recursive: true });
writeSession(otherDir, "z.jsonl", "sz", "/proj/beta", "beta", "2026-09-30T08:00:05.000Z");
resetIndexCacheForTests();
const rCur = await listSessionsCached(ref, { all: false });
const rAll = await listSessionsCached(ref, { all: true });
check("F1 默认档只含当前 cwd", rCur.entries.length === 1 && rCur.entries.every((e) => e.info.id === "s1"), ids(rCur));
check("F2 all=1 含其它 cwd", rAll.entries.some((e) => e.info.id === "sz"), ids(rAll));

/* ---------- G. 并发去重：同一 ref 并发共享一次扫描 ---------- */
fs.rmSync(indexFilePath(sessionDir), { force: true }); // 使「全 miss」不依赖磁盘残留（消除墙钟时序 flaky）
resetIndexCacheForTests();
const [g1, g2] = await Promise.all([listSessionsCached(ref), listSessionsCached(ref)]);
check("G1 并发两拉共享一次扫描（misses 相同且等于文件数）", g1.stats.misses === g2.stats.misses && g1.stats.misses === g1.stats.files, { g1: g1.stats, g2: g2.stats });

/* ---------- H. subagent 子会话过滤 ---------- */
const gammaDir = path.join(sessionsRoot, "--proj-gamma--");
fs.mkdirSync(gammaDir, { recursive: true });
const GAMMA = "/proj/gamma";
const gammaHeader = (id, parent) => ({
  type: "session",
  version: 3,
  id,
  ...(parent ? { parentSession: parent } : {}),
  cwd: GAMMA,
  timestamp: "2026-09-30T09:00:00.000Z",
});
const subMeta = {
  type: "custom",
  customType: "pi-web:subagent",
  id: "c1",
  parentId: "x",
  timestamp: "2026-09-30T09:00:00.000Z",
  data: { version: 1, parentSessionId: "p", parentSessionPath: "/p.jsonl", profile: "general-purpose" },
};
const gammaMsg = (text, iso) => ({
  type: "message",
  id: "m1",
  parentId: "x",
  timestamp: iso,
  message: { role: "user", content: [{ type: "text", text }] },
});
const writeRaw = (name, entries) =>
  fs.writeFileSync(path.join(gammaDir, name), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

writeRaw("normal.jsonl", [gammaHeader("g-normal"), gammaMsg("普通会话", "2026-09-30T09:00:01.000Z")]);
writeRaw("fork.jsonl", [gammaHeader("g-fork", "/proj/gamma/parent.jsonl"), gammaMsg("fork 会话", "2026-09-30T09:00:02.000Z")]);
writeRaw("subagent.jsonl", [
  gammaHeader("g-sub", "/proj/gamma/parent.jsonl"),
  subMeta,
  gammaMsg("子会话", "2026-09-30T09:00:03.000Z"),
]);

const gref = { cwd: GAMMA, sessionDir: gammaDir };
resetIndexCacheForTests();
const rG = await listSessionsCached(gref);
check("H1 子会话被排除出 entries", !rG.entries.some((e) => e.info.id === "g-sub"), ids(rG));
/*
 * H2 语义变更（2026-10-03）：本条从「fork 保留」改为「派生会话一律排除」。
 *
 * 起因：用户换装 @tintinweb/pi-subagents 后，子会话只带 header.parentSession、
 * 不带任何 custom 标记，仅认 `pi-web:subagent` 的清单会漏出子会话（已实测复现）。
 * Pi 的 fork 与 subagent 在 header 层面同形（都用 SessionHeader.parentSession），
 * 单看 header 无法区分。取舍：Workbench 自身不暴露 fork 入口（sessions.ts:25
 * 「分支/fork 的 UI 明确记为后期」），故在 Workbench 清单语境下 hasParent 即子会话。
 *
 * 已知代价：若将来加入 fork 入口，fork 产出的会话会被一并隐藏。届时需按
 * 「与父会话 entry id 是否重叠」细分（fork 的 createBranchedSession/forkFrom
 * 会原样复制源 entry，id 必然重叠；subagent 从零新建，必然不重叠）。
 */
check("H2 派生会话（仅 parentSession）也排除 —— 修订语义", !rG.entries.some((e) => e.info.id === "g-fork"), ids(rG));
check("H3 普通会话保留", rG.entries.some((e) => e.info.id === "g-normal"), ids(rG));
check("H4 stats.files 仍扫描全部文件（含子会话；>仅 gamma）", rG.stats.files >= 3, rG.stats);
check("H5 扫描层对子会话置 isSubagent=true", scanSessionFileLight(path.join(gammaDir, "subagent.jsonl"))?.isSubagent === true, scanSessionFileLight(path.join(gammaDir, "subagent.jsonl")));

/* ---------- H6. 回归：tintinweb 形态子会话（无 custom 标记）也必须排除 ---------- */
// 这正是 2026-10-03 实锤的漏网形态：只有 header.parentSession + `general-purpose#xxxx` 名。
writeRaw("subagent-tintin.jsonl", [
  gammaHeader("g-tintin", "/proj/gamma/parent.jsonl"),
  { type: "session_info", id: "si1", parentId: "mc1", timestamp: "2026-10-03T04:19:28.733Z", name: "general-purpose#25d2c547" },
  { type: "message", id: "tm1", parentId: "si1", timestamp: "2026-10-03T04:19:28.753Z", message: { role: "user", content: [{ type: "text", text: "这是一次连通性测试" }] } },
]);
resetIndexCacheForTests();
const rT = await listSessionsCached(gref);
check("H6 无标记的派生子会话不进清单", !rT.entries.some((e) => e.info.id === "g-tintin"), ids(rT));
check("H6b 该子会话扫描层 hasParent=true", scanSessionFileLight(path.join(gammaDir, "subagent-tintin.jsonl"))?.hasParent === true, scanSessionFileLight(path.join(gammaDir, "subagent-tintin.jsonl")));

fs.rmSync(tmpRoot, { recursive: true, force: true });
const failed = checks.filter((c) => !c.pass);
console.log(`\n  ${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);