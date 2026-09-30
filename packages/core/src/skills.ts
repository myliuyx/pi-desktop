/**
 * C7 · 设置弹窗「技能」Tab 的数据合并与开关写路径（server.ts 的 GET /skills / POST /skills/toggle）。
 *
 * ## 数据口径（task-settings-skills-plugins.md §三.1）
 *
 * `resourceLoader.getSkills()` 只回**已加载**技能 —— 被 `!路径` 模式禁用的不在其中，
 * 拿它当清单会让「关掉的技能」从列表里消失、再也打不开。所以清单以
 * `DefaultPackageManager.resolve()` 的**全量**结果为准（0.87.1 的 resolve 内部跑
 * `addAutoDiscoveredResources`，每条自带 enabled 标志），名称/描述优先从 getSkills()
 * 对齐，禁用项现场 `parseFrontmatter` 补齐（frontmatter 解析失败回落技能目录名）。
 *
 * ## 开关写路径（origin × scope 三分叉，均对 0.87.1 源码核实）
 *
 * - top-level + user    → 全局 settings `skills` 数组（`setSkillPaths`）
 * - top-level + project → 项目 settings `skills` 数组（`setProjectSkillPaths`）
 * - package             → 归属包的**对象过滤器** skills 字段 —— 字符串源的包资源默认
 *   全启用、**不受**全局模式数组管束（`applyPackageFilter` 只认包对象里的 skills 字段），
 *   禁用须升级为 `{source, skills:["!路径"]}`；**skills 数组被清空时必须整字段删除**
 *   （`{source, skills:[]}` 在 0.87.1 里=禁用整包技能，applyPackageFilter 既定语义）。
 *
 * ## 安全口径
 *
 * - `resolve()` 一律传 `onMissing → "skip"`：不传时 0.87.1 会对缺失包**静默安装**
 *   （resolvePackageSources 的 installMissing 分支）—— GET 端点绝不能出网。
 * - 落盘只走 SettingsManager（setter + flush），禁止直写 settings.json
 *   （会被其内存态回写覆盖，见规格书 §六.6）。
 */

import fs from "node:fs";
import path from "node:path";
import {
	DefaultPackageManager,
	hasTrustRequiringProjectResources,
	parseFrontmatter,
	type ResourceLoader,
	type SettingsManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import type { SkillListItem, SkillToggleRequest, SkillsPayload } from "./contract.ts";
import type { TrustHint } from "./resources.ts";
import { readSkillSourceRecord } from "./skills-install.ts";

/** toggle 定位不到技能时抛出（server.ts 据此回 404，与意外错误 500 区分） */
export class SkillNotFoundError extends Error {}

/** `resolve()` 的缺包动作：一律 skip —— 不传会被 0.87.1 静默安装（出网），GET 端点绝不允许 */
const skipMissing = async (): Promise<"skip"> => "skip";

/** 路径对齐键：resolve() 与 getSkills() 两路的字符串必须先归一到同一口径再比对 */
const norm = (p: string): string => path.resolve(p);

/** 现场解析 SKILL.md 的 name/description（禁用项在 getSkills 里不存在时的兜底；损坏回落目录名） */
function readSkillFrontmatter(filePath: string): { name: string; description: string } {
	const fallback = path.basename(path.dirname(filePath));
	try {
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(filePath, "utf8"));
		const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
		const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
		return { name: name || fallback, description };
	} catch {
		return { name: fallback, description: "" };
	}
}

/**
 * 全量技能清单：resolve() 全量 × getSkills() 元数据合并，按参考图分组排序
 * （「全局」在前、「项目」在后；temporary 与未信任项目技能不列）。
 */
export async function collectSkillsPayload(args: {
	packageManager: DefaultPackageManager;
	loader: ResourceLoader;
	trust: TrustHint | null;
	cwd: string;
}): Promise<SkillsPayload> {
	const resolved = await args.packageManager.resolve(skipMissing);
	const loaded = new Map<string, Skill>();
	for (const skill of args.loader.getSkills().skills) {
		loaded.set(norm(skill.filePath), skill);
	}

	const items: SkillListItem[] = [];
	let filteredProjectCount = 0;
	for (const entry of resolved.skills) {
		const meta = entry.metadata;
		// CLI --skill 临时注入不进清单（会话级、不落盘，无「开关」可言）
		if (meta.scope === "temporary") continue;
		// 未信任时不列项目技能（同 /resources 口径：它们本次根本没被加载，列出来是误导）
		if (meta.scope === "project" && args.trust?.trusted !== true) {
			filteredProjectCount += 1;
			continue;
		}
		const isPackage = meta.origin === "package";
		const known = loaded.get(norm(entry.path));
		const base = known
			? { name: known.name, description: known.description }
			: readSkillFrontmatter(entry.path);
		items.push({
			name: base.name,
			description: base.description,
			path: entry.path,
			scope: meta.scope === "project" ? "project" : "user",
			origin: isPackage ? "package" : "top-level",
			...(isPackage ? { packageSource: meta.source } : {}),
			// S6：top-level 技能透出安装来源（技能目录内的 .pi-source.json，安装时写入；
			// 无记录/损坏 = legacy 安装，字段缺省不造数据）。package 技能不带——它的归属
			// 由 packageSource 表达，语义不同。
			...(!isPackage ? { source: readSkillSourceRecord(path.dirname(entry.path))?.source } : {}),
			enabled: entry.enabled,
		});
	}
	items.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === "user" ? -1 : 1));

	// 信任门字段与 resources.ts 同源（04 屏同款：UI 据此说明「为什么项目组是空的」）
	const projectResourcesExist = hasTrustRequiringProjectResources(args.cwd);
	const trusted = args.trust?.trusted === true;

	return {
		skills: items,
		trust: args.trust ? { trusted: args.trust.trusted, reason: args.trust.reason } : null,
		projectResourcesExist,
		projectTrustBlocked: projectResourcesExist && !trusted,
		filteredProjectCount,
	};
}

/** 顶层数组的开关：禁用=追加精确排除模式（幂等）；启用=移除**我们写入的精确模式**（用户手写 glob 不动） */
function applyArrayToggle(current: string[], pattern: string, enabled: boolean): string[] {
	if (enabled) return current.filter((p) => p !== pattern);
	return current.includes(pattern) ? current : [...current, pattern];
}

/**
 * 包贡献技能的开关：写归属包对象过滤器的 skills 模式数组。
 * 项目级包存 project settings 的 packages 数组、用户级存全局（与
 * listConfiguredPackages 的 scope 口径一致）。
 */
function applyPackageSkillToggle(args: {
	settingsManager: SettingsManager;
	source: string;
	isProject: boolean;
	pattern: string;
	enabled: boolean;
}): void {
	const sm = args.settingsManager;
	const current = args.isProject ? (sm.getProjectSettings().packages ?? []) : sm.getPackages();
	const idx = current.findIndex((pkg) =>
		typeof pkg === "string" ? pkg === args.source : pkg.source === args.source,
	);
	if (idx < 0) {
		throw new Error(`未在 settings 中找到来源为「${args.source}」的插件包（可能来自临时注入或旧配置）`);
	}

	const next = current.map((pkg, i) => {
		if (i !== idx) return pkg;
		if (typeof pkg === "string") {
			// 纯字符串源：资源全启用 —— 禁用 = 升级为对象形并追加排除模式；启用 = 原样（幂等）
			return args.enabled ? pkg : { source: pkg, skills: [args.pattern] };
		}
		const before = pkg.skills ?? [];
		if (args.enabled) {
			// 排除模式本来就不在 → no-op（避免顺手清掉用户手写的其他过滤模式）
			if (!before.includes(args.pattern)) return pkg;
			const after = before.filter((s) => s !== args.pattern);
			if (after.length > 0) return { ...pkg, skills: after };
			const rest = { ...pkg };
			// 清空 = 禁用整包技能 —— 必须整字段删除，不能留空数组
			delete rest.skills;
			// 对象只剩 source 时塌回纯字符串，保持 settings 形状干净
			return Object.keys(rest).length === 1 ? rest.source : rest;
		}
		return before.includes(args.pattern) ? pkg : { ...pkg, skills: [...before, args.pattern] };
	});
	if (args.isProject) sm.setProjectPackages(next);
	else sm.setPackages(next);
}

/**
 * 切换技能启用态：按 origin × scope 写对应 settings 数组，flush 落盘。
 * **不在这里 reload** —— 会话热重载由 session.ts 的运行时方法负责（它才拿得到 AgentSession）。
 */
export async function toggleSkillInSettings(args: {
	packageManager: DefaultPackageManager;
	settingsManager: SettingsManager;
	req: SkillToggleRequest;
}): Promise<void> {
	// 用**当前** resolve 结果定位目标：路径不存在直接报错（不静默 no-op ——
	// 技能被删/被移走时 UI 要拿到明确失败，而不是「切了但什么都没发生」）
	const resolved = await args.packageManager.resolve(skipMissing);
	const target = resolved.skills.find((entry) => norm(entry.path) === norm(args.req.path));
	if (!target) {
		throw new SkillNotFoundError(`技能不存在或已被移除：${args.req.path}`);
	}

	const pattern = `!${target.path}`;
	const meta = target.metadata;

	if (meta.origin === "package") {
		applyPackageSkillToggle({
			settingsManager: args.settingsManager,
			source: meta.source,
			isProject: meta.scope === "project",
			pattern,
			enabled: args.req.enabled,
		});
	} else if (meta.scope === "project") {
		const current = args.settingsManager.getProjectSettings().skills ?? [];
		args.settingsManager.setProjectSkillPaths(applyArrayToggle(current, pattern, args.req.enabled));
	} else {
		const current = args.settingsManager.getSkillPaths();
		args.settingsManager.setSkillPaths(applyArrayToggle(current, pattern, args.req.enabled));
	}
	// setter 内部已标记 modified；flush 确保落盘完成后再由调用方 reload（避免读到半态）
	await args.settingsManager.flush();
}
