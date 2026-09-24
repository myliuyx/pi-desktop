/**
 * Provider 保存前校验（2026-09-24 用户要求）。
 *
 * 规则：**启用的** Provider 必须填写 Base URL 与 API key，否则不允许保存。
 *
 * 为什么只校验「启用的」：停用是唯一能「先存个半成品、晚点再配」的途径
 * （停用项落 sidecar，不参与 Pi 链路，残缺无害）。若连停用项也要填，
 * 用户就没有任何中途保存的办法了。
 *
 * 为什么必须有这条闸（而不是只靠 core 的 warning）：空 apiKey / baseUrl 在 Pi 那边
 * 不是「没填」而是**非法值**，会让整份 models.json 校验失败、所有 Provider 一起消失；
 * 与其保存完再报错，不如在保存前拦住并指到字段上。
 *
 * 本文件是**唯一判据**：「保存拦截」（SettingsDialog）与「字段就地红字提示」
 * （ModelProvidersTab）都从这里取，避免两处规则漂移。
 */

import type { ModelProviderConfig } from "@/mock/model-config";

/** 会被拦截的字段（键名与 ProviderFormProps.invalidFields 对齐） */
export type ProviderRequiredField = "baseUrl" | "apiKey";

export interface ProviderValidationIssue {
  id: string;
  /** 给用户看的名字（没填名字就退回 id，避免出现「」这种空引用） */
  name: string;
  /** 缺失的字段，按 baseUrl → apiKey 顺序 */
  missing: ProviderRequiredField[];
}

const FIELD_LABEL: Record<ProviderRequiredField, string> = {
  baseUrl: "Base URL",
  apiKey: "API key",
};

/**
 * 返回所有**启用的**且缺必填项的 Provider（保持草稿顺序）。
 * 全部合规时返回空数组。
 */
export function validateProviders(draft: readonly ModelProviderConfig[]): ProviderValidationIssue[] {
  const issues: ProviderValidationIssue[] = [];
  for (const p of draft) {
    if (!p.enabled) continue;
    const missing: ProviderRequiredField[] = [];
    if (!p.baseUrl.trim()) missing.push("baseUrl");
    if (!p.apiKey.trim()) missing.push("apiKey");
    if (missing.length > 0) {
      issues.push({ id: p.id, name: p.name.trim() || p.id, missing });
    }
  }
  return issues;
}

/** 状态条文案：点名是哪个 Provider、缺什么、以及怎么绕过 */
export function describeProviderIssues(issues: readonly ProviderValidationIssue[]): string {
  const parts = issues.map((i) => `「${i.name}」缺少 ${i.missing.map((m) => FIELD_LABEL[m]).join(" 与 ")}`);
  return `无法保存：${parts.join("；")}（可先停用该 Provider 跳过）`;
}
