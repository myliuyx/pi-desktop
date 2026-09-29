/**
 * 提问导航刻度栏纯函数断言（task-turn-rail.md 步骤 6）—— 不需要浏览器。
 * 运行：npm run check:turn-rail
 * 口径出处：lib/turn-rail.ts 注释、.plan/task-turn-rail.md 决策 4/5 与
 * .plan/task-turn-rail-even-ticks.md（2026-09-29 修订：决策 3 等比 → 均匀槽位居中）。
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

/* 3. layoutTickTops：均匀槽位居中（task-turn-rail-even-ticks.md 修订决策 3） */
{
  check("案例3 两刻度槽位居中", layoutTickTops(2, 400), [100, 300]);
  check("案例3 三刻度等分", layoutTickTops(3, 300), [50, 150, 250]);
}

/* 4. 间距恒定：相邻差恒等于 railHeight / n（均匀分布天然不叠，无需 minGap 钳制） */
{
  const tops = layoutTickTops(3, 300);
  check(
    "案例4 相邻间距全等（railHeight/n）",
    tops[1] - tops[0] === 100 && tops[2] - tops[1] === 100,
    true,
  );
}

/* 5. 多刻度不裁剪：数量全保留，首尾各留半格（整列上下对称） */
{
  const tops = layoutTickTops(100, 300);
  check("案例5 数量不裁剪", tops.length, 100);
  check("案例5 首刻度上留半格", tops[0], 1.5);
  check("案例5 末刻度下留半格", tops[99], 298.5);
}

/* 6. 边界：空输入 / 单刻度居中 / 非正高度 → 不炸、无 NaN */
{
  check("案例6 空输入", layoutTickTops(0, 300), []);
  check("案例6 单刻度居中", layoutTickTops(1, 300), [150]);
  check("案例6 railHeight 0", layoutTickTops(2, 0), [0, 0]);
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

if (failed > 0) {
  console.error(`\n刻度栏断言失败 ${failed} 项`);
  process.exit(1);
}
console.log("刻度栏断言全部通过");
