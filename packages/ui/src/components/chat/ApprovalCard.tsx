import { cn } from "@/lib/cn";
import { Icon } from "@/components/common/icons";
import { Check, ShieldQuestion } from "lucide-react";
import type { ApprovalBlock } from "@/mock/types";
import { useChatStore } from "@/store/chat-store";

export interface ApprovalCardProps {
  block: ApprovalBlock;
}

/**
 * 授权卡片（可交互 / 已决置灰）。
 *
 * - 未决（resolved 为空）：两个选项都可直接点，点击后写回 store（resolveApproval）。
 * - 已决：两个选项都 `disabled`（验收 2-8 要求不可再点），并高亮用户已选的那一项。
 * - `data-resolved` 必须反映真实状态：resolved 非空为 "true"，空为 "false"。
 *   验收脚本会构造「已决卡片两按钮都 disabled」的反例。
 */
export function ApprovalCard({ block }: ApprovalCardProps) {
  const resolveApproval = useChatStore((state) => state.resolveApproval);
  const resolved = block.resolved ?? "";
  const isResolved = resolved !== "";

  return (
    <div
      data-testid="approval-card"
      data-resolved={isResolved}
      className="min-w-0 rounded-lg border border-border-default bg-bg-surface p-3"
    >
      <div className="mb-1 flex items-center gap-2 text-sm font-medium text-text-primary">
        <Icon icon={ShieldQuestion} className="text-icon-neutral" />
        {block.title}
      </div>
      {block.message ? <p className="mb-2.5 text-sm text-text-secondary">{block.message}</p> : null}

      <div className="flex flex-wrap gap-2">
        {block.options.map((option, index) => {
          const chosen = resolved === option;
          return (
            <button
              key={option}
              type="button"
              data-testid={`approval-option-${index}`}
              data-option={option}
              disabled={isResolved}
              onClick={() => resolveApproval(block.requestId, option)}
              aria-pressed={chosen}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors",
                "disabled:cursor-not-allowed",
                chosen
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border-default bg-bg-app text-text-primary hover:bg-bg-hover",
                isResolved && !chosen && "opacity-60",
              )}
            >
              {chosen ? <Icon icon={Check} className="text-current" /> : null}
              {option}
            </button>
          );
        })}
      </div>

      {isResolved ? (
        <p className="mt-2 text-xs text-text-tertiary">已选择：{resolved}</p>
      ) : null}
    </div>
  );
}
