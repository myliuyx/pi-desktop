import { formatFullTimestamp, formatMessageTime } from "@/lib/format";
import type { MessageUsage } from "@/mock/types";

/**
 * 消息底部元信息行（F2 · task-chat-feedback-and-usage.md §3.3 + 2026-09-27 消息时间批次）。
 *
 * 形态：消息块之后**一行** 12px 灰字，两端对齐 —— 用量在左、时间在右：
 *   ↑1342 ↓286 · cache 45201                        18:25
 * 时间放消息末尾是用户裁决：AI 回复可能很长，顶部时间会随滚动离开视野，
 * 「读完的落点」上才随时可见。两个角色共用本行：
 * - assistant：usage 有值（只随 message_end 到达）时显示用量段；
 * - user：契约上无 usage → 行退化为仅时间的右对齐小字，落在右对齐气泡正下方。
 *
 * 用量文案（2026-09-26 用户裁定）：数字**全量展示**（不用 formatCompact 的 1.3k 缩写，如 1523）；
 * 「缓存读」标签定名 `cache`（「缓存写」同族 `cache write`，对齐 API 控制台惯例）。
 * cache 两项「有值才显示」（契约里 >0 才写）；精确数值与口径走原生 title 悬停（全仓惯例）。
 *
 * 口径（决策 D5）：cacheRead/cacheWrite 已含在 total 里，与 input 并列展示、**不相加** ——
 * tooltip 里写明，防「加起来对不上」的困惑。
 *
 * 渲染条件由数据天然保证：流式中 / 中止的消息没有 usage → 本行只显示时间，
 * 数字不会中途跳动、也不谎报。timestamp 为 0（reduce.ts 兜底值）且无 usage 时
 * 整行不渲染（formatMessageTime 返回 null），绝不出现「1970-01-01 08:00」。
 */
export function MessageFooter({ usage, timestamp }: { usage?: MessageUsage; timestamp?: number }) {
  const time = formatMessageTime(timestamp ?? 0, Date.now());
  if (!usage && !time) return null;

  const line = usage
    ? [
        `↑${usage.input}`,
        `↓${usage.output}`,
        ...(usage.cacheRead !== undefined ? [`cache ${usage.cacheRead}`] : []),
        ...(usage.cacheWrite !== undefined ? [`cache write ${usage.cacheWrite}`] : []),
      ].join(" · ")
    : null;

  const usageTitle = usage
    ? [
        `输入 ${usage.input.toLocaleString()}`,
        `输出 ${usage.output.toLocaleString()}`,
        ...(usage.cacheRead !== undefined ? [`cache ${usage.cacheRead.toLocaleString()}`] : []),
        ...(usage.cacheWrite !== undefined ? [`cache write ${usage.cacheWrite.toLocaleString()}`] : []),
      ].join(" · ") +
      ` —— 缓存读写已含在总消耗 ${usage.total.toLocaleString()} 中，与输入并列显示、不相加`
    : undefined;

  return (
    <div className="flex w-full min-w-0 items-baseline gap-3 text-xs text-text-tertiary">
      {usage ? (
        <span data-testid="message-usage" title={usageTitle} className="min-w-0 truncate">
          {line}
        </span>
      ) : null}
      {time ? (
        <span className="ml-auto shrink-0" title={formatFullTimestamp(timestamp ?? 0)}>
          {time}
        </span>
      ) : null}
    </div>
  );
}
