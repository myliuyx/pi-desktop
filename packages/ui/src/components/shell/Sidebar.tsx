import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { FolderOpen, History, Plus, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  SIDEBAR_GAP,
  SIDEBAR_PADDING,
  SIDEBAR_WIDTH,
  COLLAPSED_WIDTH,
  COLLAPSE_DURATION,
  COLLAPSE_DURATION_REDUCED,
} from "@/lib/layout";
import { formatRelativeTime } from "@/lib/format";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { Icon, type LucideIcon } from "@/components/common/icons";
import { isLiveEnabled } from "@/lib/feature-flags";
import { useUiStore } from "@/store/ui-store";
import { useChatStore } from "@/store/chat-store";
import { SESSION_LIST_NOW, SESSION_SUMMARIES } from "@/mock/sessions";

interface MenuItemProps {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick?: () => void;
  testId?: string;
}

/** 侧边栏菜单项：图标固定中性色，文字用次级色，激活时提升到主色 */
function MenuItem({ icon, label, active = false, onClick, testId }: MenuItemProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      /*
       * `title={label}` 是长文本合格线的一半（M5 5-8）：
       * 超长会话标题 / 菜单文案用 `truncate` 单行省略，但省略后**全称必须可见** ——
       * 靠 `title` 提供悬停全称。只省略不给 title 属于「被无声裁掉」，不合格。
       */
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-8 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-base",
        "transition-colors duration-150 ease-out",
        active
          ? "bg-bg-active text-text-primary"
          // M5 5-5：可点击元素必须有按下反馈 —— 原来这条分支缺 `active:bg-bg-active`，
          // 鼠标按下时没有任何视觉响应（自查 5-5 抓到的真实缺口）。
          : "text-text-secondary hover:bg-bg-hover hover:text-text-primary active:bg-bg-active",
      )}
    >
      <Icon icon={icon} />
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * 历史会话两行条目（2026-09-22 用户裁决，参考会话列表样式）：
 * 标题一行 + 「相对时间 N 条消息」元信息一行。
 *
 * - 交互类与 MenuItem 一致（hover/active/transition），满足 M5 5-5 按下反馈抽查；
 * - 两行都用 `truncate` + `title` 提供悬停全称，满足 M5 5-8 长文本合格线；
 * - `items-stretch` 让两行 span 等宽，truncate 才能以容器宽度（而非自身内容宽）生效；
 * - **整块内容左对齐**（2026-09-22 终裁：经「元信息靠右 → 整块靠右」两次迭代后，用户最终
 *   改定靠左——与参考截图像素实测一致）。对齐只写在 button 一处，两行 span 继承。
 *   历史教训：cn() 曾缺 text-align 组导致 text-left 被颜色类吞掉、按钮回落 UA center，
 *   现已补组并加 cn-check 用例——这里的 text-left 是显式生效，不是 UA 兜底。
 */
function HistoryItem({ title, meta, active = false, testId, onSelect }: { title: string; meta: string; active?: boolean; testId?: string; onSelect?: () => void }) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      title={title}
      onClick={onSelect}
      className={cn(
        "flex w-full shrink-0 flex-col items-stretch gap-0.5 rounded-md px-2 py-1.5 text-left",
        "transition-colors duration-150 ease-out",
        active
          ? "bg-bg-active text-text-primary"
          : "text-text-secondary hover:bg-bg-hover hover:text-text-primary active:bg-bg-active",
      )}
    >
      <span className="truncate">{title}</span>
      {/* 元信息降两级用三级色，即使整条激活也保持弱化层级；对齐继承 button 的 text-left */}
      <span className="truncate text-xs text-text-tertiary" title={meta}>{meta}</span>
    </button>
  );
}

export interface SidebarProps extends HTMLAttributes<HTMLElement> {
  /** 当前会话 id（mock） */
  activeSessionId?: string;
  /** 当前工作目录（mock） */
  workingDirectory?: string;
  onNewTask?: () => void;
  onSearch?: () => void;
  onOpenFolder?: () => void;
  /** 底部条带，由 WorkbenchScreen 传入以避免 Sidebar 依赖 store 的折叠样式之外的东西 */
  footer?: ReactNode;
}

/**
 * 侧边栏（宽 264，可折叠）。
 *
 * 结构要点（验收 1-3 的地基）：
 * ```
 * aside  (padding:0 / gap:0 / flex-col)   ← 不给任何 padding
 * ├── div.内容包装器 (padding:12 / gap:10 / flex-1 / min-h-0 / overflow-y-auto)
 * └── footer                                ← 兄弟节点，通底贴边
 * ```
 * 折叠走**宽度过渡 + overflow:hidden**（不用 display:none，验收 1-10），
 * 因此除 `whitespace-nowrap` 外不能有别的会随宽度重排的样式。
 */
export const Sidebar = forwardRef<HTMLElement, SidebarProps>(function Sidebar(
  { activeSessionId, workingDirectory = "~ / projects / atlas-agent", onNewTask, onSearch, onOpenFolder, footer, className, ...rest },
  ref,
) {
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const prefersReducedMotion = usePrefersReducedMotion();

  /*
   * ★ C4：历史会话的数据源按形态二选一（**默认 mock 一行不变**）：
   * - mock（默认）：`SESSION_SUMMARIES` + 冻结的相对时间锚点 `SESSION_LIST_NOW`（验收 m1/m5 依赖）；
   * - live（`?live=1`）：chat-store 里的真实清单 + 真实时钟锚点（`S2 §三` 已记：接真数据后换 `Date.now()`）。
   * 条目 testid（`sidebar-history-item-<index>`）与两行结构完全不变 —— 只换数据。
   */
  const live = isLiveEnabled();
  const liveSummaries = useChatStore((state) => state.sessionSummaries);
  const liveSessionId = useChatStore((state) => state.liveSessionId);
  const summaries = live ? liveSummaries : SESSION_SUMMARIES;
  const relativeAnchor = live ? Date.now() : SESSION_LIST_NOW;
  const selectSession = useChatStore((state) => state.loadSessionById);

  return (
    <aside
      ref={ref}
      data-testid="sidebar"
      data-collapsed={collapsed}
      aria-label="侧边栏"
      aria-hidden={collapsed}
      className={cn(
        /*
         * 这里 `flex` 与 `flex-col` 必须同传，且依赖 cn() 把它们分到不同冲突组。
         * 早期 cn() 把二者都归到 "flex" 组，后写的 `flex-col` 会把先写的 `flex` 整条吞掉，
         * 元素就只剩 flex-direction:column 而没有 display:flex，静默退化成 display:block。
         * 详见 lib/cn.ts 的 flex 分组注释。
         *
         * 分隔线用 `divider-r`（绝对定位伪元素）而**不是** `border-r`：
         * border 在 border-box 下最窄就是 1px，会让折叠态卡在 1px、内容区只有 1422
         * （验收 1-13 要求严格 0）。伪元素不占布局宽度，才能收到真正的 0。
         * 详见 globals.css 里 divider-r 的注释与实测数据。
         */
        "flex h-full min-h-0 min-w-0 shrink-0 flex-col overflow-hidden divider-r bg-bg-surface",
        "gap-0 p-0",
        // 宽度过渡：**不要**加 motion-reduce:transition-none —— 那会生成
        // @media(prefers-reduced-motion:reduce){transition-property:none}，把过渡整个取消，
        // 折叠退化成瞬间跳变（实测 headless Chrome 默认就是 reduce，验收 1-10 直接挂）。
        // reduced-motion 的适配改为「缩短时长」，见下方 transitionDuration。
        "transition-[width] ease-out",
        className,
      )}
      style={{
        width: collapsed ? COLLAPSED_WIDTH : SIDEBAR_WIDTH,
        transitionDuration: `${prefersReducedMotion ? COLLAPSE_DURATION_REDUCED : COLLAPSE_DURATION}ms`,
      }}
      {...rest}
    >
      {/* 内容包装器：承载 12px 内边距，折叠时用 nowrap 防止文字反复折行造成抖动 */}
      <div
        data-testid="sidebar-content"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden whitespace-nowrap"
        style={{ padding: SIDEBAR_PADDING, gap: SIDEBAR_GAP }}
      >
        <MenuItem icon={Plus} label="新建任务" testId="sidebar-new-task" onClick={onNewTask} />

        <MenuItem icon={Search} label="搜索" testId="sidebar-search" onClick={onSearch} />

        {/* 历史会话：直接平铺列表，**无「今天 / 昨天」分组标题**（设计稿第 4 轮去掉，验收 1-7） */}
        <SectionLabel icon={History} label="历史会话" />
        <nav className="flex flex-col gap-0.5" data-testid="sidebar-history" aria-label="历史会话">
          {summaries.map((session, index) => (
            <HistoryItem
              key={session.id}
              title={session.title}
              meta={`${formatRelativeTime(session.updatedAt, relativeAnchor)} ${session.messageCount} 条消息`}
              /*
               * 激活项判定：live 用真实当前会话 id，mock 仍用调用方传入的 `activeSessionId`
               * （默认 "session-0" —— 不动清单里的既有行为）。
               */
              active={live ? liveSessionId === session.id : activeSessionId === session.id}
              testId={`sidebar-history-item-${index}`}
              /* live 形态下点击即按 id 打开历史会话；mock 形态不绑点击（行为零变化） */
              onSelect={live ? () => selectSession(session.id, session.title) : undefined}
            />
          ))}
        </nav>

        <SectionLabel icon={FolderOpen} label="工作目录" />
        <div
          data-testid="sidebar-working-directory"
          className="flex shrink-0 items-center gap-2 rounded-md bg-bg-subtle px-2 py-1.5"
        >
          <Icon icon={FolderOpen} />
          {/* title 提供超长路径的全称（M5 5-8 长文本合格线） */}
          <span className="truncate font-mono text-xs text-text-secondary" title={workingDirectory}>
            {workingDirectory}
          </span>
        </div>

        <button
          type="button"
          data-testid="sidebar-change-directory"
          onClick={onOpenFolder}
          className={cn(
            "flex h-8 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-base",
            "text-text-secondary transition-colors duration-150 ease-out",
            "hover:bg-bg-hover hover:text-text-primary active:bg-bg-active",
          )}
        >
          <Icon icon={FolderOpen} />
          <span className="truncate">打开文件夹</span>
        </button>
      </div>

      {/* ★ 条带是内容包装器的兄弟节点，不在 12px padding 之内 —— 验收 1-3 的判定点 */}
      {footer}
    </aside>
  );
});

/** 分节标签：不是「今天 / 昨天」那种日期分组，只是菜单分区标题 */
function SectionLabel({ icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex shrink-0 items-center gap-2 px-2 pt-1">
      <Icon icon={icon} size={14} />
      <span className="text-xs font-medium text-text-tertiary">{label}</span>
    </div>
  );
}
