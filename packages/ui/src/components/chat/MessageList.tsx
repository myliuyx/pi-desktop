import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type RefObject,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/common/icons";
import { ArrowDown, MessageSquare, Wrench } from "lucide-react";
import {
  AUTO_SCROLL_THRESHOLD,
  LAYOUT_SETTLE_FADE_MS,
  LAYOUT_SETTLE_STABLE_FRAMES,
  LAYOUT_SETTLE_TIMEOUT_MS,
  MESSAGE_GAP,
  MESSAGE_LIST_PADDING,
  MESSAGE_MAX_WIDTH,
  TURN_FLASH_MS,
  TURN_PREVIEW_ANSWER_CHARS,
  TURN_PREVIEW_QUESTION_CHARS,
  TURN_RAIL_TICK_HALF,
  TURN_RAIL_TICK_PITCH,
} from "@/lib/layout";
import type { Block, Message, TerminalBlock } from "@/mock/types";
import { COMPOSER_MODELS } from "@/mock/composer";
import { useModelsStore } from "@/store/models-store";
import { useChatStore } from "@/store/chat-store";
import { useUiStore } from "@/store/ui-store";
import { formatMessageTime, speedTone, type SpeedTone } from "@/lib/format";
import { toolArgsPreview } from "@/lib/tool-preview";
import { buildTurnIndex, type TurnMembership } from "@/lib/turns";
import { collectTurnFiles, type TurnFileEntry } from "@/lib/turn-files";
import {
  buildPreviewTexts,
  collectRailTurns,
  layoutTickTops,
  type RailPreview,
} from "@/lib/turn-rail";
import { MessageBubble } from "./MessageBubble";
import { ThinkingCard } from "./ThinkingCard";
import { ThinkingPending } from "./ThinkingPending";
import { MessageFooter } from "./MessageFooter";
import { PlanCard } from "./PlanCard";
import { TerminalCard } from "./TerminalCard";
import { ToolCallCard } from "./ToolCallCard";
import { ApprovalCard } from "./ApprovalCard";
import { ProcessGroupRow } from "./ProcessGroupRow";
import { MessageErrorCard } from "./MessageErrorCard";
import { TurnFileChips } from "./TurnFileChips";
import { TurnRail } from "./TurnRail";
import { ImagePreviewDialog } from "./ImagePreviewDialog";
import { LayoutSettlingOverlay } from "./LayoutSettlingOverlay";
import { getLiveConfig } from "@/lib/feature-flags";
import { imageThumbnailAlt, imageUrl } from "@/lib/image-src";
import {
  createHeightMemory,
  rememberMessageHeight,
  resolveRowHeight,
  type HeightMemory,
} from "@/lib/message-height";

export interface MessageListProps extends HTMLAttributes<HTMLDivElement> {
  messages: Message[];
  /** 助手是否正在流式输出（与 pendingSince 一起决定是否渲染等待占位行，§2.2） */
  streaming?: boolean;
  /**
   * 下一轮模型响应「已请求、尚未开始流式」（task-waiting-row-turn-start.md F1）：
   * 多轮 agent loop 的轮间空窗（上一轮已完结、下一轮请求已发出）占位行据此照常显示 ——
   * 仅 live 链路为 true，mock 恒 false（缺省值同）。
   */
  awaitingModel?: boolean;
  /** 本次请求的发起时刻（epoch ms）；null 表示非等待期。占位行的计时起点。 */
  pendingSince?: number | null;
  /**
   * 已完结可折叠轮次键（task-process-collapse.md；chat-store settledTurnKeys 同路透传）。
   * 键在集合里 = 该轮已完结且可折叠 → 过程块收进「处理详情」折叠行。
   */
  settledTurnKeys?: ReadonlySet<string>;
  /** 轮次键的会话作用域（liveSessionId ?? "draft"），展开态跨会话不串 */
  sessionScope?: string;
  /**
   * 首屏布局已稳定（总高不再变化且已贴底）的通知（2026-10-01 首屏跳变批次）。
   *
   * 触发时机：virtualizer 总高连续 LAYOUT_SETTLE_STABLE_FRAMES 帧不再变化。
   * 仅**首屏**触发一次（settledRef 自锁），后续滚动不重复通知。
   */
  onLayoutSettled?: () => void;
  /**
   * 首屏稳定判定超时（ms）—— 超过则强制上报（兜底，防高度永不收敛时永久遮罩）。
   * 默认 LAYOUT_SETTLE_TIMEOUT_MS（5s）；可传小值供验收脚本压缩等待。
   */
  layoutSettleTimeoutMs?: number;
}

  /** settledTurnKeys 的缺省引用（模块级常量，保证默认值引用稳定） */
const EMPTY_SETTLED_KEYS: ReadonlySet<string> = new Set();

/**
 * MessageItem 的轮次渲染信息（由 MessageList 从 buildTurnIndex + settledTurnKeys +
 * 本地展开态推出；undefined = 与折叠无关的行，走原路径）。
 */
interface MessageTurnInfo {
  isTail: boolean;
  isHead: boolean;
  /** 该轮当前收起中（已完结可折叠且未被手动展开） */
  collapsed: boolean;
  /**
   * 折叠行宿主（2026-09-27 二次裁决）：**收起态挂尾条**（紧贴最终答复上方）、
   * **展开态挂首条**（整组过程顶部）—— 两种状态都渲染在所在消息的模型标签之前。
   */
  hostsToggle: boolean;
  messageCount: number;
  toolCallCount: number;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * 是否存在「用户看得见」的内容块（F1 §2.2）。
 * 空文本块（首字未到的流式占位）不算可见 —— 等待占位行据此判定何时让位给真实内容。
 */
function hasRenderableContent(blocks: Block[]): boolean {
  return blocks.some((block) => block.type !== "text" || block.content.trim() !== "");
}

/**
 * 是否贴底。阈值取自 layout.ts —— 放模块级（而非组件内）是为了能被 useCallback([]) 安全引用，
 * 不随每次渲染重建。
 */
function measureAtBottom(el: HTMLDivElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= AUTO_SCROLL_THRESHOLD;
}

/**
 * 消息流（虚拟滚动 + 自动滚底 + 上滚停止）。
 *
 * ★ 冻结契约：根节点 `data-testid="message-list"` 是**唯一的滚动容器**；
 * 还带 `data-total-count`（总数，验收 2-2 用来算「渲染数 ≪ 总数」）与
 * `data-at-bottom`（反映真实贴底状态，验收 2-5 直接读它）。
 *
 * 虚拟滚动的关键（task-M2 3.4）：消息高度动态（markdown / 代码块 / 终端输出都会变），
 * 必须用 `virtualizer.measureElement` 动态测量，不能只靠 `estimateSize`。
 * 每个 item 挂 `ref={virtualizer.measureElement}` + `data-index`。代码块异步高亮后
 * 高度变化，measureElement 内置的 ResizeObserver 会自动重新测量（不要自己再包一层）。
 *
 * 自动滚底（task-M2 3.5）：`atBottomRef` 为真时才把视口拽到底部；用户上滚后
 * `atBottomRef` 变假，新消息到达不再强制滚底。scroll-to-bottom 按钮仅在非底部时出现。
 *
 * 内容列居中（2026-09-22 裁决）：内层虚拟容器带 `maxWidth: MESSAGE_MAX_WIDTH`
 * + 左右 auto 外边距，与滚动容器的 24px 内边距构成 720px 内容列并在内容区内居中；
 * 虚拟行 absolute `width:100%` 以该列为基准自动跟随。
 * ★ Composer/工具条**不参与居中**（2026-09-22 二次裁决：输入区还原全宽原样）——
 *   它们在 flex 纵向容器里，交叉轴 auto margin 会禁用 stretch、令盒子收缩成
 *   fit-content（实测被挤成 ~180px 内容宽），全宽还原后与本列各自独立。
 */
export const MessageList = forwardRef<HTMLDivElement, MessageListProps>(function MessageList(
  {
    messages,
    streaming = false,
    awaitingModel = false,
    pendingSince = null,
    settledTurnKeys = EMPTY_SETTLED_KEYS,
    sessionScope = "draft",
    onLayoutSettled,
    layoutSettleTimeoutMs = LAYOUT_SETTLE_TIMEOUT_MS,
    className,
    ...rest
  },
  ref,
) {
  const parentRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  /*
   * F1 · 等待占位行（§2.2 + task-waiting-row-turn-start.md）：streaming 中且 pendingSince
   * 非空时，三种形态在虚拟列表末尾追加一行「等待模型回复」——
   * ① awaitingModel：第 2+ 轮的轮间空窗（上一轮已完结、下一轮请求已发出，实测 TTFB
   *    6.5s–39s+，turn_start 置位 → 本轮 assistant message_start 清除）；
   * ② 最后一条是 user（首轮请求已发出、回复未至）；
   * ③ 最后一条是尚无可见内容的 assistant（message_start 已到、首字未到 —— 含 awaitingModel
   *    清除后与空壳隐藏衔接的短暂窗口，视觉不跳变）。
   * 占位作为普通虚拟行参与 measureElement / 自动滚底，零新增滚动逻辑；
   * 首个可见块（text / thinking / tool_call 任一）到达后条件自然失效，由真实内容顶替。
   */
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const pending =
    streaming &&
    pendingSince !== null &&
    lastMessage !== undefined &&
    (awaitingModel ||
      lastMessage.role === "user" ||
      (lastMessage.role === "assistant" && !hasRenderableContent(lastMessage.blocks)));

  /*
   * 处理详情折叠（task-process-collapse.md）：分轮归属每渲染期重算（useMemo 记忆），
   * 已完结且可折叠的轮次把过程块收进「处理详情」折叠行。settledTurnKeys 仅 live 写入
   * （mock 恒空 → 演示/验收面零变化）；展开态是本地视图状态（决策 6：不持久化、
   * 不进 store），键用 TurnGroup.key（带会话作用域，切会话不串）。
   */
  const turnIndex = useMemo(() => buildTurnIndex(messages, sessionScope), [messages, sessionScope]);
  const [expandedTurns, setExpandedTurns] = useState<Record<string, boolean>>({});
  const toggleTurn = useCallback((key: string) => {
    setExpandedTurns((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }));
  }, []);

  /** 由轮次归属 + settled 标记 + 手动展开态推出 MessageItem 的渲染信息 */
  const turnInfoOf = useCallback(
    (membership: TurnMembership): MessageTurnInfo => {
      const { turn, isTail, isHead } = membership;
      const showToggle =
        settledTurnKeys.has(turn.key) && turn.collapsible && !turn.hasUnresolvedApproval;
      const collapsed = showToggle && !(expandedTurns[turn.key] ?? false);
      return {
        isTail,
        isHead,
        collapsed,
        hostsToggle: showToggle && (collapsed ? isTail : isHead),
        messageCount: turn.messageCount,
        toolCallCount: turn.toolCallCount,
        expanded: showToggle && !collapsed,
        onToggle: () => toggleTurn(turn.key),
      };
    },
    [settledTurnKeys, expandedTurns, toggleTurn],
  );

  /*
   * 轮次改动文件表（task-turn-file-chips.md）：每个 turn 推导一次「写成功的文件清单」，
   * 只在尾条渲染 chips 行。与 turnIndex 同依赖（messages/sessionScope）+ liveCwd
   * （相对路径绝对化与展示口径）——lib/turn-files.ts 纯函数，空清单不进表（不渲染行）。
   */
  const liveCwd = useChatStore((state) => state.liveCwd);
  const turnFilesByKey = useMemo(() => {
    const map = new Map<string, TurnFileEntry[]>();
    const seen = new Set<string>();
    for (const { turn } of turnIndex.values()) {
      if (seen.has(turn.key)) continue;
      seen.add(turn.key);
      const files = collectTurnFiles(messages, turn, liveCwd);
      if (files.length > 0) map.set(turn.key, files);
    }
    return map;
  }, [turnIndex, messages, liveCwd]);

  /** chip 点击 → 右侧预览打开该文件（WorkingDirFileTree openFile 同款两行模式） */
  const openFileInPreview = useCallback((path: string) => {
    const ui = useUiStore.getState();
    ui.setPreviewFilePath(path);
    if (ui.previewCollapsed) ui.togglePreview();
  }, []);
  /**
   * 是否处于「我们主动贴底」的过程中。
   *
   * 为什么需要这个标志：列表高度是**动态测量**出来的（markdown / 代码块 / 终端输出都会变），
   * 程序化滚到底之后虚拟列表还会继续长高，于是紧接着触发的 scroll 事件会算出一个
   * 「没贴底」的中间态。若此时直接把 atBottom 翻成 false，下面那个 ResizeObserver
   * 就再也不会纠偏（它只在 atBottomRef 为真时补滚），最终表现为
   * **「点了回到底部，却还差一截」**（实测差 134px，验收 2-5d 抓到）。
   *
   * 所以：贴底过程中出现的非贴底中间态 → 继续补滚并保持状态；
   * 只有真实用户交互（滚轮 / 触摸 / 键盘）才允许退出「自动贴底」。
   */
  const pinningRef = useRef(false);
  const [atBottom, setAtBottom] = useState(true);

  /*
   * 行高估算 + 实测记忆化（2026-10-01 上滚回弹根治 · 第 2 层）。
   *
   * ## 为什么不能只靠 measureElement
   *
   * 虚拟滚动对**未渲染行**只能用 estimateSize，滚动到才由 measureElement 回填
   * 真实高度⇒ 总高在“向上滚进新区域”时缩水，scrollTop 被浏览器连带拽动 = 回弹。
   * 旧实现固定 `estimateSize: () => 140`：实测真实行高 stress 短句97/99、
   * live 长回复 342/464 —— 每个方向都偏，短句档每次滚动多退约 249px。
   *
   * ## 两个 hook
   *
   * ① `heightMemory`（实测值，messageId 键）：消息只增不改 ⇒ 同一条高度恒定，
   *    回看已浏览区域**零误差零跳变** —— 这是根治的主路径。
   * ② `estimateSizeOf`（估算值兜底）：未测量过的行按内容估算（lib/message-height.ts，
   *    常量全部实测反推），把首次进入的误差从固定 43~324px 压到个位数。
   *
   * ⚠️ `estimateSizeOf` 用 ref 读最新的 messages（闭包稳定）：virtualizer 内部按
   * 函数身份记忆 measurements，若每次渲染新建函数会导致整表缓存失效、滚动位置跳。
   * 同 `measureAtBottom` 的模块级常量纪律。
   */
  const heightMemoryRef = useRef<HeightMemory>(createHeightMemory());
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const estimateSizeOf = useCallback((index: number) => {
    return resolveRowHeight(heightMemoryRef.current, messagesRef.current[index]);
  }, []);

  const virtualizer = useVirtualizer({
    // 占位行计入虚拟行数（消息数 + 1），testid 用 thinking-indicator，不占 message-item 名额
    count: messages.length + (pending ? 1 : 0),
    getScrollElement: () => parentRef.current,
    // 未渲染行的行高：实测优先，否则按内容估算（见上方注释）
    estimateSize: estimateSizeOf,
    overscan: 6,
  });

  /*
   * 实测高度记忆的写入点（与 estimateSizeOf 成对）。
   *
   * 包装 `virtualizer.measureElement`：调用原函数（保留它内置的 ResizeObserver ——
   * 代码块异步高亮后的高度变化靠它重新测量，**不要自己再包一层 RO**），再把本次
   * 测到的真实高度按 messageId 记进 heightMemory。
   *
   * 口径一致性（关键）：这里读的 getBoundingClientRect().height 与 virtualizer 自己
   * 测量用的是同一盒模型（含 MESSAGE_GAP 的 paddingBottom）—— 两边口径不一致的话，
   * 记忆值与实测量对不上，记忆化反而会引入新的偏差。
   *
   * 用 messageId 而非索引作键：切会话后索引会指向别的消息（virtual-core 默认
   * getItemKey(i) 正是跨会话缓存污染的来源）。
   */
  const measureRow = useCallback(
    (node: HTMLElement | null) => {
      virtualizer.measureElement(node);
      if (!node) return;
      const message = messagesRef.current[Number(node.dataset.index)];
      if (!message) return;
      const height = node.getBoundingClientRect().height;
      if (height > 0) rememberMessageHeight(heightMemoryRef.current, message.id, height);
    },
    [virtualizer],
  );

  const scrollToBottom = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    pinningRef.current = true;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
    // 再补两帧：动态测量会在第一次滚动之后继续改变高度，只滚一次收不到底
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const node = parentRef.current;
        if (!node) return;
        node.scrollTop = node.scrollHeight;
        const bottom = measureAtBottom(node);
        atBottomRef.current = bottom;
        setAtBottom(bottom);
        pinningRef.current = false;
      }),
    );
  }, []);

  /*
   * 会话提问导航刻度栏（task-turn-rail.md）：锚点 / 预览随 messages 记忆。
   * 常显（task-turn-rail-always-visible.md，2026-09-29 用户裁决翻转决策 2）：触屏豁免 +
   * 有提问即恒渲染——邻近检测 / 收起宽限 / focus·preview hold 的开合状态机整体退役；
   * 常显条永久盖住 24px 内边距带，滚轮经 TurnRail 透传兜底（由「开着时兜底」升级为关键路径）。
   */
  const railRef = useRef<HTMLDivElement | null>(null);
  const [railHeight, setRailHeight] = useState(0);
  const [flashIndex, setFlashIndex] = useState<number | null>(null);
  const flashTimer = useRef<number | null>(null);
  // hover:none（触屏）整体不启用（规格书决策 8）；SSR / 无 window 环境一并豁免
  const [hoverable] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(hover: hover)").matches === true,
  );

  const railAnchors = useMemo(
    () => collectRailTurns(messages, sessionScope),
    [messages, sessionScope],
  );
  const railPreviews = useMemo<RailPreview[]>(
    () =>
      railAnchors.map(({ turn }) => {
        const anchor = messages[turn.startIndex];
        const texts = buildPreviewTexts(
          anchor,
          messages[turn.tailIndex],
          TURN_PREVIEW_QUESTION_CHARS,
          TURN_PREVIEW_ANSWER_CHARS,
        );
        return {
          timestamp: anchor?.timestamp ?? 0,
          time: formatMessageTime(anchor?.timestamp ?? 0, Date.now()),
          ...texts,
        };
      }),
    [railAnchors, messages],
  );

  const handleRailWheel = useCallback((deltaY: number) => {
    const el = parentRef.current;
    if (el) el.scrollTop += deltaY;
  }, []);

  /** 刻度栏高度（槽位居中映射的栏高）；常显挂 ResizeObserver 跟随窗口/布局变化，
      依赖锚点数：0 → N 的翻转即 TurnRail 挂载点 */
  useLayoutEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const update = () => setRailHeight(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hoverable, railAnchors.length]);

  /**
   * 跳转到某次提问（决策 6）：测量定位 → 双 rAF 读行 DOM 校正（scrollToBottom 同款
   * 两帧节奏，消化动态测量误差）。**不置 pinningRef** —— scroll 事件里 atBottom 诚实
   * 翻转，「回到底部」按钮按既有语义自然出现。落点闪烁 TURN_FLASH_MS 给「你在这里」锚点。
   */
  const jumpToMessage = useCallback(
    (anchorIndex: number) => {
      const el = parentRef.current;
      if (!el) return;
      const measurement = virtualizer.measurementsCache[anchorIndex];
      if (!measurement) return;
      pinningRef.current = false;
      // 行文档位置 = 内边距(24) + start；「视口顶 + 24px 呼吸位」⇔ scrollTop = start
      // （规格书修正：先按 start 落、校正一步到位，免 start+PADDING 再回调的可见跳动）
      const maxTop = Math.max(el.scrollHeight - el.clientHeight, 0);
      el.scrollTop = Math.min(Math.max(measurement.start, 0), maxTop);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const node = parentRef.current;
          const row = innerRef.current?.querySelector<HTMLElement>(
            `[data-index="${anchorIndex}"]`,
          );
          if (!node || !row) return;
          const delta =
            row.getBoundingClientRect().top - node.getBoundingClientRect().top - MESSAGE_LIST_PADDING;
          if (delta !== 0) {
            const top = Math.max(node.scrollHeight - node.clientHeight, 0);
            node.scrollTop = Math.min(Math.max(node.scrollTop + delta, 0), top);
          }
        }),
      );
      setFlashIndex(anchorIndex);
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => {
        flashTimer.current = null;
        setFlashIndex(null);
      }, TURN_FLASH_MS);
    },
    [virtualizer],
  );

  // 卸载清计时器（StrictMode 双挂载同样安全）
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  // 滚动时更新贴底判定（阈值取自 layout.ts，避免硬编码）
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      const bottom = measureAtBottom(el);
      if (!bottom && pinningRef.current) {
        // 程序化贴底过程中的中间态：继续补滚，不翻状态（见 pinningRef 注释）
        el.scrollTop = el.scrollHeight;
        return;
      }
      atBottomRef.current = bottom;
      setAtBottom(bottom);
    };
    // 真实用户交互才允许退出自动贴底
    const onUserIntent = () => {
      pinningRef.current = false;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onUserIntent, { passive: true });
    el.addEventListener("touchstart", onUserIntent, { passive: true });
    el.addEventListener("keydown", onUserIntent);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onUserIntent);
      el.removeEventListener("touchstart", onUserIntent);
      el.removeEventListener("keydown", onUserIntent);
    };
  }, []);

  // 内容（含异步高亮后的代码块）高度变化时，若仍在底部则跟随到底
  useEffect(() => {
    const inner = innerRef.current;
    const scrollEl = parentRef.current;
    if (!inner || !scrollEl) return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) scrollEl.scrollTop = scrollEl.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  // 新消息/流式增量到达时：贴底才滚到底（用户上滚后停止，这是 2-5 的关键反例）
  useEffect(() => {
    if (atBottomRef.current) {
      requestAnimationFrame(() => requestAnimationFrame(scrollToBottom));
    }
  }, [messages, scrollToBottom]);

  /*
   * 发送即回底（2026-10-01 批次）：消费 ui-store 的回底请求。
   *
   * ## 为什么必须有这个分支
   *
   * 上面那个 effect 的开关是 `atBottomRef.current` —— 用户上滚后它变 false，
   * 于是「本轮及之后所有增量都不再自动贴底」（2-5c 反例契约，**刻意保留**）。
   * 但它也意味着：用户上滚回看历史后重新提问，视口永远回不到最新位置。
   * 老逻辑没有区分「被动收到增量」与「用户主动重新提问」的能力，这个请求位
   * 就是那条缺失的信号（发起点见 Composer.handleSend）。
   *
   * ## 为什么只调既有 scrollToBottom 就够（零新增滚动逻辑）
   *
   * scrollToBottom 自己会：置 `pinningRef = true` → 双 rAF 补滚（消化动态测量的
   * 高度增长）→ 末帧实测 atBottom 回写。**atBottomRef 一旦被置回 true，
   * 后续整轮流式增量就由上面那个既有 effect 自然持续贴底**（正是 2-5e 的路径），
   * 无需在本处重复实现一遍跟随逻辑。
   *
   * 为什么还要显式再置一次 pinningRef：scrollToBottom 内部会置，但它是
   * useCallback(闭包)，本 effect 若在它执行前就依赖 pinning 语义，顺序不稳；
   * 显式前置一次保证「进入补滚前不退出自动贴底」。
   *
   * 双 rAF 与既有两条路径同节奏（等 React 提交完新消息行、且 virtualizer 完成
   * 一轮测量），避免滚到底后又被测量误差顶回。
   *
   * 挂载时机天然安全：草稿态（NewSessionHero 顶替 MessageList）下本组件不挂载，
   * 请求无人消费 —— 但那本来就没有消息列表可滚，无副作用（不做特判，YAGNI）。
   */
  const composerScrollToBottomRequest = useUiStore((s) => s.composerScrollToBottomRequest);
  useEffect(() => {
    if (!composerScrollToBottomRequest) return;
    pinningRef.current = true;
    requestAnimationFrame(() => requestAnimationFrame(scrollToBottom));
  }, [composerScrollToBottomRequest, scrollToBottom]);

  // 合并外部 ref 与内部 parentRef（外部通常不传 ref，这里仅保证契约完整）
  const setScrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      parentRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as RefObject<HTMLDivElement | null>).current = node;
    },
    [ref],
  );

  const items = virtualizer.getVirtualItems();
  const isEmpty = messages.length === 0;

  /*
   * 首屏布局稳定检测（2026-10-01 首屏跳变批次）。
   *
   * 缺陷实测（248 条真实会话）：首帧只有 ~34 行被估算，totalSize 是估算堆出来的；
   * 随后测量回填使总高缩水，已写入的 scrollTop 被连带拽走 —— 实测内容出现后
   * 194ms 内被拽 3876px（用户观感：内容出现 → 画面剧烈上跳 → 才稳定）。
   *
   * 判据 = **总高连续 N 帧不再变化**（LAYOUT_SETTLE_STABLE_FRAMES）。不用固定延迟：
   * 消息数与机器速度差异极大（实测 5 条消息首帧即稳定、248 条要 ~200ms），
   * 猜延迟要么慢要么漏。
   *
   * 触发后仅回调一次（settledRef 自锁）：遮罩撤除后不该因后续滚动再被遮挡。
   * 超时兜底（LAYOUT_SETTLE_TIMEOUT_MS）：总高永不收敛时强制放行 ——
   * 永久遮罩 = 永久不可用，比多等一会儿严重得多。
   */
  const settledRef = useRef(false);
  /*
   * 遮罩状态机（三态）：`detecting`（检测中，spinner 可见）→ `fading`（150ms
   * 淡出）→ `settled`（遮罩卸载）。
   *
   * ⚠️ 初值必须是「检测中」而不是「已稳定」（实测踩坑）：live 首屏 bootstrapping 转
   * false 前渲染的是 hero，MessageList 是**那一刻才首次挂载**的—— 若初值写成
   * 「已稳定」，遮罩从第一帧就不显示，实测 live 首屏遮罩零帧可见，跳动照旧。
   */
  const [settlePhase, setSettlePhase] = useState<"detecting" | "fading" | "settled">("detecting");
  const stableFrameRef = useRef(0);
  const lastTotalRef = useRef(-1);

  /**
   * 布局已收敛：进入淡出态，LAYOUT_SETTLE_FADE_MS 后卸载遮罩。
   *
   * settledRef 在此刻上锁（而不是等遮罩真的卸载）——检测循环据此立即停止，
   * 避免淡出期间又跑一轮无意义的 rAF。
   *
   * ⚠️ 卸载走 setTimeout 兜底而非 CSS `onTransitionEnd`：transitionend 在元素
   * 没有实际视觉变化时**不触发**（prefers-reduced-motion 或背景色相同即触发不了），
   * 遮罩会永久残留 —— 比原缺陷更糟。
   */
  const reportSettled = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    setSettlePhase("fading");
    onLayoutSettled?.();
  }, [onLayoutSettled]);

  // 淡出定时器：fading → settled（卸载遮罩）。仅在 fading 态存在，卸载即清。
  useEffect(() => {
    if (settlePhase !== "fading") return;
    const timer = window.setTimeout(() => setSettlePhase("settled"), LAYOUT_SETTLE_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [settlePhase]);

  useEffect(() => {
    // 遮罩自管 ⇒ 即便无人传 onLayoutSettled 也必须跑（它只是可选通知）
    if (settlePhase !== "detecting" || isEmpty) return;
    let raf = 0;
    const started = performance.now();

    const check = () => {
      if (settledRef.current) return;
      const total = virtualizer.getTotalSize();

      /*
       * 判据 = 「虚拟器已滚到列表末尾」**且**「总高连续 N 帧不变」。
       *
       * ⚠️ 两轮实测踩坑的教训：
       * ① 只看「总高连续 N 帧不变」不够—— live 首屏 MessageList 挂载时 messages
       *   已完整，estimateSizeOf 立即算出**最终**总高，首帧起就连续不变 ⇒ 第一帧
       *    直接判过，遮罩零帧可见（实测 overlay 恒 false）。「总高不变」在这里
       *   是**恒真条件**，不是收敛信号。
       * ② 「末尾条件」用virtualItems 的 last.end 是对的：last.end ≥ scrollHeight − clientHeight
       *    意味着末尾行已渲染并被 measureElement 测过；此时总高若仍不变，才说明
       *    测量确实收敛。反之（还在往上滚的过程里）总高不变毫无意义。
       *
       * 末尾行正在视口外 ⇒ 说明还没测完，继续等（这正是 248 条会话要等 ~1s 的原因）。
       */
      const virtualItems = virtualizer.getVirtualItems();
      const last = virtualItems[virtualItems.length - 1];
      const el = parentRef.current;
      const reachedEnd =
        el !== null && last !== undefined && last.end >= el.scrollHeight - el.clientHeight - 1;

      if (!reachedEnd) {
        // 尚未覆盖到末尾：不论总高是否变化都不计稳定帧（正在测量中）
        stableFrameRef.current = 0;
        lastTotalRef.current = total;
      } else if (total !== lastTotalRef.current) {
        // 已到末尾但总高还在变（末尾行正在被测量回填）
        lastTotalRef.current = total;
        stableFrameRef.current = 0;
      } else {
        stableFrameRef.current += 1;
      }

      if (stableFrameRef.current >= LAYOUT_SETTLE_STABLE_FRAMES) {
        reportSettled();
        return;
      }
      // 判据 B：超时兜底（用户裁决 5s；永不收敛时强制放行 —— 永久遮罩更糟）
      if (performance.now() - started >= layoutSettleTimeoutMs) {
        reportSettled();
        return;
      }
      raf = requestAnimationFrame(check);
    };
    raf = requestAnimationFrame(check);
    return () => cancelAnimationFrame(raf);
  }, [virtualizer, isEmpty, settlePhase, messages.length, reportSettled, layoutSettleTimeoutMs]);

  /*
   * 图片大图预览（2026-10-01 图片预览批次 Task 7 Step 1b）。
   *
   * ⚠️ state 必须挂在 **MessageList 顶层**、弹层在这里条件渲染，绝不能下沉到
   * `BlockView`：`BlockView` 经 MessageItem 被**递归调用**，一条消息 N 个 image block
   * 就会挂 N 个弹层实例（后开的覆盖先开的，还各自持有独立的 Esc 处理器）。
   *
   * token 从 `getLiveConfig()` 直读（读 window 上的稳定值，不订阅变化），
   * 由 `imageUrl` 拼进 `?token=` —— `<img>` 带不了 Authorization 头，
   * 不带 token 一律 401（core `/sessions/image` 只对该端点单点豁免 query token）。
   * mock 态 token 为空串 ⇒ `imageUrl` 不拼该段，行为与不带参数时逐字节一致。
   *
   * ★ `previewRef` 记下**打开大图时聚焦的那个缩略图按钮**，closePreview 里还回去
   * （G7 焦点归还）。必须自己存：`Dialog` 的归还逻辑挂在 `open` 由 true→false 的
   * effect 重跑上，而我们恒传 `open` + 条件渲染（`Dialog` 关闭态仍是 role=dialog，
   * 常驻会污染 probe 的「第一个 [role=dialog]」锚点）⇒ 关闭走的是**卸载**，
   * `previouslyFocused.focus?.()` 一次都不执行，焦点会掉到 `<body>`。
   * 手动归还与 `WorkingDirectoryMenu.tsx` 的 DirectoryPickerDialog 同款。
   */
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  const openPreview = useCallback(
    (src: string, alt: string, trigger?: HTMLElement | null) => {
      previewRef.current = trigger ?? null;
      setPreview({ src, alt });
    },
    [],
  );
  const closePreview = useCallback(() => {
    const trigger = previewRef.current;
    previewRef.current = null;
    setPreview(null);
    // 卸载后再还：弹层还挂着时焦点若被 Dialog 的 rAF 抢回面板，焦点又会丢回 body
    requestAnimationFrame(() => trigger?.focus?.());
  }, []);

  /*
   * 刻度纵向位置（紧凑居中簇，task-turn-rail-compact-cluster.md 第二次修订）：位置只由
   * 提问数、栏高与固定档距决定，不读 virtualizer 测量。常显渲染、每渲染期直算
   * （N = 提问数，代价可忽略）。未量到高度时给空表（刻度不渲染）。
   */
  let railTops: number[] = [];
  if (railHeight > 0 && railAnchors.length > 0) {
    railTops = layoutTickTops(railAnchors.length, railHeight, TURN_RAIL_TICK_PITCH).map((top) =>
      // 居中刻度的视觉半高钳制：中心收进 [半高, 栏高-半高]。紧凑簇下仅溢出压缩
      // 的极端多轮会贴边，保留作渲染层保险（纯函数层不动）
      Math.min(Math.max(top, TURN_RAIL_TICK_HALF), railHeight - TURN_RAIL_TICK_HALF),
    );
  }

  /*
   * 空会话占位（验收 5-7 / 5-8）。
   *
   * 为什么必须显式占位而不是「什么都不渲染」：`data-testid="message-list"` 是唯一滚动容器，
   * 0 条消息时它的内容高度为 0，视觉上塌陷成一条空带 —— 用户不知道是「加载完了没消息」
   * 还是「坏了」。占位高度取 MESSAGE_LIST_PADDING 的语义单位（用 `py-16` 之类 Tailwind
   * 间距类，不引入新尺寸常量），保证占位本身有可测高度。
   *
   * 可用 `?empty=1` 复现（App.tsx 的 applyEmptyParam → EMPTY_SESSION）。
   */
  if (isEmpty) {
    return (
      <div className={cn("relative flex min-h-0 flex-1")}>
        <div
          ref={setScrollRef}
          data-testid="message-list"
          data-total-count={0}
          data-at-bottom={atBottom}
          className={cn("h-full w-full overflow-y-auto", className)}
          style={{ padding: MESSAGE_LIST_PADDING }}
          {...rest}
        >
          <div
            data-testid="empty-state"
            className="flex h-full min-h-0 flex-col items-center justify-center gap-3 py-16 text-center"
          >
            <Icon icon={MessageSquare} size={28} className="text-icon-neutral" />
            <p className="text-base font-medium text-text-secondary">还没有消息</p>
            <p className="max-w-sm text-sm text-text-tertiary">
              在下方输入框里给 Pi 下达第一个任务，回复会出现在这里。
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("relative flex min-h-0 flex-1")}>
      <div
        ref={setScrollRef}
        data-testid="message-list"
        data-total-count={messages.length}
        data-at-bottom={atBottom}
        className={cn("h-full w-full overflow-y-auto", className)}
        style={{ padding: MESSAGE_LIST_PADDING }}
        {...rest}
      >
        <div
          ref={innerRef}
          style={{
            height: virtualizer.getTotalSize(),
            width: "100%",
            // 会话内容列居中（2026-09-22 裁决）：列宽 = MESSAGE_MAX_WIDTH，
            // 在滚动容器内容盒内 margin auto 居中；侧边栏/预览区折叠组合变化时
            // 随内容区自动重新居中。虚拟行 absolute width:100% 以本列为基准。
            maxWidth: MESSAGE_MAX_WIDTH,
            marginLeft: "auto",
            marginRight: "auto",
            position: "relative",
          }}
        >
          {items.map((virtualRow) => {
            // F1：末尾占位行（index === messages.length 且 pending）—— thinking-indicator
            // 刻意不复用 message-item testid，m2 验收 2-1 按 message-item 数消息不受影响
            const isPendingRow = pending && virtualRow.index === messages.length;
            const message = messages[virtualRow.index];
            // 处理详情折叠：assistant 消息按轮次归属分派（user / 占位行无归属）
            const membership = isPendingRow ? undefined : turnIndex.get(virtualRow.index);
            const turn = membership ? turnInfoOf(membership) : undefined;
            // 收起轮次的中间行整行隐藏：包装保留（testid 与 data-total-count 探针契约不变），
            // 内边距归零避免叠出一串空隙
            const rowHidden = turn !== undefined && turn.collapsed && !turn.isTail;
            // 空壳整行隐藏（2026-09-28 用户裁决·渲染层方向A）：message_start 即建壳
            // （模型名/时间戳先挂上），首个可见块到达前它只会顶着占位行冒充「正在回复」——
            // 内容不渲染，占位行直接贴上一条消息，模型标签随首个可见块一起现身。
            // 数据层不动（pending 判定 / turnIndex 照旧）；包装保留（testid 与
            // data-total-count 探针契约不变），内边距归零（同 rowHidden 先例）；
            // 折叠行宿主豁免（兜底：空壳若为可折叠轮首/尾条，不能吞掉切换行）；
            // 模型请求失败的空壳豁免（2026-09-28 用户裁决：失败要可见）——
            // 带 errorMessage 的空壳渲染成错误框，不能当普通空壳吞掉。
            const shellHidden =
              !isPendingRow &&
              !(turn?.hostsToggle ?? false) &&
              message.role === "assistant" &&
              !hasRenderableContent(message.blocks) &&
              !message.errorMessage;
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                className={cn(flashIndex === virtualRow.index && "message-flash")}
                {...(isPendingRow
                  ? { "data-testid": "thinking-indicator" }
                  : {
                      "data-testid": "message-item",
                      "data-message-id": message.id,
                      "data-role": message.role,
                    })}
                ref={measureRow}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                  // 消息间距放进测量高度，避免绝对定位下的重叠（隐藏行除外，见上）
                  paddingBottom: rowHidden || shellHidden ? 0 : MESSAGE_GAP,
                }}
              >
                {isPendingRow ? (
                  <ThinkingPending since={pendingSince as number} />
                ) : (
                  <MessageItem
                    message={message}
                    turn={turn}
                    onPreviewImage={openPreview}
                    turnFiles={
                      membership?.isTail === true
                        ? turnFilesByKey.get(membership.turn.key)
                        : undefined
                    }
                    onOpenFile={openFileInPreview}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/*
       * 首屏 loading 遮罩（2026-10-01 首屏跳变批次 · 用户裁决「方案 A：标准 loading 态」）。
       *
       * ## 为什么需要它
       *
       * 首帧只有可见的十几行被 overscan 带进来渲染，totalSize 是**估算堆出来的**；
       * 随后的 measureElement 回填使总高缩水，已写入的 scrollTop 被连带拽走
       * （实测 248 条会话在内容出现后 194ms 内被拽 3877px）。遮罩期间真实内容在
       * 底下完成全部测量。
       *
       * ## 为什么是不透明而非半透明（用户反馈「灰色一闪而过像 bug」）
       *
       * 先前是纯黑 45% 半透明，浅色主题下铺满内容区 ⇒ **整块界面变灰**，
       * 视觉语言等于「禁用 / 加载失败」。而且半透明在这条路上是**逻辑死结**：
       * 要让跳动不可见就得不透明，不透明就等于「不显示内容」。
       *
       * ## 为什么抽成共享组件
       *
       * 首屏等待分两段，两段必须形态一致：① bootstrapping（WorkspaceArea 用）、
       * ② 布局未稳（这里用）。此前两段各画各的（Sparkles 大字 vs spinner 小字），
       * 接力时观感突变（用户反馈「先大字后小字」）。现共用 LayoutSettlingOverlay。
       *
       * 卸载时机：fading 态淡出 LAYOUT_SETTLE_FADE_MS 后由 setTimeout 兜底卸载，
       * **不依赖 CSS transitionend**（该事件在无实际视觉变化时不触发，
       * 遮罩会永久残留 —— 比原缺陷更糟）。
       *
       * 罩在滚动容器的兄弟层（absolute inset-0），**不跨到 Composer** ——
       * 输入框不该被首屏遮罩挡住。
       */}
      {settlePhase !== "settled" ? (
        <LayoutSettlingOverlay fading={settlePhase === "fading"} />
      ) : null}

      {!atBottom ? (
        <button
          type="button"
          data-testid="scroll-to-bottom"
          onClick={scrollToBottom}
          aria-label="滚动到底部"
          className="absolute bottom-4 right-4 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full border border-border-default bg-bg-elevated text-text-secondary shadow-md transition-colors hover:bg-bg-hover"
        >
          <Icon icon={ArrowDown} className="text-icon-neutral" />
        </button>
      ) : null}

      {/* 会话提问导航刻度栏（task-turn-rail.md）：常显（task-turn-rail-always-visible.md
          翻转决策 2）；无提问的会话（纯 assistant 开头 / 空会话）不渲染，触屏（hover:none）
          整体豁免（决策 8）；key=sessionScope 切会话重挂、双通道 state 天然清零 */}
      {hoverable && railAnchors.length > 0 ? (
        <TurnRail
          key={sessionScope}
          anchors={railAnchors}
          tops={railTops}
          previews={railPreviews}
          railRef={railRef}
          onJump={jumpToMessage}
          onWheelScroll={handleRailWheel}
        />
      ) : null}

      {/* 图片大图预览：条件渲染（无预览对象则文档里没有 role=dialog，
          不污染 probe-dir-menu / m4-acceptance 的「第一个 [role=dialog]」锚点）。
          key={src} 让换图时卸载重挂、组件内加载态自然归零（见 ImagePreviewDialog 文件头）；
          onClose 手动把焦点还给打开它的缩略图按钮。 */}
      {preview ? (
        <ImagePreviewDialog
          key={preview.src}
          open
          onClose={closePreview}
          src={preview.src}
          alt={preview.alt}
        />
      ) : null}
    </div>
  );
});

/* ---------------------------------------------------------------------------
 * 单条消息：按角色对齐 + 逐 Block 分发渲染
 * ------------------------------------------------------------------------- */

/** 速度档位 → 徽章配色（tokens.css 语义令牌，soft 底对比度已验证；G5 禁调色板安全） */
const SPEED_TONE_CLASS: Record<SpeedTone, string> = {
  danger: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  success: "bg-success-soft text-success",
  info: "bg-info-soft text-info",
};

/**
 * 消息左上角的模型标签（2026-09-27 用户裁决）。
 *
 * 展示口径取 `responseModel ?? model`（实际生成这条回复的模型）；展示名走
 * 决策链：live 的 /models 清单 → mock 的 COMPOSER_MODELS → 原始 id 兜底。
 * **同日修订（用户裁决）**：快照变体（如火山方舟 `*-ga-260731`）通常不在清单里，
 * 查不到展示名时退回**配置模型**（`model`）的展示口径 —— 标签与配置/选择器一致，
 * 实际部署版本由 title 交代。
 *
 * title 悬停给原始事实（全仓惯例）：请求/实际 id 分叉时写「请求 X，实际响应 Y」，
 * 不用展示名冒充事实。渲染条件：assistant 且消息带模型事实 —— user 消息、
 * 压缩摘要 / custom_message 映射出的消息、旧会话文件都没有 model → 整行不渲染
 * （同 usage 诚实展示纪律）。另：无可见内容的空壳消息在 MessageList 行级整行隐藏
 * （2026-09-28 裁决·方向A）—— 标签的实际现身时机与首个可见块一致，等待期不冒充「正在回复」。
 */
function ModelLabelRow({ message }: { message: Message }) {
  const models = useModelsStore((s) => s.payload);

  /*
   * token 速度徽章（2026-09-27 用户裁决，批次 B；同日修订显示时机）：
   * **仅回复过程中显示、动态刷新，回复完成即隐藏** —— 不是完成后定格的终值。
   * 流中没有真实 usage（随 message_end 才到，且到达即隐藏），速度按已有
   * text + thinking 字符量估算（因子 0.5 tokens/字，沿用 chat-store computeTokens
   * 先例）；耗时 = now − message.timestamp（Pi 请求起点，含首字延迟）。
   * ticker 每 500ms 跳动一次（chunk 间隙也持续走表；ThinkingPending 的秒表同款先例）。
   * 显示门槛：进行 ≥1s 且已有输出字符 —— 开局半秒的数字全是噪声，不闪黄红。
   * hooks 必须在 early return 之前（isStreaming 的 ticker 对每行都无条件注册）。
   */
  const isStreaming = message.blocks.some(
    (b) => (b.type === "text" || b.type === "thinking") && b.streaming,
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isStreaming) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [isStreaming]);

  const request = message.model;
  const response = message.responseModel;
  const effective = response ?? request;
  if (!effective) return null;
  const lookup = (id: string) => {
    const fromLive = models?.models.find((m) => m.id === id);
    if (fromLive) return { label: fromLive.label, providerLabel: fromLive.providerLabel?.trim() };
    const fromMock = COMPOSER_MODELS.find((m) => m.id === id);
    // ModelOption（mock 清单）没有 providerLabel 字段，只有 live 的 ModelInfo 才有
    return fromMock ? { label: fromMock.label, providerLabel: undefined } : undefined;
  };
  let hit = lookup(effective);
  let shownId = effective;
  if (!hit && response && request && response !== request) {
    const requestHit = lookup(request);
    if (requestHit) {
      hit = requestHit;
      shownId = request;
    }
  }
  const label = hit?.label ?? shownId;
  const rerouted = response !== undefined && request !== undefined && response !== request;
  const titleParts = [rerouted ? `请求 ${request}，实际响应 ${response}` : `模型 ${label}`];
  if (hit?.providerLabel) titleParts.push(hit.providerLabel);

  const outputChars = message.blocks.reduce(
    (acc, b) => (b.type === "text" || b.type === "thinking" ? acc + b.content.length : acc),
    0,
  );
  const elapsedMs = now - message.timestamp;
  const speed =
    isStreaming && elapsedMs >= 1000 && outputChars > 0
      ? {
          tps: (outputChars * 0.5) / (elapsedMs / 1000),
          chars: outputChars,
          elapsedSec: elapsedMs / 1000,
        }
      : null;

  return (
    <div
      data-testid="message-model"
      className="flex items-center gap-2 text-xs text-text-tertiary"
      title={titleParts.join(" · ")}
    >
      <span>{label}</span>
      {speed !== null ? (
        <span
          data-testid="message-speed"
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 font-medium tabular-nums",
            SPEED_TONE_CLASS[speedTone(speed.tps)],
          )}
          title={`已输出约 ${speed.chars} 字符（估算）÷ 已进行 ${speed.elapsedSec.toFixed(1)}s —— 完成后徽章隐藏`}
        >
          {speed.tps.toFixed(1)} t/s
        </span>
      ) : null}
    </div>
  );
}

function MessageItem({
  message,
  turn,
  onPreviewImage,
  turnFiles,
  onOpenFile,
}: {
  message: Message;
  turn?: MessageTurnInfo;
  /** 图片预览请求冒泡到 MessageList 层（弹层只有一份，见 MessageList 的 preview state 注释）。
      必传：MessageItem 只有 MessageList 一个调用点，那里恒有 openPreview —— 可选化就得
      造一个「点了没反应」的哑按钮（本仓明令避免的陷阱）。 */
  onPreviewImage: (src: string, alt: string, trigger?: HTMLElement | null) => void;
  /** 本轮「写成功的文件」清单（task-turn-file-chips.md）——仅尾条由 MessageList 传入，
      空清单不传（不渲染行，哑交互禁令）；chips 行折叠/展开都显示（折叠只藏过程块）。 */
  turnFiles?: TurnFileEntry[];
  /** chip 点击 → 右侧文件预览（MessageList 层的 openFile，同 WorkingDirFileTree 先例） */
  onOpenFile: (path: string) => void;
}) {
  const isUser = message.role === "user";
  /*
   * 处理详情折叠（task-process-collapse.md）：收起轮次的中间行整行不渲染内容 ——
   * 虚拟行包装（testid / data-message-id）由 MessageList 保留，这里只放弃内容。
   * 尾条负责渲染折叠行 + 最终文本（见下）。
   */
  if (turn?.collapsed && !turn.isTail) return null;
  // 空壳（无任何可见内容的 assistant）不渲染 —— 与 MessageList 的 shellHidden 同一判定、
  // 两处各写一份（rowHidden 先例同款）；模型标签/时间戳随首个可见块一起出现（2026-09-28 裁决）。
  // 带 errorMessage 的失败空壳豁免（2026-09-28 用户裁决：失败要可见），下方渲染错误框。
  if (
    message.role === "assistant" &&
    !hasRenderableContent(message.blocks) &&
    !message.errorMessage &&
    !(turn?.hostsToggle ?? false)
  )
    return null;
  /*
   * 视图层合并（2026-09-26 用户裁决）：live 的 bash 执行此前渲染两块 ——
   * tool_call 行（bash + 命令预览）+「终端」卡；现在同一条消息内按 toolCallId
   * 配对，渲染成**一张**一行式工具卡（ToolCallCard），终端块本身不再单独出卡。
   * 配不上的块各走各的老组件（mock 会话的裸 terminal / stress 的裸 tool_call），
   * m1/m2 探针的 TerminalCard 断言不受影响。
   */
  const pairedCallIds = new Set<string>();
  const terminalById = new Map<string, TerminalBlock>();
  for (const block of message.blocks) {
    if (block.type === "tool_call" && block.toolCallId) pairedCallIds.add(block.toolCallId);
    if (block.type === "terminal" && block.toolCallId) terminalById.set(block.toolCallId, block);
  }
  /*
   * 收起态尾条只渲染 text + approval 两类块（thinking / tool_call / terminal / plan
   * 全部收进折叠区，展开即回）；approval 任何情况不收 —— 授权卡必须可操作
   * （task-process-collapse.md 决策 4；正常时序 settled 前授权已决，此为兜底）。
   * 配对表仍按全量 blocks 建，展开路径零变化。
   */
  const visibleBlocks =
    turn?.collapsed && turn.isTail
      ? message.blocks.filter((block) => block.type === "text" || block.type === "approval")
      : message.blocks;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2",
        isUser ? "items-end" : "items-start",
      )}
    >
      {/* 处理详情折叠行（2026-09-27 二次裁决）：收起态挂尾条（紧贴最终答复上方）、
          展开态挂首条（整组过程顶部）—— 均置于模型标签之前 */}
      {turn?.hostsToggle ? (
        <ProcessGroupRow
          messageCount={turn.messageCount}
          toolCallCount={turn.toolCallCount}
          expanded={turn.expanded}
          onToggle={turn.onToggle}
        />
      ) : null}
      {/* 左上角模型标签（2026-09-27 用户裁决）：assistant 且带模型事实才显示，
          与底部 MessageFooter 成上下镜像；渲染条件细节见 ModelLabelRow 注释 */}
      {message.role === "assistant" ? <ModelLabelRow message={message} /> : null}
      {visibleBlocks.map((block, i) => {
        // 已与 tool_call 配对的终端块并入了上方的一行式工具卡，跳过避免双份渲染
        if (block.type === "terminal" && block.toolCallId && pairedCallIds.has(block.toolCallId)) {
          return null;
        }
        return (
          <div
            key={i}
            className="min-w-0"
            style={
              /*
               * 我方 vs 对方的宽度语义（2026-09-22 三次裁决，参考截图：我方消息
               * 应为紧凑气泡贴右，不占满整列）：
               * - 对方（assistant）：width:100% 占满 720 列 —— 卡片 / 终端 / 代码块
               *   需要整列宽度，长文本也在列内换行（2-18）。
               * - 我方（user）：不给宽度 —— 根容器 items-end 已禁用 flex 交叉轴
               *   stretch，块退化为 fit-content：短文本气泡只包住内容、贴右；
               *   超长文本被 maxWidth 720 封顶后换行，不撑破容器。
               */
              isUser
                ? { maxWidth: MESSAGE_MAX_WIDTH }
                : { maxWidth: MESSAGE_MAX_WIDTH, width: "100%" }
            }
          >
            <BlockView
              message={message}
              block={block}
              pairedTerminal={
                block.type === "tool_call" && block.toolCallId
                  ? terminalById.get(block.toolCallId)
                  : undefined
              }
              onPreviewImage={onPreviewImage}
            />
          </div>
        );
      })}
      {/* 模型请求失败直出（2026-09-28 用户裁决）：失败空壳不再被吞，错误框摆在
          内容块之后 / 时间戳之前 —— 模型标签照常在左上角，与参考截图同构 */}
      {message.errorMessage ? <MessageErrorCard message={message.errorMessage} /> : null}
      {/* 本次修改文件 chips（task-turn-file-chips.md）：轮级元数据与 footer 同类——
          摆在内容块/错误框之后、footer 之前（参考截图同落点）；折叠轮的尾条照常显示 */}
      {turnFiles !== undefined && turnFiles.length > 0 ? (
        <TurnFileChips files={turnFiles} onOpenFile={onOpenFile} />
      ) : null}
      {/* 底部元信息行（F2 用量 + 2026-09-27 消息时间）：两个角色统一交 MessageFooter ——
          usage 契约上只存在于 assistant 消息，user 行自动退化为仅时间的右对齐小字 */}
      <MessageFooter usage={message.usage} timestamp={message.timestamp} />
    </div>
  );
}

function BlockView({
  message,
  block,
  pairedTerminal,
  onPreviewImage,
}: {
  message: Message;
  block: Block;
  /** 与该 tool_call 同 toolCallId 配对的终端块（同消息内存在才传，见 MessageItem 的合并注释） */
  pairedTerminal?: TerminalBlock;
  /** 冒泡到 MessageList 层去开预览（见该文件 preview state 注释：弹层只有一份）。
      第三参是触发按钮，MessageList 据此在关闭时归还焦点（G7）。 */
  onPreviewImage: (src: string, alt: string, trigger?: HTMLElement | null) => void;
}) {
  switch (block.type) {
    case "image": {
      /*
       * 历史图片（ImageBlock，元数据 + 按需取图）。token 必传：
       * `<img>` 带不了 Authorization 头，core `/sessions/image` 只对该端点豁免
       * `?token=` —— 不带就是 401，图恒裂。空串时 `imageUrl` 不拼该段（mock 态无碍）。
       */
      const url = imageUrl(block, getLiveConfig().token, getLiveConfig().baseUrl);
      if (!url) return null;
      // ⚠️ 用 mimeType 而不是 partIndex 编号：`partIndex` 是该 part 在
      // `message.content[]` 里的**下标**，不是图片序号。真实会话里块结构恒为
      // `[text, image]` ⇒ partIndex 几乎总是 1，拿它编号会让 13 张图的无障碍文案
      // 全部变成「图片 2」，且与 Composer 侧 `i + 1` 的口径分叉。
      // 屏读器文案只要能区分即可，不追求「第几张」——同一消息内多图极罕见。
      const alt = `${imageThumbnailAlt(0)}（${block.mimeType}）`;
      return (
        <MessageAttachment
          src={url}
          alt={alt}
          onPreview={(trigger) => onPreviewImage(url, alt, trigger)}
        />
      );
    }
    case "text":
      return (
        <MessageBubble
          block={block}
          role={message.role}
          streaming={block.streaming}
          /* 粘图批次：贴图附件随 user 消息回显（仅乐观回显存在；core 历史回放恒无此字段） */
          attachments={message.role === "user" ? message.attachments : undefined}
        />
      );
    case "thinking":
      return <ThinkingCard block={block} />;
    case "plan":
      return <PlanCard block={block} />;
    case "terminal":
      return <TerminalCard block={block} />;
    case "approval":
      return <ApprovalCard block={block} />;
    case "tool_call":
      /*
       * 配上终端块 = 一行式工具卡（bash 执行的常态路径）；没配上（执行事件未到 /
       * 中止流式 / stress 压测数据）回落原轻量行，行为零变化。
       */
      return pairedTerminal ? (
        <ToolCallCard call={block} terminal={pairedTerminal} />
      ) : (
        <ToolCallInline block={block} />
      );
    default:
      return null;
  }
}

/** 工具调用内联展示（轻量，无专门 testid，不进验收核心路径） */
function ToolCallInline({ block }: { block: Extract<Block, { type: "tool_call" }> }) {
  // 与 ToolCallCard 同源摘要（D3）：edit/write 短摘要，其余通用兜底
  const argsPreview = toolArgsPreview(block.toolName, block.args);
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border-subtle bg-bg-subtle px-3 py-2 text-sm text-text-secondary">
      <Icon icon={Wrench} className="shrink-0 text-icon-neutral" />
      <span className="font-medium text-text-primary">{block.toolName}</span>
      <span className="min-w-0 truncate font-mono text-xs text-text-tertiary">{argsPreview}</span>
    </div>
  );
}

/**
 * 历史消息里的图片缩略图（ImageBlock）—— 64px 与既有 attachments 缩略图同尺寸，
 * 保证视觉一致；点击开大图预览。
 *
 * ⚠️ 尺寸是几何契约的一部分（既有探针按 h-16 采样），不要改。
 *
 * `onPreview` 回调带上**按钮自身**（= 事件 currentTarget）：MessageList 存下来，
 * 关闭预览时把焦点还回去（G7）。用回调传 ref 而不是 `document.activeElement` 快照 ——
 * 鼠标点击会把焦点放到按钮上没问题，但由键盘/程序触发时 activeElement 可能还在别处。
 */
function MessageAttachment({
  src,
  alt,
  onPreview,
}: {
  src: string;
  alt: string;
  onPreview: (trigger: HTMLButtonElement) => void;
}) {
  /*
   * 加载失败要直接可见（2026-09-28 用户裁决「失败要可见，不许静默」，同 contract.ts 的
   * 诚实展示纪律）：`<img>` 无 onError 时加载失败只留浏览器默认碎图标，user 完全看不出
   * 「图真的存在但没加载出来」——而取图失败在跨源形态、跨 cwd 档位、entryId 失效等
   * 场景下都会发生，静默会让排查无从下手。
   * 预览弹层里已有独立的失败态文案，这里给缩略图补上同一口径。
   */
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => onPreview(e.currentTarget)}
      title="点击查看大图"
      aria-label={`查看${alt}`}
      data-testid="message-image-thumb"
      data-load-state={failed ? "error" : "ok"}
      className="group inline-block h-16 max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-border-subtle"
    >
      {failed ? (
        <span className="flex h-16 w-16 items-center justify-center text-text-tertiary" data-testid="message-image-failed">
          <span className="text-xs">图未能加载</span>
        </span>
      ) : (
        <img src={src} alt={alt} onError={() => setFailed(true)} className="h-16 max-w-full object-cover" />
      )}
    </button>
  );
}
