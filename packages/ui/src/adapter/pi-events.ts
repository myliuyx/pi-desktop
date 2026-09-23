/**
 * Agent 事件协议 —— 直接 re-export 自 `packages/core/src/contract.ts`（C0 契约提升）。
 *
 * 设计纪律（S4 决策 + C0）：
 * 1. UI 不依赖 `pi-coding-agent`（Node 包），打包干净；
 * 2. 与 mock 数据同构 → 验收脚本不用 core 也能跑 mock 回归；
 * 3. Pi 升级导致事件形状变化时，改动被关在 core 里。
 *
 * 由 `packages/core` 把 Pi 事件翻译成这里（契约）的形状再下发。
 * 字段来源见 `.plan/survey/S1-event-mapping.md`。
 */

export type {
  AgentContentPart,
  AgentMessageRole,
  AgentMessage,
  AgentEvent,
} from "../../../core/src/contract.ts";
