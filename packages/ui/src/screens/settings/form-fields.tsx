import { type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { IconButton, Button } from "@/components/primitives";
import type { ModelHeader } from "@/mock/model-config";

/**
 * 模型表单的共用输入样式与小组件。
 *
 * ★ 颜色只走令牌（G1/G5）：input 用 `bg-bg-surface` / `border-border-default` / `text-text-primary`，
 *   聚焦态用 `focus:border-accent`；绝不写 hex。
 * ★ 尺寸走 style/常量（G 约束）：输入框高度用 h-8（与全库控件一致），宽度由父容器决定。
 * ★ 窄容器下必须能换行（G6）：所有字段用「标签在上、控件在下」纵向排布，配合 `min-w-0` 与
 *   `w-full`，双列字段用 grid 自动折行，右侧窄弹窗里不会撑出横向滚动条。
 */

/** 文本 / 数字输入框统一样式 */
export const INPUT_CLASS =
  "w-full min-w-0 h-8 rounded-md border border-border-default bg-bg-surface px-2 text-sm text-text-primary " +
  "placeholder:text-text-tertiary transition-colors duration-150 ease-out " +
  "hover:border-border-strong focus:border-accent focus:outline-none";

/** 下拉框：在输入框基础上加指针与去原生箭头（用统一令牌色，不写 hex） */
export const SELECT_CLASS = cn(INPUT_CLASS, "appearance-none cursor-pointer");

/** 带标签的字段容器（标签在上，控件在下，纵向不溢出） */
export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-1 text-sm font-medium text-text-primary">
        {label}
        {required ? <span className="text-danger" aria-hidden="true">*</span> : null}
      </span>
      {children}
      {hint ? <span className="text-xs text-text-tertiary">{hint}</span> : null}
    </label>
  );
}

/** 自定义 Headers 编辑器（Provider 层与 Model 高级设置层复用） */
export function HeadersEditor({
  headers,
  onChange,
}: {
  headers: ModelHeader[];
  onChange: (next: ModelHeader[]) => void;
}) {
  const update = (key: string, patch: Partial<ModelHeader>) =>
    onChange(headers.map((h) => (h.key === key ? { ...h, ...patch } : h)));
  const remove = (key: string) => onChange(headers.filter((h) => h.key !== key));
  const add = () => onChange([...headers, { key: `h-${Date.now()}`, name: "", value: "" }]);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {headers.map((h) => (
        <div key={h.key} className="flex min-w-0 items-center gap-2">
          <input
            className={INPUT_CLASS}
            placeholder="Header 名"
            value={h.name}
            aria-label="Header 名"
            onChange={(e) => update(h.key, { name: e.target.value })}
          />
          <input
            className={INPUT_CLASS}
            placeholder="值"
            value={h.value}
            aria-label="Header 值"
            onChange={(e) => update(h.key, { value: e.target.value })}
          />
          <IconButton label="删除该 Header" icon={Trash2} size="sm" onClick={() => remove(h.key)} />
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        icon={Plus}
        onClick={add}
        className="self-start"
        data-testid="add-header"
      >
        Add header
      </Button>
    </div>
  );
}

/** 折叠区（grid-rows 0fr→1fr 过渡，非 display:none，满足 G8） */
export function Collapsible({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="grid transition-[grid-template-rows] duration-200 ease-out"
      style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
