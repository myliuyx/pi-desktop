import { useEffect, useState } from "react";
import {
  SHELLS_MODE_HINT_HEIGHT,
  SHELL_PREVIEW_GAP,
} from "@/lib/layout";
import {
  SHELLS_SCREEN_SUBTITLE,
  SHELLS_SCREEN_TITLE,
  SHELL_VARIANTS,
  isOsName,
} from "@/mock/shells";
import { ScreenArea, ScreenBody, ScreenHeader } from "@/components/screens/ScreenLayout";
import { ShellPreview } from "@/components/screens/ShellPreview";
import { WorkbenchScreen } from "@/components/shell/WorkbenchScreen";
import { Sidebar } from "@/components/shell/Sidebar";
import { SidebarFooter } from "@/components/shell/SidebarFooter";
import { WindowShell } from "@/components/shell/WindowShell";

export interface ShellsScreenProps {
  onBackToWorkbench?: () => void;
  onOpenSettings?: () => void;
}

/**
 * 06 屏 · 跨平台窗口壳。
 *
 * 两种模式，由 hash 参数决定（与 `?stress=` / `?preview=` 同理做成**正式能力**，
 * 不让验收依赖手点 —— M2 的教训）：
 *
 * - **并排模式**（无参数，`#/shells`）：三张缩略窗口卡片纵向堆叠。
 *   三卡各自持有自己的 `os`（来自 `SHELL_VARIANTS` 常量表），**不读全局 store** ——
 *   共用 store 会让三端同时变（高危点 4）。
 * - **单壳模式**（`#/shells?os=mac|win|linux`）：渲染一个**全尺寸**的三端壳。
 *   为什么需要它：验收 5-2 要在全尺寸下比较三端内容区首元素坐标（缩放视图下比较
 *   会引入缩放误差）。
 *
 * ★ 并排模式的承载结构：本屏用 `ScreenArea` + 自带侧边栏（与 03/04/05 同构），
 *   因此三张缩略卡片是**卡片内部各自裁剪**的 1440 宽窗口，外层锁死缩放后尺寸，
 *   不会把 06 屏撑出横向滚动条（G6）。
 */
export function ShellsScreen({ onBackToWorkbench, onOpenSettings }: ShellsScreenProps) {
  const [singleOs, setSingleOs] = useState<ReturnType<typeof readOsParam>>(null);

  /*
   * `?os=` 的读取与订阅。
   *
   * ⚠️ 必须订阅 `hashchange`，不能只在挂载时读一次（M5 踩到的真实缺陷）：
   *   `#/shells` → `#/shells?os=mac` 之间只有 hash 的查询串变了，**屏 id 仍是 shells**，
   *   因此 App 的 `setScreen("shells")` 是同一值、React 不会重挂载本组件，
   *   `useEffect([])` 也不再运行 —— 表现为「切 os 参数没反应，一直停在并排模式」
   *   （自查脚本 5-2b 正是这样抓到的）。
   *   订阅 hashchange 后，两种入口（整页加载 / 页内改 hash）都能正确切模式。
   */
  useEffect(() => {
    const sync = () => setSingleOs(readOsParam());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const mode = singleOs ? "single" : "grid";

  return (
    <WindowShell os="mac" onOpenSettings={onOpenSettings}>
      <Sidebar
        activeSessionId="session-0"
        footer={<SidebarFooter onOpenSettings={onOpenSettings} />}
      />
      <ScreenArea data-testid="shells-screen">
        <ScreenHeader
          title={SHELLS_SCREEN_TITLE}
          subtitle={SHELLS_SCREEN_SUBTITLE}
          onBackToWorkbench={onBackToWorkbench}
        />

        {/*
         * 模式提示条：带 data-mode（grid / single），让验收脚本知道当前模式。
         * 不做条件渲染 —— 两种模式都渲染它，只是文案不同，脚本才有一致的落点。
         */}
        <div
          data-testid="shells-mode-hint"
          data-mode={mode}
          className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 text-xs text-text-tertiary"
          style={{ height: SHELLS_MODE_HINT_HEIGHT }}
        >
          {mode === "single" ? (
            <>
              <span>单壳模式</span>
              <span className="font-mono">{`?os=${singleOs}`}</span>
              <span>·全尺寸，用于逐端比对内容区坐标</span>
            </>
          ) : (
            <>
              <span>并排模式</span>
              <span className="font-mono">#/shells</span>
              <span>·三端缩略窗口纵向堆叠，缩放比 0.42</span>
            </>
          )}
        </div>

        {mode === "single" && singleOs ? (
          // 单壳模式：一个全尺寸三端壳，带 shell-single + data-os。
          // 注意这里**不裁剪、不缩放** —— 全尺寸才有意义。
          <div data-testid="shell-single" data-os={singleOs} className="min-h-0 min-w-0 flex-1">
            <WorkbenchScreen os={singleOs} probeOs={singleOs} />
          </div>
        ) : (
          <ScreenBody>
            <div className="flex min-w-0 flex-col" style={{ gap: SHELL_PREVIEW_GAP }}>
              {SHELL_VARIANTS.map((variant) => (
                <ShellPreview key={variant.os} variant={variant} />
              ))}
            </div>
          </ScreenBody>
        )}
      </ScreenArea>
    </WindowShell>
  );
}

/**
 * 解析 `?os=` 参数。
 *
 * ⚠️ 必须读 **hash 里的查询串**（`#/shells?os=win`），而不是 `location.search` ——
 * hash 里问号之后的部分不会进入 `location.search`（M5 踩到的真实缺陷，见 App.tsx
 * 的 `readHashParts` 注释）。这里同时兼容 `location.search`，是为了
 * `?os=win` 写在真查询串上的写法也能工作（两种都支持，容错优先）。
 *
 * 非法值（如 `?os=android`）一律回落到 `null`，即并排模式 —— 与 `readScreen()`
 * 的「非法值回落 workbench」同一种兜底语义：参数坏了不能把整屏搞成空白。
 */
function readOsParam(): "mac" | "win" | "linux" | null {
  if (typeof window === "undefined") return null;
  const rawHash = window.location.hash.replace(/^#\/?/, "");
  const qIndex = rawHash.indexOf("?");
  const hashQuery = new URLSearchParams(qIndex === -1 ? "" : rawHash.slice(qIndex + 1));
  const fromHash = hashQuery.get("os");
  const raw = fromHash ?? new URLSearchParams(window.location.search).get("os");
  return isOsName(raw) ? raw : null;
}
