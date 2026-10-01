import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { MESSAGE_LIST_PADDING } from "@/lib/layout";
import { useChatStore } from "@/store/chat-store";
import { Composer } from "@/components/chat/Composer";
import { MessageList } from "@/components/chat/MessageList";
import { NewSessionHero, NEW_SESSION_COMPOSER_PLACEHOLDER } from "@/components/chat/NewSessionHero";

export type WorkspaceAreaProps = HTMLAttributes<HTMLElement>;

/**
 * 内容区（弹性，可收缩）。
 *
 * `min-w-0` 是必须的：flex 子项默认 `min-width: auto`，
 * 缺了它内容不会真正收缩，折叠两侧时会挤出横向滚动条（同时挂掉 1-10 与 1-12）。
 *
 * 结构（M2）：消息流占满剩余高度，底部是固定高度的「输入区」。
 * ★ Composer **在内容区内部**，不横跨窗口底部 —— 理由见 lib/layout.ts 的 M2 段注释
 *   （验收 1-3 要求侧边栏底部条带贴住窗口底，Composer 若横跨底部会把条带顶上去）。
 * ★ 模型 / 思考 / 上下文环原先是本文件里 Composer 之后的独立工具条一行，
 *   2026-09-30 起内嵌进输入框成为底行（task-composer-inline-toolbar.md），
 *   composer-area 里只剩 Composer 一个盒子。
 */
export const WorkspaceArea = forwardRef<HTMLElement, WorkspaceAreaProps>(function WorkspaceArea(
  { className, ...rest },
  ref,
) {
  const messages = useChatStore((state) => state.messages);
  const streaming = useChatStore((state) => state.streaming);
  // 等待占位全轮覆盖（task-waiting-row-turn-start.md）：轮间空窗（下一轮已请求未开流）
  const awaitingModel = useChatStore((state) => state.awaitingModel);
  const pendingSince = useChatStore((state) => state.pendingSince);
  const newSessionDraft = useChatStore((state) => state.newSessionDraft);
  const bootstrapping = useChatStore((state) => state.bootstrapping);
  // 处理详情折叠（task-process-collapse.md）：settled 标记与会话作用域同路下传
  const settledTurnKeys = useChatStore((state) => state.settledTurnKeys);
  const liveSessionId = useChatStore((state) => state.liveSessionId);
  /*
   * 首屏遮罩（2026-10-01 首屏跳变批次）完全由MessageList 内部自管：
   * 它自己测「总高连续 N 帧不变」并渲染遮罩、自己兜底超时。
   *
   * 本层刻意不持有layoutSettled 状态，也不参与计时 ——
   * ① 遮罩必须在消息列表**真实挂载**时才有意义（bootstrapping 期间 messages 为空，
   *    走 isEmpty 分支不挂 virtualizer，此时由 hero 负责等待）；
   * ② 本层再计一次时 = 双计时器「谁先到谁说话」，反而难排查；
   * ③ 换会话复位由 key 重挂天然完成（MessageList 实例重建 ⇒ settledRef 归零）。
   */

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
      {/*
       * 新建会话草稿态（task-new-session-page.md §4.2）：整块二选一顶替 MessageList，
       * Composer / 工具条原位保留 —— 侧栏、标题栏、预览区对这次切换零感知。
       * 旧空态（`?empty=1` 的 `empty-state`，m5 5-7 锚）只服务非草稿空消息路径，不经这里。
       * 三分支（task-6，spec C3）：live 首帧 `bootstrapping` 为 true 时先占位，
       * 拿到真实数据（或 mock 下恒 false）后回落到原有的「草稿 / MessageList」二选一。
       */}
      {/*
       * 首屏遮罩期（bootstrapping 或布局未稳）仍渲染 MessageList 真实内容
       * —— 用户裁决「显示但半透明/不可交互」：遮罩在 MessageList 内部，
       * 内容在底下完成测量，撤罩后不再跳动。
       *
       * ⚠️ bootstrapping 期间 messages 为空（live 首帧不得有 mock 数据），
       * MessageList 走 isEmpty 空态分支、不挂 virtualizer ⇒ 此时不渲染遮罩
       * （无内容可遮，遮了只是一块灰）；hero 仍负责这段「连内容都还没有」的等待。
       */}
      {bootstrapping ? (
        <NewSessionHero loading />
      ) : newSessionDraft ? (
        <NewSessionHero />
      ) : (
        <MessageList
          /*
           * ★ key={liveSessionId}（2026-10-01切会话必贴底）：强制按会话重挂。
           *
           * 不重挂的缺陷（实测）：上一个会话滚到顶（scrollTop=0、atBottomRef=false）后
           * 切到另一个会话，React 复用同一滚动容器 ⇒ 浏览器保留旧 scrollTop（实测继承为 0），
           * 新会话开在顶部看历史开头；同时 atBottomRef 残留 false把自动贴底门关掉，回不来。
           *
           * 重挂的连锁收益：
           *   ① atBottomRef 归位true ⇒ 首帧 effect 自然贴底（复用既有 2-5e 路径，零新滚动逻辑）
           *   ② virtualizer 实例与 itemSizeCache 一并重建 ⇒ 消除 virtual-core 默认
           *   getItemKey(i) 用**索引**当键造成的跨会话高度缓存污染（旧会话的行高被新会话复用）
           *   ③ 展开态回到默认收起（用户已确认接受；历史会话本就默认收起，见
           *      chat-store 的 collectCollapsibleTurnKeys 回填）
           *
           * 切走正在流式的会话无额外影响：loadSessionById 本就先中止流式再换会话
           * （chat-store.ts:598），重挂时 streaming 已是 false，不会残留转圈/半展开态。
           */
          key={liveSessionId ?? "draft"}
          messages={messages}
          streaming={streaming}
          awaitingModel={awaitingModel}
          pendingSince={pendingSince}
          settledTurnKeys={settledTurnKeys}
          sessionScope={liveSessionId ?? "draft"}
        />
      )}

      {/* 底部固定区：输入框（模型/思考/上下文环已内嵌为底行）。左右与底部与消息流同一边距。
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
        }}
      >
        {/* 草稿态换图中文案（D5）；其余路径不传 prop，占位零变化 */}
        <Composer placeholder={newSessionDraft ? NEW_SESSION_COMPOSER_PLACEHOLDER : undefined} />
      </div>
    </main>
  );
});

