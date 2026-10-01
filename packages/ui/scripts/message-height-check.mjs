/**
 * 行高估算断言（2026-10-01 · 上滚回弹根治 · 第 2 层）—— 纯函数，不需要浏览器。
 *
 * 断言口径 = **实测真实高度**（采集自 dev server：stress=600 与 live 真会话，
 * 见 lib/message-height.ts 文件头表格）。估算值必须落在实测值的容差内，
 * 否则上滚进入未测量区域时总高就会缩水 ⇒ 回弹。
 *
 * 运行：npm run check:message-height
 */
import {
  MIN_ESTIMATED_ROW_HEIGHT,
  createHeightMemory,
  estimateBlocksHeight,
  estimateMessageHeight,
  rememberMessageHeight,
  resolveRowHeight,
} from "../src/lib/message-height.ts";

let failed = 0;
function check(label, ok, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
}

/** 断言估算值落在 [实测 - tol, 实测 + tol] */
function near(label, estimated, measured, tol) {
  const diff = estimated - measured;
  const ok = Math.abs(diff) <= tol;
  check(label, ok, `估算 ${estimated} vs 实测 ${measured}（差 ${diff > 0 ? "+" : ""}${diff}，容差 ±${tol}）`);
}

const text = (content) => [{ type: "text", content }];

/* ---------------------------------------------------------------- 1. 短文本 */
{
  // stress=600 user 行恒 97：单行短文本 + 内边距
  const h = estimateMessageHeight({ id: "u", role: "user", timestamp: 0, blocks: text("好的") });
  near("单行短文本 ≈ stress user 行实测 97", h, 97, 15);
}

/* ---------------------------------------------------------------- 2. 多行文本 */
{
  const short = estimateMessageHeight({ id: "a", role: "assistant", timestamp: 0, blocks: text("已完成。") });
  check("assistant 短答复在实测区间 90~180", short >= 90 && short <= 180, `实际 ${short}`);
  const long = estimateMessageHeight({
    id: "a", role: "assistant", timestamp: 0,
    blocks: text("x".repeat(50 * 6)),   // 6 行
  });
  check("6 行文本显著高于单行", long > short + 100, `${short} → ${long}`);
}

/* ---------------------------------------------------------------- 3. 工具卡 */
{
  // ⚠️ 实测校正：live 里342/464px 的大行**不是**工具卡，而是纯 markdown 长回复
  // （markdown-body 占 214/336px，其余为 chrome 128px）—— 当时已折叠进
  // process-details，工具卡并未渲染。下面分开锁「工具卡」与「长markdown」两形态。
  const withTool = estimateMessageHeight({
    id: "a", role: "assistant", timestamp: 0,
    blocks: [
      { type: "tool_call", toolCallId: "t1", toolName: "bash", args: { command: "node hello.js" } },
      { type: "terminal", toolCallId: "t1", command: "node hello.js", output: "hello\nworld", status: "done" },
      text("已创建并运行。"),
    ],
  });
  check("工具卡 + 2 行输出 + 一句答复在合理区间（240~440）", withTool >= 240 && withTool <= 440, `实际 ${withTool}`);
}

/* ---------------------------------------------------------------- 3b. 长 markdown */
{
  // 实测：markdown-body 214px ≈ 9 行；行总高 342 = chrome 128 + body 214
  const nine = estimateMessageHeight({
    id: "a", role: "assistant", timestamp: 0, blocks: text("x".repeat(50 * 9)),
  });
  near("9 行 markdown ≈ 实测行高 342", nine, 342, 30);
  const fourteen = estimateMessageHeight({
    id: "a", role: "assistant", timestamp: 0, blocks: text("x".repeat(50 * 14)),
  });
  near("14 行 markdown ≈ 实测行高 464", fourteen, 464, 30);
}

/* ---------------------------------------------------------------- 4. 钳制 */
{
  const empty = estimateMessageHeight({ id: "a", role: "assistant", timestamp: 0, blocks: [] });
  check("空消息不低于下限", empty >= MIN_ESTIMATED_ROW_HEIGHT, `${empty}`);
  const emptyUser = estimateMessageHeight({ id: "u", role: "user", timestamp: 0, blocks: [] });
  check("空 user 消息不低于下限", emptyUser >= MIN_ESTIMATED_ROW_HEIGHT, `${emptyUser}`);
  const huge = estimateMessageHeight({ id: "a", role: "assistant", timestamp: 0, blocks: text("y".repeat(200000)) });
  check("超长文本被钳制", huge <= 4000, `${huge}`);
}

/* ---------------------------------------------------------------- 5. 记忆化优先 */
{
  const mem = createHeightMemory();
  const msg = { id: "m1", role: "user", timestamp: 0, blocks: text("实测 200px") };
  // 未测量 → 走估算
  const before = resolveRowHeight(mem, msg);
  rememberMessageHeight(mem, "m1", 200);
  const after = resolveRowHeight(mem, msg);
  check("记忆化命中后返回实测值", after === 200, `估算 ${before} → 实测 ${after}`);
  check("记忆化优先于估算", after !== before);
  // 未命中走估算
  const other = resolveRowHeight(mem, { ...msg, id: "m2" });
  check("未命中则走估算", other !== 200 && other > 0, `${other}`);
  // 缺消息兜底
  check("消息缺省返回下限", resolveRowHeight(mem, undefined) === MIN_ESTIMATED_ROW_HEIGHT);
}

/* ---------------------------------------------------------------- 6. 估算单调性 */
{
  // 文本越长估算越高（否则总高随内容抖动 ⇒ 又一种跳变源）
  let prev = 0, mono = true;
  for (let n = 1; n <= 10; n++) {
    const h = estimateBlocksHeight(text("z".repeat(n * 30)));
    if (h < prev) mono = false;
    prev = h;
  }
  check("估算随文本长度单调不减", mono);
}

console.log(failed === 0 ? "\n行高估算断言全部通过" : `\n行高估算断言失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);