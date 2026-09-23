import { useEffect, useState } from "react";
import { Blocks, Database, FileText, MessageSquare, Package, Pencil, Sparkles, Terminal } from "lucide-react";
import { cn } from "@/lib/cn";
import { isLiveEnabled, isMcpEnabled } from "@/lib/feature-flags";
import { getLiveTransport } from "@/services/live-transport";
import { Sidebar } from "@/components/shell/Sidebar";
import { SidebarFooter } from "@/components/shell/SidebarFooter";
import { WindowShell } from "@/components/shell/WindowShell";
import type { OsName } from "@/components/shell/TitleBar";
import { Icon, type LucideIcon } from "@/components/common/icons";
import { ScreenArea, ScreenBody, ScreenHeader, ScreenSection } from "@/components/screens/ScreenLayout";
import { Switch } from "@/components/screens/Switch";
import { COMPOSER_MCP_SERVERS } from "@/mock/composer";
import {
  MCP_NOTE,
  SKILL_GROUPS,
  TOOL_ENTRIES,
  type SkillCategory,
  type SkillGroup,
  type ToolName,
} from "@/mock/skills";
import type { ResourcesPayload } from "@/mock/types";
import { useUiStore } from "@/store/ui-store";

/**
 * 04 屏 · 技能与工具。
 *
 * 三个分区，**顺序固定**：技能列表 → 工具开关 → MCP 服务器列表。
 *
 * ★ 技能分三类做成**三个同时可见的分组段落**（不是 Tabs）：验收 4-2 要「分类对应三类」，
 *   脚本要能在一次页面加载里读到三类；Tab 切换会让另外两类不在 DOM 里，
 *   等于把判定依赖到交互步骤上（见 task-M4.md 4.2 ①）。
 *
 * ★ MCP 区块是**自建能力的展示位** —— Pi 不内置 MCP。这句说明必须留在页面上，
 *   它是给后来接 Pi 的人看的（见 task-M4.md 4.2 ③）。
 *
 * ⏸ **MCP 区块默认不渲染（2026-09-23 用户裁决「MCP 暂缓」）**：
 *   Pi 无 MCP 概念（`usage.md:310`），该清单在 Pi 侧没有任何数据源，继续展示 mock 数据属误导。
 *   但 `accept:m2` 的 2-11 与 `accept:m4` 的 4-4 依赖该区块存在 → 按 §五纪律选
 *   「保留 mock 分支供回归」：**组件代码 / testid / mock 数据全部保留，仅用 `?mcp=1` 门控**。
 *   见 `@/lib/feature-flags` 与 `.plan/pi-survey-plan.md` S5。
 */

/** 技能分类 → 标题图标（列表里给的是 categories，图标是纯展示，不进 mock 数据） */
const CATEGORY_ICON: Record<SkillCategory, LucideIcon> = {
  extension: Blocks,
  prompt: MessageSquare,
  skill: Sparkles,
};

/** 工具名 → 图标（task-M4.md 4.2 指定的映射，四个图标均已在 ICON_INVENTORY 里） */
const TOOL_ICON: Record<ToolName, LucideIcon> = {
  read: FileText,
  bash: Terminal,
  edit: Pencil,
  write: Package,
};

export interface SkillsScreenProps {
  os?: OsName;
  onBackToWorkbench?: () => void;
  onOpenSettings?: () => void;
}

export function SkillsScreen({ os = "mac", onBackToWorkbench, onOpenSettings }: SkillsScreenProps) {
  const enabledTools = useUiStore((state) => state.enabledTools);
  const toggleTool = useUiStore((state) => state.toggleTool);

  /*
   * ★ C5：live 形态下「技能列表」用 core 的真实三类数据（`GET /resources`）。
   *
   * 关键取舍：**分组结构（三个分组、label/note/顺序、testid）从 mock 的 SKILL_GROUPS 派生**，
   * 只把 `entries` 换成真实条目 —— 这样 04 屏的 DOM 契约与默认形态完全同构
   * （验收 4-2 读的是 `skill-group` / `skill-item` / `skill-group-count` 的 dataset），
   * 真实数据不该带来第二套结构。
   *
   * 拉取放在组件挂载时（本屏被路由到才有意义），失败只记日志、不回退成假数据
   * （宁可显示空分组，也不在 live 形态下拿 mock 顶替 —— 那是误导）。
   */
  const live = isLiveEnabled();
  const [liveResources, setLiveResources] = useState<ResourcesPayload | null>(null);
  useEffect(() => {
    if (!live) return;
    const transport = getLiveTransport();
    if (!transport) return;
    let alive = true;
    void transport
      .listResources()
      .then((payload) => {
        if (alive) setLiveResources(payload);
      })
      .catch((e) => console.error("[live] /resources 失败:", e));
    return () => {
      alive = false;
    };
  }, [live]);

  const groups: SkillGroup[] = liveResources ? groupsFromResources(liveResources) : SKILL_GROUPS;

  const enabledCount = TOOL_ENTRIES.filter((t) => enabledTools[t.name]).length;
  const skillTotal = groups.reduce((n, g) => n + g.entries.length, 0);
  /** MCP 区块开关（默认关；`?mcp=1` 打开，供验收回归）—— 见 @/lib/feature-flags。**不因 live 而开启** */
  const mcpEnabled = isMcpEnabled();
  /*
   * 信任门说明：口径见 `core/src/resources.ts` —— 未信任时 Pi 压根不加载项目本地资源，
   * 所以判据是「这个目录本来就有需要信任的资源 且 本次未信任」（`projectTrustBlocked`），
   * 不是「过滤前后条数差」（那个恒为 0，写出来只会是误导性的 0 条）。
   */
  const filteredNote = live && liveResources?.projectTrustBlocked
    ? "本目录含需要信任的项目本地扩展/技能，本次未信任 ⇒ 未加载也未列出（信任结论可在首次打开时确认）"
    : null;

  return (
    <WindowShell os={os} title="技能与工具" onOpenSettings={onOpenSettings}>
      <Sidebar activeSessionId="session-0" footer={<SidebarFooter onOpenSettings={onOpenSettings} />} />

      <ScreenArea data-testid="skills-screen">
        <ScreenHeader
          title="技能与工具"
          subtitle={
            <span>
              技能 {skillTotal} 条 · 工具 {enabledCount}/{TOOL_ENTRIES.length} 开启
              {live ? " · 真实数据（core /resources）" : null}
              {/* MCP 摘要随区块一起门控，避免关闭时出现「MCP 4 个服务器」却看不到列表的自相矛盾 */}
              {mcpEnabled ? ` · MCP ${COMPOSER_MCP_SERVERS.length} 个服务器` : null}
            </span>
          }
          onBackToWorkbench={onBackToWorkbench}
        />

        <ScreenBody>
          {/* ① 技能列表：三类分组各自可见 */}
          <ScreenSection
            title="技能列表"
            note="对应 Pi 的 get_commands 三类：extension / prompt / skill"
          >
            {/* 信任门过滤的说明只在「确实过滤了东西」时出现（live 形态） */}
            {filteredNote ? (
              <p
                data-testid="resources-trust-note"
                className="mb-3 rounded-md border border-warning bg-warning-soft px-3 py-2 text-xs text-warning"
              >
                {filteredNote}
              </p>
            ) : null}
            <div className="flex min-w-0 flex-col" style={{ gap: 16 }}>
              {groups.map((group) => (
                <SkillGroupBlock
                  key={group.category}
                  category={group.category}
                  label={group.label}
                  note={group.note}
                  entries={group.entries}
                />
              ))}
            </div>
          </ScreenSection>

          {/* ② 工具开关：对齐 Pi 的 tools allowlist */}
          <ScreenSection
            title="工具开关"
            note="对应 Pi 的 tools allowlist：read / bash / edit / write · 开关状态会持久化"
          >
            <ul data-testid="tool-list" className="min-w-0 overflow-hidden rounded-lg border border-border-subtle bg-bg-surface">
              {TOOL_ENTRIES.map((tool) => (
                <li
                  key={tool.name}
                  className="flex min-w-0 items-center gap-3 border-t border-border-subtle px-3 py-2.5 first:border-t-0"
                >
                  <Icon icon={TOOL_ICON[tool.name]} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium text-text-primary">{tool.label}</span>
                      <code className="font-mono text-xs text-text-tertiary">{tool.name}</code>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-text-secondary" title={tool.description}>
                      {tool.description}
                    </span>
                  </span>
                  <Switch
                    checked={enabledTools[tool.name]}
                    label={tool.hint}
                    onToggle={() => toggleTool(tool.name)}
                    data-testid="tool-toggle"
                    data-tool-name={tool.name}
                    data-enabled={enabledTools[tool.name]}
                  />
                </li>
              ))}
            </ul>
          </ScreenSection>

          {/* ③ MCP 服务器列表（自建能力展示位）—— ⏸ 默认不渲染，`?mcp=1` 打开，见 @/lib/feature-flags */}
          {mcpEnabled ? (
            <ScreenSection
              title="MCP 服务器"
              icon={Database}
              badge={
                <span data-testid="mcp-count" className="text-xs text-text-tertiary">
                  {COMPOSER_MCP_SERVERS.length} 个
                </span>
              }
            >
              {/*
               * ★ 这句必须是可见文本（不是 title / aria-label）：它是给读代码的人看的说明，
               *   验收 4-4 要求「区块内含"自建能力"文案」。
               */}
              <p
                data-testid="mcp-note"
                className="mb-3 rounded-md border border-warning bg-warning-soft px-3 py-2 text-xs text-warning"
              >
                {MCP_NOTE}
              </p>

              <ul data-testid="mcp-list" className="min-w-0 overflow-hidden rounded-lg border border-border-subtle bg-bg-surface">
                {COMPOSER_MCP_SERVERS.map((server) => {
                  const connected = server.status === "connected";
                  return (
                    <li
                      key={server.id}
                      data-testid="mcp-server"
                      data-mcp-name={server.name}
                      data-mcp-status={server.status}
                      className="flex min-w-0 items-center gap-3 border-t border-border-subtle px-3 py-2.5 first:border-t-0"
                    >
                      <Icon icon={Database} />
                      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{server.name}</span>
                      <span
                        className={cn(
                          "shrink-0 text-xs",
                          // 状态色只用令牌：connected→success、disconnected→text-tertiary
                          connected ? "text-success" : "text-text-tertiary",
                        )}
                      >
                        {connected ? "已连接" : "未连接"}
                      </span>
                      <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-text-secondary">
                        {server.toolCount} 个工具
                      </span>
                    </li>
                  );
                })}
              </ul>
            </ScreenSection>
          ) : null}
        </ScreenBody>
      </ScreenArea>
    </WindowShell>
  );
}

/* ---------------------------------------------------------------------------
 * C5 · `/resources` 载荷 → 04 屏的分组结构
 *
 * 只替换 `entries`：`label` / `note` / 分组顺序 / `category` 全部沿用 `SKILL_GROUPS`
 * —— 04 屏的 DOM 结构与默认形态**完全同构**（分组数 3、每组都有条数标记、testid 不变）。
 * ------------------------------------------------------------------------- */

function groupsFromResources(resources: ResourcesPayload): SkillGroup[] {
  const byCategory: Record<SkillCategory, ResourcesPayload["extensions"]> = {
    extension: resources.extensions ?? [],
    prompt: resources.prompts ?? [],
    skill: resources.skills ?? [],
  };
  return SKILL_GROUPS.map((group) => ({
    ...group,
    entries: byCategory[group.category].map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      source: entry.source,
    })),
  }));
}

/* ---------------------------------------------------------------------------
 * 单个技能分组（一类一个段落，三段同时渲染）
 * ------------------------------------------------------------------------- */

function SkillGroupBlock({
  category,
  label,
  note,
  entries,
}: {
  category: SkillCategory;
  label: string;
  note: string;
  entries: ReadonlyArray<{ id: string; name: string; description: string; source?: string }>;
}) {
  return (
    <div data-testid="skill-group" data-skill-category={category} className="min-w-0">
      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Icon icon={CATEGORY_ICON[category]} />
        <h3 className="text-sm font-medium text-text-primary">{label}</h3>
        <code className="font-mono text-xs text-text-tertiary">{category}</code>
        {/* 条数供脚本核对（验收 4-2） */}
        <span
          data-testid="skill-group-count"
          data-skill-type={category}
          className="rounded-full bg-bg-subtle px-2 py-0.5 text-xs tabular-nums text-text-secondary"
        >
          {entries.length} 条
        </span>
        <span className="min-w-0 text-xs text-text-tertiary">{note}</span>
      </div>

      <ul className="min-w-0 overflow-hidden rounded-lg border border-border-subtle bg-bg-surface">
        {entries.map((entry) => (
          <li
            key={entry.id}
            data-testid="skill-item"
            data-skill-type={category}
            data-skill-name={entry.name}
            className="flex min-w-0 items-baseline gap-3 border-t border-border-subtle px-3 py-2.5 first:border-t-0"
          >
            <code className="shrink-0 font-mono text-sm text-text-primary">{entry.name}</code>
            <span className="min-w-0 flex-1 truncate text-xs text-text-secondary" title={entry.description}>
              {entry.description}
            </span>
            {entry.source ? (
              <span className="shrink-0 rounded-full bg-bg-subtle px-2 py-0.5 text-xs text-text-tertiary">
                {entry.source}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
