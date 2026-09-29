import { useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import {
  POPOVER_Z,
  TURN_PREVIEW_MAX_HEIGHT,
  TURN_PREVIEW_WIDTH,
  TURN_RAIL_WIDTH,
} from "@/lib/layout";
import { formatFullTimestamp } from "@/lib/format";
import type { RailPreview, RailTurnAnchor } from "@/lib/turn-rail";

/**
 * 会话提问导航刻度栏（TurnRail · task-turn-rail.md）。
 *
 * 结构与职责边界：
 * - 本组件只管「打开后」的渲染：刻度列 + 悬停预览 portal。开合由 MessageList 的
 *   左缘邻近检测驱动（无常驻遮罩条 —— 常驻条会吃掉左缘一条滚轮死区，规格书决策 2），
 *   open=false 返回 null，零布局存在。
 * - 刻度列 absolute inset-y-0 left-0，宽 TURN_RAIL_WIDTH（< 触发带宽 24）：悬停刻度
 *   时鼠标仍在触发区内，展开态天然稳定，不需要额外的宽限联动。
 * - 预览气泡 portal 到 body + fixed（@菜单 / 工作目录菜单同款先例），pointer-events-none
 *   纯展示（决策 5）：鼠标移向它 = 移出刻度 = 收起，无需「移入气泡保持展开」的宽限联动。
 * - 滚轮透传（onWheelScroll）：刻度栏开着时它盖在 24px 内边距带上，滚轮不冒泡给滚动
 *   容器会形成死区 —— 手动透传 deltaY，死区消除。
 * - 键盘：刻度是 button（focus-visible 环走全局 :focus-visible），聚焦期间经
 *   onRailFocusChange(true) 让 MessageList 保持展开（focus-within 语义，规格书决策 7）；
 *   预览是纯展示（aria-hidden），读屏走刻度的 aria-label（含「第 N 问 + 摘要」）。
 */

interface TurnRailProps {
  open: boolean;
  /** 导航锚点（collectRailTurns 的产物；open 时长度 ≥1） */
  anchors: RailTurnAnchor[];
  /** 每个刻度的纵向位置（px，layoutTickTops 的产物，与 anchors 等长） */
  tops: number[];
  /** 预览内容包（MessageList 按 anchors 预算；与 anchors 等长） */
  previews: RailPreview[];
  /** 刻度列根节点 ref（MessageList 用它量高度做均匀槽位映射） */
  railRef: RefObject<HTMLDivElement | null>;
  /** 点击刻度 → 跳转到该次提问（MessageList 实现：测量定位 + 双 rAF 校正 + 落点闪烁） */
  onJump: (anchorIndex: number) => void;
  /** 刻度栏上的滚轮透传（deltaY 直加到滚动容器 scrollTop） */
  onWheelScroll: (deltaY: number) => void;
  /** 刻度栏 focus-within 变化：聚焦期间保持展开（离开后走正常宽限收起） */
  onRailFocusChange: (focused: boolean) => void;
}

/** 预览气泡距视口上/下缘的安全边距（气泡最高 TURN_PREVIEW_MAX_HEIGHT，居中钳制用半高） */
const PREVIEW_VIEWPORT_MARGIN = Math.ceil(TURN_PREVIEW_MAX_HEIGHT / 2) + 16;

export function TurnRail({
  open,
  anchors,
  tops,
  previews,
  railRef,
  onJump,
  onWheelScroll,
  onRailFocusChange,
}: TurnRailProps) {
  /** 悬停中的刻度：index + 预览气泡的 fixed 定位（hover 当场取刻度 rect，不随滚动跟随） */
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);

  if (!open) return null;

  const handleTickEnter = (index: number) => (event: ReactMouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    // 垂直按视口钳制（气泡最高 TURN_PREVIEW_MAX_HEIGHT，超出屏幕的内容靠内部滚动看全）；
    // 水平取刻度右缘 +8（刻度贴左缘，正常不会撞右边界，钳一下防极端窄窗）
    const y = Math.min(
      Math.max(rect.top + rect.height / 2, PREVIEW_VIEWPORT_MARGIN),
      Math.max(PREVIEW_VIEWPORT_MARGIN, window.innerHeight - PREVIEW_VIEWPORT_MARGIN),
    );
    const x = Math.min(rect.right + 8, Math.max(8, window.innerWidth - TURN_PREVIEW_WIDTH - 8));
    setHover({ index, x, y });
  };

  return (
    <>
      <div
        ref={railRef}
        role="navigation"
        aria-label="会话提问导航"
        data-testid="turn-rail"
        data-open="true"
        className="absolute inset-y-0 left-0 z-20"
        style={{ width: TURN_RAIL_WIDTH }}
        onWheel={(event) => onWheelScroll(event.deltaY)}
        onFocusCapture={() => onRailFocusChange(true)}
        onBlurCapture={() => onRailFocusChange(false)}
      >
        {anchors.map((anchor, i) => (
          <button
            key={anchor.turn.key}
            type="button"
            data-testid="turn-tick"
            data-turn-key={anchor.turn.key}
            data-anchor-index={anchor.anchorIndex}
            aria-label={`跳转到第 ${i + 1} 次提问：${(previews[i]?.question ?? "").slice(0, 20)}`}
            onMouseEnter={handleTickEnter(i)}
            onMouseLeave={() => setHover(null)}
            onClick={() => onJump(anchor.anchorIndex)}
            className={cn(
              "absolute left-1/2 rounded-full transition-all duration-150 ease-out",
              hover?.index === i
                ? "h-1 w-3.5 bg-text-secondary"
                : "h-0.5 w-2.5 bg-border-strong hover:bg-text-tertiary",
            )}
            style={{ top: tops[i] ?? 0, transform: "translate(-50%, -50%)" }}
          />
        ))}
      </div>
      {hover
        ? createPortal(
            <div
              data-testid="turn-preview"
              aria-hidden="true"
              className="pointer-events-none fixed overflow-y-auto rounded-lg border border-border-default bg-bg-elevated p-3 shadow-lg"
              style={{
                left: hover.x,
                top: hover.y,
                transform: "translateY(-50%)",
                width: TURN_PREVIEW_WIDTH,
                maxHeight: TURN_PREVIEW_MAX_HEIGHT,
                zIndex: POPOVER_Z,
              }}
            >
              <p
                data-testid="turn-preview-time"
                className="text-xs text-text-tertiary"
                title={
                  previews[hover.index] && previews[hover.index].timestamp > 0
                    ? formatFullTimestamp(previews[hover.index].timestamp)
                    : undefined
                }
              >
                第 {hover.index + 1} 问
                {previews[hover.index]?.time ? ` · ${previews[hover.index].time}` : ""}
              </p>
              <p
                data-testid="turn-preview-question"
                className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-text-primary"
              >
                {previews[hover.index]?.question || "（无文本内容）"}
              </p>
              <div className="mt-2 border-t border-border-subtle pt-2">
                <p
                  data-testid="turn-preview-answer"
                  className="whitespace-pre-wrap break-words text-xs leading-relaxed text-text-secondary"
                >
                  {previews[hover.index]?.answer || "回答生成中…"}
                </p>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
