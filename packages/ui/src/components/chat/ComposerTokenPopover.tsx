import { formatCompact, formatContextPercent, formatCost, formatThousands } from "@/lib/format";
import type { TokenUsage } from "@/mock/types";

/**
 * 环悬停浮框 —— Token 用量明细面板（task-context-ring-token-popover.md）。
 *
 * 参考图（另一 Agent 产品）的 Token 明细浮框：label 灰居左、数值右对齐 tabular-nums；
 * 上簇用量五行 + 费用，细分隔线后下簇上下文/命中率。数据口径是**会话累计**
 * （2026-10-01 主控裁决 D1：inputSum/outputSum/cacheReadSum/cacheWriteSum/costTotal，
 * 加总 = 总计）；旧形状 payload（m2 注入、未升级的 live）按 `?? 最近一次字段` 回退
 * 显示——数值仍真实，口径差异记录在契约字段注释里。
 *
 * 行显隐（缺省/0 整行隐藏，主控裁决 D3 同一纪律）：
 * - 缓存读取/缓存写入：0 或缺省隐藏（provider 无缓存时面板不挂空行）；
 * - 费用：costTotal 缺省或 ≤0 隐藏（模型没配单价时 pi 算出 0，常挂 `$0.0000` 是噪音）；
 * - 命中率：分母（input + cacheRead + cacheWrite，D2：写入也算未命中）为 0 或
 *   缓存全 0 隐藏；
 * - 缓存写入行参考图上没有，但 cacheWriteSum>0 时必须补——否则各行加总对不上总计
 *   （total = Σ totalTokens = Σ 四分量，实测 jsonl 样本吻合）。
 * - 上下文行：窗口未知（`contextWindow === 0`，本批次新增口径）或占用未知 → 整行显示
 *   「— / —」。此前窗口未知时仍会显示 `formatCompact(0)` 产出的 `0`，那是假事实
 *   （2026-10-01 上下文环真值批次）。
 *
 * 定位与 hover 桥（容器在 ComposerContextRing）：absolute bottom-full 向上弹，落在
 * 消息流区域内（同 ChipMenu 论证，不被 WorkspaceArea overflow-hidden 裁切）。
 * **不能用 margin 留缝**——视觉间距由位置容器的 padding（pb-2）顶出：padding 在
 * 元素盒内，指针穿过它仍是环 wrapper 的后代，不会触发父级 mouseleave；ChipMenu 的
 * mb-2 手法对点击菜单够用，对 hover 浮层会「移向面板穿过缝隙即消失」。
 */

/** 一行明细：label 灰居左，数值右对齐 tabular-nums（testid 供验收逐行断言） */
function Row({ testId, label, value }: { testId: string; label: string; value: string }) {
  return (
    <div data-testid={testId} className="flex items-baseline justify-between gap-6">
      <span className="text-xs text-text-tertiary">{label}</span>
      <span className="text-xs font-medium tabular-nums text-text-primary">{value}</span>
    </div>
  );
}

export function ComposerTokenPopover({
  usage,
  contextWindow,
}: {
  usage: TokenUsage;
  /** 已解析的窗口真值（`resolveContextWindow` 的结果）；0 = 未知 ⇒ 本行显示「— / —」 */
  contextWindow: number;
}) {
  // 累计口径优先，回退最近一次（决策 2）；cache 两项缺省按 0 参与命中率分母
  const input = usage.inputSum ?? usage.input;
  const output = usage.outputSum ?? usage.output;
  const cacheRead = usage.cacheReadSum ?? usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWriteSum ?? usage.cacheWrite ?? 0;
  const costTotal = usage.costTotal ?? 0;
  const hitDenominator = input + cacheRead + cacheWrite;
  const hitRate = cacheRead > 0 && hitDenominator > 0 ? (cacheRead / hitDenominator) * 100 : null;
  // 上下文行降级（决策 6：原 title 的「占用未知」说明由本行承担）：占用未知 → 百分比位显示 —
  // 窗口本身未知（本批次新增：usage 事件未到且模型清单没有该字段）→ 整个「X / Y」都显示 —
  const contextTokens = usage.contextTokens;
  const knownContext = contextTokens !== undefined && contextWindow > 0;
  const contextText = knownContext
    ? `${formatContextPercent((contextTokens / contextWindow) * 100)} / ${formatCompact(contextWindow)}`
    : `— / —`;

  return (
    /* 位置容器：pb-2 = 面板与环的视觉间距 + hover 桥（见文件头注释，勿改 margin） */
    <div className="absolute bottom-full left-0 z-20 pb-2">
      <div
        data-testid="composer-token-popover"
        role="tooltip"
        className="w-56 rounded-lg border border-border-default bg-bg-elevated p-3 shadow-lg"
      >
        <div className="text-xs font-semibold text-text-primary">Token</div>
        <div className="mt-2 flex flex-col gap-1">
          <Row testId="composer-token-row-input" label="输入" value={formatThousands(input)} />
          <Row testId="composer-token-row-output" label="输出" value={formatThousands(output)} />
          {cacheRead > 0 ? (
            <Row testId="composer-token-row-cache-read" label="缓存读取" value={formatThousands(cacheRead)} />
          ) : null}
          {cacheWrite > 0 ? (
            <Row testId="composer-token-row-cache-write" label="缓存写入" value={formatThousands(cacheWrite)} />
          ) : null}
          <Row testId="composer-token-row-total" label="总计" value={formatThousands(usage.total)} />
          {costTotal > 0 ? (
            <Row testId="composer-token-row-cost" label="费用" value={formatCost(costTotal)} />
          ) : null}
        </div>
        <div className="mt-2 flex flex-col gap-1 border-t border-border-subtle pt-2">
          <Row testId="composer-token-row-context" label="上下文" value={contextText} />
          {hitRate !== null ? (
            <Row
              testId="composer-token-row-hit-rate"
              label="平均缓存命中率"
              value={formatContextPercent(hitRate)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
