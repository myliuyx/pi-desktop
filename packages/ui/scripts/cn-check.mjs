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

console.log(`\n${cases.length - failed}/${cases.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
