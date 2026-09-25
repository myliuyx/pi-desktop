import { forwardRef, useState, type ChangeEvent, type HTMLAttributes, type ReactNode } from "react";
import { FolderOpen, History, Plus, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  SIDEBAR_GAP,
  SIDEBAR_HISTORY_SECTION_FLEX_GROW,
  SIDEBAR_PADDING,
  SIDEBAR_SECTION_FLEX_BASIS,
  SIDEBAR_WIDTH,
  SIDEBAR_WORKING_DIRECTORY_SECTION_FLEX_GROW,
  COLLAPSED_WIDTH,
  COLLAPSE_DURATION,
  COLLAPSE_DURATION_REDUCED,
} from "@/lib/layout";
import { formatRelativeTime } from "@/lib/format";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { Icon, type LucideIcon } from "@/components/common/icons";
import { WorkingDirectoryMenu } from "@/components/shell/WorkingDirectoryMenu";
import { WorkingDirFileTree } from "@/components/shell/WorkingDirFileTree";
import { isLiveEnabled } from "@/lib/feature-flags";
import { useUiStore } from "@/store/ui-store";
import { useChatStore } from "@/store/chat-store";
import { SESSION_LIST_NOW, SESSION_SUMMARIES } from "@/mock/sessions";
import type { SessionSummary } from "@/mock/types";

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

/** 按标题过滤历史会话；空查询返回原列表，英文大小写不敏感。 */
export function filterSessionSummaries(
  sessions: readonly SessionSummary[],
  query: string,
): readonly SessionSummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return sessions;
  return sessions.filter((session) => session.title.toLowerCase().includes(normalizedQuery));
}

export interface SidebarProps extends HTMLAttributes<HTMLElement> {
  /** 当前会话 id（mock） */
  activeSessionId?: string;
  /**
   * 工作目录**覆盖口径**（`workingDirectory ?? 按形态取值`）—— 仅 SSR / 探针使用，
   * **生产调用点一律不传**：
   * - 不传（生产）：live 显示 core 的真实 cwd（只读），mock 显示 `uiStore.workingDir`；
   * - 传了（`scripts/sidebar-layout-check.mjs` SSR 渲染需要固定值）：以传入值为准。
   *
   * ⚠️ 2026-09-24 起**不再是**"展示值"本身：旧默认值 `"~ / projects / atlas-agent"`
   * 与 `uiStore.workingDir` 各不相同（一个带空格一个不带），两处已漂移 —— 现在统一收到
   * `useWorkingDirectoryView` 一处解析（U5 / R9）。
   */
  workingDirectory?: string;
  /** 底部条带，由 WorkbenchScreen 传入以避免 Sidebar 依赖 store 的折叠样式之外的东西 */
  footer?: ReactNode;
}

/**
 * 侧边栏（宽 264，可折叠）。
 *
 * 结构要点（验收 1-3 的地基）：
 * ```
 * aside  (padding:0 / gap:0 / flex-col)   ← 不给任何 padding
 * ├── div.内容包装器 (padding:12 / gap:10 / flex-1 / min-h-0 / overflow-hidden)
 * │   ├── 顶部操作区 (固定)
 * │   ├── 历史会话区 (flex:2 / min-h-0 / overflow-hidden)
 * │   │   └── 会话列表 (flex-1 / min-h-0 / overflow-y-auto)
 * │   └── 工作目录区 (flex:1 / min-h-0 / overflow-hidden)
 * │       ├── 触发条=当前目录行 (固定，不随树滚 —— 2026-09-25 挪出滚动容器)
 * │       └── 工作目录内容 (flex-1 / min-h-0 / overflow-y-auto)
 * └── footer                                ← 兄弟节点，通底贴边
 * ```
 * 历史会话与未来可能嵌套多层的文件树各有独立滚动边界；任一列表变多都不能继续
 * 把下方分区或 footer 推出可视区。折叠走**宽度过渡 + overflow:hidden**（不用
 * display:none，验收 1-10），因此除 `whitespace-nowrap` 外不能有别的会随宽度重排的样式。
 */
export const Sidebar = forwardRef<HTMLElement, SidebarProps>(function Sidebar(
  { activeSessionId, workingDirectory, footer, className, ...rest },
  ref,
) {
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const prefersReducedMotion = usePrefersReducedMotion();
  const [searchQuery, setSearchQuery] = useState("");

  /*
   * ★ 新建会话（task-new-session-page.md §4.5 · D1）：原来经 `onNewTask` prop 外部注入，
   * 但全部 4 个调用点都没传 —— 哑按钮（与 dir-menu 批次删 `onOpenFolder` 同型），
   * 现在内部直连 chat-store 的 startNewSession。从 03/04/06 屏点击时顺带把 hash
   * 切回工作台；已在 workbench 时赋同值不触发 hashchange，幂等。
   * 处理器只在 click 里跑，SSR（check:sidebar-layout）不经过它。
   */
  const startNewSession = useChatStore((state) => state.startNewSession);
  const handleNewTask = () => {
    startNewSession();
    window.location.hash = "#/workbench";
  };

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
  const visibleSessionIds = new Set(filterSessionSummaries(summaries, searchQuery).map((session) => session.id));

  const handleSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(event.currentTarget.value);
  };

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
      {/* 内容包装器：承载 12px 内边距；自身不滚动，滚动职责下放到两个分区 */}
      <div
        data-testid="sidebar-content"
        className="flex min-h-0 flex-1 flex-col overflow-hidden whitespace-nowrap"
        style={{ padding: SIDEBAR_PADDING, gap: SIDEBAR_GAP }}
      >
        <div data-testid="sidebar-actions" className="flex shrink-0 flex-col" style={{ gap: SIDEBAR_GAP }}>
          <MenuItem icon={Plus} label="新建会话" testId="sidebar-new-task" onClick={handleNewTask} />
          <div className="relative flex shrink-0 items-center">
            <span className="pointer-events-none absolute left-2 flex items-center">
              <Icon icon={Search} />
            </span>
            <input
              type="search"
              value={searchQuery}
              onChange={handleSearchChange}
              placeholder="搜索历史会话"
              aria-label="搜索历史会话"
              autoComplete="off"
              spellCheck={false}
              data-testid="sidebar-search"
              className={cn(
                "h-8 w-full rounded-md border border-border-subtle bg-bg-subtle pl-8 pr-2 text-base text-text-primary",
                "transition-colors duration-150 ease-out placeholder:text-text-tertiary",
                "hover:bg-bg-hover focus:border-border-strong",
              )}
            />
          </div>
        </div>

        {/* 历史会话：直接平铺列表，**无「今天 / 昨天」分组标题**（设计稿第 4 轮去掉，验收 1-7） */}
        <section
          data-testid="sidebar-history-section"
          className="flex min-h-0 flex-col overflow-hidden"
          style={{
            flexGrow: SIDEBAR_HISTORY_SECTION_FLEX_GROW,
            flexBasis: SIDEBAR_SECTION_FLEX_BASIS,
            gap: SIDEBAR_GAP,
          }}
        >
          <SectionLabel icon={History} label="历史会话" />
          <nav
            className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden"
            data-testid="sidebar-history"
            aria-label="历史会话"
          >
            {visibleSessionIds.size > 0 ? (
              summaries.map((session, index) =>
                visibleSessionIds.has(session.id) ? (
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
                ) : null,
              )
            ) : (
              <div data-testid="sidebar-search-empty" className="px-2 py-2 text-xs text-text-tertiary">
                没有匹配的历史会话
              </div>
            )}
          </nav>
        </section>

        <section
          data-testid="sidebar-working-directory-section"
          className="flex min-h-0 flex-col overflow-hidden border-t border-border-subtle pt-1.5"
          style={{
            flexGrow: SIDEBAR_WORKING_DIRECTORY_SECTION_FLEX_GROW,
            flexBasis: SIDEBAR_SECTION_FLEX_BASIS,
            gap: SIDEBAR_GAP,
          }}
        >
          <SectionLabel icon={FolderOpen} label="工作目录" />
          {/*
           * ★ 2026-09-24 改造（U1/U2/U5）：原本是纯展示 `div` + 一个**哑按钮**「打开文件夹」
           *   （`onClick={onOpenFolder}`，全部 4 个调用点都没传），合成**可点击的触发条**。
           * ★ 2026-09-25 滚动修复：触发条**固定在滚动容器之外**——此前它与文件树同在下方
           *   `overflow-y-auto` 里，树一长往下滚目录名行就跟着滚出视野。
           *   上弹面板仍 portal 到 `body`（本区被 section/aside 两层 `overflow-hidden` 包着，
           *   原地 absolute 依旧会被裁，见 WorkingDirectoryMenu 文件头）。
           */}
          <WorkingDirectoryMenu workingDirectory={workingDirectory} />
          <div
            data-testid="sidebar-working-directory-content"
            className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden"
          >
            {/*
             * ★ 2026-09-25 文件树（dir-tree 批次，task-sidebar-file-tree.md）：
             * 渲染门槛在组件内部（mock / SSR / liveCwd 未拿到都返回 null）；
             * 树的滚动由本容器 overflow-y-auto 独自承担，不新增滚动边界。
             */}
            <WorkingDirFileTree />
          </div>
        </section>
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
