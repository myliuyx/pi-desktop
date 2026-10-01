/**
 * 工具结果 details 透传断言（task-tool-diff-preview.md）—— 确定性、不起 core 服务。
 *
 * 背景：edit 工具在上游返回 `details: { diff, patch, firstChangedLine }`（generateDiffString
 * 算好的展示用 diff），此前 core 翻译/历史两层都把 details 丢弃，UI 展开工具卡只能看到
 * 「Successfully…」一行文本。本检查锁定两条透传链与「无 details 不写键」纪律：
 *   ① live：raw `tool_execution_end.result.details` → `toAgentEvent` 顶层 details；
 *   ② 历史：toolResult entry 的 `message.details` → `entriesToMessages` 的 TerminalBlock.details。
 *
 * 运行：npm run check:tool-details
 * 用 tsx 直跑（同 check:usage-branch）——sessions.ts 传递依赖 pi 包，strip-types 会撞参数属性语法。
 */

import { toAgentEvent } from "../src/adapt.ts";
import { entriesToMessages } from "../src/sessions.ts";

const checks = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push(ok);
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`}`);
};

const DETAILS = {
  diff: "     ...\n 170 \tconst before = 1;\n-174 \tb = old;\n+174 \tb = new;\n 175 \n     ...",
  patch: "--- a/a.ts\n+++ b/a.ts\n@@ -172,7 +172,7 @@\n",
  firstChangedLine: 174,
};

/* ---------------------------------------------------------------------------
 * ① live 链路：toAgentEvent
 * ------------------------------------------------------------------------- */
console.log("① live：tool_execution_end.result.details → 事件顶层");

{
  const event = toAgentEvent({
    type: "tool_execution_end",
    toolCallId: "t1",
    result: {
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in a.ts." }],
      details: DETAILS,
    },
    isError: false,
  });
  check("① edit details 原样透传到事件顶层", event.details, DETAILS);
  check("① output 文本不受影响", event.output, "Successfully replaced 1 block(s) in a.ts.");
  check("① isError 口径不变", event.isError, false);
}

{
  // bash 常态（无 details）→ 精确形状：多一个 undefined 键都会破坏 adapter-check 的深度断言
  const event = toAgentEvent({
    type: "tool_execution_end",
    toolCallId: "c1",
    result: { content: [{ type: "text", text: "ok" }] },
    isError: false,
  });
  check(
    "① 无 details 不写键（精确形状，adapter-check 镜像）",
    JSON.stringify(event),
    JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", output: "ok", isError: false }),
  );
}

{
  // details 非对象（异常/老数据）→ 同样不写键，让 UI 回落 output 文本
  const event = toAgentEvent({
    type: "tool_execution_end",
    toolCallId: "c2",
    result: { content: [{ type: "text", text: "ok" }], details: "weird" },
    isError: false,
  });
  check("① details 非对象不写键", "details" in event, false);
}

/* ---------------------------------------------------------------------------
 * ② 历史链路：entriesToMessages
 * ------------------------------------------------------------------------- */
console.log("② 历史：toolResult entry.details → TerminalBlock.details");

const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);
const ts = (i) => new Date(T0 + i * 60_000).toISOString();
const base = (id, parentId, i) => ({ id, parentId, timestamp: ts(i) });

const entries = [
  { type: "session", version: 3, id: "tool-details-synth", timestamp: ts(0), cwd: process.cwd() },
  {
    ...base("e1", null, 1),
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "改一下" }] },
  },
  {
    ...base("e2", "e1", 2),
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "t1", name: "edit", arguments: { path: "a.ts", edits: [{ oldText: "b = old", newText: "b = new" }] } },
        { type: "toolCall", id: "t2", name: "bash", arguments: { command: "echo hi" } },
      ],
    },
  },
  {
    ...base("e3", "e2", 3),
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "edit",
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in a.ts." }],
      details: DETAILS,
      isError: false,
      timestamp: Date.now(),
    },
  },
  {
    ...base("e4", "e2", 4),
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "t2",
      toolName: "bash",
      content: [{ type: "text", text: "hi" }],
      isError: false,
      timestamp: Date.now(),
    },
  },
];

{
  const { messages } = entriesToMessages(entries, { contextWindow: 1000 });
  const assistant = messages.find((m) => m.role === "assistant");
  const terminalOf = (id) =>
    (assistant?.blocks ?? []).find((b) => b.type === "terminal" && b.toolCallId === id);
  const edit = terminalOf("t1");
  check("② 历史 edit TerminalBlock 带回 details", edit?.details, DETAILS);
  const bash = terminalOf("t2");
  check("② 历史 bash 无 details 不写键", bash ? "details" in bash : null, false);
  check("② 历史 output/status 口径不变", bash ? { output: bash.output, status: bash.status } : null, {
    output: "hi",
    status: "success",
  });
}

if (checks.some((ok) => !ok)) {
  console.error(`\n工具 details 透传断言失败 ${checks.filter((ok) => !ok).length} 项`);
  process.exit(1);
}
console.log(`工具 details 透传断言全部通过：${checks.length} 项`);
