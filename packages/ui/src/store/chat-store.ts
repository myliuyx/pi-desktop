import { create } from "zustand";
import type { Message, Session, SessionSummary, TextBlock, TokenUsage } from "@/mock/types";
import { INITIAL_SESSION, INITIAL_SESSION_TITLE, INITIAL_TOKEN_USAGE } from "@/mock/sessions";
import { simulateStream, type StreamHandle } from "@/mock/stream";
import { STREAM_TICK_MS } from "@/lib/layout";
import { isLiveEnabled } from "@/lib/feature-flags";
import { getLiveTransport } from "@/services/live-transport";
import { applyEvent, createDraft, type DraftState } from "@/adapter/reduce";
import type { AgentEvent } from "@/adapter/pi-events";

/**
 * 会话工作台状态。
 *
 * `ChatState` 的字段与方法名是 M2 的**冻结契约**（Agent B 只读 tokenUsage / streaming，
 * 调用 sendMessage / abortStream）。本文件由 Agent A 实现完整版。
 * 允许新增字段，但必须有默认值、且不得改名或删除既有项。
 *
 * ## C4 新增（全部是「新增」，既有字段与方法签名一行未改）
 *
 * - `sessionSummaries` / `liveSessionId`：live 形态下 Sidebar 的真实清单与当前会话；
 * - `refreshSessions()` / `loadSessionById(id)`：**新增方法**（未动 `loadSession` 的签名，
 *   按教训 #3「给既有公共 API 加可选参不是向后兼容」）。
 * - `loadSession(session)` 在 live 形态下**内部改走 transport**（签名仍是 `(session: Session) => void`：
 *   只取 `id`/`title`，消息体由 core 回填）。
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
  /** 载入会话（`?stress=N` 与演示重置用）；live 形态下经 core 按 `session.id` 拉真实消息 */
  loadSession: (session: Session) => void;
  /** 回到初始会话 */
  reset: () => void;

  /* ------------------------------------------------------------------ C4 新增 */
  /** live 形态下的真实会话清单（Sidebar 数据源）；mock 形态恒为空数组 */
  sessionSummaries: SessionSummary[];
  /** live 形态下当前打开的会话 id（Sidebar 高亮用）；mock 形态恒为 null */
  liveSessionId: string | null;
  /** 重新拉取会话清单（live 形态；mock 形态是空操作） */
  refreshSessions: () => void;
  /** 按 id 打开历史会话（live 形态；mock 形态是空操作） */
  loadSessionById: (id: string, title?: string) => void;
}

/* ---------------------------------------------------------------------------
 * 模块级流式句柄：流式状态属于「进行中」的副作用，不进 store 本身，
 * 用闭包变量持有，避免把定时器塞进可序列化状态。
 * ------------------------------------------------------------------------- */
let activeStream: StreamHandle | null = null;
let streamMsgId: string | null = null;

/* ---------------------------------------------------------------------------
 * live 模式（?live=1）真实链路句柄 —— 模块级闭包，不进可序列化状态。
 * 与 mock 的 activeStream 互斥：live 走 core + 真实模型，mock 走 simulateStream。
 * 实例由 `services/live-transport.ts` 统一持有（04/05 屏也要用同一条 SSE）。
 * ------------------------------------------------------------------------- */
let liveDraft: DraftState = createDraft();

function ensureLive(): void {
  const transport = getLiveTransport();
  if (!transport) return;
  // 订阅生命周期与应用一致：只要还有监听器就保持 SSE 连接（见 transport 内部引用计数）
  transport.subscribe((event: AgentEvent) => {
    /*
     * usage 事件是 core 算好的真实用量快照（输入/输出/消耗/已用上下文），
     * 与消息树无关 —— 不进 reducer，直接写 store，让 TokenStats 联动。
     */
    if (event.type === "usage") {
      useChatStore.setState({ tokenUsage: event.usage });
      return;
    }
    liveDraft = applyEvent(liveDraft, event);
    useChatStore.setState({ messages: liveDraft.messages, streaming: liveDraft.streaming });
    // C4：一轮对话结束后刷新会话清单 —— Pi 是在首条 entry 追加时才落盘会话文件，
    // 所以新会话只有跑完一轮才会出现在 Sidebar（不刷新则列表永远是启动那一刻的快照）。
    if (event.type === "agent_settled") useChatStore.getState().refreshSessions();
  });
}

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

    // ★ live 分支：经 core 连真实模型（reducer 由 applyEvent 在订阅里驱动，不在此预建 assistant 占位）
    const transport = getLiveTransport();
    if (transport) {
      const now = Date.now();
      const userMsg: Message = {
        id: `u-${now}`,
        role: "user",
        timestamp: now,
        blocks: [{ type: "text", content: trimmed }],
      };
      set((state) => ({ messages: [...state.messages, userMsg], streaming: true }));
      // liveDraft 以「当前消息 + 新 user 消息」为基线，后续 assistant 消息由 reducer 追加
      liveDraft = createDraft([...get().messages]);
      void transport.sendMessage(trimmed).catch((e) => {
        console.error("[live] sendMessage 失败:", e);
        useChatStore.setState({ streaming: false });
      });
      return;
    }

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
    const transport = getLiveTransport();
    if (transport) {
      // 真实链路：中止当前会话（已产出内容定格），streaming 立即解除
      void transport.abort().catch(() => {});
      set({ streaming: false });
      return;
    }
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
    const transport = getLiveTransport();
    if (transport) {
      // 回传授权选择给 core（core 再 resolve Pi 的 pending）；UI 乐观收卡见下
      void transport.resolveApproval(requestId, choice).catch(() => {});
    }
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
    const transport = getLiveTransport();
    if (transport) {
      /*
       * ★ live 形态：**签名不变**（`(session: Session) => void`），内部改走 transport。
       * 这里只用到 `id`/`title` —— 真实消息体由 core 的
       * `POST /sessions/load` 回填（`SessionEntry[] → Message[]` 的独立映射在 core 侧）。
       * 找不到会话时（例如 `?stress=` 造的假 id）保留传入的 session 内容，不把界面清空。
       */
      void transport.abort().catch(() => {});
      get().loadSessionById(session.id, session.title);
      return;
    }
    set({
      messages: session.messages,
      streaming: false,
      sessionTitle: session.title,
      tokenUsage: computeTokens(session.messages),
    });
  },

  /* -------------------------------------------------------------- C4 新增 */

  sessionSummaries: [],
  liveSessionId: null,

  refreshSessions: () => {
    const transport = getLiveTransport();
    if (!transport) return;
    void transport
      .listSessions()
      .then((sessions) => {
        useChatStore.setState({ sessionSummaries: sessions });
      })
      .catch((e) => {
        console.error("[live] listSessions 失败:", e);
      });
  },

  loadSessionById: (id, title) => {
    const transport = getLiveTransport();
    if (!transport) return;
    if (activeStream) {
      activeStream.abort();
      activeStream = null;
      streamMsgId = null;
    }
    void transport.abort().catch(() => {});
    // 乐观先切标题与「当前会话」（消息体等 core 回来再填），避免点击后长时间无反馈
    set((state) => ({ streaming: false, liveSessionId: id, sessionTitle: title ?? state.sessionTitle }));
    void transport
      .loadSession(id)
      .then((loaded) => {
        liveDraft = createDraft(loaded.messages);
        useChatStore.setState({
          messages: loaded.messages,
          sessionTitle: loaded.title || title || "会话",
          tokenUsage: loaded.tokenUsage,
          streaming: false,
          liveSessionId: loaded.id,
        });
      })
      .catch((e) => {
        console.error(`[live] loadSession(${id}) 失败:`, e);
      });
  },

  reset: () => {
    if (activeStream) {
      activeStream.abort();
      activeStream = null;
      streamMsgId = null;
    }
    const transport = getLiveTransport();
    if (transport) {
      void transport.abort().catch(() => {});
      liveDraft = createDraft(INITIAL_SESSION.messages);
    }
    set({
      messages: INITIAL_SESSION.messages,
      streaming: false,
      sessionTitle: INITIAL_SESSION_TITLE,
      tokenUsage: INITIAL_TOKEN_USAGE,
      liveSessionId: null,
    });
  },
}));

/*
 * 开发期把 store 挂到 window，仅供验收脚本驱动 sendMessage / abortStream
 * （Composer 由 Agent B 实现，A 这边需要真实触发流式来验证自动滚底 2-5）。
 * 仅在 DEV 或 live 模式下暴露（live 模式挂真实 store 实例供脚本驱动，同 MCP 范式）；
 * 用 as any 规避 import.meta.env 的类型依赖。
 */
if (typeof window !== "undefined") {
  const dev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
  if (dev || isLiveEnabled()) {
    (window as unknown as { __chatStore?: typeof useChatStore }).__chatStore = useChatStore;
    // live 模式：建立真实链路订阅（SSE → reducer → store），并拉一次会话清单给 Sidebar
    ensureLive();
    if (isLiveEnabled()) {
      useChatStore.getState().refreshSessions();
      /*
       * C6 首个修复项（2026-09-23 用户实测反馈）：live 启动**不再展示 mock 会话**。
       * 加载最近一条真实会话；一条都没有则进入空态（messages: []），
       * 绝不拿 `INITIAL_SESSION` 的 7 条 mock 顶数 —— 否则用户看到的永远「和纯 UI 没区别」。
       */
      void (async () => {
        const transport = getLiveTransport();
        if (!transport) return;
        try {
          const sessions = await transport.listSessions();
          if (sessions.length > 0) {
            const latest = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
            useChatStore.getState().loadSessionById(latest.id, latest.title);
          } else {
            liveDraft = createDraft([]);
            useChatStore.setState({ messages: [], sessionTitle: "新会话", streaming: false });
          }
        } catch (e) {
          console.error("[live] 启动加载最近会话失败:", e);
        }
      })();
    }
  }
}
