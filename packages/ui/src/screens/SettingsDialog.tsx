import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  Button,
  Dialog,
  IconButton,
  Tabs,
  tabPanelProps,
  type TabItem,
} from "@/components/primitives";
import {
  SETTINGS_DIALOG_FOOTER_HEIGHT,
  SETTINGS_DIALOG_FORM_PADDING,
  SETTINGS_DIALOG_HEADER_HEIGHT,
  SETTINGS_DIALOG_HEIGHT,
  SETTINGS_DIALOG_PADDING,
  SETTINGS_DIALOG_WIDTH,
} from "@/lib/layout";
import type { ModelProviderConfig } from "@/mock/model-config";
import { buildPutRequest, entriesToProviders } from "@/mock/provider-convert";
import { isLiveEnabled } from "@/lib/feature-flags";
import { getLiveTransport } from "@/services/live-transport";
import { cn } from "@/lib/cn";
import { useUiStore } from "@/store/ui-store";
import { useModelsStore } from "@/store/models-store";
import { SettingsGeneralTab } from "./settings/SettingsGeneralTab";
import { ModelProvidersTab } from "./settings/ModelProvidersTab";
import { PANE_SCROLL_CLASS } from "./settings/form-fields";
import { SkillsSettingsTab } from "./settings/SkillsSettingsTab";
import { PluginsSettingsTab } from "./settings/PluginsSettingsTab";
import { describeProviderIssues, validateProviders, type ProviderValidationIssue } from "./settings/provider-validation";
import { resolveProvidersSaveState } from "./settings/providers-save-state";

/**
 * 设置弹窗骨架（D1：全局 Dialog，替代原 05 屏路由）。
 *
 * 结构：头部 5 Tab（常规 / 模型 / 技能 / 插件 / 子代理，激活项用 accent 令牌 pill；2026-09-28
 * 用户裁决：插件与子代理换位）+
 * 内容区（按选中 Tab 切换，带淡入过渡 G8）+ 底部条（左「保存后应用于新的会话」、
 * 右「取消 / 保存」）。
 *
 * 草稿语义：模型配置编辑写本地 `draft`（弹窗打开时从 store 提交值深拷贝而来），
 * 点「保存」才 `saveModelProviders(draft)` 回写 store；点「取消」丢弃（关闭即回落）。
 * 常规 Tab 内五组为实时写 store（D3 原样随迁，保持既有行为）。
 */
type SettingsTabId = "general" | "models" | "skills" | "subagents" | "plugins";

const TABS: TabItem[] = [
  { id: "general", label: "常规", testId: "settings-tab-general" },
  { id: "models", label: "模型", testId: "settings-tab-models" },
  { id: "skills", label: "技能", testId: "settings-tab-skills" },
  { id: "plugins", label: "插件", testId: "settings-tab-plugins" },
  { id: "subagents", label: "子代理", testId: "settings-tab-subagents" },
];

const TAB_PANEL_PREFIX = "settings-tab";

const IDLE_STATUS = { tone: "normal", text: "保存后应用于新的会话" } as const;

type StatusTone = "normal" | "success" | "warning" | "danger";

export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const providers = useUiStore((s) => s.modelProviders);
  const saveModelProviders = useUiStore((s) => s.saveModelProviders);
  /** 当前 modelProviders 的来源（CR-084）：live 读失败回落演示数据时据此禁存 */
  const providersSource = useUiStore((s) => s.providersSource);
  const setProvidersSource = useUiStore((s) => s.setProvidersSource);

  /** 默认打开「模型」Tab（2026-09-23 用户裁决：模型管理是设置的高频入口） */
  const [activeTab, setActiveTab] = useState<SettingsTabId>("models");
  const [draft, setDraft] = useState<ModelProviderConfig[]>(providers);
  /** 底部状态条：live 读取/写入的进度与失败原因（mock 形态恒 “保存后应用于新的会话”） */
  const [status, setStatus] = useState<{ tone: StatusTone; text: string }>({ ...IDLE_STATUS });
  /** 保存被校验拦下时，指示 ModelProvidersTab 定位到出问题的那一项（seq 递增以支持连点） */
  const [focus, setFocus] = useState<{ id: string; seq: number } | null>(null);
  /** 被保存闸门拦过的 Provider id（下发下去，让对应表单就地标红缺哪一项） */
  const [blockedIds, setBlockedIds] = useState<Set<string>>(() => new Set());
  /**
   * live 读取中（CR-084）：读取未决时草稿仍是回落演示数据，此时也应禁存 —— 
   * 保存会用尚未确认来源的数据 PUT 覆盖真实配置。
   * 读取代际（`readSeqRef`）：连点「重新读取」/ 快速开关时，只有最后一次读取的结果算数。
   */
  const [reading, setReading] = useState(false);
  const readSeqRef = useRef(0);

  const live = isLiveEnabled();

  /** CR-084 的保存来源闸：mock 形态不设闸（无 PUT、无真实配置可覆盖）。 */
  const saveState = live
    ? resolveProvidersSaveState(providersSource, draft.length > 0)
    : { canSave: true, canRetry: false, reason: "" };
  /** 读取未决（reading）也禁存：此刻草稿来源未定，仍是回落演示数据。 */
  const canSave = saveState.canSave && !reading;

  /**
   * live 读取模型配置（CR-084）。成功 → 回填 store 并切 source=live（把保存路径从「回落演示
   * 数据」切回 live 真实数据）；失败 → source=fallback（草稿保持演示数据，保存被禁、提供重试）。
   * 读取代际（readSeqRef）保证只有最后一次读取的结果算数，过期结果丢弃。
   */
  const reloadProviders = useCallback(() => {
    if (!live) return;
    const transport = getLiveTransport();
    if (!transport) return;
    const seq = ++readSeqRef.current;
    setReading(true);
    setStatus({ tone: "normal", text: "正在读取 core 的模型配置…" });
    void transport
      .listProviders()
      .then((payload) => {
        if (seq !== readSeqRef.current) return;
        const entries = entriesToProviders(payload);
        // 回填 store：提交值切回 live 真实数据（不再以演示数据兜底），并标记来源为 live
        saveModelProviders(entries);
        setProvidersSource("live");
        setDraft(entries);
        setStatus({ ...IDLE_STATUS });
      })
      .catch((e) => {
        if (seq !== readSeqRef.current) return;
        // C5 同范式：core 取不到就回落草稿（演示数据），绝不白屏；但标记来源，保存闸据此禁存
        setProvidersSource("fallback");
        setStatus({
          tone: "danger",
          text: `core 读取失败，已回落到演示数据：${e instanceof Error ? e.message : String(e)}`,
        });
      })
      .finally(() => {
        if (seq === readSeqRef.current) setReading(false);
      });
  }, [live, saveModelProviders, setProvidersSource]);

  /** 每次打开：从 store 提交值重新拉一份草稿（取消后重开即回落），并回到默认「模型」Tab */
  useEffect(() => {
    if (!open) return;
    const initial = providers.map((p) => structuredClone(p));
    setDraft(initial);
    setActiveTab("models");
    setStatus({ ...IDLE_STATUS });
    setFocus(null);
    setBlockedIds(new Set());
    readSeqRef.current = 0; // 重开对话框归零读取代际
    // live 形态打开即触发一次读取（成功切回真实数据，失败标记 fallback 禁存）
    reloadProviders();
    // 仅依赖 open：用打开那一刻的 store 提交值，避免编辑过程中被实时提交值覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => setSettingsOpen(false);

  /**
   * 「被校验拦下」的统一出口（保存闸门与「导入模型…」闸门共用）：
   * 切到模型 Tab、把出问题的 Provider 选中并展开、就地标红、状态条写原因。
   */
  const reportIssues = (issues: ProviderValidationIssue[]) => {
    const first = issues[0];
    if (!first) return;
    setActiveTab("models");
    setFocus((prev) => ({ id: first.id, seq: (prev?.seq ?? 0) + 1 }));
    setBlockedIds(new Set(issues.map((i) => i.id)));
    setStatus({ tone: "danger", text: describeProviderIssues(issues) });
  };

  /**
   * 保存：**不关闭弹窗**（2026-09-23 用户裁决）—— 底部状态条给结果反馈，
   * 让用户能接着改、也能看见 core 的回退提示；关闭动作交给 ✕ / 取消 / 遮罩。
   *
   * 前置闸门（2026-09-24 用户要求）：启用的 Provider 必须填 Base URL 与 API key，
   * 否则**直接拦下不发请求**，并把用户带到出问题的那一项。
   * 为什么拦在前面：空 baseUrl/apiKey 在 Pi 那边是**非法值**（不是「没填」），
   * 会让整份 models.json 校验失败、所有 Provider 一起消失 —— 与其保存完再报错，
   * 不如在保存前就说清楚缺什么。
   */
  const onSave = async () => {
    /*
     * CR-084 来源闸（前置）：live 读失败回落演示数据时直接拦下，绝不 PUT（否则演示 Provider
     * 会全量覆盖真实 models.json）。保存按钮此时已 disabled，这里是**纵深防御** —— 即便按钮
     * 状态被绕过，发起点也拒绝外发，并把用户导向「重新读取」。
     */
    if (live && !saveState.canSave) {
      setStatus({ tone: "danger", text: saveState.reason });
      return;
    }
    const snapshot = draft.map((p) => structuredClone(p));

    const issues = validateProviders(snapshot);
    if (issues.length > 0) {
      reportIssues(issues);
      return;
    }
    setBlockedIds(new Set());

    saveModelProviders(snapshot);

    const transport = getLiveTransport();
    if (!transport) {
      setStatus({ tone: "success", text: "保存成功（应用于新的会话）" });
      return;
    }
    setStatus({ tone: "normal", text: "正在写入 core…" });
    try {
      const res = await transport.saveProviders(buildPutRequest(snapshot));
      // 用 core 回给我的合并清单为准（含 enabled 拆分结果与回退后的 current）
      setDraft(entriesToProviders(res));
      // 保存会改变可选模型 / 当前模型 —— 通知所有 models-store 消费者重取，
      // 否则 Composer 的模型菜单仍是旧快照（#2）。
      void useModelsStore.getState().refresh();
      /*
       * 状态条口径（2026-09-24 修正）：只要 core 回了 `warning` 就按 warning 显示。
       * 原实现只在 `fallbackApplied` 时才显示 warning ⇒ 「保存成功、但没有任何可用模型」
       * 这类诊断（warning 有值但没触发回退）会被吞掉，用户只看到一行绿字，
       * 完全不知道模型为什么不见了。
       */
      setStatus(
        res.warning
          ? { tone: "warning", text: res.warning }
          : { tone: "success", text: "保存成功（已写入 core，应用于新的会话）" },
      );
    } catch (e) {
      // 写失败不关闭弹窗、也不丢用户的编辑，让用户看见原因并可重试
      setStatus({
        tone: "danger",
        text: `写入 core 失败（本地草稿已保留）：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      label="设置"
      width={SETTINGS_DIALOG_WIDTH}
      height={SETTINGS_DIALOG_HEIGHT}
      header={
        <div
          className="flex min-w-0 items-center justify-between gap-3 border-b border-border-subtle px-5"
          style={{ height: SETTINGS_DIALOG_HEADER_HEIGHT }}
        >
          <Tabs
            items={TABS}
            value={activeTab}
            onChange={setActiveTab}
            label="设置分类"
            idPrefix={TAB_PANEL_PREFIX}
            className="min-w-0 flex-wrap"
            tabClassName="px-3 h-8 rounded-full text-base text-text-secondary transition-colors duration-150 ease-out hover:bg-bg-hover"
            activeTabClassName="bg-accent-soft text-accent"
          />
          <IconButton label="关闭设置" icon={X} testId="settings-dialog-close" onClick={close} />
        </div>
      }
      footer={
        <div
          className="flex min-w-0 items-center justify-between gap-3 border-t border-border-subtle px-5"
          style={{ height: SETTINGS_DIALOG_FOOTER_HEIGHT }}
        >
          <p
            className={cn(
              "min-w-0 truncate text-xs text-text-tertiary",
              status.tone === "success" && "text-success",
              status.tone === "warning" && "text-warning",
              status.tone === "danger" && "text-danger",
            )}
            /* 长文案会被 truncate 截断 —— 补 title 让悬停能看到全文（就地标红才是主提示） */
            title={status.text}
            data-testid="settings-status"
            data-tone={status.tone}
          >
            {status.text}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {saveState.canRetry ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={reloadProviders}
                disabled={reading}
                data-testid="settings-reload"
              >
                重新读取
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={close} data-testid="settings-cancel">
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={onSave}
              disabled={!canSave}
              title={canSave ? undefined : saveState.reason}
              data-testid="settings-save"
            >
              保存
            </Button>
          </div>
        </div>
      }
    >
      <div
        key={activeTab}
        className="settings-tab-in h-full min-h-0"
        style={{ padding: SETTINGS_DIALOG_PADDING }}
        {...tabPanelProps(TAB_PANEL_PREFIX, activeTab)}
      >
        {activeTab === "general" ? (
          /* 常规 Tab 是单列（无左栏树），没有视觉边界依靠，直接贴弹窗边会顶到面板边缘，
             故自己带 SETTINGS_DIALOG_FORM_PADDING 内边距 —— 与模型/技能/插件三个 Tab 的右栏同值。 */
          <div
            className={cn("h-full min-h-0", PANE_SCROLL_CLASS)}
            style={{ padding: SETTINGS_DIALOG_FORM_PADDING }}
          >
            <SettingsGeneralTab />
          </div>
        ) : null}
        {activeTab === "models" ? (
          <ModelProvidersTab
            providers={draft}
            onChange={setDraft}
            focusRequest={focus}
            blockedIds={blockedIds}
            onReportIssues={reportIssues}
          />
        ) : null}
        {activeTab === "skills" ? <SkillsSettingsTab /> : null}
        {activeTab === "plugins" ? <PluginsSettingsTab /> : null}
        {activeTab === "subagents" ? <PlaceholderTab title="子代理" /> : null}
      </div>
    </Dialog>
  );
}

function PlaceholderTab({ title }: { title: string }) {
  return (
    <div className="flex h-full min-w-0 items-center justify-center">
      <p className="text-sm text-text-tertiary">{title}（占位）本批暂不实现</p>
    </div>
  );
}
