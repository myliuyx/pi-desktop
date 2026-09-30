import { cn } from "@/lib/cn";
import {
  contextTone,
  formatCompact,
  formatContextPercent,
  type ContextTone,
} from "@/lib/format";
import { CONTEXT_RING_SIZE, CONTEXT_RING_STROKE } from "@/lib/layout";
import { useChatStore } from "@/store/chat-store";

/**
 * 上下文占用环 —— 输入框底行左簇的「消耗」代言人（task-composer-inline-toolbar.md D1=A1）。
 *
 * 参考图（另一 Agent 产品）把上下文占用画成小圆环 + 百分比，替代原 TokenStats 四段
 * 常驻文本：行内只留**最该盯的一个数字**（上下文占用率，Pi CLI 同口径），四段明细
 * （输入/输出/消耗/窗口）收进原生 `title` 悬停提示——与旧 TokenStats item 的 title
 * 同一手法，不引入新浮层组件。数据源与旧 TokenStats 相同：chat-store 的 `tokenUsage`
 * （live 由 usage 事件实时下发，mock 由 computeTokens/INITIAL_TOKEN_USAGE 合成）。
 *
 * 颜色三档（contextTone）：≥90% danger / ≥70% warning / 其余中性。颜色挂在数值 span
 * 与 svg 的 currentColor 上，验收（m2 2-15）按探针元素比对**计算色值**，所以必须真的
 * 用 text-* 类，绝不能自己调亮度凑。
 *
 * 降级态（规格决策 5）：live 下 `contextTokens` 缺省（契约「仅当两侧都未知才缺省」，
 * 如刚压缩完的下一次回复前）→ 中性满环 + 数值显示窗口大小，title 注明占用未知。
 */

const TONE_CLASS: Record<ContextTone, string> = {
  neutral: "text-text-tertiary",
  warning: "text-warning",
  danger: "text-danger",
};

/** 圆环几何：半径 = (直径 − 描边) / 2，进度弧按周长比例展开 */
const RING_RADIUS = (CONTEXT_RING_SIZE - CONTEXT_RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function ComposerContextRing() {
  const usage = useChatStore((state) => state.tokenUsage);

  const { contextTokens, contextWindow } = usage;
  const known = contextTokens !== undefined && contextWindow > 0;
  // 未知态按 0% 计：contextTone(0)=neutral、弧长 0，恰好就是降级态想要的形状
  // （满环由下方 known 分支显式给 100，不经 percent）
  const percent = known ? (contextTokens / contextWindow) * 100 : 0;
  const tone = contextTone(percent);
  const valueText = known ? formatContextPercent(percent) : formatCompact(contextWindow);

  const title = known
    ? `输入 ${formatCompact(usage.input)} · 输出 ${formatCompact(usage.output)} · 消耗 ${formatCompact(usage.total)} · 上下文 ${valueText}/${formatCompact(contextWindow)}`
    : `上下文占用未知（尚未回复或刚压缩完）· 窗口 ${formatCompact(contextWindow)} · 输入 ${formatCompact(usage.input)} · 输出 ${formatCompact(usage.output)} · 消耗 ${formatCompact(usage.total)}`;

  return (
    <div
      data-testid="composer-context-ring"
      title={title}
      className="flex shrink-0 items-center gap-1.5"
    >
      <span className={cn("inline-flex", TONE_CLASS[tone])}>
        <svg
          width={CONTEXT_RING_SIZE}
          height={CONTEXT_RING_SIZE}
          viewBox={`0 0 ${CONTEXT_RING_SIZE} ${CONTEXT_RING_SIZE}`}
          aria-hidden="true"
        >
          {/* 轨道：发丝灰整圆；进度弧叠在其上，stroke=currentColor 跟随分档色 */}
          <circle
            cx={CONTEXT_RING_SIZE / 2}
            cy={CONTEXT_RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={CONTEXT_RING_STROKE}
            className="stroke-border-subtle"
          />
          <circle
            cx={CONTEXT_RING_SIZE / 2}
            cy={CONTEXT_RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={CONTEXT_RING_STROKE}
            strokeLinecap="round"
            stroke="currentColor"
            /* 降级态画满环（规格决策 5）；已知态按占比展开、钳到 100 防越界。
               -90° 起笔 = 从 12 点方向顺时针（参考图同款走向） */
            strokeDasharray={`${((known ? Math.min(percent, 100) : 100) / 100) * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
            transform={`rotate(-90 ${CONTEXT_RING_SIZE / 2} ${CONTEXT_RING_SIZE / 2})`}
          />
        </svg>
      </span>
      <span
        data-testid="composer-context-ring-value"
        className={cn("text-xs font-medium tabular-nums", TONE_CLASS[tone])}
      >
        {valueText}
      </span>
    </div>
  );
}
