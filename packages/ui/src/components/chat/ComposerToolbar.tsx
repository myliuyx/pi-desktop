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
import { notifyFailure } from "@/store/notice-store";
import { pickActiveThinking } from "@/lib/thinking";
import {
  COMPOSER_MODEL_GROUPS,
  COMPOSER_MODELS,
  COMPOSER_THINKING_LEVELS,
  MCP_CONNECTED_COUNT,
  THINKING_HINT,
  THINKING_LABEL,
  THINKING_LEVEL_OPTIONS,
} from "@/mock/composer";
import type { ModelInfo, ThinkingLevel } from "@/mock/types";

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

    const activeThinking: ThinkingLevel = live
      ? pickActiveThinking(liveModels, thinkingLevel)
      : thinkingLevel;

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
          notifyFailure("思考档位切换失败", e);
          // 乐观更新已写入 ui-store，失败要拉回 core 的真实值，避免 chip 显示假状态
          void useModelsStore.getState().refresh();
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

    /*
     * ★ 无可用模型态的显式降级（2026-09-24）：core 的 `current` 为 null 表示
     * 「一个可用模型都没有」，此时**不能**再回落到 ui-store 的 mock `modelId` ——
     * 那会让芯片显示一个并不存在、却很像真的模型名（如「Claude Sonnet 4.5」），
     * 把「还没配模型」这件事藏起来。原先显示 `unknown` 虽然难看，但至少诚实；
     * 本批把 core 的诊断口径统一成「有 warning 就报 warning」，显示层同理：
     * **没有就说没有，并指出去哪儿配**。
     *
     * 两种降级分开说清（都是可达状态）：
     * - 清单为空 ⇒ 没配好（首次运行，或 Provider 被 Pi 判非法/无凭证而摘掉）；
     * - 清单非空但未选中 ⇒ 保存时自动选型失败（core 的 warning 已明说「请手动选择一个模型」）。
     */
    const noModelDegrade = (() => {
      if (!live || !liveModels) return null;
      if (liveModels.current !== null) return null;
      return liveModels.models.length === 0
        ? {
            label: "未配置模型",
            reason: "尚未配置可用模型：请在「设置 → 模型」添加并启用一个 Provider",
          }
        : {
            label: "未选择模型",
            reason: "尚未选择模型：请在下方列表中选择一个（自动选型未生效）",
          };
    })();

    const activeModelKey =
      live && liveModels?.current
        ? `${liveModels.current.provider}:${liveModels.current.modelId}`
        : noModelDegrade
          ? ""
          : modelId;

    const activeModelLabel = (() => {
      if (live && liveModels) {
        if (noModelDegrade) return noModelDegrade.label;
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
          notifyFailure("模型切换失败", e);
          void useModelsStore.getState().refresh();
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
          /* 无可用模型时不挂菜单（空菜单点了没反应），改渲染禁用态芯片并说明去处 */
          disabledReason={noModelDegrade?.reason}
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
 * live：把 core 的可用模型按 provider 分组，value 用 `provider:id` 保证跨 provider 唯一。
 *
 * ★ 分组标题用 `providerLabel`（展示名，如 `opencodex`），**不是** `provider`（内部 key，
 * 形如 `provider-1790227472338`）—— 后者是给请求用的，摆到菜单上就是乱码
 * （2026-09-24 用户反馈）。core 取不到展示名时才回落 key。
 * 分组**按 label 归并**：同一展示名下的模型合成一组（key 仍是 `provider:id`，不丢唯一性）。
 */
function groupModelsByProvider(models: readonly ModelInfo[]): ChipMenuGroup<string>[] {
  const byProvider = new Map<string, { label: string; options: { value: string; label: string }[] }>();
  for (const m of models) {
    const groupLabel = m.providerLabel?.trim() || m.provider;
    const group = byProvider.get(groupLabel) ?? { label: groupLabel, options: [] };
    group.options.push({ value: `${m.provider}:${m.id}`, label: m.label || m.id });
    byProvider.set(groupLabel, group);
  }
  return [...byProvider.values()];
}
