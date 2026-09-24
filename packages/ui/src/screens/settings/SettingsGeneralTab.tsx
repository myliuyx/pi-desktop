import { useEffect } from "react";
import { FolderOpen, Moon, Sun } from "lucide-react";
import { isLiveEnabled } from "@/lib/feature-flags";
import { getLiveTransport } from "@/services/live-transport";
import { SETTINGS_GROUP_HEADER_MIN_HEIGHT, SETTINGS_LABEL_WIDTH, SCREEN_SECTION_GAP } from "@/lib/layout";
import { Icon } from "@/components/common/icons";
import { Button, Chip } from "@/components/primitives";
import { Switch } from "@/components/screens/Switch";
import { COMPOSER_THINKING_LEVELS, THINKING_LABEL } from "@/mock/composer";
import type { ThinkingLevel } from "@/mock/types";
import {
  PI_FIELD_NAMES,
  SESSION_SWITCHES,
  THEME_OPTIONS,
  type ThemeOptionValue,
} from "@/mock/settings";
import { useUiStore } from "@/store/ui-store";
import { useModelsStore } from "@/store/models-store";

/**
 * 设置弹窗 · 「常规」Tab。
 *
 * 内容整体平移自旧 05 屏 `SettingsScreen` 的 `<ScreenBody>`（D3：原样搬进弹窗
 * 「常规」Tab，内部实现、testid 全部保留，只换容器）。
 *
 * 分组顺序（验收 4-5 口径迁移到此）：思考强度 → 会话 → 外观 → 工作目录。
 * （原「模型」组已删 —— 2026-09-23 用户裁决：模型管理走「模型」Tab，选用走工具条菜单。）
 *
 * ★ 外观分组必须复用 store 的 `setTheme` / `syncSystemTheme` / `useSystemTheme`，
 *   **不得直接改 `document.documentElement.dataset.theme`** —— 那会绕过 ui-store 的
 *   localStorage 持久化，"首帧前确定主题"的既有约定立刻破掉（M0 验收 0-5 依赖它）。
 *
 * ★ 每个字段的说明文本里都带上对齐 Pi 的字段名（验收 4-6 迁移口径），名字取自
 *   `mock/settings.ts` 的 `PI_FIELD_NAMES`。
 */

export function SettingsGeneralTab() {
  const thinkingLevel = useUiStore((state) => state.thinkingLevel);
  const setThinkingLevel = useUiStore((state) => state.setThinkingLevel);
  const sessionSwitches = useUiStore((state) => state.sessionSwitches);
  const toggleSessionSwitch = useUiStore((state) => state.toggleSessionSwitch);
  const workingDir = useUiStore((state) => state.workingDir);

  /*
   * ★ C5：live 形态下「思考强度」组用 core 的真实数据（`GET /models`），
   * 点击即经 `POST /thinking` 写回 core 的 `settings.json`。
   *
   * 显示口径（刻意的选择，有实测依据）：**激活的思考档位**优先用 `settings.json` 里的
   * `defaultThinkingLevel`（用户所选），而不是 `thinkingLevel`（生效值 —— 会被模型能力
   * 夹取：本机 `reasoning:false` 恒为 off）。否则用户点了「High」而界面纹丝不动，
   * 正是 C3 记过的「点了没反应」陷阱。
   *
   * （原「模型」组随 2026-09-23 用户裁决删除：模型管理走「模型」Tab 的 Provider/模型
   *   编辑器，选用走工具条上拉菜单；live 拉取保留供思考档位展示。）
   */
  const live = isLiveEnabled();
  const liveModels = useModelsStore((state) => state.payload);
  const ensureModels = useModelsStore((state) => state.ensure);
  const applyModels = useModelsStore((state) => state.applyPayload);
  useEffect(() => {
    if (live) void ensureModels();
  }, [live, ensureModels]);

  const activeThinking: ThinkingLevel | null = live
    ? ((liveModels?.settings.thinkingLevel ?? liveModels?.thinkingLevel ?? null) as ThinkingLevel | null)
    : thinkingLevel;

  const selectThinking = (level: ThinkingLevel) => {
    setThinkingLevel(level);
    const transport = getLiveTransport();
    if (!transport) return;
    void transport
      .setThinkingLevel(level)
      .then(applyModels)
      .catch((e) => {
        console.error("[live] setThinkingLevel 失败:", e);
      });
  };

  return (
    <div data-testid="settings-general-tab" className="flex min-w-0 flex-col" style={{ gap: SCREEN_SECTION_GAP }}>
      {/* ① 思考强度 —— 对齐 set_thinking_level（模型单选组已删：模型管理走「模型」Tab，选用走工具条菜单） */}
      <SettingsGroup
        group="thinking"
        title="思考强度"
        note={`对齐 Pi 的 ${PI_FIELD_NAMES.thinking} · 档位取值与工具条同源`}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {COMPOSER_THINKING_LEVELS.map((level) => {
            const active = level === activeThinking;
            return (
              <Chip
                key={level}
                data-testid="settings-thinking-option"
                data-thinking-level={level}
                data-active={active}
                variant={active ? "accent" : "neutral"}
                selected={active}
                onClick={() => selectThinking(level)}
              >
                {THINKING_LABEL[level]}
              </Chip>
            );
          })}
        </div>
        {live && liveModels ? (
          <p className="mt-2 text-xs text-text-tertiary">
            当前模型支持档位：
            <code className="ml-1 font-mono">{liveModels.availableThinkingLevels.join(" / ") || "-"}</code>
            {` · 持久化档位：${liveModels.settings.thinkingLevel ?? "-"}`}
          </p>
        ) : null}
      </SettingsGroup>

      {/* ② 会话 —— 对齐 SettingsManager.autoCompact / autoRetry */}
      <SettingsGroup
        group="session"
        title="会话"
        note={`对齐 Pi 的 ${PI_FIELD_NAMES.autoCompact} / ${PI_FIELD_NAMES.autoRetry}`}
      >
        <ul data-testid="settings-session-list" className="min-w-0 overflow-hidden rounded-lg border border-border-subtle bg-bg-surface">
          {SESSION_SWITCHES.map((item) => {
            const checked = sessionSwitches[item.field];
            return (
              <li
                key={item.field}
                className="flex min-w-0 items-center gap-3 border-t border-border-subtle px-3 py-2.5 first:border-t-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium text-text-primary">{item.label}</span>
                    {/* 对齐的 Pi 字段名必须可读（验收 4-6） */}
                    <code className="font-mono text-xs text-text-tertiary">{item.piField}</code>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-text-secondary" title={item.description}>
                    {item.description}
                  </span>
                </span>
                <Switch
                  checked={checked}
                  label={item.label}
                  onToggle={() => toggleSessionSwitch(item.field)}
                  data-testid="settings-switch"
                  data-field={item.field}
                  aria-checked={checked}
                />
              </li>
            );
          })}
        </ul>
      </SettingsGroup>

      {/* ③ 外观 —— 主题三段，必须走既有 store */}
      <SettingsGroup
        group="appearance"
        title="外观"
        note="主题切换走 ui-store 的 setTheme / syncSystemTheme，持久化与首帧确定由 store 负责"
      >
        <ThemeSelector />
      </SettingsGroup>

      {/* ④ 工作目录 —— 对齐 AgentOptions.cwd */}
      <SettingsGroup
        group="working-dir"
        title="工作目录"
        note={`对齐 Pi 的 ${PI_FIELD_NAMES.workingDir}`}
      >
        <div
          data-testid="settings-working-dir"
          data-field={PI_FIELD_NAMES.workingDir}
          className="flex min-w-0 items-center gap-3 rounded-lg border border-border-subtle bg-bg-surface px-3 py-2.5"
        >
          <Icon icon={FolderOpen} />
          <code className="min-w-0 flex-1 truncate font-mono text-sm text-text-primary" title={workingDir}>
            {workingDir}
          </code>
          <code className="hidden shrink-0 font-mono text-xs text-text-tertiary sm:block">
            {PI_FIELD_NAMES.workingDir}
          </code>
          {/*
           * 「更改」按钮：原型里不实现目录选择器（浏览器没有跨平台的原生目录选择 UI），
           * 但按钮必须可点、可聚焦 —— 空实现而不是 disabled，否则 G7 走查会把它当成
           * 「交互元素无反馈」。点击行为与真实接入的落点写在 title 里。
           */}
          <Button
            variant="secondary"
            size="sm"
            data-testid="settings-change-dir"
            title="原型阶段不实现目录选择器；接入 Electron 后调用系统目录对话框"
          >
            更改
          </Button>
        </div>
      </SettingsGroup>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * 分组容器：`data-group` 是验收 4-5 口径迁移后的判定位（常规 Tab 内顺序断言）
 * ------------------------------------------------------------------------- */

function SettingsGroup({
  group,
  title,
  note,
  children,
}: {
  group: string;
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section data-testid="settings-group" data-group={group} className="min-w-0">
      <div
        className="mb-3 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1"
        style={{ minHeight: SETTINGS_GROUP_HEADER_MIN_HEIGHT }}
      >
        <h2 className="text-sm font-semibold text-text-primary" style={{ minWidth: SETTINGS_LABEL_WIDTH }}>
          {title}
        </h2>
        <p className="min-w-0 text-xs text-text-tertiary">{note}</p>
      </div>
      {children}
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * 主题三段选择
 *
 * ★ 关键约束：不许自己写 DOM 操作（task-M4.md 4.3 明令）。三种取值分别对应
 *   store 的两个既有入口：
 * - "light" / "dark" → `setTheme(t)`：写 localStorage 并置 `themeSource = "user"`
 * - "system"         → `useSystemTheme()`：切回跟随系统（语义即「切回跟随系统」）
 *
 * 「跟随系统」这一档在已做过显式选择的会话里，光调 `syncSystemTheme()` 是空操作
 * （source 仍是 "user"），用户会看到点了没反应。
 * ------------------------------------------------------------------------- */

function ThemeSelector() {
  const theme = useUiStore((state) => state.theme);
  const themeSource = useUiStore((state) => state.themeSource);
  const setTheme = useUiStore((state) => state.setTheme);
  const useSystemTheme = useUiStore((state) => state.useSystemTheme);

  /** 三段各自的激活判定：source=system 时前两段都不该亮（主题当前值可能是系统给的） */
  const activeValue: ThemeOptionValue = themeSource === "system" ? "system" : theme;

  const apply = (value: ThemeOptionValue) => {
    if (value === "system") {
      useSystemTheme();
      return;
    }
    setTheme(value);
  };

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2" role="group" aria-label="主题">
        {THEME_OPTIONS.map((option) => {
          const active = option.value === activeValue;
          return (
            <Chip
              key={option.value}
              data-testid="settings-theme-option"
              data-theme-value={option.value}
              data-active={active}
              variant={active ? "accent" : "neutral"}
              selected={active}
              icon={option.value === "dark" ? Moon : option.value === "light" ? Sun : undefined}
              onClick={() => apply(option.value)}
            >
              {option.label}
            </Chip>
          );
        })}
      </div>
      <p data-testid="settings-theme-state" className="mt-2 text-xs text-text-tertiary">
        当前 <code className="font-mono">data-theme=&quot;{theme}&quot;</code>
        {themeSource === "system" ? " · 跟随系统（系统换肤时自动同步）" : " · 用户显式选择（已持久化）"}
      </p>
    </div>
  );
}
