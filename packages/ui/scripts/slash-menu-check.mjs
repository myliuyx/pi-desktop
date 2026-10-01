/**
 * 斜杠命令触发区间检测断言 —— 确定性、不起浏览器。
 * 运行：node --experimental-strip-types scripts/slash-menu-check.mjs
 */

import { computeSlashState } from "../src/lib/slash.ts";

const checks = [];
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	checks.push(ok);
	console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`}`);
};

check("行首 /", computeSlashState("/", 1), { start: 0, end: 1, query: "" });
check("行首 /re", computeSlashState("/re", 3), { start: 0, end: 3, query: "re" });
check("空白后 /co", computeSlashState("hello /co", 9), { start: 6, end: 9, query: "co" });
check("多行：换行后 /", computeSlashState("第一行\n/re", 7), { start: 4, end: 7, query: "re" });
check("路径里的 / 不触发", computeSlashState("path/to", 7), null);
check("a/b 不触发", computeSlashState("a/b", 3), null);
check("斜杠后已有空格不触发", computeSlashState("/re ", 4), null);
check("邮箱式 a@b 不触发", computeSlashState("a@b", 3), null);
check("光标在 token 中间", computeSlashState("/reload", 3), { start: 0, end: 3, query: "re" });

const failed = checks.filter((ok) => !ok).length;
console.log(failed === 0 ? `\n全部通过（${checks.length} 项）` : `\n失败 ${failed}/${checks.length}`);
process.exitCode = failed === 0 ? 0 : 1;