import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import {
  SWITCH_BORDER_WIDTH,
  SWITCH_HEIGHT,
  SWITCH_KNOB_INSET,
  SWITCH_KNOB_LEFT_ON,
  SWITCH_KNOB_SIZE,
  SWITCH_WIDTH,
} from "@/lib/layout";

/**
 * 开关控件（原生 `role="switch"`）。
 *
 * 为什么不用 `<input type="checkbox">` 打样式：
 * checkbox 的 `aria-checked` 是隐式的、由 `checked` 派生，验收脚本读 `aria-checked`
 * 时拿到的是浏览器反射值，一旦样式层出问题（如 `appearance:none` 写漏）就会出现
 * 「看着没开、aria 说开了」这类不一致。`role="switch"` + 显式 `aria-checked` 的
 * button 让状态只有一个来源（props），DOM 属性与视觉必然同源。
 *
 * 为什么不用 Radix Switch：M4 明令不引入新依赖，两个属性一个 button 就够
 * （见 task-M4.md 4.2 ② 与第四节禁止项）。
 *
 * ★ 三种「状态可见性」同时输出，彼此不重复：
 * - `aria-checked` —— 无障碍语义（G7）
 * - `data-enabled`  —— 验收 4-3 的判定位（与 aria 同源，但字符串形式便于选择器）
 * - 视觉：`accent` 底表示开启
 */
export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role"> {
  checked: boolean;
  /** 无障碍必填：开关本身没有可见文本 */
  label: string;
  onToggle: () => void;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, label, onToggle, className, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      data-enabled={checked}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full border",
        "transition-colors duration-150 ease-out",
        "disabled:cursor-not-allowed disabled:opacity-40",
        checked
          ? "border-accent bg-accent"
          : "border-border-default bg-bg-subtle hover:bg-bg-hover",
        className,
      )}
      style={{ width: SWITCH_WIDTH, height: SWITCH_HEIGHT }}
      {...rest}
    >
      {/*
       * 滑块位置用 `left`（不用 transform / right）：
       *   ① 开关是 36×20 的固定尺寸控件，left 与两个「外缘口径」常量直接对应，
       *      比 transform 少一层换算（transform 还要再除以 2）。
       *   ② ★ 两态都必须写 `left` —— 若「开」态改用 `right`，left↔right 是**两个
       *      不同 CSS 属性**、切换时不可插值，`transition-all` 直接失效、滑块瞬移
       *      （2026-09-28 review 逐帧实测：left 恒 1px、位移 0）。这正是
       *      SWITCH_KNOB_LEFT_ON 作为独立常量存在的原因。
       *
       * ★ top/left 相对 **padding box**（border 内部），而 INSET 定义的是
       *   「距外边缘」：开关有 1px 边框，写 style 时必须减掉 SWITCH_BORDER_WIDTH，
       *   否则滑块上/左各多 1px —— 肉眼可见地「白圆没上下居中、且偏右」
       *   （2026-09-28 用户实拍）。
       */}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute rounded-full transition-all duration-150 ease-out",
          checked ? "bg-accent-fg" : "bg-border-strong",
        )}
        style={{
          width: SWITCH_KNOB_SIZE,
          height: SWITCH_KNOB_SIZE,
          top: SWITCH_KNOB_INSET - SWITCH_BORDER_WIDTH,
          left: checked
            ? SWITCH_KNOB_LEFT_ON
            : SWITCH_KNOB_INSET - SWITCH_BORDER_WIDTH,
        }}
      />
    </button>
  );
});
