import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { File, Folder, Loader2, SearchX } from "lucide-react";
import { cn } from "@/lib/cn";
import { POPOVER_Z } from "@/lib/layout";
import { Icon } from "@/components/common/icons";
import { isLiveEnabled } from "@/lib/feature-flags";
import { getLiveTransport } from "@/services/live-transport";
import type { FsSearchEntryResult } from "@/services/agent-transport";
import { useChatStore } from "@/store/chat-store";

/**
 * Composer 的 @ 文件搜索弹层（at-file 批次，task-composer-at-file.md §4.3）。
 *
 * **纯受控展示 + 数据加载**：触发区间检测 / 键盘路由 / 文本替换都在 Composer——
 * 弹层只按 `query` 拉数据、渲染候选，并经 handle 向 Composer 暴露按键消费
 * （↑↓ 移动高亮、Enter/Tab 确认、Esc 关闭；Enter 必须在弹层内被消费，
 * 否则会漏到 Composer 的「Enter 发送」）。
 *
 * ## 渲染门槛
 * live 形态且 `liveCwd` 已拿到才渲染（mock / SSR / cwd 未拿到一律 null）——
 * mock 没有 core 没有 fs 数据源，诚实于形态（WorkingDirFileTree 同款门槛）。
 *
 * ## 数据
 * - 每次查询现拉不缓存；防抖 150ms + per-query 序号守卫（picker / 文件树同款，
 *   只认最后一次，慢响应丢弃）；
 * - 搜索根恒传 `liveCwd`（根与「core 当前 cwd」是两个概念，同文件树口径）；
 * - 旧 core 无此路由：HTTP 200 HTML ⇒ assertJson 报「响应非 JSON」→ error 态展示。
 *
 * ## 定位
 * portal 到 body + fixed，锚定 composer 根盒**向上弹**（输入区贴窗口底部，
 * 下弹会出视口）；渲染时读 `getBoundingClientRect`（Composer 高度随输入变化，
 * 每次渲染刷新一次即可——query 变必然触发渲染）。
 */

/** 请求防抖（ms）：@ 后连续打字不逐键发请求 */
const DEBOUNCE_MS = 150;

interface SearchState {
  status: "loading" | "ready" | "error";
  error?: string;
  entries: FsSearchEntryResult[];
  truncated: boolean;
}

export interface ComposerAtMenuHandle {
  /** 弹层是否开着（条件渲染 ⇒ mounted 即开；Composer 据此决定是否拦截按键） */
  isOpen: () => boolean;
  /** 处理一个按键；返回 true 表示已被弹层消费（Composer 不再做发送等处理） */
  handleKey: (e: KeyboardEvent) => boolean;
}

export interface ComposerAtMenuProps {
  query: string;
  /** 定位锚：composer 根盒（弹层在它上方居中弹出） */
  anchorEl: HTMLElement | null;
  onPick: (entry: FsSearchEntryResult) => void;
  onClose: () => void;
}

export const ComposerAtMenu = forwardRef<ComposerAtMenuHandle, ComposerAtMenuProps>(
  function ComposerAtMenu({ query, anchorEl, onPick, onClose }, ref) {
    const liveCwd = useChatStore((state) => state.liveCwd);

    const [search, setSearch] = useState<SearchState>({ status: "loading", entries: [], truncated: false });
    const [activeIndex, setActiveIndex] = useState(0);
    /** activeIndex 的镜像：handleKey 里要读"当前高亮"而不把它列进 handle 重建依赖 */
    const activeIndexRef = useRef(0);
    const listRef = useRef<HTMLDivElement>(null);

    const entriesRef = useRef<FsSearchEntryResult[]>([]);

    activeIndexRef.current = activeIndex;
    entriesRef.current = search.entries;

    /* 数据加载：query / liveCwd 变化 → 防抖后现拉（组件级序号守卫丢晚到响应；
       防抖窗口内 query 再变 ⇒ 旧 effect 清理掉定时器，请求根本不会发出） */
    const seqRef = useRef(0);
    useEffect(() => {
      const transport = getLiveTransport();
      if (!isLiveEnabled() || !liveCwd || !transport) return;
      const my = ++seqRef.current;
      setActiveIndex(0);
      setSearch({ status: "loading", entries: [], truncated: false });
      const timer = setTimeout(() => {
        if (seqRef.current !== my) return;
        transport
          .searchFiles(liveCwd, query)
          .then((r) => {
            if (seqRef.current !== my) return;
            setSearch({ status: "ready", entries: r.entries, truncated: r.truncated });
          })
          .catch((e) => {
            if (seqRef.current !== my) return;
            setSearch({
              status: "error",
              error: e instanceof Error ? e.message : String(e),
              entries: [],
              truncated: false,
            });
          });
      }, DEBOUNCE_MS);
      return () => clearTimeout(timer);
    }, [query, liveCwd]);

    /* 高亮项滚动进可视区（键盘导航时跟随） */
    useEffect(() => {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }, [activeIndex, search.entries.length]);

    const confirmActive = () => {
      const entry = entriesRef.current[activeIndexRef.current];
      if (entry) onPick(entry);
      else onClose();
    };

    useImperativeHandle(
      ref,
      () => ({
        isOpen: () => true,
        handleKey: (e) => {
          const count = entriesRef.current.length;
          if (e.key === "ArrowDown" && count > 0) {
            e.preventDefault();
            setActiveIndex((i) => (i + 1) % count);
            return true;
          }
          if (e.key === "ArrowUp" && count > 0) {
            e.preventDefault();
            setActiveIndex((i) => (i - 1 + count) % count);
            return true;
          }
          if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            confirmActive();
            return true;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
            return true;
          }
          return false;
        },
      }),
      // confirmActive 闭包随 entries/activeIndex/onPick/onClose 刷新；activeIndexRef/entriesRef 保证即时性
      [search.entries, activeIndex, onPick, onClose],
    );

    /* 渲染门槛（hooks 之后返回 null —— of hooks）：mock / SSR / cwd 未拿到 */
    if (typeof document === "undefined" || !isLiveEnabled() || !liveCwd) return null;

    const rect = anchorEl?.getBoundingClientRect();
    const width = rect ? Math.min(460, rect.width - 24) : 440;

    return createPortal(
      <div
        data-testid="composer-at-menu"
        role="listbox"
        aria-label="@ 引用文件"
        className={cn(
          "fixed flex flex-col overflow-hidden p-1",
          "rounded-lg border border-border-default bg-bg-elevated shadow-lg",
        )}
        style={{
          left: rect ? rect.left + 12 : 0,
          bottom: rect ? window.innerHeight - rect.top + 8 : 8,
          width,
          zIndex: POPOVER_Z,
        }}
      >
        <div ref={listRef} className="max-h-64 min-w-0 overflow-y-auto">
          {search.status === "loading" ? (
            <div
              data-testid="composer-at-loading"
              className="flex h-8 items-center gap-2 px-2 text-xs text-text-tertiary"
            >
              <Icon icon={Loader2} size={12} className="shrink-0 animate-spin" />
              <span>正在搜索文件…</span>
            </div>
          ) : search.status === "error" ? (
            <div
              data-testid="composer-at-error"
              className="flex h-8 items-center px-2 text-xs text-danger"
              title={search.error}
            >
              <span className="min-w-0 flex-1 truncate">搜索失败：{search.error}</span>
            </div>
          ) : search.entries.length === 0 ? (
            <div
              data-testid="composer-at-empty"
              className="flex h-8 items-center gap-2 px-2 text-xs text-text-tertiary"
            >
              <Icon icon={SearchX} size={12} className="shrink-0" />
              <span>没有匹配的文件</span>
            </div>
          ) : (
            search.entries.map((entry, index) => (
              <button
                key={entry.relPath}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                data-testid={`composer-at-option-${index}`}
                data-index={index}
                data-path={entry.relPath}
                data-kind={entry.kind}
                title={entry.absPath}
                /* mousedown preventDefault：抢选不夺焦点——textarea 保持聚焦，光标不丢 */
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(entry)}
                onMouseMove={() => setActiveIndex(index)}
                className={cn(
                  "flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left font-mono text-xs",
                  "transition-colors duration-150 ease-out",
                  index === activeIndex
                    ? "bg-bg-active text-text-primary"
                    : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
                )}
              >
                {/* 目录引用与文件引用同榜（D6）：图标区分 kind，路径尾部 / 由 core 语义消化 */}
                <Icon
                  icon={entry.kind === "dir" ? Folder : File}
                  size={13}
                  className="shrink-0 text-text-tertiary"
                />
                <span className="min-w-0 flex-1 truncate">{entry.relPath}</span>
                {entry.kind === "dir" ? (
                  <span className="shrink-0 text-text-tertiary">目录</span>
                ) : null}
              </button>
            ))
          )}
        </div>
        {search.status === "ready" && search.truncated ? (
          <div className="shrink-0 px-2 pb-0.5 pt-1 text-xs text-text-tertiary">仅显示前 {search.entries.length} 个匹配</div>
        ) : null}
      </div>,
      document.body,
    );
  },
);
