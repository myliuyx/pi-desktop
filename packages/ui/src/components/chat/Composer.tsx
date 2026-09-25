import { forwardRef, useLayoutEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent } from "react";
import { Send, Square } from "lucide-react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/common/icons";
import { useChatStore } from "@/store/chat-store";
import {
  COMPOSER_INPUT_TRAILING_SPACE,
} from "@/lib/composer-layout";
import {
  COMPOSER_MAX_HEIGHT,
  COMPOSER_MIN_HEIGHT,
  COMPOSER_PADDING,
  COMPOSER_SEND_INSET,
  SEND_BUTTON_SIZE,
  SEND_ICON_OPTICAL_SHIFT_X,
  SEND_ICON_OPTICAL_SHIFT_Y,
} from "@/lib/layout";

/**
 * 输入区（输入框本体 + 内嵌右下角圆形发送按钮）。
 *
 * 冻结契约（task-M2.md 4.4）：
 * - 根节点 `data-testid="composer"` **即输入框本体**，带可见边框；
 * - textarea 为 `data-testid="composer-input"`；
 * - 发送按钮 `data-testid="composer-send"` 必须是根节点的**子孙**（验收 2-9），
 *   且矩形完全落在 composer 内、位于右下角（3.1）。
 *
 * 为什么把按钮用绝对定位放在 composer 内部最右下角：验收要的是 DOM 上的子孙关系 +
 * 几何上的「在边框内侧右下角」，而不是视觉上「看起来在旁边」。绝对定位 + 内缩
 * `COMPOSER_SEND_INSET` 能稳定满足这两条。
 */
export interface ComposerProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * 覆盖占位文案（新建会话草稿态传图中文案，task-new-session-page.md §4.0 D5）。
   * 只影响 placeholder —— aria-label / testid / 发送按钮几何 / 键盘行为等
   * 冻结契约零改动；不传（全部既有调用点）保持原文案，行为零变化。
   */
  placeholder?: string;
}

export const Composer = forwardRef<HTMLDivElement, ComposerProps>(function Composer(
  { placeholder, className, ...rest },
  ref,
) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");

  const streaming = useChatStore((state) => state.streaming);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const abortStream = useChatStore((state) => state.abortStream);

  // 自适应多行高度：先归零再量 scrollHeight，超过上限就锁死并改内部滚动（验收 2-17）。
  // 用 layout effect 在绘制前完成，避免先以旧高度闪一帧。
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.max(
      COMPOSER_MIN_HEIGHT,
      Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT),
    );
    el.style.height = `${next}px`;
  }, [value]);

  // 停止态：流式进行中按钮可点（中止）；非流式且空：禁用（验收要求无内容禁用）
  const disabled = !streaming && value.trim().length === 0;

  function handleSend() {
    if (streaming) {
      abortStream();
      return;
    }
    const text = value.trim();
    if (!text) return;
    sendMessage(text);
    setValue("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter 发送、Shift+Enter 换行（原型内闭环；与验收不冲突）
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div
      ref={ref}
      data-testid="composer"
      className={cn(
        // relative 让内嵌按钮能相对它绝对定位；可见边框是「在内部」判定的前提（3.1）
        "relative flex w-full items-start rounded-xl border border-border-default bg-bg-surface",
        className,
      )}
      {...rest}
    >
      <textarea
        ref={taRef}
        data-testid="composer-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder ?? "给 Pi 下达任务…（Enter 发送，Shift+Enter 换行）"}
        /*
         * aria-label：placeholder 随着输入消失，不是稳定的可访问名称 —— 只靠 placeholder
         * 的输入框在屏幕阅读器里是「无名控件」（G7）。这里补一个固定名称，
         * 与 placeholder 的提示性文案分工明确（提示「怎么用」vs 名称「是什么」）。
         */
        aria-label="消息输入框"
        spellCheck={false}
        rows={1}
        className={cn(
          "block w-full resize-none rounded-xl bg-transparent text-base leading-relaxed text-text-primary",
          /*
           * ⚠️ 这里**不能**写 `outline-none`（M5 5-3 修复项）。
           *
           * 原来写的是 `outline-none`，本意是「鼠标点进输入框时不要那一圈难看的方框」。
           * 但它生成 `outline-style: none`，**优先级高于** globals.css 里 `:focus-visible`
           * 的 `outline: 2px solid var(--accent)` —— 于是纯键盘用户 Tab 到输入框时
           * 完全看不到焦点环，G7「焦点环可见」直接挂（这是本轮 grep 盘点抓到的真缺陷）。
           *
           * 正确做法：不加 `outline-none`，把「鼠标点击不显示焦点环」交给浏览器原生的
           * `:focus-visible` 启发式（鼠标聚焦不会命中 `:focus-visible`，键盘聚焦才命中）——
           * 这正好是 globals.css 那条全局规则的设计意图，在这里不要覆盖它。
           */
          "placeholder:text-text-tertiary",
          "overflow-y-auto overflow-x-hidden",
        )}
        style={{
          // 右侧与底部预留出发送按钮占用的空间，避免文字被压住
          paddingTop: COMPOSER_PADDING,
          paddingBottom: COMPOSER_INPUT_TRAILING_SPACE,
          paddingLeft: COMPOSER_PADDING,
          paddingRight: COMPOSER_INPUT_TRAILING_SPACE,
          minHeight: COMPOSER_MIN_HEIGHT,
        }}
      />

      <button
        type="button"
        data-testid="composer-send"
        aria-label={streaming ? "停止生成" : "发送"}
        title={streaming ? "停止生成" : "发送"}
        disabled={disabled}
        onClick={handleSend}
        className={cn(
          "absolute flex items-center justify-center rounded-full border border-accent bg-accent-soft text-accent",
          "transition-colors duration-150 ease-out hover:bg-bg-hover active:bg-bg-active",
          "disabled:cursor-not-allowed disabled:opacity-40",
        )}
        style={{
          width: SEND_BUTTON_SIZE,
          height: SEND_BUTTON_SIZE,
          // 距输入框右/下边缘内缩（3.1：必须在边框内侧）
          right: COMPOSER_SEND_INSET,
          bottom: COMPOSER_SEND_INSET,
        }}
      >
        {streaming ? (
          <Icon icon={Square} size={14} className="text-accent" />
        ) : (
          /* Send 字形质心偏右上（8x 像素实测 (+1.05, -1.17)px @14px），按半量反向
             光学补偿——常量依据与「为何只取半量」见 lib/layout.ts；
             Square 是中心对称字形，不参与偏移。 */
          <span
            className="inline-flex"
            style={{
              transform: `translate(${SEND_ICON_OPTICAL_SHIFT_X}px, ${SEND_ICON_OPTICAL_SHIFT_Y}px)`,
            }}
          >
            <Icon icon={Send} size={14} className="text-accent" />
          </span>
        )}
      </button>
    </div>
  );
});
