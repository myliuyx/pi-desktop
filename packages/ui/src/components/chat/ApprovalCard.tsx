import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/common/icons";
import { Check, ShieldQuestion } from "lucide-react";
import type { ApprovalBlock } from "@/mock/types";
import { useChatStore } from "@/store/chat-store";

export interface ApprovalCardProps {
  block: ApprovalBlock;
}

/**
 * 授权卡片（可交互 / 已决置灰 / 超时失效）。
 *
 * - 未决（resolved 为空）：两个选项都可直接点，点击后写回 store（resolveApproval）。
 * - 已决：两个选项都 `disabled`（验收 2-8 要求不可再点），并高亮用户已选的那一项。
 * - `data-resolved` 必须反映真实状态：resolved 非空为 "true"，空为 "false"。
 *   验收脚本会构造「已决卡片两按钮都 disabled」的反例。
 *
 * C3 新增（不碰上面任何既有行为；mock 数据不带 `timeoutMs` ⇒ 渲染与从前一致）：
 * - **倒计时 / 失效态**（S3 §3.2）：请求带 `timeoutMs` 时渲染倒计时，到点按钮置灰不可点
 *   （`data-expired="true"`）—— 因为 core 侧到点已把该 id 结算掉，再点只会被静默丢弃。
 * - **拒绝理由明示**（B2 裁决）：结算后按结论给出文案。core 只回 `accepted`/`cancelled`
 *   两种 resolution，具体选项文案由 store 本地乐观写入（`resolved`），这里按
 *   「第一项 = 肯定项」的约定判别肯定/否定，并把「拒绝/取消」的后果讲清楚。
 */
export function ApprovalCard({ block }: ApprovalCardProps) {
  const resolveApproval = useChatStore((state) => state.resolveApproval);
  const resolved = block.resolved ?? "";
  const isResolved = resolved !== "";
  /** A1：input 型请求 → 渲染输入框 + 提交按钮（与 options 按钮互斥；method 缺省走旧渲染） */
  const isInput = block.method === "input";

  /*
   * 倒计时以「本卡片挂载时刻 + timeoutMs」为截止点：
   * 请求事件与卡片渲染在同一拍到达，误差在毫秒级；不做跨端时钟同步（无必要）。
   * 结算（resolved 非空）后立刻停表，避免已决卡片还挂着数字。
   */
  const timeoutMs = block.timeoutMs;
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  useEffect(() => {
    if (!timeoutMs || isResolved) {
      setRemainingMs(null);
      return;
    }
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const left = deadline - Date.now();
      setRemainingMs(left > 0 ? left : 0);
      return left <= 0;
    };
    if (tick()) return;
    const timer = setInterval(() => {
      if (tick()) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [timeoutMs, isResolved]);

  const showCountdown = !!timeoutMs && !isResolved && remainingMs !== null;
  const expired = !!timeoutMs && !isResolved && remainingMs !== null && remainingMs <= 0;
  const disabled = isResolved || expired;

  /* A1：input 提交（空文本禁提交；Enter 提交；与 options 按钮同一条 resolveApproval 链路） */
  const [inputText, setInputText] = useState("");
  const canSubmitInput = !disabled && inputText.trim() !== "";
  const submitInput = () => {
    if (!canSubmitInput) return;
    resolveApproval(block.requestId, inputText);
  };

  /** C3：结论/状态 → 明示文案（拒绝与取消的后果不同，别让用户猜） */
  const reasonText = (() => {
    if (isResolved) {
      // A1：input 卡没有 options，「第一项=肯定项」启发式不适用 ——
      // 输入文本本身是应答（由「已提交」行展示），accepted/cancelled 才需要解释文案
      if (isInput) {
        if (resolved === "accepted") return "已应答：本次请求按输入内容处理。";
        if (resolved === "cancelled") {
          return "已取消（core 超时或调用方取消）：本次调用不会执行；扩展收到的是「取消」而不是输入文本。";
        }
        return "";
      }
      if (resolved === "accepted") return "已应答：本次请求按所选选项处理。";
      if (resolved === "cancelled") {
        return "已取消（core 超时或调用方取消）：本次调用不会执行；扩展收到的是「取消」而不是选项文案。";
      }
      return resolved === block.options[0]
        ? "已允许：本次调用获授权执行。"
        : "已拒绝：本次调用不会执行；扩展会把拒绝原因回传给模型（B2：拒绝理由明示）。";
    }
    if (expired) {
      return "已超时：core 已按「取消」自动结算，此处不可再应答（再点会被静默丢弃）。";
    }
    return "";
  })();

  return (
    <div
      data-testid="approval-card"
      data-resolved={isResolved}
      data-expired={expired}
      className="min-w-0 rounded-lg border border-border-default bg-bg-surface p-3"
    >
      <div className="mb-1.5 flex items-center gap-2 text-sm font-medium leading-5 text-text-primary">
        <Icon icon={ShieldQuestion} className="shrink-0 text-icon-neutral" />
        {block.title}
      </div>
      {block.message ? <p className="mb-3 text-sm leading-5 text-text-secondary">{block.message}</p> : null}

      {/* A1：input 型只出输入框，不出 options 按钮（二者互斥；method 缺省保持旧渲染逐像素不变） */}
      {isInput ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            data-testid="approval-input"
            type="text"
            value={inputText}
            disabled={disabled}
            placeholder={block.placeholder}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitInput();
              }
            }}
            className={cn(
              "min-w-0 flex-1 rounded-md border border-border-default bg-bg-app px-2.5 py-1.5 text-sm text-text-primary",
              "placeholder:text-text-tertiary transition-colors",
              "focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          />
          <button
            type="button"
            data-testid="approval-input-submit"
            disabled={!canSubmitInput}
            onClick={submitInput}
            className={cn(
              "inline-flex items-center rounded-md border border-accent bg-accent px-3 py-1.5 text-sm text-accent-fg",
              "transition-colors hover:bg-accent-hover",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
              "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-accent",
            )}
          >
            提交
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {block.options.map((option, index) => {
            const chosen = resolved === option;
            return (
              <button
                key={option}
                type="button"
                data-testid={`approval-option-${index}`}
                data-option={option}
                disabled={disabled}
                onClick={() => resolveApproval(block.requestId, option)}
                aria-pressed={chosen}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors",
                  "disabled:cursor-not-allowed",
                  "focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
                  chosen
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border-default bg-bg-app text-text-primary enabled:hover:bg-bg-hover",
                  // A2：disabled 统一收敛为「透明度 + 文案」，不再区分已选/未选
                  disabled && "opacity-60",
                )}
              >
                {chosen ? <Icon icon={Check} className="text-current" /> : null}
                {option}
              </button>
            );
          })}
        </div>
      )}

      {showCountdown ? (
        <p
          data-testid="approval-countdown"
          className={cn(
            "mt-2.5 text-xs transition-colors",
            expired || (remainingMs !== null && remainingMs <= 10_000) ? "text-danger" : "text-text-tertiary",
          )}
        >
          {expired ? "已超时" : `剩余 ${Math.ceil((remainingMs ?? 0) / 1000)} 秒`}
        </p>
      ) : null}

      {isResolved && !(isInput && (resolved === "accepted" || resolved === "cancelled")) ? (
        <p className="mt-2.5 text-xs text-text-tertiary">
          {isInput ? (
            <>
              已提交：<span className="text-text-secondary">{resolved}</span>
            </>
          ) : (
            `已选择：${resolved}`
          )}
        </p>
      ) : null}

      {reasonText ? (
        <p data-testid="approval-reason" className={cn("mt-1.5 text-xs", expired ? "text-danger" : "text-text-tertiary")}>
          {reasonText}
        </p>
      ) : null}
    </div>
  );
}
