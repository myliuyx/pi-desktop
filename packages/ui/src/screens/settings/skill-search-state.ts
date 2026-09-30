/**
 * 「添加技能」搜索结果行的状态判定（纯函数，无 JSX——供 SkillsSettingsTab 渲染
 * 与 `check:skill-search-state` 离线检查脚本共用；后者经 --experimental-strip-types
 * 直接 import 本文件）。
 *
 * **为什么状态判定要抽出来**：搜索结果行有四种互斥形态（可添加 / 已安装 /
 * 同名冲突 / 不支持安装），渲染层只该照状态画，不该自己揣着业务口径；而口径
 * 必须有单一出处并被离线断言钉住（浏览器探针打不到的组合——如「非 owner/repo
 * 来源」「不同来源撞名」——在这里覆盖）。
 */

/** 与 core `skills-install.ts` 的 `SOURCE_PATTERN` 同口径：core 只认 `owner/repo`
 * 形态的 source，其余（skills.volces.com、open.feishu.cn 等注册表源）安装必 400。
 * 改这里必须同步改 core（反之亦然），探针 L9 钉的是 core 侧行为。 */
export const SKILL_SOURCE_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** 已装技能的最小引用（来自 `/skills` 的 SkillListItem，只取判定所需两字段） */
export interface InstalledSkillRef {
	name: string;
	/** 安装来源仓库（core 安装时写 `.pi-source.json`、`/skills` 透出，S6）。
	 * 缺省 = legacy 安装（S6 之前装的，无记录）。 */
	source?: string;
}

/** 搜索结果行的安装状态 */
export type SkillSearchEntryState =
	| /** 非 `owner/repo` 来源：core 拒装（400），渲染成禁用徽标，不给可点的死按钮 */ "unsupported"
	| /** 当前范围下同一来源已装（或 legacy 无记录的同名）：渲染「已安装」徽标 */ "installed"
	| /** 当前范围下**不同来源**的同名技能已装：渲染「同名冲突」徽标（再装必 409） */ "conflict"
	| /** 可正常添加 */ "addable";

/**
 * 判定一条搜索结果在「当前安装范围」下的状态。
 *
 * **匹配口径（2026-09-30 裁决）**：按 **当前所选 scope** 比对——`installed` 由调用方
 * 按 `skills.filter(s => s.scope === addScope)` 构建，与 core 409 冲突守卫的语义
 * 逐条对齐（user/project 是两个互不冲突的目录）。**按 name（= skillId）定位 +
 * 按 source 精确区分（S6）**：安装目录由 skillId 生成，不同来源的同名技能落同一个
 * 目录——
 * - `hit.source` 缺省（legacy，S6 之前的存量安装）：**「同名冲突」**（2026-09-30
 *   用户裁决 B）——数据上无法证明装过的就是这条，显示「已安装」对撞名行是误导；
 *   tooltip 注明「旧版安装未记录来源，删除重装一次后可精确识别」。
 * - `hit.source` 存在且等于本条 source → 「已安装」（就是装过的那个）。
 * - `hit.source` 存在且不同 → 「同名冲突」（名字被别的仓库占了，再装必 409）。
 */
export function resolveSkillSearchEntryState(
	source: string,
	skillId: string,
	installed: ReadonlyArray<InstalledSkillRef>,
): SkillSearchEntryState {
	if (!SKILL_SOURCE_PATTERN.test(source)) return "unsupported";
	const hit = installed.find((s) => s.name === skillId);
	if (!hit) return "addable";
	if (hit.source === undefined) return "conflict";
	return hit.source === source ? "installed" : "conflict";
}
