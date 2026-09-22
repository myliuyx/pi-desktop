import { Fragment } from "react";
import { cn } from "@/lib/cn";
import { formatCompact } from "@/lib/format";
import { useChatStore } from "@/store/chat-store";

/**
 * TokenStats —— 输入区右下角的四段用量统计。
 *
 * 设计要点（见 task-M2.md 3.2 / 验收 2-13~2-16）：
 * - 四段顺序固定：输入 → 输出 → 消耗 → 上下文，段间用 1px 细分隔线。
 * - **只有「消耗」段用 `text-text-primary`**，其余三段用 `text-text-secondary`。
 *   验收脚本会现场注入 `text-text-primary` / `text-text-secondary` 探针元素比对计算色值，
 *   所以这里必须真的用这两个类，绝不能自己调亮度凑（见 3.2）。
 * - 数值格式化一律走 `formatCompact`（12.4k / 128k 那种），不得自行 toFixed。
 * - 容器 `bg-bg-subtle` 圆角，靠工具条里的 `composer-toolbar-spacer`（flex-1）推到右边，
 *   这里不要加 `ml-auto`，否则验收就看不到那个弹性占位节点了（见 3.2）。
 * - `shrink-0`：四段用量是关键信息，工具条宽度吃紧时**不许**被挤压换行——
 *   压力由模型名芯片吸收（Chip/ChipMenu 可收缩，文本省略号降级）。
 * - 标签随容器宽度显隐（≥690px 显示）：全内容自然宽 687.87px > 默认视口内宽
 *   632px，结构性放不下；窄容器只留数字+分隔线，语义走 title 悬停提示。
 */

interface Segment {
  /** 对应 token-stats-item-{key} 的 testid 片段 */
  key: "input" | "output" | "total" | "context";
  label: string;
  /** 是否高亮（仅「消耗」为 true） */
  highlight: boolean;
  /** 从 tokenUsage 取该段数值 */
  pick: (u: { input: number; output: number; total: number; contextWindow: number }) => number;
}

const SEGMENTS: Segment[] = [
  { key: "input", label: "输入", highlight: false, pick: (u) => u.input },
  { key: "output", label: "输出", highlight: false, pick: (u) => u.output },
  { key: "total", label: "消耗", highlight: true, pick: (u) => u.total },
  { key: "context", label: "上下文", highlight: false, pick: (u) => u.contextWindow },
];

export function TokenStats() {
  // tokenUsage 由 Agent A 的 store 在每次流式结束后更新（见 chat-store.ts）
  const usage = useChatStore((state) => state.tokenUsage);

  return (
    <div
      data-testid="token-stats"
      className="flex shrink-0 items-center rounded-lg bg-bg-subtle px-3 py-1.5 text-xs"
    >
      {SEGMENTS.map((seg, i) => (
        <Fragment key={seg.key}>
          {/* 段间细分隔线（首段之前不放，避免左侧多出一条） */}
          {i > 0 && (
            <div data-testid="token-stats-divider" className="mx-2 h-3 w-px shrink-0 bg-border-subtle" />
          )}
          <div
            data-testid={`token-stats-item-${seg.key}`}
            title={`${seg.label} ${formatCompact(seg.pick(usage))}`}
            className={cn(
              // 颜色只挂在这一层：验收脚本读 item 自身的 color 与探针比对
              "flex items-center gap-1",
              seg.highlight ? "text-text-primary" : "text-text-secondary",
            )}
          >
            {/*
             * 标签只在宽容器显示（@container 由 ComposerToolbar 根建立）。
             * 实测：全内容（4 段全带标签 + 三芯片全名）自然宽 687.87px，而默认视口
             * 工具条内宽只有 632px——不是挤挤就能放下的量级。标签砍掉后约省 110px，
             * 全部元素都能以自然宽度放下；语义由 item 的 title 悬停提示兜底。
             * 验收口径安全：2-13~2-15 断言的是 item 存在性 / 分隔线数 / 顺序 /
             * 数值（lastElementChild.textContent）与颜色，标签可见性不在断言内。
             */}
            <span className="hidden opacity-70 @min-[690px]:inline">{seg.label}</span>
            <span className="font-medium tabular-nums">{formatCompact(seg.pick(usage))}</span>
          </div>
        </Fragment>
      ))}
    </div>
  );
}
