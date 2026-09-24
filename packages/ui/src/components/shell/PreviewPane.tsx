import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
} from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  COLLAPSE_DURATION,
  COLLAPSE_DURATION_REDUCED,
  COLLAPSED_WIDTH,
  PREVIEW_COPY_RESET_MS,
  PREVIEW_PANE_WIDTH,
  PREVIEW_TABBAR_HEIGHT,
  PREVIEW_TABBAR_PADDING_X,
} from "@/lib/layout";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { useUiStore } from "@/store/ui-store";
import { highlightCode } from "@/lib/highlight";
import { buildPreviewHtml, previewLanguage } from "@/mock/preview";
import { Icon } from "@/components/common/icons";
import { Tabs, tabPanelProps } from "@/components/primitives/Tabs";

export interface PreviewPaneProps extends HTMLAttributes<HTMLElement> {}

/** Tab 定义：id 与 ui-store 的 previewTab 值一一对应 */
const PREVIEW_TABS = [
  { id: "effect", label: "预览效果", testId: "preview-tab-effect" },
  { id: "code", label: "预览源码", testId: "preview-tab-code" },
];

/**
 * 预览区（默认宽 480，可折叠，M3 起为双 Tab）。
 *
 * 折叠实现与 Sidebar 一致：宽度过渡 + overflow:hidden，不用 display:none。
 * Tab：顶部 Tab 条 + 下方内容区随 Tab 互斥渲染 ——
 * - 效果态：iframe sandbox 渲染 mock 产物。iframe 是独立文档用不了应用令牌，
 *   所以按当前主题生成对应配色的 HTML，切主题时随 srcDoc 重载换肤；
 * - 源码态：Shiki 高亮（--shiki-* 双主题变量，切主题无需重高亮）+ CSS counter 行号 + 复制。
 * 折叠时整个 aside 照旧收 0 宽，Tab 内容随 overflow-hidden 裁掉，无需特殊处理。
 */
export const PreviewPane = forwardRef<HTMLElement, PreviewPaneProps>(function PreviewPane(
  { className, ...rest },
  ref,
) {
  const collapsed = useUiStore((state) => state.previewCollapsed);
  const previewTab = useUiStore((state) => state.previewTab);
  const setPreviewTab = useUiStore((state) => state.setPreviewTab);
  const theme = useUiStore((state) => state.theme);
  const prefersReducedMotion = usePrefersReducedMotion();

  const previewHtml = useMemo(() => buildPreviewHtml(theme), [theme]);

  return (
    <aside
      ref={ref}
      data-testid="preview-pane"
      data-collapsed={collapsed}
      aria-label="预览区"
      aria-hidden={collapsed}
      className={cn(
        // 同 Sidebar：`flex` 与 `flex-col` 同传，靠 cn() 的 flex 分组区分
        // 分隔线用 `divider-l`（绝对定位伪元素）而非 border-l：border 在 border-box 下
        // 最窄就是 1px，会让折叠态卡在 1px、内容区只有 1422（验收 1-13 要求严格 0）
        "flex h-full min-h-0 min-w-0 shrink-0 flex-col overflow-hidden divider-l bg-bg-surface",
        // 同 Sidebar：不加 motion-reduce:transition-none，否则过渡被整个取消；改用缩短时长适配
        "transition-[width] ease-out",
        className,
      )}
      style={{
        width: collapsed ? COLLAPSED_WIDTH : PREVIEW_PANE_WIDTH,
        transitionDuration: `${prefersReducedMotion ? COLLAPSE_DURATION_REDUCED : COLLAPSE_DURATION}ms`,
      }}
      {...rest}
    >
      <div
        data-testid="preview-tabbar"
        className="flex shrink-0 items-center gap-2 border-b border-border-subtle"
        style={{
          height: PREVIEW_TABBAR_HEIGHT,
          paddingLeft: PREVIEW_TABBAR_PADDING_X,
          paddingRight: PREVIEW_TABBAR_PADDING_X,
        }}
      >
        <Tabs
          idPrefix="preview"
          label="预览视图"
          items={PREVIEW_TABS}
          value={previewTab}
          onChange={setPreviewTab}
          className="flex items-center gap-1"
          tabClassName={cn(
            "inline-flex h-8 select-none items-center justify-center rounded-md px-3 text-sm",
            "transition-colors duration-150 ease-out",
            "text-text-secondary hover:bg-bg-hover active:bg-bg-active",
          )}
          activeTabClassName="bg-bg-subtle text-text-primary"
        />
        {/* 弹性占位：把源码态的复制按钮推到右端（效果态此处为空） */}
        <div className="min-w-0 flex-1" />
        {previewTab === "code" ? <CopySourceButton source={previewHtml} /> : null}
      </div>

      {previewTab === "code" ? (
        <PreviewSource {...tabPanelProps("preview", "code")} source={previewHtml} />
      ) : (
        <div
          {...tabPanelProps("preview", "effect")}
          className="min-h-0 flex-1"
        >
          {/* 完全沙箱（空值）即可：mock 是纯静态 HTML，不需要 scripts / same-origin */}
          <iframe
            data-testid="preview-iframe"
            sandbox=""
            srcDoc={previewHtml}
            title="预览效果"
            className="h-full w-full border-0"
          />
        </div>
      )}
    </aside>
  );
});

/** shiki 未就绪前的纯文本兜底（与 Markdown 的 CodeBlock 同策略，避免空白闪烁） */
function escapeHtml(code: string): string {
  return code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 给 shiki 输出的每个行 span（`<span class="line">`）补上 data-line 序号。
 * shiki 的行 span 自身不带属性，按固定前缀替换是安全的；行号渲染本身走
 * shiki.css 里的 CSS counter（与代码同行流，步进/行高天然对齐）。
 */
function withLineData(html: string): string {
  let index = 0;
  return html.replace(/<span class="line"/g, () => {
    index += 1;
    return `<span class="line" data-line="${index}"`;
  });
}

/**
 * 源码态：Shiki 高亮 + 行号 + data-line-count（验收 3-2 的三要素载体）。
 *
 * 面板端 aria 属性（`role="tabpanel"` / `aria-labelledby`）由调用方通过
 * `tabPanelProps("preview", "code")` 透传进来（G7 收尾，见 primitives/Tabs.tsx）。
 */
function PreviewSource(props: ReturnType<typeof tabPanelProps> & { source: string }) {
  const { source, ...rest } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | null>(null);

  const fallbackHtml = useMemo(
    () => `<pre class="shiki"><code>${escapeHtml(source)}</code></pre>`,
    [source],
  );

  useEffect(() => {
    let active = true;
    highlightCode(source, previewLanguage).then((result) => {
      if (active) setHtml(withLineData(result));
    });
    return () => {
      active = false;
    };
  }, [source]);

  // 高亮渲染完成后从 DOM 数行数写入 data-line-count：
  // 保证该值与真实渲染行数一致（而不是从源字符串猜，尾随换行会差一行）。
  useEffect(() => {
    if (!html || !containerRef.current) return;
    const count = containerRef.current.querySelectorAll(".line").length;
    containerRef.current.dataset.lineCount = String(count);
  }, [html]);

  return (
    <div
      ref={containerRef}
      {...rest}
      data-testid="preview-source"
      className="preview-source min-h-0 flex-1 overflow-auto font-mono"
      dangerouslySetInnerHTML={{ __html: html ?? fallbackHtml }}
    />
  );
}

/** 复制按钮：clipboard API 失败回退 execCommand，再失败静默（headless 无权限也不能抛错） */
async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // 落到 execCommand 回退
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  } catch {
    // 静默：原型阶段复制失败不阻塞 UI
  }
}

function CopySourceButton({ source }: { source: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const onCopy = () => {
    void copyTextToClipboard(source);
    // 「静默成功」策略：无论剪贴板是否真的可用都进入已复制态（headless 下也能走查到该态）
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), PREVIEW_COPY_RESET_MS);
  };

  return (
    <button
      type="button"
      data-testid="preview-copy"
      onClick={onCopy}
      aria-label={copied ? "已复制" : "复制源码"}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-sm",
        "transition-colors duration-150 ease-out",
        "text-text-secondary hover:bg-bg-hover hover:text-text-primary active:bg-bg-active",
      )}
    >
      <Icon icon={copied ? Check : Copy} />
      <span className="whitespace-nowrap">{copied ? "已复制" : "复制"}</span>
    </button>
  );
}
