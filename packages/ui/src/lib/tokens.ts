import type { Theme } from "@/store/ui-store";

/** 颜色令牌清单（与 tokens.css 一一对应） */
export const COLOR_TOKENS = [
  "bg-app",
  "bg-surface",
  "bg-subtle",
  "bg-elevated",
  "bg-hover",
  "bg-active",
  "text-primary",
  "text-secondary",
  "text-tertiary",
  "text-inverse",
  "border-subtle",
  "border-default",
  "border-strong",
  "accent",
  "accent-hover",
  "accent-soft",
  "accent-fg",
  "success",
  "success-soft",
  "warning",
  "warning-soft",
  "danger",
  "danger-soft",
  "info",
  "info-soft",
  "icon-neutral",
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];

export const TOKEN_GROUPS: Array<{ title: string; tokens: ColorToken[] }> = [
  {
    title: "背景",
    tokens: ["bg-app", "bg-surface", "bg-subtle", "bg-elevated", "bg-hover", "bg-active"],
  },
  {
    title: "文字",
    tokens: ["text-primary", "text-secondary", "text-tertiary", "text-inverse"],
  },
  {
    title: "描边",
    tokens: ["border-subtle", "border-default", "border-strong"],
  },
  {
    title: "强调色",
    tokens: ["accent", "accent-hover", "accent-soft", "accent-fg"],
  },
  {
    title: "语义色",
    tokens: ["success", "success-soft", "warning", "warning-soft", "danger", "danger-soft", "info", "info-soft"],
  },
  {
    title: "图标",
    tokens: ["icon-neutral"],
  },
];

/**
 * 读取指定主题下的实际令牌值：临时切换 <html data-theme> 后取计算值再还原。
 * 同步完成，不会产生中间帧的绘制。
 */
export function readColorTokens(theme: Theme): Record<ColorToken, string> {
  const result = {} as Record<ColorToken, string>;
  if (typeof document === "undefined") return result;

  const root = document.documentElement;
  const previous = root.dataset.theme;

  root.dataset.theme = theme;
  const computed = getComputedStyle(root);
  for (const token of COLOR_TOKENS) {
    result[token] = computed.getPropertyValue(`--${token}`).trim();
  }

  if (previous) {
    root.dataset.theme = previous;
  } else {
    delete root.dataset.theme;
  }
  return result;
}

export const RADIUS_TOKENS = ["sm", "md", "lg", "xl", "full"] as const;

export const FONT_SIZE_TOKENS = ["xs", "sm", "base", "md", "lg", "xl"] as const;
