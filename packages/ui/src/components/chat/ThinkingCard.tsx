import { useEffect, useState } from "react";
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
 * 展开态的两种驱动：
 * 1. **实时对话**（`block.streaming` 有值）→ 自动：「思考中展开、思考结束收起」。
 *    思考中 = reducer 把该段标为 `streaming:true`（它是当前最后且仍在增长的 part）；
 *    一旦后面出现正文/工具调用或消息结束 → `streaming:false` → 收起。
 * 2. **mock / 历史加载**（无 `streaming`）→ 回退 `collapsed` 默认（`expanded = !collapsed`），
 *    行为与改动前一致（演示态那条 thinking 仍展开）。
 *
 * 自动切换只发生在 `streaming` 变化时；用户在某一态下手工开/关会保留，直到下一次状态切换。
 * 折叠用条件渲染（不是 display:none，见 task-M2 6.6 禁止项），折叠态不占高度。
 *
 * `data-expanded` 必须反映真实状态，验收脚本会构造反例校验（见 .plan/m2-notes-A.md）。
 */
export function ThinkingCard({ block }: ThinkingCardProps) {
  const [expanded, setExpanded] = useState(block.streaming ?? !block.collapsed);

  // 流式状态变化时同步展开态（mock / 历史无 streaming → 不干预，保持手工态与 collapsed 默认）
  useEffect(() => {
    if (block.streaming === undefined) return;
    setExpanded(block.streaming);
  }, [block.streaming]);

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
