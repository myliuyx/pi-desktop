import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Icon, type LucideIcon } from "@/components/common/icons";

export type ChipVariant = "neutral" | "accent" | "outline";

const VARIANT_CLASSES: Record<ChipVariant, string> = {
  neutral: "bg-bg-subtle text-text-secondary border border-border-subtle hover:bg-bg-hover active:bg-bg-active",
  accent: "bg-accent-soft text-accent border border-transparent hover:bg-bg-hover active:bg-bg-active",
  outline: "bg-transparent text-text-secondary border border-border-default hover:bg-bg-hover active:bg-bg-active",
};

/** 供 00 屏状态矩阵静态展示 hover / active 态使用 */
export const CHIP_STATE_CLASSES: Record<ChipVariant, { hover: string; active: string }> = {
  neutral: { hover: "bg-bg-hover", active: "bg-bg-active" },
  accent: { hover: "bg-bg-hover", active: "bg-bg-active" },
  outline: { hover: "bg-bg-hover", active: "bg-bg-active" },
};

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ChipVariant;
  icon?: LucideIcon;
  /** 选中态 */
  selected?: boolean;
  /**
   * 文本之后的尾部附件（如下拉箭头）。
   * 为什么单独开插槽而不塞进 children：children 会被 `truncate`（overflow-hidden）包裹，
   * 行内 svg 在里面会被行盒裁切（ChipMenu 的箭头实踩过）——trailing 渲染在文本 span 外，
   * 与它平级参与 flex 对齐，不会被裁。
   */
  trailing?: ReactNode;
  children?: ReactNode;
}

/** 工具条芯片默认高 32（h-8） */
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { variant = "neutral", icon, selected = false, trailing, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        // min-w-0：作为弹性容器的子项时允许收缩（默认 min-width:auto 会顶住不放，
        // 把兄弟节点挤出容器——ComposerToolbar 里 TokenStats 被挤溢出 11px 实踩）。
        // 收缩时文本由 truncate span 省略号降级，图标与 trailing 不受影响。
        "inline-flex h-8 min-w-0 max-w-full select-none items-center gap-1.5 rounded-full px-3 text-sm",
        "transition-colors duration-150 ease-out",
        "disabled:bg-bg-subtle disabled:text-text-tertiary disabled:border-border-subtle",
        variant === "accent" && selected && "border-accent",
        variant !== "accent" && selected && "border-border-strong text-text-primary",
        VARIANT_CLASSES[variant],
        className,
      )}
      {...rest}
    >
      {icon ? <Icon icon={icon} className="text-current" /> : null}
      <span className="truncate">{children}</span>
      {trailing}
    </button>
  );
});
