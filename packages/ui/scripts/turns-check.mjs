/**
 * 分轮纯函数断言（task-process-collapse.md 步骤 6）—— 不需要浏览器。
 * 运行：npm run check:turns
 * 口径出处：lib/turns.ts 注释与 .plan/task-process-collapse.md 决策 2/3。
 */
import { groupTurns, buildTurnIndex, collectCollapsibleTurnKeys, turnKey } from "../src/lib/turns.ts";

let seq = 0;
const user = () => ({ id: `u${++seq}`, role: "user", timestamp: 0, blocks: [{ type: "text", content: "q" }] });
const assistant = (blocks) => ({ id: `a${++seq}`, role: "assistant", timestamp: 0, blocks });
const text = (content) => ({ type: "text", content });
const tool = (id) => ({ type: "tool_call", toolCallId: id, toolName: "bash", args: {} });
const approval = (resolved) => ({
  type: "approval",
  requestId: `r${++seq}`,
  title: "t",
  options: ["允许"],
  ...(resolved === undefined ? {} : { resolved }),
});

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(
    `  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`,
  );
}

/* 1. 多轮含工具的一问：三条 assistant（含中间过程与最终答复）→ 一轮，N=3 M=3 可折叠 */
{
  const msgs = [user(), assistant([tool("t1"), text("让我看看")]), assistant([tool("t2"), tool("t3")]), assistant([text("一共 3 个")])];
  const turns = groupTurns(msgs, "s1");
  check("案例1 轮数", turns.length, 1);
  check("案例1 N（assistant 条数）", turns[0].messageCount, 3);
  check("案例1 M（toolCallId 去重）", turns[0].toolCallCount, 3);
  check("案例1 尾条有文本", turns[0].tailHasText, true);
  check("案例1 可折叠", turns[0].collapsible, true);
  check("案例1 键（起始下标 0）", turns[0].key, turnKey("s1", 0));
  check("案例1 尾条下标", turns[0].tailIndex, 3);
}

/* 2. 纯文本轮（无工具调用）→ 不可折叠（思考卡本就自动收一行，无过程可收） */
{
  const msgs = [user(), assistant([text("直接回答")])];
  check("案例2 纯文本不可折叠", groupTurns(msgs, "s1").map((t) => t.collapsible), [false]);
}

/* 3. 尾条无文本（中止/出错）→ 不可折叠（过程留在原地不藏） */
{
  const msgs = [user(), assistant([tool("t1")]), assistant([tool("t2")])];
  const turn = groupTurns(msgs, "s1")[0];
  check("案例3 尾条无文本", turn.tailHasText, false);
  check("案例3 不可折叠", turn.collapsible, false);
}

/* 4. 会话以 assistant 开头（无 user 头）→ 首段自成一轮 */
{
  const msgs = [assistant([tool("t1")]), assistant([text("答案")]), user(), assistant([text("下一轮")])];
  const turns = groupTurns(msgs, "s1");
  check("案例4 轮数", turns.length, 2);
  check("案例4 首轮起始下标", turns[0].startIndex, 0);
  check("案例4 首轮可折叠", turns[0].collapsible, true);
  check("案例4 次轮不可折叠（纯文本）", turns[1].collapsible, false);
}

/* 5. 同一 toolCallId 跨消息重复 → 去重计 1 */
{
  const msgs = [user(), assistant([tool("t1")]), assistant([tool("t1"), text("好")])];
  check("案例5 toolCallId 去重", groupTurns(msgs, "s1")[0].toolCallCount, 1);
}

/* 6. 空文本块不算「有文本」（流式首字未到 / 空串） */
{
  const msgs = [user(), assistant([tool("t1"), text("  ")])];
  check("案例6 空白文本不算答完", groupTurns(msgs, "s1")[0].collapsible, false);
}

/* 7. 未决授权：只记 hasUnresolvedApproval，不参与 collapsible（动态条件归渲染侧闸门） */
{
  const unresolved = [user(), assistant([tool("t1"), text("答")]), assistant([approval()]), assistant([text("最终答复")])];
  const turnU = groupTurns(unresolved, "s1")[0];
  check("案例7a 未决授权被标记", turnU.hasUnresolvedApproval, true);
  check("案例7b collapsible 不受授权影响（尾条有文本）", turnU.collapsible, true);
  const resolvedMsgs = [user(), assistant([tool("t1"), text("答")]), assistant([approval("允许")]), assistant([text("最终答复")])];
  check("案例7c 已决授权不标记", groupTurns(resolvedMsgs, "s1")[0].hasUnresolvedApproval, false);
}

/* 8. 多轮切分 + collectCollapsibleTurnKeys：只收可折叠轮，key 随 scope 变 */
{
  const msgs = [
    user(), assistant([tool("t1"), text("答一")]),
    user(), assistant([text("答二")]),
    user(), assistant([tool("t2")]), assistant([text("答三")]),
  ];
  const turns = groupTurns(msgs, "sA");
  check("案例8 轮数", turns.length, 3);
  check("案例8 键序列", turns.map((t) => t.key), [turnKey("sA", 0), turnKey("sA", 2), turnKey("sA", 4)]);
  check("案例8 可折叠键（scope sA）", [...collectCollapsibleTurnKeys(msgs, "sA")], [turnKey("sA", 0), turnKey("sA", 4)]);
  check("案例8 换 scope 键全变", [...collectCollapsibleTurnKeys(msgs, "sB")], [turnKey("sB", 0), turnKey("sB", 4)]);
}

/* 9. buildTurnIndex：每条 assistant 消息有归属，尾条 isTail，user 不在表内 */
{
  const msgs = [user(), assistant([tool("t1")]), assistant([text("答")]), user(), assistant([text("答2")])];
  const index = buildTurnIndex(msgs, "s1");
  check("案例9 表大小（3 条 assistant）", index.size, 3);
  check("案例9 中间行 isTail", index.get(1).isTail, false);
  check("案例9 尾条 isTail", index.get(2).isTail, true);
  check("案例9 user 不在表内", index.has(0), false);
  check("案例9 次轮尾条", index.get(4).isTail, true);
}

/* 10. 空数组 / 只有 user（无回复）→ 无轮次 */
{
  check("案例10 空数组", groupTurns([], "s1"), []);
  check("案例10 只有 user", groupTurns([user()], "s1"), []);
}

if (failed > 0) {
  console.error(`\n分轮断言失败 ${failed} 项`);
  process.exit(1);
}
console.log("分轮断言全部通过");
