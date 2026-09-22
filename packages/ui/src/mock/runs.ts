/**
 * 03 屏 · 运行详情 的 mock 数据。
 *
 * 为什么单独成文件：`sessions.ts` 是 01 屏的消息流数据（验收脚本按它的 Block 构成逐条断言，
 * 属冻结的验收输入），运行详情是另一个视角的同一批事实，混在一起会让 01 屏的回归变脆弱。
 *
 * ★ 四态齐全（验收 4-1）：mock 里必须同时存在 done / running / pending / failed 四种
 *   `PlanStepStatus`，否则验收脚本找不到对应 `data-status` —— 这一点与 PlanCard 的
 *   四态要求同性质（见 PlanCard 注释）。
 *
 * 耗时由本文件直接给出（字符串），组件侧不做运算 —— task-M4.md 4.1 明确规定
 * 「由 mock 数据直接给，不要在组件里做格式化逻辑之外的运算」。
 *
 * 展开态的富内容直接内嵌 `TerminalBlock` / `PlanBlock`，展开时原样喂给
 * `TerminalCard` / `PlanCard`（screens.md 03 屏的硬要求：「数据复用 TerminalCard 与
 * PlanCard 的组件，只是排布不同」）。
 */

import type { PlanBlock, PlanStepStatus, TerminalBlock } from "./types";

/** 03 屏一次运行的步骤 */
export interface RunStep {
  id: string;
  /** 步骤序号，从 1 开始（渲染时直接展示） */
  index: number;
  title: string;
  status: PlanStepStatus;
  /** 耗时文本（如 "1.2s" / "340ms"），由 mock 直接给 */
  duration: string;
  /** 输入摘要（一行，超出截断） */
  input: string;
  /** 输出摘要（一行，超出截断） */
  output: string;
  /**
   * 展开后的完整结果。
   *
   * 二选一的富内容：命令类步骤给 `TerminalBlock`（渲染成 TerminalCard），
   * 计划类步骤给 `PlanBlock`（渲染成 PlanCard）。两者都不给时展开区渲染纯文本输出。
   */
  detailTerminal?: TerminalBlock;
  detailPlan?: PlanBlock;
  /** 没有富内容时的纯文本完整输出 */
  detailText?: string;
}

/** 运行标题与汇总 */
export interface RunSummary {
  title: string;
  /** 总耗时文本（求和不精确到毫秒级，直接给汇总值） */
  totalDuration: string;
}

export const RUN_SUMMARY: RunSummary = {
  title: "接入 Pi 工具链的调研 · 运行 #1",
  totalDuration: "12.4s",
};

/**
 * 步骤清单 —— **四态齐全**，且顺序即时间轴顺序。
 *
 * 刻意把 failed 放在倒数第二步、running 放中间：这样时间轴的连接线既穿过已完成的段、
 * 也穿过进行中的段，走查时能一眼看出状态色是否映射正确。
 */
export const RUN_STEPS: RunStep[] = [
  {
    id: "step-1",
    index: 1,
    title: "读取项目依赖清单",
    status: "done",
    duration: "340ms",
    input: "package.json · pnpm-lock.yaml",
    output: "解析出 42 个直接依赖、3 个工作区包",
    detailText: [
      "读取到的工作区结构：",
      "  packages/ui         → @agent/ui",
      "  packages/core       → @agent/core",
      "  packages/pi-adapter → @agent/pi-adapter",
      "",
      "直接依赖 42 个（其中 devDependencies 18 个），未发现重复声明。",
    ].join("\n"),
  },
  {
    id: "step-2",
    index: 2,
    title: "解析 Pi 的 get_commands 能力清单",
    status: "done",
    duration: "1.2s",
    input: "get_commands()",
    output: "返回 extension / prompt / skill 三类，共 10 条",
    detailPlan: {
      type: "plan",
      steps: [
        { id: "sp-1", title: "拉取 extension 列表（3 条）", status: "done" },
        { id: "sp-2", title: "拉取 prompt 列表（4 条）", status: "done" },
        { id: "sp-3", title: "拉取 skill 列表（3 条）", status: "done" },
        { id: "sp-4", title: "按类别归档并去重", status: "done" },
      ],
    },
  },
  {
    id: "step-3",
    index: 3,
    title: "校验工具 allowlist 是否与 Pi 默认一致",
    status: "running",
    duration: "—",
    input: "tools: read / bash / edit / write",
    output: "正在比对 4 个工具的权限声明…",
    detailPlan: {
      type: "plan",
      steps: [
        { id: "tl-1", title: "读取本地 tools 配置", status: "done" },
        { id: "tl-2", title: "与 Pi 默认 allowlist 逐项比对", status: "running" },
        { id: "tl-3", title: "输出差异清单", status: "pending" },
      ],
    },
  },
  {
    id: "step-4",
    index: 4,
    title: "生成适配层代码",
    status: "done",
    duration: "4.8s",
    input: "packages/pi-adapter/src/adapter.ts",
    output: "生成 186 行事件映射代码，含 3 个映射函数",
    detailTerminal: {
      type: "terminal",
      toolCallId: "tc-m4-generate",
      command: "node scripts/gen-adapter.mjs --from pi-events.json",
      status: "success",
      exitCode: 0,
      output: [
        "[1/6] 读取 pi-events.json                    ok",
        "[2/6] 生成 text_delta → TextBlock 映射        ok",
        "[3/6] 生成 thinking_delta → ThinkingBlock 映射 ok",
        "[4/6] 生成 tool_execution_* → TerminalBlock   ok",
        "[5/6] 生成 extension_ui_request → Approval    ok",
        "[6/6] 写入 packages/pi-adapter/src/adapter.ts ok",
        "",
        "产物：186 行 · 3 个导出函数 · 0 个类型错误",
      ].join("\n"),
      truncated: false,
    },
  },
  {
    id: "step-5",
    index: 5,
    title: "执行适配层类型检查",
    status: "failed",
    duration: "6.1s",
    input: "tsc --noEmit -p tsconfig.adapter.json",
    output: "2 个类型错误：Block 不可赋值给 MessageBlock",
    detailTerminal: {
      type: "terminal",
      toolCallId: "tc-m4-typecheck",
      command: "npx tsc --noEmit -p tsconfig.adapter.json",
      status: "error",
      exitCode: 1,
      output: [
        "src/adapter.ts(12,3): error TS2322: Type 'Block' is not assignable to type 'MessageBlock'.",
        "  Type 'PlanBlock' is missing the following properties from type 'MessageBlock': messageId, createdAt",
        "src/adapter.ts(42,11): error TS2304: Cannot find name 'mapThinking'.",
        "",
        "Found 2 errors in the same file, starting at: src/adapter.ts:12",
      ].join("\n"),
      truncated: false,
    },
  },
  {
    id: "step-6",
    index: 6,
    title: "重跑完整构建与自检",
    status: "pending",
    duration: "—",
    input: "npm run build --workspaces",
    output: "等待上一步的修复结果",
  },
];

/* ---------------------------------------------------------------------------
 * 汇总（页面头展示）：从步骤数据推导，不另写一份数字
 * ------------------------------------------------------------------------- */

/** 步骤总数（验收 4-1 的 data-step-count 与 run-step 节点数必须与它一致） */
export const RUN_STEP_COUNT = RUN_STEPS.length;

/** 各状态计数（页面头汇总用） */
export const RUN_STATUS_COUNT: Record<PlanStepStatus, number> = RUN_STEPS.reduce(
  (acc, step) => {
    acc[step.status] += 1;
    return acc;
  },
  { done: 0, running: 0, pending: 0, failed: 0 } as Record<PlanStepStatus, number>,
);
