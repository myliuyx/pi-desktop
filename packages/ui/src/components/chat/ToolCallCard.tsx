import { useState } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/common/icons";
import { Check, ChevronDown, Loader2, TriangleAlert, Wrench } from "lucide-react";
import type { TerminalBlock, ToolCallBlock } from "@/mock/types";
import { TERMINAL_MAX_LINES } from "@/lib/layout";
import { truncateLines } from "@/lib/format";
import { toolArgsPreview } from "@/lib/tool-preview";
import { ToolDiffView } from "./ToolDiffView";
import { ToolWritePreview } from "./ToolWritePreview";

export interface ToolCallCardProps {
  call: ToolCallBlock;
  /** 配对的终端块（live 流式 / 历史加载都会带上；undefined = 执行事件还没到） */
  terminal?: TerminalBlock;
}

/**
 * 工具执行**一行式**卡片（2026-09-26 用户裁决：合并 tool_call 行与终端卡）。
 *
 * 此前 live 一次 bash 执行渲染两块：`ToolCallInline`（bash + 命令预览）一行、
 * `TerminalCard`（「终端」+ 成功徽章 + 命令 + 输出）一行；合并后收起只有一行 ——
 * 图标 + 工具名 + 命令预览 + 状态徽章 + 右侧下拉，展开才看命令行与输出。
 *
 * - 状态徽章保留（用户裁决）：running 转圈 / 成功 ✓ / 失败 退出码 N ——
 *   扫一眼定位失败命令全靠它（原 TerminalCard 的 running 态会被误标「成功」，这里顺手修正）；
 * - 展开区截断口径与 TerminalCard 完全同款（TERMINAL_MAX_LINES + 查看完整内容），
 *   TerminalCard 本体一行不动（mock 会话 / 03 屏验收面零影响）；
 * - 展开区按工具分派（task-tool-diff-preview.md）：edit → ToolDiffView（上游
 *   details.diff 的红绿 diff）、write → ToolWritePreview（args.content 带行号高亮预览）；
 *   分派不命中回落命令 + 输出文本，bash 等其余工具行为不变；
 * - 配对逻辑在 MessageList（同消息 + 同 toolCallId），配不上的块仍走老组件。
 */
export function ToolCallCard({ call, terminal }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const [fullOutput, setFullOutput] = useState(false);

  const command = terminal?.command ?? (typeof call.args.command === "string" ? call.args.command : "");
  // D3（task-tool-diff-preview.md）：edit/write 用面向人的短摘要，其余工具维持通用兜底
  const argsPreview = toolArgsPreview(call.toolName, call.args);
  const status = terminal?.status ?? "running";
  const isError = status === "error";
  const truncatedNow = terminal?.truncated === true && !fullOutput;
  const { visible } = truncateLines(terminal?.output ?? "", TERMINAL_MAX_LINES);
  const shownOutput = truncatedNow ? visible : (terminal?.output ?? "");

  /*
   * 展开区分派（D1/D2）：edit 且上游 details.diff 就位 → DiffView（红绿行级 diff）；
   * write 且 args.content 就位 → 写入内容预览（带行号 + shiki 高亮）。
   * 两者取不到（旧会话无 details / 裸事件 / 形状异常）都回落现状的命令 + 输出文本，
   * 不本地重算 diff（诚实展示：没有就说没有）。
   */
  const editDiff =
    call.toolName === "edit" && terminal?.details && typeof terminal.details.diff === "string"
      ? terminal.details.diff
      : undefined;
  const editPath = call.toolName === "edit" && typeof call.args.path === "string" ? call.args.path : "";
  const editCount = call.toolName === "edit" && Array.isArray(call.args.edits) ? call.args.edits.length : undefined;
  const writeContent =
    call.toolName === "write" && typeof call.args.content === "string" ? call.args.content : undefined;
  const writePath = call.toolName === "write" && typeof call.args.path === "string" ? call.args.path : "";
  const customView =
    editDiff ? (
      <ToolDiffView path={editPath} diff={editDiff} editsCount={editCount} />
    ) : writeContent !== undefined ? (
      <ToolWritePreview path={writePath} content={writeContent} />
    ) : null;

  return (
    <div data-testid="tool-call-card" className="min-w-0 rounded-lg border border-border-subtle bg-bg-subtle">
      {/* 整行可点（比单独的箭头热区大）；「查看完整内容」在展开区，与行按钮是兄弟节点不嵌套 */}
      <button
        type="button"
        data-expanded={open}
        aria-expanded={open}
        aria-label={open ? "收起工具执行详情" : "展开工具执行详情"}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-md",
          "text-text-secondary transition-colors duration-150 ease-out hover:bg-bg-hover",
        )}
      >
        <Icon icon={Wrench} className="shrink-0 text-icon-neutral" />
        <span className="shrink-0 font-medium text-text-primary">{call.toolName}</span>
        <span className="min-w-0 truncate font-mono text-xs text-text-tertiary" title={command || argsPreview}>
          {argsPreview}
        </span>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs",
            status === "running" && "bg-bg-active text-text-tertiary",
            isError && "bg-danger-soft text-danger",
            status === "success" && "bg-success-soft text-success",
          )}
        >
          {status === "running" ? (
            <>
              <Icon icon={Loader2} className="shrink-0 animate-spin text-current" />
              运行中
            </>
          ) : isError ? (
            <>
              <Icon icon={TriangleAlert} className="shrink-0 text-current" />
              退出码 {terminal?.exitCode ?? 1}
            </>
          ) : (
            <>
              <Icon icon={Check} className="shrink-0 text-current" />
              成功
            </>
          )}
        </span>
        <Icon
          icon={ChevronDown}
          className={cn("ml-auto shrink-0 text-icon-neutral transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        customView ? (
          /* 分派命中：diff / 内容预览整体替换命令 + 输出区（路径与统计已在头行） */
          customView
        ) : (
          <>
            {command ? (
              <div
                data-testid="terminal-command"
                className="border-t border-border-subtle px-3 py-1.5 font-mono text-xs text-text-secondary"
              >
                <span className="select-none text-text-tertiary">$ </span>
                {command}
              </div>
            ) : null}
            {terminal ? (
              <div
                data-testid="terminal-output"
                data-truncated={truncatedNow}
                className={cn(
                  "overflow-auto border-t border-border-subtle bg-bg-surface px-3 py-2 font-mono text-xs leading-relaxed",
                  isError ? "text-danger" : "text-text-primary",
                )}
                style={{ maxHeight: fullOutput || !terminal.truncated ? 220 : undefined }}
              >
                <pre className="m-0 whitespace-pre-wrap break-words">{shownOutput}</pre>
                {truncatedNow ? (
                  <button
                    type="button"
                    onClick={() => setFullOutput(true)}
                    className="mt-1 text-left text-accent underline underline-offset-2"
                  >
                    查看完整内容（还有 {terminal.hiddenLineCount ?? 0} 行）
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}
