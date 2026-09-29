/**
 * 提问导航刻度栏纯函数断言（task-turn-rail.md 步骤 6）—— 不需要浏览器。
 * 运行：npm run check:turn-rail
 * 口径出处：lib/turn-rail.ts 注释、.plan/task-turn-rail.md 决策 4/5、
 * .plan/task-turn-rail-even-ticks.md（第一次修订：等比 → 全高槽位居中）与
 * .plan/task-turn-rail-compact-cluster.md（第二次修订：紧凑居中簇 + 固定档距）。
 */
import { buildPreviewTexts, collectRailTurns, layoutTickTops } from "../src/lib/turn-rail.ts";

let seq = 0;
const user = (content) => ({
  id: `u${++seq}`,
  role: "user",
  timestamp: 0,
  blocks: [{ type: "text", content }],
});
const assistant = (blocks) => ({ id: `a${++seq}`, role: "assistant", timestamp: 0, blocks });
const text = (content) => ({ type: "text", content });

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(
    `  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`,
  );
}

/* 1. collectRailTurns：每条 user 消息一个锚点；assistant 开头的首段（无 user 头）不出刻度 */
{
  const msgs = [
    assistant([text("压缩摘要")]),
    user("问题一"),
    assistant([text("答一")]),
    user("问题二"),
    assistant([text("答二")]),
  ];
  const anchors = collectRailTurns(msgs, "s1");
  check("案例1 锚点数（2 个 user 头）", anchors.length, 2);
  check("案例1 锚点下标", anchors.map((a) => a.anchorIndex), [1, 3]);
  check("案例1 尾条下标（回答所在）", anchors.map((a) => a.turn.tailIndex), [2, 4]);
}

/* 2. 空会话 / 只有 assistant → 无锚点（0 提问不渲染触发，规格书决策 4） */
{
  check("案例2 空数组", collectRailTurns([], "s1"), []);
  check("案例2 只有 assistant", collectRailTurns([assistant([text("x")])], "s1"), []);
}

/* 3. layoutTickTops：紧凑居中簇（task-turn-rail-compact-cluster.md 第二次修订） */
{
  check("案例3 三刻度紧凑簇", layoutTickTops(3, 300, 12), [138, 150, 162]);
  check("案例3 两刻度对称簇", layoutTickTops(2, 400, 10), [195, 205]);
}

/* 4. 档距恒定：相邻差恒等于 pitch（簇内等距，无需 minGap 钳制） */
{
  const tops = layoutTickTops(3, 300, 12);
  check("案例4 相邻间距全等（pitch）", tops[1] - tops[0] === 12 && tops[2] - tops[1] === 12, true);
}

/* 5. 溢出压缩：数量不裁剪，档距压缩为 railHeight/(n-1) 全高铺满 */
{
  const full = layoutTickTops(31, 300, 10);
  check("案例5 满簇（档距恰=栏高上限）", full, Array.from({ length: 31 }, (_, i) => i * 10));
  const squeezed = layoutTickTops(61, 300, 12);
  check("案例5 压缩后数量不裁剪", squeezed.length, 61);
  check("案例5 压缩后首刻度贴顶", squeezed[0], 0);
  check("案例5 压缩后末刻度贴底", squeezed[60], 300);
  check("案例5 压缩后档距 = railHeight/(n-1)", squeezed[1] - squeezed[0], 5);
}

/* 6. 边界：空输入 / 单刻度居中 / 非正高度 → 不炸、无 NaN */
{
  check("案例6 空输入", layoutTickTops(0, 300, 12), []);
  check("案例6 单刻度居中", layoutTickTops(1, 300, 12), [150]);
  check("案例6 railHeight 0", layoutTickTops(2, 0, 12), [0, 0]);
}

/* 7. buildPreviewTexts：注入文件块折 📎 行 + 截断带省略号 + 缺省安全 */
{
  const p1 = buildPreviewTexts(
    user('看下 <file name="a/b.md">正文</file> 这个'),
    assistant([text("回")]),
    500,
    300,
  );
  check("案例7 文件块折行", p1.question, "看下\n📎 b.md\n这个");
  check("案例7 回答取尾条文本", p1.answer, "回");
  const long = "长".repeat(600);
  const p2 = buildPreviewTexts(user(long), undefined, 500, 300);
  check("案例7 问题截断 500+省略号", p2.question, `${"长".repeat(500)}…`);
  check("案例7 无尾条 → 回答空", p2.answer, "");
  const p3 = buildPreviewTexts(undefined, undefined, 500, 300);
  check("案例7 全缺省 → 双空", `${p3.question}|${p3.answer}`, "|");
}

/* 8. 回答取最后一个非空 text 块（跳过工具块与空白块） */
{
  const p = buildPreviewTexts(
    user("问"),
    assistant([
      { type: "tool_call", toolCallId: "t1", toolName: "bash", args: {} },
      text("  "),
      text("最终答复"),
    ]),
    500,
    300,
  );
  check("案例8 跳过空白取最终", p.answer, "最终答复");
}

/* 9. 回答截断（渲染态口径，task-turn-rail-preview-interaction.md 决策 6）：
      截断 + 奇数围栏补闭合 + 截断提示；无围栏只加提示；未截断原样；问题路径不修补 */
{
  // 每段 16 字符含 1 个 ```：截到 300 字符时围栏数 19（奇）→ 补闭合后必为偶数
  const a1 = buildPreviewTexts(user("问"), assistant([text("text\n```js\ncode\n".repeat(200))]), 500, 300);
  check("案例9 截断触发", a1.answer.length > 300, true);
  check("案例9 围栏闭合（偶数个 ```）", (a1.answer.match(/```/g) ?? []).length % 2, 0);
  check("案例9 截断提示", a1.answer.endsWith("（预览已截断，点击刻度查看全文）"), true);
  const a3 = buildPreviewTexts(user("问"), assistant([text("x".repeat(400))]), 500, 300);
  check("案例9 无围栏只加提示", a3.answer.includes("```"), false);
  check("案例9 无围栏也有提示", a3.answer.endsWith("（预览已截断，点击刻度查看全文）"), true);
  const a2 = buildPreviewTexts(user("问"), assistant([text("短回答")]), 500, 300);
  check("案例9 未截断原样", a2.answer, "短回答");
  const q1 = buildPreviewTexts(user("```\nabc".repeat(80)), undefined, 500, 300);
  check("案例9 问题路径不修补不提示", q1.question.includes("（预览已截断"), false);
}

if (failed > 0) {
  console.error(`\n刻度栏断言失败 ${failed} 项`);
  process.exit(1);
}
console.log("刻度栏断言全部通过");
