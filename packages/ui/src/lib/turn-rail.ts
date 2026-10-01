/**
 * 会话提问导航刻度栏的纯函数层（task-turn-rail.md）—— 把扁平 Message[] 折成
 * 「每次提问一个刻度」的导航锚点，并负责刻度的均匀槽位布局与预览文本的组装。
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
 * 刻度纵向位置：紧凑居中簇（task-turn-rail-compact-cluster.md，2026-09-29 第二次修订）。
 *
 * 刻度按固定档距 pitch（center-to-center）排成一簇，簇整体在栏内垂直居中：
 * `top = railHeight/2 + (i − (n−1)/2) × pitch` —— 位置不编码「内容远近」，刻度纯语义化
 * 为「第 N 问 of M」：不读 virtualizer 测量值，刻度列在会话内完全静止。
 *
 * 溢出压缩（数量不裁剪，沿用原边界原则）：(n−1) × pitch 超过栏高时档距压缩为
 * railHeight / (n−1)，退化为全高铺满；贴边刻度的 1px 探出由渲染层半高钳制兜底。
 *
 * 防御语义：n ≤ 0 → []；n > 0 且 railHeight ≤ 0（未挂载）→ 长度 n 的全 0 —— 不炸、无 NaN。
 */
export function layoutTickTops(n: number, railHeight: number, pitch: number): number[] {
  if (!(n > 0)) return [];
  if (!(railHeight > 0)) return Array<number>(n).fill(0);
  const p = n > 1 ? Math.min(pitch, railHeight / (n - 1)) : pitch;
  const top = (railHeight - (n - 1) * p) / 2;
  return Array.from({ length: n }, (_, i) => top + i * p);
}

/**
 * 匹配历史 core 注入文件块（★ 2026-10-02 起新消息不再产生，此处仅为解旧 session）。
 * ⚠️ 口径必须与 MessageBubble.tsx 的 INJECTED_FILE_BLOCK_RE 同步（同一份历史格式，
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

/** 截断提示（回答渲染态专用；问题路径保持纯文本口径不加提示） */
const ANSWER_TRUNCATED_NOTE = "（预览已截断，点击刻度查看全文）";

/**
 * 回答截断（渲染态口径，task-turn-rail-preview-interaction.md 决策 6）：截断到 max
 * 字符后，若 ``` 围栏数为奇数补一行闭合（防截断把余下正文吞进未闭合代码块），再追加
 * 截断提示。与 question 的 truncate 分径：问题含 📎 行且多为手打文本，不做围栏修补。
 */
function truncateAnswer(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  let cut = `${trimmed.slice(0, max)}…`;
  if (((cut.match(/```/g) ?? []).length & 1) === 1) cut += "\n```";
  return `${cut}\n\n${ANSWER_TRUNCATED_NOTE}`;
}

/**
 * 预览文本组装（规格书决策 5）：
 * - 问题 = user 消息全部 text 块，注入文件块折成「📎 文件名」行（与气泡折叠条同口径；
 *   预览里不塞文件正文，否则预览会被文件内容淹没）；块间以换行衔接；
 * - 回答 = 尾条 assistant 消息**最后一个非空** text 块（最终答复；thinking / 工具卡
 *   不进预览 —— 过程内容的入口是「处理详情」折叠行，两处各司其职）。
 *
 * 纯文本输出（问题侧 = 纯文本 + 📎 行；回答侧 = Markdown 源文，组件层用共享 Markdown
 * 渲染成「预览效果」，task-turn-rail-preview-interaction.md 决策 4）；截断带省略号；
 * 空串表示「无内容」，由组件层决定占位文案。时间不在这里组装 —— formatMessageTime 的
 * now 必须由组件边界传（format.ts 同一条纪律），本函数保持可被脚本直跑复跑。
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
    answer: truncateAnswer(answer, answerMaxChars),
  };
}
