import type {
  Message,
  MessageRole,
  Session,
  SessionSummary,
  TokenUsage,
} from "./types";

/**
 * mock 会话数据。
 *
 * 为什么这样组织：本阶段是纯前端原型，所有内容都来自这里。验收脚本按本文件里的
 * Block 内容逐条断言（见 .plan/task-M2.md 第九节 9.1 的「mock 会话数据的内容规格」），
 * 所以 7 条消息的 Block 构成是**冻结的验收输入**，改动会直接让验收脚本挂掉。
 *
 * 时间轴用固定基准（而非 Date.now()）：验收要可复跑，时间戳必须稳定可比对，
 * 用 Date.now() 会让「时间戳升序」这类断言失去确定性。
 */

/** 固定基准时刻：2026-09-22 10:00:00 UTC，每条消息递增 60s */
const BASE_TS = Date.UTC(2026, 8, 22, 10, 0, 0);
const STEP_MS = 60_000;

/** 超长不可断字符串（≥120 字符，验收 2-18 故意制造横向溢出风险）。
 *  必须定义在 INITIAL_SESSION_MESSAGES 之前（const 的暂时性死区）。 */
const LONG_HASH =
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" +
  "b9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

/** 构建步骤的中文标签（仅供第 4 条终端输出使用） */
function stepLabel(i: number): string {
  const labels = [
    "解析依赖图",
    "编译适配器层",
    "生成类型映射",
    "拉取 SDK 元信息",
    "校验工具清单",
    "注入事件总线",
    "生成绑定代码",
    "执行预检脚本",
    "打包渲染产物",
    "生成 sourcemap",
    "写入产物清单",
    "清理临时文件",
    "压缩资源",
    "拷贝静态资源",
    "注入版本号",
    "生成变更日志",
    "执行单元测试",
    "生成覆盖率报告",
    "上传构建缓存",
    "完成",
  ];
  return labels[i] ?? `步骤 ${i + 1}`;
}

function md(content: string): { type: "text"; content: string } {
  return { type: "text", content };
}

/* ---------------------------------------------------------------------------
 * 默认会话的 7 条消息（按顺序）
 * ------------------------------------------------------------------------- */

const INITIAL_SESSION_MESSAGES: Message[] = [
  // 1 · user · 普通短句
  {
    id: "m1",
    role: "user",
    timestamp: BASE_TS + 0 * STEP_MS,
    blocks: [md("帮我调研一下怎么把 Pi 工具链接进我们的桌面 Agent。")],
  },

  // 2 · assistant · thinking + text（text 必须覆盖七项 markdown）
  {
    id: "m2",
    role: "assistant",
    timestamp: BASE_TS + 1 * STEP_MS,
    blocks: [
      {
        type: "thinking",
        content:
          "先拆解问题：Pi 的工具链通过 `createAgentSession()` 暴露，事件流需要映射到我们的 `Block` 模型。重点在适配层，而不是重写 UI。",
        collapsed: false,
      },
      md(
        [
          "## 调研结论",
          "",
          "先说结论：接入可以分成三步，且**不需要改动现有 UI 组件**。",
          "",
          "1. 在 `AgentOptions` 里声明要暴露的工具清单",
          "2. 用 `createAgentSession()` 建立一次会话",
          "3. 把 Pi 的事件流逐条映射成我们的 `Block` 类型",
          "",
          "核心依赖只有两个：",
          "",
          "- `@pi-coding-agent/sdk`（官方 SDK）",
          "- 一个轻量适配层（约 200 行）",
          "",
          "下面是一段最小可运行的示例：",
          "",
          "```ts",
          'import { createAgentSession } from "@pi-coding-agent/sdk";',
          "",
          "const session = createAgentSession({ tools: [\"read\", \"bash\"] });",
          'session.on("message_update", (event) => render(event));',
          "```",
          "",
          "参数对照如下：",
          "",
          "| 字段 | 含义 | 是否必填 |",
          "| --- | --- | --- |",
          "| tools | 工具清单 | 是 |",
          "| model | 模型标识 | 否 |",
          "| mcp | MCP 服务器列表 | 否 |",
          "",
          "更完整的说明见 [Pi 官方文档](https://example.com/pi-docs)。",
        ].join("\n"),
      ),
    ],
  },

  // 3 · assistant · plan + tool_call（plan 四态齐全）
  {
    id: "m3",
    role: "assistant",
    timestamp: BASE_TS + 2 * STEP_MS,
    blocks: [
      {
        type: "plan",
        steps: [
          { id: "p1", title: "读取现有 package.json 与依赖", status: "done" },
          { id: "p2", title: "安装 @pi-coding-agent/sdk", status: "running" },
          { id: "p3", title: "生成适配层代码", status: "pending" },
          { id: "p4", title: "跑通冒烟测试", status: "failed" },
        ],
      },
      {
        type: "tool_call",
        toolCallId: "tc-install",
        toolName: "bash",
        args: { command: "npm install @pi-coding-agent/sdk" },
        status: "running",
      },
    ],
  },

  // 4 · assistant · terminal（success，输出超过 TERMINAL_MAX_LINES，截断）
  {
    id: "m4",
    role: "assistant",
    timestamp: BASE_TS + 3 * STEP_MS,
    blocks: [
      {
        type: "terminal",
        toolCallId: "tc-build",
        command: "pi-agent build --target desktop",
        status: "success",
        exitCode: 0,
        // 20 行输出，超过 TERMINAL_MAX_LINES(12)，故 truncated + hiddenLineCount = 8
        output: Array.from({ length: 20 }, (_, i) => `[${i + 1}/20] ${stepLabel(i)}`).join("\n"),
        truncated: true,
        hiddenLineCount: 8,
      },
    ],
  },

  // 5 · assistant · approval（未决）
  {
    id: "m5",
    role: "assistant",
    timestamp: BASE_TS + 4 * STEP_MS,
    blocks: [
      {
        type: "approval",
        requestId: "req-1",
        title: "允许执行依赖安装？",
        message: "将在项目中安装 @pi-coding-agent/sdk 及其依赖（约 12 个包）。",
        options: ["允许", "拒绝"],
        resolved: "",
      },
    ],
  },

  // 6 · user · 普通短句
  {
    id: "m6",
    role: "user",
    timestamp: BASE_TS + 5 * STEP_MS,
    blocks: [md("好，那就继续，先把依赖装上。")],
  },

  // 7 · assistant · text（含超长不可断字符串）+ terminal（error）
  {
    id: "m7",
    role: "assistant",
    timestamp: BASE_TS + 6 * STEP_MS,
    blocks: [
      md(
        [
          "安装过程中校验失败，下面是完整校验和（单行不可断，用于验证长文本不撑破容器）：",
          "",
          "sha256:" + LONG_HASH,
          "",
          "请确认该哈希与发布页一致后再重试。",
        ].join("\n"),
      ),
      {
        type: "terminal",
        toolCallId: "tc-verify",
        command: "npx tsc --noEmit",
        status: "error",
        exitCode: 1,
        output: [
          "src/adapter.ts(12,3): error TS2322: Type 'Block' is not assignable to type 'MessageBlock'.",
          "src/adapter.ts(18,7): error TS2304: Cannot find name 'render'.",
          "Found 2 errors. Build aborted.",
        ].join("\n"),
        truncated: false,
      },
    ],
  },
];

/** 01 屏默认会话标题（与侧边栏历史会话首项一致） */
export const INITIAL_SESSION_TITLE = "接入 Pi 工具链的调研";

/** 空会话标题（`?empty=1` 入口，验收 5-7 空状态用） */
export const EMPTY_SESSION_TITLE = "新建会话";

/**
 * 空会话：0 条消息。
 *
 * 用途：验收 5-7「空状态不塌陷」需要**可复现**的空会话入口，
 * 由 `App.tsx` 的 `?empty=1` 参数载入（与 `?stress=N` 同理做成正式能力）。
 * 不做成「手动删数据」是因为验收必须能反复跑。
 */
export const EMPTY_SESSION: Session = {
  id: "session-empty",
  title: EMPTY_SESSION_TITLE,
  updatedAt: BASE_TS,
  messages: [],
};

/** 默认会话 —— 严格按规格的 7 条消息顺序与 Block 构成 */
export const INITIAL_SESSION: Session = {
  id: "session-0",
  title: INITIAL_SESSION_TITLE,
  updatedAt: BASE_TS + 6 * STEP_MS,
  messages: INITIAL_SESSION_MESSAGES,
};

/**
 * 历史列表相对时间的固定「现在」锚点：BASE 后 3h6m ——
 * session-0（BASE+6min）距它恰好 3 小时，元信息行显示「3小时前」。
 * 相对时间必须锚定在固定时刻而不是真实时钟，验收证据才可复跑。
 */
export const SESSION_LIST_NOW = BASE_TS + 186 * STEP_MS;

/**
 * 侧边栏历史会话列表（首项即默认会话，其余为演示项）。
 * 展示形态（2026-09-22 用户裁决，参考会话列表样式）：标题一行 + 「相对时间 N 条消息」一行。
 */
export const SESSION_SUMMARIES: SessionSummary[] = [
  { id: "session-0", title: INITIAL_SESSION_TITLE, updatedAt: BASE_TS + 6 * STEP_MS, messageCount: 7 },
  { id: "session-demo-1", title: "重构执行计划卡片", updatedAt: BASE_TS - 300 * STEP_MS, messageCount: 292 },
  { id: "session-demo-2", title: "修复深色模式对比度", updatedAt: BASE_TS - 960 * STEP_MS, messageCount: 63 },
  { id: "session-demo-3", title: "整理 MCP 服务器配置", updatedAt: BASE_TS - 1140 * STEP_MS, messageCount: 100 },
  { id: "session-demo-4", title: "梳理窗口壳跨平台差异", updatedAt: BASE_TS - 1200 * STEP_MS, messageCount: 102 },
  { id: "session-demo-5", title: "终端输出截断策略", updatedAt: BASE_TS - 1320 * STEP_MS, messageCount: 112 },
  { id: "session-demo-6", title: "虚拟滚动性能回归", updatedAt: BASE_TS - 1680 * STEP_MS, messageCount: 217 },
  { id: "session-demo-7", title: "技能列表分类方案", updatedAt: BASE_TS - 2700 * STEP_MS, messageCount: 132 },
];

/** 初始 Token 用量（设计稿第 5 轮定稿的四个展示值，验收 2-13/2-14 用 formatCompact 呈现） */
export const INITIAL_TOKEN_USAGE: TokenUsage = {
  input: 12400,
  output: 6200,
  total: 18600,
  contextWindow: 128000,
};

/**
 * 压力测试会话：生成**恰好 count 条**轻量消息，用于验收 2-2「虚拟滚动生效」。
 *
 * 为什么只塞轻量文本、混少量 tool_call / terminal（不带大段输出/代码块）：
 * 验收要量的是「虚拟滚动渲染节点数 ≪ 总数」，如果每条都很重，量到的就是渲染性能
 * 而不是虚拟滚动本身。App.tsx 通过 `?stress=N` 触发本函数。
 */
export function createStressSession(count: number): Session {
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    const role: MessageRole = i % 2 === 0 ? "user" : "assistant";
    const ts = BASE_TS + (1000 + i) * STEP_MS;
    if (role === "user") {
      messages.push({
        id: `stress-user-${i}`,
        role,
        timestamp: ts,
        blocks: [{ type: "text", content: `压测消息 #${i + 1}：这是一条用于验证虚拟滚动的轻量文本。` }],
      });
    } else if (i % 5 === 1) {
      // 偶发工具调用，但保持轻量（不喂大段输出）
      messages.push({
        id: `stress-assistant-${i}`,
        role,
        timestamp: ts,
        blocks: [
          { type: "text", content: `压测消息 #${i + 1}：调用一个工具。` },
          {
            type: "tool_call",
            toolCallId: `tc-${i}`,
            toolName: "read",
            args: { path: `/src/module-${i}.ts` },
            status: "success",
          },
        ],
      });
    } else {
      messages.push({
        id: `stress-assistant-${i}`,
        role,
        timestamp: ts,
        blocks: [{ type: "text", content: `压测消息 #${i + 1}：这是助手的一条较短回复，用于撑高列表。` }],
      });
    }
  }
  return {
    id: "session-stress",
    title: `压力测试 · ${count} 条消息`,
    updatedAt: BASE_TS + (1000 + count) * STEP_MS,
    messages,
  };
}
