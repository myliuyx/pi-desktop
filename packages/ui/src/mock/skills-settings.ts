/**
 * C7 · 设置弹窗「技能」Tab 的 mock 数据（5180 默认形态数据源；live 走 `GET /skills`）。
 *
 * 口径对齐 `packages/core/src/contract.ts` 的 `SkillListItem`：
 * - 全局组（scope:"user"）混排 包贡献（origin:"package"）与目录发现（origin:"top-level"），
 *   与参考图1一致（GLOBAL 组里全是 superpowers 包贡献的技能）；
 * - 至少一条 enabled:false（空心点 + 开关关闭的演示态）；
 * - 项目组（scope:"project"）一条 —— live 未信任时不列（core 侧过滤），mock 恒展示。
 *
 * mock 形态的开关是**本地翻转**（不落盘、不通知 core）—— 它只负责把开关交互跑通。
 */

import type { SkillListItem, SkillsPayload } from "../../../core/src/contract.ts";

export const MOCK_SKILLS: SkillListItem[] = [
	{
		name: "web-content-fetcher",
		description:
			"Extract article content from any URL as clean Markdown. Uses fast HTTP with scored content-container selection and an automatic headless-browser fallback; preserves headings, links, images, lists and code blocks.",
		path: "~/.pi/agent/skills/web-content-fetcher/SKILL.md",
		scope: "user",
		origin: "package",
		packageSource: "git:github.com/obra/superpowers",
		enabled: true,
	},
	{
		name: "brainstorming",
		description:
			"Turn a vague idea into a concrete design through disciplined questioning: explore intent, alternatives and trade-offs before any implementation plan is written.",
		path: "~/.pi/agent/skills/brainstorming/SKILL.md",
		scope: "user",
		origin: "package",
		packageSource: "git:github.com/obra/superpowers",
		enabled: true,
	},
	{
		name: "test-driven-development",
		description:
			"Enforce red-green-refactor: write the failing test first, watch it fail for the right reason, then write the minimal code that makes it pass.",
		path: "~/.pi/agent/skills/test-driven-development/SKILL.md",
		scope: "user",
		origin: "package",
		packageSource: "git:github.com/obra/superpowers",
		enabled: true,
	},
	{
		name: "weekly-report",
		description: "把本周 git 提交整理成一份按项目分组的周报草稿（本地自建技能演示条目）。",
		path: "~/.pi/agent/skills/weekly-report/SKILL.md",
		scope: "user",
		origin: "top-level",
		enabled: false,
	},
	{
		name: "commit-helper",
		description: "按本仓库的提交规范（type(scope): 摘要）起草提交说明，含验收脚本结论段落。",
		path: "~/work/demo-project/.pi/skills/commit-helper/SKILL.md",
		scope: "project",
		origin: "top-level",
		enabled: true,
	},
];

export const MOCK_SKILLS_PAYLOAD: SkillsPayload = {
	skills: MOCK_SKILLS,
	trust: { trusted: true, reason: "会话默认信任（mock 演示数据）" },
	projectResourcesExist: true,
	projectTrustBlocked: false,
	filteredProjectCount: 0,
};
