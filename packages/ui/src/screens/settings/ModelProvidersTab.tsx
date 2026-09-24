import { useEffect, useState } from "react";
import { ChevronDown, Cog, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/common/icons";
import {
  SETTINGS_DIALOG_LEFT_WIDTH,
  SETTINGS_DIALOG_SPLIT_GAP,
} from "@/lib/layout";
import type { ModelConfig, ModelProviderConfig } from "@/mock/model-config";
import { MOCK_DISCOVERED_MODELS } from "@/mock/model-config";
import { headersToRecord } from "@/mock/provider-convert";
import { getLiveTransport } from "@/services/live-transport";
import { isLiveEnabled } from "@/lib/feature-flags";
import { ProviderForm } from "./ProviderForm";
import { ModelForm } from "./ModelForm";
import { ModelImportPanel } from "./ModelImportPanel";
import {
  validateProviders,
  type ProviderRequiredField,
  type ProviderValidationIssue,
} from "./provider-validation";

/**
 * 设置弹窗 · 「模型」Tab（第一批 mock 主体）。
 *
 * 左栏 Provider 树（组头展开/收起 + 齿轮入口 + 模型行 + 「+ 模型」+ 底部「+ 添加 Provider」），
 * 右栏随左栏选中项切换两种表单：选中模型行 → ModelForm；点组头/齿轮 → ProviderForm
 * （Provider 表单不是默认可见，默认选中首个模型即显示 ModelForm）。
 *
 * 草稿语义：本组件只持有「选中项」与「展开态」这类 UI 状态；对数据的修改一律
 * `onChange(newProviders)` 回写上层草稿（SettingsDialog 持有），「保存」才落 store。
 */
export interface ModelProvidersTabProps {
  providers: ModelProviderConfig[];
  onChange: (next: ModelProviderConfig[]) => void;
  /**
   * 「保存被拦下」时由上层下发：把选中项切到出问题的 Provider。
   * `seq` 递增保证同一个 Provider 连点两次「保存」也能重新定位（否则 props 不变、effect 不跑）。
   */
  focusRequest?: { id: string; seq: number } | null;
  /**
   * 被保存闸门拦下的 Provider id 集合（只记「曾经拦过」）。
   * 就地红字提示**只在保存被拦之后出现**（必填的 `*` 标记则一直显示），
   * 避免刚点「添加 Provider」就对着一张空表标红说教。
   */
  blockedIds?: ReadonlySet<string>;
  /**
   * 需要上层把「被拦」的提示写到状态条并定位。
   * 「保存」与「导入模型」两道闸门共用同一条通路（判据都是 `validateProviders()`）。
   */
  onReportIssues?: (issues: ProviderValidationIssue[]) => void;
}

/** 「导入模型…」的会话状态（一次只服务一个 Provider） */
interface ImportSession {
  providerId: string;
  loading: boolean;
  models: string[];
  error: string | null;
}

type Selection =
  | { kind: "provider"; providerId: string }
  | { kind: "model"; providerId: string; modelIndex: number }
  | null;

function emptyModel(id = ""): ModelConfig {
  return {
    id,
    // 导入来的模型直接用 id 当显示名：上游只给 id，留空会在表单里变成「未命名模型」
    name: id,
    reasoning: false,
    imageInput: false,
    contextWindow: 0,
    maxTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    advanced: { endpointOverride: "", compatibility: "", headers: [] },
  };
}

function defaultSelection(providers: ModelProviderConfig[]): Selection {
  const first = providers[0];
  if (!first) return null;
  if (first.models.length > 0) return { kind: "model", providerId: first.id, modelIndex: 0 };
  return { kind: "provider", providerId: first.id };
}

export function ModelProvidersTab({
  providers,
  onChange,
  focusRequest,
  blockedIds,
  onReportIssues,
}: ModelProvidersTabProps) {
  const [selection, setSelection] = useState<Selection>(() => defaultSelection(providers));
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(providers.map((p) => [p.id, true])),
  );

  /**
   * 保存校验未过 → 上层下发 focusRequest：切到该 Provider 并展开它。
   * 只认 `focusRequest` 这个对象标识（每次下发都是新对象），不依赖 `providers`
   * —— 否则用户正常编辑时（providers 每次都变）会被反复抢走当前选择。
   */
  useEffect(() => {
    if (!focusRequest) return;
    if (!providers.some((p) => p.id === focusRequest.id)) return;
    setSelection({ kind: "provider", providerId: focusRequest.id });
    setExpanded((prev) => ({ ...prev, [focusRequest.id]: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  /** 校验结果按 provider id 索引，供表单就地标红（判据与保存拦截同源） */
  const missingByProvider = (p: ModelProviderConfig): ProviderRequiredField[] | undefined => {
    if (!blockedIds?.has(p.id)) return undefined;
    // 复用同一个判据：用户一填上，红字立刻消失（不必再点一次保存）
    return validateProviders([p])[0]?.missing;
  };

  /* -------------------------------------------------------------------------
   * 「导入模型…」：拉取该 Provider 的真实清单 → 浮层勾选 → 并入草稿
   * （实现见下方 `startImport` / `confirmImport`，放在 `updateProvider` 之后：
   *  它们会回写草稿，声明的先后顺序与阅读顺序保持一致，避免「用了后面才定义的函数」的错觉）
   * ----------------------------------------------------------------------- */

  const updateProvider = (id: string, patch: Partial<ModelProviderConfig>) =>
    onChange(providers.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const updateModel = (providerId: string, modelIndex: number, patch: Partial<ModelConfig>) =>
    onChange(
      providers.map((p) =>
        p.id === providerId
          ? { ...p, models: p.models.map((m, i) => (i === modelIndex ? { ...m, ...patch } : m)) }
          : p,
      ),
    );

  const addModel = (providerId: string) => {
    const created = emptyModel();
    onChange(
      providers.map((p) =>
        p.id === providerId ? { ...p, models: [...p.models, created] } : p,
      ),
    );
    const provider = providers.find((p) => p.id === providerId);
    const nextIndex = provider ? provider.models.length : 0;
    setSelection({ kind: "model", providerId, modelIndex: nextIndex });
  };

  const removeModel = (providerId: string, modelIndex: number) => {
    const provider = providers.find((p) => p.id === providerId);
    const nextLen = provider ? provider.models.length - 1 : 0;
    onChange(
      providers.map((p) =>
        p.id === providerId
          ? { ...p, models: p.models.filter((_, i) => i !== modelIndex) }
          : p,
      ),
    );
    // 选中项回退：仍在范围内则保持，否则落到上一个 / 退回 Provider
    if (selection?.kind === "model" && selection.providerId === providerId) {
      if (modelIndex > 0) setSelection({ kind: "model", providerId, modelIndex: modelIndex - 1 });
      else if (nextLen > 0) setSelection({ kind: "model", providerId, modelIndex: 0 });
      else setSelection({ kind: "provider", providerId });
    }
  };

  const deleteProvider = (providerId: string) => {
    const next = providers.filter((p) => p.id !== providerId);
    onChange(next);
    setSelection(defaultSelection(next) ?? null);
  };

  const addProvider = () => {
    const created: ModelProviderConfig = {
      id: `provider-${Date.now()}`,
      name: "新 Provider",
      baseUrl: "",
      apiKey: "",
      api: "openai-completions",
      headers: [],
      /*
       * 默认**启用**（2026-09-24 用户裁决）：原先默认 false ⇒ 用户刚添加的 Provider 被存进
       * sidecar `models-disabled.json`（Pi 眼中并不存在），设置页看起来"加了却没生效"。
       * 添加动作本身就表达了"我要用它"，默认启用才符合直觉。
       */
      enabled: true,
      models: [],
    };
    onChange([...providers, created]);
    setSelection({ kind: "provider", providerId: created.id });
  };

  const toggleExpand = (providerId: string) =>
    setExpanded((prev) => ({ ...prev, [providerId]: !prev[providerId] }));

  /**
   * 模型连通性测试：live 形态发一次性最小真实请求（`POST /models/test`，max_tokens=1）；
   * mock 形态沿用 800ms 延迟成功。模型级 endpointOverride / headers 优先于 Provider 级。
   */
  const runModelTest = async (): Promise<{ ok: boolean; latencyMs: number; error?: string }> => {
    if (!selectedProvider || !selectedModel) return { ok: false, latencyMs: 0, error: "未选中模型" };
    const transport = getLiveTransport();
    if (!transport) {
      await new Promise((resolve) => window.setTimeout(resolve, 800));
      return { ok: true, latencyMs: 800 };
    }
    return transport.testModel({
      baseUrl: selectedModel.advanced.endpointOverride || selectedProvider.baseUrl,
      apiKey: selectedProvider.apiKey,
      api: selectedProvider.api,
      headers: {
        ...headersToRecord(selectedProvider.headers),
        ...headersToRecord(selectedModel.advanced.headers),
      },
      modelId: selectedModel.id,
    });
  };

  const selectedProvider =
    selection?.kind === "provider" || selection?.kind === "model"
      ? providers.find((p) => p.id === selection.providerId) ?? null
      : null;
  const selectedModel =
    selection?.kind === "model" && selectedProvider
      ? selectedProvider.models[selection.modelIndex] ?? null
      : null;

  /* -------------------------------------------------------------------------
   * 「导入模型…」：拉取该 Provider 的真实清单 → 浮层勾选 → 并入草稿
   * ----------------------------------------------------------------------- */

  const [importSession, setImportSession] = useState<ImportSession | null>(null);

  /**
   * 点「导入模型…」。先把必填项过一遍闸门（与保存同一判据）：
   * 没填 Base URL / API key 就没法拉清单，此时**不发请求**，直接交给上层提示并定位。
   */
  const startImport = (p: ModelProviderConfig) => {
    const issues = validateProviders([p]);
    if (issues.length > 0) {
      onReportIssues?.(issues);
      return;
    }
    setImportSession({ providerId: p.id, loading: true, models: [], error: null });

    const fail = (message: string) =>
      setImportSession({ providerId: p.id, loading: false, models: [], error: message });

    const transport = isLiveEnabled() ? getLiveTransport() : null;
    if (!transport) {
      /*
       * mock 形态（默认）：没有上游可拉，用固定演示清单把**交互本身**跑通 ——
       * 筛选 / 全选 / 逐项勾选 / 「已添加」标记 / 计数，一样都不少（探针据此可在不起 core 时验完）。
       */
      window.setTimeout(() => {
        setImportSession({
          providerId: p.id,
          loading: false,
          models: [...MOCK_DISCOVERED_MODELS],
          error: null,
        });
      }, 350);
      return;
    }

    void transport
      .listProviderModels({
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        api: p.api,
        headers: headersToRecord(p.headers),
      })
      .then((res) => {
        if (!res.ok) {
          // core 把上游失败包成 200 + {ok:false,error}：原文照显，别吞
          fail(res.error ?? "拉取模型清单失败");
          return;
        }
        setImportSession({ providerId: p.id, loading: false, models: res.models, error: null });
      })
      .catch((e) => fail(e instanceof Error ? e.message : String(e)));
  };

  /** 确认导入：按 id 去重并入草稿，并把选中项切到第一个新加的模型 */
  const confirmImport = (p: ModelProviderConfig, ids: readonly string[]) => {
    const have = new Set(p.models.map((m) => m.id));
    const fresh = ids.filter((id) => !have.has(id));
    setImportSession(null);
    if (fresh.length === 0) return;
    const appended = fresh.map((id) => emptyModel(id));
    const baseIndex = p.models.length;
    updateProvider(p.id, { models: [...p.models, ...appended] });
    setSelection({ kind: "model", providerId: p.id, modelIndex: baseIndex });
  };

  /** 当前是否正在为选中的 Provider 导入（浮层取代右栏表单） */
  const activeImport =
    importSession && selectedProvider && importSession.providerId === selectedProvider.id
      ? importSession
      : null;

  return (
    <div className="flex h-full min-h-0 min-w-0" style={{ gap: SETTINGS_DIALOG_SPLIT_GAP }}>
      {/* 左栏：Provider 树（列表区自身滚动，「+ 添加 Provider」钉在栏底不随滚动） */}
      <div
        className="flex min-h-0 min-w-0 flex-col overflow-hidden border border-border-subtle rounded-lg bg-bg-surface"
        style={{ width: SETTINGS_DIALOG_LEFT_WIDTH }}
        data-testid="model-provider-tree"
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
          {providers.map((p) => {
            const isProviderSelected = selection?.kind === "provider" && selection.providerId === p.id;
            const isOpen = expanded[p.id] ?? true;
            return (
              <div key={p.id} className="border-b border-border-subtle last:border-b-0">
                {/* 组头：点击选中 Provider（→ ProviderForm）；齿轮 = 显式入口；chevron = 展开/收起 */}
                <div
                  className={cn(
                    "flex min-w-0 items-center gap-2 px-2 py-2",
                    isProviderSelected ? "bg-bg-active" : "hover:bg-bg-hover",
                  )}
                >
                  <button
                    type="button"
                    aria-label={isOpen ? "收起模型列表" : "展开模型列表"}
                    aria-expanded={isOpen}
                    onClick={() => toggleExpand(p.id)}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
                  >
                    <Icon
                      icon={ChevronDown}
                      size={15}
                      className={cn("transition-transform duration-200 ease-out", !isOpen && "-rotate-90")}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelection({ kind: "provider", providerId: p.id })}
                    data-testid="provider-header"
                    data-provider-id={p.id}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        p.enabled ? "bg-success" : "bg-border-strong",
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                      {p.name}
                    </span>
                    <span className="shrink-0 text-xs text-text-tertiary">
                      {p.models.length} 模型
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label="配置该 Provider"
                    title="配置该 Provider"
                    onClick={() => setSelection({ kind: "provider", providerId: p.id })}
                    data-testid="provider-gear"
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
                  >
                    <Icon icon={Cog} size={15} />
                  </button>
                </div>

                {/* 模型清单：grid-rows 0fr→1fr 过渡（G8，非 display:none） */}
                <div
                  className="grid transition-[grid-template-rows] duration-200 ease-out"
                  style={{ gridTemplateRows: isOpen ? "1fr" : "0fr" }}
                >
                  <div className="min-h-0 overflow-hidden">
                    <ul className="flex min-w-0 flex-col pb-1">
                      {p.models.map((m, i) => {
                        const selected =
                          selection?.kind === "model" &&
                          selection.providerId === p.id &&
                          selection.modelIndex === i;
                        const pending = m.id.trim().length === 0;
                        return (
                          <li key={i}>
                            <button
                              type="button"
                              onClick={() => setSelection({ kind: "model", providerId: p.id, modelIndex: i })}
                              data-testid="model-row"
                              data-model-id={m.id}
                              data-pending={pending}
                              className={cn(
                                "flex min-w-0 w-full items-center gap-2 px-3 py-1.5 text-left",
                                selected ? "bg-bg-active" : "hover:bg-bg-hover",
                              )}
                            >
                              <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                                {m.name || m.id || "未命名模型"}
                              </span>
                              {pending ? (
                                <span className="shrink-0 rounded-full bg-warning-soft px-2 py-0.5 text-xs text-warning">
                                  待配置
                                </span>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                      <li>
                        <button
                          type="button"
                          onClick={() => addModel(p.id)}
                          data-testid="add-model"
                          className="flex min-w-0 w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
                        >
                          <Icon icon={Plus} size={14} />
                          模型
                        </button>
                      </li>
                    </ul>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {/* 钉底：添加 Provider 始终固定在左栏底部（2026-09-23 用户裁决），不随列表滚动 */}
        <div className="shrink-0 border-t border-border-subtle p-2">
          <button
            type="button"
            onClick={addProvider}
            data-testid="add-provider"
            className="flex w-full min-w-0 items-center justify-center gap-1.5 rounded-md border border-dashed border-border-default px-3 py-2 text-sm text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
          >
            <Icon icon={Plus} size={15} />
            添加 Provider
          </button>
        </div>
      </div>

      {/* 右栏：表单 */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden" data-testid="model-form-pane">
        {activeImport && selectedProvider ? (
          /* 导入浮层**取代**右栏表单（不叠一层新弹窗）：左栏仍可点，用户随时能看自己在配哪个 Provider */
          <ModelImportPanel
            providerName={selectedProvider.name || selectedProvider.id}
            models={activeImport.models}
            existingIds={selectedProvider.models.map((m) => m.id)}
            loading={activeImport.loading}
            error={activeImport.error}
            onCancel={() => setImportSession(null)}
            onConfirm={(ids) => confirmImport(selectedProvider, ids)}
          />
        ) : selection?.kind === "provider" && selectedProvider ? (
          <ProviderForm
            /* key：切换 Provider 时重建表单，避免上一项的「确认删除」等局部态残留 */
            key={selectedProvider.id}
            provider={selectedProvider}
            onChange={(next) => updateProvider(selectedProvider.id, next)}
            onDelete={() => deleteProvider(selectedProvider.id)}
            onImport={() => startImport(selectedProvider)}
            invalidFields={missingByProvider(selectedProvider)}
          />
        ) : selection?.kind === "model" && selectedProvider && selectedModel ? (
          <ModelForm
            /* key：切换模型（含「移除后选中项回落」）时重建表单，避免「确认移除」一直挂着 */
            key={`${selectedProvider.id}#${selection.modelIndex}`}
            model={selectedModel}
            providerName={selectedProvider.name}
            onChange={(next) => updateModel(selectedProvider.id, selection.modelIndex, next)}
            onRemove={() => removeModel(selectedProvider.id, selection.modelIndex)}
            onTest={runModelTest}
          />
        ) : (
          <div className="flex h-full min-w-0 items-center justify-center text-sm text-text-tertiary">
            从左侧选择一个 Provider 或模型
          </div>
        )}
      </div>
    </div>
  );
}
