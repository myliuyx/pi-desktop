/**
 * C8 · 设置弹窗「插件」Tab 的数据合并与写路径（GET /packages / POST /packages/*）。
 *
 * ## 数据口径（task-settings-skills-plugins.md §三.5）
 *
 * - 包清单 = `DefaultPackageManager.listConfiguredPackages()`（settings `packages`
 *   数组的 **user + project 双 scope 全量**，每项带 installedPath）—— 缺失未装的包
 *   也在列（status:"missing"），否则「添加失败/被删」的包会从清单里凭空消失。
 * - 资源明细 = `resolve(onMissing=skip)` 的全量结果，按 `metadata.origin==="package"
 *   && metadata.source===包 source` 归属过滤（与 skills.ts 识别包技能是同一判据）。
 * - 包元数据（name/version/description）= 安装目录 package.json；本地路径包没有
 *   package.json 时 name 回落目录名，version/description **不设键**（不造假数据）。
 * - 状态：loaded = 该包有扩展已加载（getExtensions() 的 sourceInfo 归属匹配）；
 *   installed = 在装但无扩展加载（只贡献技能/被禁用）；missing = settings 有但未安装。
 * - 底部统计条 totals = resolve() 四类的**启用**计数（参考图2「2 ext · 14 skills · …」
 *   的「当前生效」口径）。
 *
 * ## 写路径（0.87.1 已核实）
 *
 * - 开关 = 对象形 PackageSource：禁用 = `{source, autoload:false}`（autoload:false
 *   时该包资源整体不加载，applyPackageDeltaFilter 语义）；启用 = 去掉 autoload:false
 *   （对象只剩 source 时塌回纯字符串，保持 settings 形状干净）。
 * - 移除 = `removeAndPersist(source, {local: scope==="project"})`（npm 卸载/git 删克隆/
 *   本地仅删 settings 条目，均内部落盘）。
 * - 安装 = `installAndPersist(source, {local})`；进度经 `setProgressCallback` 桥接
 *   SSE（session.ts 挂回调）。检查更新 = `checkForAvailableUpdates()`（npm view /
 *   git ls-remote，需联网；本地包自动跳过）。
 * - 落盘一律经 SettingsManager（PM 内部写 + 我们补 flush），禁止直写 settings.json。
 */

import fs from "node:fs";
import path from "node:path";
import {
	DefaultPackageManager,
	type ResourceLoader,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
	PackageDetail,
	PackageRemoveRequest,
	PackageResourceRef,
	PackageToggleRequest,
	PackageUpdateEntry,
	PackagesPayload,
} from "./contract.ts";

/** toggle 定位不到包时抛出（server.ts 据此回 404，与意外错误 500 区分） */
export class PackageNotFoundError extends Error {}

/** `resolve()` 的缺包动作：一律 skip —— 清单端点绝不能静默安装（出网） */
const skipMissing = async (): Promise<"skip"> => "skip";

const RESOURCE_KINDS = ["extensions", "skills", "prompts", "themes"] as const;
const KIND_LABELS: Record<(typeof RESOURCE_KINDS)[number], string> = {
	extensions: "扩展",
	skills: "技能",
	prompts: "提示词",
	themes: "主题",
};

/** resolve() 条目 → 展示名（扩展/提示词/主题=文件名去后缀；技能=SKILL.md 的父目录名） */
function refName(kind: (typeof RESOURCE_KINDS)[number], filePath: string): string {
	const base = path.basename(filePath);
	if (kind === "skills") return path.basename(path.dirname(filePath));
	return base.replace(/\.[^.]+$/, "");
}

/** 读安装目录 package.json 的 name/version/description（缺失/损坏返回空对象，不抛） */
function readPackageJson(dir: string): { name?: string; version?: string; description?: string } {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
		const str = (k: string) => (typeof parsed[k] === "string" ? (parsed[k] as string) : undefined);
		return { name: str("name"), version: str("version"), description: str("description") };
	} catch {
		return {};
	}
}

/** settings 某包条目的启用态：字符串=启用；对象看 autoload（!== false 即启用） */
function entryEnabled(
	settingsManager: SettingsManager,
	source: string,
	scope: "user" | "project",
): boolean {
	const arr =
		scope === "project"
			? (settingsManager.getProjectSettings().packages ?? [])
			: settingsManager.getPackages();
	const entry = arr.find((p) => (typeof p === "string" ? p === source : p.source === source));
	if (entry === undefined) return true;
	return typeof entry === "string" ? true : entry.autoload !== false;
}

/**
 * 插件全量清单：listConfiguredPackages × resolve 资源归属 × 安装目录元数据。
 * 失败抛错（端点 500 + 原文）。
 */
export async function collectPackagesPayload(args: {
	packageManager: DefaultPackageManager;
	loader: ResourceLoader;
	settingsManager: SettingsManager;
	cwd: string;
}): Promise<PackagesPayload> {
	const resolved = await args.packageManager.resolve(skipMissing);
	const configured = args.packageManager.listConfiguredPackages();

	// 已加载扩展的归属判定：sourceInfo.origin==="package" && source===包 source（与 skills 同判据）
	const loadedPackageSources = new Set(
		args.loader
			.getExtensions()
			.extensions.map((ext) => {
				const info = ext.sourceInfo;
				return info && info.origin === "package" ? info.source : null;
			})
			.filter((s): s is string => typeof s === "string"),
	);

	const packages: PackageDetail[] = configured.map((pkg) => {
		const resources: Record<(typeof RESOURCE_KINDS)[number], PackageResourceRef[]> = {
			extensions: [],
			skills: [],
			prompts: [],
			themes: [],
		};
		for (const kind of RESOURCE_KINDS) {
			resources[kind] = resolved[kind]
				.filter((r) => r.metadata.origin === "package" && r.metadata.source === pkg.source)
				.map((r) => ({ name: refName(kind, r.path), path: r.path, enabled: r.enabled }));
		}

		const meta = pkg.installedPath ? readPackageJson(pkg.installedPath) : {};
		const name = meta.name ?? (pkg.installedPath ? path.basename(pkg.installedPath) : undefined);

		let status: PackageDetail["status"];
		if (!pkg.installedPath) {
			status = "missing";
		} else {
			status = loadedPackageSources.has(pkg.source) ? "loaded" : "installed";
		}

		const counts = RESOURCE_KINDS.map((kind) => resources[kind].length);
		const resourceSummary = counts.every((c) => c === 0)
			? "无"
			: counts
					.map((c, i) => (c > 0 ? `${c}${KIND_LABELS[RESOURCE_KINDS[i]]}` : null))
					.filter((s): s is string => s !== null)
					.join("·");

		return {
			source: pkg.source,
			scope: pkg.scope,
			enabled: entryEnabled(args.settingsManager, pkg.source, pkg.scope),
			...(pkg.installedPath ? { installedPath: pkg.installedPath } : {}),
			...(name ? { name } : {}),
			...(meta.version ? { version: meta.version } : {}),
			...(meta.description ? { description: meta.description } : {}),
			status,
			resources,
			resourceSummary,
		};
	});

	// 底部统计条：全量四类启用计数（参考图2「当前生效」口径）
	const totals = { extensions: 0, skills: 0, prompts: 0, themes: 0 };
	for (const kind of RESOURCE_KINDS) {
		totals[kind] = resolved[kind].filter((r) => r.enabled).length;
	}

	return { packages, totals, cwd: args.cwd };
}

/**
 * 整包开关：写 settings `packages` 数组的对象形（禁用=`{source, autoload:false}`）。
 * 不在这里 reload —— 会话热重载由 session.ts 的运行时方法负责。
 */
export function togglePackageInSettings(args: {
	settingsManager: SettingsManager;
	req: PackageToggleRequest;
}): void {
	const sm = args.settingsManager;
	const isProject = args.req.scope === "project";
	const current = isProject ? (sm.getProjectSettings().packages ?? []) : sm.getPackages();
	const idx = current.findIndex((p) =>
		typeof p === "string" ? p === args.req.source : p.source === args.req.source,
	);
	if (idx < 0) {
		throw new PackageNotFoundError(`未在 settings 中找到插件包：${args.req.source}`);
	}

	const next = current.map((pkg, i) => {
		if (i !== idx) return pkg;
		if (args.req.enabled) {
			if (typeof pkg === "string" || pkg.autoload !== false) return pkg;
			const rest = { ...pkg };
			delete rest.autoload;
			// 对象只剩 source 时塌回纯字符串，保持 settings 形状干净
			return Object.keys(rest).length === 1 ? rest.source : rest;
		}
		if (typeof pkg === "string") return { source: pkg, autoload: false };
		return pkg.autoload === false ? pkg : { ...pkg, autoload: false };
	});
	if (isProject) sm.setProjectPackages(next);
	else sm.setPackages(next);
}

/** 移除包：removeAndPersist 内部落盘（npm 卸载 / git 删克隆 / 本地仅删 settings 条目） */
export async function removePackageFromSettings(args: {
	packageManager: DefaultPackageManager;
	req: PackageRemoveRequest;
}): Promise<void> {
	await args.packageManager.removeAndPersist(args.req.source, {
		local: args.req.scope === "project",
	});
}

/** 检查更新（npm view / git ls-remote，需联网；本地路径包自动跳过） */
export async function checkPackageUpdates(pm: DefaultPackageManager): Promise<PackageUpdateEntry[]> {
	return pm.checkForAvailableUpdates();
}
