import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronUp } from "lucide-react";
import { cn } from "@/lib/cn";
import { Chip } from "@/components/primitives/Chip";
import { Icon, type LucideIcon } from "@/components/common/icons";

/**
 * 芯片 + 上拉选项菜单（2026-09-22 用户需求：模型 / 思考强度改为「点开选」而非循环切换）。
 *
 * 结构与 testid 契约（与 M2 验收 2-11 / 2-12 兼容，**勿改**）：
 * - 外层定位 wrapper（`relative inline-flex`）**持有原 chip 的 testid** ——
 *   m2-acceptance 2-11 枚举 `composer-toolbar` 直接子节点的 testid 序列，
 *   2-12 量该 testid 节点的高（必须 32，wrapper 不含 absolute 面板，高恰为芯片高）；
 * - 触发按钮 testid 为 `${testId}-trigger`（新命名空间，无既有脚本引用）；
 * - 面板 testid 为 `${menuTestId}`，`role="listbox"`，仅展开时渲染
 *   （互斥渲染 → 芯片的 `aria-controls` 仅展开时持有，遵循 M5 的 aria 裁决）。
 *
 * 面板支持**分组**（同日用户反馈，对齐参考稿）：组标题全大写灰字，组间细分隔线；
 * 无分组传单组不带 label 即可。分组在 APG listbox 里的正确形态是
 * `listbox > group[aria-labelledby] > option`，焦点漫游跨组连续（Map 插入序）。
 *
 * 交互（G7）：
 * - 点击芯片开/关；`ArrowUp/ArrowDown` 也能打开（菜单在上方，方向键语义一致）；
 * - 展开时焦点自动落到选中项；`ArrowUp/ArrowDown` 在选项间移动，`Home/End` 跳两端；
 * - `Escape` 关闭并把焦点还给芯片；`Tab` 关闭后自然离开；
 * - 点外部（`pointerdown` 不在 wrapper 内）关闭。
 *
 * 为什么面板不用 fixed 定位：Composer 固定在内容区底部，向上弹（`bottom-full`）
 * 永远落在消息流区域内、WorkspaceArea 根节点 `overflow-hidden` 之内，
 * 不会产生横向滚动（G6），也无需测量视口翻转。
 */
export interface ChipMenuOption<T extends string> {
  value: T;
  label: string;
  /** 选项说明副行（如思考档位的适用场景），弱化展示 */
  hint?: string;
}

export interface ChipMenuGroup<T extends string> {
  /** 组标题（面板内全大写展示）；不传 = 该组无标题（如思考档位） */
  label?: string;
  options: ReadonlyArray<ChipMenuOption<T>>;
}

export interface ChipMenuProps<T extends string> {
  /** 定位 wrapper 的 testid（= 原芯片 testid，兼容 M2 2-11/2-12 枚举） */
  testId: string;
  /** 面板 testid */
  menuTestId: string;
  icon: LucideIcon;
  /** 芯片展示文案（即当前选中项标签） */
  label: string;
  /** 芯片的可访问名称（G7：名称说「是什么」） */
  ariaLabel: string;
  /** 面板的可访问名称 */
  menuLabel: string;
  groups: ReadonlyArray<ChipMenuGroup<T>>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

export function ChipMenu<T extends string>({
  testId,
  menuTestId,
  icon,
  label,
  ariaLabel,
  menuLabel,
  groups,
  value,
  onChange,
  className,
}: ChipMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef(new Map<T, HTMLButtonElement>());

  useEffect(() => {
    if (!open) return;
    // 展开后焦点落到选中项（APG listbox 模式：选项不在 Tab 序里，方向键漫游）
    const raf = requestAnimationFrame(() => {
      optionRefs.current.get(value)?.focus();
    });
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && e.target instanceof Node && wrapRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, value]);

  function select(next: T) {
    onChange(next);
    setOpen(false);
    // 焦点回到芯片：键盘用户选完能继续 Tab 走，不落到 body（G7）
    chipRef.current?.focus();
  }

  function onChipKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (open) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
      return;
    }
    // 菜单在上方，方向键「向上/向下打开」都说得通；Enter/Space 走按钮原生 click
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const items = [...optionRefs.current.values()];
    const idx = items.findIndex((el) => el === document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(idx + 1 + items.length) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      chipRef.current?.focus();
    } else if (e.key === "Tab") {
      // 让 Tab 自然走，但菜单收起（焦点离开即关闭的键盘等价物）
      setOpen(false);
    }
  }

  return (
    <div ref={wrapRef} data-testid={testId} className={cn("relative inline-flex min-w-0", className)}>
      <Chip
        ref={chipRef}
        data-testid={`${testId}-trigger`}
        icon={icon}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuTestId : undefined}
        title={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onChipKeyDown}
        trailing={
          <Icon
            icon={ChevronUp}
            size={12}
            className={cn(
              "-ml-0.5 text-text-tertiary transition-transform duration-150",
              open && "rotate-180",
            )}
          />
        }
      >
        {label}
      </Chip>

      {open ? (
        <div
          data-testid={menuTestId}
          role="listbox"
          aria-label={menuLabel}
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
          className={cn(
            "absolute bottom-full left-0 z-20 mb-2 flex flex-col p-1",
            "min-w-44 rounded-lg border border-border-default bg-bg-elevated shadow-lg",
          )}
        >
          {groups.map((group, gi) => (
            <div
              key={group.label ?? gi}
              role={group.label ? "group" : undefined}
              aria-labelledby={group.label ? `${menuTestId}-group-${gi}` : undefined}
              className={cn(gi > 0 && "mt-1 border-t border-border-subtle pt-1")}
            >
              {group.label ? (
                <div
                  id={`${menuTestId}-group-${gi}`}
                  /* pl-8 = px-2.5(10) + 勾占位(14) + gap(8)：与选项文字左缘对齐 */
                  className="pl-8 pr-2.5 pb-1 pt-1.5 text-xs font-medium uppercase tracking-wide text-text-tertiary"
                >
                  {group.label}
                </div>
              ) : null}
              {group.options.map((opt) => {
                const selected = opt.value === value;
                return (
                  <button
                    key={opt.value}
                    ref={(el) => {
                      if (el) optionRefs.current.set(opt.value, el);
                      else optionRefs.current.delete(opt.value);
                    }}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    onClick={() => select(opt.value)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm",
                      "transition-colors duration-150 hover:bg-bg-hover focus:bg-bg-hover",
                      selected ? "bg-bg-hover text-text-primary" : "text-text-secondary",
                    )}
                  >
                    {/* 选中标记在左（2026-09-22 用户裁决：勾在左侧、说明右对齐）；
                        未选中 invisible 占位，各行文字左缘对齐不跳动 */}
                    <Icon
                      icon={Check}
                      size={14}
                      className={cn("shrink-0 text-accent", !selected && "invisible")}
                    />
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                      <span className="truncate">{opt.label}</span>
                      {/* 说明推到行右（ml-auto），超长与主文案一起截断 */}
                      {opt.hint ? (
                        <span className="ml-auto truncate pl-2 text-xs text-text-tertiary">{opt.hint}</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
