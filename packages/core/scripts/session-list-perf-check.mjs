/**
 * 会话清单性能阈值检查（spec §7 判定阈值表）。
 * 运行：npm run check:session-list-perf
 *
 * 为什么用夹具而不是真实 agentDir：阈值必须可复跑，不能被「本机恰好有 104 个会话」
 * 或磁盘冷热影响。夹具造 300 个会话（每个含 200 条 message）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { listSessionsCached, resetIndexCacheForTests, flushIndexSaveForTests } from "../src/session-list-cache.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "perf-check-"));
const CWD = "/proj/perf";
const sessionDir = path.join(tmpRoot, "agent", "sessions", "--proj-perf--");
fs.mkdirSync(sessionDir, { recursive: true });

const SESSIONS = 300;
const MESSAGES = 200;
const base = Date.parse("2026-09-01T00:00:00.000Z");
let bytes = 0;
for (let i = 0; i < SESSIONS; i++) {
  const lines = [JSON.stringify({ type: "session", version: 3, id: `s${i}`, cwd: CWD, timestamp: new Date(base + i * 1000).toISOString() })];
  for (let m = 0; m < MESSAGES; m++) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `m${i}-${m}`,
        parentId: "x",
        timestamp: new Date(base + i * 1000 + m * 100).toISOString(),
        message: { role: m % 2 ? "assistant" : "user", content: [{ type: "text", text: `内容 ${i}/${m} `.repeat(20) }] },
      }),
    );
  }
  const body = lines.join("\n") + "\n";
  bytes += Buffer.byteLength(body);
  fs.writeFileSync(path.join(sessionDir, `2026-09-01T00-00-00-000Z_s${i}.jsonl`), body);
}
console.log(`夹具：${SESSIONS} 会话 / 每个 ${MESSAGES} 条消息 / 总计 ${(bytes / 1e6).toFixed(1)}MB`);

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

const ref = { cwd: CWD, sessionDir };

resetIndexCacheForTests();
let t = performance.now();
const cold = await listSessionsCached(ref);
const coldMs = performance.now() - t;
flushIndexSaveForTests(sessionDir); // 落盘后才能测「重启首拉」

t = performance.now();
const warm = await listSessionsCached(ref);
const warmMs = performance.now() - t;

resetIndexCacheForTests(); // 模拟 core 重启：只剩落盘索引
t = performance.now();
const restart = await listSessionsCached(ref);
const restartMs = performance.now() - t;

console.log(`  冷扫 ${(bytes / 1e6).toFixed(1)}MB: ${coldMs.toFixed(0)}ms｜热拉: ${warmMs.toFixed(0)}ms｜重启首拉: ${restartMs.toFixed(0)}ms`);
check("清单条数正确", cold.entries.length === SESSIONS, cold.entries.length);
check("热拉 < 100ms（300 文件 stat + 无解析）", warmMs < 100, `${warmMs.toFixed(0)}ms`);
check("重启首拉 < 100ms（命中落盘索引）", restartMs < 100, `${restartMs.toFixed(0)}ms`);
check("热拉零重扫", warm.stats.misses === 0, warm.stats);
check("重启首拉零重扫", restart.stats.misses === 0, restart.stats);
check("冷扫吞吐 > 20MB/s（护栏，防退化为逐行 parse）", bytes / 1e6 / (coldMs / 1000) > 20, `${(bytes / 1e6 / (coldMs / 1000)).toFixed(1)}MB/s`);

fs.rmSync(tmpRoot, { recursive: true, force: true });
const failed = checks.filter((c) => !c.pass);
console.log(`\n  ${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);