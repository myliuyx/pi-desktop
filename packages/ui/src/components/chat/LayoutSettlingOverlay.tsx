/**
 * 首屏 loading 遮罩（2026-10-01 首屏跳变批次）。
 *
 * ## 为什么单独抽成组件
 *
 * 首屏等待分两段，两段都必须显示**同一个** loading 形态：
 *
 * ① `bootstrapping`（chat-store 拉会话清单/最近会话期间）—— 此时 messages 为空，
 *    还没挂 MessageList；
 * ② 数据到了但**布局未稳**（MessageList 内 virtualizer 测量未收敛）—— MessageList 已挂载，
 *    内容在底下测量。
 *
 * 此前两段各画各的：① 用 `NewSessionHero loading`（Sparkles 图标块 + h1 大字），
 * ② 用遮罩里的 Loader2 spinner + 小字 —— **文案相同、视觉规格完全不同**，
 * 接力时观感突变（用户反馈「先大字后小字，看起来很奇怪」）。
 *
 * 抽成一份DOM 与样式 ⇒ 两段形态必然一致，衔接无突变。
 *
 * ## 视觉口径
 *
 * - 背景 `bg-bg-app`：主题色 token，浅色/深色自动跟随，零硬编码调色板；
 * - `Loader2` + `animate-spin`：与 ToolCallCard / ComposerAtMenu / WorkingDirFileTree
 *   同一套 loading 语言；
 * - 文案「正在载入会话…」：与首次进入应用、切换会话两段等待说同一句话。
 */

import { Loader2 } from "lucide-react";
import { Icon } from "@/components/common/icons";
import { cn } from "@/lib/cn";
import { LAYOUT_SETTLE_FADE_MS } from "@/lib/layout";

export interface LayoutSettlingOverlayProps {
  /**
   * 淡出态（收敛后、卸载前）：整体降到 0 透明。
   * 150ms 过渡让「遮罩退场」与「内容入场」自然衔接 —— 瞬切仍是"闪一下"。
   */
  fading?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function LayoutSettlingOverlay({
  fading = false,
  className,
  style,
}: LayoutSettlingOverlayProps) {
  return (
    <div
      data-testid="layout-settling"
      data-phase={fading ? "fading" : "detecting"}
      aria-hidden="true"
      className={cn("absolute inset-0 z-[5] flex items-center justify-center bg-bg-app", className)}
      style={{
        opacity: fading ? 0 : 1,
        transition: `opacity ${LAYOUT_SETTLE_FADE_MS}ms ease-out`,
        // fading 期间不再吃交互：内容已经稳定，该让用户操作了
        pointerEvents: fading ? "none" : "auto",
        ...style,
      }}
    >
      <div
        className="flex flex-col items-center gap-3"
        style={{ opacity: fading ? 0 : 1, transition: `opacity ${LAYOUT_SETTLE_FADE_MS}ms ease-out` }}
      >
        <Icon icon={Loader2} size={20} className="animate-spin text-icon-neutral" />
        <p className="text-sm text-text-secondary">正在载入会话…</p>
      </div>
    </div>
  );
}