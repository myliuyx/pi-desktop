import { create } from "zustand";
import type { Message, Session, TextBlock, TokenUsage } from "@/mock/types";
import { INITIAL_SESSION, INITIAL_SESSION_TITLE, INITIAL_TOKEN_USAGE } from "@/mock/sessions";
import { simulateStream, type StreamHandle } from "@/mock/stream";
import { STREAM_TICK_MS } from "@/lib/layout";

/**
 * 会话工作台状态。
 *
 * `ChatState` 的字段与方法名是 M2 的**冻结契约**（Agent B 只读 tokenUsage / streaming，
 * 调用 sendMessage / abortStream）。本文件由 Agent A 实现完整版。
 * 允许新增字段，但必须有默认值、且不得改名或删除既有项。
 */

export interface ChatState {
  messages: Message[];
  /** 助手正在流式输出（停止按钮、自动滚底判定用） */
  streaming: boolean;
  tokenUsage: TokenUsage;
  sessionTitle: string;

  /** 发送一条用户消息，并触发一次 mock 助手的流式回复（≤2s） */
  sendMessage: (text: string) => void;
  /** 中止正在进行的流式输出（已产出内容定格） */
  abortStream: () => void;
  /** 解决授权卡片；对已决的 requestId 再次调用应无效 */
  resolveApproval: (requestId: string, choice: string) => void;
  /** 载入会话（`?stress=N` 与演示重置用） */
  loadSession: (session: Session) => void;
  /** 回到初始会话 */
  reset: () => void;
}

/* ---------------------------------------------------------------------------
 * 模块级流式句柄：流式状态属于「进行中」的副作用，不进 store 本身，
 * 用闭包变量持有，避免把定时器塞进可序列化状态。
 * ------------------------------------------------------------------------- */
let activeStream: StreamHandle | null = null;
let streamMsgId: string | null = null;

/** 按消息内容粗略估算 token（仅原型展示用，不要求精确） */
function computeTokens(messages: Message[]): TokenUsage {
  let inputChars = 0;
  let outputChars = 0;
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type === "text") {
        if (m.role === "user") inputChars += b.content.length;
        else outputChars += b.content.length;
      }
    }
  }
  const input = Math.round(inputChars * 0.5);
  const output = Math.round(outputChars * 0.5);
  return {
    input,
    output,
    total: input + output,
    contextWindow: INITIAL_TOKEN_USAGE.contextWindow,
  };
}

/** 一条 canned 回复（含 markdown + 代码块，顺便在流式过程中验证高亮） */
function pickReply(userText: string): string {
  const preview = userText.slice(0, 40);
  return [
    "收到，我先梳理一下你的需求。",
    "",
    `你提到的是：**${preview}**`,
    "",
    "接下来我会按三步推进：",
    "",
    "1. 检索相关工具",
    "2. 生成适配代码",
    "3. 跑通自检",
    "",
    "```ts",
    "const plan = buildPlan(userText);",
    "```",
    "",
    "稍等，马上开始。",
  ].join("\n");
}

/** 构造一个 TextBlock（避免内联字面量把 type 推宽为 string） */
function mkText(content: string, streaming: boolean): TextBlock {
  return { type: "text", content, streaming };
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: INITIAL_SESSION.messages,
  streaming: false,
  tokenUsage: INITIAL_TOKEN_USAGE,
  sessionTitle: INITIAL_SESSION_TITLE,

  sendMessage: (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // 1. 同步追加一条 user 消息
    const now = Date.now();
    const userMsg: Message = {
      id: `u-${now}`,
      role: "user",
      timestamp: now,
      blocks: [{ type: "text", content: trimmed }],
    };
    // 2. 追加一条 streaming 的 assistant 占位消息
    const assistantId = `a-${now + 1}`;
    const assistantMsg: Message = {
      id: assistantId,
      role: "assistant",
      timestamp: now + 1,
      blocks: [{ type: "text", content: "", streaming: true }],
    };
    set((state) => ({
      messages: [...state.messages, userMsg, assistantMsg],
      streaming: true,
    }));

    const reply = pickReply(trimmed);
    streamMsgId = assistantId;

    // 3. 分片增长（打字机），总时长 ≤ 2s
    activeStream = simulateStream({
      text: reply,
      tickMs: STREAM_TICK_MS,
      onChunk: (partial) => {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === assistantId ? { ...m, blocks: [mkText(partial, true)] } : m,
          ),
        }));
      },
      onDone: () => {
        const finalMessages = get().messages.map((m) =>
          m.id === assistantId ? { ...m, blocks: [mkText(reply, false)] } : m,
        );
        set({ streaming: false, messages: finalMessages, tokenUsage: computeTokens(finalMessages) });
        activeStream = null;
        streamMsgId = null;
      },
    });
  },

  abortStream: () => {
    if (activeStream) {
      activeStream.abort();
      activeStream = null;
    }
    const id = streamMsgId;
    streamMsgId = null;
    set((state) => {
      const messages = state.messages.map((m) =>
        m.id === id
          ? {
              ...m,
              blocks: m.blocks.map((b) =>
                b.type === "text" ? { ...b, streaming: false } : b,
              ),
            }
          : m,
      );
      return { streaming: false, messages, tokenUsage: computeTokens(messages) };
    });
  },

  resolveApproval: (requestId, choice) => {
    set((state) => ({
      // 已决的 requestId 再次调用不会改变（resolved 非空时不再覆盖）
      messages: state.messages.map((m) => ({
        ...m,
        blocks: m.blocks.map((b) =>
          b.type === "approval" && b.requestId === requestId && (b.resolved ?? "") === ""
            ? { ...b, resolved: choice }
            : b,
        ),
      })),
    }));
  },

  loadSession: (session) => {
    // 切换会话前先中止可能进行的流式
    if (activeStream) {
      activeStream.abort();
      activeStream = null;
      streamMsgId = null;
    }
    set({
      messages: session.messages,
      streaming: false,
      sessionTitle: session.title,
      tokenUsage: computeTokens(session.messages),
    });
  },

  reset: () => {
    if (activeStream) {
      activeStream.abort();
      activeStream = null;
      streamMsgId = null;
    }
    set({
      messages: INITIAL_SESSION.messages,
      streaming: false,
      sessionTitle: INITIAL_SESSION_TITLE,
      tokenUsage: INITIAL_TOKEN_USAGE,
    });
  },
}));

/*
 * 开发期把 store 挂到 window，仅供验收脚本驱动 sendMessage / abortStream
 * （Composer 由 Agent B 实现，A 这边需要真实触发流式来验证自动滚底 2-5）。
 * 仅在 DEV 下暴露，生产构建不挂；用 as any 规避 import.meta.env 的类型依赖。
 */
if (typeof window !== "undefined" && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __chatStore?: typeof useChatStore }).__chatStore = useChatStore;
}
