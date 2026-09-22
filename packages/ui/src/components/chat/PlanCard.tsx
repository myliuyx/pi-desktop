import { cn } from "@/lib/cn";
import { Icon, type LucideIcon } from "@/components/common/icons";
import { Check, Circle, Loader2, X } from "lucide-react";
import type { PlanBlock, PlanStepStatus } from "@/mock/types";

export interface PlanCardProps {
  block: PlanBlock;
}

/**
 * 执行计划卡片（四态）。
 *
 * 四态齐全是验收 2-6 的硬要求，所以这里把状态 → 图标/颜色映射写全，
 * 缺任一态都会导致验收脚本找不到对应 `data-status`。颜色全走语义令牌：
 * done→success、failed→danger、running→accent、pending→text-tertiary。
 */
const STATUS_META: Record<
  PlanStepStatus,
  { icon: LucideIcon; label: string; className: string; spin?: boolean }
> = {
  done: { icon: Check, label: "完成", className: "text-success" },
  running: { icon: Loader2, label: "进行中", className: "text-accent", spin: true },
  pending: { icon: Circle, label: "待执行", className: "text-text-tertiary" },
  failed: { icon: X, label: "失败", className: "text-danger" },
};

export function PlanCard({ block }: PlanCardProps) {
  return (
    <div
      data-testid="plan-card"
      className="min-w-0 rounded-lg border border-border-subtle bg-bg-surface p-3"
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-text-primary">
        <span>执行计划</span>
        <span className="text-text-tertiary">·</span>
        <span className="text-text-tertiary">{block.steps.length} 步</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {block.steps.map((step) => {
          const meta = STATUS_META[step.status];
          return (
            <li
              key={step.id}
              data-testid="plan-step"
              data-status={step.status}
              className="flex items-center gap-2 text-sm"
            >
              <Icon
                icon={meta.icon}
                className={cn(meta.className, meta.spin && "animate-spin")}
              />
              <span className={step.status === "failed" ? "text-text-primary line-through" : "text-text-primary"}>
                {step.title}
              </span>
              <span className={cn("ml-auto text-xs", meta.className)}>{meta.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
