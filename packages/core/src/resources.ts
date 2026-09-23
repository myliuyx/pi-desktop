/**
 * C5 · 04 屏数据源 —— `resourceLoader` 的三类清单（扩展 / 提示词 / 技能）。
 *
 * ## 三类数据的出处（`S6 §五` 04 屏行）
 *
 * | 我们的分组 | Pi 的 getter | 依据 |
 * |---|---|---|
 * | 扩展 | `resourceLoader.getExtensions().extensions` | `resource-loader.ts:30` |
 * | 提示词 | `resourceLoader.getPrompts().prompts` | `resource-loader.ts:35` |
 * | 技能 | `resourceLoader.getSkills().skills` | `resource-loader.ts:31` |
 *
 * 工具开关（read/bash/edit/write）**不在这里** —— 它走 Pi 的 `tools` allowlist，
 * 04 屏当前仍用本地持久化（`ui-store.enabledTools`），接入 `setActiveToolsByName` 记为遗留。
 *
 * ## 信任门过滤（`S6 §四·3`：04 屏扩展清单同语义过滤）
 *
 * `SourceInfo.scope`（`source-info.d.ts`）有三个取值：`user` / `project` / `temporary`。
 * **未信任时直接不列 `scope === "project"` 的项目本地资源** —— 它们本次根本没被执行，
 * 列出来等于告诉用户「这些扩展已生效」（误导）。被过滤的条数随 `filteredProjectCount` 返回，
 * UI 可以据此说明原因（而不是让清单凭空变短）。
 *
 * `hidden === true` 的扩展同样不列（Pi 只对 named inline extension 置该标记，语义就是「不展示」）。
 */

import { hasTrustRequiringProjectResources, type Extension, type PromptTemplate, type ResourceLoader, type Skill } from "@earendil-works/pi-coding-agent";
import type { ResourceEntry, ResourcesPayload } from "./contract.ts";

/** 信任结论（只用得到这两个字段，避免把 trust.ts 的类型绑死在这里） */
export interface TrustHint {
  trusted: boolean;
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

/** `SourceInfo.scope` → 04 屏的「来源」标签 */
function scopeLabel(scope: unknown): string {
  switch (scope) {
    case "user":
      return "用户目录";
    case "project":
      return "项目内";
    case "temporary":
      return "临时";
    default:
      return "内置";
  }
}

/** 取 `sourceInfo.scope`（Pi 的 SourceInfo 一定存在，但过 HTTP 的旧数据可能缺，防御一下） */
function scopeOf(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  const info = item.sourceInfo;
  return isRecord(info) && typeof info.scope === "string" ? info.scope : undefined;
}

const isProjectLocal = (scope: string | undefined): boolean => scope === "project";

/** 项目本地资源是否放行（信任门结论是唯一判据；`null` 视为未信任，安全默认） */
function allowed(scope: string | undefined, trust: TrustHint | null): boolean {
  return !isProjectLocal(scope) || trust?.trusted === true;
}

function extensionEntry(ext: Extension): ResourceEntry {
  const file = typeof ext.resolvedPath === "string" ? ext.resolvedPath : ext.path;
  const base = (file ?? "").split(/[/\\]/).pop() ?? "extension";
  const name = base.replace(/\.[^.]+$/, "");
  const toolCount = ext.tools instanceof Map ? ext.tools.size : 0;
  const commandCount = ext.commands instanceof Map ? ext.commands.size : 0;
  const bits = [`${toolCount} 工具`, `${commandCount} 命令`];
  return {
    id: `ext-${name}`,
    name,
    description: bits.join(" · "),
    source: scopeLabel(scopeOf(ext)),
  };
}

function promptEntry(prompt: PromptTemplate): ResourceEntry {
  const description = prompt.description || prompt.argumentHint || "";
  return {
    id: `prompt-${prompt.name}`,
    // 与 mock 数据同形：提示词带前导斜杠（它本来就是一个斜杠命令）
    name: `/${prompt.name}`,
    description,
    source: scopeLabel(scopeOf(prompt)),
  };
}

function skillEntry(skill: Skill): ResourceEntry {
  return {
    id: `skill-${skill.name}`,
    name: skill.name,
    description: skill.description ?? "",
    source: scopeLabel(scopeOf(skill)),
  };
}

/**
 * 汇总三类清单并按信任结论过滤。
 * `trust === null`（会话尚未就绪）按**未信任**处理 —— 宁少列、不多列。
 */
export function collectResources(loader: ResourceLoader, trust: TrustHint | null, options: { cwd: string }): ResourcesPayload {
  const extensions = loader.getExtensions().extensions.filter((ext) => ext.hidden !== true);
  const skills = loader.getSkills().skills;
  const prompts = loader.getPrompts().prompts;

  const projectLocalCount =
    extensions.filter((ext) => isProjectLocal(scopeOf(ext))).length +
    skills.filter((skill) => isProjectLocal(scopeOf(skill))).length +
    prompts.filter((prompt) => isProjectLocal(scopeOf(prompt))).length;

  const kept = {
    extensions: extensions.filter((ext) => allowed(scopeOf(ext), trust)),
    skills: skills.filter((skill) => allowed(scopeOf(skill), trust)),
    prompts: prompts.filter((prompt) => allowed(scopeOf(prompt), trust)),
  };

  // 被「我们」剔除的条数（实测常为 0：未信任时 Pi 自己就没加载项目本地资源，见契约注释）
  const stillListed = projectLocalCount
    ? kept.extensions.filter((ext) => isProjectLocal(scopeOf(ext))).length +
      kept.skills.filter((skill) => isProjectLocal(scopeOf(skill))).length +
      kept.prompts.filter((prompt) => isProjectLocal(scopeOf(prompt))).length
    : 0;

  // 纯谓词，不加载任何东西：该目录是否存在受信任门管辖的资源
  const projectResourcesExist = hasTrustRequiringProjectResources(options.cwd);
  const trusted = trust?.trusted === true;

  return {
    extensions: kept.extensions.map(extensionEntry),
    prompts: kept.prompts.map(promptEntry),
    skills: kept.skills.map(skillEntry),
    trust: trust ? { trusted: trust.trusted, reason: trust.reason } : null,
    projectResourcesExist,
    projectTrustBlocked: projectResourcesExist && !trusted,
    filteredProjectCount: Math.max(0, projectLocalCount - stillListed),
  };
}
