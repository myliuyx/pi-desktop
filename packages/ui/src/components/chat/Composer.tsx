import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
} from "react";
import { Send, Square } from "lucide-react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/common/icons";
import { useChatStore } from "@/store/chat-store";
import { useUiStore } from "@/store/ui-store";
import {
  ComposerAtMenu,
  type ComposerAtMenuHandle,
} from "@/components/chat/ComposerAtMenu";
import type { FsSearchEntryResult } from "@/services/agent-transport";
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
 *
 * ## at-file 批次（task-composer-at-file.md §4.3）的两处增量
 *
 * ① **草稿提升**：文本从本地 state 换成 `ui-store.composerDraft`（文件树的「@ 引用」
 *    入口要与输入框打通，两棵子树只有共享 store 能握手）；`composerInsertRequest`
 *    消费点在本组件（插到光标处 + 聚焦 + 光标移到插入尾）。testid / 几何 / 键盘
 *    行为等冻结契约零改动。
 * ② **@ 弹层**：光标所在 token 以 `@` 开头（且 @ 前是行首/空白，`a@b` 邮箱不触发）
 *    即激活文件搜索弹层；弹层开着时 ↑↓/Enter/Tab/Esc 被弹层消费（Enter 不发送）。
 *    发送时从全文提取 @token 作为 fileRefs 透传（core 展开成 `<file>` 块/图片附件）。
 */

export interface ComposerProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * 覆盖占位文案（新建会话草稿态传图中文案，task-new-session-page.md §4.0 D5）。
   * 只影响 placeholder —— aria-label / testid / 发送按钮几何 / 键盘行为等
   * 冻结契约零改动；不传（全部既有调用点）保持原文案，行为零变化。
   */
  placeholder?: string;
}

/** @ token 的区间与查询词（null = 弹层关闭） */
interface AtTokenState {
  start: number;
  end: number;
  query: string;
}

/**
 * 光标处的 @ token 检测：从 caret 向前扫到行首或空白，token 以 `@` 开头即激活。
 * 前扫本身保证了「@ 前是行首或空白」—— `a@b` 的 token 会一路回退到 `a@b`，
 * 不以 @ 开头，自然排除邮箱形态。
 */
function computeAtState(value: string, caret: number): AtTokenState | null {
  let start = caret;
  while (start > 0 && !/\s/.test(value[start - 1] ?? "")) start--;
  const token = value.slice(start, caret);
  if (!token.startsWith("@")) return null;
  return { start, end: caret, query: token.slice(1) };
}

/**
 * 全文提取 @引用（发送时作为 fileRefs 透传给 core，与 CLI「全部 @file 参数」语义一致）：
 * 只认「行首或空白后」的 @token（同一正则语义的手工版），去重、裸 `@` 不算。
 * 手打的 `@path` 与弹层选中的一视同仁；core 读不到的引用会经 skippedFiles 弹通知。
 */
export function extractAtRefs(text: string): string[] {
  const refs = new Set<string>();
  const re = /(^|\s)@([^\s]+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[2] && m[2].length > 0) refs.add(m[2]);
  }
  return [...refs];
}

export const Composer = forwardRef<HTMLDivElement, ComposerProps>(function Composer(
  { placeholder, className, ...rest },
  ref,
) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  /** 弹层定位锚：composer 根盒（forwardRef 的外部 ref 可能不传，锚用内部 ref 独立持有） */
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<ComposerAtMenuHandle>(null);

  // at-file ①：草稿提升——value 的唯一真相在 ui-store（冻结契约不变，见文件头）
  const composerDraft = useUiStore((state) => state.composerDraft);
  const setComposerDraft = useUiStore((state) => state.setComposerDraft);
  const composerInsertRequest = useUiStore((state) => state.composerInsertRequest);
  /** @ 弹层状态：null = 关闭；非 null = 光标停在 @token 内 */
  const [atState, setAtState] = useState<AtTokenState | null>(null);

  const streaming = useChatStore((state) => state.streaming);
  // 「停止生成」全程可点（task-waiting-row-turn-start.md F4）：streaming 是消息级
  // （每条 assistant message_end 即 false），awaitingModel 补上工具执行期与 TTFB 空窗
  // —— 整轮未结束按钮就不退回「发送」。mock 单轮恒 false，行为不变。
  const awaitingModel = useChatStore((state) => state.awaitingModel);
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
  }, [composerDraft]);

  /* at-file ①：消费「插入引用」请求（文件树 @ 按钮发起；seq 相同不重复消费） */
  useEffect(() => {
    if (!composerInsertRequest) return;
    const el = taRef.current;
    if (!el) return;
    const text = composerInsertRequest.text;
    const pos = el.selectionStart ?? composerDraft.length;
    const next = composerDraft.slice(0, pos) + text + composerDraft.slice(pos);
    setComposerDraft(next);
    const caret = pos + text.length;
    // rAF：等受控 value 提交后再聚焦/设光标，否则 setSelectionRange 会被重渲染覆盖
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
    // composerDraft 在依赖里让 effect 拿到最新草稿；seq 相同的重跑由上方 if 拦下（幂等）
  }, [composerInsertRequest, composerDraft, setComposerDraft]);

  /** onChange / onSelect 共用：按当前光标重算 @ 弹层开关与查询词 */
  const syncAtState = () => {
    const el = taRef.current;
    if (!el) return;
    setAtState(computeAtState(el.value, el.selectionStart ?? el.value.length));
  };

  // 停止态：整轮进行中（流式或轮间等待，F4）按钮可点（中止）；空闲且空：禁用（验收要求无内容禁用）
  const busy = streaming || awaitingModel;
  const disabled = !busy && composerDraft.trim().length === 0;

  function handleSend() {
    if (busy) {
      abortStream();
      return;
    }
    const text = composerDraft.trim();
    if (!text) return;
    // at-file ②：全文 @token 作为 fileRefs 透传（core 展开；读不到的引用经 skippedFiles 弹通知）
    sendMessage(text, extractAtRefs(text));
    setComposerDraft("");
    setAtState(null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // at-file ②：弹层开着时按键先给弹层（↑↓ 移动、Enter/Tab 选中、Esc 关闭；
    // Enter 被消费就不会落到底下的「发送」）
    if (menuRef.current?.isOpen() && menuRef.current.handleKey(e.nativeEvent)) return;
    // Enter 发送、Shift+Enter 换行（原型内闭环；与验收不冲突）
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  /** 弹层选中：把 @token 区间原地替换为 `@<relPath> `，光标落在插入尾 */
  function handleAtPick(entry: FsSearchEntryResult) {
    if (!atState) return;
    const snippet = `@${entry.relPath} `;
    const next = composerDraft.slice(0, atState.start) + snippet + composerDraft.slice(atState.end);
    setComposerDraft(next);
    setAtState(null);
    const caret = atState.start + snippet.length;
    const el = taRef.current;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  return (
    <div
      ref={(node) => {
        anchorRef.current = node;
        // 外部 ref 兼容 forwardRef 转发（函数/对象 ref 两种形态都处理）
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
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
        value={composerDraft}
        onChange={(e) => {
          setComposerDraft(e.target.value);
          syncAtState();
        }}
        onSelect={syncAtState}
        onKeyDown={onKeyDown}
        onBlur={() => setAtState(null)}
        // ⚠️ 默认 placeholder 文案被 probe-new-session.mjs 的 DEFAULT_PLACEHOLDER 断言锁定，
        // 改文案须先改探针（「@ 引用文件」的提示已由 NewSessionHero 提示行承担）
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
        aria-label={busy ? "停止生成" : "发送"}
        title={busy ? "停止生成" : "发送"}
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
        {busy ? (
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

      {/* @ 文件搜索弹层（portal 到 body；mock/SSR 下组件内部返回 null，键盘路由短路） */}
      {atState ? (
        <ComposerAtMenu
          ref={menuRef}
          query={atState.query}
          anchorEl={anchorRef.current}
          onPick={handleAtPick}
          onClose={() => setAtState(null)}
        />
      ) : null}
    </div>
  );
});
