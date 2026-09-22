import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  RUN_STEP_DETAIL_MAX_HEIGHT,
  RUN_STEP_SUMMARY_MAX_HEIGHT,
  TIMELINE_DOT_SIZE,
  TIMELINE_RAIL_WIDTH,
} from "@/lib/layout";
import { Sidebar } from "@/components/shell/Sidebar";
import { SidebarFooter } from "@/components/shell/SidebarFooter";
import { WindowShell } from "@/components/shell/WindowShell";
import type { OsName } from "@/components/shell/TitleBar";
import { Icon, type LucideIcon } from "@/components/common/icons";
import { Check, Loader2, Circle, X } from "lucide-react";
import { PlanCard } from "@/components/chat/PlanCard";
import { TerminalCard } from "@/components/chat/TerminalCard";
import { ScreenArea, ScreenBody, ScreenHeader, ScreenSection } from "@/components/screens/ScreenLayout";
import {
  RUN_STATUS_COUNT,
  RUN_STEP_COUNT,
  RUN_STEPS,
  RUN_SUMMARY,
  type RunStep,
} from "@/mock/runs";
import type { PlanStepStatus } from "@/mock/types";

/**
 * 03 屏 · 运行详情。
 *
 * screens.md 原文：「时间轴或步骤列表，每步含状态、耗时、输入/输出摘要、可展开的完整结果。
 * 数据复用 TerminalCard 与 PlanCard 的组件，只是排布不同。」
 *
 * ★ 容器归属：渲染 `<WindowShell>` + `<Sidebar>`（footer 传 `SidebarFooter` 保持条带通底）
 *   + 自己的内容区，**不渲染 `PreviewPane`**（见 lib/layout.ts 的 M4 段）。
 *
 * 状态色沿用 PlanCard 的语义映射（done→success / running→accent / pending→text-tertiary /
 * failed→danger），不另立一套 —— 两屏对同一状态的颜色不一致是最容易让人误判的缺陷。
 */
const STATUS_META: Record<
  PlanStepStatus,
  { icon: LucideIcon; label: string; className: string; dotClassName: string; spin?: boolean }
> = {
  done: {
    icon: Check,
    label: "完成",
    className: "text-success",
    dotClassName: "border-success bg-success",
  },
  running: {
    icon: Loader2,
    label: "进行中",
    className: "text-accent",
    dotClassName: "border-accent bg-accent",
    spin: true,
  },
  pending: {
    icon: Circle,
    label: "待执行",
    className: "text-text-tertiary",
    // 待执行节点用底色而非实心：时间轴缩略看时一眼能分辨「还没轮到」
    dotClassName: "border-border-strong bg-bg-app",
  },
  failed: {
    icon: X,
    label: "失败",
    className: "text-danger",
    dotClassName: "border-danger bg-danger",
  },
};

export interface RunDetailScreenProps {
  os?: OsName;
  onBackToWorkbench?: () => void;
  onOpenSettings?: () => void;
}

export function RunDetailScreen({ os = "mac", onBackToWorkbench, onOpenSettings }: RunDetailScreenProps) {
  return (
    <WindowShell os={os} title={RUN_SUMMARY.title} onOpenSettings={onOpenSettings}>
      <Sidebar activeSessionId="session-0" footer={<SidebarFooter onOpenSettings={onOpenSettings} />} />

      <ScreenArea data-testid="run-detail-screen" data-step-count={RUN_STEP_COUNT}>
        <ScreenHeader
          title={RUN_SUMMARY.title}
          subtitle={<RunSummaryLine />}
          onBackToWorkbench={onBackToWorkbench}
        />

        <ScreenBody>
          <ScreenSection
            title="步骤时间轴"
            note={`共 ${RUN_STEP_COUNT} 步 · 点击任一步骤展开完整结果`}
            data-testid="run-timeline"
          >
            <ol data-testid="run-timeline-list" className="min-w-0">
              {RUN_STEPS.map((step, i) => (
                <RunStepRow key={step.id} step={step} isLast={i === RUN_STEPS.length - 1} />
              ))}
            </ol>
          </ScreenSection>
        </ScreenBody>
      </ScreenArea>
    </WindowShell>
  );
}

/** 页面头副标题：总步数 / 成功 / 失败 / 总耗时 —— 数字全部来自 mock，不在组件里重算 */
function RunSummaryLine() {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span>总 {RUN_STEP_COUNT} 步</span>
      <span className="text-text-tertiary">·</span>
      <span className="text-success">成功 {RUN_STATUS_COUNT.done}</span>
      <span className="text-text-tertiary">·</span>
      <span className="text-danger">失败 {RUN_STATUS_COUNT.failed}</span>
      <span className="text-text-tertiary">·</span>
      <span>进行中 {RUN_STATUS_COUNT.running}</span>
      <span className="text-text-tertiary">·</span>
      <span>总耗时 {RUN_SUMMARY.totalDuration}</span>
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * 单个步骤行：左列时间轴轨道 + 右列内容卡
 * ------------------------------------------------------------------------- */

function RunStepRow({ step, isLast }: { step: RunStep; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const meta = STATUS_META[step.status];

  return (
    <li
      data-testid="run-step"
      data-status={step.status}
      data-step-id={step.id}
      className="flex min-w-0 items-stretch"
      style={{ gap: 12 }}
    >
      {/*
       * 时间轴轨道：固定宽度的一列，内含节点圆点与向下延伸的连接线。
       * 连接线用绝对定位的 1px 竖线（`left: 50%`）而非 border —— border 参与布局宽度，
       * 会让这一列的实际占用与 TIMELINE_RAIL_WIDTH 不一致（M1 折叠 1px 残留的同源问题）。
       */}
      <div
        aria-hidden="true"
        className="relative flex shrink-0 justify-center"
        style={{ width: TIMELINE_RAIL_WIDTH }}
      >
        <span
          className={cn("absolute rounded-full border-2", meta.dotClassName)}
          style={{ width: TIMELINE_DOT_SIZE, height: TIMELINE_DOT_SIZE, top: 14 }}
        />
        {/* 最后一步不画连接线，否则列表底部会多出一截悬空的线 */}
        {!isLast ? (
          <span className="absolute w-px bg-border-subtle" style={{ top: 26, bottom: 0, left: "50%" }} />
        ) : null}
        {/* 圆点占位撑出轨道高度：圆点在 top:14，卡片的第一个元素也在 14 附近对齐 */}
        <span className="shrink-0" style={{ height: 1 }} />
      </div>

      <div className="min-w-0 flex-1" style={{ paddingBottom: isLast ? 0 : 12 }}>
        <div
          className={cn(
            "min-w-0 rounded-lg border bg-bg-surface",
            expanded ? "border-border-default" : "border-border-subtle",
          )}
        >
          {/* 步骤头：序号 + 名称 + 状态徽标 + 耗时 + 展开按钮 */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2.5">
            <span className="shrink-0 font-mono text-xs text-text-tertiary">
              {String(step.index).padStart(2, "0")}
            </span>
            <span className="min-w-0 truncate text-sm font-medium text-text-primary">{step.title}</span>

            <span
              className={cn("inline-flex shrink-0 items-center gap-1 text-xs", meta.className)}
              data-testid="run-step-status"
            >
              <Icon icon={meta.icon} size={14} className={cn(meta.className, meta.spin && "animate-spin")} />
              {meta.label}
            </span>

            <span className="ml-auto flex shrink-0 items-center gap-2">
              {/* 耗时：文本形如「1.2s」/「340ms」，验收按 testid 读取 */}
              <span
                data-testid="run-step-duration"
                className="font-mono text-xs tabular-nums text-text-secondary"
              >
                {step.duration}
              </span>
              <button
                type="button"
                data-testid="run-step-toggle"
                data-expanded={expanded}
                aria-expanded={expanded}
                aria-label={expanded ? `收起「${step.title}」的完整结果` : `展开「${step.title}」的完整结果`}
                onClick={() => setExpanded((v) => !v)}
                className="rounded p-1 text-icon-neutral transition-colors hover:bg-bg-hover"
              >
                <Icon
                  icon={ChevronDown}
                  className={cn("text-icon-neutral transition-transform", expanded && "rotate-180")}
                />
              </button>
            </span>
          </div>

          {/* 输入 / 输出摘要：各一行，超出用 truncate 截断（不换行撑高卡片） */}
          <div className="min-w-0 border-t border-border-subtle px-3">
            <SummaryLine label="输入" text={step.input} testId="run-step-summary" />
            <SummaryLine label="输出" text={step.output} testId="run-step-summary" />
          </div>

          {/*
           * 展开区：**条件渲染**而不是 display:none（M2 既定做法，见 task-M2 6.6）。
           * 内层 overflow-auto + 最大高度 —— 长输出在容器内滚动，不撑破卡片（验收 4-1 的边界要求）。
           */}
          {expanded ? (
            <div
              data-testid="run-step-detail"
              className="min-w-0 overflow-auto border-t border-border-subtle p-3"
              style={{ maxHeight: RUN_STEP_DETAIL_MAX_HEIGHT }}
            >
              <StepDetail step={step} />
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** 摘要行：标签 + 单行文本（截断） */
function SummaryLine({ label, text, testId }: { label: string; text: string; testId: string }) {
  return (
    <div
      data-testid={testId}
      data-summary-label={label}
      className="flex min-w-0 items-center gap-2 border-t border-border-subtle py-1.5 first:border-t-0"
      style={{ maxHeight: RUN_STEP_SUMMARY_MAX_HEIGHT }}
    >
      <span className="w-8 shrink-0 text-xs text-text-tertiary">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary" title={text}>
        {text}
      </span>
    </div>
  );
}

/**
 * 展开后的完整结果。
 *
 * ★ 硬要求（screens.md 03 屏原文）：展开态必须复用 `TerminalCard`（命令类步骤）
 * 或 `PlanCard`（计划类步骤），而不是自己画一个输出框。
 * 两者都没有的步骤回落到纯文本（`detailText`）。
 */
function StepDetail({ step }: { step: RunStep }) {
  if (step.detailTerminal) {
    return (
      <div className="min-w-0">
        {/* 卡片自身有边框与底色，展开区不再叠一层装饰 */}
        <TerminalCard block={step.detailTerminal} />
        <p className="mt-2 text-xs text-text-tertiary">
          以上为完整输出（{step.detailTerminal.output.split("\n").length} 行）
          {step.detailTerminal.status === "error" ? ` · 退出码 ${step.detailTerminal.exitCode ?? 1}` : ""}
        </p>
      </div>
    );
  }

  if (step.detailPlan) {
    return (
      <div className="min-w-0">
        <PlanCard block={step.detailPlan} />
        <p className="mt-2 text-xs text-text-tertiary">以上为该步骤内部的子计划（{step.detailPlan.steps.length} 项）</p>
      </div>
    );
  }

  return (
    <pre className="m-0 min-w-0 whitespace-pre-wrap break-words rounded-md bg-bg-subtle p-3 font-mono text-xs text-text-secondary">
      {step.detailText ?? "（本步骤无额外输出）"}
    </pre>
  );
}
