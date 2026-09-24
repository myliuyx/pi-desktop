/**
 * Composer / 工具条的 mock 数据。
 *
 * 为什么独立成文件：这些选项（模型清单、思考强度档位、MCP 服务器）属于「输入区与统计」
 * 这条线，与 A 的会话数据（`sessions.ts`）解耦。原型阶段不接 Pi，全部写死在这里。
 *
 * 字段类型复用 `types.ts` 的冻结契约（ModelOption / McpServer / ThinkingLevel），
 * 下阶段接真数据时这些值直接换成接口返回即可。
 */

import type { McpServer, ModelOption, ThinkingLevel } from "./types";

/** 可选模型清单（工具条 ChipMenu 与 05 设置屏共用） */
export const COMPOSER_MODELS: ModelOption[] = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", provider: "Anthropic", supportsXhigh: true },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", provider: "Anthropic" },
  { id: "gpt-5", label: "GPT-5", provider: "OpenAI" },
  { id: "gemini-3-pro", label: "Gemini 3 Pro", provider: "Google" },
  { id: "deepseek-v3", label: "DeepSeek V3", provider: "DeepSeek" },
];

/**
 * 工具条模型菜单的**分组视图**（2026-09-22 用户反馈：按供应商归组，
 * 同供应商的模型统一进一个组 —— Anthropic 两款不再各自重复写供应商）。
 * 组序与组内序均为展示序，刻意从 COMPOSER_MODELS 派生而非另写一份 id，
 * 防止两处清单漂移；下阶段接 Pi 时换成按接口返回的 provider 字段 groupBy。
 */
export const COMPOSER_MODEL_GROUPS: { label: string; options: { value: string; label: string }[] }[] =
  Object.entries(
    COMPOSER_MODELS.reduce<Record<string, { value: string; label: string }[]>>((acc, m) => {
      (acc[m.provider] ??= []).push({ value: m.id, label: m.label });
      return acc;
    }, {}),
  ).map(([label, options]) => ({ label, options }));

/**
 * 工具条只暴露 Low / High / Max 三档（设计稿定稿）。
 * 类型保留全集（off / minimal / medium / xhigh …）是为了下阶段接 Pi 不改类型，
 * 但 UI 上只提供这三档（工具条 ChipMenu 与 05 设置屏同源）。
 */
export const COMPOSER_THINKING_LEVELS: ThinkingLevel[] = ["low", "high", "max"];

/**
 * 思考强度全集（对齐 Pi 的 `THINKING_LEVEL_OPTIONS`）。
 * live 形态下若 `GET /models` 尚未就绪（`availableThinkingLevels` 为空）时兜底，
 * 避免回落到写死的 3 档 —— Pi 在无 model 时同样返回全集。
 */
export const THINKING_LEVEL_OPTIONS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** 思考强度 → 展示文案（芯片里显示为「思考 Low」这类） */
export const THINKING_LABEL: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

/** 思考强度 → 菜单副行说明（工具条 ChipMenu 用；live 形态下档位动态，故需全集文案） */
export const THINKING_HINT: Record<ThinkingLevel, string> = {
  off: "关闭思考，直接回答",
  minimal: "极简思考，最省用量",
  low: "快速回答，几乎不思考",
  medium: "中等推理，平衡速度与深度",
  high: "均衡模式，日常任务首选",
  xhigh: "更强推理，处理复杂任务",
  max: "最强推理，更慢也更耗用量",
};

/** store 默认选中（ui-store M4 段引用；05 屏与工具条共用同一字段） */
export const INITIAL_MODEL_INDEX = 0;
export const INITIAL_THINKING_INDEX = 1; // 默认 High

/** 已连接的 MCP 服务器（芯片显示形如「MCP 4」） */
export const COMPOSER_MCP_SERVERS: McpServer[] = [
  { id: "fs", name: "FileSystem", status: "connected", toolCount: 6 },
  { id: "git", name: "Git", status: "connected", toolCount: 9 },
  { id: "db", name: "Database", status: "connected", toolCount: 4 },
  { id: "web", name: "WebSearch", status: "connected", toolCount: 3 },
];

/** 已连接 MCP 服务器数（芯片文案用） */
export const MCP_CONNECTED_COUNT = COMPOSER_MCP_SERVERS.filter((s) => s.status === "connected").length;
