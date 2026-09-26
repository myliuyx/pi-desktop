import type { MessageUsage } from "@/mock/types";

/**
 * 消息底部逐条用量行（F2 · task-chat-feedback-and-usage.md §3.3）。
 *
 * 形态：assistant 消息块之后一行 12px 灰字（常显，决策 D1）：
 *   ↑1342 ↓286 · cache 45201 · cache write 1024
 * 2026-09-26 用户裁定：数字**全量展示**（不用 formatCompact 的 1.3k 缩写，如 1523）；
 * 「缓存读」标签定名 `cache`（「缓存写」同族 `cache write`，对齐 API 控制台惯例）。
 * cache 两项「有值才显示」（契约里 >0 才写）；精确数值与口径走原生 title 悬停（全仓惯例）。
 *
 * 口径（决策 D5）：cacheRead/cacheWrite 已含在 total 里，与 input 并列展示、**不相加** ——
 * tooltip 里写明，防「加起来对不上」的困惑。
 *
 * 渲染条件由数据天然保证：usage 只随 message_end 到达（reduce.ts），
 * 流式中 / 中止的消息没有 usage → 本组件返回 null，数字不会中途跳动、也不谎报。
 */
export function MessageFooter({ usage }: { usage?: MessageUsage }) {
  if (!usage) return null;

  const line = [
    `↑${usage.input}`,
    `↓${usage.output}`,
    ...(usage.cacheRead !== undefined ? [`cache ${usage.cacheRead}`] : []),
    ...(usage.cacheWrite !== undefined ? [`cache write ${usage.cacheWrite}`] : []),
  ].join(" · ");

  const detail = [
    `输入 ${usage.input.toLocaleString()}`,
    `输出 ${usage.output.toLocaleString()}`,
    ...(usage.cacheRead !== undefined ? [`cache ${usage.cacheRead.toLocaleString()}`] : []),
    ...(usage.cacheWrite !== undefined ? [`cache write ${usage.cacheWrite.toLocaleString()}`] : []),
  ].join(" · ");
  const title = `${detail} —— 缓存读写已含在总消耗 ${usage.total.toLocaleString()} 中，与输入并列显示、不相加`;

  return (
    <div data-testid="message-usage" title={title} className="min-w-0 truncate text-xs text-text-tertiary">
      {line}
    </div>
  );
}
