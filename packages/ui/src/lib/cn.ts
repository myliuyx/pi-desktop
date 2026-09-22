/**
 * className 合并：过滤假值 + 同组冲突时后者胜出（简易版 tailwind-merge）。
 * 只处理本项目用到的前缀，够用即可。
 */

export type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | ClassValue[]
  | Record<string, boolean | null | undefined>;

const CONFLICT_PREFIXES = [
  "bg",
  "text",
  "border",
  "rounded",
  "shadow",
  "font",
  "leading",
  "tracking",
  "opacity",
  "outline",
  "ring",
  "min-w",
  "max-w",
  "min-h",
  "max-h",
  "w",
  "h",
  "size",
  "gap-x",
  "gap-y",
  "gap",
  "px",
  "py",
  "pt",
  "pb",
  "pl",
  "pr",
  "p",
  "mx",
  "my",
  "mt",
  "mb",
  "ml",
  "mr",
  "m",
  "inset",
  "top",
  "right",
  "bottom",
  "left",
  "z",
  "flex",
  "grid",
  "items",
  "justify",
  "self",
  "overflow",
  "cursor",
  "transition",
  "duration",
  "whitespace",
  "truncate",
  "shrink",
  "grow",
  "basis",
  "order",
];

const FONT_SIZE_VALUES = new Set(["xs", "sm", "base", "md", "lg", "xl"]);
/**
 * text-align 值：`text-left` / `text-center` / `text-right` 等是对齐，不是颜色！
 * 缺这组时它们落进 text-color 组，会被后写的任意 text 颜色类吞掉 ——
 * 按钮随即回落到浏览器 UA 的 `text-align: center`（Chrome 的 <button> 默认居中），
 * 文字静默居中（2026-09-22 历史会话标题实踩： MenuItem / ChipMenu / ThinkingCard
 * 等所有 cn() 内的 text-left 全部失效，仅因 span 收缩到内容宽才从未显形）。
 */
const TEXT_ALIGN_VALUES = new Set(["left", "center", "right", "justify", "start", "end"]);
const BORDER_WIDTH_VALUES = new Set(["", "0", "2", "4", "8"]);
/** flex 的「值」：`flex` 本身是 display，`flex-col` / `flex-wrap` 是别的属性，不能同组 */
const FLEX_DIRECTION_VALUES = new Set(["row", "row-reverse", "col", "col-reverse"]);
const FLEX_WRAP_VALUES = new Set(["wrap", "wrap-reverse", "nowrap"]);
/** display 值：`flex` 属于 display，与 `flex-col` 不同组；`hidden` 也是 display:none */
const DISPLAY_VALUES = new Set([
  "block",
  "inline-block",
  "inline",
  "flex",
  "inline-flex",
  "grid",
  "inline-grid",
  "table",
  "contents",
  "flow-root",
  "hidden",
  "none",
]);

function flatten(input: ClassValue): string[] {
  if (!input) return [];
  if (typeof input === "string") return [input];
  if (typeof input === "number") return [String(input)];
  if (Array.isArray(input)) return input.flatMap(flatten);
  return Object.entries(input)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key);
}

function groupOf(cls: string): string {
  const splitAt = cls.lastIndexOf(":");
  const variant = splitAt === -1 ? "" : cls.slice(0, splitAt + 1);
  const base = splitAt === -1 ? cls : cls.slice(splitAt + 1);

  for (const prefix of CONFLICT_PREFIXES) {
    if (base === prefix) {
      // 无横线的 display 关键字（`flex` / `grid` / `hidden`）归 display 组，不归前缀同名的组
      if (DISPLAY_VALUES.has(base)) return variant + "display";
      return variant + prefix;
    }
    if (!base.startsWith(prefix + "-")) continue;
    const rest = base.slice(prefix.length + 1);

    // text-* 三分：字号 / 对齐 / 颜色，按值区分（缺对齐组时 text-left 会被颜色类吞掉）
    if (prefix === "text") {
      if (FONT_SIZE_VALUES.has(rest)) return variant + "font-size";
      if (TEXT_ALIGN_VALUES.has(rest)) return variant + "text-align";
      return variant + "text-color";
    }
    // border-* 既可能是宽度也可能是颜色，按值区分
    if (prefix === "border") {
      if (BORDER_WIDTH_VALUES.has(rest)) return variant + "border-width";
      if (/^[trblxy](-(0|2|4|8))?$/.test(rest)) return variant + "border-width";
      return variant + "border-color";
    }
    /*
     * flex-* 必须细分：`flex` 是 display、`flex-col` 是 flex-direction、`flex-wrap` 是 flex-wrap。
     * 早期版本一律归到 "flex" 组，导致 `cn("flex", "flex-col")` 把 `flex` 整条丢掉 →
     * 元素只剩 flex-col 而没有 display:flex，静默退化成 display:block（M1 三栏布局曾因此塌掉）。
     */
    if (prefix === "flex") {
      if (FLEX_DIRECTION_VALUES.has(rest)) return variant + "flex-direction";
      if (FLEX_WRAP_VALUES.has(rest)) return variant + "flex-wrap";
      if (DISPLAY_VALUES.has(rest)) return variant + "display";
      return variant + "flex";
    }
    // grid-* 同理：`grid` 是 display，`grid-cols-*` / `grid-flow-*` 不是
    if (prefix === "grid") {
      return variant + (DISPLAY_VALUES.has(rest) ? "display" : "grid-" + rest.split("-")[0]);
    }
    return variant + prefix;
  }

  // `block` / `inline-flex` 等无前缀的 display 类
  if (DISPLAY_VALUES.has(base)) return variant + "display";

  return cls;
}

export function cn(...inputs: ClassValue[]): string {
  const tokens = inputs
    .flatMap(flatten)
    .flatMap((token) => token.trim().split(/\s+/))
    .filter(Boolean);

  const lastIndexByGroup = new Map<string, number>();
  tokens.forEach((token, index) => {
    lastIndexByGroup.set(groupOf(token), index);
  });

  const keep = new Set(lastIndexByGroup.values());
  return tokens.filter((_, index) => keep.has(index)).join(" ");
}
