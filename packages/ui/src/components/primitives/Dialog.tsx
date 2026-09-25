import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { DIALOG_TRANSITION_MS, SETTINGS_DIALOG_MAX_HEIGHT_VH } from "@/lib/layout";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/** 可聚焦元素选择器（焦点陷阱用，G7 全键盘可达） */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  /** 受控开关 */
  open: boolean;
  /** 关闭回调（Esc / 点击遮罩 / ✕ 都会触发） */
  onClose: () => void;
  /** 无障碍可读名称（role=dialog 的 aria-label） */
  label: string;
  /** 弹窗宽度（px），由调用方从 lib/layout 取常量传入 */
  width: number;
  /**
   * 弹窗整体高度（px，可选）。给定后高度恒定、不随内容塌缩
   * （内容区 flex-1 + 滚动承担剩余空间）；仍受 maxHeight（vh）钳制。
   */
  height?: number;
  /** 头部内容（如标题 + Tab 条 + ✕） */
  header?: ReactNode;
  /** 底部条内容（如取消 / 保存） */
  footer?: ReactNode;
  /** 主体内容 */
  children?: ReactNode;
  /**
   * 覆盖层级 z-index（不传 = 默认 z-50，现行为零变化）。
   * dir-picker 传 `POPOVER_Z`（60）：工作目录菜单面板也是 60，同屏防御时弹窗必须在上
   * （task-dir-picker.md D10）。
   */
  zIndex?: number;
  /** 稳定标识：供验收脚本按元素定位使用（IconButton.testId 同款先例） */
  testId?: string;
}

/**
 * 弹窗原语（零新依赖）。
 *
 * 关键约束实现：
 * - **G8 过渡**：遮罩透明度 + 面板缩放/透明度过渡，绝不用 `display:none` 跳变。
 *   关闭后保留在 DOM（opacity-0 + pointer-events-none），下次打开才有淡入。
 * - **G7 键盘可达**：打开时把焦点移入面板、Esc 关闭、Tab/Shift+Tab 在面板内循环。
 *   关闭时给整层打 `inert`，从 Tab 序列与无障碍树里彻底移除（避免隐藏元素仍可被聚焦）。
 * - **无颜色硬编码**：遮罩用 `bg-overlay` 令牌，面板用 `bg-bg-elevated` 令牌（G1/G5）。
 */
export function Dialog({ open, onClose, label, width, height, header, footer, children, zIndex, testId }: DialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const prefersReduced = usePrefersReducedMotion();

  /** 打开瞬间：记住触发元素，并把焦点送进面板 */
  useEffect(() => {
    if (open) {
      previouslyFocused.current = (document.activeElement as HTMLElement) ?? null;
      const raf = requestAnimationFrame(() => {
        const panel = panelRef.current;
        if (!panel) return;
        const first = panel.querySelector<HTMLElement>(FOCUSABLE);
        (first ?? panel).focus();
      });
      return () => cancelAnimationFrame(raf);
    }
    // 关闭：把焦点还回去（inert 已保证它不在 Tab 序列里，这里只是体验更好）
    previouslyFocused.current?.focus?.();
    return;
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => !el.hasAttribute("inert") && el.offsetParent !== null,
    );
    if (focusables.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey) {
      if (active === first || !panel.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !panel.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  const duration = prefersReduced ? DIALOG_TRANSITION_MS / 2 : DIALOG_TRANSITION_MS;

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-testid={testId}
      onKeyDown={onKeyDown}
      // 关闭时整层 inert：从 Tab 序列与无障碍树移除，避免隐藏元素仍可聚焦
      inert={open ? undefined : true}
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center",
        "transition-opacity ease-out",
        open ? "opacity-100" : "pointer-events-none opacity-0",
      )}
      style={{ transitionDuration: `${duration}ms` }}
    >
      {/* 遮罩：点击关闭；用令牌色，不写 hex */}
      <div className="absolute inset-0 bg-overlay" aria-hidden="true" onClick={onClose} />

      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          "relative flex min-h-0 flex-col overflow-hidden rounded-lg bg-bg-elevated shadow-lg",
          "transition-[opacity,transform] ease-out",
          open ? "scale-100 opacity-100" : "scale-95 opacity-0",
        )}
        style={{
          width,
          height,
          maxHeight: `${SETTINGS_DIALOG_MAX_HEIGHT_VH}vh`,
          // 内联 zIndex 覆盖 class 的 z-50（不传时 undefined 无效果，走原 class）
          zIndex,
          transitionDuration: `${duration}ms`,
        }}
      >
        {header ? (
          <div className="shrink-0">{header}</div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        {footer ? <div className="shrink-0">{footer}</div> : null}
      </div>
    </div>
  );
}
