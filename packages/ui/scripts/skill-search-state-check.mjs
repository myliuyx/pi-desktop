/**
 * 「添加技能」搜索结果行状态判定检查 —— `check:skill-search-state`（S5 · 2026-09-30）。
 *
 * 钉 `src/screens/settings/skill-search-state.ts` 的三态口径。为什么单独有本脚本：
 * 搜索/安装只在 live 形态可用（mock 直接 toast 拒绝），浏览器探针打不到可控的组合
 * （非 owner/repo 来源、同名不同 scope、不同来源同名技能）——这些在纯函数层离线钉死，
 * 探针 L11 只做「渲染层与 helper 同口径」的一致性断言。
 *
 * 用法（在 packages/ui 下）：`npm run check:skill-search-state`
 */
import { resolveSkillSearchEntryState } from "../src/screens/settings/skill-search-state.ts";

let failed = 0;
const check = (name, pass, detail) => {
	console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
	if (!pass) failed += 1;
};

/* ---- unsupported：非 owner/repo 形态（注册表源），core 必 400，不给可点死按钮 ---- */
check(
	"注册表源（skills.volces.com）→ unsupported",
	resolveSkillSearchEntryState("skills.volces.com", "tts", new Set()) === "unsupported",
	"skills.volces.com",
);
check(
	"站点源（open.feishu.cn）→ unsupported",
	resolveSkillSearchEntryState("open.feishu.cn", "doc-export", new Set()) === "unsupported",
	"open.feishu.cn",
);
check(
	"带协议/路径的来源 → unsupported（core SOURCE_PATTERN 只收 owner/repo）",
	resolveSkillSearchEntryState("https://github.com/owner/repo", "tts", new Set()) === "unsupported" &&
		resolveSkillSearchEntryState("owner/repo/tree/main", "tts", new Set()) === "unsupported",
	"https 形态与子路径形态",
);
check(
	"反事实对拍：owner/repo 形态不判 unsupported（否则上一条恒真）",
	resolveSkillSearchEntryState("aahl/skills", "edge-tts", new Set()) === "addable",
	"aahl/skills",
);

/* ---- installed：当前 scope 同名（installedNames 由调用方按 scope 构建） ---- */
check(
	"同名已装 → installed",
	resolveSkillSearchEntryState("aahl/skills", "edge-tts", new Set(["edge-tts"])) === "installed",
	"edge-tts",
);
check(
	"不同来源的同名技能同样 installed（装谁都落同一个 sanitizeDirName(skillId) 目录，第二个必 409）",
	resolveSkillSearchEntryState("noizai/skills", "tts", new Set(["tts"])) === "installed" &&
		resolveSkillSearchEntryState("marswaveai/skills", "tts", new Set(["tts"])) === "installed",
	"noizai 与 marswaveai 的同名 tts",
);
check(
	"反事实对拍：集合里没有该名 → addable 而非 installed（否则上一条恒真）",
	resolveSkillSearchEntryState("aahl/skills", "edge-tts", new Set(["other-skill"])) === "addable",
	"other-skill",
);
check(
	"package 来源的同名技能计入 installed 是调用方职责：helper 只认集合（scope 过滤发生在组件 useMemo，此处钉纯粹性）",
	resolveSkillSearchEntryState("obra/superpowers", "brainstorming", new Set(["brainstorming"])) === "installed" &&
		resolveSkillSearchEntryState("obra/superpowers", "brainstorming", new Set()) === "addable",
	"集合有/无 brainstorming",
);

/* ---- 优先级：unsupported 压过 installed（来源都不支持时没有「已安装」可言） ---- */
check(
	"优先级：非 owner/repo 来源即使同名已装也是 unsupported（点击路径不存在，状态不误导）",
	resolveSkillSearchEntryState("skills.volces.com", "tts", new Set(["tts"])) === "unsupported",
	"unsupported > installed",
);

console.log(failed === 0 ? "\nskill-search-state 检查全部通过" : `\nskill-search-state 检查失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
