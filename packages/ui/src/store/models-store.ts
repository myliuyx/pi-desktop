import { create } from "zustand";
import { getLiveTransport } from "@/services/live-transport";
import { useNoticeStore } from "@/store/notice-store";
import type { ModelsPayload } from "@/mock/types";

/**
 * 模型清单的**唯一真相**（live 形态）。
 *
 * 为什么必须是 store：Composer 工具条与设置弹窗·常规 Tab 都要展示「当前模型 / 可选模型 /
 * 思考档位」，而设置弹窗保存 provider 后（`SettingsDialog.onSave`）会改变可选清单与当前模型。
 * 之前两处各自 mount 时 `listModels()` 一次，保存后仍是旧快照（选项点了没反应）。
 *
 * mock 形态（`getLiveTransport()` 返回 null）下 `payload` 恒为 null，消费方回落 mock 分支，
 * 默认行为零变化。
 */
interface ModelsState {
  payload: ModelsPayload | null;
  /** 尚未加载时才拉取（组件挂载用） */
  ensure: () => Promise<void>;
  /** 强制拉取（保存 provider 后调用） */
  refresh: () => Promise<void>;
  /** 用已有接口返回值就地覆盖（setModel / setThinkingLevel 的响应即最新清单） */
  applyPayload: (payload: ModelsPayload) => void;
}

export const useModelsStore = create<ModelsState>((set, get) => ({
  payload: null,
  ensure: async () => {
    if (get().payload) return;
    await get().refresh();
  },
  refresh: async () => {
    const transport = getLiveTransport();
    if (!transport) return;
    try {
      set({ payload: await transport.listModels() });
    } catch (e) {
      // 与既有一致：失败只记录，消费方回落 mock / 保留旧快照，绝不白屏
      console.error("[live] /models 失败:", e);
      // 模型清单是 Composer 芯片 / 设置·思考档位的可见数据源，回落演示清单要让用户知道
      useNoticeStore.getState().notify({ tone: "warning", text: "模型清单读取失败，已回落演示清单" });
    }
  },
  applyPayload: (payload) => set({ payload }),
}));