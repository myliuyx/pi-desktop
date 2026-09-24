import { useState } from "react";
import { Eye, EyeOff, Download } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/primitives";
import { Icon } from "@/components/common/icons";
import { Switch } from "@/components/screens/Switch";
import {
  MODEL_API_TYPES,
  type ModelApiType,
  type ModelProviderConfig,
} from "@/mock/model-config";
import { Field, INPUT_CLASS, SELECT_CLASS, HeadersEditor } from "./form-fields";
import type { ProviderRequiredField } from "./provider-validation";

/**
 * 模型服务（Provider）配置表单。
 *
 * 入口：点左栏组头 / 齿轮图标进入（**不是默认可见**，见规格书 §一）。
 *
 * 草稿语义：所有改动经 `onChange` 写回上层草稿（ModelProvidersTab 持有），
 * 「保存」才落 store；「取消」丢弃。删除走两步确认（不弹新窗）。
 *
 * 启用开关**不再二次确认**（2026-09-24 用户裁决）：它本身是幂等、可随手改回的低风险操作，
 * 且状态在开关上直接可见；多一次点击只是阻碍。删除仍保留两步确认（不可逆）。
 *
 * 校验（2026-09-24 用户要求）：**启用的** Provider 必须填 Base URL 与 API key，
 * 否则「保存」被拦下（见 `provider-validation.ts`）。拦截后由上层把出问题的项选中并传入
 * `invalidFields`，这里就地标红并写明缺什么 —— 不依赖底部状态条（那行会被 `truncate` 截断）。
 *
 * 「导入模型…」**不是本组件的职责**：它要发网络请求、改草稿、切换右栏内容，
 * 全部由 `ModelProvidersTab` 承接；这里只负责把点击转出去（`onImport`）。
 */
export interface ProviderFormProps {
  provider: ModelProviderConfig;
  onChange: (next: ModelProviderConfig) => void;
  onDelete: () => void;
  /** 点「导入模型…」：由上层校验必填项并发起拉取 */
  onImport: () => void;
  /** 保存校验未通过的字段；来自 `validateProviders()`，为 undefined/空表示合规 */
  invalidFields?: readonly ProviderRequiredField[];
}

/** 各必填项的就地提示文案 */
const REQUIRED_ERROR: Record<ProviderRequiredField, string> = {
  baseUrl: "必填：请填写服务地址，保存前不允许为空",
  apiKey: "必填：请填写密钥（或 $环境变量名），保存前不允许为空",
};

export function ProviderForm({ provider, onChange, onDelete, onImport, invalidFields }: ProviderFormProps) {
  const [showApiKey, setShowApiKey] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const patch = (p: Partial<ModelProviderConfig>) => onChange({ ...provider, ...p });

  const missing = (f: ProviderRequiredField) => invalidFields?.includes(f) === true;

  /** 删除后立刻收起确认组（与模型「确认移除」同源：组件被复用时不该留着确认按钮） */
  const doDelete = () => {
    setConfirmDelete(false);
    onDelete();
  };

  /** 启用开关：点击即切换（可随时改回，无需确认） */
  const onEnableToggle = () => patch({ enabled: !provider.enabled });

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {/* 顶部：标题 + 启用开关 + 删除 */}
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">Provider 配置</h3>
          <p className="min-w-0 truncate text-xs text-text-tertiary" title={provider.name}>
            {provider.name || "未命名 Provider"}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
          <div className="flex items-center gap-2">
            <Switch
              checked={provider.enabled}
              label="启用该 Provider"
              onToggle={onEnableToggle}
              data-testid="provider-enabled"
            />
          </div>
          {confirmDelete ? (
            <span className="flex items-center gap-2">
              <Button size="sm" variant="danger" onClick={doDelete} data-testid="provider-delete-confirm">
                确认删除
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                取消
              </Button>
            </span>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)} data-testid="provider-delete">
              删除
            </Button>
          )}
        </div>
      </div>

      <Field label="Provider 名称" required>
        <input
          className={INPUT_CLASS}
          value={provider.name}
          placeholder="例如 AliYun"
          data-testid="provider-name"
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Field>

      <Field
        label="Base URL"
        /* 启用态下它才是必填的：停用项允许留着空（唯一的「先存半成品」途径） */
        required={provider.enabled}
        invalid={missing("baseUrl")}
        error={REQUIRED_ERROR.baseUrl}
      >
        <input
          className={cn(INPUT_CLASS, missing("baseUrl") && "border-danger")}
          value={provider.baseUrl}
          placeholder="https://..."
          data-testid="provider-base-url"
          onChange={(e) => patch({ baseUrl: e.target.value })}
        />
      </Field>

      <Field
        label="API key"
        hint="以 ! 开头执行 shell 命令，或填写环境变量名"
        required={provider.enabled}
        invalid={missing("apiKey")}
        error={REQUIRED_ERROR.apiKey}
      >
        <div className="relative flex min-w-0 items-center">
          <input
            className={cn(INPUT_CLASS, "pr-9", missing("apiKey") && "border-danger")}
            type={showApiKey ? "text" : "password"}
            value={provider.apiKey}
            placeholder="sk-... 或 $ENV_NAME 或 !cmd"
            data-testid="provider-api-key"
            onChange={(e) => patch({ apiKey: e.target.value })}
          />
          <button
            type="button"
            aria-label={showApiKey ? "隐藏 API key" : "显示 API key"}
            title={showApiKey ? "隐藏 API key" : "显示 API key"}
            onClick={() => setShowApiKey((v) => !v)}
            className="absolute right-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
          >
            <Icon icon={showApiKey ? EyeOff : Eye} size={15} />
          </button>
        </div>
      </Field>

      <Field label="API 类型">
        <select
          className={SELECT_CLASS}
          value={provider.api}
          data-testid="provider-api-type"
          onChange={(e) => patch({ api: e.target.value as ModelApiType })}
        >
          {MODEL_API_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>

      {/* 不再给一块「Headers」标题：按钮文案已自解释，多一行标题只是噪音（2026-09-24 用户要求） */}
      <HeadersEditor
        headers={provider.headers}
        onChange={(headers) => patch({ headers })}
      />

      <div className="flex min-w-0 flex-col gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={Download}
          onClick={onImport}
          data-testid="provider-import"
          className="self-start"
        >
          导入模型…
        </Button>
        <p className="text-xs text-text-tertiary">
          从该 Provider 拉取模型清单，勾选后并入下方模型列表
        </p>
      </div>
    </div>
  );
}
