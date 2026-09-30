import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type HTMLAttributes,
  type KeyboardEvent,
} from "react";
import { Plus, Send, Square, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/common/icons";
import { useChatStore } from "@/store/chat-store";
import { useUiStore } from "@/store/ui-store";
import { useModelsStore } from "@/store/models-store";
import { useNoticeStore } from "@/store/notice-store";
import { isLiveEnabled } from "@/lib/feature-flags";
import { attachFromBlob, MAX_IMAGES_PER_MESSAGE } from "@/lib/image-attach";
import {
  ComposerAtMenu,
  type ComposerAtMenuHandle,
} from "@/components/chat/ComposerAtMenu";
import { ComposerContextRing } from "@/components/chat/ComposerContextRing";
import { ComposerToolbar } from "@/components/chat/ComposerToolbar";
import { ImagePreviewDialog } from "./ImagePreviewDialog";
import type { FsSearchEntryResult } from "@/services/agent-transport";
import {
  COMPOSER_PADDING,
  COMPOSER_MAX_HEIGHT,
  COMPOSER_MIN_HEIGHT,
  COMPOSER_ROW_PADDING_BOTTOM,
  COMPOSER_ROW_PADDING_TOP,
  COMPOSER_ROW_SEND_CLEARANCE,
  COMPOSER_SEND_INSET,
  SEND_BUTTON_SIZE,
  SEND_ICON_OPTICAL_SHIFT_X,
  SEND_ICON_OPTICAL_SHIFT_Y,
} from "@/lib/layout";

/**
 * 输入区（输入框本体 + 内嵌底行 + 内嵌右下角圆形发送按钮）。
 *
 * 冻结契约（task-M2.md 4.4）：
 * - 根节点 `data-testid="composer"` **即输入框本体**，带可见边框；
 * - textarea 为 `data-testid="composer-input"`；
 * - 发送按钮 `data-testid="composer-send"` 必须是根节点的**子孙**（验收 2-9），
 *   且矩形完全落在 composer 内、位于右下角（3.1）。
 *
 * ## 内嵌底行（task-composer-inline-toolbar.md，2026-09-30 用户裁决）
 *
 * 原先「输入框下方独立一行工具条」整体**搬进边框内部**成为底行（对齐参考图）：
 * 左簇 = `+`（插入 @ 引用）+ 上下文占用环；右簇 = 模型 / 思考 / MCP 芯片
 * （ComposerToolbar 原组件原样迁入，`composer-toolbar` testid 保留）。
 * 发送按钮仍是绝对定位右下角（2-9 / 2-10 零改动），textarea 不再为其预留
 * 右/下 padding（原 COMPOSER_INPUT_TRAILING_SPACE 退役）——底行把按钮区和
 * 文字区天然分层，避让改由底行右侧净空承担。
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
 *    底行的 `+` 按钮走同一条通路（插入 `@` 并激活弹层，见 handlePlus）。
 *
 * ## 粘贴图片（task-composer-paste-image.md，2026-09-30 用户裁决）
 *
 * textarea `onPaste` 旁路收集剪贴板里的 image item（**永不 preventDefault**——
 * textarea 原生忽略 image item，文本粘贴不受影响；图文混合 = 文本落框 + 图进待发区）。
 * 待发图存 ui-store（与 composerDraft 同生命周期：发送后清、跨会话切换保留），
 * 缩略图行渲染在 textarea 上方（D4 = 用户参考图），**有图才渲染**——无图时 composer
 * 的 DOM 与既有几何契约（testid / probe-r7）零差异。门控 D2：live 且当前模型
 * `input` 不含 `"image"` ⇒ 粘贴拒收 + 弹提示（models-store 的 payload 缺 current /
 * 缺 input 字段时宽松放行——不能因数据未到把门控做成全面禁贴）。
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
  // 粘图批次：待发图区（同在 ui-store，与草稿同生命周期）
  const pendingImages = useUiStore((state) => state.pendingComposerImages);
  const addComposerImage = useUiStore((state) => state.addComposerImage);
  const removeComposerImage = useUiStore((state) => state.removeComposerImage);
  const clearComposerImages = useUiStore((state) => state.clearComposerImages);
  /** @ 弹层状态：null = 关闭；非 null = 光标停在 @token 内 */
  const [atState, setAtState] = useState<AtTokenState | null>(null);
  /*
   * 图片大图预览（2026-10-01 图片预览批次 Task 7 Step 4）：待发缩略图点击后的大图。
   * state 挂 Composer 顶层（与 MessageList 同款纪律：预览弹层只有一份），
   * 弹层在根 <div> 末尾**条件渲染** —— 无预览对象时文档里没有 role=dialog，
   * 不污染 probe-dir-menu / m4-acceptance 的「第一个 [role=dialog]」锚点。
   *
   * ★ `previewRef` 记下打开大图的缩略图按钮，关闭时还焦点（G7）。恒传 `open` +
   * 条件渲染 ⇒ `Dialog` 看到的一直是 true，`previouslyFocused.focus?.()` 永不执行，
   * 焦点会掉到 `<body>`（手动归还与 WorkingDirectoryMenu 的 DirectoryPickerDialog 同款）。
   */
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  const openPreview = useCallback((src: string, alt: string, trigger: HTMLElement | null) => {
    previewRef.current = trigger;
    setPreview({ src, alt });
  }, []);
  const closePreview = useCallback(() => {
    const trigger = previewRef.current;
    previewRef.current = null;
    setPreview(null);
    // 卸载后再还：弹层还挂着时焦点若被 Dialog 的 rAF 抢回面板，焦点又会丢回 body
    requestAnimationFrame(() => trigger?.focus?.());
  }, []);

  const streaming = useChatStore((state) => state.streaming);
  // 「停止生成」全程可点（task-waiting-row-turn-start.md F4）：streaming 是消息级
  // （每条 assistant message_end 即 false），awaitingModel 补上工具执行期与 TTFB 空窗
  // —— 整轮未结束按钮就不退回「发送」。mock 单轮恒 false，行为不变。
  const awaitingModel = useChatStore((state) => state.awaitingModel);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const abortStream = useChatStore((state) => state.abortStream);

  /* 粘图批次 · 门控（D2）：当前模型是否接受图片输入。宽松口径见文件头。
     模型匹配 / label 回退与 ComposerToolbar 同款（provider+id 匹配，label 缺省回落 modelId）。 */
  const live = isLiveEnabled();
  const modelsPayload = useModelsStore((state) => state.payload);
  const activeImageModel = (() => {
    if (!live || !modelsPayload?.current) return null;
    const cur = modelsPayload.current;
    return modelsPayload.models.find((m) => m.provider === cur.provider && m.id === cur.modelId) ?? null;
  })();
  const activeModelSupportsImage =
    activeImageModel === null || !activeImageModel.input || activeImageModel.input.includes("image");

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

  /* at-file ①：消费「插入引用」请求（文件树 @ 按钮发起）。
     ⚠️ 依赖只放 composerInsertRequest（seq 自增保证每次请求都触发一次消费）——
     绝不能把 composerDraft 列进依赖：消费会 setComposerDraft ⇒ draft 变 ⇒ effect
     重跑 ⇒ 再插一次 ⇒ 无限循环（React Maximum update depth 崩溃，实弹抓到的真崩）。
     最新草稿经 draftRef 镜像读取（WorkingDirFileTree 的 expandedRef 同款手法）。 */
  const draftRef = useRef(composerDraft);
  draftRef.current = composerDraft;
  useEffect(() => {
    if (!composerInsertRequest) return;
    const el = taRef.current;
    if (!el) return;
    const text = composerInsertRequest.text;
    const pos = el.selectionStart ?? draftRef.current.length;
    const next = draftRef.current.slice(0, pos) + text + draftRef.current.slice(pos);
    setComposerDraft(next);
    const caret = pos + text.length;
    // rAF：等受控 value 提交后再聚焦/设光标，否则 setSelectionRange 会被重渲染覆盖
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }, [composerInsertRequest, setComposerDraft]);

  /** onChange / onSelect 共用：按当前光标重算 @ 弹层开关与查询词 */
  const syncAtState = () => {
    const el = taRef.current;
    if (!el) return;
    setAtState(computeAtState(el.value, el.selectionStart ?? el.value.length));
  };

  // 停止态：整轮进行中（流式或轮间等待，F4）按钮可点（中止）；空闲且空：禁用（验收要求无内容禁用）。
  // 粘图批次：待发图也算「有内容」——纯图无文本可发送。
  const busy = streaming || awaitingModel;
  const disabled = !busy && composerDraft.trim().length === 0 && pendingImages.length === 0;

  function handleSend() {
    if (busy) {
      abortStream();
      return;
    }
    const text = composerDraft.trim();
    if (!text && pendingImages.length === 0) return;
    // at-file ②：全文 @token 作为 fileRefs 透传（core 展开；读不到的引用经 skippedFiles 弹通知）
    // 粘图批次：待发图随 sendMessage 透传（chat-store 剥 base64 进 /prompt body + 快照进回显）
    sendMessage(text, extractAtRefs(text), pendingImages);
    setComposerDraft("");
    clearComposerImages();
    setAtState(null);
  }

  /**
   * 粘贴采集（粘图批次 §5.2）：旁路收集剪贴板 image item，**永不 preventDefault**——
   * textarea 原生忽略 image item，文本粘贴零影响（图文混合 = 文本正常落框 + 图进待发区）。
   * 门控失败/校验失败都弹 notice（上游的降级 hints 只进模型文本，用户看不见，即时反馈在 UI）。
   * busy 态允许收图（只进待发区；此时发送钮语义是「停止」，abort 后图仍在，合理）。
   */
  async function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData?.items ?? []);
    const files = items
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    if (!activeModelSupportsImage) {
      const label = activeImageModel?.label ?? "当前模型";
      useNoticeStore.getState().notify({ tone: "warning", text: `模型 ${label} 不支持图片输入，已忽略粘贴的图片` });
      return;
    }
    let added = 0;
    for (const file of files) {
      if (pendingImages.length + added >= MAX_IMAGES_PER_MESSAGE) {
        useNoticeStore
          .getState()
          .notify({ tone: "warning", text: `单条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片，超出部分已忽略` });
        break;
      }
      const r = await attachFromBlob(file);
      if (r.ok) {
        addComposerImage(r.image);
        added += 1;
      } else {
        useNoticeStore.getState().notify({ tone: "warning", text: r.reason });
      }
    }
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

  /**
   * 底行「+」按钮（task-composer-inline-toolbar.md 决策 6）：在光标处插入 `@` 并
   * 激活文件搜索弹层——与文件树 @ 按钮、手打 @ 同一条通路（插入→光标落 @ 后→
   * computeAtState 开弹层），不是上传附件。
   * ⚠️ 弹层状态必须**同步**从刚构造的 `next` 计算，不能塞进 rAF 读 draftRef：
   * rAF 在被遮挡/后台标签里会被节流到不执行，弹层就永远开不出来（5190 目验实踩）；
   * 而且回调执行早于 React 提交时 draftRef 还是旧值，算出来恒 null。rAF 只负责
   * 「等受控 value 提交后」的 focus / setSelectionRange（与插入引用消费点同一手法）。
   */
  function handlePlus() {
    const el = taRef.current;
    if (!el) return;
    const pos = el.selectionStart ?? composerDraft.length;
    const next = composerDraft.slice(0, pos) + "@" + composerDraft.slice(pos);
    const caret = pos + 1;
    setComposerDraft(next);
    setAtState(computeAtState(next, caret));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
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
        // relative 让内嵌按钮能相对它绝对定位；可见边框是「在内部」判定的前提（3.1）；
        // flex-col = textarea 在上、底行在下（同盒内分层，task-composer-inline-toolbar.md）；
        // focus-within 边框加深 = 键盘/鼠标聚焦指示（见 textarea 的 outline-none 注释）
        "relative flex w-full flex-col rounded-xl border border-border-default bg-bg-surface",
        "transition-colors duration-150 ease-out focus-within:border-border-strong",
        className,
      )}
      {...rest}
    >
      {/* 粘图批次：待发缩略图行（D4 = 参考图：框内顶部）。条件渲染——无图时本节点
          不存在，composer 的 DOM 结构与既有几何/探针契约零差异。 */}
      {pendingImages.length > 0 ? (
        <div
          data-testid="composer-images"
          className="flex flex-wrap gap-2"
          style={{
            paddingLeft: COMPOSER_PADDING,
            paddingRight: COMPOSER_PADDING,
            paddingTop: COMPOSER_PADDING,
          }}
        >
          {pendingImages.map((img, i) => (
            <div
              key={img.id}
              data-testid={`composer-image-${i}`}
              data-mime={img.mimeType}
              className="group relative h-16 w-16 shrink-0"
            >
              <button
                type="button"
                onClick={(e) => openPreview(img.dataUrl, `待发送图片 ${i + 1}`, e.currentTarget)}
                title="点击查看大图"
                aria-label={`查看待发送图片 ${i + 1}`}
                className="block h-16 w-16 cursor-zoom-in overflow-hidden rounded-lg border border-border-subtle"
              >
                <img
                  src={img.dataUrl}
                  alt={`待发送图片 ${i + 1}`}
                  className="h-16 w-16 object-cover"
                />
              </button>
              <button
                type="button"
                data-testid={`composer-image-remove-${i}`}
                aria-label={`移除图片 ${i + 1}`}
                title="移除"
                /* 防御性：截断继续向上冒泡到 composer 根的点击。
                   ⚠️ 旧注释说「不阻断就会同时触发大图预览」是错的 —— 移除按钮与预览按钮
                   是**兄弟**节点（同一缩略图格内的两个 button），DOM 事件在兄弟之间
                   不传播，它对预览本就无效。保留只为不再冒泡到 composer 根。 */
                onClick={(e) => {
                  e.stopPropagation();
                  removeComposerImage(img.id);
                }}
                className={cn(
                  "absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full",
                  "border border-border-subtle bg-bg-surface text-text-secondary",
                  "transition-opacity duration-150 ease-out hover:bg-bg-hover hover:text-text-primary",
                  "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                )}
              >
                <Icon icon={X} size={11} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

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
        onPaste={handlePaste}
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
           * ⚠️ outline-none 是 2026-09-30 用户目验裁决，**推翻 M5 5-3** 的「不能写
           * outline-none」：globals.css 的 `:focus-visible` 全局环（accent 蓝 2px）
           * 在 Chromium 里对文本输入框**鼠标点击也命中**（支持键盘输入的元素聚焦
           * 即匹配 :focus-visible），蓝框因此常显、且只框住 textarea 上半截，
           * 与底行同盒分层后观感尤其怪（用户截图反馈「蓝色框框取消」）。
           *
           * 焦点指示没有丢：迁到 composer 根的 `focus-within:border-border-strong`
           * （整盒边框加深），键盘 Tab 进输入框仍可见、指示面积反而更大。
           * G7 采样（Tab 6 次落在标题栏按钮区）不受影响，m2 已复跑验证。
           */
          "outline-none",
          "placeholder:text-text-tertiary",
          "overflow-y-auto overflow-x-hidden",
        )}
        style={{
          // 底行把发送按钮区与文字区天然分层，textarea 四边回归统一内边距
          // （原右/下 36px 按钮预留随工具条入盒退役，见文件头「内嵌底行」）
          paddingTop: COMPOSER_PADDING,
          paddingBottom: COMPOSER_PADDING,
          paddingLeft: COMPOSER_PADDING,
          paddingRight: COMPOSER_PADDING,
          minHeight: COMPOSER_MIN_HEIGHT,
        }}
      />

      {/*
       * 内嵌底行：左簇（+ 引用入口、上下文占用环）+ 右簇（模型/思考/MCP 芯片，
       * ComposerToolbar 自带 ml-auto 贴右）。右侧 padding 为绝对定位的发送按钮
       * 预留净空（COMPOSER_ROW_SEND_CLEARANCE），底缘留白与按钮 bottom 内缩同值。
       */}
      <div
        data-testid="composer-bottom-row"
        className="flex w-full items-center gap-2"
        style={{
          paddingLeft: COMPOSER_PADDING,
          paddingRight: COMPOSER_ROW_SEND_CLEARANCE,
          paddingTop: COMPOSER_ROW_PADDING_TOP,
          paddingBottom: COMPOSER_ROW_PADDING_BOTTOM,
        }}
      >
        <button
          type="button"
          data-testid="composer-plus"
          aria-label="插入 @ 文件引用"
          title="插入 @ 文件引用"
          onClick={handlePlus}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary",
            "transition-colors duration-150 ease-out hover:bg-bg-hover hover:text-text-primary active:bg-bg-active",
          )}
        >
          <Icon icon={Plus} size={16} />
        </button>

        <ComposerContextRing />

        <ComposerToolbar />
      </div>

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

      {/* 图片大图预览（待发图）：条件渲染，理由见 preview state 注释。
          key={src} 让换图时卸载重挂、组件内加载态自然归零（见 ImagePreviewDialog 文件头）；
          onClose 手动把焦点还给打开它的缩略图按钮（G7）。 */}
      {preview ? (
        <ImagePreviewDialog
          key={preview.src}
          open
          onClose={closePreview}
          src={preview.src}
          alt={preview.alt}
        />
      ) : null}
    </div>
  );
});
