import { useEffect, useState, isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";
import { CODE_BLOCK_MAX_HEIGHT } from "@/lib/layout";
import { highlightCode } from "@/lib/highlight";

/**
 * Markdown 渲染（消息正文 + 思考块正文共用）。
 *
 * 为什么单独抽：`MessageBubble` 与 `ThinkingCard` 都要渲染 markdown，写两份必然出现
 * 样式/代码块行为不一致。这里集中处理 react-markdown + remark-gfm + Shiki 代码块。
 *
 * 双主题代码高亮：代码块交给 `highlightCode`（Shiki，懒加载）。Shiki 是异步的，
 * 所以 `CodeBlock` 先渲染纯文本兜底，高亮完成后 `dangerouslySetInnerHTML` 换上，
 * 高度变化由虚拟滚动的 `measureElement` 内置 ResizeObserver 自动重新测量。
 *
 * 长文本不破版（验收 2-18）：`overflow-wrap: anywhere` 是**可继承**属性，挂在
 * markdown-body 根节点即可覆盖 p / li / code / td 等所有子孙（见下方 inline style）。
 */

/** 把 react-markdown 传来的 children 还原成纯文本（代码块里是字符串，但保险起见递归） */
function toText(node: ReactNode): string {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(toText).join("");
  if (isValidElement(node)) {
    const el = node as React.ReactElement<{ children?: ReactNode }>;
    return toText(el.props.children);
  }
  return "";
}

/** Shiki 异步代码块：先渲染纯文本兜底，高亮就绪后替换 */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    highlightCode(code, lang).then((result) => {
      if (active) setHtml(result);
    });
    return () => {
      active = false;
    };
  }, [code, lang]);

  return (
    <div
      data-testid="code-block"
      className="my-2 overflow-auto rounded-md border border-border-subtle bg-bg-subtle"
      style={{ maxHeight: CODE_BLOCK_MAX_HEIGHT }}
    >
      {html ? (
        // Shiki 输出含自身 <pre>，背景/配色由 shiki.css 桥接
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="m-0 overflow-x-auto p-3 text-sm leading-relaxed">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

const MD_COMPONENTS: Components = {
  // 去掉 react-markdown 默认的 <pre> 包裹，避免 <div>(CodeBlock) 嵌在 <pre> 里（非法 HTML）
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children }) {
    const match = /language-(\w+)/.exec(className ?? "");
    if (match) {
      // 去掉代码块末尾可能的换行，避免 Shiki 多渲染一行空行
      return <CodeBlock code={toText(children).replace(/\n$/, "")} lang={match[1]} />;
    }
    // 行内代码：用语义令牌底色，不写固定色
    return <code className="rounded bg-bg-subtle px-1 py-0.5 text-[0.9em] text-text-primary">{children}</code>;
  },
  h1: ({ children }) => <h1 className="mb-1 mt-3 text-md font-semibold text-text-primary">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1 mt-3 text-md font-semibold text-text-primary">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 text-base font-semibold text-text-primary">{children}</h3>,
  p: ({ children }) => <p className="my-1.5 leading-relaxed text-text-primary">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5 text-text-primary">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5 text-text-primary">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-2 w-full overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-bg-subtle">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-border-subtle px-2 py-1 text-left font-medium text-text-primary">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border border-border-subtle px-2 py-1 text-text-secondary">{children}</td>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border-strong pl-3 text-text-secondary">{children}</blockquote>
  ),
};

export interface MarkdownProps {
  content: string;
  className?: string;
}

export function Markdown({ content, className }: MarkdownProps) {
  return (
    <div
      data-testid="markdown-body"
      className={cn("min-w-0 text-sm", className)}
      // overflow-wrap 可继承：挂在根节点即覆盖 p/li/code/td（验收 2-18）
      style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
