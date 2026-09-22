import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { Icon, type LucideIcon } from "@/components/common/icons";

export type IconButtonSize = "sm" | "md";

const SIZE_CLASSES: Record<IconButtonSize, string> = {
  sm: "h-7 w-7",
  md: "h-8 w-8",
};

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 无障碍必填：图标按钮没有可见文本 */
  label: string;
  icon: LucideIcon;
  size?: IconButtonSize;
  /** 选中 / 激活态 */
  active?: boolean;
  /** 稳定标识：供验收脚本按元素定位使用（不影响视觉） */
  testId?: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = "sm", active = false, className, disabled, type = "button", testId, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active}
      data-testid={testId}
      disabled={disabled}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md",
        "transition-colors duration-150 ease-out",
        "hover:bg-bg-hover active:bg-bg-active",
        "disabled:bg-transparent disabled:opacity-50",
        active && "bg-bg-active",
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    >
      <Icon icon={icon} />
    </button>
  );
});
