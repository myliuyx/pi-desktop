import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { TitleBar, type OsName } from "./TitleBar";

export type { OsName };

export interface WindowShellProps extends HTMLAttributes<HTMLDivElement> {
  /** 窗口壳类型：mac 交通灯在左，win / linux 控件在右 */
  os?: OsName;
  /** 会话标题，透传给 TitleBar */
  title?: string;
  onOpenSettings?: () => void;
  /**
   * 主区内容。壳只负责「标题栏 + 主区」的纵向结构，
   * 三栏本身由调用方（WorkbenchScreen）组装 —— 06 屏的「只换壳」正是靠这一点。
   */
  children?: ReactNode;
}

/**
 * 三端窗口外壳。
 *
 * 高度走 `h-full` 而不是给固定值：这样在浏览器与桌面壳里都能撑满，
 * 也让「底边与窗口底重合」（验收 1-3）成立。
 */
export const WindowShell = forwardRef<HTMLDivElement, WindowShellProps>(function WindowShell(
  { os = "mac", title, onOpenSettings, children, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      data-testid="window-shell"
      data-os={os}
      className={cn("flex h-full min-h-0 flex-col overflow-hidden bg-bg-app text-text-primary", className)}
      {...rest}
    >
      <TitleBar os={os} title={title} onOpenSettings={onOpenSettings} />
      {/*
       * 三栏容器：`min-w-0` 是**折到严格 0 宽的关键一环**，别删。
       *
       * 只给三个子项加 min-w-0 不够：本行自身是 WindowShell（flex-col）的
       * **交叉轴**子项，交叉轴默认 `min-width: auto`，行不允许收缩到小于
       * 「子项最小宽度之和」。于是折到 0 的子项那 1px 边框会被算进行宽，
       * 整行卡在 1423 收不下去，内容区只有 1422（实测），1-12 挂。
       * 在本行也置 min-w-0，才能把这条最小宽度链断掉。
       */}
      <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
    </div>
  );
});
