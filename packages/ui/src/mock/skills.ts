/**
 * 04 屏 · 技能与工具 的 mock 数据。
 *
 * 为什么单独成文件（而不是塞进 composer.ts / types.ts）：
 * - `composer.ts` 是「输入区与统计」这条线，与技能/工具清单无关；
 * - `types.ts` 是 M2 的**冻结契约**，M4 不得改它的既有字段。
 * 因此本文件自包含类型定义，只在确实对应 Pi 既有概念时复用已冻结的类型。
 *
 * ⚠️ 04 屏的 MCP 区块是**自建能力的展示位** —— Pi 不内置 MCP。
 * 数据直接复用 `mock/composer.ts` 的 `COMPOSER_MCP_SERVERS`，不再另造一份，
 * 避免屏幕之间出现两份"连接到不同服务器"的假象（见 task-M4.md 第一节第 6 点）。
 */

import type { McpServer, ThinkingLevel } from "./types";

/** 技能 / 命令分类 —— 字面对齐 Pi 的 `get_commands` 三类返回值 */
export type SkillCategory = "extension" | "prompt" | "skill";

/** 单条技能条目 */
export interface SkillEntry {
  id: string;
  name: string;
  /** 一行描述 */
  description: string;
  /** 来源标记（可选）：扩展包名 / 内置 / 用户目录 */
  source?: string;
}

export interface SkillGroup {
  category: SkillCategory;
  /** 分组小标题 */
  label: string;
  /** 一句话说明这一类是什么 */
  note: string;
  entries: SkillEntry[];
}

/**
 * 三类技能分组 —— **顺序即 04 屏的渲染顺序**，三类都必须有非空数据（验收 4-2 的核心）。
 *
 * 为什么三个分组同时可见、不做 Tab 切换：验收 4-2 要求脚本「在一次页面加载里读到三类」，
 * Tab 切换会让其中两类不在 DOM 里，脚本必须模拟点击才能读全 —— 那是把验收项的判定
 * 依赖到交互步骤上，脆弱且偏离「分类对应三类」的本意（见 task-M4.md 4.2 ①）。
 */
export const SKILL_GROUPS: SkillGroup[] = [
  {
    category: "extension",
    label: "扩展",
    note: "Pi 的 extension —— 可挂载 UI 与自定义事件处理器的插件",
    entries: [
      {
        id: "ext-desktop-shell",
        name: "desktop-shell",
        description: "提供跨平台窗口壳能力，注入 mac / win / linux 三端标题栏",
        source: "@agent/ext-desktop-shell",
      },
      {
        id: "ext-preview-pane",
        name: "preview-pane",
        description: "把生成的 HTML 产物渲染进右侧预览区（沙箱 iframe）",
        source: "@agent/ext-preview-pane",
      },
      {
        id: "ext-token-meter",
        name: "token-meter",
        description: "实时汇总输入 / 输出 / 上下文用量，供工具条展示",
        source: "@agent/ext-token-meter",
      },
    ],
  },
  {
    category: "prompt",
    label: "提示词",
    note: "Pi 的 prompt —— 以斜杠命令触发的预置提示词模板",
    entries: [
      {
        id: "prompt-research",
        name: "/research",
        description: "对指定主题做多源调研并输出结论，附引用来源",
        source: "内置",
      },
      {
        id: "prompt-refactor",
        name: "/refactor",
        description: "按给定目标重构选中文件，保持既有测试全绿",
        source: "内置",
      },
      {
        id: "prompt-review",
        name: "/review",
        description: "审查当前改动，按 Blocker / Major / Minor 分级列出问题",
        source: "用户目录",
      },
      {
        id: "prompt-plan",
        name: "/plan",
        description: "先产出分步执行计划，等确认后再动手",
        source: "内置",
      },
    ],
  },
  {
    category: "skill",
    label: "技能",
    note: "Pi 的 skill —— 带独立说明文档与脚本的可复用能力包",
    entries: [
      {
        id: "skill-design-tokens",
        name: "design-tokens",
        description: "审计语义令牌的深浅覆盖与对比度，输出未达标清单",
        source: "用户目录",
      },
      {
        id: "skill-browser-verify",
        name: "browser-verify",
        description: "用真实浏览器打开本地页面，截图并断言 DOM 状态",
        source: "用户目录",
      },
      {
        id: "skill-cn-check",
        name: "cn-check",
        description: "校验 className 合并函数的冲突分组是否正确",
        source: "项目内",
      },
    ],
  },
];

/* ---------------------------------------------------------------------------
 * 工具 allowlist —— 对齐 Pi 的 `tools`
 * ------------------------------------------------------------------------- */

/** 工具清单项（图标不进数据，由组件侧按名映射，避免数据文件依赖 React 组件） */
export interface ToolEntry {
  name: ToolName;
  label: string;
  description: string;
  /** 该工具的权限语义说明，供 G7 可读名称与走查使用 */
  hint: string;
}

/** Pi 的 `tools` allowlist 四个工具名 */
export type ToolName = "read" | "bash" | "edit" | "write";

/**
 * 四个工具的渲染顺序 —— 与 Pi 的 allowlist 惯用顺序一致（读 → 执行 → 改 → 写）。
 * 图标映射写在 `SkillsScreen.tsx`（read→FileText / bash→Terminal / edit→Pencil / write→Package）。
 */
export const TOOL_ENTRIES: ToolEntry[] = [
  {
    name: "read",
    label: "读取文件",
    description: "读取工作目录内的文件内容，用于理解现有代码",
    hint: "允许 Agent 读取工作目录内的文件",
  },
  {
    name: "bash",
    label: "执行命令",
    description: "在工作目录下执行 shell 命令，含构建与测试",
    hint: "允许 Agent 执行 shell 命令",
  },
  {
    name: "edit",
    label: "编辑文件",
    description: "对已存在的文件做局部替换，不整体重写",
    hint: "允许 Agent 编辑已存在的文件",
  },
  {
    name: "write",
    label: "写入文件",
    description: "新建文件或整体覆盖写入",
    hint: "允许 Agent 创建与覆盖写入文件",
  },
];

/**
 * 工具开关默认值：**四个全开**。
 *
 * 为什么全开而不是默认关掉 bash：Pi 的默认 allowlist 就是这四个都可用，
 * 原型阶段保持与 Pi 默认一致，走查时不会出现「功能看起来坏了」的误导。
 * 真实接入后这里会换成读 `SettingsManager` 的持久化值。
 */
export const DEFAULT_ENABLED_TOOLS: Record<ToolName, boolean> = {
  read: true,
  bash: true,
  edit: true,
  write: true,
};

/** 04 屏 MCP 区块的自建能力说明（这句话是给后来接 Pi 的人看的，别省） */
export const MCP_NOTE =
  "MCP 是本项目的自建能力 —— Pi 不内置 MCP。此区块展示我们自行实现的服务器接入位，接入 Pi 时需在本项目侧维护。";

/** 04 屏使用的 MCP 服务器清单（复用 composer.ts 的同一份数据） */
export type { McpServer };

/** 技能分类的展示元信息（标题图标名走 icons.tsx 的 ICON_INVENTORY 既有图标） */
export const SKILL_CATEGORY_LABEL: Record<SkillCategory, string> = {
  extension: "扩展",
  prompt: "提示词",
  skill: "技能",
};

/** 思考强度档位的类型再导出，方便 05 屏引用而不必直接依赖 types.ts */
export type { ThinkingLevel };
