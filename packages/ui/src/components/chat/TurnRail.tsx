import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { Markdown } from "@/components/common/Markdown";
import {
  POPOVER_Z,
  TURN_PREVIEW_MAX_HEIGHT,
  TURN_PREVIEW_WIDTH,
  TURN_RAIL_CLOSE_GRACE_MS,
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
 * - 预览气泡 portal 到 body + fixed（@菜单 / 工作目录菜单同款先例），可交互
 *   （task-turn-rail-preview-interaction.md）。列走廊粘滞（task-turn-rail-sticky-column.md）：
 *   收起扳机在「离列」（rail onMouseLeave 起 150ms 宽限）——列内上下移动（含刻度间空隙）
 *   气泡保持、跨刻度切换内容、来源刻度保持放大态；移入气泡取消收起、移出气泡立即收；
 *   气泡内滚轮可滚（overscroll-contain 防链动消息流）；悬停期间经 onPreviewOpenChange
 *   让 MessageList 保持刻度栏展开（focus-hold 同款）。
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
  /** 预览开合上报：悬停刻度/气泡期间 true，MessageList 借此保持刻度栏展开（决策 3） */
  onPreviewOpenChange: (previewOpen: boolean) => void;
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
  onPreviewOpenChange,
}: TurnRailProps) {
  /** 悬停中的刻度：index + 预览气泡的 fixed 定位（hover 当场取刻度 rect，不随滚动跟随） */
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  /** 预览收起宽限定时器：刻度 → 气泡的 150ms 移动桥（决策 2） */
  const previewCloseTimer = useRef<number | null>(null);
  /** 开合上报只报翻转：挂载期（hover=null）不上报，防误触发收起宽限 */
  const reportedOpenRef = useRef(false);

  const cancelPreviewClose = useCallback(() => {
    if (previewCloseTimer.current !== null) {
      window.clearTimeout(previewCloseTimer.current);
      previewCloseTimer.current = null;
    }
  }, []);

  // open 翻 false（宽限后收起）即清悬停：防合成事件/异常路径漏 mouseleave 时残留幽灵气泡
  useEffect(() => {
    if (!open) {
      cancelPreviewClose();
      setHover(null);
    }
  }, [open, cancelPreviewClose]);

  // 预览开合翻转上报：悬停刻度或气泡期间让 MessageList 保持刻度栏展开（决策 3）
  const previewOpen = hover !== null;
  useEffect(() => {
    if (previewOpen === reportedOpenRef.current) return;
    reportedOpenRef.current = previewOpen;
    onPreviewOpenChange(previewOpen);
  }, [previewOpen, onPreviewOpenChange]);

  // 卸载清定时器 + 解除 hold（会话切到 0 提问时 TurnRail 整体卸载，hold 不能悬空）
  useEffect(
    () => () => {
      if (previewCloseTimer.current !== null) window.clearTimeout(previewCloseTimer.current);
      if (reportedOpenRef.current) {
        reportedOpenRef.current = false;
        onPreviewOpenChange(false);
      }
    },
    [onPreviewOpenChange],
  );

  if (!open) return null;

  const handleTickEnter = (index: number) => (event: ReactMouseEvent<HTMLElement>) => {
    cancelPreviewClose();
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

  /** 离开整列（走廊粘滞，sticky-column 决策 1）：收起扳机从刻度 mouseleave 上移到 rail
      容器——列内上下移动不清 hover（含刻度间空隙），150ms 宽限同时覆盖「移入气泡」
      与「移出列」两条路；移向别的刻度由 enter 取消并切换内容 */
  const handleColumnLeave = () => {
    cancelPreviewClose();
    previewCloseTimer.current = window.setTimeout(() => {
      previewCloseTimer.current = null;
      setHover(null);
    }, TURN_RAIL_CLOSE_GRACE_MS);
  };

  /** 移入气泡：取消待收定时器，悬停保持 */
  const handlePreviewEnter = () => cancelPreviewClose();

  /** 移出气泡：立即收起 */
  const handlePreviewLeave = () => {
    cancelPreviewClose();
    setHover(null);
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
        onMouseLeave={handleColumnLeave}
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
            onClick={() => onJump(anchor.anchorIndex)}
            className={cn(
              // 命中区加宽（sticky-column 决策 3）：after 伪元素上下各扩 5px、左右各扩 4px
              // （命中 ≈18×12px，列向近无缝），视觉仍是 10×2/20×4 本体，探针几何口径不变
              "absolute left-1/2 rounded-full transition-all duration-150 ease-out",
              "after:absolute after:inset-y-[-5px] after:inset-x-[-4px] after:content-['']",
              hover?.index === i
                ? "h-1 w-5 bg-text-secondary"
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
              onMouseEnter={handlePreviewEnter}
              onMouseLeave={handlePreviewLeave}
              className="pointer-events-auto fixed overscroll-contain overflow-y-auto rounded-lg border border-border-default bg-bg-elevated p-3 shadow-lg"
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
                <div data-testid="turn-preview-answer" className="min-w-0">
                  {previews[hover.index]?.answer ? (
                    // 共享 Markdown 渲染（与消息区同观感 = 预览效果，决策 4）；text-xs 收进紧凑气泡
                    <Markdown content={previews[hover.index].answer} className="text-xs" />
                  ) : (
                    <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-text-secondary">
                      回答生成中…
                    </p>
                  )}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
