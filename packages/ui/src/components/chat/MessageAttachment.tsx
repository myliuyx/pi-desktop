/**
 * 消息里的图片缩略图 —— **两条通道共用的唯一实现**（2026-10-02 由 MessageList 抽出）。
 *
 * ## 为什么抽成独立文件
 *
 * 两处通道需要同款可点缩略图，但它们所在的组件互相 import 会成环：
 *
 *   历史通道：`MessageList` → `BlockView`（case "image"）→ 本组件
 *   刚发送通道：`MessageList` → `MessageItem` → `BlockView`（case "text"）
 *              → `MessageBubble`（attachments 行）→ 本组件
 *
 * 实现若留在 `MessageList.tsx`，`MessageBubble.tsx` 反向 import 它就是
 * `MessageList ⇄ MessageBubble` 循环依赖 ⇒ 抽到中性位置，两边都单向依赖。
 *
 * ## 为什么必须是同一个组件（而不是各写一份）
 *
 * 这正是本文件被抽出来的直接原因：**修复前刚发送通道是裸 `<img>`**（无 button /
 * 无 onClick），点了毫无反应，而历史通道完全正常 —— 两处各写一份的实现，
 * 后者漏接了预览接线，而历史通道的既有探针判据（C1–C5）全绿，
 * **缺陷从所有判据的缝里漏了过去**（用户实测报「发完图片点不开预览」）。
 * 抽成一份后，"新增一条图片通道就自动可点"成为结构性事实，而非靠人记得补。
 *
 * 另一层收益：加载失败态（onError → "图未能加载"）也一并统一 —— 刚发送通道
 * 此前连失败都是静默的（浏览器默认碎图标）。
 *
 * ## 不变项（既有探针依赖，不要改）
 *
 * - `testId` **缺省就是 `message-image-thumb`** ⇒ 历史通道调用点零改动，
 *   probe-image-preview.mjs 的 C1/C3/C5 断言继续有效；
 * - 尺寸 `h-16` 是几何契约的一部分（探针按它采样）；
 * - `onPreview` 回调带**按钮自身**（事件 currentTarget）：调用层存下来，
 *   关闭预览时把焦点还回去（G7）。用回调传 ref 而不是 `document.activeElement`
 *   快照 —— 鼠标点击会把焦点放到按钮上没问题，但由键盘/程序触发时
 *   activeElement 可能还在别处。
 */
import { useState } from "react";

export interface MessageAttachmentProps {
  /** 图片源：历史图 = /sessions/image URL；刚发送的贴图 = dataUrl */
  src: string;
  /** 无障碍文案（不含"查看"前缀，本组件自行拼 `查看${alt}`） */
  alt: string;
  /** 点击回调，带上触发按钮本身供关闭后归还焦点 */
  onPreview: (trigger: HTMLButtonElement) => void;
  /**
   * 按钮上的 testid。**缺省 `message-image-thumb`（历史通道的既有契约）**；
   * 刚发送通道传 `message-attachment-${id}` —— 该值沿用修复前的 img 上的 testid，
   * 不改名是为了不打碎任何按它定位的东西（尽管目前全仓无断言）。
   */
  testId?: string;
}

export function MessageAttachment({ src, alt, onPreview, testId = "message-image-thumb" }: MessageAttachmentProps) {
  /*
   * 加载失败要直接可见（2026-09-28 用户裁决「失败要可见，不许静默」，同 contract.ts 的
   * 诚实展示纪律）：`<img>` 无 onError 时加载失败只留浏览器默认碎图标，user 完全看不出
   * 「图真的存在但没加载出来」—— 而取图失败在跨源形态、跨 cwd 档位、entryId 失效等
   * 场景下都会发生，静默会让排查无从下手。
   * 预览弹层里已有独立的失败态文案，这里给缩略图补上同一口径。
   */
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => onPreview(e.currentTarget)}
      title="点击查看大图"
      aria-label={`查看${alt}`}
      data-testid={testId}
      data-load-state={failed ? "error" : "ok"}
      className="group inline-block h-16 max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-border-subtle"
    >
      {failed ? (
        <span className="flex h-16 w-16 items-center justify-center text-text-tertiary" data-testid="message-image-failed">
          <span className="text-xs">图未能加载</span>
        </span>
      ) : (
        <img src={src} alt={alt} onError={() => setFailed(true)} className="h-16 max-w-full object-cover" />
      )}
    </button>
  );
}