import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { WorkspaceArea } from "./WorkspaceArea";
import { PreviewPane } from "./PreviewPane";
import { Sidebar } from "./Sidebar";
import { SidebarFooter } from "./SidebarFooter";
import { WindowShell } from "./WindowShell";
import type { OsName } from "./TitleBar";

export interface WorkbenchScreenProps extends HTMLAttributes<HTMLDivElement> {
  /** 窗口壳类型，06 屏靠它并排三个变体且内容区零位移 */
  os?: OsName;
  title?: string;
  onOpenSettings?: () => void;
  /**
   * 06 屏坐标探针（验收 5-2 的唯一落点）。
   *
   * 传值时会在**三栏容器的第一个位置**插入一个零尺寸的
   * `[data-testid="shell-content-probe"]` 元素（带 `data-os`）。
   * 为什么放在这里而不是 `ShellPreview` 里：探针要量的正是「内容区首个元素的坐标」，
   * 它必须是三栏容器的子节点，`offsetTop` 才等于 `TITLE_BAR_HEIGHT` +
   * 内容区自身偏移 —— 也就是三端必须天然相同的那个值。
   *
   * 探针是 `absolute` + 不设 `top/left`，因此走**静态位置**（flex 容器的内容盒起点），
   * 不受任何硬编码坐标影响。`offsetLeft/offsetTop` 不受 transform 影响，
   * 所以它也是 06 屏缩放视图下唯一可信的坐标口径（高危点 1）。
   *
   * 不传时（01 屏及三屏）完全不渲染，零影响。
   */
  probeOs?: OsName;
}

/**
 * 01 屏 · 会话工作台（M1 只到骨架 + 占位内容）。
 *
 * 三栏组装放在这里而不是 WindowShell 里：这样 06 屏切换 `os` 时
 * 整棵内容子树的原位置引用不变，内容区首个元素坐标完全一致（验收 5-2）。
 *
 * ★ 条带通底的关键：`SidebarFooter` 作为 `Sidebar` 的 `footer` prop 传进去，
 * 由 Sidebar 渲染成「内容包装器」的**兄弟节点**，而不是被包进带 padding 的容器里。
 */
export const WorkbenchScreen = forwardRef<HTMLDivElement, WorkbenchScreenProps>(function WorkbenchScreen(
  { os = "mac", title = "接入 Pi 工具链的调研", onOpenSettings, probeOs, className, ...rest },
  ref,
) {
  return (
    <WindowShell ref={ref} os={os} title={title} onOpenSettings={onOpenSettings} className={cn(className)} {...rest}>
      {/*
       * ★ 06 屏坐标探针：必须是三栏容器的**第一个**子节点，且 absolute + 不设 top/left
       *   走静态位置（flex 内容盒起点）。它的 offsetTop = TITLE_BAR_HEIGHT（三端一致）。
       *   不传 probeOs 时整块不渲染，对 01 屏与三屏零影响（5-2 的基准不能被污染）。
       */}
      {probeOs ? (
        <span
          data-testid="shell-content-probe"
          data-os={probeOs}
          aria-hidden="true"
          className="pointer-events-none absolute"
          style={{ width: 0, height: 0 }}
        />
      ) : null}
      <Sidebar
        activeSessionId="session-0"
        footer={<SidebarFooter onOpenSettings={onOpenSettings} />}
      />
      <WorkspaceArea />
      <PreviewPane />
    </WindowShell>
  );
});
