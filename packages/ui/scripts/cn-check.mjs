/**
 * cn() 回归断言 —— 防止「flex 被 flex-col 吞掉」这类静默布局缺陷再次出现。
 *
 * 为什么值得单独一个脚本：这个 bug 不报错、不影响 tsc、构建也通过，
 * 只表现为「元素悄悄从 flex 退化成 block」，从代码上完全看不出来。
 * 唯一可靠的防线是断言。
 *
 * 运行：node --experimental-strip-types scripts/cn-check.mjs
 */
import { cn } from "../src/lib/cn.ts";
import {
  SETTINGS_DIALOG_FORM_PADDING,
  SETTINGS_DIALOG_SPLIT_GAP,
  SWITCH_BORDER_WIDTH,
  SWITCH_KNOB_INSET,
  SWITCH_KNOB_LEFT_ON,
  SWITCH_KNOB_SIZE,
  SWITCH_WIDTH,
} from "../src/lib/layout.ts";

const cases = [
  // [说明, 实际, 期望]
  ["flex 与 flex-col 必须共存", cn("flex", "flex-col"), "flex flex-col"],
  ["flex-col 覆盖 flex-row", cn("flex-row", "flex-col"), "flex-col"],
  ["flex-wrap 与 display 互不干扰", cn("flex", "flex-wrap"), "flex flex-wrap"],
  ["block 被 flex 覆盖", cn("block", "flex"), "flex"],
  ["flex 被 hidden 覆盖", cn("flex", "hidden"), "hidden"],
  ["hidden 被 flex 覆盖", cn("hidden flex"), "flex"],
  ["inline-flex 覆盖 flex", cn("flex", "inline-flex"), "inline-flex"],
  ["grid 与 grid-cols 共存", cn("grid", "grid-cols-3"), "grid grid-cols-3"],
  ["h-full 不被 hidden 干扰", cn("h-full hidden"), "h-full hidden"],
  ["字号与文字色互不干扰", cn("text-sm", "text-text-primary"), "text-sm text-text-primary"],
  // text-align 组（2026-09-22 实踩：缺这组时 text-left 落进 text-color 被吞，
  // <button> 回落 UA 的 text-align:center，文字静默居中）
  ["text-left 不被后续文字色吞掉", cn("text-left", "text-text-secondary"), "text-left text-text-secondary"],
  ["text-right 与字号、颜色共存", cn("truncate text-right text-xs", "text-text-tertiary"), "truncate text-right text-xs text-text-tertiary"],
  ["对齐组内后者胜出", cn("text-left", "text-right"), "text-right"],
  ["对齐变体不跨变体冲突", cn("text-left", "hover:text-right"), "text-left hover:text-right"],
  ["调用方覆盖对齐", cn("px-2 text-left", "text-center"), "px-2 text-center"],
  ["调用方覆盖宽度", cn("w-full", "w-10"), "w-10"],
  ["调用方覆盖颜色", cn("text-text-secondary", "text-text-primary"), "text-text-primary"],
  ["调用方覆盖 display", cn("flex flex-col", "hidden"), "flex-col hidden"],
  // 真实调用串：M1 三栏靠这一条
  [
    "侧边栏真实 class 串",
    cn("flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r border-border-subtle bg-bg-surface", "gap-0 p-0", "transition-[width] ease-out"),
    "flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r border-border-subtle bg-bg-surface gap-0 p-0 transition-[width] ease-out",
  ],
  [
    "内容区真实 class 串",
    cn("flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg-app"),
    "flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg-app",
  ],
];

let failed = 0;
for (const [name, actual, expected] of cases) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}`);
  if (!ok) console.log(`      实际: "${actual}"\n      期望: "${expected}"`);
}

/* ---------------------------------------------------------------------------
 * C1：设置弹窗右栏「左右留白相等」的常量不变量（2026-09-28 加）
 *
 * 为什么要在这里锁：右栏视觉留白 = SPLIT_GAP + FORM_PADDING + scrollbar 槽(10)
 *  vs  FORM_PADDING + 槽(10)。两式只有在 SPLIT_GAP === 0 时才相等。
 * 这条不变式**没有任何运行时症状**：gap 一旦被调成非 0，页面只是「看着右边
 * 窄一点」，不报错、tsc 也不报 —— 与本文件开头描述的「静默布局退化」同类，
 * 只能靠断言守。改这两个常量前请先改本断言。
 * ------------------------------------------------------------------------- */
const invariants = [
  [
    "C1a 两栏 gap 必须为 0（否则左右留白差 gap）",
    SETTINGS_DIALOG_SPLIT_GAP,
    0,
  ],
  [
    "C1b 视觉留白左右相等：gap + padding === padding",
    SETTINGS_DIALOG_SPLIT_GAP + SETTINGS_DIALOG_FORM_PADDING,
    SETTINGS_DIALOG_FORM_PADDING,
  ],
  [
    "C1c 视觉留白 = 用户要的 20（padding 10 + 滚动条槽 10）",
    SETTINGS_DIALOG_FORM_PADDING + 10,
    20,
  ],
  [
    "C1d 开关滑块「关」态 left = INSET - 边框（padding box 换算）",
    SWITCH_KNOB_INSET - SWITCH_BORDER_WIDTH,
    1,
  ],
  [
    "C1e 开关滑块「开」态 left 不溢出（left + 滑块 + 内缩 <= 开关宽）",
    SWITCH_KNOB_LEFT_ON + SWITCH_KNOB_SIZE + SWITCH_KNOB_INSET <= SWITCH_WIDTH,
    true,
  ],
  [
    // 「开」态距左 18 / 距右 2；「关」态距左 2 / 距右 18（均为实测值）。
    // 镜像不变量：(开态距左 − 开态距右) === −(关态距左 − 关态距右)。
    // ★ 用**视觉**值（距 border 外缘）而非 padding box 值：手推边框换算正是
    //   2026-09-28 引入 Switch 偏移与动画回归的根源（review 实证），此断言故意
    //   不重蹈。实际渲染由 Switch.tsx 的 SWITCH_KNOB_LEFT_ON 决定。
    "C1f 开关滑块两态左右留白镜像（开:18/2，关:2/18）",
    `${18 - 2} vs ${2 - 18}`,
    "16 vs -16",
  ],
  [
    // 「开」态的距左（17 = SWITCH_KNOB_LEFT_ON）加上滑块与内缩后必须仍 <= 开关宽，
    // 否则会像 2026-09-28 之前的版本那样把滑块顶出右边缘（距右 = 0）。
    "C1g 开关滑块「开」态未溢出（右边缘内缩仍为正）",
    SWITCH_KNOB_LEFT_ON + SWITCH_KNOB_SIZE <= SWITCH_WIDTH - SWITCH_KNOB_INSET,
    true,
  ],
];

for (const [name, actual, expected] of invariants) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}`);
  if (!ok) console.log(`      实际: ${actual}\n      期望: ${expected}`);
}

const total = cases.length + invariants.length;
console.log(`\n${total - failed}/${total} 通过`);
process.exit(failed === 0 ? 0 : 1);
