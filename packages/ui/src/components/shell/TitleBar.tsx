import { forwardRef, type HTMLAttributes } from "react";
import { Moon, PanelLeftClose, PanelRightClose, Settings, Sun } from "lucide-react";
import { cn } from "@/lib/cn";
import { TITLE_BAR_BUTTON_SIZE, TITLE_BAR_HEIGHT } from "@/lib/layout";
import { IconButton } from "@/components/primitives";
import { useUiStore } from "@/store/ui-store";

export type OsName = "mac" | "win" | "linux";

/** 会话标题兜底文案 */
const DEFAULT_TITLE = "新建会话";

/** mac 交通灯直径 10 */
const MAC_DOT_SIZE = 10;

/**
 * 三端壳的标志色。品牌色不随主题派生，因此不进 tokens.css，
 * 而是注册在 Tailwind 主题里（见 styles/globals.css），组件侧不出现色值字面量。
 */
const MAC_DOT_CLASS = ["bg-window-close", "bg-window-minimize", "bg-window-maximize"] as const;

function MacTrafficLights() {
  return (
    <div className="flex shrink-0 items-center gap-2" aria-hidden="true">
      {MAC_DOT_CLASS.map((dotClass) => (
        <span
          key={dotClass}
          className={cn("block rounded-full", dotClass)}
          style={{ width: MAC_DOT_SIZE, height: MAC_DOT_SIZE }}
        />
      ))}
    </div>
  );
}

/** win / linux 的窗口控件用内联 SVG 表达，避免为一个形状引入图标并保持 28×28 一致 */
function WindowControlGlyph({ shape }: { shape: "minimize" | "maximize" | "close" }) {
  return (
    <svg width={MAC_DOT_SIZE} height={MAC_DOT_SIZE} viewBox="0 0 10 10" aria-hidden="true">
      {shape === "minimize" ? <rect x="0" y="4.5" width="10" height="1" className="fill-current" /> : null}
      {shape === "maximize" ? (
        <rect x="0.5" y="0.5" width="9" height="9" fill="none" strokeWidth={1} className="stroke-current" />
      ) : null}
      {shape === "close" ? (
        <path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" strokeWidth={1} className="stroke-current" />
      ) : null}
    </svg>
  );
}

const WIN_CONTROLS: Array<{ shape: "minimize" | "maximize" | "close"; label: string }> = [
  { shape: "minimize", label: "最小化" },
  { shape: "maximize", label: "最大化" },
  { shape: "close", label: "关闭" },
];

function WindowControls({ os }: { os: OsName }) {
  if (os === "mac") return <MacTrafficLights />;

  return (
    <div className="flex shrink-0 items-center" aria-hidden="true">
      {WIN_CONTROLS.map(({ shape, label }) => (
        <span
          key={shape}
          className={cn(
            "flex items-center justify-center rounded-md text-text-secondary",
            // win 把关闭键染成危险色；linux 三个键一视同仁，风格更朴素
            os === "win" && shape === "close" && "text-danger",
          )}
          style={{ width: TITLE_BAR_BUTTON_SIZE, height: TITLE_BAR_BUTTON_SIZE }}
          title={label}
        >
          <WindowControlGlyph shape={shape} />
        </span>
      ))}
    </div>
  );
}

export interface TitleBarProps extends HTMLAttributes<HTMLDivElement> {
  /** 当前窗口壳类型 */
  os?: OsName;
  /** 会话标题，超出截断 */
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
 */
export const TitleBar = forwardRef<HTMLDivElement, TitleBarProps>(function TitleBar(
  { os = "mac", title = DEFAULT_TITLE, onOpenSettings, className, ...rest },
  ref,
) {
  const theme = useUiStore((state) => state.theme);
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const previewCollapsed = useUiStore((state) => state.previewCollapsed);
  const toggleTheme = useUiStore((state) => state.toggleTheme);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const togglePreview = useUiStore((state) => state.togglePreview);

  const dark = theme === "dark";

  return (
    <div
      ref={ref}
      className={cn(
        "flex shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-surface px-2",
        className,
      )}
      style={{ height: TITLE_BAR_HEIGHT }}
      {...rest}
    >
      <WindowControls os={os} />

      <IconButton
        label="收起左侧"
        icon={PanelLeftClose}
        testId="titlebar-toggle-sidebar"
        active={sidebarCollapsed}
        onClick={toggleSidebar}
      />

      <span className="flex min-w-0 flex-1 items-center justify-center">
        {/* title 提供超长会话标题的全称（M5 5-8 长文本合格线：省略 + 全称可见） */}
        <span
          data-testid="titlebar-title"
          className="truncate text-sm font-medium text-text-primary"
          title={title}
        >
          {title}
        </span>
      </span>

      <IconButton
        label={dark ? "切换到浅色" : "切换到深色"}
        icon={dark ? Moon : Sun}
        testId="titlebar-toggle-theme"
        onClick={toggleTheme}
      />
      <IconButton label="设置" icon={Settings} testId="titlebar-open-settings" onClick={onOpenSettings} />
      <IconButton
        label="收起右侧"
        icon={PanelRightClose}
        testId="titlebar-toggle-preview"
        active={previewCollapsed}
        onClick={togglePreview}
      />
    </div>
  );
});
