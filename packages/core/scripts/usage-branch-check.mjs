/**
 * 活动分支用量口径断言 —— 确定性、不起 core 服务。
 *
 * 背景：`resetUsageFromSession`（continue-recent 重建活动会话后重置累计）曾用
 * `SessionManager.getEntries()`，会把**被弃旁支**的 usage 也折进 TokenUsage；
 * 而 `readSession`（POST /sessions/load）用 `getBranch()` 只取活动分支。
 * 两者口径不一致 ⇒ 加载回来的用量与内存里重置后的用量会分叉。
 *
 * 运行：npm run check:usage-branch
 * 依赖 Node 的 --experimental-strip-types（package.json 已加 flag）以 import .ts。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { entriesToMessages, usageFromActiveBranch } from "../src/sessions.ts";

const T0 = Date.UTC(2026, 8, 24, 10, 0, 0);
const ts = (i) => new Date(T0 + i * 60_000).toISOString();
const base = (id, parentId, i) => ({ id, parentId, timestamp: ts(i) });

/** 主干 e1→e2→e3；旁支 e2b（parent=e2）挂一条 usage，不应被计入 */
const entries = [
  { type: "session", version: 3, id: "usage-synth", timestamp: ts(0), cwd: process.cwd() },
  { ...base("e1", null, 1), type: "message", message: { role: "user", content: [{ type: "text", text: "问" }] } },
  {
    ...base("e2", "e1", 2),
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "答" }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } },
  },
  /*
   * 旁支：parentId=e2，不是 leaf 的父链。
   *
   * ⚠️ 这里必须放**带 usage 的 assistant 消息**，不能放 `type:"usage"` 条目：
   * `entriesToMessages` 在存在任何消息级 usage 时会**优先取消息级口径**
   * （`useEntryUsage = !sawMessageUsage && sawEntryUsage`），而真实被弃分支
   * 上同样有 assistant 消息 usage —— 用 usage 条目反而复现不出污染（会得 15）。
   */
  {
    ...base("e2b", "e2", 3),
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "旁支答" }], usage: { input: 9999, output: 9999, cacheRead: 0, cacheWrite: 0, totalTokens: 9999 } },
  },
  { ...base("e3", "e2", 4), type: "message", message: { role: "user", content: [{ type: "text", text: "第二问" }] } },
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-branch-"));
const file = path.join(dir, "2026-09-24T10-00-00-000Z_usage-synth.jsonl");
fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

const manager = SessionManager.open(file, dir, process.cwd());

const checks = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push(ok);
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`}`);
};

// ① 基线：主干口径（readSession 同源）
const branchUsage = entriesToMessages(manager.getBranch(), { contextWindow: 1000 }).tokenUsage;
check("主干汇总 total=15（不含旁支 9999）", branchUsage.total, 15);

// ② 反例：全量口径会污染（复现修复前的 resetUsageFromSession）
//    total 历史累加，故污染值 = 主干 15 + 旁支 9999 = 10014
const allUsage = entriesToMessages(manager.getEntries(), { contextWindow: 1000 }).tokenUsage;
check("（反例）全量汇总会把旁支折进来 => 15+9999=10014", allUsage.total, 10014);

// ③ 目标：导出的公共函数必须是主干口径（只比对本用例关心的四字段，
//    实际 tokenUsage 还会带可选的 contextTokens）
const active = usageFromActiveBranch(manager, 1000);
check(
  "usageFromActiveBranch 与主干一致（input=10 output=5 total=15）",
  { input: active.input, output: active.output, total: active.total, contextWindow: active.contextWindow },
  { input: 10, output: 5, total: 15, contextWindow: 1000 },
);

if (checks.some((ok) => !ok)) {
  console.error(`\n分支用量断言失败 ${checks.filter((ok) => !ok).length} 项`);
  process.exit(1);
}
console.log(`分支用量断言全部通过：${checks.length} 项`);