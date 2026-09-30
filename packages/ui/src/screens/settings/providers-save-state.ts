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
 * 【先红态】如实承接 SettingsDialog 当前行为：**尚无来源闸**。
 * live 读失败回落演示数据时也返回「可保存」—— 这正是 CR-084 的病根（回归据此标红）。
 * fix 提交把 `fallback` 分支改成「禁存 + 重新读取」。
 * （`source` 已在签名承接以对齐目标形态；`_hasDraft` 待 fix 提交组织原因文案时启用，
 *   `_` 前缀避开 `noUnusedParameters`。）
 */
export function resolveProvidersSaveState(source: ProvidersSource, _hasDraft: boolean): ProvidersSaveState {
  if (source === "live") {
    return { canSave: true, canRetry: false, reason: "" };
  }
  // fallback：当前也放行（= CR-084 待修路径：演示数据被全量 PUT 覆盖真实 models.json）
  return { canSave: true, canRetry: false, reason: "" };
}
