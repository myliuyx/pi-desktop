import { useState } from "react";
import { CheckCircle2, ChevronDown, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/primitives";
import { Icon } from "@/components/common/icons";
import type { ModelConfig } from "@/mock/model-config";
import type { ModelTestResult } from "@/mock/provider-contract";
import { Field, INPUT_CLASS, HeadersEditor, Collapsible } from "./form-fields";

/**
 * 单个模型配置表单。
 *
 * 入口：选中左栏某条模型行进入（右栏默认即此表单，因为对话框打开时默认选中首个模型）。
 *
 * 状态语义：模型「待配置 / 已配置」由 `id` 是否为空决定（空串 = 待配置）。
 * 「测试」按钮：传入 `onTest`（live）→ 发一次性最小真实请求并显示延迟 / 错误文案；
 * 未传（mock 形态）→ 沿用第一批的 800ms 延迟成功反馈。「移除」两步确认（不弹新窗）。
 */
export interface ModelFormProps {
  model: ModelConfig;
  providerName: string;
  onChange: (next: ModelConfig) => void;
  onRemove: () => void;
  /** live 形态：真实连通性测试（POST /models/test）；不传 = mock 反馈 */
  onTest?: () => Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}

type TestState = "idle" | "testing" | "success" | "error";

function parseNumber(value: string): number {
  if (value.trim() === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function ModelForm({ model, providerName, onChange, onRemove, onTest }: ModelFormProps) {
  const [testState, setTestState] = useState<TestState>("idle");
  /** 成功时记延迟（ms）、失败时记错误文案 */
  const [testNote, setTestNote] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const configured = model.id.trim().length > 0;
  const patch = (p: Partial<ModelConfig>) => onChange({ ...model, ...p });

  /*
   * 连通性测试：live 形态走 `POST /models/test`（一次性最小真实请求，不落盘、不改当前选择）；
   * 未传 `onTest`（mock 形态）沿用第一批的 800ms 延迟成功反馈。
   * 结果（成功带延迟 / 失败带原因）显示在**按钮组最右侧**，不插在按钮中间挤位。
   */
  const runTest = async () => {
    if (testState === "testing") return;
    setTestState("testing");
    setTestNote("");
    try {
      const res: ModelTestResult = onTest
        ? await onTest()
        : await new Promise((resolve) => {
            window.setTimeout(() => resolve({ ok: true, latencyMs: 800 }), 800);
          });
      if (res.ok) {
        setTestState("success");
        setTestNote(`${res.latencyMs}ms`);
      } else {
        setTestState("error");
        setTestNote(res.error ?? "连接失败");
      }
    } catch (e) {
      setTestState("error");
      setTestNote(e instanceof Error ? e.message : String(e));
    }
  };

  /** 确认移除后立刻收起确认组：否则组件被复用时「确认移除」会一直挂在界面上 */
  const doRemove = () => {
    setConfirmRemove(false);
    onRemove();
  };

  const fillFromModelsDev = () => {
    patch({
      name: model.name || "导入的模型",
      contextWindow: model.contextWindow || 128000,
      maxTokens: model.maxTokens || 8192,
      cost: model.cost.input ? model.cost : { input: 1, output: 3, cacheRead: 0.25, cacheWrite: 0.5 },
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {/* 顶部：状态 + 测试 / 移除 */}
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            模型配置
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs",
                configured ? "bg-success-soft text-success" : "bg-warning-soft text-warning",
              )}
              data-testid="model-status"
            >
              {configured ? "已配置" : "待配置"}
            </span>
          </h3>
          <p className="min-w-0 truncate text-xs text-text-tertiary" title={providerName}>
            {providerName}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={runTest}
            disabled={testState === "testing" || !configured}
            data-testid="model-test"
          >
            {testState === "testing" ? "测试中…" : "测试"}
          </Button>
          {confirmRemove ? (
            <span className="flex items-center gap-2">
              <Button size="sm" variant="danger" onClick={doRemove} data-testid="model-remove-confirm">
                确认移除
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                取消
              </Button>
            </span>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setConfirmRemove(true)} data-testid="model-remove">
              移除
            </Button>
          )}
          {/* 测试结果恒在按钮组最右侧：不插在「测试」与「移除」中间，避免挤位与换行错位 */}
          {testState === "success" ? (
            <span
              className="flex shrink-0 items-center gap-1 text-xs text-success"
              data-testid="model-test-result"
            >
              <Icon icon={CheckCircle2} size={14} />
              连接成功{testNote ? ` · ${testNote}` : ""}
            </span>
          ) : null}
          {testState === "error" ? (
            <span
              className="max-w-[200px] shrink-0 truncate text-xs text-danger"
              data-testid="model-test-error"
              title={testNote}
            >
              {testNote || "连接失败"}
            </span>
          ) : null}
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-2 gap-4">
        <Field label="ID" required hint="模型在 Provider 内的唯一标识">
          <input
            className={INPUT_CLASS}
            value={model.id}
            placeholder="例如 qwen-max"
            data-testid="model-id"
            onChange={(e) => patch({ id: e.target.value })}
          />
        </Field>
        <Field label="Name">
          <input
            className={INPUT_CLASS}
            value={model.name}
            placeholder="展示名"
            data-testid="model-name"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>
      </div>

      {/* 能力复选框 */}
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-sm font-medium text-text-primary">能力</span>
        <label className="flex min-w-0 items-center gap-2 text-sm text-text-primary">
          <input
            type="checkbox"
            className="h-4 w-4 accent-accent"
            checked={model.reasoning}
            data-testid="model-cap-reasoning"
            onChange={(e) => patch({ reasoning: e.target.checked })}
          />
          推理 / 思考
        </label>
        <label className="flex min-w-0 items-center gap-2 text-sm text-text-primary">
          <input
            type="checkbox"
            className="h-4 w-4 accent-accent"
            checked={model.imageInput}
            data-testid="model-cap-image"
            onChange={(e) => patch({ imageInput: e.target.checked })}
          />
          图片输入
        </label>
      </div>

      <div className="grid min-w-0 grid-cols-2 gap-4">
        <Field label="上下文窗口 (tokens)">
          <input
            type="number"
            min={0}
            className={INPUT_CLASS}
            value={model.contextWindow}
            data-testid="model-context-window"
            onChange={(e) => patch({ contextWindow: parseNumber(e.target.value) })}
          />
        </Field>
        <Field label="最大输出 tokens">
          <input
            type="number"
            min={0}
            className={INPUT_CLASS}
            value={model.maxTokens}
            data-testid="model-max-tokens"
            onChange={(e) => patch({ maxTokens: parseNumber(e.target.value) })}
          />
        </Field>
      </div>

      {/* 每百万 tokens 价格四列 */}
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-sm font-medium text-text-primary">每百万 TOKENS 价格</span>
        <div className="grid min-w-0 grid-cols-2 gap-4">
          <Field label="输入">
            <input
              type="number"
              min={0}
              step="0.1"
              className={INPUT_CLASS}
              value={model.cost.input}
              data-testid="model-price-input"
              onChange={(e) => patch({ cost: { ...model.cost, input: parseNumber(e.target.value) } })}
            />
          </Field>
          <Field label="输出">
            <input
              type="number"
              min={0}
              step="0.1"
              className={INPUT_CLASS}
              value={model.cost.output}
              data-testid="model-price-output"
              onChange={(e) => patch({ cost: { ...model.cost, output: parseNumber(e.target.value) } })}
            />
          </Field>
          <Field label="缓存读取">
            <input
              type="number"
              min={0}
              step="0.1"
              className={INPUT_CLASS}
              value={model.cost.cacheRead}
              data-testid="model-price-cache-read"
              onChange={(e) => patch({ cost: { ...model.cost, cacheRead: parseNumber(e.target.value) } })}
            />
          </Field>
          <Field label="缓存写入">
            <input
              type="number"
              min={0}
              step="0.1"
              className={INPUT_CLASS}
              value={model.cost.cacheWrite}
              data-testid="model-price-cache-write"
              onChange={(e) => patch({ cost: { ...model.cost, cacheWrite: parseNumber(e.target.value) } })}
            />
          </Field>
        </div>
      </div>

      {/* 填入模型信息 + 来源 */}
      <div className="flex min-w-0 flex-col gap-1">
        <Button
          variant="ghost"
          size="sm"
          icon={Sparkles}
          onClick={fillFromModelsDev}
          data-testid="model-fill"
          className="self-start"
        >
          填入模型信息
        </Button>
        <span className="text-xs text-text-tertiary">来源： models.dev</span>
      </div>

      {/* 高级设置折叠 */}
      <div className="flex min-w-0 flex-col gap-2">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
          data-testid="model-advanced-toggle"
          className={cn(
            "flex w-full min-w-0 items-center gap-1.5 rounded-md px-0 py-1 text-left text-sm font-medium text-text-primary",
            "transition-colors duration-150 hover:text-text-secondary",
          )}
        >
          <Icon
            icon={ChevronDown}
            size={15}
            className={cn("text-icon-neutral transition-transform duration-200 ease-out", advancedOpen && "rotate-180")}
          />
          高级设置
        </button>
        <Collapsible open={advancedOpen}>
          <div className="flex min-w-0 flex-col gap-4 pt-1">
            <Field label="API 端点覆盖">
              <input
                className={INPUT_CLASS}
                value={model.advanced.endpointOverride}
                placeholder="留空则用 Provider 的 Base URL"
                data-testid="model-endpoint-override"
                onChange={(e) =>
                  patch({ advanced: { ...model.advanced, endpointOverride: e.target.value } })
                }
              />
            </Field>
            <div className="flex min-w-0 flex-col gap-2">
              <span className="text-sm font-medium text-text-primary">Headers</span>
              <HeadersEditor
                headers={model.advanced.headers}
                onChange={(headers) => patch({ advanced: { ...model.advanced, headers } })}
              />
            </div>
            <Field label="兼容性">
              <input
                className={INPUT_CLASS}
                value={model.advanced.compatibility}
                placeholder="例如 openai"
                data-testid="model-compatibility"
                onChange={(e) =>
                  patch({ advanced: { ...model.advanced, compatibility: e.target.value } })
                }
              />
            </Field>
          </div>
        </Collapsible>
      </div>
    </div>
  );
}
