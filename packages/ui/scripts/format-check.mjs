/**
 * 数值格式化边界断言 —— 纯函数，不需要浏览器。
 * 运行：npm run check:format
 */
import { formatCompact } from "../src/lib/format.ts";

const cases = [
  [0, "0"],
  [999, "999"],
  [1000, "1k"],
  [1995, "2.0k"],
  [12400, "12.4k"],
  [128000, "128k"],
  [200000, "200k"],
  [999949, "999.9k"],
  [999950, "1.0M"],
  [999999, "1.0M"],
  [1000000, "1.0M"],
  [1048576, "1.0M"],
  [9500000, "9.5M"],
  [9999999, "10M"],
];

let failed = 0;
for (const [input, expected] of cases) {
  const actual = formatCompact(input);
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} formatCompact(${input}) = ${JSON.stringify(actual)}（期望 ${JSON.stringify(expected)}）`);
}
if (failed > 0) {
  console.error(`\n格式化断言失败 ${failed} 项`);
  process.exit(1);
}
console.log(`格式化断言全部通过：${cases.length} 项`);