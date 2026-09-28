import {
  forwardRef,
  useCallback,
  useEffect,
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
  MESSAGE_GAP,
  MESSAGE_LIST_PADDING,
  MESSAGE_MAX_WIDTH,
} from "@/lib/layout";
import type { Block, Message, TerminalBlock } from "@/mock/types";
import { COMPOSER_MODELS } from "@/mock/composer";
import { useModelsStore } from "@/store/models-store";
import { speedTone, type SpeedTone } from "@/lib/format";
import { buildTurnIndex, type TurnMembership } from "@/lib/turns";
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

  const virtualizer = useVirtualizer({
    // 占位行计入虚拟行数（消息数 + 1），testid 用 thinking-indicator，不占 message-item 名额
    count: messages.length + (pending ? 1 : 0),
    getScrollElement: () => parentRef.current,
    // 仅作为首帧前的猜测值；真实高度由 measureElement 覆盖
    estimateSize: () => 140,
    overscan: 6,
  });

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
                {...(isPendingRow
                  ? { "data-testid": "thinking-indicator" }
                  : {
                      "data-testid": "message-item",
                      "data-message-id": message.id,
                      "data-role": message.role,
                    })}
                ref={virtualizer.measureElement}
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
                  <MessageItem message={message} turn={turn} />
                )}
              </div>
            );
          })}
        </div>
      </div>

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

function MessageItem({ message, turn }: { message: Message; turn?: MessageTurnInfo }) {
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
            />
          </div>
        );
      })}
      {/* 模型请求失败直出（2026-09-28 用户裁决）：失败空壳不再被吞，错误框摆在
          内容块之后 / 时间戳之前 —— 模型标签照常在左上角，与参考截图同构 */}
      {message.errorMessage ? <MessageErrorCard message={message.errorMessage} /> : null}
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
}: {
  message: Message;
  block: Block;
  /** 与该 tool_call 同 toolCallId 配对的终端块（同消息内存在才传，见 MessageItem 的合并注释） */
  pairedTerminal?: TerminalBlock;
}) {
  switch (block.type) {
    case "text":
      return <MessageBubble block={block} role={message.role} streaming={block.streaming} />;
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
  const argsPreview =
    "command" in block.args
      ? String(block.args.command)
      : Object.entries(block.args)
          .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join(" ");
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border-subtle bg-bg-subtle px-3 py-2 text-sm text-text-secondary">
      <Icon icon={Wrench} className="shrink-0 text-icon-neutral" />
      <span className="font-medium text-text-primary">{block.toolName}</span>
      <span className="min-w-0 truncate font-mono text-xs text-text-tertiary">{argsPreview}</span>
    </div>
  );
}
