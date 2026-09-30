/**
 * mock 数据类型 —— 刻意对齐 Pi 的事件模型。
 *
 * ⚠️ C0 契约提升：Block 七型 / Message / SessionSummary / TokenUsage / PlanStepStatus
 * 已提升为 `packages/core/src/contract.ts` 的共享契约（UI 只 `import type` 它，
 * vite build 后 dist 不含 core/pi 痕迹）。本文件统一 re-export 契约类型，
 * 并保留 UI 侧专属类型（ThinkingLevel / McpStatus / ModelOption / McpServer）
 * 与运行时工具 `isBlock`。字段语义见 contract.ts 与 .plan/archive/survey/S1-event-mapping.md。
 */

export type {
  MessageRole,
  PlanStepStatus,
  ToolStatus,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  TerminalBlock,
  ApprovalBlock,
  PlanStep,
  PlanBlock,
  /* 2026-10-01 图片真缩略图批次：历史回放走元数据 + 按需取图（core 契约） */
  ImageBlock,
  Block,
  BlockType,
  Message,
  Session,
  SessionSummary,
  TokenUsage,
  MessageUsage,
  /* C4/C5 新增：会话加载结果与 04/05 屏载荷（core 契约，UI 只 import type） */
  SessionLoadResult,
  SessionLoadStats,
  ResourceEntry,
  ResourcesPayload,
  ModelInfo,
  ModelsPayload,
  ThinkingLevelName,
  /* C6 新增：04 屏工具开关载荷 */
  ToolsPayload,
  /* C7 新增：设置弹窗 · 技能 Tab 载荷（全量清单含禁用项 + 开关请求/结果） */
  SkillListItem,
  SkillsPayload,
  SkillToggleRequest,
  SkillToggleResult,
  /* S1-S2 新增：设置弹窗「添加技能」（搜索代理 + 克隆安装 + 进度事件） */
  SkillSearchEntry,
  SkillSearchPayload,
  SkillInstallRequest,
  SkillInstallResult,
  SkillProgressEvent,
  /* C8 新增：设置弹窗 · 插件 Tab 载荷（清单/开关/移除/安装/检查更新 + 进度事件） */
  PackageDetail,
  PackageInstallRequest,
  PackageInstallResult,
  PackageProgressEvent,
  PackageRemoveRequest,
  PackageRemoveResult,
  PackageResourceRef,
  PackageToggleRequest,
  PackageToggleResult,
  PackageUpdateEntry,
  PackageUpdateRequest,
  PackageUpdateResult,
  PackageUpdatesPayload,
  PackagesPayload,
  SessionReloadResult,
} from "../../../core/src/contract.ts";

import type { Block, BlockType } from "../../../core/src/contract.ts";

/**
 * Block 类型收窄。
 * 用途：`if (isBlock(block, "terminal")) { block.command }` —— 避免渲染层到处写 as 断言。
 */
export function isBlock<T extends BlockType>(block: Block, type: T): block is Extract<Block, { type: T }> {
  return block.type === type;
}

/* ---------------------------------------------------------------------------
 * 以下为 UI 侧专属类型（不在共享契约内）
 * ------------------------------------------------------------------------- */

/**
 * 思考强度 —— 取值直接对齐 Pi 的 `set_thinking_level`。
 * 设计稿工具条只暴露 Low / High / Max 三档，但类型保留全集，避免下阶段接真数据时改类型。
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** MCP 服务器连接状态 */
export type McpStatus = "connected" | "disconnected";

/** ← `get_available_models` */
export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  /** 只有支持的模型才暴露 xhigh / max 档位（对齐 Pi 的说明） */
  supportsXhigh?: boolean;
}

/** 自建能力的展示位 —— Pi 不内置 MCP */
export interface McpServer {
  id: string;
  name: string;
  status: McpStatus;
  toolCount: number;
}
