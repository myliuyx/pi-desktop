import type { ModelsPayload } from "@/mock/types";

/**
 * 上下文占用环的**窗口分母**解析（2026-10-01 上下文环真值批次）。
 *
 * ## 为什么需要这个函数
 * 环此前直接读 `tokenUsage.contextWindow`，而该值在三处是 UI 侧的 mock 演示值
 * （`INITIAL_TOKEN_USAGE.contextWindow = 128000`）—— 屏幕上那个 `0% / 128k`
 * 里的 128k 就是它。真值（Pi 的 `Model.contextWindow`）只有 core 在 `usage` 事件里
 * 才下发，而 `usage` 事件要等**第一条 assistant 回复结束**，所以首屏与新建会话草稿态
 * 必然落在假值窗口期里。
 *
 * ## 三级优先级
 * 1. `usageContextWindow > 0` —— core 的 usage 事件 / 会话加载，最新且与实际请求
 *    用的是同一个模型，直接采用（模型切换后 core 会带新值，这里自动跟上）。
 * 2. `GET /models` 清单里**当前模型**的 `contextWindow` —— 覆盖"usage 事件还没来"
 *    的空窗期。清单是 UI 已有的 `models-store` 数据源（Composer 的模型芯片、
 *    粘图门控都在用它），不新增请求。
 * 3. 都取不到 → `0` = **未知**。这是本函数与渲染层之间的**不变量**：返回 `0` 时，
 *    环数值位渲染 `—`（`ComposerContextRing.tsx` 的 `known` / `valueText`），
 *    浮框上下文行渲染 `— / —`（`ComposerTokenPopover.tsx` 的 `knownContext` /
 *    `contextText`）。`0` 不是任何模型的真实窗口，把它当已知值渲染即假事实（D9）；
 *    回落成 `formatCompact(0)` 的 `0` 同样不允许。
 *
 * ## 为什么不回落任何默认值
 * 「窗口未知就显示 128k」正是本批次要根治的假事实（D9 纪律）。未知就是未知：
 * 显示一个精确到位的数字会让用户以为系统知道自己的模型窗口，从而不做压缩、
 * 不切模型，直到真被截断。未知的唯一诚实表达是「—」。
 */
export function resolveContextWindow(
  usageContextWindow: number | undefined,
  payload: ModelsPayload | null | undefined,
): number {
  if (typeof usageContextWindow === "number" && usageContextWindow > 0) return usageContextWindow;
  if (!payload?.current) return 0;
  const cur = payload.current;
  const active = payload.models.find((m) => m.provider === cur.provider && m.id === cur.modelId);
  return active?.contextWindow !== undefined && active.contextWindow > 0 ? active.contextWindow : 0;
}