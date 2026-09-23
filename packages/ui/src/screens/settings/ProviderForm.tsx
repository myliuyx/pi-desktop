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

/**
 * 模型服务（Provider）配置表单。
 *
 * 入口：点左栏组头 / 齿轮图标进入（**不是默认可见**，见规格书 §一）。
 *
 * 草稿语义：所有改动经 `onChange` 写回上层草稿（ModelProvidersTab 持有），
 * 「保存」才落 store；「取消」丢弃。启用开关、删除走两步确认（不弹新窗）。
 */
export interface ProviderFormProps {
  provider: ModelProviderConfig;
  onChange: (next: ModelProviderConfig) => void;
  onDelete: () => void;
}

export function ProviderForm({ provider, onChange, onDelete }: ProviderFormProps) {
  const [showApiKey, setShowApiKey] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [enableConfirm, setEnableConfirm] = useState(false);
  const [importFeedback, setImportFeedback] = useState<string | null>(null);

  const patch = (p: Partial<ModelProviderConfig>) => onChange({ ...provider, ...p });

  /** 启用开关两步确认：首次点击只弹确认，不切换值 */
  const onEnableToggle = () => {
    if (!enableConfirm) {
      setEnableConfirm(true);
      return;
    }
    patch({ enabled: !provider.enabled });
    setEnableConfirm(false);
  };

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
            {enableConfirm ? (
              <span className="flex items-center gap-2">
                <span className="text-xs text-text-secondary">
                  确认{provider.enabled ? "停用" : "启用"}？
                </span>
                <Button size="sm" variant="primary" onClick={onEnableToggle} data-testid="provider-enable-confirm">
                  确认
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEnableConfirm(false)}>
                  取消
                </Button>
              </span>
            ) : null}
          </div>
          {confirmDelete ? (
            <span className="flex items-center gap-2">
              <Button size="sm" variant="danger" onClick={onDelete} data-testid="provider-delete-confirm">
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

      <Field label="Base URL">
        <input
          className={INPUT_CLASS}
          value={provider.baseUrl}
          placeholder="https://..."
          data-testid="provider-base-url"
          onChange={(e) => patch({ baseUrl: e.target.value })}
        />
      </Field>

      <Field
        label="API key"
        hint="以 ! 开头执行 shell 命令，或填写环境变量名"
      >
        <div className="relative flex min-w-0 items-center">
          <input
            className={cn(INPUT_CLASS, "pr-9")}
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

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-sm font-medium text-text-primary">Headers</span>
        <HeadersEditor
          headers={provider.headers}
          onChange={(headers) => patch({ headers })}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={Download}
          onClick={() => setImportFeedback("（mock）已打开目录清单，导入示例模型成功")}
          data-testid="provider-import"
          className="self-start"
        >
          导入模型…
        </Button>
        {importFeedback ? (
          <p className="text-xs text-text-secondary" data-testid="provider-import-feedback">
            {importFeedback}
          </p>
        ) : null}
      </div>
    </div>
  );
}
