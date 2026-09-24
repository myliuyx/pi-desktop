/**
 * 05 屏 · 设置 的 mock 数据与默认值。
 *
 * 为什么单独成文件：
 * - `types.ts` 是 M2 的**冻结契约**，M4 不改它的既有字段；
 * - `composer.ts` 里的模型 / 思考强度清单是**已经在用的数据**，05 屏直接复用而非另造
 *   （另造必然出现「工具条显示 Opus、设置里显示 Sonnet」这类不一致）。
 *
 * ★ 字段对齐（验收 4-6）：Pi 的确切字段名一律取自
 *   `.plan/development-plan.md` 第三节 M4 与 `.plan/screens.md` 第二节 05 屏已写明的名字，
 *   不凭空发明。本文件的常量注释里标了每个名字的出处，便于复核。
 */

import type { ThinkingLevel } from "./types";

/**
 * 设置分组标识 —— 值即验收 4-5 要求的五组，**顺序即 UI 渲染顺序**。
 *
 * 为什么用字面量联合而不是 enum：验收脚本要读 `data-group` 的值做集合比对，
 * 字面量联合能在 TS 层保证组件不会写错字符串（写错即编译失败）。
 */
export type SettingsGroupId = "model" | "thinking" | "session" | "appearance" | "working-dir";

/** 分组定义（标题 + 说明 + 对齐说明） */
export interface SettingsGroupDef {
  id: SettingsGroupId;
  title: string;
  /** 分组级说明 */
  note: string;
}

/**
 * 五个分组 —— 顺序固定，与 `.plan/screens.md` 05 屏列出的
 * 「模型、思考强度、会话（自动压缩 / 自动重试）、外观（主题）、工作目录」一致。
 */
export const SETTINGS_GROUPS: SettingsGroupDef[] = [
  { id: "model", title: "模型", note: "选择本次会话使用的模型" },
  { id: "thinking", title: "思考强度", note: "控制模型的推理预算档位" },
  { id: "session", title: "会话", note: "长会话的自动处理策略" },
  { id: "appearance", title: "外观", note: "界面主题，深浅两套令牌同源" },
  { id: "working-dir", title: "工作目录", note: "Agent 可读写的工作区根路径" },
];

/* ---------------------------------------------------------------------------
 * 会话开关 —— 对齐 Pi 的 `SettingsManager`
 * ------------------------------------------------------------------------- */

/**
 * 会话开关的字段名。
 *
 * 出处：`.plan/development-plan.md` M4 完成判据 + `.plan/screens.md` 05 屏
 * 「字段对齐 Pi 的 `SettingsManager`」。名字取 `SettingsManager.autoCompact` 与
 * `SettingsManager.autoRetry`，与 task-M4.md 4.3 表中标注的完全一致。
 */
export type SessionSwitchField = "autoCompact" | "autoRetry";

export interface SessionSwitchDef {
  field: SessionSwitchField;
  label: string;
  description: string;
  /** UI 上可读到的「对齐 Pi」字段名（验收 4-6 依赖它出现在说明文本里） */
  piField: string;
}

export const SESSION_SWITCHES: SessionSwitchDef[] = [
  {
    field: "autoCompact",
    label: "自动压缩",
    description: "上下文接近上限时自动压缩历史，避免超出窗口被截断",
    piField: "SettingsManager.autoCompact",
  },
  {
    field: "autoRetry",
    label: "自动重试",
    description: "请求失败时自动重试一次，仍失败才报错给用户",
    piField: "SettingsManager.autoRetry",
  },
];

/** 会话开关默认值：两个都开（与 Pi 默认行为一致，接入后换成读持久化值） */
export const DEFAULT_SESSION_SWITCHES: Record<SessionSwitchField, boolean> = {
  autoCompact: true,
  autoRetry: true,
};

/* ---------------------------------------------------------------------------
 * 外观分组 —— 主题三段
 * ------------------------------------------------------------------------- */

/**
 * 主题三段的值。
 *
 * 前两个直接对应 `useUiStore` 的 `Theme`（"light" | "dark"），
 * `system` 对应 `themeSource: "system"` —— 切换必须走既有 `setTheme` / `syncSystemTheme`，
 * 不能自己改 `document.documentElement.dataset.theme`（那会绕过持久化，破坏"首帧前确定"）。
 */
export type ThemeOptionValue = "light" | "dark" | "system";

export interface ThemeOptionDef {
  value: ThemeOptionValue;
  label: string;
}

export const THEME_OPTIONS: ThemeOptionDef[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

/* ---------------------------------------------------------------------------
 * 对齐 Pi 的字段名（UI 上要能读到，验收 4-6）
 *
 * 这些字符串集中在 mock 里而不是散落在组件里，是为了让「对齐」这件事可核对：
 * 复核时只要看本文件与 Pi 文档的对照，不必翻遍 JSX。
 * ------------------------------------------------------------------------- */

export const PI_FIELD_NAMES = {
  /** 模型选择 → Pi 的 AgentOptions.model */
  model: "AgentOptions.model",
  /** 思考强度 → Pi 的 set_thinking_level */
  thinking: "set_thinking_level",
  /** 自动压缩 → Pi 的 SettingsManager.autoCompact */
  autoCompact: "SettingsManager.autoCompact",
  /** 自动重试 → Pi 的 SettingsManager.autoRetry */
  autoRetry: "SettingsManager.autoRetry",
  /** 工作目录 → Pi 的 AgentOptions.cwd */
  workingDir: "AgentOptions.cwd",
} as const;

/**
 * 工作目录的 **mock 展示占位** —— 仅 mock 形态下偏好未设置（`workingDir === null`）时
 * 用作显示回落；live 形态显示 core 的真实 cwd，与本值无关。
 *
 * ⚠️ 2026-09-24 裁决：「使用默认目录」**不再写回本值** —— 早先写回它会落盘一个
 * 不存在但很像真的偏好（`~` 路径在 Windows 上根本不存在）。现在「默认」= 清除偏好
 * （`ui-store.clearWorkingDir`），core 侧 `CORE_CWD` 缺省 ⇒ 回落 pi 自己的
 * `process.cwd()`。本值不进任何存储。
 *
 * ⚠️ 旧注释"与 Sidebar 的展示值保持一致"已于 2026-09-24 清理：那条早已过期 ——
 * Sidebar 当时的默认展示值是 `"~ / projects / atlas-agent"`（**带空格**），与此处
 * **不带空格**的值并不一致。现在两处统一收到 `useWorkingDirectoryView()` 一处解析。
 */
export const DEFAULT_WORKING_DIR = "~/projects/atlas-agent";

/* ---------------------------------------------------------------------------
 * 思考强度档位的显示顺序
 *
 * 档位取值复用 `mock/composer.ts` 的 `COMPOSER_THINKING_LEVELS`（工具条同一套），
 * 05 屏不另外定义一份，避免"设置里能选 off 但工具条不认"这类不一致。
 * ------------------------------------------------------------------------- */

/** 思考强度档位类型再导出（组件侧不必直接依赖 types.ts） */
export type { ThinkingLevel };
