import { create } from "zustand";

/**
 * 全局轻量提示队列 —— 整个 UI 唯一的失败反馈通道。
 *
 * 为什么需要它：全 UI 有十余处 live 调用失败只 `console.error`，用户看不到任何反馈；
 * 其中 Composer 的模型/思考切换还会「乐观更新后静默失败」，界面显示与 core 实际状态不一致。
 * 逐个组件造提示不划算，收口成一个 store + 一个 NoticeStack。
 *
 * mock 形态不会产生提示（mock 不经过 transport，也没有失败路径），默认行为零变化。
 */
export type NoticeTone = "info" | "success" | "warning" | "danger";

export interface Notice {
  id: string;
  tone: NoticeTone;
  text: string;
}

interface NoticeState {
  notices: Notice[];
  /** 返回新提示的 id —— 供调用方在恢复时精确 dismiss（既有忽略返回值的调用方不受影响） */
  notify: (input: { tone: NoticeTone; text: string; timeoutMs?: number }) => string;
  dismiss: (id: string) => void;
}

let seq = 0;

/** danger 默认常驻（需要用户读一眼），其余 5s 自动消失；也可手动关闭。 */
export const useNoticeStore = create<NoticeState>((set, get) => ({
  notices: [],
  notify: ({ tone, text, timeoutMs }) => {
    const id = `n-${++seq}`;
    set((state) => ({ notices: [...state.notices, { id, tone, text }] }));
    const ms = timeoutMs ?? (tone === "danger" ? 0 : 5000);
    if (ms > 0) setTimeout(() => get().dismiss(id), ms);
    return id;
  },
  dismiss: (id) => set((state) => ({ notices: state.notices.filter((n) => n.id !== id) })),
}));

/** 统一失败上报：异常 → 一句可读中文。非组件模块（store / service）也能调用。 */
export function notifyFailure(scope: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  useNoticeStore.getState().notify({ tone: "danger", text: `${scope}：${detail}` });
}
