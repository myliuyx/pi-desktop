/**
 * 会话提问导航刻度栏的纯函数层（task-turn-rail.md）—— 把扁平 Message[] 折成
 * 「每次提问一个刻度」的导航锚点，并负责刻度的等比布局与预览文本的组装。
 *
 * 纯函数、零副作用（同 turns.ts / adapter/reduce.ts 的纪律）：输入确定、输出确定，
 * 可被 scripts/turn-rail-check.mjs 直跑断言。DOM / React 一概不碰 —— 挂载、悬停、
 * 跳转全部在 TurnRail / MessageList 组件层。
 *
 * 为什么锚点复用 groupTurns 而不是直接 filter(role === "user")：
 * 预览气泡要展示「该次提问对应的回答」（turn.tailIndex），轮次归属必须与
 * 「处理详情」折叠行（process-collapse 批次）走同一套口径 —— 两处各算一遍必漂移。
 */

import type { Message } from "../mock/types.ts";
import { groupTurns, type TurnGroup } from "./turns.ts";

/** 一个可导航的提问锚点：轮次 + 该轮 user 消息（刻度）的下标 */
export interface RailTurnAnchor {
  turn: TurnGroup;
  /** 该轮 user 消息在 messages 里的下标（= 虚拟行下标，跳转定位用） */
  anchorIndex: number;
}

/** 预览气泡的内容包（组件层按 hover 的刻度取用；timestamp 供悬停 title 给完整秒级时间） */
export interface RailPreview {
  /** 锚点消息的原始时间戳（epoch ms；0 = 缺失，时间行照「第 N 问」退化为仅序号） */
  timestamp: number;
  /** formatMessageTime 的产物（null = 不渲染时间段） */
  time: string | null;
  /** 问题摘要（注入文件块折成「📎 文件名」行，纯文本） */
  question: string;
  /** 回答摘要（尾条 assistant 最后一个非空 text 块；空串 = 尚无文本，组件层给占位） */
  answer: string;
}

/**
 * 收集导航锚点：groupTurns 的轮次里只取 **user 消息开头** 的轮。
 * 会话以 assistant 开头（无 user 头：压缩摘要 / 历史导入）的首段不是「提问」，
 * 不出刻度（规格书决策 4）。
 */
export function collectRailTurns(messages: Message[], scope: string): RailTurnAnchor[] {
  const anchors: RailTurnAnchor[] = [];
  for (const turn of groupTurns(messages, scope)) {
    if (messages[turn.startIndex]?.role !== "user") continue;
    anchors.push({ turn, anchorIndex: turn.startIndex });
  }
  return anchors;
}

/**
 * 刻度纵向位置：内容流位置 → 刻度栏像素位置（等比 minimap，规格书决策 3）。
 *
 * - 等比：`top = start / totalSize × railHeight` —— 位置本身携带「远近」线索；
 * - 最小间距：相邻刻度 < minGap 时自上而下顺次下推，短轮次扎堆不叠成一点；
 * - 溢出回退：minGap 铺开后超出刻度栏高度（极端多轮）→ 退化为均匀分布，
 *   **数量不裁剪**（规格书边界表：允许紧凑，不允许消失）。
 *
 * totalSize / railHeight 非正数（空内容 / 未挂载）一律返回同长全 0 —— 不炸、无 NaN。
 */
export function layoutTickTops(
  starts: number[],
  totalSize: number,
  railHeight: number,
  minGap: number,
): number[] {
  const n = starts.length;
  if (n === 0) return [];
  if (!(totalSize > 0) || !(railHeight > 0)) return starts.map(() => 0);
  const proportional = starts.map((s) =>
    Math.min(Math.max((s / totalSize) * railHeight, 0), railHeight),
  );
  const swept: number[] = [proportional[0]];
  for (let i = 1; i < n; i++) {
    swept.push(Math.max(proportional[i], swept[i - 1] + minGap));
  }
  if (swept[n - 1] <= railHeight) return swept;
  if (n === 1) return [Math.min(proportional[0], railHeight)];
  // 溢出回退：均匀分布（首 0 末 railHeight，中间等分），保证全部刻度可见
  return starts.map((_, i) => (railHeight * i) / (n - 1));
}

/**
 * 匹配 core expandFileRefs 的注入文件块。
 * ⚠️ 口径必须与 MessageBubble.tsx 的 INJECTED_FILE_BLOCK_RE 同步（同一份上游格式，
 * 两处各自消费：气泡折叠条 / 本预览）—— 改动时两处一起改。
 */
const INJECTED_FILE_BLOCK_RE = /<file name="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/file>\n?/g;

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * 预览文本组装（规格书决策 5）：
 * - 问题 = user 消息全部 text 块，注入文件块折成「📎 文件名」行（与气泡折叠条同口径；
 *   预览里不塞文件正文，否则预览会被文件内容淹没）；块间以换行衔接；
 * - 回答 = 尾条 assistant 消息**最后一个非空** text 块（最终答复；thinking / 工具卡
 *   不进预览 —— 过程内容的入口是「处理详情」折叠行，两处各司其职）。
 *
 * 纯文本输出（面板不进 Markdown）；截断带省略号；空串表示「无内容」，由组件层
 * 决定占位文案。时间不在这里组装 —— formatMessageTime 的 now 必须由组件边界传
 * （format.ts 同一条纪律），本函数保持可被脚本直跑复跑。
 */
export function buildPreviewTexts(
  userMsg: Message | undefined,
  tailMsg: Message | undefined,
  questionMaxChars: number,
  answerMaxChars: number,
): { question: string; answer: string } {
  const questionParts: string[] = [];
  if (userMsg) {
    for (const block of userMsg.blocks) {
      if (block.type !== "text") continue;
      const content = block.content;
      let last = 0;
      INJECTED_FILE_BLOCK_RE.lastIndex = 0;
      for (
        let m = INJECTED_FILE_BLOCK_RE.exec(content);
        m;
        m = INJECTED_FILE_BLOCK_RE.exec(content)
      ) {
        const text = content.slice(last, m.index).trim();
        if (text) questionParts.push(text);
        questionParts.push(`📎 ${basename(m[1] ?? "")}`);
        last = m.index + m[0].length;
      }
      const rest = content.slice(last).trim();
      if (rest) questionParts.push(rest);
    }
  }
  let answer = "";
  if (tailMsg) {
    for (let i = tailMsg.blocks.length - 1; i >= 0; i--) {
      const block = tailMsg.blocks[i];
      if (block.type === "text" && block.content.trim() !== "") {
        answer = block.content;
        break;
      }
    }
  }
  return {
    question: truncate(questionParts.join("\n"), questionMaxChars),
    answer: truncate(answer, answerMaxChars),
  };
}
