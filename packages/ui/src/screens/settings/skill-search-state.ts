/**
 * 「添加技能」搜索结果行的状态判定（纯函数，无 JSX——供 SkillsSettingsTab 渲染
 * 与 `check:skill-search-state` 离线检查脚本共用；后者经 --experimental-strip-types
 * 直接 import 本文件）。
 *
 * **为什么状态判定要抽出来**：搜索结果行有三种互斥形态（可添加 / 已安装 /
 * 不支持安装），渲染层只该照状态画，不该自己揣着业务口径；而口径必须有
 * 单一出处并被离线断言钉住（浏览器探针打不到的组合——如「非 owner/repo
 * 来源」「同名但不同 scope」——在这里覆盖）。
 */

/** 与 core `skills-install.ts` 的 `SOURCE_PATTERN` 同口径：core 只认 `owner/repo`
 * 形态的 source，其余（skills.volces.com、open.feishu.cn 等注册表源）安装必 400。
 * 改这里必须同步改 core（反之亦然），探针 L9 钉的是 core 侧行为。 */
export const SKILL_SOURCE_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** 搜索结果行的安装状态 */
export type SkillSearchEntryState =
	| /** 非 `owner/repo` 来源：core 拒装（400），渲染成禁用徽标，不给可点的死按钮 */ "unsupported"
	| /** 当前安装范围下已有同名技能：渲染「已安装」徽标（再装必 409 冲突） */ "installed"
	| /** 可正常添加 */ "addable";

/**
 * 判定一条搜索结果在「当前安装范围」下的状态。
 *
 * **匹配口径（2026-09-30 用户裁决：按当前 scope）**：`installedNames` 由调用方
 * 按 **当前所选 scope** 的已装清单构建（`skills.filter(s => s.scope === addScope)`），
 * 与 core 409 冲突守卫的语义逐条对齐——同一 skillId 装进 user/project 是两个
 * 互不冲突的目录，所以切 scope 后同一条目从「已安装」变回「可添加」是**对的**。
 * **按 name（= skillId）匹配而非按来源仓库**：装哪个仓库的同名技能都落同一个
 * 目录（`sanitizeDirName(skillId)`），第二个必 409——两个不同仓库的同名 `tts`
 * 在装了其一之后都应显示「已安装」。package 来源的同名技能（origin=package，
 * 路径不在 skills 目录）同样计入：用户视角技能已存在，不鼓励重复安装遮蔽。
 */
export function resolveSkillSearchEntryState(
	source: string,
	skillId: string,
	installedNames: ReadonlySet<string>,
): SkillSearchEntryState {
	if (!SKILL_SOURCE_PATTERN.test(source)) return "unsupported";
	if (installedNames.has(skillId)) return "installed";
	return "addable";
}
