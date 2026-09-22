import type { OsName } from "@/components/shell/TitleBar";

/**
 * 06 屏 · 三端窗口壳的元数据。
 *
 * 为什么单独抽一个 mock 文件：三端壳的**形状差异已经由 `TitleBar` 的三端分支实现**
 * （M1 验收覆盖），06 屏自己只负责「并排展示 + 逐壳切 os」。
 * 因此这里只放**展示层需要的数据**（os 值、显示名、一句说明），
 * 不重复描述控件形状 —— 见 task-M5.md 明令禁止第 10 条。
 *
 * `os` 是验收脚本的定位键：`shell-preview` / `shell-preview-label` / `shell-content-probe`
 * 都带 `data-os`，取值必须来自本表且三者互不相同（验收 5-1）。
 */
export interface ShellVariant {
  /** 三端取值，直接对齐 `TitleBar` 的 `OsName` */
  os: OsName;
  /** 卡片标签上的显示名 */
  label: string;
  /** 一句说明，写清这一端的标志性差异 */
  note: string;
}

/**
 * 三端顺序固定为 mac → win → linux。
 * 顺序固定是为了让并排展示与设计稿一致，也让验收脚本能按稳定顺序取三组坐标。
 */
export const SHELL_VARIANTS: readonly ShellVariant[] = [
  {
    os: "mac",
    label: "macOS",
    note: "交通灯在左（三个彩色圆点，直径 10）",
  },
  {
    os: "win",
    label: "Windows",
    note: "控件在右，关闭键染危险色",
  },
  {
    os: "linux",
    label: "Linux",
    note: "控件在右，三键同色、无危险色",
  },
];

/** 三端 os 合法取值集合（`?os=` 参数解析与非法值回落共用） */
export const SHELL_OS_VALUES: readonly OsName[] = SHELL_VARIANTS.map((v) => v.os);

/**
 * 校验一个字符串是否是合法的 os 值。
 *
 * 为什么不用 `Array.prototype.includes` 直接判：`includes` 会把 `string` 与
 * `OsName` 的联合类型判成「可能不相交」，在 strict 下要额外断言；
 * 用一个显式守卫函数可以把类型收窄做干净，且解析 `?os=` 时能直接复用。
 */
export function isOsName(value: string | null): value is OsName {
  return value === "mac" || value === "win" || value === "linux";
}

/** 06 屏并排模式的标题与说明（单壳模式复用同一份文案基底） */
export const SHELLS_SCREEN_TITLE = "跨平台窗口壳";
export const SHELLS_SCREEN_SUBTITLE = "同一内容区在 mac / win / linux 三种壳下并排呈现，只换壳、不换内容";
