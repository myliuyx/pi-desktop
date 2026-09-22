import { useState } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/common/icons";
import { ChevronDown, Terminal, TriangleAlert, Check } from "lucide-react";
import type { TerminalBlock } from "@/mock/types";
import { TERMINAL_MAX_LINES } from "@/lib/layout";
import { truncateLines } from "@/lib/format";

export interface TerminalCardProps {
  block: TerminalBlock;
}

/**
 * 终端卡片（等宽 / 截断 / 展开）。
 *
 * 三个 data 属性都要反映真实状态（验收会构造反例）：
 * - `data-expanded`（terminal-toggle）：输出面板是否展开
 * - `data-truncated`（terminal-output）：当前是否处于「截断态」
 *   = 原始 `block.truncated` 且用户还没点「查看完整内容」。`block.truncated=false`
 *   时必须为 false（反例：把一条成功但很短的输出标 truncated=false 验证）。
 * - `terminal-expand`：进入完整内容的入口，仅截断态且未展开时出现。
 *
 * 折叠用条件渲染（非 display:none，见 task-M2 6.6）。
 */
export function TerminalCard({ block }: TerminalCardProps) {
  const [showOutput, setShowOutput] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const isError = block.status === "error";
  const truncatedNow = block.truncated === true && !expanded;

  const { visible } = truncateLines(block.output, TERMINAL_MAX_LINES);
  const shownOutput = truncatedNow ? visible : block.output;

  return (
    <div data-testid="terminal-card" className="min-w-0 rounded-lg border border-border-subtle bg-bg-surface">
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon icon={Terminal} className="text-icon-neutral" />
        <span className="text-sm font-medium text-text-primary">终端</span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
            isError ? "bg-danger-soft text-danger" : "bg-success-soft text-success",
          )}
        >
          <Icon icon={isError ? TriangleAlert : Check} className="text-current" />
          {isError ? `退出码 ${block.exitCode ?? 1}` : "成功"}
        </span>
        <button
          type="button"
          data-testid="terminal-toggle"
          data-expanded={showOutput}
          aria-expanded={showOutput}
          aria-label={showOutput ? "收起输出" : "展开输出"}
          onClick={() => setShowOutput((v) => !v)}
          className="ml-auto rounded p-1 text-icon-neutral transition-colors hover:bg-bg-hover"
        >
          <Icon icon={ChevronDown} className={cn("transition-transform", showOutput && "rotate-180")} />
        </button>
      </div>

      {/* 命令行：等宽字体，带提示符 */}
      <div
        data-testid="terminal-command"
        className="border-t border-border-subtle px-3 py-1.5 font-mono text-xs text-text-secondary"
      >
        <span className="select-none text-text-tertiary">$ </span>
        {block.command}
      </div>

      {showOutput ? (
        <div
          data-testid="terminal-output"
          data-truncated={truncatedNow}
          className={cn(
            "overflow-auto border-t border-border-subtle bg-bg-subtle px-3 py-2 font-mono text-xs leading-relaxed",
            isError ? "text-danger" : "text-text-primary",
          )}
          /*
           * 必须带 overflow-auto：只给 maxHeight 不给 overflow 时，展开后的长输出会
           * **溢出到卡片外**而不是在卡片内滚动（实测 computed overflowY = "visible"）。
           * 验收 2-7 要求「输出可滚动」，这是那一半的落点。
           */
          style={{ maxHeight: expanded || !block.truncated ? 220 : undefined }}
        >
          <pre className="m-0 whitespace-pre-wrap break-words">{shownOutput}</pre>
          {truncatedNow ? (
            <button
              type="button"
              data-testid="terminal-expand"
              onClick={() => setExpanded(true)}
              className="mt-1 text-left text-accent underline underline-offset-2"
            >
              查看完整内容（还有 {block.hiddenLineCount ?? 0} 行）
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
