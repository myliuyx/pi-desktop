import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, FolderOpen, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/common/icons";
import { Button } from "@/components/primitives";
import {
  POPOVER_Z,
  WORKING_DIR_MENU_FADE_MS,
  WORKING_DIR_MENU_GAP,
  WORKING_DIR_MENU_MIN_WIDTH,
} from "@/lib/layout";
import { truncatePathTail } from "@/lib/recent-dirs";
import { isLiveEnabled } from "@/lib/feature-flags";
import { DEFAULT_WORKING_DIR } from "@/mock/settings";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { useUiStore } from "@/store/ui-store";
import { useChatStore } from "@/store/chat-store";
import { useNoticeStore } from "@/store/notice-store";

/**
 * 侧栏「工作目录」触发条 + **上弹**浮层（指针与键盘上都可用），设置页复用同一个浮层。
 *
 * ## 为什么必须 portal（本次最大的技术坑）
 *
 * 触发条位于 `sidebar-working-directory-content`（`overflow-y-auto`）内部，
 * 而外层 `sidebar-working-directory-section` 与 `aside` **也都是 `overflow-hidden`**。
 * 照抄 ChipMenu 的原地 `absolute bottom-full`，面板会落在容器的**负坐标区被逐层裁掉**。
 * 更坑的是：**被裁时 `getBoundingClientRect()` 照样返回正常数值** ——
 * "量得到"不等于"看得见"，所以这里的判据只能是 `elementFromPoint`（验收 C4）。
 * ⇒ `createPortal(panel, document.body)` + `position: fixed`。
 *
 * portal 的固有代价：面板挂在 `body` 上，**脱离 `aside` 的 `aria-hidden` 管辖**，
 * 侧栏收起时若不同步关闭，就会出现「侧栏收了、菜单还浮在空地上」。
 * 所以「订阅 `sidebarCollapsed` 主动关闭」是必需项（验收 C10），不是可选项。
 *
 * ## 取值口径（本模块的另一条铁律）
 *
 * live 形态显示 **core 的真实 cwd**（`GET /sessions` 已返回，只读）；
 * 拿不到时**显式降级**成占位文案，**绝不回落成 `uiStore.workingDir`** ——
 * 本地记录值冒充"当前会话目录"会造出一个并不存在但很像真的事实
 * （同「无可用模型时不得回落 mock modelId」）。`data-current-source` 是这条口径的
 * **唯一无歧义判据**：`unavailable` 与 `mock` 的文字可能长得一样（都可能是某个路径）。
 */

/** 显示值的来源（`data-current-source` 的取值，属 §4.0 契约，不得改名） */
export type WorkingDirectorySource = "live" | "mock" | "unavailable";

/** live 但还没拿到 cwd 时的显式占位（不许回落本地值） */
const UNAVAILABLE_TEXT = "未知目录";

/**
 * SSR 下 `useLayoutEffect` 会打 warning 且不执行；首帧定位只在浏览器里有意义，
 * 所以服务端降级成 `useEffect`（不执行也不吵）。
 */
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * 工作目录「显示值」的统一解析口径（侧栏触发条、面板首行、设置页共用一份）。
 *
 * 抽出来的理由：D4 要求设置页与侧栏**说同一件事**，否则就会出现
 * 「侧栏说真的、设置页说假的」；口径只有一处实现才不会漂移。
 *
 * ⚠️ `liveCwd` 是只读真相，本 hook **不提供任何 setter**。
 */
export interface WorkingDirectoryView {
  /** 形态：live 拿到真值 / mock 本地偏好 / live 未拿到（显式降级） */
  source: WorkingDirectorySource;
  /** 完整路径（`title` 与设置页用）；live 未拿到时为占位文案 */
  fullPath: string;
  /** 左侧省略后的展示值（侧栏路径行用） */
  label: string;
  /** 本地偏好目录；`null` = 未设置（跟随 core 默认）。live 下即「下次启动带不带 CORE_CWD」；mock 下即当前展示值的直接来源 */
  preference: string | null;
  /** live 下 core 的真实 cwd；未拿到为 null */
  liveCwd: string | null;
  /** 本地最近目录（未排除当前项） */
  recentDirs: string[];
}

export function useWorkingDirectoryView(override?: string): WorkingDirectoryView {
  const live = isLiveEnabled();
  const liveCwd = useChatStore((state) => state.liveCwd);
  const preference = useUiStore((state) => state.workingDir);
  const recentDirs = useUiStore((state) => state.recentDirs);

  /*
   * `override` 是**仅 SSR / 探针**的固定口径（`scripts/sidebar-layout-check.mjs` 依赖它传
   * 固定值渲染真实 Sidebar）；生产调用点一律不传。取值优先级：override › 形态口径。
   * mock 没有 core 可显示，偏好未设置（`null`）时回落 mock 占位值 —— **仅展示**，
   * 不写回存储（live 下显示值恒为真 cwd，偏好为 null 时不会走到这里）。
   */
  const value = override ?? (live ? liveCwd : preference ?? DEFAULT_WORKING_DIR);
  const source: WorkingDirectorySource = live ? (liveCwd ? "live" : "unavailable") : "mock";
  const fullPath = value ?? UNAVAILABLE_TEXT;

  return { source, fullPath, label: truncatePathTail(fullPath), preference, liveCwd, recentDirs };
}

export interface WorkingDirectoryMenuProps {
  /** 面板 testid；设置页传 `settings-working-dir-menu`（两个 portal 面板可能同时存在，重名会让 q() 取错） */
  menuTestId?: string;
  /** **仅 SSR / 探针覆盖**的固定口径；生产调用点一律不传 */
  workingDirectory?: string;
  /** 触发条形态：`sidebar` = 路径行（默认）；`settings` = 设置页「更改」按钮 */
  variant?: "sidebar" | "settings";
}

export function WorkingDirectoryMenu({
  menuTestId = "sidebar-working-directory-menu",
  workingDirectory,
  variant = "sidebar",
}: WorkingDirectoryMenuProps) {
  const view = useWorkingDirectoryView(workingDirectory);
  const { source, fullPath, label, preference, liveCwd, recentDirs } = view;

  const [open, setOpen] = useState(false);
  /** 首帧定位完成前先 `opacity-0`：否则会先闪一下未定位的面板（R3） */
  const [placed, setPlaced] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0, width: WORKING_DIR_MENU_MIN_WIDTH });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const prefersReduced = usePrefersReducedMotion();
  const setWorkingDir = useUiStore((state) => state.setWorkingDir);
  const clearWorkingDir = useUiStore((state) => state.clearWorkingDir);
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const settingsOpen = useUiStore((state) => state.settingsOpen);

  const live = isLiveEnabled();
  const isSidebar = variant === "sidebar";

  /**
   * 当前项之后的「其余最近目录」。
   * 当前目录**恒置顶**（见下方首行），所以要从本区排除，否则同一个目录会出现两次
   * （live 下更严重：真实目录与偏好目录是两个概念，会出现**两个 ✓**，§4.6 明令禁止）。
   * 排除对象是**有效展示值**（mock 偏好未设置时 = 占位值），不是裸 preference。
   */
  const currentDir = live ? liveCwd : preference ?? DEFAULT_WORKING_DIR;
  const restRecents = recentDirs.filter((dir) => dir !== currentDir);

  function close() {
    setOpen(false);
  }

  function openMenu() {
    setPlaced(false);
    setOpen(true);
  }

  /* ------------------------------------------------------------------ 关闭时机 */

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    /*
     * 位置失效（resize / 任意容器滚动）直接关闭：面板生命周期很短，
     * 重算不如关掉干净，少一类"错位却看起来有值"的错。
     */
    const onViewportChange = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open]);

  /*
   * 关闭联动（两条都必须有，且**两种形态各自都要顾**）：
   *
   * ① sidebar 形态：侧栏折叠 / 设置弹窗打开 ⇒ 关闭侧栏那份面板
   *    （面板 portal 在 body 上，脱离 `aside` 的 `aria-hidden` 管辖，不关就浮在空地上）。
   *
   * ② settings 形态：**弹窗关闭 ⇒ 面板跟着关**。
   *    为什么这是必需项而不是可选项：`Dialog` 关闭后 children **保留在 DOM**
   *    （inert + opacity-0 + pointer-events-none，见 Dialog.tsx「G8 过渡」注释），
   *    而本面板 `createPortal` 到 `document.body` —— **不是** dialog 的 DOM 后代，
   *    `inert` 管不到它 ⇒ 弹窗关了面板会残留且仍可交互（z-60 还在遮罩之上）。
   *    React 语义上它随弹窗子树"还在"，但用户看到的是一个孤儿浮层。
   */
  useEffect(() => {
    if (!open) return;
    if (isSidebar) {
      if (sidebarCollapsed || settingsOpen) setOpen(false);
    } else if (!settingsOpen) {
      setOpen(false);
    }
  }, [open, isSidebar, sidebarCollapsed, settingsOpen]);

  /* ------------------------------------------------------------------ 定位 */

  useIsoLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.max(rect.width, WORKING_DIR_MENU_MIN_WIDTH);
    const height = panel.offsetHeight;
    // 默认向上（用户要的「向上弹出」）；贴顶放不下时翻转向下，避免面板跑到视口外
    let top = rect.top - height - WORKING_DIR_MENU_GAP;
    if (top < 8) top = rect.bottom + WORKING_DIR_MENU_GAP;
    // 水平：左对齐触发条；仅当会顶出视口时才回收（G6 不出现横向滚动 / 面板不出屏）
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    setPos({ left: Math.min(Math.max(8, rect.left), maxLeft), top, width });
    setPlaced(true);
    /*
     * 依赖不止 `open`：live 的 cwd 是**异步**拿到的，面板打开期间 `label`/`source` 可能变化
     *（内容变高变矮）⇒ 必须重算 top/left，否则面板会停在旧坐标上（"错位却看起来有值"）。
     * `recentDirs.length` 同理覆盖"最近目录在打开期间被外部改写"的防御场景。
     */
  }, [open, label, source, recentDirs.length]);

  /* 展开后焦点落到「当前项」（APG menu：菜单项不在 Tab 序里，靠方向键漫游） */
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      menuItems()[0]?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  /* ------------------------------------------------------------------ 键盘（照搬 ChipMenu） */

  /** 面板内全部可漫游项，DOM 序即视觉序（role 前缀同时覆盖 menuitem / menuitemradio） */
  function menuItems(): HTMLButtonElement[] {
    const panel = panelRef.current;
    if (!panel) return [];
    return Array.from(panel.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]'));
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (open) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
      return;
    }
    // 菜单在上方，方向键「向上/向下打开」都说得通；Enter/Space 走按钮原生 click
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      openMenu();
    }
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = menuItems();
    const index = items.findIndex((el) => el === document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(index + 1 + items.length) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === "Escape") {
      event.stopPropagation();
      close();
      // 焦点还给触发条，别落到 body（G7）
      triggerRef.current?.focus();
    } else if (event.key === "Tab") {
      // 让 Tab 自然走，但菜单收起（焦点离开即关闭的键盘等价物）
      close();
    }
  }

  /* ------------------------------------------------------------------ 选择 */

  /**
   * 记偏好目录。
   *
   * - mock：`workingDir` 就是显示值，所以**立即变**，且不弹提示（C21）；
   * - live：真实目录是 core 的启动参数，UI **不做热切换**（D2/§六），
   *   所以只记偏好 + **显式提示需重启生效**（D5）——不假装能热切。
   */
  function chooseDir(dir: string) {
    setWorkingDir(dir);
    if (live && dir !== liveCwd) {
      useNoticeStore.getState().notify({
        tone: "info",
        text: `已记录为下次启动目录：${dir}。重启 core 后生效：cd packages/core && CORE_CWD=${dir} npm run smoke`,
      });
    }
    close();
    triggerRef.current?.focus();
  }

  /**
   * 「使用默认目录」= **清除偏好**（2026-09-24 裁决，替代旧的「写回 DEFAULT_WORKING_DIR」）。
   *
   * 为什么不写任何路径：live 的「默认」是 core **未来启动时**的 `process.cwd()`，
   * UI 此刻拿不到 —— 写死某个值（如 mock 占位 `DEFAULT_WORKING_DIR`，`~` 路径在
   * Windows 上根本不存在）只会造出一个不存在但很像真的偏好。清除后 core 侧
   * `CORE_CWD` 缺省 ⇒ 自动回落 pi 自己的 `process.cwd()`，语义才是真的「用默认」。
   *
   * - live：弹提示说明重启后不带 `CORE_CWD`（对齐 chooseDir 的显式反馈）；
   * - mock：偏好即显示值，清除立即生效，不弹提示（C21 先例）。
   */
  function chooseDefault() {
    clearWorkingDir();
    if (live) {
      useNoticeStore.getState().notify({
        tone: "info",
        text: "已恢复默认：下次启动 core 不设置 CORE_CWD，将以 core 启动时所在目录（process.cwd()）为工作目录",
      });
    }
    close();
    triggerRef.current?.focus();
  }

  /**
   * 「自定义路径…」= 方案 A（§4.5）：外观与参照图一致（可点、不置灰），
   * 点击走**显式反馈**而不是静默 —— "点了没反应"是本项目明令避免的陷阱；
   * 但也不假装实现了选择器（浏览器套壳拿不到绝对路径，见 §六.2）。
   * 面板**不关**：用户看到提示后可以接着选别的。
   */
  function chooseCustom() {
    useNoticeStore.getState().notify({
      tone: "info",
      text: "自定义路径：尚未接入系统目录对话框，请从最近目录或默认目录中选择",
    });
  }

  /* ------------------------------------------------------------------ 渲染 */

  const fadeMs = prefersReduced ? WORKING_DIR_MENU_FADE_MS / 2 : WORKING_DIR_MENU_FADE_MS;
  const menuItemClass = cn(
    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm",
    "transition-colors duration-150 hover:bg-bg-hover focus:bg-bg-hover",
  );

  const trigger = isSidebar ? (
    <button
      ref={triggerRef}
      type="button"
      data-testid="sidebar-working-directory"
      data-current-source={source}
      // 超长路径的全称（M5 5-8 长文本合格线）—— 展示值本身在左侧省略过
      title={fullPath}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuTestId : undefined}
      onClick={() => (open ? close() : openMenu())}
      onKeyDown={onTriggerKeyDown}
      className={cn(
        "flex w-full shrink-0 items-center gap-2 rounded-md bg-bg-subtle px-2 py-1.5 text-left",
        "text-text-secondary transition-colors duration-150 ease-out",
        "hover:bg-bg-hover hover:text-text-primary active:bg-bg-active",
      )}
    >
      <Icon icon={FolderOpen} />
      <span
        data-testid="sidebar-working-directory-path"
        className="min-w-0 flex-1 truncate font-mono text-xs"
        title={fullPath}
      >
        {label}
      </span>
      <Icon
        icon={ChevronDown}
        size={12}
        className={cn("shrink-0 transition-transform duration-150", open && "rotate-180")}
      />
    </button>
  ) : (
    <Button
      ref={triggerRef}
      variant="secondary"
      size="sm"
      data-testid="settings-change-dir"
      className="shrink-0"
      title={live ? "选择工作目录（下次启动 core 时使用）" : "选择工作目录"}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuTestId : undefined}
      onClick={() => (open ? close() : openMenu())}
      onKeyDown={onTriggerKeyDown}
    >
      更改
    </Button>
  );

  return (
    <>
      {trigger}
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              id={menuTestId}
              data-testid={menuTestId}
              role="menu"
              aria-label="工作目录"
              tabIndex={-1}
              onKeyDown={onMenuKeyDown}
              className={cn(
                "fixed flex flex-col p-1",
                "rounded-lg border border-border-default bg-bg-elevated shadow-lg",
                // 先 opacity-0 量高定位、placed 后再显示：避免首帧闪一下（R3）
                "transition-opacity ease-out",
                placed ? "opacity-100" : "opacity-0",
              )}
              style={{
                left: pos.left,
                top: pos.top,
                width: pos.width,
                zIndex: POPOVER_Z,
                transitionDuration: `${fadeMs}ms`,
              }}
            >
              {/* 首行：当前目录（只读真相）。
                  用 `menuitemradio` + `aria-checked` 表达「当前项」——`aria-checked` 在
                  普通 `menuitem` 上无效（WAI-ARIA 只在 radio/checkbox 类菜单项上支持），
                  读屏会漏报选中态；✓ 图标只是视觉冗余，不是语义本体。 */}
              <button
                type="button"
                role="menuitemradio"
                aria-disabled="true"
                aria-checked="true"
                tabIndex={-1}
                data-testid="sidebar-working-directory-current"
                data-current-source={source}
                className={cn(menuItemClass, "cursor-default text-text-primary")}
                title={fullPath}
              >
                <Icon icon={Check} size={14} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{label}</span>
                {source === "live" ? (
                  // 仅 live 且真拿到了 cwd 才渲染（未拿到时不能声称"运行中"）
                  <span
                    data-testid="sidebar-working-directory-current-badge"
                    className="shrink-0 text-xs text-text-tertiary"
                  >
                    运行中
                  </span>
                ) : null}
              </button>

              {restRecents.length > 0 ? (
                <>
                  <div className="my-1 border-t border-border-subtle" />
                  {restRecents.map((dir, index) => {
                    /*
                     * 「下次启动」只在 live 且**偏好 ≠ 真实目录**时有信息量；
                     * 两者相同时不显示（否则等于告诉用户一句废话）。
                     * 偏好项**不占勾位**：live 下真实目录与偏好是两个概念，
                     * 出现两个 ✓ 会让用户分不清哪个是"现在"，§4.6 明令禁止。
                     */
                    const pending = live && dir === preference && dir !== liveCwd;
                    return (
                      <button
                        key={dir}
                        type="button"
                        role="menuitemradio"
                        aria-checked={false}
                        tabIndex={-1}
                        data-testid={`sidebar-working-directory-recent-${index}`}
                        title={dir}
                        onClick={() => chooseDir(dir)}
                        className={cn(menuItemClass, "text-text-secondary")}
                      >
                        <Icon icon={Check} size={14} className="invisible shrink-0" />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">
                          {truncatePathTail(dir)}
                        </span>
                        {pending ? (
                          <span
                            data-testid={`sidebar-working-directory-recent-${index}-pending`}
                            className="shrink-0 text-xs text-text-tertiary"
                          >
                            下次启动
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </>
              ) : null}

              <div className="my-1 border-t border-border-subtle" />

              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-testid="sidebar-working-directory-default"
                onClick={chooseDefault}
                className={cn(menuItemClass, "text-text-secondary")}
              >
                <Icon icon={FolderOpen} size={14} />
                <span className="min-w-0 flex-1 truncate">使用默认目录</span>
              </button>

              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-testid="sidebar-working-directory-custom"
                onClick={chooseCustom}
                className={cn(menuItemClass, "text-text-secondary")}
              >
                <Icon icon={Plus} size={14} />
                <span className="min-w-0 flex-1 truncate">自定义路径…</span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
