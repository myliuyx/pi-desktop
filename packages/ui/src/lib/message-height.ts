/**
 * 虚拟列表的行高估算（2026-10-01 · 上滚回弹根治 · 第2 层）。
 *
 * ## 为什么需要它
 *
 * 虚拟滚动对**未渲染行**只能用 `estimateSize` 估算，滚动到该行时才由
 * `measureElement` 回填真实高度。总高因此会在"向上滚 → 新区域被测量"时缩水，
 * scrollTop 被浏览器连带拽动 —— 表现为往上滚着突然被弹回去（回弹）。
 *
 * 实测（本仓 dev server + stress=600 + live 真会话）真实行高分布：
 *
 * | 形态 | 角色 | 真实高度 | 旧估算值 | 误差 |
 * |---|---|---|---|---|
 * | stress=600 | user | 恒 97 | 140 | +43px/行 |
 * | stress=600 | assistant | 99 ~ 143（多短句） | 140 | 尚可 |
 * | live | user | 恒 97 | 140 | +43px/行 |
 * | live | assistant（含工具卡） | 99 ~ 464 | 140 | **−324px/行** |
 *
 * 固定 140 既高估短消息（stress 短句档每次滚动多退约 249px）又严重低估含工具卡 /
 * 代码块的长消息（464px 估成 140 ⇒ 每次滚动少走 324px）。两个方向的误差叠加，
 * 就是回弹手感。
 *
 * ## 策略：**实测值优先记忆化，其次按内容估算**
 *
 * ① **记忆化命中即返回实测高度**（`measureMessageHeights` / `rememberMessageHeight`）：
 *    消息只增不改，同一条消息的高度**永不变**⇒ 往返浏览同一区域可以做到
 *    **零误差、零跳变**。这是回弹的根治所在：绝大多数回看场景（用户往上翻之前看过的
 *    内容）走的就是这条路径。
 * ② 未命中则按 blocks 内容估算（见下方常量），尽量贴近真实值以压低首次进入的误差。
 *
 * 纯函数、零副作用（同 lib/turns.ts 纪律）：可被 scripts/message-height-check.mjs 直跑断言。
 * 类型只import。
 */

import type { Block, Message } from "../mock/types.ts";
import { TERMINAL_MAX_LINES } from "./layout.ts";

/* ---------------------------------------------------------------------------
 * 估算常量（全部来自实测，见文件头表格）
 * --------------------------------------------------------------------------- */

/**
 * 行内容基线高（px）—— 不含任何正文块。
 *
 * 实测反推（live 真会话）：行总高 − markdown-body 高恒为 **128px**（342−214、
 * 420−274、464−336 三例一致）。构成：MessageItem 的 gap-2(16) + 模型标签行(15)
 * + 折叠行(20) + 页脚时间(16) + 虚拟行 MESSAGE_GAP(20) + 块间距余量。
 *
 * 注：stress=600 的 user 行实测97px 比这低—— 那些行**无模型标签**（user 消息
 * 不渲染 ModelLabelRow）且无折叠行。下方按角色分别取值。
 */
const ROW_CHROME_ASSISTANT = 128;

/** user 行的基线（无模型标签行、无折叠行：stress 实测 97 − 单行文本 35 ≈ 62） */
const ROW_CHROME_USER = 62;

/**
 * 单行文本行高（px）—— `text-md` 14px × `leading-relaxed`(1.625) ≈ 22.75。
 *
 * 反推实测：markdown-body 214/274/336 三例分别 ≈ 9/12/14 行 × 22.75 + 12。
 */
const LINE_HEIGHT = 22.75;

/** 文本块的额外内边距（Markdown `p` 的 my-1.5 = 上下各 6px，合计 12） */
const TEXT_BLOCK_PADDING = 12;

/** 单行可容纳字符数（内容列 720px / 14px，约 50 字/行） */
const DEFAULT_CHARS_PER_LINE = 50;

/**
 * 工具调用卡片基线高（实测：py-2 内边距 + 图标 + 工具名 + 状态徽章行 ≈ 44px）。
 *
 * ⚠️ tool_call 与**配对的** terminal 块渲染成**同一张** ToolCallCard
 * （MessageList 的 BlockView 按 toolCallId 配对，terminal 不再单独出卡），
 * 所以两者不能各算一份高 —— 下方用 pairedTerminal 标记做去重。
 */
const TOOL_CARD_BASE = 44;

/** 工具卡每行输出/参数的高度 */
const TOOL_CARD_LINE = 20;

/** 终端块每行输出高度（font-mono text-xs + py-2 内边距 ≈ 20px） */
const TERMINAL_OUTPUT_LINE = 20;

/** 终端输出区基线（上边框 + 内边距） */
const TERMINAL_OUTPUT_BASE = 12;

// 注：代码块不单独估算—— markdown 里的 ``` 围栏已被当作 text 块的字符计入
// （Block契约里代码块不是独立 block 类型，见 contract.ts 的 Block 七型）。

/** 思考卡基线 */
const THINKING_BASE = 32;

/** 思考卡每行 */
const THINKING_LINE = 22;

/** 计划卡每步 */
const PLAN_STEP = 28;

/** 计划卡基线 */
const PLAN_BASE = 40;

/** 授权卡基线（授权卡有固定操作区） */
const APPROVAL_BASE = 96;

/** 图片块（历史缩略图 64px + 布局余量） */
const IMAGE_BASE = 80;

/** 估算下限：任何一行都不会比这更矮（与 stress 实测最小值 97 对齐） */
export const MIN_ESTIMATED_ROW_HEIGHT = 90;

/** 估算上限：超出则钳制（极端长回复防御，避免单行估算撑爆总高） */
export const MAX_ESTIMATED_ROW_HEIGHT = 4000;

/**
 * 估算一条消息的渲染高度（px）。
 *
 * 记忆化**不在**本函数内 —— 调用方（MessageList）先查记忆化再决定是否调本函数，
 * 这样本函数保持纯函数、可独立断言。
 *
 * @param message 目标消息
 * @param charsPerLine 单行可容纳的字符数（按内容列宽 720px / 字号估算；缺省 48）
 */
export function estimateMessageHeight(
  message: Message,
  charsPerLine = DEFAULT_CHARS_PER_LINE,
): number {
  // 基线按角色取：user 行没有模型标签与折叠行（实测低 66px）
  let height = message.role === "user" ? ROW_CHROME_USER : ROW_CHROME_ASSISTANT;

  /*
   * tool_call ↔ terminal 的配对集合：同一张 ToolCallCard 只应计一次高
   * （MessageList 的 BlockView 按 toolCallId 配对，terminal 不再单独出卡）。
   */
  const pairedTerminalIds = new Set<string>();
  for (const b of message.blocks) {
    if (b.type === "tool_call" && b.toolCallId) pairedTerminalIds.add(b.toolCallId);
  }

  for (const block of message.blocks) {
    switch (block.type) {
      case "text": {
        // 空壳 assistant（流式占位）几乎不占高度
        const len = block.content.trim().length;
        if (len === 0) break;
        const lines = Math.max(1, Math.ceil(len / charsPerLine));
        height += lines * LINE_HEIGHT + TEXT_BLOCK_PADDING;
        break;
      }
      case "thinking": {
        const lines = Math.max(1, Math.ceil(block.content.trim().length / charsPerLine));
        height += THINKING_BASE + lines * THINKING_LINE;
        break;
      }
      case "tool_call": {
        // 实测含工具卡的 assistant 行342~464。本块若已与 terminal 配对，
        // 终端输出的高度在 terminal分支计（避免同一张卡算两遍）。
        const paired = block.toolCallId !== undefined && pairedTerminalIds.has(block.toolCallId);
        const cmd = typeof block.args?.command === "string" ? block.args.command : "";
        const cmdLines = paired ? 0 : Math.max(1, cmd.split("\n").length);
        height += TOOL_CARD_BASE + cmdLines * TOOL_CARD_LINE;
        break;
      }
      case "terminal": {
        // ⚠️ 字段是 output（不是 content）—— 读错会让估算恒为终端基线，长输出低估严重
        // 输出区实测：px-3 py-2 内边距 + font-mono text-xs 每行 ≈ 20px，末尾行分隔符不算行
        const lines = Math.max(1, (block.output ?? "").split("\n").filter(Boolean).length);
        // 终端默认只展示 TERMINAL_MAX_LINES(12) 行（TerminalCard 的 truncateLines）
        height += TERMINAL_OUTPUT_BASE + Math.min(lines, TERMINAL_MAX_LINES) * TERMINAL_OUTPUT_LINE;
        break;
      }
      case "plan": {
        height += PLAN_BASE + Math.max(1, (block.steps?.length ?? 0)) * PLAN_STEP;
        break;
      }
      case "approval":
        height += APPROVAL_BASE;
        break;
      case "image":
        height += IMAGE_BASE;
        break;
      default:
        // 未穷举的块类型给一个中性值，不让总高偏小
        height += TOOL_CARD_BASE;
    }
  }

  return clamp(height);
}

function clamp(h: number): number {
  return Math.min(Math.max(Math.round(h), MIN_ESTIMATED_ROW_HEIGHT), MAX_ESTIMATED_ROW_HEIGHT);
}

/* ---------------------------------------------------------------------------
 * 实测高度记忆化
 *
 * 消息只增不改 ⇒ 同一条消息的渲染高度在会话生命周期内**恒定**。记住它就能让
 * 回看已浏览过的区域时零误差，这是回弹的根治路径（详见文件头策略 ①）。
 *
 * 用 messageId 作键（**不用索引**：切会话后索引会指向别的消息，实测正是
 * virtual-core 默认 getItemKey(i) 造成跨会话缓存污染）。
 * --------------------------------------------------------------------------- */

/** 已测得高度的记忆表：messageId → 真实高度 */
export type HeightMemory = Map<string, number>;

/** 单个记忆表的容量上限（超出后整体清空，避免长会话无限增长） */
export const HEIGHT_MEMORY_LIMIT = 800;

/** 新建记忆表 */
export function createHeightMemory(): HeightMemory {
  return new Map();
}

/** 查实测高度；未测量过返回 null */
export function rememberMessageHeight(memory: HeightMemory, id: string, height: number): void {
  if (memory.size >= HEIGHT_MEMORY_LIMIT) memory.clear();
  memory.set(id, Math.round(height));
}

/**
 * 取「该用于布局的高度」：有实测值用实测值，否则用估算值。
 *
 * 这是 MessageList 的 virtualizer `estimateSize` 直接调用的入口。
 *
 * @param memory 实测高度记忆表
 */
export function resolveRowHeight(
  memory: HeightMemory,
  message: Message | undefined,
  charsPerLine = DEFAULT_CHARS_PER_LINE,
): number {
  if (message) {
    const measured = memory.get(message.id);
    if (measured !== undefined) return clamp(measured);
  }
  return message ? estimateMessageHeight(message, charsPerLine) : MIN_ESTIMATED_ROW_HEIGHT;
}

/** 便捷：从 Block[] 估算（供纯函数断言直接用，不构造 Message） */
export function estimateBlocksHeight(blocks: Block[], charsPerLine = DEFAULT_CHARS_PER_LINE): number {
  return estimateMessageHeight(
    { id: "x", role: "assistant", blocks, timestamp: 0 } as Message,
    charsPerLine,
  );
}