import { cn } from "@/lib/cn";

/**
 * 模型请求失败错误框（2026-09-28 用户裁决：失败要直接可见，不许静默）。
 *
 * 背景：Pi 在模型请求失败时产出 `stopReason="error"` 的 assistant 消息 ——
 * content 为空壳、错误文本只在 errorMessage 字段。此前该消息被空壳隐藏逻辑
 * 整行吞掉，用户视角就是「消息发出去没影了」（2026-09-28 Linux 实测：
 * provider 容量满 → 界面零反馈、无任何出口）。
 *
 * 展示口径对齐上游 TUI（assistant-message.ts:196 的 `Error: ${errorMessage}`）：
 * 红色等宽文本框；模型标签与时间戳照常由 MessageItem / MessageFooter 渲染，
 * 与用户参考截图一致。样式走语义令牌（--danger / --danger-soft，亮暗主题各有一套）。
 */
export function MessageErrorCard({ message }: { message: string }) {
	return (
		<div
			data-testid="message-error-card"
			role="alert"
			className={cn(
				"w-full rounded-lg border border-danger bg-danger-soft px-3 py-2",
				"font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-danger",
			)}
		>
			{`Error: ${message}`}
		</div>
	);
}
