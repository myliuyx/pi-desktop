import { useState } from "react";
import { cn } from "@/lib/cn";
import { countDiffChanges, parseDetailsDiff } from "@/lib/diff-parse";
import { TERMINAL_MAX_LINES } from "@/lib/layout";

export interface ToolDiffViewProps {
  /** 被编辑文件的路径（args.path，头行展示；取不到为空串则头行只显统计） */
  path: string;
  /** 上游 details.diff（generateDiffString 产物，格式见 lib/diff-parse.ts） */
  diff: string;
  /** 一次调用的替换块数（args.edits.length，取不到不显示该段） */
  editsCount?: number;
}

/**
 * edit 工具的展开区 diff（task-tool-diff-preview.md，参考图 2）。
 *
 * 数据来自上游算好的 `details.diff`（D1），单列行号（D4）：add/ctx 是新文件行号、
 * del 是旧文件行号，长段未变内容折叠成省略标记行（kind="skip"）。
 * 行底色用专用令牌 --diff-add-bg / --diff-del-bg（tokens.css 深浅两套；
 * soft 令牌是徽章语义，行级背景要能独立调档）。
 *
 * 截断口径与终端输出同款（TERMINAL_MAX_LINES 首屏 + 「查看完整内容」+ 展开后 220px 滚动）；
 * 文本走纯 React 节点（内容来自模型/文件，不 innerHTML）。
 */
export function ToolDiffView({ path, diff, editsCount }: ToolDiffViewProps) {
  const [full, setFull] = useState(false);

  const lines = parseDetailsDiff(diff);
  const { added, removed } = countDiffChanges(lines);
  const truncated = lines.length > TERMINAL_MAX_LINES && !full;
  const shown = truncated ? lines.slice(0, TERMINAL_MAX_LINES) : lines;

  const stats = added + removed > 0 ? `（+${added} / -${removed} 行）` : "";
  const edits = typeof editsCount === "number" && editsCount > 0 ? ` · ${editsCount} 处替换` : "";
  const header = `${path}${edits}${stats}`;

  return (
    <div data-testid="tool-diff" className="border-t border-border-subtle bg-bg-surface">
      {header ? (
        <div className="border-b border-border-subtle px-3 py-1.5 font-mono text-xs text-text-secondary">
          {header}
        </div>
      ) : null}
      <div
        className="overflow-auto py-1 font-mono text-xs leading-relaxed"
        style={{ maxHeight: truncated ? undefined : 220 }}
      >
        {shown.map((line, index) => (
          <div
            key={index}
            data-kind={line.kind}
            className={cn(
              "flex min-w-0",
              line.kind === "add" && "bg-diff-add text-success",
              line.kind === "del" && "bg-diff-del text-danger",
              line.kind === "ctx" && "text-text-secondary",
              line.kind === "skip" && "select-none text-text-tertiary italic",
            )}
          >
            <span className="w-10 shrink-0 select-none pr-2 text-right text-text-tertiary">
              {line.lineNo ?? ""}
            </span>
            {/* 空内容行给一个空格撑出行盒，否则行高塌成 0 */}
            <span className="min-w-0 whitespace-pre-wrap break-words pr-3">{line.content || " "}</span>
          </div>
        ))}
        {truncated ? (
          <button
            type="button"
            onClick={() => setFull(true)}
            className="mt-1 px-3 text-left text-accent underline underline-offset-2"
          >
            查看完整内容（还有 {lines.length - TERMINAL_MAX_LINES} 行）
          </button>
        ) : null}
      </div>
    </div>
  );
}
