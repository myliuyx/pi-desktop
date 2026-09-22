import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  SHELL_PREVIEW_BORDER_WIDTH,
  SHELL_PREVIEW_LABEL_HEIGHT,
  SHELL_PREVIEW_RADIUS,
  SHELL_PREVIEW_SCALE,
} from "@/lib/layout";
import { WorkbenchScreen } from "@/components/shell/WorkbenchScreen";
import type { ShellVariant } from "@/mock/shells";

/** 缩放后的外层尺寸：外层必须给**固定值**，否则缩放过仍占 1440 宽 → 06 屏横向滚动条（G6 挂） */
const SCALED_WIDTH = DESIGN_WIDTH * SHELL_PREVIEW_SCALE;
const SCALED_HEIGHT = DESIGN_HEIGHT * SHELL_PREVIEW_SCALE;

export interface ShellPreviewProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * 本卡片对应的 os。
   *
   * ★ 关键约束（高危点 4）：`os` 是**本卡片的 props**，绝不能读全局 store ——
   *   并排三卡若共用 store 里一个字段，切一次会三端同时变，`data-os` 全一样，5-1 直接挂。
   */
  variant: ShellVariant;
}

/**
 * 06 屏的缩略窗口卡片：标签 + 缩放裁剪的内容区。
 *
 * 结构（自上而下）：
 * ```
 * section.shell-preview            ← data-testid="shell-preview" + data-os
 * ├── div.shell-preview-label       ← data-testid="shell-preview-label" + data-os
 * └── div.缩放外层（固定 SCALED_WIDTH × SCALED_HEIGHT + overflow:hidden）
 *     └── div.缩放内层（DESIGN_WIDTH × DESIGN_HEIGHT + transform: scale）
 *         ├── span.shell-content-probe   ← data-testid="shell-content-probe" + data-os
 *         └── WorkbenchScreen            ← 真正的窗口壳（data-testid="window-shell" = shell-frame）
 * ```
 *
 * ★ 关于探针为什么放在这一层：
 *   `transform: scale()` 会污染 `getBoundingClientRect()`，但**不影响 `offsetLeft/offsetTop`**。
 *   探针是缩放内层里的一个绝对定位零尺寸元素，它的 `offsetParent` 是缩放外层
 *   （`position: relative`），因此 `offsetTop` 精确等于「窗口壳相对裁剪窗口顶边的位移」——
 *   也就是 `TITLE_BAR_HEIGHT`（三端必须都是 36）。三端的这个值天然相同，
 *   若某端不同就是真缺陷（比如某端控件把标题栏撑高了），绝不能用 margin 补丁抹平。
 */
export const ShellPreview = forwardRef<HTMLDivElement, ShellPreviewProps>(function ShellPreview(
  { variant, className, ...rest },
  ref,
) {
  const { os, label, note } = variant;

  return (
    <section
      ref={ref}
      data-testid="shell-preview"
      data-os={os}
      className={cn("min-w-0 shrink-0 rounded-xl border border-border-subtle bg-bg-surface", className)}
      style={{ borderRadius: SHELL_PREVIEW_RADIUS, borderWidth: SHELL_PREVIEW_BORDER_WIDTH }}
      {...rest}
    >
      <div
        data-testid="shell-preview-label"
        data-os={os}
        className="flex items-center gap-3 border-b border-border-subtle px-3"
        style={{ height: SHELL_PREVIEW_LABEL_HEIGHT }}
      >
        {/* 显示名 + os 值：用既有令牌，不新增色值（G1） */}
        <span className="shrink-0 text-sm font-medium text-text-primary">{label}</span>
        <span className="shrink-0 rounded-sm bg-bg-subtle px-1.5 font-mono text-xs text-text-tertiary">
          {os}
        </span>
        {/* 说明文字可能较长：给 min-w-0 + truncate + title，避免撑破卡片 */}
        <span className="min-w-0 truncate text-xs text-text-tertiary" title={note}>
          {note}
        </span>
      </div>

      {/*
       * 缩放外层：给**固定**的缩放后尺寸 + overflow:hidden。
       * 固定尺寸这一条是 G6 的关键 —— 若外层不锁尺寸，内层的 1440 宽会撑出横向滚动条。
       */}
      <div
        className="overflow-hidden"
        style={{ width: SCALED_WIDTH, height: SCALED_HEIGHT }}
      >
        {/*
         * 缩放内层：尺寸恒为 1440×900（与 DESIGN_* 同源），只做视觉缩放。
         * transform-origin 必须是 top left：否则缩放后会在容器内偏移，裁剪窗就对不齐左上角了。
         *
         * ★ 坐标探针不在这里，而在 `WorkbenchScreen` 的 `probeOs` 里 ——
         *   探针必须是**三栏容器的子节点**，`offsetTop` 才能等于 `TITLE_BAR_HEIGHT`，
         *   从而让验收 5-2 量到「内容区首个元素的坐标」而不是缩放容器的顶边。
         */}
        <div
          className="relative origin-top-left"
          style={{
            width: DESIGN_WIDTH,
            height: DESIGN_HEIGHT,
            transform: `scale(${SHELL_PREVIEW_SCALE})`,
          }}
        >
          {/* 真正的三端壳：复用 M1 的 WindowShell / TitleBar，不重复实现（明令禁止第 10 条） */}
          <WorkbenchScreen os={os} probeOs={os} />
        </div>
      </div>
    </section>
  );
});
