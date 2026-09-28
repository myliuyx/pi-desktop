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

/**
 * 右侧内容面板（模型表单 / 技能详情 / 插件详情 / 常规 Tab）的滚动类。
 *
 * ★ 三个部分缺一不可：
 *   ① `overflow-x-hidden`：G6（弹窗内不得出现横向滚动条）。
 *   ② `pane-scroll-stable`（= `scrollbar-gutter: stable both-edges`）：
 *      滚动条槽在**左右两端各留 10px**。只留右侧的话，滚动条一出现右边就比
 *      左边窄 10px（2026-09-28 用户实拍「左右间距明显不一样」）；两端同留才能
 *      在任何平台都得到对称布局。
 *   ③ `overflow-y-scroll`（恒定占位）：让「是否溢出」不改变容器可用宽度 ——
 *      `stable` 本身已保证不跳动，此处是显式声明意图，防止后续被改成 `auto`
 *      时误以为「只是等价替换」而丢掉对称性依据。
 *
 * ★ 与 SETTINGS_DIALOG_FORM_PADDING（layout.ts）的耦合：最终视觉留白
 *   = padding(10) + 槽(10) = 20。**动本类里的 scrollbar 相关样式前，
 *   必须同步复核 layout.ts 的 SETTINGS_DIALOG_FORM_PADDING**，否则留白会变。
 *
 *   只给**右栏**用：左栏是满宽的树/列表行，滚动条紧贴边框、不产生视觉不对称。
 */
export const PANE_SCROLL_CLASS = "overflow-y-scroll overflow-x-hidden pane-scroll-stable";

/** 带标签的字段容器（标签在上，控件在下，纵向不溢出） */
export function Field({
  label,
  hint,
  required,
  invalid,
  error,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  /** 校验未过：提示改用 danger 令牌，并把 `*` 视为必填强调 */
  invalid?: boolean;
  /** 校验未过的提示文案；给了就替代 `hint` 显示（一句话说清「缺什么」） */
  error?: string;
  children: ReactNode;
}) {
  const showError = invalid === true && error !== undefined;
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-1 text-sm font-medium text-text-primary">
        {label}
        {required || invalid ? (
          <span className="text-danger" aria-hidden="true">
            *
          </span>
        ) : null}
      </span>
      {children}
      {showError ? (
        <span className="text-xs text-danger" data-testid="field-error">
          {error}
        </span>
      ) : hint ? (
        <span className="text-xs text-text-tertiary">{hint}</span>
      ) : null}
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
        Add Header
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
