/**
 * Shiki 代码高亮 —— 懒加载单例。
 *
 * 为什么做成懒加载单例：shiki 全套语言/主题体积很大，首屏若直接 import 会把几 MB
 * 的语法数据拖进主包，拖慢首屏。原型里只有消息里的代码块才需要它，所以首次
 * 遇到代码块时才动态 import（见下方 getHighlighter）。
 *
 * 为什么用 `shiki/bundle/web` 入口（而非主入口 `shiki`）：
 * 主入口 `import "shiki"` 会把**所有**语言与主题打进产物；`bundle/web` 只预置了
 * 常用集合，且我们通过 `createHighlighter({ langs, themes })` 显式只加载用到的那几个，
 * 产物体积可控。实测产物体积见 .plan/m2-notes-A.md。
 *
 * 双主题策略：`codeToHtml` 传 `themes: { light, dark }` 且 `defaultColor: false`。
 * `defaultColor: false` 让 Shiki **不输出默认色**，只输出两组 CSS 变量
 * `--shiki-light` / `--shiki-light-bg` 与 `--shiki-dark` / `--shiki-dark-bg`。
 * 真正「选哪个主题」交给 shiki.css 用 `[data-theme="dark"]` 桥接（绝不用 Tailwind 的 dark:）。
 * 这样切换主题时配色实时跟随、无需重渲染（验收 2-4）。
 */

import type { HighlighterGeneric } from "shiki";

/**
 * 结构化类型即可：bundle/web 的 createHighlighter 返回的是子集泛化类型，
 * 与 `shiki` 主入口的 `Highlighter` 因语言集合不同而互不赋值，
 * 这里只关心 `codeToHtml` 这一个方法，避免类型纠缠。
 */
type AnyHighlighter = HighlighterGeneric<string, string>;

/** 只加载原型里会遇到的语言，避免打进全量语法 */
const LANGS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "bash",
  "shell",
  "css",
  "html",
  "md",
  "yaml",
  "plaintext",
] as const;

/** 浅/深两套主题（GitHub 官方配色，对比度达标） */
const THEME_LIGHT = "github-light";
const THEME_DARK = "github-dark";

let highlighterPromise: Promise<AnyHighlighter> | null = null;

async function getHighlighter(): Promise<AnyHighlighter> {
  if (!highlighterPromise) {
    // 动态 import 子入口 → 首屏不加载 shiki
    highlighterPromise = import("shiki/bundle/web").then(({ createHighlighter }) =>
      createHighlighter({
        langs: [...LANGS],
        themes: [THEME_LIGHT, THEME_DARK],
      }) as unknown as AnyHighlighter,
    );
  }
  return highlighterPromise;
}

/** 把语言标识规范成 shiki 认识的名字；不在清单里就退回纯文本（不会抛错） */
function normalizeLang(raw: string): string {
  const lang = raw.trim().toLowerCase();
  if ((LANGS as readonly string[]).includes(lang)) return lang;
  // 一些常见别名
  if (lang === "typescript") return "ts";
  if (lang === "javascript") return "js";
  if (lang === "sh" || lang === "zsh") return "bash";
  if (lang === "markdown") return "md";
  return "plaintext";
}

/**
 * 高亮一段代码，返回带 shiki 变量的 HTML 字符串。
 * 失败（主题/语言异常）时退回纯文本 pre，保证 UI 不崩。
 */
export async function highlightCode(code: string, lang: string): Promise<string> {
  try {
    const highlighter = await getHighlighter();
    return highlighter.codeToHtml(code, {
      lang: normalizeLang(lang),
      themes: { light: THEME_LIGHT, dark: THEME_DARK },
      // 关键：不输出默认色，只输出 --shiki-light / --shiki-dark 变量，颜色交给 CSS 选
      defaultColor: false,
    });
  } catch {
    const escaped = code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<pre class="shiki"><code>${escaped}</code></pre>`;
  }
}
