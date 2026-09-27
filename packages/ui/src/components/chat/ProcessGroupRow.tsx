import { cn } from "@/lib/cn";
import { Icon } from "@/components/common/icons";
import { ChevronDown } from "lucide-react";

export interface ProcessGroupRowProps {
  /** N：本轮 assistant 消息条数（含最终答复，2026-09-27 用户裁决） */
  messageCount: number;
  /** M：本轮工具调用次数（按 toolCallId 去重，2026-09-27 用户裁决） */
  toolCallCount: number;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * 「处理详情」折叠行（task-process-collapse.md）。
 *
 * 一轮回复完结（agent_settled）后，若既有工具调用又有最终文本，整轮过程块
 * （thinking / tool_call / 终端 / plan）由 MessageList 收起，只留这一行 +
 * 最终答复 —— 参考截图「处理详情, 10 条消息 · 18 次工具调用」。
 *
 * 与 ThinkingCard / ToolCallCard 同范式：整行可点（热区大）、`data-expanded`
 * 反映真实状态（验收脚本会读）、aria-expanded 同步。本组件折叠态没有内容区 ——
 * 过程块的显隐由 MessageList 分派，这里只有行本身。chevron 收起朝右（-rotate-90）、
 * 展开朝下，与参考截图一致（图标沿用 repo 的 ChevronDown + transform 惯例）。
 */
export function ProcessGroupRow({ messageCount, toolCallCount, expanded, onToggle }: ProcessGroupRowProps) {
  return (
    <button
      type="button"
      data-testid="process-details"
      data-expanded={expanded}
      aria-expanded={expanded}
      aria-label={expanded ? "收起本轮处理详情" : "展开本轮处理详情"}
      title={expanded ? "点击收起本轮处理过程" : "点击展开本轮处理过程"}
      onClick={onToggle}
      className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left text-sm text-text-secondary transition-colors hover:bg-bg-hover"
    >
      <Icon
        icon={ChevronDown}
        className={cn("shrink-0 text-icon-neutral transition-transform", !expanded && "-rotate-90")}
      />
      <span className="min-w-0 truncate">
        处理详情 · {messageCount} 条消息 · {toolCallCount} 次工具调用
      </span>
    </button>
  );
}
