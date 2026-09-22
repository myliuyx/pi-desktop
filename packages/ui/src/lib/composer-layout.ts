/**
 * Composer / 工具条专属布局常量。
 *
 * 为什么单独建文件（而不是塞进 `lib/layout.ts`）：layout.ts 是共享文件，两个执行方同时改会冲突。
 * B（输入区与统计）只在这里放自己领域内的派生常量，主控收尾时再决定是否归并回 layout.ts。
 *
 * 所有数值都从 layout.ts 的冻结常量推导，不写死字面量。
 */

import { COMPOSER_SEND_INSET, SEND_BUTTON_SIZE } from "@/lib/layout";

/**
 * 内嵌发送按钮会占用输入框右下角一片空间，textarea 必须在右侧与底部预留出这片区域，
 * 否则文字会被按钮压住（验收 2-9 要求按钮落在输入框边框内侧）。
 *
 * 预留 = 按钮宽度 + 一侧内缩（按钮距边的距离）。按钮右侧贴到 `COMPOSER_SEND_INSET`，
 * 左侧则延伸到 `SEND_BUTTON_SIZE + COMPOSER_SEND_INSET` 处，故右侧与底部 padding 取这个值。
 */
export const COMPOSER_INPUT_TRAILING_SPACE = SEND_BUTTON_SIZE + COMPOSER_SEND_INSET;
