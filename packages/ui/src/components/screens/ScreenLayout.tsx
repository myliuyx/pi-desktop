import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  SCREEN_PADDING,
  SCREEN_SECTION_GAP,
} from "@/lib/layout";
import { Button } from "@/components/primitives";
import { Icon, type LucideIcon } from "@/components/common/icons";

/**
 * 03 / 04 / 05 三屏共用的内容区外壳。
 *
 * 这三屏是「工作台里的一块」而非独立全屏页（见 lib/layout.ts 的 M4 段归属说明），
 * 所以内容区的结构必须与 `WorkspaceArea` 同构：
 * - 根节点 `flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden`
 *   （`min-w-0` 是折叠时不出横向滚动的关键，验收 4-7 的落点）
 * - 页面头固定高度，正文独立滚动
 *
 * 与 `WorkspaceArea` 的唯一区别：三屏不渲染 `MessageList` / `Composer`。
 */
export interface ScreenAreaProps extends HTMLAttributes<HTMLElement> {
  children?: ReactNode;
}

export const ScreenArea = forwardRef<HTMLElement, ScreenAreaProps>(function ScreenArea(
  { children, className, ...rest },
  ref,
) {
  return (
    <main
      ref={ref}
      className={cn(
        // `flex` 与 `flex-col` 同传，靠 cn() 的 flex 分组把二者区分开（见 lib/cn.ts）
        "flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg-app",
        className,
      )}
      {...rest}
    >
      {children}
    </main>
  );
});

/**
 * 三屏的页面头：标题 + 副标题/汇总 + 右侧动作区（含「返回工作台」）。
 *
 * 返回按钮统一走 `Button variant="ghost" size="sm" icon={ArrowLeft}`，
 * 与 `TokensScreen` 的返回入口保持同一种视觉语言。
 */
export interface ScreenHeaderProps {
  title: string;
  subtitle?: ReactNode;
  onBackToWorkbench?: () => void;
  /** 右侧附加动作（如设置屏的主题快捷入口），渲染在返回按钮之后 */
  actions?: ReactNode;
}

export function ScreenHeader({ title, subtitle, onBackToWorkbench, actions }: ScreenHeaderProps) {
  return (
    <header
      className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border-subtle bg-bg-app"
      style={{
        paddingLeft: SCREEN_PADDING,
        paddingRight: SCREEN_PADDING,
        paddingTop: 12,
        paddingBottom: 12,
      }}
    >
      <div className="min-w-0">
        <h1 className="truncate text-md font-semibold text-text-primary">{title}</h1>
        {subtitle ? <div className="mt-0.5 text-xs text-text-tertiary">{subtitle}</div> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {actions}
        {onBackToWorkbench ? (
          <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBackToWorkbench} data-testid="screen-back">
            返回工作台
          </Button>
        ) : null}
      </div>
    </header>
  );
}

/**
 * 三屏正文容器：可滚动、四边内边距、纵向分组间距。
 *
 * 为什么正文自己滚动而不是整屏滚动：页面头要像工作台的标题栏一样始终可见，
 * 与 `TokensScreen` 的 `sticky` header 语义一致，但这里用 flex 布局实现，
 * 避免 sticky 在 flex 容器里与折叠过渡叠加时产生额外的合成层开销。
 */
export interface ScreenBodyProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export const ScreenBody = forwardRef<HTMLDivElement, ScreenBodyProps>(function ScreenBody(
  { children, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden", className)}
      style={{ padding: SCREEN_PADDING }}
      {...rest}
    >
      {/* min-w-0：内层内容再宽也不能把外层撑出横向滚动条（验收 4-7） */}
      <div className="flex min-w-0 flex-col" style={{ gap: SCREEN_SECTION_GAP }}>
        {children}
      </div>
    </div>
  );
});

/**
 * 三屏的纵向分区（小标题 + 说明 + 内容）。
 *
 * 与 `TokensScreen` 内部的 `Section` 视觉一致，但那个是 `TokensScreen` 的私有函数
 * （00 屏是体检页，性质不同），按 task-M4.md 第一节第 5 点的指示**照样式另写**，不导出复用。
 */
export interface ScreenSectionProps extends HTMLAttributes<HTMLElement> {
  title: string;
  /** 标题右侧的附加信息（如条数），单独传以便脚本定位 */
  badge?: ReactNode;
  note?: string;
  /** 分区右上角的动作区 */
  actions?: ReactNode;
  icon?: LucideIcon;
  children?: ReactNode;
}

export const ScreenSection = forwardRef<HTMLElement, ScreenSectionProps>(function ScreenSection(
  { title, badge, note, actions, icon, children, className, ...rest },
  ref,
) {
  return (
    <section ref={ref} className={cn("min-w-0", className)} {...rest}>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        {icon ? <Icon icon={icon} /> : null}
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        {badge}
        {note ? <p className="min-w-0 text-xs text-text-tertiary">{note}</p> : null}
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
});
