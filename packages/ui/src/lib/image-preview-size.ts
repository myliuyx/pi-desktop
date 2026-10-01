/**
 * 大图预览面板尺寸计算（task-image-preview-fit.md，2026-10-01；同日二次裁决：
 * 外框形态 = **零内边距、图即卡**——面板尺寸就是图片显示尺寸，圆角/阴影裁在图上，
 * 任何颜色的图都不再有白框（白卡 + 16px 边距在深色图上会衬出白框，用户实弹否决）。
 *
 * 为什么单独抽纯函数：面板随图走的全部规则（不放大、视口钳制、最小尺寸、
 * 0 尺寸防御）都要进 check 断言，而 `--experimental-strip-types` 加载不了
 * `@/` 别名与 React —— 与 `image-src.ts` 同款纪律：零 React、零 DOM、
 * 相对路径 import（`.ts` 扩展名，tsconfig 已开 allowImportingTsExtensions）。
 *
 * 背景（本批修的两个根因，见 .plan/task-image-preview-fit.md §一）：
 * 旧实现把面板写死近全屏（与图片尺寸无关），白底截图贴白板 ⇒「巨大白色背景、
 * 图片只有一小块」。现在由调用方先预取图片自然尺寸，再用本函数反推面板宽高
 * —— 小图出紧凑卡（= 图片原尺寸），大图等比降采样贴到视口余量。
 */
import { SETTINGS_DIALOG_MAX_HEIGHT_VH } from "./layout.ts";

/** 视口四周留白（沿用旧「innerWidth−48」口径，24px/侧） */
export const IMAGE_PREVIEW_MARGIN = 48;

/** 面板（=图片显示盒）下限：1×1 PNG 等 payload 不出荒诞小板，错误/加载文案也放得下 */
export const IMAGE_PREVIEW_MIN_CONTENT = { width: 240, height: 180 } as const;

/** 预载/失败态面板：实测回来前弹层先以此尺寸出现，绝不死点击（文案自带 p-6） */
export const IMAGE_PREVIEW_PROVISIONAL = { width: 320, height: 220 } as const;

/**
 * 图片自然尺寸 + 视口 → 预览面板尺寸（= 图片显示尺寸，零内边距）。
 *
 * 规则（image-preview-size-check.mjs 逐条对账）：
 * - **不放大**：`scale ≤ 1`（D1 裁决——小图按原始 CSS 像素呈现，面板贴图即可）；
 * - 面板 = 图片显示盒，**无 padding**，所以视口钳制直接落在面板上：
 *   `availW = viewportW − 48`；`availH = min(viewportH − 48,
 *   viewportH × SETTINGS_DIALOG_MAX_HEIGHT_VH / 100)`——90vh 项与 `Dialog` 面板
 *   `maxHeight` 同源常量，面板 ≤ 90vh 不会再被二次钳制（曾有的 90vh+32 二次钳
 *   随 padding 一起废止）；
 * - 自然尺寸 ≤ 0：视为无有效尺寸，scale=1 落到最小面板（**不产生 NaN/Infinity**；
 *   组件层把 0 尺寸判加载失败，这里只是最后的防御）；
 * - 面板 = max(round(natW×scale), MIN.width) × max(round(natH×scale), MIN.height)。
 */
export function computePreviewPanelSize(
  naturalWidth: number,
  naturalHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): { width: number; height: number } {
  const availW = Math.max(0, viewportWidth - IMAGE_PREVIEW_MARGIN);
  const availH = Math.max(
    0,
    Math.min(
      viewportHeight - IMAGE_PREVIEW_MARGIN,
      (viewportHeight * SETTINGS_DIALOG_MAX_HEIGHT_VH) / 100,
    ),
  );
  const hasNatural = naturalWidth > 0 && naturalHeight > 0;
  const scale = hasNatural
    ? Math.min(availW / naturalWidth, availH / naturalHeight, 1)
    : 1;
  return {
    width: Math.max(Math.round(naturalWidth * scale), IMAGE_PREVIEW_MIN_CONTENT.width),
    height: Math.max(Math.round(naturalHeight * scale), IMAGE_PREVIEW_MIN_CONTENT.height),
  };
}
