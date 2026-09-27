/**
 * 会话分轮（task-process-collapse.md）—— 把扁平的 Message[] 按「一次提问 → 一次完整回复」
 * 切成轮次（TurnGroup），供「处理详情」折叠行做归属判定与计数。
 *
 * 纯函数、零副作用（同 adapter/reduce.ts 的纪律）：输入确定、输出确定，可被
 * scripts/turns-check.mjs 直跑断言。类型只 import（dist 无运行时痕迹）。
 *
 * 为什么按「user 消息」切轮：reducer 对 message_start 逐条**追加** assistant 消息
 * （一轮 prompt 可产生多条，多 turn），消息数组本身没有轮次概念；user 消息是唯一
 * 稳定的轮次边界。会话以 assistant 开头（无 user 头）时首段自成一轮。
 */

import type { Message } from "../mock/types.ts";

export interface TurnGroup {
  /** 稳定键：`${scope}:t${起始消息下标}` —— store 的 settled 标记与视图展开态共用 */
  key: string;
  /** 轮次起始消息下标（user 消息；无 user 头时为第一条 assistant 的下标） */
  startIndex: number;
  /** 轮内 assistant 消息下标（升序） */
  assistantIndexes: number[];
  /** 最后一条 assistant 消息下标（= assistantIndexes 末位；折叠行渲染在它的行内） */
  tailIndex: number;
  /** N：assistant 消息条数（含最终答复，2026-09-27 用户裁决） */
  messageCount: number;
  /** M：tool_call 块数（按 toolCallId 去重，2026-09-27 用户裁决） */
  toolCallCount: number;
  /** 尾条 assistant 消息是否有非空 text 块（false = 没答完 —— 中止/出错，不折叠） */
  tailHasText: boolean;
  /** 轮内是否存在未决授权卡（渲染侧据此拒绝折叠 —— 授权卡必须可操作） */
  hasUnresolvedApproval: boolean;
  /**
   * 可折叠 = 有工具调用 && 尾条有文本。
   * **不含** settled 与未决授权两个条件 —— 前者由 store 的 settledTurnKeys 标记
   * （live 专属，mock 恒空），后者在渲染侧动态判定（授权解决后下一渲染即可收起）。
   */
  collapsible: boolean;
}

export function turnKey(scope: string, startIndex: number): string {
  return `${scope}:t${startIndex}`;
}

export function groupTurns(messages: Message[], scope: string): TurnGroup[] {
  const turns: TurnGroup[] = [];
  let start: number | null = null;
  let assistants: number[] = [];

  const flush = () => {
    if (start !== null && assistants.length > 0) {
      const toolCallIds = new Set<string>();
      let hasUnresolvedApproval = false;
      for (const idx of assistants) {
        for (const block of messages[idx].blocks) {
          if (block.type === "tool_call") toolCallIds.add(block.toolCallId);
          if (block.type === "approval" && (block.resolved ?? "") === "") hasUnresolvedApproval = true;
        }
      }
      const tail = messages[assistants[assistants.length - 1]];
      const tailHasText = tail.blocks.some((b) => b.type === "text" && b.content.trim() !== "");
      turns.push({
        key: turnKey(scope, start),
        startIndex: start,
        assistantIndexes: assistants,
        tailIndex: assistants[assistants.length - 1],
        messageCount: assistants.length,
        toolCallCount: toolCallIds.size,
        tailHasText,
        hasUnresolvedApproval,
        collapsible: toolCallIds.size >= 1 && tailHasText,
      });
    }
    start = null;
    assistants = [];
  };

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      flush();
      start = i;
    } else {
      if (start === null) start = i; // 无 user 头（会话以 assistant 开头）：自成一轮
      assistants.push(i);
    }
  }
  flush();
  return turns;
}

/** 每条 assistant 消息的轮次归属（MessageList 渲染分派用）；user 消息不在表内 */
export interface TurnMembership {
  turn: TurnGroup;
  /** 是否为最后一条 assistant 消息（折叠行收起态的宿主；用量 footer / 最终答复所在） */
  isTail: boolean;
  /** 是否为第一条 assistant 消息（折叠行展开态的宿主，2026-09-27 二次裁决） */
  isHead: boolean;
}

export function buildTurnIndex(messages: Message[], scope: string): Map<number, TurnMembership> {
  const index = new Map<number, TurnMembership>();
  for (const turn of groupTurns(messages, scope)) {
    const last = turn.assistantIndexes.length - 1;
    turn.assistantIndexes.forEach((idx, i) => {
      index.set(idx, { turn, isTail: i === last, isHead: i === 0 });
    });
  }
  return index;
}

/**
 * 已完结可折叠轮次的键集合 —— chat-store `settledTurnKeys` 的数据源（整体替换写入）。
 * 只按 collapsible 过滤、**不**按未决授权过滤：授权卡是否已决会变，若在标记期剔除，
 * 解决后没有任何事件再来补标记，该轮就永远收不上了；动态条件交给渲染侧闸门。
 */
export function collectCollapsibleTurnKeys(messages: Message[], scope: string): Set<string> {
  return new Set(groupTurns(messages, scope).filter((t) => t.collapsible).map((t) => t.key));
}
