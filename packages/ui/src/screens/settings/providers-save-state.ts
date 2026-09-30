/**
 * Provider 保存来源闸（CR-084）—— 从 SettingsDialog 保存路径抽出的**可测纯函数**。
 *
 * 背景（CR-084）：live 形态下 `SettingsDialog` 读 `/providers` 失败时，回落到**演示数据**作草稿，
 * 但「保存」按钮没有任何来源闸 —— 一点保存就把演示 Provider（假 URL / 假 key）全量 PUT 覆盖
 * 真实 `models.json`，真实 Provider 与 key 被抹掉（且演示数据的 string `compat` 直接触发 CR-029）。
 *
 * 本函数只回答一件事：**当前草稿能不能保存 / 该不该提供重试**，不碰传输、不碰 store。
 * 判定依据是「当前 modelProviders 的来源」（= store 的 `providersSource`，见 `ui-store.ts`）：
 * - `live`：来自 core 的真实读取（或本地提交值），保存合法；
 * - `fallback`：读失败回落的演示数据，**禁止保存**（会覆盖真配置），改为提供「重新读取」重试。
 *
 * 入参说明：`source` 即 store 的 `providersSource`；`hasDraft` 表示对话框里是否确有一份草稿在
 * 展示（决定重试提示文案）。**不接 draft 内容本身** —— 必填项校验另由 `provider-validation.ts`
 * 负责，两者正交：本闸管「来源是否可信」，那个闸管「字段是否填齐」。
 */

/** 当前 `modelProviders` 的来源（CR-084） */
export type ProvidersSource = "live" | "fallback";

export interface ProvidersSaveState {
  /** 是否允许保存（点「保存」是否应生效） */
  canSave: boolean;
  /** 是否应提供「重新读取」重试入口（live 读失败时重新从 core 拉取） */
  canRetry: boolean;
  /** 保存被禁时给用户的原因（`canSave` 为 true 时为空串） */
  reason: string;
}

/**
 * 依据「来源」判定能否保存：
 * - `fallback`（live 读失败回落演示数据）→ **禁存 + 提供重试**（CR-084 核心）：保存会把
 *   演示 Provider 全量 PUT 覆盖真实 models.json，故必须拦住并给「重新读取」入口；
 * - `live`（core 真实读取 / 本地提交值）→ 允许保存，无需重试。
 */
export function resolveProvidersSaveState(source: ProvidersSource, hasDraft: boolean): ProvidersSaveState {
  if (source === "fallback") {
    return {
      canSave: false,
      canRetry: true,
      reason: hasDraft
        ? "core 模型配置读取失败，当前草稿未与 core 确认（可能是演示/过期数据）；直接保存会用它们覆盖真实配置。请点「重新读取」成功后再保存。"
        : "core 模型配置读取失败，未取到可保存的配置。请点「重新读取」重试。",
    };
  }
  return { canSave: true, canRetry: false, reason: "" };
}
