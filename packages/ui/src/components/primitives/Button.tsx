import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Icon, type LucideIcon } from "@/components/common/icons";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover active:brightness-95",
  secondary:
    "bg-bg-surface text-text-primary border border-border-default hover:bg-bg-hover active:bg-bg-active",
  ghost: "bg-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary active:bg-bg-active",
  danger: "bg-danger text-text-inverse hover:brightness-95 active:brightness-90",
};

/** 供 00 屏状态矩阵静态展示 hover / active 态使用（class 必须字面量，Tailwind 才能扫描到） */
export const BUTTON_STATE_CLASSES: Record<ButtonVariant, { hover: string; active: string }> = {
  primary: { hover: "bg-accent-hover", active: "bg-accent-hover brightness-95" },
  secondary: { hover: "bg-bg-hover", active: "bg-bg-active" },
  ghost: { hover: "bg-bg-hover text-text-primary", active: "bg-bg-active" },
  danger: { hover: "brightness-95", active: "brightness-90" },
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-sm gap-1.5",
  md: "h-8 px-3 text-base gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, iconRight, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      className={cn(
        "inline-flex select-none items-center justify-center rounded-md font-medium",
        "transition-colors duration-150 ease-out",
        "disabled:bg-bg-subtle disabled:text-text-tertiary disabled:border-border-subtle",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    >
      {/* 按钮内图标跟随按钮文字色，语义上属于按钮的一部分 */}
      {icon ? <Icon icon={icon} className="text-current" /> : null}
      {children}
      {iconRight ? <Icon icon={iconRight} className="text-current" /> : null}
    </button>
  );
});
