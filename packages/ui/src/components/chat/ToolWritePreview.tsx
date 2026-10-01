import { useEffect, useState } from "react";
import { extToLang, highlightCode } from "@/lib/highlight";
import { TERMINAL_MAX_LINES } from "@/lib/layout";

export interface ToolWritePreviewProps {
  /** 写入目标路径（args.path，头行展示 + 推断高亮语言） */
  path: string;
  /** 写入的完整内容（args.content） */
  content: string;
}

/**
 * write 工具的展开区内容预览（task-tool-diff-preview.md，参考图 1，D2=shiki 高亮）。
 *
 * 数据即 toolCall args 的 `{ path, content }`（live / 历史两条链路天然都有，零 core 依赖）。
 * 高亮与行号完全复用 PreviewPane 源码态的基建：`highlightCode`（懒加载单例、双主题）+
 * `.preview-source` 的 CSS counter 行号 gutter（shiki.css 既有，不新写样式）；
 * shiki 未就绪/失败时回落纯文本（同 Markdown CodeBlock 手法，无行号但内容可见）。
 * 截断口径与 ToolDiffView 同款（TERMINAL_MAX_LINES 首屏 + 「查看完整内容」）。
 */
export function ToolWritePreview({ path, content }: ToolWritePreviewProps) {
  const [full, setFull] = useState(false);
  const [html, setHtml] = useState<string | null>(null);

  // Windows 文件常见 CRLF：先归一成 LF 再计数/高亮，防止行号双计
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lineCount = normalized.split("\n").length;
  const truncated = lineCount > TERMINAL_MAX_LINES && !full;
  const shownText = truncated ? normalized.split("\n").slice(0, TERMINAL_MAX_LINES).join("\n") : normalized;
  const lang = extToLang(path);

  useEffect(() => {
    let active = true;
    highlightCode(shownText, lang).then((result) => {
      if (active) setHtml(result);
    });
    return () => {
      active = false;
    };
  }, [shownText, lang]);

  return (
    <div data-testid="tool-write-preview" className="border-t border-border-subtle bg-bg-surface">
      <div className="border-b border-border-subtle px-3 py-1.5 font-mono text-xs text-text-secondary">
        {path ? `${path} · ` : ""}新写入 {lineCount} 行
      </div>
      <div
        className="preview-source min-h-0 overflow-auto font-mono"
        style={{ maxHeight: truncated ? undefined : 220 }}
      >
        {html ? (
          // Shiki 输出含自身 <pre>，背景/配色/行号 gutter 由 shiki.css 桥接
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="m-0 overflow-x-auto p-3 text-md leading-relaxed">
            <code>{shownText}</code>
          </pre>
        )}
        {truncated ? (
          <button
            type="button"
            onClick={() => setFull(true)}
            className="mt-1 px-3 pb-2 text-left text-accent underline underline-offset-2"
          >
            查看完整内容（还有 {lineCount - TERMINAL_MAX_LINES} 行）
          </button>
        ) : null}
      </div>
    </div>
  );
}
