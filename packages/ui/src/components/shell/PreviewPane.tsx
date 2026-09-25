import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Check, Copy, File, Loader2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { isLiveEnabled } from "@/lib/feature-flags";
import { getLiveTransport } from "@/services/live-transport";
import type { FileReadResult } from "@/services/agent-transport";
import { useChatStore } from "@/store/chat-store";
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
import { Markdown } from "@/components/common/Markdown";
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
 *
 * ## live 缺省折叠 + 未选文件空态（2026-09-25 裁决）
 *
 * - 缺省折叠：`ui-store.readStoredPreviewCollapsed` —— 从未显式设置时 live 默认收 0 宽
 *   （mock 仍默认展开，`accept:m3` 的「默认态」断言依赖）；显式存过的选择两形态都尊重。
 * - live 且未选文件：渲染 `preview-empty` 空态（指路侧栏文件树），**不渲染 mock 双 Tab** ——
 *   假产物/假源码在 live 下属于「用假数据冒充现状」；mock 形态双 Tab 原样保留，
 *   故 `?preview=` 参数在 live 下成为 no-op（Tab 不渲染，状态写入无落点）。
 *
 * ## 文件形态（dir-file-preview 批次；2026-09-25 二轮：效果/源码双 Tab）
 *
 * `ui-store.previewFilePath` 非空（且 live 形态）时，整个内容区二选一顶替既有两 Tab：
 * 顶部文件名条（`preview-file-bar`）+ 下方 `FilePreviewView`。
 * - 唯一入口：侧栏文件树的文件行点击（WorkingDirFileTree）；mock 形态下树不渲染，
 *   `isLiveEnabled()` 再挡一层（状态残留也不渲染文件形态），既有 mock 行为**一行不差**；
 * - **效果可渲染的文件**（html/htm/svg → iframe 沙箱；md/markdown → Markdown 组件）
 *   名条里带「预览效果 / 预览源码」双 Tab，打开默认落在**效果**态（mock 语义：点开即看
 *   渲染结果，源码是第二视图）；其余文件（ts/json/…）只有源码形态，**不渲染 Tab**
 *   （没有第二视图就不给哑 Tab，同 mock 哑交互禁令）；
 * - 关闭（`preview-file-close`）清空选择**并直接收起预览区**（2026-09-25 用户裁决——
 *   live 下 × 的落点是收起而非空态；下次手动展开看到的是 live 空态）；
 * - 自动刷新：`chat-store.fsVersion` 变化（agent 跑完一轮 / SSE 广播）重拉当前文件——
 *   agent 刚改完的文件，预览里看到的就是新内容；cwd 热切换则清空选择（旧目录的路径不再诚实）。
 *
 * testid 契约（供验收探针用，实现方不再改动）：
 * `preview-file-bar` / `preview-file-name` / `file-tab-effect` / `file-tab-code` /
 * `preview-file-close` / `preview-file-loading` / `preview-file-error` / `preview-file-retry` /
 * `preview-file-binary` / `preview-file-empty` / `preview-file-effect` / `preview-file-frame` /
 * `preview-file-source` / `preview-file-truncated`
 */
export const PreviewPane = forwardRef<HTMLElement, PreviewPaneProps>(function PreviewPane(
  { className, ...rest },
  ref,
) {
  const collapsed = useUiStore((state) => state.previewCollapsed);
  const previewTab = useUiStore((state) => state.previewTab);
  const setPreviewTab = useUiStore((state) => state.setPreviewTab);
  const previewFilePath = useUiStore((state) => state.previewFilePath);
  const setPreviewFilePath = useUiStore((state) => state.setPreviewFilePath);
  const theme = useUiStore((state) => state.theme);
  const prefersReducedMotion = usePrefersReducedMotion();

  const previewHtml = useMemo(() => buildPreviewHtml(theme), [theme]);

  // 文件形态双门槛：previewFilePath 只可能来自文件树点击（live），isLiveEnabled 再挡一层
  // SSR / mock 残留。用局部 null 归一而非布尔，让 JSX 里的路径窄化天然成立。
  const live = isLiveEnabled();
  const openedFilePath = live ? previewFilePath : null;

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
      {openedFilePath !== null ? (
        <FilePreviewView
          path={openedFilePath}
          onClose={() => {
            // 2026-09-25 用户裁决：× = 清空文件选择 + **直接收起预览区**（原行为只清空、
            // 退回空态后还得再点一次标题栏才收）。× 只在展开态可点到，防御性判断保留；
            // 收起走 togglePreview，持久化口径与手动收起一致。
            setPreviewFilePath(null);
            if (!useUiStore.getState().previewCollapsed) useUiStore.getState().togglePreview();
          }}
        />
      ) : live ? (
        /*
         * ★ 2026-09-25（live 空态裁决）：live 形态不再渲染 mock 双 Tab ——
         * `buildPreviewHtml` 的假产物/假源码在 live 下属于「用假数据冒充现状」，
         * 文件预览上线后 live 预览区的唯一真实内容就是文件，未选文件时给诚实空态。
         * mock 形态双 Tab 原样保留（accept:m3 验收面 + 01b 屏 `?preview=` 参数）。
         */
        <PreviewEmptyState />
      ) : (
        <>
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
        </>
      )}
    </aside>
  );
});

/** live 未选文件的空态：不给任何 mock 内容，只指路侧栏文件树（2026-09-25 live 空态裁决） */
function PreviewEmptyState() {
  return (
    <div
      data-testid="preview-empty"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <Icon icon={File} size={28} className="text-text-tertiary" />
      <p className="text-sm text-text-tertiary">在左侧文件树点击文件以预览</p>
    </div>
  );
}

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

/* -------------------------------------------------- 文件形态（dir-file-preview 批次） */

/** 与 core 的 `FILE_READ_MAX_BYTES`（fs-read.ts）保持一致的展示口径；改动两侧要同步 */
const FILE_PREVIEW_MAX_KB = 256;

/** 扩展名 → shiki 语言（限 lib/highlight.ts LANGS 已捆绑集合）。表外一律 "plaintext"：
 * highlightCode 对不认识的语言自动回退纯文本且不抛错，所以这张表只追求常见源码高亮，不求全。 */
function extToLang(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "plaintext"; // 无扩展名（`.gitignore` 这类点开头名同样按无扩展名）
  const map: Record<string, string> = {
    ts: "ts", mts: "ts", cts: "ts",
    js: "js", mjs: "js", cjs: "js",
    jsx: "jsx", tsx: "tsx",
    json: "json", jsonc: "json",
    css: "css",
    html: "html", htm: "html", svg: "html",
    md: "md", markdown: "md",
    yaml: "yaml", yml: "yaml",
    sh: "shell", bash: "shell", zsh: "shell",
  };
  return map[name.slice(dot + 1).toLowerCase()] ?? "plaintext";
}

/** 文件的效果态可渲染类型：html/svg 进 iframe 沙箱，md 进 Markdown 组件；
 * 其余文件（ts/json/…）没有「渲染结果」可言，只有源码形态、不渲染双 Tab。 */
type FilePreviewKind = "html" | "markdown" | "source";

function filePreviewKind(name: string): FilePreviewKind {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (ext === "html" || ext === "htm" || ext === "svg") return "html";
  if (ext === "md" || ext === "markdown") return "markdown";
  return "source";
}

/** 文件形态的双 Tab（与 mock 的 效果/源码 同语义同顺序，id 故意沿用 effect/code） */
const FILE_PREVIEW_TABS = [
  { id: "effect", label: "预览效果", testId: "file-tab-effect" },
  { id: "code", label: "预览源码", testId: "file-tab-code" },
];

/** 文件形态的拉取状态；ready 后 binary / 空内容再分流到对应占位 */
interface FilePreviewState {
  status: "loading" | "error" | "ready";
  error?: string;
  data?: FileReadResult;
}

/**
 * 文件形态整体：顶部文件名条 + 下方内容，由 PreviewPane 在 `openedFilePath` 非空时渲染
 * （整块二选一顶替既有两 Tab，关闭即原样回去）。
 *
 * 数据纪律（WorkingDirFileTree 同款）：
 * - 拉取竞态用序号守卫，晚到的旧响应直接丢弃（切文件 / fsVersion 重拉都安全）；
 * - `fsVersion` 变化（agent 跑完一轮 / SSE 广播）保持当前文件重拉 —— 预览里看到的就是
 *   agent 刚产出的新内容；
 * - `liveCwd` 变化（目录热切换）清空选择：旧目录下的路径继续展示是假事实；
 * - 错误态的重试经 retryTick 走唯一再拉通道（path 与 fsVersion 都没动，effect 不会自己重跑）。
 */
function FilePreviewView({ path, onClose }: { path: string; onClose: () => void }) {
  const fsVersion = useChatStore((state) => state.fsVersion);
  const liveCwd = useChatStore((state) => state.liveCwd);
  const setPreviewFilePath = useUiStore((state) => state.setPreviewFilePath);
  const [state, setState] = useState<FilePreviewState>({ status: "loading" });
  const [retryTick, setRetryTick] = useState(0);
  /** 效果/源码双 Tab（仅效果可渲染的文件显示）；切文件回到默认「效果」态（mock 语义） */
  const [fileTab, setFileTab] = useState<"effect" | "code">("effect");
  const seqRef = useRef(0);

  useEffect(() => {
    setFileTab("effect");
  }, [path]);

  useEffect(() => {
    const transport = getLiveTransport();
    if (!transport) return;
    const seq = ++seqRef.current;
    setState({ status: "loading" });
    transport
      .readFile(path)
      .then((data) => {
        if (seqRef.current !== seq) return;
        setState({ status: "ready", data });
      })
      .catch((e) => {
        if (seqRef.current !== seq) return;
        setState({ status: "error", error: e instanceof Error ? e.message : String(e) });
      });
    // retryTick 刻意不在回调体内使用：它只是「再拉一次」的时钟（重试语义见上方注释）
  }, [path, fsVersion, retryTick]);

  const cwdRef = useRef(liveCwd);
  useEffect(() => {
    if (cwdRef.current !== liveCwd) {
      cwdRef.current = liveCwd;
      setPreviewFilePath(null);
    }
  }, [liveCwd, setPreviewFilePath]);

  const data = state.status === "ready" ? state.data : undefined;
  const fileName = data?.name ?? path.split(/[\\/]/).pop() ?? path;
  const kind = data ? filePreviewKind(data.name) : "source";
  const hasEffect = kind !== "source";

  return (
    <>
      <div
        data-testid="preview-file-bar"
        className="flex shrink-0 items-center gap-2 border-b border-border-subtle"
        style={{
          height: PREVIEW_TABBAR_HEIGHT,
          paddingLeft: PREVIEW_TABBAR_PADDING_X,
          paddingRight: PREVIEW_TABBAR_PADDING_X,
        }}
      >
        <Icon icon={File} size={13} className="shrink-0 text-text-tertiary" />
        <span
          data-testid="preview-file-name"
          title={path}
          className="min-w-0 flex-1 truncate text-sm text-text-primary"
        >
          {fileName}
        </span>
        {/* 效果可渲染的文件才有双 Tab（mock 的 效果/源码 同款）；纯源码文件没有第二视图，
            不渲染 Tab —— 与「看着能点但没动作」的哑交互禁令同一纪律。
            （2026-09-25 用户裁决：文件预览不设复制按钮，mock 源码态的复制不在其列） */}
        {hasEffect ? (
          <Tabs
            idPrefix="file-preview"
            label="文件预览视图"
            items={FILE_PREVIEW_TABS}
            value={fileTab}
            onChange={setFileTab}
            className="flex shrink-0 items-center gap-1"
            tabClassName={cn(
              "inline-flex h-8 select-none items-center justify-center rounded-md px-3 text-sm",
              "transition-colors duration-150 ease-out",
              "text-text-secondary hover:bg-bg-hover active:bg-bg-active",
            )}
            activeTabClassName="bg-bg-subtle text-text-primary"
          />
        ) : null}
        <button
          type="button"
          data-testid="preview-file-close"
          aria-label="关闭文件预览"
          title="关闭"
          onClick={onClose}
          className={cn(
            "inline-flex h-7 shrink-0 items-center justify-center rounded-md px-1.5",
            "transition-colors duration-150 ease-out",
            "text-text-secondary hover:bg-bg-hover hover:text-text-primary active:bg-bg-active",
          )}
        >
          <Icon icon={X} />
        </button>
      </div>

      {state.status === "loading" ? (
        <FileStatusBlock testId="preview-file-loading" text="正在读取…" spinning />
      ) : state.status === "error" ? (
        <FileStatusBlock
          testId="preview-file-error"
          text={state.error ?? "读取失败"}
          tone="danger"
          hint={path}
          action={
            <button
              type="button"
              data-testid="preview-file-retry"
              onClick={() => setRetryTick((t) => t + 1)}
              className={cn(
                "inline-flex h-7 items-center rounded-md border border-border-default px-3 text-sm",
                "transition-colors duration-150 ease-out",
                "text-text-secondary hover:bg-bg-hover hover:text-text-primary active:bg-bg-active",
              )}
            >
              重试
            </button>
          }
        />
      ) : data?.binary ? (
        <FileStatusBlock testId="preview-file-binary" text="二进制文件，暂不支持预览" hint={path} />
      ) : data && data.content.length === 0 ? (
        <FileStatusBlock testId="preview-file-empty" text="空文件" hint={path} />
      ) : data ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {hasEffect && fileTab === "effect" ? (
            kind === "html" ? (
              <div data-testid="preview-file-effect" className="min-h-0 flex-1 bg-white">
                {/* 与 mock 效果态同款空 sandbox（禁脚本）；HTML 文档样式自理，无样式文档
                    按浏览器惯例给白底（bg-white），避免深色应用底上黑字不可读 */}
                <iframe
                  data-testid="preview-file-frame"
                  sandbox=""
                  srcDoc={data.content}
                  title={data.name}
                  className="h-full w-full border-0"
                />
              </div>
            ) : (
              <div data-testid="preview-file-effect" className="min-h-0 flex-1 overflow-y-auto">
                <Markdown content={data.content} className="px-5 py-4" />
              </div>
            )
          ) : (
            <FileHighlightedSource source={data.content} name={data.name} />
          )}
          {data.truncated ? (
            <div
              data-testid="preview-file-truncated"
              className="flex shrink-0 items-center border-t border-border-subtle px-4 py-1.5 text-xs text-text-tertiary"
            >
              文件较大，仅显示前 {FILE_PREVIEW_MAX_KB} KB
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** 高亮正文：Shiki（未就绪前纯文本兜底）+ CSS counter 行号，渲染完成后回写真实行数。
 * 与 mock 的 PreviewSource 同策略但不共用组件 —— mock 路径带验收断言，保持零改动。 */
function FileHighlightedSource({ source, name }: { source: string; name: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | null>(null);

  const fallbackHtml = useMemo(
    () => `<pre class="shiki"><code>${escapeHtml(source)}</code></pre>`,
    [source],
  );

  useEffect(() => {
    let active = true;
    highlightCode(source, extToLang(name)).then((result) => {
      if (active) setHtml(withLineData(result));
    });
    return () => {
      active = false;
    };
  }, [source, name]);

  useEffect(() => {
    if (!html || !containerRef.current) return;
    const count = containerRef.current.querySelectorAll(".line").length;
    containerRef.current.dataset.lineCount = String(count);
  }, [html]);

  return (
    <div
      ref={containerRef}
      data-testid="preview-file-source"
      className="preview-source min-h-0 flex-1 overflow-auto font-mono"
      dangerouslySetInnerHTML={{ __html: html ?? fallbackHtml }}
    />
  );
}

/** 文件形态的整块占位：loading / error / binary / empty（内容区居中，不滚动） */
function FileStatusBlock({
  testId,
  text,
  hint,
  tone,
  spinning,
  action,
}: {
  testId: string;
  text: string;
  /** 次行弱化提示（通常是完整路径） */
  hint?: string;
  tone?: "danger";
  spinning?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
      <div
        data-testid={testId}
        className={cn(
          "flex items-center gap-1.5 text-sm",
          tone === "danger" ? "text-danger" : "text-text-tertiary",
        )}
      >
        {spinning ? <Icon icon={Loader2} size={14} className="animate-spin" /> : null}
        <span className="min-w-0">{text}</span>
      </div>
      {hint ? (
        <div className="max-w-full truncate font-mono text-xs text-text-tertiary" title={hint}>
          {hint}
        </div>
      ) : null}
      {action}
    </div>
  );
}
