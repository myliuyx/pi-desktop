import { useState } from "react";
import { ChevronDown, Cog, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/common/icons";
import {
  SETTINGS_DIALOG_LEFT_WIDTH,
  SETTINGS_DIALOG_SPLIT_GAP,
} from "@/lib/layout";
import type { ModelConfig, ModelProviderConfig } from "@/mock/model-config";
import { headersToRecord } from "@/mock/provider-convert";
import { getLiveTransport } from "@/services/live-transport";
import { ProviderForm } from "./ProviderForm";
import { ModelForm } from "./ModelForm";

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
}

type Selection =
  | { kind: "provider"; providerId: string }
  | { kind: "model"; providerId: string; modelIndex: number }
  | null;

function emptyModel(): ModelConfig {
  return {
    id: "",
    name: "",
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

export function ModelProvidersTab({ providers, onChange }: ModelProvidersTabProps) {
  const [selection, setSelection] = useState<Selection>(() => defaultSelection(providers));
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(providers.map((p) => [p.id, true])),
  );

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
      enabled: false,
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
        {selection?.kind === "provider" && selectedProvider ? (
          <ProviderForm
            /* key：切换 Provider 时重建表单，避免上一项的「确认删除」等局部态残留 */
            key={selectedProvider.id}
            provider={selectedProvider}
            onChange={(next) => updateProvider(selectedProvider.id, next)}
            onDelete={() => deleteProvider(selectedProvider.id)}
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
