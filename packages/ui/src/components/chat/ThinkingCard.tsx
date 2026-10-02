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
 * 思考块（三态：尾窗 / 全文 / 收起）。
 *
 * 形态判定（`data-mode` 三值，探针唯一判据；`data-expanded` 只在 full 为 true）：
 * - `tail`：流式中且未手动展开 —— 只渲染一行高的「尾窗」（`.thinking-tail-window`
 *   顶部渐隐 + 内容底部锚定），新内容从渐隐区长出来、可视区恒停在最后一行
 *   （tail -f 观感），窗口高度恒定 ⇒ 流式期列表不再被思考内容反复撑高。
 * - `full`：全文展开（流式中手动展开 / settled 后手动展开）。
 * - `collapsed`：收起，条件渲染不占高度（task-M2 6.6 禁 display:none）。
 *
 * 展开态驱动（`streaming` 标志语义见 adapter/reduce.ts `blocksFrom`，本组件只消费）：
 * 1. **实时对话**（`block.streaming` 有值）→ 该值任一方向翻转都收口 `setExpanded(false)`：
 *    思考开始回尾窗默认；思考结束强制收起（含流式中被手动展开过的情况，D2 裁决保持现状语义）。
 *    内容增量不改 `streaming` ⇒ 手动展开态在流式期间稳定。
 * 2. **mock / 历史加载**（无 `streaming`）→ 回退 `collapsed` 默认（`expanded = !collapsed`），
 *    行为与尾窗化之前一致（演示态那条 thinking 仍展开）。
 *
 * 尾窗内容为空时不渲染窗口（防 30px 哑壳）；流式中滚远再滚回触发虚拟化重挂会丢
 * 手动展开态、回落尾窗——虚拟化语义下的既有取舍。规格：.plan/task-thinking-tail.md。
 */
export function ThinkingCard({ block }: ThinkingCardProps) {
  const [expanded, setExpanded] = useState(block.streaming ? false : !block.collapsed);

  // streaming 翻转即收口 false（mock / 历史无 streaming → 不干预，保持手工态与 collapsed 默认）
  useEffect(() => {
    if (block.streaming === undefined) return;
    setExpanded(false);
  }, [block.streaming]);

  const tailing = block.streaming === true && !expanded;

  return (
    <div
      data-testid="thinking-card"
      data-mode={expanded ? "full" : tailing ? "tail" : "collapsed"}
      className="min-w-0 rounded-lg border border-border-subtle bg-bg-subtle"
    >
      <button
        type="button"
        data-testid="thinking-toggle"
        data-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-md text-text-secondary transition-colors hover:bg-bg-hover"
      >
        <Icon icon={Sparkles} className="text-icon-neutral" />
        <span className="font-medium">思考过程</span>
        {block.streaming === true && (
          <span
            aria-hidden="true"
            className="thinking-dot h-1.5 w-1.5 shrink-0 rounded-full bg-text-tertiary"
          />
        )}
        <Icon
          icon={ChevronDown}
          className={cn("ml-auto text-icon-neutral transition-transform", expanded && "rotate-180")}
        />
      </button>
      {tailing && block.content.trim() !== "" ? (
        /*
         * border-t 放外层：mask 盖在带边框的节点上会把顶部边线一起淡掉。
         * 水平内边距落在 absolute 内层（inset 相对 padding box，父级 px 不约束绝对定位子元素）。
         */
        <div className="border-t border-border-subtle">
          <div
            data-testid="thinking-tail"
            className="thinking-tail-window relative h-[30px] overflow-hidden"
          >
            <div className="absolute inset-x-3.5 bottom-0">
              <Markdown
                content={block.content}
                className="text-text-secondary [&>*:last-child]:mb-0"
              />
            </div>
          </div>
        </div>
      ) : expanded ? (
        <div className="border-t border-border-subtle px-3.5 py-2">
          <Markdown content={block.content} className="text-text-secondary" />
        </div>
      ) : null}
    </div>
  );
}
