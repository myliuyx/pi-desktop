import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { Markdown } from "@/components/common/Markdown";
import {
  POPOVER_Z,
  TURN_PREVIEW_MAX_HEIGHT,
  TURN_PREVIEW_WIDTH,
  TURN_RAIL_CLOSE_GRACE_MS,
  TURN_RAIL_CORRIDOR_PAD,
  TURN_RAIL_WIDTH,
} from "@/lib/layout";
import { formatFullTimestamp } from "@/lib/format";
import type { RailPreview, RailTurnAnchor } from "@/lib/turn-rail";

/**
 * 会话提问导航刻度栏（TurnRail · task-turn-rail.md）。
 *
 * 结构与职责边界：
 * - 常显（task-turn-rail-always-visible.md，翻转决策 2）：挂载即渲染——MessageList 保证
 *   仅在「触屏豁免 + 有提问」时挂载，key=sessionScope 切会话重挂；开合状态机（邻近检测/
 *   收起宽限/focus·preview hold）已随常显退役，本组件只管渲染与悬停交互。
 * - 刻度列 absolute inset-y-0 left-0，宽 TURN_RAIL_WIDTH：永久盖住 24px 内边距带，
 *   滚轮透传因此是关键路径（见下）。
 * - 预览气泡 portal 到 body + fixed（@菜单 / 工作目录菜单同款先例），可交互
 *   （task-turn-rail-preview-interaction.md）。列走廊粘滞（task-turn-rail-sticky-column.md）
 *   + 粘滞区定界（task-turn-rail-corridor-bound.md）：气泡收起判定 = 离列或越出刻度簇外扩
 *   TURN_RAIL_CORRIDOR_PAD 的范围（rail onMouseMove/onMouseLeave 起 150ms 宽限）——
 *   簇内上下移动（含刻度间空隙）气泡保持、跨刻度切换内容、来源刻度保持放大态；移入气泡
 *   取消收起、移出气泡立即收；气泡内滚轮可滚（overscroll-contain 防链动消息流）。
 * - 扫动丝滑（task-turn-rail-smooth-sweep.md）：急缓分离——activeIndex（急）驱动高亮、
 *   hover（缓，80ms 节流 latest-wins）驱动气泡内容/位置，扫动中跨刻度只重置节流、
 *   停下才结算；Markdown 按刻度 key 缓存元素，扫回看过的刻度零重新解析。
 * - 滚轮透传（onWheelScroll）：常显条永久盖住 24px 内边距带，滚轮不冒泡给滚动容器会
 *   形成永久死区 —— 手动透传 deltaY，死区消除。
 * - 键盘：刻度是 button（focus-visible 环走全局 :focus-visible）；
 *   预览是纯展示（aria-hidden），读屏走刻度的 aria-label（含「第 N 问 + 摘要」）。
 */

interface TurnRailProps {
  /** 导航锚点（collectRailTurns 的产物；挂载即长度 ≥1——无提问/触屏由 MessageList 不渲染） */
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
}

/** 预览气泡距视口上/下缘的安全边距（气泡最高 TURN_PREVIEW_MAX_HEIGHT，居中钳制用半高） */
const PREVIEW_VIEWPORT_MARGIN = Math.ceil(TURN_PREVIEW_MAX_HEIGHT / 2) + 16;

/** 扫动节流（ms）—— 气泡内容/位置在「停 ≥ 此值」才结算（task-turn-rail-smooth-sweep.md 决策 1） */
const TURN_PREVIEW_SWEEP_MS = 80;

export function TurnRail({
  anchors,
  tops,
  previews,
  railRef,
  onJump,
  onWheelScroll,
}: TurnRailProps) {
  /** 急通道：当前悬停刻度下标——驱动高亮/放大与 hold 上报（渲染极轻，跟手丝滑） */
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  /** 缓通道：气泡（内容+位置）——80ms 节流 latest-wins，扫动中每次跨刻度重置，停下才结算
      （smooth-sweep 决策 1：廉价的高亮与昂贵的 Markdown 解析拆进两个渲染通道） */
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  /** 预览收起宽限定时器：刻度 → 气泡的 150ms 移动桥（决策 2） */
  const previewCloseTimer = useRef<number | null>(null);
  /** 扫动节流定时器 */
  const sweepTimer = useRef<number | null>(null);
  /** 节流窗内最后悬停的快照：到期用它的 index/rect 结算气泡 */
  const pendingHover = useRef<{ index: number; x: number; y: number } | null>(null);
  /** Markdown 元素缓存（smooth-sweep 决策 4）：key=turn.key、value={answer, el}——
      同内容复用同一 element 对象 → React 对子树 bail out，扫回看过的刻度零 parse */
  const mdCacheRef = useRef(new Map<string, { answer: string; el: ReactElement }>());

  const cancelPreviewClose = useCallback(() => {
    if (previewCloseTimer.current !== null) {
      window.clearTimeout(previewCloseTimer.current);
      previewCloseTimer.current = null;
    }
  }, []);

  const cancelSweep = useCallback(() => {
    if (sweepTimer.current !== null) {
      window.clearTimeout(sweepTimer.current);
      sweepTimer.current = null;
    }
    pendingHover.current = null;
  }, []);

  // 卸载清定时器（会话切换经 MessageList 的 key=sessionScope 重挂，state 随卸载销毁）
  useEffect(
    () => () => {
      if (previewCloseTimer.current !== null) window.clearTimeout(previewCloseTimer.current);
      if (sweepTimer.current !== null) window.clearTimeout(sweepTimer.current);
    },
    [],
  );

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
    // 急：高亮立即跟手；缓：快照进节流窗——每次跨刻度重置，停 ≥ TURN_PREVIEW_SWEEP_MS
    // 才结算（连续扫过的中间刻度不渲染，卡顿源被整体跳过）
    setActiveIndex(index);
    pendingHover.current = { index, x, y };
    if (sweepTimer.current !== null) window.clearTimeout(sweepTimer.current);
    sweepTimer.current = window.setTimeout(() => {
      sweepTimer.current = null;
      if (pendingHover.current) {
        setHover(pendingHover.current);
        pendingHover.current = null;
      }
    }, TURN_PREVIEW_SWEEP_MS);
  };

  /** 起收起宽限（走廊定界，corridor-bound 决策 3）：「已挂不重排」——首次越界/离列起
      150ms 钟，界外反复移动不重置；钟未到回界内即由 cancelPreviewClose 撤销 */
  const schedulePreviewClose = () => {
    if (previewCloseTimer.current !== null) return;
    previewCloseTimer.current = window.setTimeout(() => {
      previewCloseTimer.current = null;
      setActiveIndex(null);
      setHover(null);
      cancelSweep();
    }, TURN_RAIL_CLOSE_GRACE_MS);
  };

  /** 列内移动（走廊定界，corridor-bound 决策 2）：粘滞区 = 刻度簇范围外扩
      TURN_RAIL_CORRIDOR_PAD——界内取消待收（跨刻度/空隙照常粘滞），越界起收起宽限
      （首/末刻度外侧的空列段不再常驻气泡） */
  const handleColumnMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    if (!rail || tops.length === 0) return;
    const y = event.clientY - rail.getBoundingClientRect().top;
    const corridorTop = Math.min(...tops) - TURN_RAIL_CORRIDOR_PAD;
    const corridorBottom = Math.max(...tops) + TURN_RAIL_CORRIDOR_PAD;
    if (y >= corridorTop && y <= corridorBottom) cancelPreviewClose();
    else schedulePreviewClose();
  };

  /** 移入气泡：取消收起；节流未结算则立即结算（鼠标已到气泡旁，不再有扫动） */
  const handlePreviewEnter = () => {
    cancelPreviewClose();
    if (pendingHover.current) {
      const snapshot = pendingHover.current;
      cancelSweep();
      setHover(snapshot);
    }
  };

  /** 移出气泡：立即收起 */
  const handlePreviewLeave = () => {
    cancelPreviewClose();
    cancelSweep();
    setActiveIndex(null);
    setHover(null);
  };

  /** Markdown 元素缓存取用：同 key 同内容返回同一 element（React 子树 bail out），
      内容已流式更新则重建 */
  const getAnswerElement = (index: number): ReactElement | null => {
    const answer = previews[index]?.answer;
    if (!answer) return null;
    const key = anchors[index]?.turn.key ?? `i${index}`;
    const hit = mdCacheRef.current.get(key);
    if (hit && hit.answer === answer) return hit.el;
    if (mdCacheRef.current.size > 60) mdCacheRef.current.clear();
    const el = <Markdown content={answer} className="text-xs" />;
    mdCacheRef.current.set(key, { answer, el });
    return el;
  };

  return (
    <>
      <div
        ref={railRef}
        role="navigation"
        aria-label="会话提问导航"
        data-testid="turn-rail"
        className="absolute inset-y-0 left-0 z-20"
        style={{ width: TURN_RAIL_WIDTH }}
        onWheel={(event) => onWheelScroll(event.deltaY)}
        onMouseMove={handleColumnMove}
        onMouseLeave={schedulePreviewClose}
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
              // cursor-default：显式反例全局 button{cursor:pointer}——整列统一箭头（2026-09-29 用户裁决）
              "absolute left-1/2 cursor-default rounded-full transition-all duration-150 ease-out",
              "after:absolute after:inset-y-[-5px] after:inset-x-[-4px] after:content-['']",
              activeIndex === i
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
                  {getAnswerElement(hover.index) ?? (
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
