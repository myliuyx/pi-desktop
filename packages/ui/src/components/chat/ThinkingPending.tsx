import { useEffect, useState } from "react";

/** 等待超过该时长换「仍在等待模型响应」文案 —— 给「仍在工作」的明确信号，防「卡死了」疑虑 */
const WAIT_WARN_MS = 20_000;

/**
 * 等待模型首字的占位行（task-chat-feedback-and-usage.md §2.3）。
 *
 * 出现/消失条件由 MessageList 判定（streaming 且无可见内容；首个可见块到达即让位），
 * 本组件只负责呈现：脉动三点 + 秒级计时。三点动画在 globals.css
 * （`.thinking-dot` + prefers-reduced-motion 媒体查询内降级为静态），不引新色令牌。
 *
 * testid 由外层虚拟行携带（`thinking-indicator`）；这里再挂 role="status" +
 * aria-live="polite"，读屏用户也能感知等待态与已等待时长。
 */
export function ThinkingPending({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsedMs = Math.max(0, now - since);
  const seconds = Math.floor(elapsedMs / 1000);
  const elapsed =
    seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
  const label = elapsedMs >= WAIT_WARN_MS ? "仍在等待模型响应" : "正在思考";

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${label}，已等待 ${elapsed}`}
      className="inline-flex items-center gap-2.5 rounded-xl border border-border-subtle bg-bg-surface px-3.5 py-2.5"
    >
      <span className="flex items-center gap-1" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="thinking-dot h-1.5 w-1.5 rounded-full bg-text-tertiary"
            style={{ animationDelay: `${i * 180}ms` }}
          />
        ))}
      </span>
      <span className="text-sm text-text-secondary">
        {label}
        <span className="ml-2 tabular-nums text-text-tertiary">{elapsed}</span>
      </span>
    </div>
  );
}
