import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useNoticeStore, type NoticeTone } from "@/store/notice-store";

/** 色调样式（token 全部来自 tokens.css 的 --color-* 映射，见 globals.css） */
const TONE_CLASS: Record<NoticeTone, string> = {
  info: "border-border-default bg-bg-surface text-text-primary",
  success: "border-success bg-success-soft text-success",
  warning: "border-warning bg-warning-soft text-warning",
  danger: "border-danger bg-danger-soft text-danger",
};

/**
 * 全局提示条：底部居中、可堆叠、可关闭。挂在 App 级（与 SettingsDialog 同级）。
 *
 * `pointer-events-none` 在外层 + `pointer-events-auto` 在条目上：提示不遮挡点击，
 * 但条目自身可以点「关闭」。
 */
export function NoticeStack() {
  const notices = useNoticeStore((state) => state.notices);
  const dismiss = useNoticeStore((state) => state.dismiss);
  if (notices.length === 0) return null;
  return (
    <div
      data-testid="notice-stack"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
    >
      {notices.map((n) => (
        <div
          key={n.id}
          data-testid="notice-item"
          data-tone={n.tone}
          role="status"
          className={cn(
            "pointer-events-auto flex w-fit max-w-[520px] items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg",
            TONE_CLASS[n.tone],
          )}
        >
          <span className="min-w-0 flex-1">{n.text}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => dismiss(n.id)}
            className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
