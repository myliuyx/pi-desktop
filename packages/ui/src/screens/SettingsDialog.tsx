import { useEffect, useState } from "react";
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
  SETTINGS_DIALOG_HEADER_HEIGHT,
  SETTINGS_DIALOG_HEIGHT,
  SETTINGS_DIALOG_PADDING,
  SETTINGS_DIALOG_WIDTH,
} from "@/lib/layout";
import type { ModelProviderConfig } from "@/mock/model-config";
import { useUiStore } from "@/store/ui-store";
import { SettingsGeneralTab } from "./settings/SettingsGeneralTab";
import { ModelProvidersTab } from "./settings/ModelProvidersTab";

/**
 * 设置弹窗骨架（D1：全局 Dialog，替代原 05 屏路由）。
 *
 * 结构：头部 5 Tab（常规 / 模型 / 技能 / 子代理 / 插件，激活项用 accent 令牌 pill）+
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
  { id: "subagents", label: "子代理", testId: "settings-tab-subagents" },
  { id: "plugins", label: "插件", testId: "settings-tab-plugins" },
];

const TAB_PANEL_PREFIX = "settings-tab";

export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const providers = useUiStore((s) => s.modelProviders);
  const saveModelProviders = useUiStore((s) => s.saveModelProviders);

  /** 默认打开「模型」Tab（2026-09-23 用户裁决：模型管理是设置的高频入口） */
  const [activeTab, setActiveTab] = useState<SettingsTabId>("models");
  const [draft, setDraft] = useState<ModelProviderConfig[]>(providers);

  /** 每次打开：从 store 提交值重新拉一份草稿（取消后重开即回落），并回到默认「模型」Tab */
  useEffect(() => {
    if (open) {
      setDraft(providers.map((p) => structuredClone(p)));
      setActiveTab("models");
    }
    // 仅依赖 open：用打开那一刻的 store 提交值，避免编辑过程中被实时提交值覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => setSettingsOpen(false);

  const onSave = () => {
    saveModelProviders(draft.map((p) => structuredClone(p)));
    close();
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
          <p className="min-w-0 truncate text-xs text-text-tertiary">保存后应用于新的会话</p>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={close} data-testid="settings-cancel">
              取消
            </Button>
            <Button variant="primary" size="sm" onClick={onSave} data-testid="settings-save">
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
          <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden">
            <SettingsGeneralTab />
          </div>
        ) : null}
        {activeTab === "models" ? (
          <ModelProvidersTab providers={draft} onChange={setDraft} />
        ) : null}
        {activeTab === "skills" ? <PlaceholderTab title="技能" /> : null}
        {activeTab === "subagents" ? <PlaceholderTab title="子代理" /> : null}
        {activeTab === "plugins" ? <PlaceholderTab title="插件" /> : null}
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
