import { Blocks, Database, FileText, MessageSquare, Package, Pencil, Sparkles, Terminal } from "lucide-react";
import { cn } from "@/lib/cn";
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
  type ToolName,
} from "@/mock/skills";
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

  const enabledCount = TOOL_ENTRIES.filter((t) => enabledTools[t.name]).length;
  const skillTotal = SKILL_GROUPS.reduce((n, g) => n + g.entries.length, 0);

  return (
    <WindowShell os={os} title="技能与工具" onOpenSettings={onOpenSettings}>
      <Sidebar activeSessionId="session-0" footer={<SidebarFooter onOpenSettings={onOpenSettings} />} />

      <ScreenArea data-testid="skills-screen">
        <ScreenHeader
          title="技能与工具"
          subtitle={
            <span>
              技能 {skillTotal} 条 · 工具 {enabledCount}/{TOOL_ENTRIES.length} 开启 · MCP{" "}
              {COMPOSER_MCP_SERVERS.length} 个服务器
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
            <div className="flex min-w-0 flex-col" style={{ gap: 16 }}>
              {SKILL_GROUPS.map((group) => (
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

          {/* ③ MCP 服务器列表（自建能力展示位） */}
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
        </ScreenBody>
      </ScreenArea>
    </WindowShell>
  );
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
