import { useState } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/common/icons";
import { ChevronDown, Sparkles } from "lucide-react";
import type { ThinkingBlock } from "@/mock/types";
import { Markdown } from "@/components/common/Markdown";

export interface ThinkingCardProps {
  block: ThinkingBlock;
}

/**
 * 思考块（可折叠）。
 *
 * 默认展开态来自 `block.collapsed`：规格里 thinking 块 `collapsed` 缺省为展开，
 * 所以 `expanded = !collapsed`。折叠用条件渲染（不是 display:none，见 task-M2 6.6 禁止项），
 * 折叠态不占高度、不影响布局。
 *
 * `data-expanded` 必须反映真实状态，验收脚本会构造反例校验（见 .plan/m2-notes-A.md）。
 */
export function ThinkingCard({ block }: ThinkingCardProps) {
  const [expanded, setExpanded] = useState(!block.collapsed);

  return (
    <div
      data-testid="thinking-card"
      className="min-w-0 rounded-lg border border-border-subtle bg-bg-subtle"
    >
      <button
        type="button"
        data-testid="thinking-toggle"
        data-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-bg-hover"
      >
        <Icon icon={Sparkles} className="text-icon-neutral" />
        <span className="font-medium">思考过程</span>
        <Icon
          icon={ChevronDown}
          className={cn("ml-auto text-icon-neutral transition-transform", expanded && "rotate-180")}
        />
      </button>
      {expanded ? (
        <div className="border-t border-border-subtle px-3.5 py-2">
          <Markdown content={block.content} className="text-text-secondary" />
        </div>
      ) : null}
    </div>
  );
}
