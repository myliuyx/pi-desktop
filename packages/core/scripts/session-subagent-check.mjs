/**
 * subagent 子会话对「历史清单 + 续接最近」的隔离检查。
 * 运行：npm run check:session-subagent
 *
 * 为什么单测这一层：列表隐藏只是 UI 观感，真正的坑是 `continueRecent`——
 * 子会话若 mtime 最新，续接会悄悄把用户带回一个子 agent 的上下文。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetIndexCacheForTests, mostRecentSessionPath } from "../src/session-list-cache.ts";
import { listSessions, continueRecentSession } from "../src/sessions.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-check-"));
const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

const CWD = "/proj/alpha";
const agentDir = path.join(tmpRoot, "agent");
const sessionsRoot = path.join(agentDir, "sessions");
const sessionDir = path.join(sessionsRoot, "--proj-alpha--");
fs.mkdirSync(sessionDir, { recursive: true });

const header = (id, ts, parent, cwd = CWD) => ({ type: "session", version: 3, id, cwd, timestamp: ts, ...(parent ? { parentSession: parent } : {}) });
const userMsg = (text, ts) => ({ type: "message", id: `m-${ts}`, parentId: "x", timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } });
const subMeta = { type: "custom", customType: "pi-web:subagent", id: "c1", parentId: "x", timestamp: "2026-10-02T10:00:00.000Z", data: { version: 1, parentSessionId: "p", parentSessionPath: "/p.jsonl", profile: "general-purpose" } };

function writeSession(name, entries) {
  const f = path.join(sessionDir, name);
  fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return f;
}

const normalOld = writeSession("2026-10-02T09-00-00-000Z_normalOld.jsonl", [
  header("normal-old", "2026-10-02T09:00:00.000Z"),
  userMsg("旧普通会话", "2026-10-02T09:00:01.000Z"),
]);
const normalNew = writeSession("2026-10-02T11-00-00-000Z_normalNew.jsonl", [
  header("normal-new", "2026-10-02T11:00:00.000Z"),
  userMsg("新普通会话", "2026-10-02T11:00:01.000Z"),
]);
const subagentNewest = writeSession("2026-10-02T12-00-00-000Z_subagentNewest.jsonl", [
  header("sub-newest", "2026-10-02T12:00:00.000Z", "/proj/alpha/parent.jsonl"),
  subMeta,
  userMsg("子会话任务", "2026-10-02T12:00:01.000Z"),
]);

// 用 mtime 钉死「最近」的确定顺序：subagent 最新，normalNew 次之，normalOld 最旧
const base = Date.parse("2026-10-02T09:00:00.000Z");
const setMtime = (f, minutes) => fs.utimesSync(f, new Date(base + minutes * 60_000), new Date(base + minutes * 60_000));
setMtime(normalOld, 0);
setMtime(normalNew, 60);
setMtime(subagentNewest, 120);

const ref = { cwd: CWD, sessionDir };

/* ---------- A. 清单过滤 ---------- */
resetIndexCacheForTests();
const listed = await listSessions(ref);
check("A1 清单不含 subagent 子会话", !listed.some((s) => s.id === "sub-newest"), listed.map((s) => s.id));
check("A2 清单含两个普通会话", listed.some((s) => s.id === "normal-old") && listed.some((s) => s.id === "normal-new"), listed.map((s) => s.id));

/* ---------- B. 续接最近：跳过 mtime 最新的 subagent ---------- */
resetIndexCacheForTests();
const newestPath = await mostRecentSessionPath(ref);
check("B1 mostRecentSessionPath 返回最新普通会话", newestPath === normalNew, { newestPath, normalNew });

resetIndexCacheForTests();
const recent = await continueRecentSession(ref);
check("B2 continueRecentSession 打开的是普通会话", recent.path === normalNew, { path: recent.path, normalNew });
check("B3 续接结果带普通会话消息", recent.result.messages.length >= 1 && recent.result.messages.some((m) => JSON.stringify(m).includes("新普通会话")), recent.result.messages.length);

/* ---------- C. 只有 subagent 会话时：空壳、不报错 ---------- */
const onlySubDir = path.join(sessionsRoot, "--proj-beta--");
fs.mkdirSync(onlySubDir, { recursive: true });
fs.writeFileSync(
  path.join(onlySubDir, "only-sub.jsonl"),
  [header("sub-only", "2026-10-02T13:00:00.000Z", "/proj/beta/parent.jsonl", "/proj/beta"), subMeta, userMsg("只有子会话", "2026-10-02T13:00:01.000Z")].map((e) => JSON.stringify(e)).join("\n") + "\n",
);
const onlyRef = { cwd: "/proj/beta", sessionDir: onlySubDir };
resetIndexCacheForTests();
const empty = await continueRecentSession(onlyRef);
check("C1 无普通会话时返回空壳（无 path、无消息）", !empty.path && empty.result.messages.length === 0, { path: empty.path, count: empty.result.messages.length });
check("C2 空壳仍有非空 id", typeof empty.result.id === "string" && empty.result.id.length > 0, empty.result.id);

fs.rmSync(tmpRoot, { recursive: true, force: true });
const failed = checks.filter((c) => !c.pass);
console.log(`\n  ${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);