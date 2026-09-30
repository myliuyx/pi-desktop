/**
 * 「添加技能」搜索结果行状态判定检查 —— `check:skill-search-state`（S5/S6 · 2026-09-30）。
 *
 * 钉 `src/screens/settings/skill-search-state.ts` 的四态口径。为什么单独有本脚本：
 * 搜索/安装只在 live 形态可用（mock 直接 toast 拒绝），浏览器探针打不到可控的组合
 * （非 owner/repo 来源、不同来源撞名、legacy 无记录）——这些在纯函数层离线钉死，
 * 探针 L11/L12 只做「渲染层与 helper 同口径」的一致性断言。
 *
 * 用法（在 packages/ui 下）：`npm run check:skill-search-state`
 */
import { resolveSkillSearchEntryState } from "../src/screens/settings/skill-search-state.ts";

let failed = 0;
const check = (name, pass, detail) => {
	console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
	if (!pass) failed += 1;
};
const state = (source, skillId, installed) => resolveSkillSearchEntryState(source, skillId, installed);

/* ---- unsupported：非 owner/repo 形态（注册表源），core 必 400，不给可点死按钮 ---- */
check(
	"注册表源（skills.volces.com）→ unsupported",
	state("skills.volces.com", "tts", []) === "unsupported",
	"skills.volces.com",
);
check(
	"带协议/路径的来源 → unsupported（core SOURCE_PATTERN 只收 owner/repo）",
	state("https://github.com/owner/repo", "tts", []) === "unsupported" &&
		state("owner/repo/tree/main", "tts", []) === "unsupported",
	"https 形态与子路径形态",
);
check(
	"反事实对拍：owner/repo 形态不判 unsupported（否则上一条恒真）",
	state("aahl/skills", "edge-tts", []) === "addable",
	"aahl/skills",
);

/* ---- installed：同一来源已装（S6 精确匹配）---- */
check(
	"同来源同名 → installed（就是装过的那个）",
	state("shirenchuang/web-content-fetcher", "web-content-fetcher", [
		{ name: "web-content-fetcher", source: "shirenchuang/web-content-fetcher" },
	]) === "installed",
	"shirenchuang 精确命中",
);
check(
	"反事实对拍：来源不同时不判 installed（否则上一条恒真，S6 修的正是这个）",
	state("shino369/claude-code-personal-workspace", "web-content-fetcher", [
		{ name: "web-content-fetcher", source: "shirenchuang/web-content-fetcher" },
	]) === "conflict",
	"shino369 撞 shirenchuang 的名",
);

/* ---- conflict：不同来源撞名 / legacy 无记录（2026-09-30 裁决 B）---- */
check(
	"不同来源同名 → conflict（名字被占，再装必 409）",
	state("noizai/skills", "tts", [{ name: "tts", source: "marswaveai/skills" }]) === "conflict",
	"noizai 撞 marswaveai 的 tts",
);
check(
	"legacy 无记录（source 缺省）→ conflict（裁决 B：无法证明装过的就是这条，诚实显冲突）",
	state("shirenchuang/web-content-fetcher", "web-content-fetcher", [{ name: "web-content-fetcher" }]) ===
		"conflict" &&
		state("shino369/claude-code-personal-workspace", "web-content-fetcher", [{ name: "web-content-fetcher" }]) ===
			"conflict",
	"两个来源撞 legacy 安装都显 conflict",
);
check(
	"反事实对拍：名字未命中 → addable 而非 conflict（否则上一条恒真）",
	state("aahl/skills", "edge-tts", [{ name: "other-skill", source: "aahl/skills" }]) === "addable",
	"other-skill",
);

/* ---- 匹配维度与优先级 ---- */
check(
	"匹配只看 name 定位 + source 区分：同 scope 语义由调用方保证（helper 只认入参数组，纯粹性）",
	state("a/b", "x", [{ name: "x", source: "a/b" }]) === "installed" &&
		state("c/d", "x", [{ name: "x", source: "a/b" }]) === "conflict" &&
		state("a/b", "y", [{ name: "x", source: "a/b" }]) === "addable",
	"installed 数组即全部事实",
);
check(
	"优先级：unsupported 压过 installed/conflict（来源不支持时点击路径不存在，状态不误导）",
	state("skills.volces.com", "tts", [{ name: "tts", source: "shirenchuang/web-content-fetcher" }]) ===
		"unsupported" && state("skills.volces.com", "tts", [{ name: "tts" }]) === "unsupported",
	"unsupported > installed/conflict",
);
check(
	"package 来源的同名技能（无 source 记录）按 legacy 裁决显 conflict（用户视角技能已存在）",
	state("obra/superpowers", "brainstorming", [{ name: "brainstorming" }]) === "conflict",
	"brainstorming legacy",
);

console.log(failed === 0 ? "\nskill-search-state 检查全部通过" : `\nskill-search-state 检查失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
