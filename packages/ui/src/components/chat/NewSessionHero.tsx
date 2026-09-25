import { forwardRef, type HTMLAttributes } from "react";
import { CircleCheck, Code2, PenLine, Sparkles, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { NEW_SESSION_COLUMN_WIDTH } from "@/lib/layout";
import { Icon, type LucideIcon } from "@/components/common/icons";

/**
 * 草稿态输入框的占位文案（2026-09-25 用户裁决 D5，参照图原文）。
 * 由 WorkspaceArea 在草稿态经 Composer 的可选 `placeholder` prop 传入；
 * 非草稿路径不传、保持既有文案（D5 冻结口径）。
 */
export const NEW_SESSION_COMPOSER_PLACEHOLDER = "描述你想完成的任务，或输入 / 调用某个技能…";

/** 建议卡数据（纯展示，2026-09-25 用户裁决 D3：无 onClick / 无 hover，后期接点击时交互与验收同步补） */
interface SuggestionCard {
  icon: LucideIcon;
  title: string;
  description: string;
}

/** 文案逐字对照参照图（规格 §4.0 文案表）；数组顺序即 testid 序（`new-session-card-<i>`） */
const SUGGESTION_CARDS: SuggestionCard[] = [
  {
    icon: Code2,
    title: "读懂这个代码库",
    description: "扫描项目结构与依赖，列出关键模块、入口文件和调用链，先建立一份全局认知。",
  },
  {
    icon: CircleCheck,
    title: "跑通测试并修复失败项",
    description: "先复现失败用例，定位根因，再按最小改动逐个修好并跑一遍回归。",
  },
  {
    icon: PenLine,
    title: "实现一个小需求",
    description: "描述目标即可，我先给出分步执行计划，等你确认后再动手改代码。",
  },
  {
    icon: TriangleAlert,
    title: "排查最近的报错",
    description: "从终端输出与日志定位根因，给出复现路径、影响范围和修复建议。",
  },
];

export interface NewSessionHeroProps extends HTMLAttributes<HTMLElement> {}

/**
 * 新建会话页（草稿态视图，task-new-session-page.md §4.1）。
 *
 * 定位：占据 MessageList 在 WorkspaceArea 里的位置（二选一渲染，§4.2），不是新路由——
 * 侧栏 / 标题栏 / 预览区 / Composer / 工具条全部原位保留。
 *
 * 结构：外层 section 是唯一滚动容器（小视口不塌陷，对齐 5-7「空态不塌陷」精神），
 * 内层 `min-h-full` 把整块内容垂直居中、超出时随外层滚动。
 *
 * ⚠️ 与旧空态（`?empty=1` 的 `empty-state`「还没有消息」）是两个互斥状态：
 * 草稿态**不经过** MessageList，`empty-state` 的 m5 5-7 锚不受本组件影响。
 *
 * 交互纪律（D3）：建议卡是纯展示 `div`——不挂 onClick、不写 hover:/active:、
 * 不加 cursor-pointer / tabindex，不许做成「看着能点」的哑交互。
 */
export const NewSessionHero = forwardRef<HTMLElement, NewSessionHeroProps>(function NewSessionHero(
  { className, ...rest },
  ref,
) {
  return (
    <section
      ref={ref}
      data-testid="new-session-hero"
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-bg-app", className)}
      {...rest}
    >
      <div className="flex min-h-full flex-col items-center justify-center px-6 py-10 text-center">
        {/* 图标块：参照图的圆角方块 + Sparkles；图标走 Icon 默认中性色（G4 纪律） */}
        <div
          aria-hidden="true"
          className="flex shrink-0 items-center justify-center rounded-xl bg-bg-subtle"
          style={{ width: 44, height: 44 }}
        >
          <Icon icon={Sparkles} size={20} />
        </div>

        <h1 className="mt-4 text-xl font-semibold text-text-primary">开始一个新会话</h1>
        <p className="mt-2.5 text-sm text-text-secondary">
          描述你想完成的任务，Pi 会先给出执行计划，再动手改代码。
        </p>

        {/*
         * 建议卡 2×2：列宽由 NEW_SESSION_COLUMN_WIDTH 封顶（lib/layout.ts，参照图两卡总宽）。
         * 卡片在 text-center 环境里必须显式 text-left（cn() 的 text-align 冲突组保证它生效，
         * 见 lib/cn.ts —— 历史教训：text-left 曾被吞掉回落 UA center）。
         */}
        <div
          data-testid="new-session-cards"
          className="mt-10 grid w-full grid-cols-2 gap-3"
          style={{ maxWidth: NEW_SESSION_COLUMN_WIDTH }}
        >
          {SUGGESTION_CARDS.map((card, index) => (
            <div
              key={card.title}
              data-testid={`new-session-card-${index}`}
              className="rounded-lg border border-border-subtle bg-bg-surface p-4 text-left"
            >
              <div className="flex items-center gap-2">
                <Icon icon={card.icon} />
                <span className="truncate text-sm font-medium text-text-primary" title={card.title}>
                  {card.title}
                </span>
              </div>
              {/* 两行截断 + title 全称（M5 5-8 纪律：省略必须有全称出口） */}
              <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-text-tertiary" title={card.description}>
                {card.description}
              </p>
            </div>
          ))}
        </div>

        {/* 提示行：/ 与 @ 是期货文案（2026-09-25 用户裁决 D4，功能后期实现） */}
        <p className="mt-7 text-xs text-text-tertiary">
          Enter 发送 · Shift+Enter 换行 · / 唤起技能 · @ 引用文件
        </p>
      </div>
    </section>
  );
});
