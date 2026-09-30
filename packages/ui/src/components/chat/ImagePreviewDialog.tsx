/**
 * 图片大图预览弹层（2026-10-01 图片预览批次）。
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
 * 图片用 `object-contain` + max-h/w：完整显示不裁切（缩略图是 object-cover，
 * 放大后必须换成 contain，否则边缘被切）。
 */
import { useState } from "react";
import { Dialog } from "@/components/primitives";
import { POPOVER_Z } from "@/lib/layout";

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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label={alt}
      /* 全屏尺寸留出边距：图片按 contain 自适应，面板本身不裁切 */
      width={Math.min(window.innerWidth - 48, 1600)}
      height={Math.min(window.innerHeight - 48, 1200)}
      zIndex={POPOVER_Z}
      testId="image-preview-dialog"
    >
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-bg-elevated p-4">
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