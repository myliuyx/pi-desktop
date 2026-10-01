import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, SearchX } from "lucide-react";
import { cn } from "@/lib/cn";
import { POPOVER_Z } from "@/lib/layout";
import { Icon } from "@/components/common/icons";
import { isLiveEnabled } from "@/lib/feature-flags";
import { getLiveTransport } from "@/services/live-transport";
import type { SlashCommandItem, SlashCommandSource } from "@/mock/types";

/**
 * Composer 的「/」斜杠命令弹层（斜杠命令批次）。
 * 纯受控展示 + 数据加载：触发区间检测 / 键盘路由 / 文本替换都在 Composer，
 * 弹层只按 query 过滤、按 source 分组渲染，并经 handle 向 Composer 暴露按键消费。
 *
 * 渲染门槛：live 形态才渲染（mock 无 core，诚实于形态）。
 */

const GROUP_LABEL: Record<SlashCommandSource, string> = {
  builtin: "内置",
  extension: "扩展",
  skill: "技能",
};
const GROUP_ORDER: SlashCommandSource[] = ["builtin", "extension", "skill"];

interface LoadState {
  status: "loading" | "ready" | "error";
  error?: string;
  commands: SlashCommandItem[];
}

export interface ComposerSlashMenuHandle {
  isOpen: () => boolean;
  handleKey: (e: KeyboardEvent) => boolean;
}

export interface ComposerSlashMenuProps {
  query: string;
  anchorEl: HTMLElement | null;
  onPick: (item: SlashCommandItem) => void;
  onClose: () => void;
}

export const ComposerSlashMenu = forwardRef<ComposerSlashMenuHandle, ComposerSlashMenuProps>(
  function ComposerSlashMenu({ query, anchorEl, onPick, onClose }, ref) {
    const [state, setState] = useState<LoadState>({ status: "loading", commands: [] });
    const [activeIndex, setActiveIndex] = useState(0);
    const activeIndexRef = useRef(0);
    const listRef = useRef<HTMLDivElement>(null);
    const flatRef = useRef<SlashCommandItem[]>([]);

    /* 打开时拉一次清单（本地调用，不防抖；不用 liveCwd 作门，命令清单与 cwd 无关） */
    useEffect(() => {
      const transport = getLiveTransport();
      if (!isLiveEnabled() || !transport) return;
      let cancelled = false;
      setState({ status: "loading", commands: [] });
      transport
        .getSlashCommands()
        .then((p) => {
          if (!cancelled) setState({ status: "ready", commands: p.commands });
        })
        .catch((e) => {
          if (!cancelled)
            setState({ status: "error", error: e instanceof Error ? e.message : String(e), commands: [] });
        });
      return () => {
        cancelled = true;
      };
    }, []);

    const groups = useMemo(() => {
      const q = query.toLowerCase();
      const visible = state.commands.filter((c) => (q ? c.name.toLowerCase().includes(q) : true));
      return GROUP_ORDER.map((source) => ({ source, items: visible.filter((c) => c.source === source) })).filter(
        (g) => g.items.length > 0,
      );
    }, [state.commands, query]);

    const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
    flatRef.current = flat;
    activeIndexRef.current = activeIndex;

    useEffect(() => {
      setActiveIndex(0);
    }, [query, state.commands]);

    useEffect(() => {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }, [activeIndex, flat.length]);

    const confirmActive = () => {
      const item = flatRef.current[activeIndexRef.current];
      if (item && item.available) onPick(item);
      else onClose();
    };

    useImperativeHandle(
      ref,
      () => ({
        isOpen: () => true,
        handleKey: (e) => {
          const count = flatRef.current.length;
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
      [flat, activeIndex, onPick, onClose],
    );

    if (typeof document === "undefined" || !isLiveEnabled()) return null;

    const rect = anchorEl?.getBoundingClientRect();
    const width = rect ? Math.min(720, rect.width - 24) : 680;

    return createPortal(
      <div
        data-testid="composer-slash-menu"
        role="listbox"
        aria-label="斜杠命令"
        className={cn(
          "fixed flex flex-col overflow-hidden rounded-lg border border-border-default bg-bg-elevated shadow-lg",
        )}
        style={{
          left: rect ? rect.left + 12 : 0,
          bottom: rect ? window.innerHeight - rect.top + 8 : 8,
          width,
          zIndex: POPOVER_Z,
        }}
      >
        <div className="flex items-center justify-between px-2 py-1 text-xs text-text-tertiary">
          <span>斜杠命令 · {state.commands.length} 个命令</span>
          <span>Tab / Enter</span>
        </div>
        <div ref={listRef} className="max-h-80 min-w-0 overflow-y-auto p-1">
          {state.status === "loading" ? (
            <div data-testid="composer-slash-loading" className="flex h-8 items-center gap-2 px-2 text-xs text-text-tertiary">
              <Icon icon={Loader2} size={12} className="shrink-0 animate-spin" />
              <span>正在读取命令…</span>
            </div>
          ) : state.status === "error" ? (
            <div data-testid="composer-slash-error" className="flex h-8 items-center px-2 text-xs text-danger" title={state.error}>
              <span className="min-w-0 flex-1 truncate">读取命令失败：{state.error}</span>
            </div>
          ) : flat.length === 0 ? (
            <div data-testid="composer-slash-empty" className="flex h-8 items-center gap-2 px-2 text-xs text-text-tertiary">
              <Icon icon={SearchX} size={12} className="shrink-0" />
              <span>没有匹配的命令</span>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.source}>
                <div className="flex items-center justify-between px-2 py-1 text-xs text-text-tertiary">
                  <span>{GROUP_LABEL[g.source]}</span>
                  <span>{g.items.length}</span>
                </div>
                <div className={g.source === "extension" ? "flex flex-col gap-1" : "grid grid-cols-3 gap-1"}>
                  {g.items.map((item) => {
                    const index = flat.indexOf(item);
                    return (
                      <button
                        key={item.name}
                        type="button"
                        role="option"
                        aria-selected={index === activeIndex}
                        disabled={!item.available}
                        data-testid={`composer-slash-option-${index}`}
                        data-name={item.name}
                        data-source={item.source}
                        data-index={index}
                        title={item.available ? undefined : "当前不可执行"}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => onPick(item)}
                        onMouseMove={() => setActiveIndex(index)}
                        className={cn(
                          "flex min-w-0 flex-col items-start rounded-md border px-2 py-1.5 text-left",
                          "transition-colors duration-150 ease-out",
                          index === activeIndex
                            ? "border-accent bg-bg-active"
                            : "border-transparent hover:bg-bg-hover",
                          !item.available && "cursor-not-allowed opacity-50",
                        )}
                      >
                        <span className="w-full truncate font-mono text-xs text-text-primary">/{item.name}</span>
                        {item.description ? (
                          <span className="w-full truncate text-xs text-text-tertiary">{item.description}</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </div>
      </div>,
      document.body,
    );
  },
);