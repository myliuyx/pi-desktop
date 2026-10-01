import { createPortal } from "react-dom";
import { ApprovalCard } from "@/components/chat/ApprovalCard";
import { Dialog } from "@/components/primitives/Dialog";
import { APPROVAL_OVERLAY_WIDTH } from "@/lib/layout";
import { approvalEventToBlock } from "@/adapter/reduce";
import { useChatStore } from "@/store/chat-store";

/**
 * 无宿主授权请求的全局模态浮层（hostless-approval-overlay 批次）。
 *
 * ## 为什么需要它
 *
 * 授权卡此前的唯一渲染路径是 `MessageList` 里 assistant 消息的内嵌块，而信任门
 * （cwd 切换 / core 启动）的 `approval_request` 发生在**零消息时刻**——新建会话草稿态
 * 连 `MessageList` 都不在场，事件被 reducer 的宿主判据静默丢弃（`reduce.ts` 对
 * `!ownerId` 原样返回）→ core 等应答到 120s 超时，用户只觉得「点了没反应」。
 * chat-store 的 SSE 路由把无宿主事件落进顶层 `pendingApprovals`，这里负责画出来。
 *
 * ## 形态（D2 已裁：模态弹窗）
 *
 * - **模态**：正在决定「是否执行本目录的可执行代码」，值得打断；焦点强制；
 *   天然阻塞「未决期间又发消息/新建会话」与 switchCwd 的竞态。
 * - **不可误关**：`onClose` 为 no-op —— Esc / 点遮罩都不会把未决请求藏起来
 *   （否则又回到「看不见」）；出口是卡上的选项按钮（信任门「不信任」与取消同终态）
 *   或 core 侧超时自动结算（settled → 条目移除 → 浮层消失）。**不设取消按钮**
 *   （规格书 §五：信任门两键即出口，扩展级 hostless 提问当前不存在）。
 * - **条件渲染纪律**：无未决时整个浮层不进 DOM —— Dialog 关闭态也是 `role="dialog"`，
 *   常驻会污染「文档第一个 role=dialog」探针锚点（dir-picker C13 同坑）。
 *
 * 卡片本体复用 `ApprovalCard`（倒计时/失效态/已决置灰全继承）；块映射与消息树内嵌卡
 * 共用 `approvalEventToBlock`（口径只有一处）。`whiteSpace: pre-line` 让信任门多行
 * title（明示后果三行）按 `\n` 换行——该属性可继承，ApprovalCard 内部未显式覆盖。
 */
export function ApprovalOverlay() {
  const pending = useChatStore((state) => state.pendingApprovals);
  if (pending.length === 0) return null;
  return createPortal(
    <Dialog
      open
      onClose={() => {}}
      label="待应答的授权请求"
      width={APPROVAL_OVERLAY_WIDTH}
      testId="approval-overlay"
    >
      <div className="max-h-[70vh] space-y-3 overflow-y-auto p-4" style={{ whiteSpace: "pre-line" }}>
        {pending.map((event) => (
          <ApprovalCard key={event.requestId} block={approvalEventToBlock(event)} />
        ))}
      </div>
    </Dialog>,
    document.body,
  );
}
