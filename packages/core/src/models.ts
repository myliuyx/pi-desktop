/**
 * C5 · 05 屏数据源 —— 列模型 / 切换模型 / 思考档位。
 *
 * ## 「写回 settings.json 既有字段」怎么落的（实测，见 `S6 §五` 05 屏行）
 *
 * Pi 的 `AgentSession.setModel(model, { persist: true })` 会调
 * `settingsManager.setDefaultModelAndProvider(provider, id)` —— 写进 **`defaultProvider` / `defaultModel`**；
 * `setThinkingLevel(level, { persist: true })` 会调 `settingsManager.setDefaultThinkingLevel(level)`
 * —— 写进 **`defaultThinkingLevel`**（`agent-session.js` 实证）。
 * 这两个字段都是 `Settings` 的既有字段（`settings-manager.d.ts`），**我们不新造配置项**。
 *
 * ## 两个实测结论（决定了下面这些取舍）
 *
 * 1. **只列 `getAvailableSnapshot()`**：`getModels()` 返回 Pi 的全部内置目录
 *    （本机实测 **1496 条**，绝大多数没有凭证、选了也跑不起来），
 *    `getAvailableSnapshot()` 只给「已配置凭证」的模型（本机 1 条）—— 与 Pi 自己的 `/model` 口径一致。
 * 2. **思考档位会被「夹取」**：本机模型 `ark-coding/deepseek-v4-flash` 的 `reasoning: false`
 *    ⇒ `getAvailableThinkingLevels()` 只有 `["off"]`，`setThinkingLevel("high")` 后
 *    **生效档位仍是 `off`，但 `defaultThinkingLevel` 已写成 `"high"`**（实测）。
 *    故 payload 同时给 `thinkingLevel`（生效）与 `settings.thinkingLevel`（用户所选），
 *    05 屏激活态用后者 —— 否则用户点了档位「没反应」（C3 同类 UX 陷阱）。
 */

import type { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelInfo, ModelsPayload, ThinkingLevelName } from "./contract.ts";

/** 全档位（顺序即 UI 展示顺序，与 `mock/composer.ts` 的 `THINKING_LABEL` 键一致） */
export const THINKING_LEVELS: readonly ThinkingLevelName[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** 白名单式归一：Pi 的 `ThinkingLevel` 与我们的字面量集合一致；非法值一律 null */
export function normalizeThinkingLevel(value: unknown): ThinkingLevelName | null {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevelName)
    : null;
}

/** `Model` → UI 的 `ModelOption` 同形对象（`supportsXhigh` 用 `Model.reasoning` 代理） */
export function toModelInfo(
  model: { id: string; name?: string; provider: string; reasoning?: boolean },
  providerLabel?: string,
): ModelInfo {
  const info: ModelInfo = {
    id: model.id,
    label: model.name && model.name.trim() ? model.name : model.id,
    provider: model.provider,
  };
  // 展示名与内部 key 是两个东西：key 是 `provider-1790227472338` 这类，不该出现在 UI 上
  if (providerLabel && providerLabel.trim() && providerLabel !== model.provider) {
    info.providerLabel = providerLabel;
  }
  // 「支持 Max」标记：reasoning 为真的是支持思考的模型（Pi 的档位开关本就以它为前提）
  if (model.reasoning === true) info.supportsXhigh = true;
  return info;
}

/** 会话侧只用到的几个成员（结构类型，便于单测与解耦） */
export interface SessionLike {
  readonly model?: { id: string; provider: string } | undefined;
  readonly thinkingLevel: string;
  getAvailableThinkingLevels(): string[];
  setModel(model: NonNullable<ReturnType<ModelRuntime["getModel"]>>, options?: { persist?: boolean }): Promise<void>;
  setThinkingLevel(level: string, options?: { persist?: boolean }): void;
}

export interface ModelsControllerDeps {
  /** 会话未就绪时为 null（payload.ready=false，UI 回落 mock） */
  getSession(): SessionLike | null;
  getRuntime(): Pick<ModelRuntime, "getAvailableSnapshot" | "getModel" | "getProvider"> | null;
  getSettings(): Pick<
    SettingsManager,
    "getDefaultProvider" | "getDefaultModel" | "getDefaultThinkingLevel"
  > | null;
}

export interface ModelsController {
  list(): ModelsPayload;
  /** 切换模型并写回 `settings.json`（`defaultProvider` / `defaultModel`） */
  select(provider: string, modelId: string): Promise<ModelsPayload>;
  /** 设置思考档位并写回 `settings.json`（`defaultThinkingLevel`） */
  setThinking(level: string): Promise<ModelsPayload>;
}

export function createModelsController(deps: ModelsControllerDeps): ModelsController {
  const list = (): ModelsPayload => {
    const session = deps.getSession();
    const runtime = deps.getRuntime();
    const settings = deps.getSettings();

    const models: ModelInfo[] = [];
    const seen = new Set<string>();
    for (const model of runtime?.getAvailableSnapshot() ?? []) {
      const key = `${model.provider}:${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // 展示名取 Pi 侧的 provider 定义（models.json 的 name / 内置 provider 名），取不到就留给 UI 回落 id
      models.push(toModelInfo(model, runtime?.getProvider(model.provider)?.name));
    }

    /*
     * ★ 无模型启动时的占位值（2026-09-24 实查）：SDK 在「没有任何可用模型」时不会让
     * `session.model` 为 undefined，而是挂一个 `provider="unknown", id="unknown"` 的
     * 占位模型 —— 直接透出会让 05 屏显示一个并不存在的模型。
     * 判据改成「runtime 认得它」：`getModel()` 对占位值返回 undefined。
     * settings 的 default* 由下方 `settings` 字段单独暴露，这里不再拿它兜底
     * （兜底会把「已选但不可用」误报成当前模型）。
     * （与 `session.ts` 的 `usableModel()` 同一口径，改一处记得改另一处。）
     */
    const sessionModel = session?.model;
    const usable = sessionModel && runtime?.getModel(sessionModel.provider, sessionModel.id) ? sessionModel : undefined;
    const provider = usable?.provider ?? null;
    const modelId = usable?.id ?? null;

    const available = (session?.getAvailableThinkingLevels() ?? [])
      .map(normalizeThinkingLevel)
      .filter((level): level is ThinkingLevelName => level !== null);

    return {
      models,
      current: provider && modelId ? { provider, modelId } : null,
      thinkingLevel: normalizeThinkingLevel(session?.thinkingLevel) ?? "off",
      availableThinkingLevels: available,
      settings: {
        provider: settings?.getDefaultProvider() ?? null,
        modelId: settings?.getDefaultModel() ?? null,
        thinkingLevel: normalizeThinkingLevel(settings?.getDefaultThinkingLevel()) ?? null,
      },
      ready: !!session,
    };
  };

  return {
    list,

    select: async (provider, modelId) => {
      const session = deps.getSession();
      const runtime = deps.getRuntime();
      if (!session || !runtime) throw new Error("会话未就绪，无法切换模型");
      const model = runtime.getModel(provider, modelId);
      if (!model) throw new Error(`模型不存在：${provider}/${modelId}`);
      // persist:true ⇒ settingsManager.setDefaultModelAndProvider(...)
      await session.setModel(model, { persist: true });
      return list();
    },

    setThinking: async (level) => {
      const session = deps.getSession();
      if (!session) throw new Error("会话未就绪，无法切换思考档位");
      const normalized = normalizeThinkingLevel(level);
      if (!normalized) throw new Error(`非法思考档位：${level}`);
      // persist:true ⇒ settingsManager.setDefaultThinkingLevel(...)
      session.setThinkingLevel(normalized, { persist: true });
      return list();
    },
  };
}
