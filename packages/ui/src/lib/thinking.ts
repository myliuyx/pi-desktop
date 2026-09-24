import type { ModelsPayload, ThinkingLevel } from "@/mock/types";

/**
 * 当前激活的思考档位 —— 工具条与设置弹窗·常规 Tab 共用的唯一真相。
 *
 * 优先「用户所选」`settings.thinkingLevel`；但当该档位**不在**当前模型支持的集合里
 * （`reasoning:false` 的模型只有 ["off"]，而 Pi 仍把 defaultThinkingLevel 持久化成 "high"），
 * 显示用户所选会出现「chip 写着 High，菜单里没有任何项被选中」。此时回落**真正生效值**
 * `payload.thinkingLevel`（Pi 按能力夹取后的结果）。
 *
 * `payload` 为 null（live 数据未就绪 / mock 形态）时，回落 UI store 的 `fallback`。
 */
export function pickActiveThinking(
  payload: ModelsPayload | null | undefined,
  fallback: ThinkingLevel,
): ThinkingLevel {
  if (!payload) return fallback;
  const chosen = payload.settings.thinkingLevel ?? payload.thinkingLevel ?? fallback;
  const available = payload.availableThinkingLevels;
  if (available.length > 0 && !available.includes(chosen)) return payload.thinkingLevel;
  return chosen;
}