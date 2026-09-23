import { forwardRef, type HTMLAttributes } from "react";
import { Cpu, Settings } from "lucide-react";
import { cn } from "@/lib/cn";
import { SIDEBAR_FOOTER_HEIGHT } from "@/lib/layout";
import { Icon } from "@/components/common/icons";

export interface SidebarFooterProps extends HTMLAttributes<HTMLDivElement> {
  onOpenModel?: () => void;
  onOpenSettings?: () => void;
}

/**
 * 侧边栏底部条带（模型 / 设置 各半宽）。
 *
 * ★ 验收 1-3 / 1-5 的关键：本组件**必须作为 Sidebar 的兄弟节点**挂在
 * `padding: 12px` 的「侧边栏内容」包装器**之外**，否则左右与底部会各残留 12px 间隙。
 * 同理这里不给任何 padding / margin / border-radius，两半之间也不留 gap 与分隔线。
 *
 * 「设置」半边的底色刻意与父容器同为 `bg-bg-subtle`（视觉上等于透明），
 * 这样两半看起来是「同一块底上分左右」，而不是两个并排的按钮。
 */
export const SidebarFooter = forwardRef<HTMLDivElement, SidebarFooterProps>(function SidebarFooter(
  { onOpenModel, onOpenSettings, className, ...rest },
  ref,
) {
  const halves = [
    {
      key: "model",
      label: "模型",
      icon: Cpu,
      // 未传 onOpenModel 时回退到打开设置弹窗（2026-09-23 用户裁决：模型按钮也是设置入口，
      // 弹窗默认落在「模型」Tab）。当前所有调用点都不传 onOpenModel。
      onClick: onOpenModel ?? onOpenSettings,
    },
    { key: "settings", label: "设置", icon: Settings, onClick: onOpenSettings },
  ] as const;

  return (
    <div
      ref={ref}
      data-testid="sidebar-footer"
      className={cn(
        "flex w-full shrink-0 items-stretch gap-0 overflow-hidden rounded-none bg-bg-subtle p-0",
        className,
      )}
      style={{ height: SIDEBAR_FOOTER_HEIGHT }}
      {...rest}
    >
      {halves.map(({ key, label, icon, onClick }) => (
        <button
          key={key}
          type="button"
          data-testid={`sidebar-footer-${key}`}
          onClick={onClick}
          className={cn(
            "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-none px-0 text-sm",
            "transition-colors duration-150 ease-out hover:bg-bg-hover active:bg-bg-active",
            // 半边的底色与其父容器相同，视觉上等于透明（验收 1-5）
            "bg-bg-subtle text-text-secondary",
          )}
        >
          <Icon icon={icon} />
          <span className="truncate">{label}</span>
        </button>
      ))}
    </div>
  );
});
