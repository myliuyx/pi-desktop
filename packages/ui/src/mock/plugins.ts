/**
 * C8 · 设置弹窗「插件」Tab 的 mock 数据（5180 默认形态数据源；live 走 `GET /packages`）。
 *
 * 口径对齐参考图2（主控 2026-09-28 截图）：
 * - 全局组两个包：`git:github.com/obra/superpowers`（1扩展·14技能·Loaded·已安装 6.3.0）
 *   + 本地路径包（1扩展）→ 底部统计条 =「2 ext · 14 skills · 0 prompts · 0 themes」；
 * - 技能资源名与参考图一一对应（brainstorming … writing-skills 共 14 条）；
 * - mock 形态的开关/移除是**本地变更**（不落盘、不通知 core），只负责把交互跑通。
 */

import type { PackageDetail, PackagesPayload } from "../../../core/src/contract.ts";

const SUPERPOWERS_ROOT = "~/.pi/agent/git/github.com/obra/superpowers";

/** 参考图2 里 superpowers 包贡献的 14 个技能（名称与路径一一对应） */
const SUPERPOWERS_SKILLS = [
	"brainstorming",
	"dispatching-parallel-agents",
	"executing-plans",
	"finishing-a-development-branch",
	"receiving-code-review",
	"requesting-code-review",
	"subagent-driven-development",
	"systematic-debugging",
	"test-driven-development",
	"using-git-worktrees",
	"using-superpowers",
	"verification-before-completion",
	"writing-plans",
	"writing-skills",
] as const;

export const MOCK_PACKAGES: PackageDetail[] = [
	{
		source: "git:github.com/obra/superpowers",
		scope: "user",
		enabled: true,
		installedPath: SUPERPOWERS_ROOT,
		name: "superpowers",
		version: "6.3.0",
		description: "Superpowers skills and runtime bootstrap for coding agents",
		status: "loaded",
		resources: {
			extensions: [
				{
					name: "superpowers",
					path: `${SUPERPOWERS_ROOT}/.pi/extensions/superpowers.ts`,
					enabled: true,
				},
			],
			skills: SUPERPOWERS_SKILLS.map((skillName) => ({
				name: skillName,
				path: `${SUPERPOWERS_ROOT}/skills/${skillName}/SKILL.md`,
				enabled: true,
			})),
			prompts: [],
			themes: [],
		},
		resourceSummary: "1扩展·14技能",
	},
	{
		source: "~/agent_work/pi-think-zh",
		scope: "user",
		enabled: true,
		installedPath: "~/agent_work/pi-think-zh",
		name: "pi-think-zh",
		status: "loaded",
		resources: {
			extensions: [
				{
					name: "think-zh",
					path: "~/agent_work/pi-think-zh/extensions/think-zh.ts",
					enabled: true,
				},
			],
			skills: [],
			prompts: [],
			themes: [],
		},
		resourceSummary: "1扩展",
	},
];

export const MOCK_PACKAGES_PAYLOAD: PackagesPayload = {
	packages: MOCK_PACKAGES,
	totals: { extensions: 2, skills: 14, prompts: 0, themes: 0 },
	cwd: "~/work/demo-project",
};
