/**
 * 图片大图预览弹层（2026-10-01 图片预览批次）。
 *
 * 复用 `primitives/Dialog` 继承：遮罩点击关闭、Esc、焦点陷阱、焦点归还触发元素、
 * G8 过渡纪律（关闭不卸载、只 opacity + inert）。这三项都是项目既有约定，
 * 自己重写必漏其中一条。
 *
 * ⚠️ **必须条件渲染**（`{preview && <ImagePreviewDialog .../>}`）：Dialog 关闭态
 * 仍是 `role="dialog"`（Dialog.tsx 仅 opacity-0 + inert），常驻会污染
 * probe-dir-menu.mjs:1201 与 m4-acceptance.mjs:432 的「文档里第一个 [role=dialog]」
 * 锚点。`DirectoryPickerDialog` 是同款参考实现。
 *
 * 图片用 `object-contain` + max-h/w：完整显示不裁切（缩略图是 object-cover，
 * 放大后必须换成 contain，否则边缘被切）。
 */
import { useState } from "react";
import { Dialog } from "@/components/primitives";
import { POPOVER_Z } from "@/lib/layout";

export interface ImagePreviewDialogProps {
  /** 受控开关（调用方按「有预览对象才渲染」的条件渲染口径传入恒 true） */
  open: boolean;
  /** 关闭回调（Esc / 点击遮罩） */
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
  // key 绑 src：换图时重置加载态，否则上一张的失败态会粘在新图上
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
            key={src}
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