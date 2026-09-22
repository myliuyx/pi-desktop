import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { COMPOSER_TOOLBAR_GAP, MESSAGE_LIST_PADDING } from "@/lib/layout";
import { useChatStore } from "@/store/chat-store";
import { Composer } from "@/components/chat/Composer";
import { ComposerToolbar } from "@/components/chat/ComposerToolbar";
import { MessageList } from "@/components/chat/MessageList";

export type WorkspaceAreaProps = HTMLAttributes<HTMLElement>;

/**
 * 内容区（弹性，可收缩）。
 *
 * `min-w-0` 是必须的：flex 子项默认 `min-width: auto`，
 * 缺了它内容不会真正收缩，折叠两侧时会挤出横向滚动条（同时挂掉 1-10 与 1-12）。
 *
 * 结构（M2）：消息流占满剩余高度，底部是固定高度的「输入区 + 工具条」。
 * ★ Composer 与工具条**在内容区内部**，不横跨窗口底部 —— 理由见 lib/layout.ts 的 M2 段注释
 *   （验收 1-3 要求侧边栏底部条带贴住窗口底，Composer 若横跨底部会把条带顶上去）。
 */
export const WorkspaceArea = forwardRef<HTMLElement, WorkspaceAreaProps>(function WorkspaceArea(
  { className, ...rest },
  ref,
) {
  const messages = useChatStore((state) => state.messages);

  return (
    <main
      ref={ref}
      data-testid="workspace-area"
      className={cn(
        // `flex` 与 `flex-col` 同传，靠 cn() 的 flex 分组把二者区分开（见 lib/cn.ts）
        "flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg-app",
        className,
      )}
      {...rest}
    >
      <MessageList messages={messages} />

      {/* 底部固定区：输入框 + 工具条。左右与底部与消息流同一边距。
          ★ 保持全宽（2026-09-22 二次裁决：输入区还原原样，仅消息流居中）。
          ⚠️ 不可在此加交叉轴 margin auto 居中：本盒是 flex-col 的子项，
          auto margin 会禁用 stretch，盒子收缩成 fit-content（实测挤成 ~180px）。 */}
      <div
        data-testid="composer-area"
        className="flex shrink-0 flex-col"
        style={{
          paddingLeft: MESSAGE_LIST_PADDING,
          paddingRight: MESSAGE_LIST_PADDING,
          paddingBottom: MESSAGE_LIST_PADDING,
          gap: COMPOSER_TOOLBAR_GAP,
        }}
      >
        <Composer />
        <ComposerToolbar />
      </div>
    </main>
  );
});

