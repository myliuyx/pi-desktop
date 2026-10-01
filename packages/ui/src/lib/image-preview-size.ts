/**
 * 大图预览面板尺寸计算（task-image-preview-fit.md，2026-10-01）。
 *
 * 为什么单独抽纯函数：面板随图走的全部规则（不放大、视口钳制、最小尺寸、
 * 0 尺寸防御）都要进 check 断言，而 `--experimental-strip-types` 加载不了
 * `@/` 别名与 React —— 与 `image-src.ts` 同款纪律：零 React、零 DOM、
 * 相对路径 import（`.ts` 扩展名，tsconfig 已开 allowImportingTsExtensions）。
 *
 * 背景（本批要修的两个根因，见 .plan/task-image-preview-fit.md §一）：
 * 旧实现把面板写死近全屏（与图片尺寸无关），白底截图贴白板 ⇒「巨大白色背景、
 * 图片只有一小块」。现在由调用方先预取图片自然尺寸，再用本函数反推面板宽高
 * —— 小图出紧凑白卡（贴图 + p-4 内边距），大图等比降采样贴到视口余量。
 */
import { SETTINGS_DIALOG_MAX_HEIGHT_VH } from "./layout.ts";

/** 视口四周留白（沿用旧「innerWidth−48」口径） */
export const IMAGE_PREVIEW_MARGIN = 48;

/** 弹层内容区内边距（容器 p-4；面板宽高 = 内容盒 + 32） */
export const IMAGE_PREVIEW_PADDING = 16;

/** 内容盒下限：1×1 PNG 等 payload 不出荒诞小板，错误/加载文案也放得下 */
export const IMAGE_PREVIEW_MIN_CONTENT = { width: 240, height: 180 } as const;

/** 预载/失败态面板（**含 padding**）：实测回来前弹层先以此尺寸出现，绝不死点击 */
export const IMAGE_PREVIEW_PROVISIONAL = { width: 320, height: 220 } as const;

/**
 * 图片自然尺寸 + 视口 → 预览面板尺寸（含 padding）。
 *
 * 规则（image-preview-size-check.mjs 逐条对账）：
 * - **不放大**：`scale ≤ 1`（D1 裁决——小图按原始 CSS 像素呈现，面板贴图即可）；
 * - 宽/高钳的是**内容盒**（面板 = 内容 + 2×PADDING）：`availW = viewportW − 48 − 32`；
 *   `availH = min(viewportH − 48, viewportH × SETTINGS_DIALOG_MAX_HEIGHT_VH / 100) − 32`
 *   ——减 PADDING×2 是实弹抓出的坑：钳「图片可用高」时面板会到 90vh+32，被
 *   `Dialog` 面板的 `maxHeight: 90vh` **二次钳制**，图片两侧多出假边距；减掉后
 *   面板高 ≤ min(vh−48, 90vh)，钳制一次到位，四周留白与旧「−48」口径一致；
 * - 自然尺寸 ≤ 0：视为无有效尺寸，scale=1 落到最小面板（**不产生 NaN/Infinity**；
 *   组件层把 0 尺寸判加载失败，这里只是最后的防御）；
 * - 内容盒 = max(round(natW×scale), MIN.width) × max(round(natH×scale), MIN.height)，
 *   面板 = 内容盒 + PADDING×2。
 */
export function computePreviewPanelSize(
  naturalWidth: number,
  naturalHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): { width: number; height: number } {
  const availW = Math.max(
    0,
    viewportWidth - IMAGE_PREVIEW_MARGIN - IMAGE_PREVIEW_PADDING * 2,
  );
  const availH = Math.max(
    0,
    Math.min(
      viewportHeight - IMAGE_PREVIEW_MARGIN,
      (viewportHeight * SETTINGS_DIALOG_MAX_HEIGHT_VH) / 100,
    ) - IMAGE_PREVIEW_PADDING * 2,
  );
  const hasNatural = naturalWidth > 0 && naturalHeight > 0;
  const scale = hasNatural
    ? Math.min(availW / naturalWidth, availH / naturalHeight, 1)
    : 1;
  const contentW = Math.max(Math.round(naturalWidth * scale), IMAGE_PREVIEW_MIN_CONTENT.width);
  const contentH = Math.max(Math.round(naturalHeight * scale), IMAGE_PREVIEW_MIN_CONTENT.height);
  return {
    width: contentW + IMAGE_PREVIEW_PADDING * 2,
    height: contentH + IMAGE_PREVIEW_PADDING * 2,
  };
}
