import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { MESSAGE_MAX_WIDTH } from "@/lib/layout";
import type { MessageRole, TextBlock } from "@/mock/types";
import { Markdown } from "@/components/common/Markdown";

export interface MessageBubbleProps extends HTMLAttributes<HTMLDivElement> {
  block: TextBlock;
  role: MessageRole;
  /** 流式进行中：在末尾显示一个跳动光标 */
  streaming?: boolean;
}

/**
 * 文本气泡（消息里的 TextBlock）。
 *
 * 气泡底色按角色区分，但**全部走语义令牌**：
 * - 助手：bg-surface + 细边框（与卡片同族）
 * - 用户：accent-soft 底（呼应发送按钮的底色，形成呼应）
 * 气泡 `max-width` 取自 MESSAGE_MAX_WIDTH，且 `min-w-0` 让长内容能收缩、配合
 * Markdown 的 overflow-wrap 不撑破容器（验收 2-18）。
 */
export const MessageBubble = forwardRef<HTMLDivElement, MessageBubbleProps>(function MessageBubble(
  { block, role, streaming = false, className, ...rest },
  ref,
) {
  // F1 §2.4：空文本（mock 首字未到的占位块）不渲染 —— 否则等待占位行下方会并存一个空壳气泡
  if (!block.content.trim()) return null;
  return (
    <div
      ref={ref}
      className={cn(
        "min-w-0 rounded-xl px-3.5 py-2.5",
        role === "user"
          ? "bg-accent-soft text-text-primary"
          : "border border-border-subtle bg-bg-surface text-text-primary",
        className,
      )}
      style={{ maxWidth: MESSAGE_MAX_WIDTH }}
      {...rest}
    >
      <Markdown content={block.content} />
      {streaming ? (
        <span
          className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-text-primary align-middle"
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
});
