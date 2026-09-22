import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useUiStore } from "@/store/ui-store";
import { Button, BUTTON_STATE_CLASSES, Chip, CHIP_STATE_CLASSES, IconButton } from "@/components/primitives";
import type { ButtonVariant } from "@/components/primitives";
import { ICON_INVENTORY, Icon } from "@/components/common/icons";
import { ArrowLeft, Moon, RefreshCw, Sun } from "lucide-react";
import {
  FONT_SIZE_TOKENS,
  RADIUS_TOKENS,
  TOKEN_GROUPS,
  readColorTokens,
  type ColorToken,
} from "@/lib/tokens";

const BUTTON_VARIANTS: ButtonVariant[] = ["primary", "secondary", "ghost", "danger"];
const CHIP_VARIANTS: Array<"neutral" | "accent" | "outline"> = ["neutral", "accent", "outline"];

/** class 必须字面量，Tailwind 才能扫描到 */
const FONT_SIZE_CLASS: Record<string, string> = {
  xs: "text-xs",
  sm: "text-sm",
  base: "text-base",
  md: "text-md",
  lg: "text-lg",
  xl: "text-xl",
};

const RADIUS_CLASS: Record<string, string> = {
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  xl: "rounded-xl",
  full: "rounded-full",
};

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-md font-semibold text-text-primary">{title}</h2>
        {note ? <p className="text-xs text-text-tertiary">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Swatch({ value, label }: { value?: string; label: string }) {
  // 令牌缺失时明确报警，而不是渲染成空白 —— 这是 00 屏存在的意义
  const missing = !value;

  return (
    <div className="flex items-center gap-2">
      <div
        className={cn(
          "h-8 w-14 shrink-0 rounded-md border",
          missing ? "border-danger bg-danger-soft" : "border-border-subtle",
        )}
        style={missing ? undefined : { backgroundColor: value }}
      />
      {missing ? (
        <code className="rounded-sm bg-danger-soft px-1.5 py-0.5 font-mono text-xs text-danger">未定义</code>
      ) : (
        <code className="truncate font-mono text-xs text-text-secondary">{label}</code>
      )}
    </div>
  );
}

export interface TokensScreenProps {
  /** 返回 01 工作台；M1 起本页是工作台标题栏「设置」按钮的目标 */
  onBackToWorkbench?: () => void;
}

export function TokensScreen({ onBackToWorkbench }: TokensScreenProps) {
  const theme = useUiStore((state) => state.theme);
  const toggleTheme = useUiStore((state) => state.toggleTheme);
  const syncSystemTheme = useUiStore((state) => state.syncSystemTheme);

  // 深浅两套值在挂载时一次性读出，用于并列展示
  const [values] = useState(() => ({ light: readColorTokens("light"), dark: readColorTokens("dark") }));

  const radiusValues = useMemo(() => {
    if (typeof document === "undefined") return {} as Record<string, string>;
    const computed = getComputedStyle(document.documentElement);
    return Object.fromEntries(RADIUS_TOKENS.map((r) => [r, computed.getPropertyValue(`--radius-${r}`).trim()]));
  }, []);

  // 令牌体检：缺失（未定义）与未覆盖（深色块漏改）
  const issues = useMemo(() => {
    const missing: string[] = [];
    const unchanged: string[] = [];
    for (const group of TOKEN_GROUPS) {
      for (const token of group.tokens) {
        if (!values.light[token]) missing.push(token);
        if (!values.dark[token]) missing.push(token);
        if (token !== "icon-neutral" && values.light[token] && values.light[token] === values.dark[token]) {
          unchanged.push(token);
        }
      }
    }
    return { missing: [...new Set(missing)], unchanged: [...new Set(unchanged)] };
  }, [values]);

  const fontValues = useMemo(() => {
    if (typeof document === "undefined") return {} as Record<string, string>;
    const computed = getComputedStyle(document.documentElement);
    return Object.fromEntries(FONT_SIZE_TOKENS.map((f) => [f, computed.getPropertyValue(`--text-${f}`).trim()]));
  }, []);

  return (
    <div className="min-h-full bg-bg-app text-text-primary">
      <header className="sticky top-0 z-10 border-b border-border-subtle bg-bg-app">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div>
            <h1 className="text-lg font-semibold">00 · 设计系统基础</h1>
            <p className="text-xs text-text-tertiary">
              令牌唯一来源 tokens.css · 当前 <code className="font-mono">data-theme=&quot;{theme}&quot;</code>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {onBackToWorkbench ? (
              <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBackToWorkbench}>
                返回工作台
              </Button>
            ) : null}
            <Button variant="secondary" size="sm" icon={theme === "dark" ? Moon : Sun} onClick={toggleTheme}>
              {theme === "dark" ? "深色" : "浅色"}
            </Button>
            <Button variant="ghost" size="sm" icon={RefreshCw} onClick={syncSystemTheme}>
              跟随系统
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] space-y-10 px-6 py-8">
        {/* 令牌体检小结 */}
        <section
          className={cn(
            "rounded-lg border px-4 py-3",
            issues.missing.length > 0 || issues.unchanged.length > 0
              ? "border-warning bg-warning-soft"
              : "border-border-subtle bg-bg-subtle",
          )}
        >
          <h2 className="text-sm font-semibold">
            {issues.missing.length > 0 || issues.unchanged.length > 0 ? "令牌体检 · 发现问题" : "令牌体检 · 全部正常"}
          </h2>
          <ul className="mt-1.5 space-y-0.5 text-xs">
            <li className={issues.missing.length ? "text-warning" : "text-text-secondary"}>
              未定义的令牌 <span className="font-mono">{issues.missing.length}</span>
              {issues.missing.length ? `：${issues.missing.join("、")}` : ""}
            </li>
            <li className={issues.unchanged.length ? "text-warning" : "text-text-secondary"}>
              深浅未覆盖的令牌 <span className="font-mono">{issues.unchanged.length}</span>
              {issues.unchanged.length ? `：${issues.unchanged.join("、")}` : ""}
            </li>
          </ul>
          <p className="mt-1.5 text-xs text-text-tertiary">
            共 {TOKEN_GROUPS.reduce((n, g) => n + g.tokens.length, 0)} 个颜色令牌 ·
            <code className="font-mono"> --icon-neutral </code>
            属刻意固定色，不计入「未覆盖」
          </p>
        </section>

        {/* 色板：逐组深浅并列 */}
        {TOKEN_GROUPS.map((group) => (
          <Section key={group.title} title={`色板 · ${group.title}`} note={`${group.tokens.length} 个令牌`}>
            <div className="overflow-hidden rounded-lg border border-border-subtle bg-bg-surface">
              <div className="grid grid-cols-[168px_1fr_1fr] gap-3 border-b border-border-subtle px-4 py-2">
                <span className="text-xs font-medium text-text-tertiary">令牌</span>
                <span className="text-xs font-medium text-text-tertiary">浅色（浅底预览）</span>
                <span className="text-xs font-medium text-text-tertiary">深色（深底预览）</span>
              </div>
              {group.tokens.map((token: ColorToken) => {
                // 深浅两值相同：对随主题变化的令牌来说是可疑信号（--icon-neutral 属预期不变）
                const unchanged =
                  values.light[token] === values.dark[token] && token !== "icon-neutral";

                return (
                  <div
                    key={token}
                    className="grid grid-cols-[168px_1fr_1fr] items-center gap-3 border-t border-border-subtle px-4 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      <code className="truncate font-mono text-xs text-text-secondary">--{token}</code>
                      {unchanged ? (
                        <span
                          className="shrink-0 rounded-sm bg-warning-soft px-1 py-0.5 font-mono text-xs text-warning"
                          title="深浅两模式取值相同，若不是刻意固定色则说明深色块漏了覆盖"
                        >
                          未覆盖
                        </span>
                      ) : null}
                    </div>
                    <div
                      className="rounded-md px-2 py-1.5"
                      style={{ backgroundColor: values.light["bg-app"], color: values.light["text-primary"] }}
                    >
                      <Swatch value={values.light[token]} label={values.light[token]} />
                    </div>
                    <div
                      className="rounded-md px-2 py-1.5"
                      style={{ backgroundColor: values.dark["bg-app"], color: values.dark["text-primary"] }}
                    >
                      <Swatch value={values.dark[token]} label={values.dark[token]} />
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>
        ))}

        {/* 字号阶梯 */}
        <Section title="字号阶梯" note="text-xs → text-xl，圆角与字号不随主题变化">
          <div className="divide-y divide-border-subtle overflow-hidden rounded-lg border border-border-subtle bg-bg-surface">
            {FONT_SIZE_TOKENS.map((step) => (
              <div key={step} className="flex flex-wrap items-baseline gap-4 px-4 py-2.5">
                <code className="w-24 shrink-0 font-mono text-xs text-text-tertiary">text-{step}</code>
                <span className="w-16 shrink-0 font-mono text-xs text-text-secondary">{fontValues[step]}</span>
                <span className={cn("min-w-0 flex-1 truncate", FONT_SIZE_CLASS[step])}>
                  Atlas 桌面 Agent · Design System 0123
                </span>
              </div>
            ))}
          </div>
        </Section>

        {/* 圆角档位 */}
        <Section title="圆角档位" note="rounded-sm / md / lg / xl / full">
          <div className="flex flex-wrap gap-4">
            {RADIUS_TOKENS.map((step) => (
              <div key={step} className="flex flex-col items-start gap-1.5">
                <div
                  className={cn(
                    "flex h-14 w-28 items-center justify-center border border-border-default bg-bg-subtle",
                    RADIUS_CLASS[step],
                  )}
                >
                  <span className="font-mono text-xs text-text-secondary">{radiusValues[step]}</span>
                </div>
                <code className="font-mono text-xs text-text-tertiary">rounded-{step}</code>
              </div>
            ))}
          </div>
        </Section>

        {/* 按钮状态矩阵 */}
        <Section title="按钮状态矩阵" note="行：variant · 列：默认 / 悬停 / 按下 / 禁用">
          <div className="overflow-x-auto rounded-lg border border-border-subtle bg-bg-surface">
            <div className="min-w-[720px]">
              <div className="grid grid-cols-[110px_repeat(4,minmax(0,1fr))] gap-3 border-b border-border-subtle px-4 py-2">
                <span className="text-xs font-medium text-text-tertiary">variant</span>
                <span className="text-xs font-medium text-text-tertiary">default</span>
                <span className="text-xs font-medium text-text-tertiary">hover</span>
                <span className="text-xs font-medium text-text-tertiary">active</span>
                <span className="text-xs font-medium text-text-tertiary">disabled</span>
              </div>
              {BUTTON_VARIANTS.map((variant) => (
                <div
                  key={variant}
                  className="grid grid-cols-[110px_repeat(4,minmax(0,1fr))] items-center gap-3 border-t border-border-subtle px-4 py-3"
                >
                  <code className="font-mono text-xs text-text-secondary">{variant}</code>
                  <Button variant={variant}>发送</Button>
                  <Button variant={variant} className={BUTTON_STATE_CLASSES[variant].hover}>
                    发送
                  </Button>
                  <Button variant={variant} className={BUTTON_STATE_CLASSES[variant].active}>
                    发送
                  </Button>
                  <Button variant={variant} disabled>
                    发送
                  </Button>
                </div>
              ))}
              <div className="grid grid-cols-[110px_repeat(4,minmax(0,1fr))] items-center gap-3 border-t border-border-subtle px-4 py-3">
                <code className="font-mono text-xs text-text-secondary">size sm</code>
                <Button size="sm" variant="primary">
                  小尺寸
                </Button>
                <Button size="sm" variant="secondary">
                  小尺寸
                </Button>
                <Button size="sm" variant="ghost">
                  小尺寸
                </Button>
                <Button size="sm" variant="danger">
                  小尺寸
                </Button>
              </div>
              <div className="grid grid-cols-[110px_repeat(4,minmax(0,1fr))] items-center gap-3 border-t border-border-subtle px-4 py-3">
                <code className="font-mono text-xs text-text-secondary">icon</code>
                <IconButton label="收起左侧" icon={Sun} />
                <IconButton label="收起右侧" icon={Moon} active />
                <IconButton label="刷新" icon={RefreshCw} size="md" />
                <IconButton label="禁用" icon={RefreshCw} disabled />
              </div>
            </div>
          </div>
        </Section>

        {/* 芯片状态矩阵 */}
        <Section title="芯片状态矩阵" note="行：variant · 列：默认 / 悬停 / 选中 / 禁用">
          <div className="overflow-x-auto rounded-lg border border-border-subtle bg-bg-surface">
            <div className="min-w-[720px]">
              <div className="grid grid-cols-[110px_repeat(4,minmax(0,1fr))] gap-3 border-b border-border-subtle px-4 py-2">
                <span className="text-xs font-medium text-text-tertiary">variant</span>
                <span className="text-xs font-medium text-text-tertiary">default</span>
                <span className="text-xs font-medium text-text-tertiary">hover</span>
                <span className="text-xs font-medium text-text-tertiary">selected</span>
                <span className="text-xs font-medium text-text-tertiary">disabled</span>
              </div>
              {CHIP_VARIANTS.map((variant) => (
                <div
                  key={variant}
                  className="grid grid-cols-[110px_repeat(4,minmax(0,1fr))] items-center gap-3 border-t border-border-subtle px-4 py-3"
                >
                  <code className="font-mono text-xs text-text-secondary">{variant}</code>
                  <Chip variant={variant}>Claude Sonnet</Chip>
                  <Chip variant={variant} className={CHIP_STATE_CLASSES[variant].hover}>
                    Claude Sonnet
                  </Chip>
                  <Chip variant={variant} selected>
                    Claude Sonnet
                  </Chip>
                  <Chip variant={variant} disabled>
                    Claude Sonnet
                  </Chip>
                </div>
              ))}
            </div>
          </div>
        </Section>

        {/* 图标清单 */}
        <Section
          title="图标清单"
          note={`${ICON_INVENTORY.length} 个 · 统一 size=16，颜色固定 --icon-neutral，不随主题变化`}
        >
          <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2">
            {ICON_INVENTORY.map(({ name, icon }) => (
              <div
                key={name}
                className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-surface px-2.5 py-2"
              >
                <Icon icon={icon} />
                <span className="truncate font-mono text-xs text-text-tertiary">{name}</span>
              </div>
            ))}
          </div>
        </Section>
      </main>
    </div>
  );
}
