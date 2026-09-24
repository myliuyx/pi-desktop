import { forwardRef, useEffect, type HTMLAttributes } from "react";
import { Bot, Blocks, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { isLiveEnabled, isMcpEnabled } from "@/lib/feature-flags";
import { getLiveTransport } from "@/services/live-transport";
import { Chip } from "@/components/primitives/Chip";
import { ChipMenu, type ChipMenuGroup } from "@/components/primitives/ChipMenu";
import { TOOLBAR_CONTROL_HEIGHT } from "@/lib/layout";
import { TokenStats } from "@/components/common/TokenStats";
import { useUiStore } from "@/store/ui-store";
import { useModelsStore } from "@/store/models-store";
import {
  COMPOSER_MODEL_GROUPS,
  COMPOSER_MODELS,
  COMPOSER_THINKING_LEVELS,
  MCP_CONNECTED_COUNT,
  THINKING_HINT,
  THINKING_LABEL,
  THINKING_LEVEL_OPTIONS,
} from "@/mock/composer";
import type { ModelInfo, ModelsPayload, ThinkingLevel } from "@/mock/types";

/**
 * Composer 底部工具条。
 *
 * 顺序固定（验收 2-11）：模型 → 思考强度 → MCP → 弹性占位 → TokenStats（靠右）。
 *
 * 模型 / 思考强度是「点开上拉菜单选」（ChipMenu，2026-09-22 用户裁决：循环切换
 * 看不到全部选项），MCP 暂为纯展示芯片（数量展示，无交互）。
 *
 * ⏸ **MCP 芯片默认不渲染（2026-09-23 用户裁决「MCP 暂缓」）**：
 * Pi 无 MCP 概念（`usage.md:310`），数量无真实来源 → 默认关。但验收 2-11 的顺序断言
 * 含 `composer-chip-mcp`，故按 §五纪律选「保留 mock 分支供回归」：**芯片代码与 testid 保留，
 * 用 `?mcp=1` 门控**。见 `@/lib/feature-flags` 与 `.plan/archive/pi-survey-plan.md` S5。
 * 注意：`?mcp=1` 关闭时顺序退化为「模型 → 思考强度 → 弹性占位 → TokenStats」，
 * 这是有意的 —— 验收 2-11 带参数跑，断言仍是原样。
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

    /*
     * live 形态：思考档位不再写死，而是用 Pi 实际支持的档位（`GET /models` 的
     * `availableThinkingLevels`，由模型能力/thinkingLevelMap 决定），选择即经
     * `POST /thinking` 写回 core 的 settings.json —— 与设置弹窗·常规 Tab 同一真相。
     * mock 形态（默认）：保持设计稿的 3 档，行为零变化。
     *
     * 激活态优先「用户所选」`settings.thinkingLevel`，回退「生效值」`thinkingLevel`：
     * 后者会被模型能力夹取（如 reasoning:false 恒为 off），直接用会出现「点了没反应」。
     */
    const live = isLiveEnabled();
    const liveModels = useModelsStore((state) => state.payload);
    const ensureModels = useModelsStore((state) => state.ensure);
    const applyModels = useModelsStore((state) => state.applyPayload);
    useEffect(() => {
      if (live) void ensureModels();
    }, [live, ensureModels]);

    // ThinkingLevelName 与 ThinkingLevel 是同一字面量联合（core 与 UI 各声明一份），
    // 直接赋值即可 —— 原先的 as 断言在掩盖两者漂移（#7）。
    const availableLevels: readonly ThinkingLevel[] = live
      ? liveModels && liveModels.availableThinkingLevels.length > 0
        ? liveModels.availableThinkingLevels
        : THINKING_LEVEL_OPTIONS
      : COMPOSER_THINKING_LEVELS;

    const activeThinking: ThinkingLevel =
      live && liveModels ? pickActiveThinking(liveModels, thinkingLevel) : thinkingLevel;

    const selectThinking = (level: ThinkingLevel) => {
      setThinkingLevel(level);
      if (!live) return;
      const transport = getLiveTransport();
      if (!transport) return;
      void transport
        .setThinkingLevel(level)
        .then(applyModels)
        .catch((e) => {
          console.error("[live] setThinkingLevel 失败:", e);
        });
    };

    /*
     * live 形态：模型选择同样不再写死 —— 用 core `GET /models` 返回的可用清单
     * （已配置凭证的模型，按 provider 分组），选择即经 `POST /models/select` 写回。
     * value 用 `provider:id` 保证跨 provider 唯一（不同 provider 可能有同名模型）。
     * mock 形态（默认）：保持设计稿清单，行为零变化。
     */
    const modelGroups: ReadonlyArray<ChipMenuGroup<string>> =
      live && liveModels ? groupModelsByProvider(liveModels.models) : COMPOSER_MODEL_GROUPS;

    const activeModelKey =
      live && liveModels?.current
        ? `${liveModels.current.provider}:${liveModels.current.modelId}`
        : modelId;

    const activeModelLabel = (() => {
      if (live && liveModels) {
        const cur = liveModels.current;
        const found = cur
          ? liveModels.models.find((m) => m.provider === cur.provider && m.id === cur.modelId)
          : undefined;
        return found?.label ?? cur?.modelId ?? modelId;
      }
      return (COMPOSER_MODELS.find((m) => m.id === modelId) ?? COMPOSER_MODELS[0]).label;
    })();

    const selectModel = (key: string) => {
      setModelId(key);
      if (!live) return;
      const sep = key.indexOf(":");
      if (sep < 0) return;
      const transport = getLiveTransport();
      if (!transport) return;
      void transport
        .setModel(key.slice(0, sep), key.slice(sep + 1))
        .then(applyModels)
        .catch((e) => {
          console.error("[live] setModel 失败:", e);
        });
    };

    /** MCP 芯片开关（默认关；`?mcp=1` 打开，供验收 2-11 回归）—— 见 @/lib/feature-flags */
    const mcpEnabled = isMcpEnabled();

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
          label={activeModelLabel}
          ariaLabel="选择模型"
          menuLabel="可选模型"
          groups={modelGroups}
          value={activeModelKey}
          onChange={selectModel}
        />

        <ChipMenu
          testId="composer-chip-thinking"
          menuTestId="composer-chip-thinking-menu"
          icon={Sparkles}
          label={`思考 ${THINKING_LABEL[activeThinking]}`}
          ariaLabel="选择思考强度"
          menuLabel="思考强度档位"
          groups={[
            {
              options: availableLevels.map((level) => ({
                value: level,
                label: THINKING_LABEL[level],
                hint: THINKING_HINT[level],
              })),
            },
          ]}
          value={activeThinking}
          onChange={selectThinking}
        />

        {mcpEnabled ? (
          <Chip
            data-testid="composer-chip-mcp"
            icon={Blocks}
            title="已连接的 MCP 服务器数"
          >
            {`MCP ${MCP_CONNECTED_COUNT}`}
          </Chip>
        ) : null}

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

/**
 * 当前激活的思考档位。
 *
 * 优先「用户所选」`settings.thinkingLevel`；但当该档位**不在**当前模型支持的集合里
 * （`reasoning:false` 的模型只有 ["off"]，而 Pi 仍把 defaultThinkingLevel 持久化成 "high"），
 * 显示用户所选会出现「chip 写着 High，菜单里没有任何项被选中」。此时回落**真正生效值**
 * `payload.thinkingLevel`（Pi 按能力夹取后的结果）。
 */
function pickActiveThinking(payload: ModelsPayload, fallback: ThinkingLevel): ThinkingLevel {
  const chosen = payload.settings.thinkingLevel ?? payload.thinkingLevel ?? fallback;
  const available = payload.availableThinkingLevels;
  if (available.length > 0 && !available.includes(chosen)) return payload.thinkingLevel;
  return chosen;
}

/** live：把 core 的可用模型按 provider 分组，value 用 `provider:id` 保证跨 provider 唯一 */
function groupModelsByProvider(models: readonly ModelInfo[]): ChipMenuGroup<string>[] {
  const byProvider = new Map<string, { value: string; label: string }[]>();
  for (const m of models) {
    const options = byProvider.get(m.provider) ?? [];
    options.push({ value: `${m.provider}:${m.id}`, label: m.label || m.id });
    byProvider.set(m.provider, options);
  }
  return [...byProvider.entries()].map(([label, options]) => ({ label, options }));
}
