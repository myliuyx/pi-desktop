/**
 * 工具 diff/内容预览 · UI 侧纯逻辑断言（task-tool-diff-preview.md）—— 不需要浏览器。
 * 运行：npm run check:tool-diff
 *
 * 锁两件事：
 *   ① `lib/diff-parse.ts` 对上游 `details.diff` 的解析（行格式见 lib/diff-parse.ts 头注释；
 *      样式取自 pi generateDiffString 实测输出——行号 padStart、省略标记行、tab 保留）；
 *   ② reducer 把 `tool_execution_end.details` 写进 TerminalBlock（无 details 不写键），
 *      这是 ToolDiffView 数据的入口。
 */
import { applyEvent, createDraft } from "../src/adapter/reduce.ts";
import { countDiffChanges, parseDetailsDiff } from "../src/lib/diff-parse.ts";

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(
    `  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`,
  );
}

/* ---------------------------------------------------------------------------
 * ① diff 解析
 * ------------------------------------------------------------------------- */
console.log("① parseDetailsDiff");

// pi generateDiffString 实测格式：行号宽 3（padStart）、上下文/省略行空格前缀、tab 内容原样
const RAW = [
  "     ...", // 省略标记行（前缀空格 + 空白行号 + " ..."）
  " 170 \tconst before = 1;", // 上下文行
  "-174 \tb = old;", // 删除行（旧文件行号）
  "+174 \tb = new;", // 新增行（新文件行号）
  " 175 ", // 空行上下文（内容为空）
  "     ...", // 省略标记行
].join("\n");

{
  const lines = parseDetailsDiff(RAW);
  check("行数（裸空行是 join 伪影要跳过，这里没有）", lines.length, 6);
  check("省略标记行", lines[0], { kind: "skip", content: "..." });
  check("上下文行（tab 原样 + 新文件行号）", lines[1], { kind: "ctx", lineNo: 170, content: "\tconst before = 1;" });
  check("删除行（旧文件行号）", lines[2], { kind: "del", lineNo: 174, content: "\tb = old;" });
  check("新增行（新文件行号）", lines[3], { kind: "add", lineNo: 174, content: "\tb = new;" });
  check("空行上下文", lines[4], { kind: "ctx", lineNo: 175, content: "" });
  check("增删计数", countDiffChanges(lines), { added: 1, removed: 1 });
}

{
  // 内容以数字/空格开头的行：行号只吃第一段数字，其余归内容
  const lines = parseDetailsDiff("+12 1234  foo");
  check("内容含前导数字", lines[0], { kind: "add", lineNo: 12, content: "1234  foo" });
}

{
  check("空 diff → 空数组", parseDetailsDiff(""), []);
  check("纯空白 diff → 空数组", parseDetailsDiff("   \n  "), []);
}

{
  // 形状外的行不丢内容（理论不出现，兜底按上下文渲染）
  const lines = parseDetailsDiff("weird line");
  check("形状外行兜底为 ctx", lines[0], { kind: "ctx", content: "weird line" });
}

/* ---------------------------------------------------------------------------
 * ② reducer：details 写进 TerminalBlock
 * ------------------------------------------------------------------------- */
console.log("② reducer details 透传");

{
  let s = createDraft();
  s = applyEvent(s, {
    type: "message_start",
    message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "a.ts" } }] },
  });
  s = applyEvent(s, { type: "tool_execution_start", toolCallId: "t1", toolName: "edit", args: { path: "a.ts" } });
  s = applyEvent(s, {
    type: "tool_execution_end",
    toolCallId: "t1",
    output: "Successfully replaced 1 block(s) in a.ts.",
    isError: false,
    details: { diff: RAW, patch: "p", firstChangedLine: 174 },
  });
  const block = s.messages[0].blocks.find((b) => b.type === "terminal" && b.toolCallId === "t1");
  check("② details 写进 TerminalBlock", block?.details, { diff: RAW, patch: "p", firstChangedLine: 174 });
  check("② output/status 口径不变", block ? { output: block.output, status: block.status } : null, {
    output: "Successfully replaced 1 block(s) in a.ts.",
    status: "success",
  });
}

{
  // 无 details（bash 常态）→ 不写键，渲染层回落 output 文本
  let s = createDraft();
  s = applyEvent(s, {
    type: "message_start",
    message: { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "echo hi" } }] },
  });
  s = applyEvent(s, { type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "echo hi" } });
  s = applyEvent(s, { type: "tool_execution_end", toolCallId: "t2", output: "hi", isError: false });
  const block = s.messages[0].blocks.find((b) => b.type === "terminal" && b.toolCallId === "t2");
  check("② 无 details 不写键", block ? "details" in block : null, false);
}

if (failed > 0) {
  console.error(`\n工具 diff 纯逻辑断言失败 ${failed} 项`);
  process.exit(1);
}
console.log("工具 diff 纯逻辑断言全部通过");
