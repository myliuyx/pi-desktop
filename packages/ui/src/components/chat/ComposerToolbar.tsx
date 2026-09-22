import { forwardRef, type HTMLAttributes } from "react";
import { Bot, Blocks, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { Chip } from "@/components/primitives/Chip";
import { ChipMenu } from "@/components/primitives/ChipMenu";
import { TOOLBAR_CONTROL_HEIGHT } from "@/lib/layout";
import { TokenStats } from "@/components/common/TokenStats";
import { useUiStore } from "@/store/ui-store";
import {
  COMPOSER_MODEL_GROUPS,
  COMPOSER_MODELS,
  MCP_CONNECTED_COUNT,
  THINKING_LABEL,
} from "@/mock/composer";

/**
 * Composer 底部工具条。
 *
 * 顺序固定（验收 2-11）：模型 → 思考强度 → MCP → 弹性占位 → TokenStats（靠右）。
 *
 * 模型 / 思考强度是「点开上拉菜单选」（ChipMenu，2026-09-22 用户裁决：循环切换
 * 看不到全部选项），MCP 暂为纯展示芯片（数量展示，无交互）。
 *
 * 状态来源是 **ui-store 的 `modelId` / `thinkingLevel`**（M4 为 05 设置屏建立的字段），
 * 不是组件内 useState —— 工具条与 05 屏是同一个真相的两处展示，改哪边都同步。
 * store 这两个字段不持久化，与 05 屏现状一致。
 *
 * 为什么用 `composer-toolbar-spacer`（flex-1）把 TokenStats 推到右边、而不给
 * TokenStats 加 `ml-auto`：验收 2-16 要能看见「弹性占位」这个真实节点，且 3.2 明令
 * 不要藏结构。spacer 必须存在且独占剩余空间。
 */
export const ComposerToolbar = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ComposerToolbar({ className, ...rest }, ref) {
    const modelId = useUiStore((state) => state.modelId);
    const setModelId = useUiStore((state) => state.setModelId);
    const thinkingLevel = useUiStore((state) => state.thinkingLevel);
    const setThinkingLevel = useUiStore((state) => state.setThinkingLevel);

    const model = COMPOSER_MODELS.find((m) => m.id === modelId) ?? COMPOSER_MODELS[0];

    return (
      <div
        ref={ref}
        data-testid="composer-toolbar"
        className={cn(
          // @container：TokenStats 的标签随本工具条宽度做容器查询（≥690px 才显示标签，
          // 632px 默认视口下只留数字——全宽内容实测 687.87px，塞不下是结构性事实，
          // 见 TokenStats 内注释）。
          "@container flex w-full shrink-0 items-center gap-2",
          className,
        )}
        {...rest}
      >
        {/*
         * testid 口径（M2 2-11/2-12 兼容）：ChipMenu 的定位 wrapper 持有
         * `composer-chip-model` / `composer-chip-thinking`，触发按钮是 `*-trigger`，
         * 面板是 `*-menu` —— 直接子节点枚举序列与芯片高度断言不受影响。
         */}
        <ChipMenu
          testId="composer-chip-model"
          menuTestId="composer-chip-model-menu"
          icon={Bot}
          label={model.label}
          ariaLabel="选择模型"
          menuLabel="可选模型"
          groups={COMPOSER_MODEL_GROUPS}
          value={modelId}
          onChange={setModelId}
        />

        <ChipMenu
          testId="composer-chip-thinking"
          menuTestId="composer-chip-thinking-menu"
          icon={Sparkles}
          label={`思考 ${THINKING_LABEL[thinkingLevel]}`}
          ariaLabel="选择思考强度"
          menuLabel="思考强度档位"
          groups={[
            {
              options: [
                { value: "low", label: "Low", hint: "快速回答，几乎不思考" },
                { value: "high", label: "High", hint: "均衡模式，日常任务首选" },
                { value: "max", label: "Max", hint: "最强推理，更慢也更耗用量" },
              ],
            },
          ]}
          value={thinkingLevel}
          onChange={setThinkingLevel}
        />

        <Chip
          data-testid="composer-chip-mcp"
          icon={Blocks}
          title="已连接的 MCP 服务器数"
        >
          {`MCP ${MCP_CONNECTED_COUNT}`}
        </Chip>

        {/*
         * 弹性占位：占满剩余空间，把 TokenStats 推到最右（2-16）。
         * min-w-0（而非原 min-w-2）：芯片加了下拉箭头后工具条在默认视口已接近满宽，
         * 占位下限改 0 把收缩余量让给无文字的它，避免 TokenStats 被挤出右缘（2-16 曾挂 12.88px）。
         */}
        <div
          data-testid="composer-toolbar-spacer"
          style={{ height: TOOLBAR_CONTROL_HEIGHT }}
          className="min-w-0 flex-1"
        />

        <TokenStats />
      </div>
    );
  },
);
