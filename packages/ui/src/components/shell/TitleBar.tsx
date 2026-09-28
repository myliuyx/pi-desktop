import { forwardRef, useEffect, useState, type HTMLAttributes } from "react";
import { Moon, PanelLeftClose, PanelRightClose, Settings, Sun } from "lucide-react";
import { cn } from "@/lib/cn";
import { TITLE_BAR_BUTTON_SIZE, TITLE_BAR_HEIGHT } from "@/lib/layout";
import { IconButton } from "@/components/primitives";
import { useUiStore } from "@/store/ui-store";

export type OsName = "mac" | "win" | "linux";

/** mac 交通灯直径 10 */
const MAC_DOT_SIZE = 10;

/**
 * 三端壳的标志色。品牌色不随主题派生，因此不进 tokens.css，
 * 而是注册在 Tailwind 主题里（见 styles/globals.css），组件侧不出现色值字面量。
 */
const MAC_DOT_CLASS = ["bg-window-close", "bg-window-minimize", "bg-window-maximize"] as const;

/** 与 MAC_DOT_CLASS 一一对应：hover 浮出的功能符号 + 无障碍标签 + 动作（原生红绿灯行为） */
const MAC_DOT_META = [
  { glyph: "✕", label: "关闭", action: "close" },
  { glyph: "−", label: "最小化", action: "minimize" },
  { glyph: "+", label: "最大化", action: "maximize" },
] as const;

/**
 * 窗口控制动作 —— 无边框桌面壳（frame:false）的最小化/最大化/关闭唯一出入口。
 *
 * 经 desktop preload 暴露的 `window.piDesktop` 走 IPC 到 BrowserWindow；
 * web / mock 形态没有这个对象，控件退化为装饰件（点击无操作），
 * DOM 几何与改造前完全一致（10px 圆点 / 28px 按键、圆角与 hover 风格不变）。
 * `maximized` 供最大化控件在「最大化 / 还原」间切换图标与标签。
 */
interface WindowActions {
  maximized: boolean;
  /** 桌面 live = `window.piDesktop` 存在；web/mock 为 false，此时控件为惰性装饰件（不可聚焦、不进无障碍树） */
  available: boolean;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
}

function useWindowActions(): WindowActions {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const api = window.piDesktop;
    if (!api) return;
    let unsubscribe: (() => void) | undefined;
    api.isMaximized().then(setMaximized).catch(() => {});
    unsubscribe = api.onMaximizeChange(setMaximized);
    return () => unsubscribe?.();
  }, []);
  return {
    maximized,
    // 与 effect 的守卫同源：window.piDesktop 存在即为桌面 live，否则 web/mock 退化为惰性装饰件
    available: Boolean(window.piDesktop),
    minimize: () => window.piDesktop?.minimize(),
    toggleMaximize: () => window.piDesktop?.toggleMaximize(),
    close: () => window.piDesktop?.close(),
  };
}

function MacTrafficLights({ actions }: { actions: WindowActions }) {
  return (
    <div className="flex shrink-0 items-center gap-2" aria-hidden={actions.available ? undefined : true}>
      {MAC_DOT_CLASS.map((dotClass, i) => {
        const meta = MAC_DOT_META[i];
        const label = meta.action === "maximize" && actions.maximized ? "还原" : meta.label;
        return (
          <button
            key={dotClass}
            type="button"
            aria-label={label}
            title={label}
            data-testid={`titlebar-mac-${meta.action}`}
            tabIndex={actions.available ? undefined : -1}
            onClick={
              meta.action === "close"
                ? actions.close
                : meta.action === "minimize"
                  ? actions.minimize
                  : actions.toggleMaximize
            }
            className="app-region-no-drag group relative block rounded-full"
            style={{ width: MAC_DOT_SIZE, height: MAC_DOT_SIZE }}
          >
            <span className={cn("block h-full w-full rounded-full", dotClass)} />
            {/* hover 浮出功能符号（原生红绿灯行为）；符号色为固定深色，走 window-glyph 令牌 */}
            <span
              aria-hidden="true"
              className="absolute inset-0 flex items-center justify-center text-[7px] font-bold leading-none text-window-glyph opacity-0 transition-opacity group-hover:opacity-100"
            >
              {meta.glyph}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** win / linux 的窗口控件用内联 SVG 表达，避免为一个形状引入图标并保持 28×28 一致 */
function WindowControlGlyph({
  shape,
  maximized,
}: {
  shape: "minimize" | "maximize" | "close";
  maximized: boolean;
}) {
  return (
    <svg width={MAC_DOT_SIZE} height={MAC_DOT_SIZE} viewBox="0 0 10 10" aria-hidden="true">
      {shape === "minimize" ? <rect x="0" y="4.5" width="10" height="1" className="fill-current" /> : null}
      {shape === "maximize" ? (
        maximized ? (
          // 还原态：错位双矩形（Win 原生语义）
          <g fill="none" strokeWidth={1} className="stroke-current">
            <rect x="2.5" y="0.5" width="7" height="7" />
            <rect x="0.5" y="2.5" width="7" height="7" />
          </g>
        ) : (
          <rect x="0.5" y="0.5" width="9" height="9" fill="none" strokeWidth={1} className="stroke-current" />
        )
      ) : null}
      {shape === "close" ? (
        <path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" strokeWidth={1} className="stroke-current" />
      ) : null}
    </svg>
  );
}

const WIN_CONTROLS: Array<{ shape: "minimize" | "maximize" | "close"; label: string; testId: string }> = [
  { shape: "minimize", label: "最小化", testId: "titlebar-win-minimize" },
  { shape: "maximize", label: "最大化", testId: "titlebar-win-maximize" },
  { shape: "close", label: "关闭", testId: "titlebar-win-close" },
];

function WindowControls({ os, actions }: { os: OsName; actions: WindowActions }) {
  if (os === "mac") return <MacTrafficLights actions={actions} />;

  return (
    <div className="flex shrink-0 items-center" aria-hidden={actions.available ? undefined : true}>
      {WIN_CONTROLS.map(({ shape, label, testId }) => {
        const text = shape === "maximize" && actions.maximized ? "还原" : label;
        return (
          <button
            key={shape}
            type="button"
            aria-label={text}
            title={text}
            data-testid={testId}
            tabIndex={actions.available ? undefined : -1}
            onClick={
              shape === "minimize"
                ? actions.minimize
                : shape === "maximize"
                  ? actions.toggleMaximize
                  : actions.close
            }
            className={cn(
              "app-region-no-drag flex items-center justify-center rounded-md text-text-secondary",
              "transition-colors duration-150 ease-out hover:bg-bg-hover active:bg-bg-active",
              // win 把关闭键染成危险色；linux 三个键一视同仁，风格更朴素
              os === "win" && shape === "close" && "text-danger",
            )}
            style={{ width: TITLE_BAR_BUTTON_SIZE, height: TITLE_BAR_BUTTON_SIZE }}
          >
            <WindowControlGlyph shape={shape} maximized={actions.maximized} />
          </button>
        );
      })}
    </div>
  );
}

export interface TitleBarProps extends HTMLAttributes<HTMLDivElement> {
  /** 当前窗口壳类型 */
  os?: OsName;
  /** 标题（如 03/04 屏的屏幕名）；**缺省 = 中间留白**（2026-09-26 用户裁决：工作台不显示任何标题文案）。超长截断 */
  title?: string;
  onOpenSettings?: () => void;
}

/**
 * 标题栏：左（窗口控件 → 收起左侧）· 中（会话标题，弹性截断）· 右（主题 → 设置 → 收起右侧）
 *
 * 「收起左侧」必须插在窗口控件之后、「收起右侧」必须在最末 —— 两处均为设计稿定稿位置，
 * 改动会破坏 06 屏三端壳的对照关系。
 *
 * 右端按钮语义为「只收右侧预览区」（2026-09-22 用户裁决：设计稿本意即收起右侧，
 * 此前实现成「收起两侧」属于跑偏）——收左侧有左端按钮，职责不重叠。
 *
 * 无边框桌面壳（2026-09-28）：根节点 `app-region-drag` 使整条可拖窗口；内部可交互
 * 元素一律 `app-region-no-drag`（否则点击被拖拽语义吞掉）；双击标题栏空白处 =
 * 最大化/还原（原生标题栏行为，落在按钮上的双击不触发）。
 */
export const TitleBar = forwardRef<HTMLDivElement, TitleBarProps>(function TitleBar(
  { os = "mac", title, onOpenSettings, className, ...rest },
  ref,
) {
  const theme = useUiStore((state) => state.theme);
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const previewCollapsed = useUiStore((state) => state.previewCollapsed);
  const toggleTheme = useUiStore((state) => state.toggleTheme);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const togglePreview = useUiStore((state) => state.togglePreview);
  const actions = useWindowActions();

  const dark = theme === "dark";

  return (
    <div
      ref={ref}
      className={cn(
        "app-region-drag flex shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-surface px-2",
        className,
      )}
      style={{ height: TITLE_BAR_HEIGHT }}
      {...rest}
      onDoubleClick={(event) => {
        // 双击标题栏空白处 = 最大化/还原；落在按钮上的双击不触发
        if ((event.target as HTMLElement).closest("button")) return;
        actions.toggleMaximize();
      }}
    >
      <WindowControls os={os} actions={actions} />

      <IconButton
        label="收起左侧"
        icon={PanelLeftClose}
        testId="titlebar-toggle-sidebar"
        active={sidebarCollapsed}
        onClick={toggleSidebar}
        className="app-region-no-drag"
      />

      <span className="flex min-w-0 flex-1 items-center justify-center">
        {/* 无标题 = 整块留白（不渲染空 span：空 title 属性会让 m5 长文本探针的
            hasTitle/every 断言误判失败，采样点少一个后仍有 3 处，≥3 依然成立）。
            title 提供超长标题的全称（M5 5-8 长文本合格线：省略 + 全称可见）。 */}
        {title ? (
          <span
            data-testid="titlebar-title"
            className="truncate text-sm font-medium text-text-primary"
            title={title}
          >
            {title}
          </span>
        ) : null}
      </span>

      <IconButton
        label={dark ? "切换到浅色" : "切换到深色"}
        icon={dark ? Moon : Sun}
        testId="titlebar-toggle-theme"
        onClick={toggleTheme}
        className="app-region-no-drag"
      />
      <IconButton label="设置" icon={Settings} testId="titlebar-open-settings" onClick={onOpenSettings} className="app-region-no-drag" />
      <IconButton
        label="收起右侧"
        icon={PanelRightClose}
        testId="titlebar-toggle-preview"
        active={previewCollapsed}
        onClick={togglePreview}
        className="app-region-no-drag"
      />
    </div>
  );
});
