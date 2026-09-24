import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/primitives";
import { Icon } from "@/components/common/icons";
import { INPUT_CLASS } from "./form-fields";

/**
 * 「导入模型…」浮层：拉取该 Provider 的真实模型清单供勾选。
 *
 * 形态（2026-09-24 用户给的参照图）：**搜索框 + 全选 + 可滚动清单**装在一个带边框的盒子里，
 * 计数与「添加所选模型」在盒子**下方**一行（左计数、右按钮）。
 *
 * 交互要点：
 * - 已在 Provider 里的模型**不参与勾选**：勾选框禁用 + 右侧「已添加」徽标（参考图同款）。
 * - 「选择当前结果」只作用于**当前筛选出的、且未添加**的那些 —— 否则筛完点全选会把已添加的也吃掉，
 *   用户以为自己新加了几个。
 * - 三态（加载 / 失败 / 空）都要有明确文案：拉不到就说拉不到，**不许静默变成空清单**。
 *
 * G 约束：颜色只走令牌（无 hex、无 Tailwind 调色板）；无横向滚动（id 长则 truncate）；
 * 勾选框是 `role="checkbox"` 的 button（与 `Switch` 同范式，状态单一来源 = props）。
 */
export interface ModelImportPanelProps {
  /** 只用于提示文案（「从 X 获取」） */
  providerName: string;
  /** 上游返回的原始清单（本组件负责与 `existingIds` 比对；不要求去重） */
  models: readonly string[];
  /** 该 Provider 当前已配的模型 id */
  existingIds: readonly string[];
  loading: boolean;
  /** 拉取失败原因（core 的 `error` 原文） */
  error?: string | null;
  onCancel: () => void;
  /** 确认：把勾选的 id 交回上层（上层负责并入草稿） */
  onConfirm: (ids: string[]) => void;
}

/** 单行勾选框：`role="checkbox"` 的 button，状态只有 `checked` 一个来源 */
function RowCheckbox({
  checked,
  disabled,
  label,
  testId,
  onToggle,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  testId: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onToggle}
      data-testid={testId}
      data-checked={checked}
      className={cn(
        "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors duration-150 ease-out",
        "disabled:cursor-not-allowed disabled:opacity-40",
        checked ? "border-accent bg-accent text-accent-fg" : "border-border-strong bg-bg-surface",
      )}
    >
      {checked ? <Icon icon={Check} size={11} /> : null}
    </button>
  );
}

export function ModelImportPanel({
  providerName,
  models,
  existingIds,
  loading,
  error,
  onCancel,
  onConfirm,
}: ModelImportPanelProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const existing = new Set(existingIds);
  const needle = query.trim().toLowerCase();
  const filtered = needle ? models.filter((id) => id.toLowerCase().includes(needle)) : models;
  /** 当前筛选下**可勾选**的（已添加的不算） */
  const selectable = filtered.filter((id) => !existing.has(id));
  const allSelected = selectable.length > 0 && selectable.every((id) => selected.has(id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) for (const id of selectable) next.delete(id);
      else for (const id of selectable) next.add(id);
      return next;
    });

  /* 已选里可能有被后续筛选隐藏的项 —— 计数与提交都以整份 `selected` 为准，不随筛选缩水 */
  const selectedCount = selected.size;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3" data-testid="model-import">
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-border-subtle bg-bg-surface">
        <div className="flex min-w-0 flex-col gap-2 p-3">
          <input
            className={INPUT_CLASS}
            value={query}
            placeholder={`筛选 ${models.length} 个模型…`}
            aria-label="筛选模型"
            data-testid="model-import-search"
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="flex min-w-0 cursor-pointer items-center gap-2">
            <RowCheckbox
              checked={allSelected}
              disabled={selectable.length === 0}
              label="选择当前结果"
              testId="model-import-select-all"
              onToggle={toggleAll}
            />
            <span className="text-sm text-text-primary">选择当前结果</span>
          </label>
        </div>

        <div className="min-h-0 max-h-64 min-w-0 overflow-y-auto overflow-x-hidden border-t border-border-subtle">
          {loading ? (
            <p
              className="flex min-w-0 items-center gap-2 px-3 py-3 text-sm text-text-secondary"
              data-testid="model-import-loading"
            >
              <Icon icon={Loader2} size={14} className="animate-spin" />
              正在从 {providerName} 拉取模型清单…
            </p>
          ) : error ? (
            <p className="px-3 py-3 text-sm text-danger" data-testid="model-import-error">
              {error}
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-3 py-3 text-sm text-text-tertiary" data-testid="model-import-empty">
              {models.length === 0
                ? `${providerName} 没有返回任何模型（该服务可能未实现 GET /models）`
                : "没有匹配的模型"}
            </p>
          ) : (
            filtered.map((id) => {
              const added = existing.has(id);
              return (
                <div
                  key={id}
                  className="flex min-w-0 items-center gap-2 px-3 py-1.5 hover:bg-bg-hover"
                  data-testid="model-import-row"
                  data-model-id={id}
                  data-added={added}
                >
                  <RowCheckbox
                    checked={added || selected.has(id)}
                    disabled={added}
                    label={`选择模型 ${id}`}
                    testId="model-import-row-check"
                    onToggle={() => toggle(id)}
                  />
                  {/*
                   * id 往往很长（`command-code/deepseek/deepseek-v4-pro`）——
                   * `truncate` + `title` 保证窄栏不撑出横向滚动（G6），鼠标悬停仍能看全。
                   */}
                  <span className="min-w-0 flex-1 truncate text-sm text-text-primary" title={id}>
                    {id}
                  </span>
                  {added ? (
                    <span
                      className="shrink-0 text-xs text-text-tertiary"
                      data-testid="model-import-added"
                    >
                      已添加
                    </span>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="flex min-w-0 shrink-0 items-center justify-between gap-3">
        <p className="min-w-0 truncate text-xs text-text-secondary" data-testid="model-import-count">
          {loading ? `正在从 ${providerName} 获取模型…` : `已获取 ${models.length} 个模型`}
          {!loading && !error && selectedCount > 0 ? `，已选 ${selectedCount} 个` : ""}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} data-testid="model-import-cancel">
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={loading || selectedCount === 0}
            onClick={() => onConfirm([...selected])}
            data-testid="model-import-confirm"
          >
            添加所选模型
          </Button>
        </div>
      </div>
    </div>
  );
}
