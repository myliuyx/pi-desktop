/**
 * 图片大图预览弹层（2026-10-01 图片预览批次；同日「面板随图走」修订，
 * 见 .plan/task-image-preview-fit.md）。
 *
 * 复用 `primitives/Dialog` 继承：遮罩点击关闭、Esc、焦点陷阱。这三项都是项目既有约定，
 * 自己重写必漏其中一条。
 *
 * ⚠️ **必须条件渲染**（`{preview && <ImagePreviewDialog .../>}`）：Dialog 关闭态
 * 仍是 `role="dialog"`（Dialog.tsx 仅 opacity-0 + inert），常驻会污染
 * probe-dir-menu.mjs:1201 与 m4-acceptance.mjs:432 的「文档里第一个 [role=dialog]」
 * 锚点。`DirectoryPickerDialog` 是同款参考实现。
 *
 * 条件渲染是**探针锚点的硬要求，不是收益**：关闭 = 组件硬卸载，因此
 * G8「关闭不卸载、只 opacity + inert」的过渡纪律在本调用点上**不成立** ——
 * 打开淡入有（Dialog 挂载后自带过渡），关闭没有任何淡出动画。
 *
 * ⚠️ **焦点归还不由 Dialog 兜底，调用点必须手动补**：`Dialog` 的归还逻辑挂在
 * `open` 由 true→false 的那次 effect 重跑上（Dialog.tsx 的 `if (open) {…}`
 * 分支里只 return 了 `cancelAnimationFrame` 的 cleanup，`previouslyFocused.focus?.()`
 * 在 if 之外）。本组件按上面的口径**恒传 `open`**，关闭即卸载 ⇒ effect 只跑 cleanup
 * ⇒ `focus()` 一次都不会执行，焦点落到 `<body>`，键盘用户 Tab 要从文档顶部重来。
 * 调用点的 `onClose` 必须显式 `focus()` 回触发元素
 * （`WorkingDirectoryMenu.tsx` 的 `DirectoryPickerDialog` 是同款既有做法）。
 *
 * ⚠️ **换图重置加载态靠调用点的 `key`**：见下面 `failed`/`loaded` 的注释。
 *
 * ## 面板随图走（本批修订，修「巨大白色背景、图片只有一小块」）
 *
 * 旧实现把面板写死近全屏 + 内层容器 `flex-1`（父级非 flex，无效）⇒ `max-h-full`
 * 对 auto 高度包含块解析为 none ⇒ 图片按原始像素渲染、大图还被静默裁切。
 * 现在：
 * - 挂载即用 `new Image()` **预取自然尺寸**，`computePreviewPanelSize` 反推面板
 *   宽高（不放大、贴视口余量）；实测回来前面板以 `IMAGE_PREVIEW_PROVISIONAL`
 *   出现（加载/失败态同尺寸）——dataUrl/localhost 解码 <50ms 无感，慢网也不死点击。
 * - 内层容器 `h-full`（Dialog children 包装层高度确定，`h-full` 才是真约束），
 *   `<img>` 的 `max-h-full` 由此真正生效，大图 object-contain 完整显示不裁切。
 * - 同 src 二次解码走内存缓存，预取无双重下载；`natural ≤ 0` 按加载失败处理。
 */
import { useEffect, useState } from "react";
import { Dialog } from "@/components/primitives";
import { POPOVER_Z } from "@/lib/layout";
import {
  computePreviewPanelSize,
  IMAGE_PREVIEW_PROVISIONAL,
} from "@/lib/image-preview-size";

export interface ImagePreviewDialogProps {
  /** 受控开关（调用方按「有预览对象才渲染」的条件渲染口径传入恒 true）。
      恒 true 意味着 `Dialog` 不会看到 false ⇒ 焦点归还必须由调用点在 onClose 里自己补。 */
  open: boolean;
  /** 关闭回调（Esc / 点击遮罩）。调用点负责把焦点还给触发元素，见文件头。 */
  onClose: () => void;
  /** 图片源：历史图 = /sessions/image URL；待发图 = dataUrl */
  src: string;
  alt: string;
  /** 取图/解码失败时的兜底文案 */
  errorText?: string;
}

export function ImagePreviewDialog({
  open,
  onClose,
  src,
  alt,
  errorText = "图片无法加载",
}: ImagePreviewDialogProps) {
  /*
   * 加载/失败态。
   *
   * ⚠️ **调用点必须传 `key={src}`**（`<ImagePreviewDialog key={src} open …/>`）：
   * 换图重置加载态靠的是「key 变化 ⇒ 卸载旧实例、挂载新实例 ⇒ useState 归零」。
   * `key` 若只挂在 `<img>` 上是**无效**的 —— React 语义下同位置、同类型、无 key
   * 才是「复用实例并保留 useState」，key 挂在 `<img>` 上只强制换 DOM 节点，
   * 本组件的 state 纹丝不动。真实坏路径：A 图加载失败（failed=true → 渲染走
   * 「图片无法加载」分支，`<img>` 根本没挂载）→ 不关弹层直接点缩略图 B →
   * 实例被复用、failed 仍为 true → B 的 `<img>` 从未挂载 ⇒ B 再也触发不了
   * onLoad/onError ⇒ 永远显示失败，只能关掉重开。
   */
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /** 预取到的自然尺寸；null = 实测未回（面板停在预置尺寸） */
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  /*
   * 预取自然尺寸：面板随图走的依据。`key={src}` 已保证换图重挂（state 归零），
   * effect 依赖 `src` 重跑 + cancelled 清理只是防御（调用点漏 key 时不串尺寸）。
   */
  useEffect(() => {
    setNatural(null);
    setFailed(false);
    let cancelled = false;
    const probe = new Image();
    probe.onload = () => {
      if (cancelled) return;
      // onload 但自然尺寸 0（某些损坏图）：按失败走，避免 scale 除 0 / 荒诞面板
      if (probe.naturalWidth <= 0 || probe.naturalHeight <= 0) {
        setFailed(true);
        return;
      }
      setNatural({ w: probe.naturalWidth, h: probe.naturalHeight });
    };
    probe.onerror = () => {
      if (!cancelled) setFailed(true);
    };
    probe.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  const { width, height } = natural
    ? computePreviewPanelSize(natural.w, natural.h, window.innerWidth, window.innerHeight)
    : IMAGE_PREVIEW_PROVISIONAL;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label={alt}
      /* 面板随图走：实测前预置小尺寸，实测后贴图（不放大 / 大图贴视口余量） */
      width={width}
      height={height}
      zIndex={POPOVER_Z}
      testId="image-preview-dialog"
    >
      {/*
        * h-full 是本批 contain 链的修复点：Dialog 的 children 包装层是普通 block
        * （高度确定），这里曾写 flex-1（父级非 flex ⇒ 无效 ⇒ 高度 auto ⇒
        * <img> 的 max-h-full 解析为 none，图片按原始像素渲染、大图被裁）。
        * h-full 让本容器高度确定，max-h-full 由此真正钳住。
        */}
      <div className="flex min-h-0 h-full items-center justify-center overflow-auto bg-bg-elevated p-4">
        {failed ? (
          <p data-testid="image-preview-error" className="text-sm text-text-secondary">
            {errorText}
          </p>
        ) : (
          <img
            src={src}
            alt={alt}
            data-testid="image-preview-img"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            className="max-h-full max-w-full object-contain"
            style={{ display: loaded ? "block" : "none" }}
          />
        )}
        {!loaded && !failed ? (
          <p className="text-sm text-text-secondary" data-testid="image-preview-loading">
            加载中…
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
