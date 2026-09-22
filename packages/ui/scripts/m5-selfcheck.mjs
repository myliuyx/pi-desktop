/**
 * M5 自查脚本 —— 覆盖 task-M5.md 第五节「自验最低要求」8 条 + G1/G2/G5 静态扫描。
 *
 * ⚠️ 本脚本由**实现方**编写，用途是自查留痕，**不是验收依据**。
 *    按项目规矩，`scripts/m5-acceptance.mjs` 由主控独立编写；本文档的每条结论
 *    在 progress-M5.md 里一律标「待主控复核」。
 *
 * 用法：
 *   1. 先在 packages/ui 下起 dev server：npm run dev -- --port 5180 --strictPort
 *   2. node scripts/m5-selfcheck.mjs
 *   （M5_ORIGIN / M5_CDP_PORT 可覆盖；CDP 端口 9343，避开 m1=9333 / m2=9337 / m3=9341 / m4=9342）
 *
 * 复用 `cdp.mjs` 的 withBrowser（M4 教训：不要另造轮子；断言全绿也必须 ctx.save 留证据）。
 *
 * 口径说明（沿用 M4 定稿，不另立标准）：
 * - 坐标一律读 `offsetLeft / offsetTop`，**绝不读 getBoundingClientRect**——
 *   06 屏缩略窗口用了 `transform: scale()`，rect 会被 scale 污染（高危点 1）。
 * - 对比度分层：正文 ≥4.5、辅助文字 ≥3（按**计算后文字颜色**分层，见 m4-acceptance.mjs 头注）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { withBrowser, sleep } from "./cdp.mjs";

const ORIGIN = process.env.M5_ORIGIN ?? "http://127.0.0.1:5180";
const PORT = Number(process.env.M5_CDP_PORT ?? 9343);
const PKG_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const EVIDENCE = "_m5-evidence.json";

/** 页面侧工具函数（与 m4-acceptance 同口径，加 offset 坐标读取） */
const HELPERS = `
window.__T5 = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  /** 坐标口径：offsetLeft / offsetTop（不受 transform 影响） */
  off: (el) => ({ offsetLeft: el.offsetLeft, offsetTop: el.offsetTop }),
  lum: (colorStr) => {
    const nums = (colorStr.match(/[\\d.]+/g) || ['0','0','0']).map(Number);
    const f = (c) => { c = c / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(nums[0]) + 0.7152 * f(nums[1]) + 0.0722 * f(nums[2]);
  },
  effBg: (el) => {
    let n = el;
    while (n) {
      const bg = getComputedStyle(n).backgroundColor;
      const m = bg.match(/rgba?\\(([^)]+)\\)/);
      if (m) {
        const parts = m[1].split(',').map((s) => parseFloat(s));
        if (parts.length < 4 || parts[3] > 0.5) return bg;
      }
      n = n.parentElement;
    }
    return 'rgb(255,255,255)';
  },
  contrast: (el) => {
    const a = window.__T5.lum(getComputedStyle(el).color);
    const b = window.__T5.lum(window.__T5.effBg(el));
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return +(((hi + 0.05) / (lo + 0.05)).toFixed(2));
  },
  hScroll: () => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }),
};
true;
`;

/** G1 / G2 / G5 静态扫描（与 m2/m3/m4 同口径） */
function staticColorChecks() {
  const SRC = join(PKG_ROOT, "src");
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|css)$/.test(name)) files.push(full);
    }
  };
  walk(SRC);

  const hexHits = [];
  const darkVariantHits = [];
  const paletteHits = [];
  const PALETTE =
    /\b(?:bg|text|border|ring|from|to)-(?:gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)\b|\b(?:bg|text)-(?:black|white)\b/g;

  for (const file of files) {
    const rel = relative(SRC, file).replace(/\\/g, "/");
    const text = readFileSync(file, "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      const hexes = line.match(/#[0-9a-fA-F]{3,8}\b/g);
      if (hexes) hexHits.push({ file: rel, line: i + 1, hits: hexes });
      const darkVariants = line.match(/(?:^|[\s"'`])dark:[a-z[]/g);
      if (darkVariants) darkVariantHits.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 100) });
      const pal = line.match(PALETTE);
      if (pal) paletteHits.push({ file: rel, line: i + 1, hits: pal });
    });
  }

  const hexOutsideTokens = hexHits.filter((h) => h.file !== "styles/tokens.css");
  return {
    扫描文件数: files.length,
    hex在tokens之外: hexOutsideTokens,
    dark变体命中: darkVariantHits,
    内置调色板命中: paletteHits,
    G1_hex仅tokens: hexOutsideTokens.length === 0,
    G2_无dark变体: darkVariantHits.length === 0,
    G5_无内置调色板: paletteHits.length === 0,
  };
}

/**
 * 硬编码尺寸扫描（M4 口径）：只看新增的 M5 文件里的
 * `width / minWidth / maxWidth / height / minHeight / maxHeight` 数字字面量，排除 <=1 的发丝线。
 * transform 的 scale 值走常量（SHELL_PREVIEW_SCALE），不在扫描范围。
 */
function hardcodedSizeScan() {
  const TARGETS = [
    "components/screens/ShellPreview.tsx",
    "screens/ShellsScreen.tsx",
    "mock/shells.ts",
  ];
  const hits = [];
  for (const rel of TARGETS) {
    const full = join(PKG_ROOT, "src", rel);
    let text;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    text.split(/\r?\n/).forEach((line, i) => {
      // 只匹配对象字面量里的尺寸键（排除 CSS 类名里的 h-8/w-full 等）
      const m = line.match(/\b(width|minWidth|maxWidth|height|minHeight|maxHeight)\s*:\s*(\d+(?:\.\d+)?)/g);
      if (m) {
        for (const item of m) {
          const num = parseFloat(item.split(":")[1]);
          if (num > 1) hits.push({ file: rel, line: i + 1, code: item });
        }
      }
    });
  }
  return { 扫描文件: TARGETS, 命中: hits, M5新增文件无硬编码尺寸: hits.length === 0 };
}

async function main() {
  const staticResult = staticColorChecks();
  const sizeResult = hardcodedSizeScan();

  await withBrowser({ port: PORT, origin: ORIGIN, evidencePath: EVIDENCE }, async (ctx) => {
    const { cdp, open, record, assert } = ctx;
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HELPERS });

    /* ================= 1. 三端并存（并排模式） ================= */
    await open("/#/shells");
    await cdp.eval(HELPERS);

    const gridBasic = await cdp.eval(`(() => {
      const previews = window.__T5.qa('[data-testid="shell-preview"]');
      const osList = previews.map((el) => el.dataset.os);
      const labels = window.__T5.qa('[data-testid="shell-preview-label"]').map((el) => el.dataset.os);
      const probes = window.__T5.qa('[data-testid="shell-content-probe"]');
      // ⚠️ 06 屏自身的 WindowShell 也有 data-testid="window-shell"，因此这里必须
      //    **限定在 .shell-preview 之内**数壳实例，否则会数出 4 个（3 卡 + 屏自身）。
      const framesInCards = previews.map((p) => p.querySelectorAll('[data-testid="window-shell"]').length);
      const hint = window.__T5.q('[data-testid="shells-mode-hint"]');
      return {
        screen存在: !!window.__T5.q('[data-testid="shells-screen"]'),
        preview数量: previews.length,
        os集合: osList,
        os去重后数量: [...new Set(osList)].length,
        label数量: labels.length,
        label_os集合: labels,
        probe数量: probes.length,
        每卡窗口壳实例数: framesInCards,
        mode: hint ? hint.dataset.mode : null,
        hScroll: window.__T5.hScroll(),
      };
    })()`);

    assert("5-1 三端壳并存（并排三卡 data-os 互不相同）", {
      shells_screen存在: gridBasic.screen存在,
      三个shell_preview: gridBasic.preview数量 === 3,
      os集合为mac_win_linux:
        JSON.stringify([...gridBasic.os集合].sort()) === JSON.stringify(["linux", "mac", "win"]),
      os三者互不相同: gridBasic.os去重后数量 === 3,
      三张label齐全: gridBasic.label数量 === 3,
      三个探针: gridBasic.probe数量 === 3,
      // 每张卡片内恰好一个窗口壳实例（shell-frame）：01 屏复用的是 WindowShell（testid=window-shell）
      每卡恰一个窗口壳: gridBasic.每卡窗口壳实例数.length === 3 && gridBasic.每卡窗口壳实例数.every((n) => n === 1),
      mode为grid: gridBasic.mode === "grid",
    });
    record("5-1_并排模式原始观测", gridBasic);

    /* ================= 2. 内容区零位移（核心） ================= */
    // 2a. 并排模式：三卡内探针 offsetTop 必须完全一致
    const gridOffsets = await cdp.eval(`(() => {
      const probes = window.__T5.qa('[data-testid="shell-content-probe"]');
      return probes.map((p) => ({ os: p.dataset.os, ...window.__T5.off(p), offsetParent: p.offsetParent ? (p.offsetParent.dataset.testid || p.offsetParent.tagName.toLowerCase()) : null }));
    })()`);

    assert("5-2a 并排模式：三端探针 offset 完全一致", {
      三端齐全: gridOffsets.length === 3,
      offsetLeft三端一致: new Set(gridOffsets.map((o) => o.offsetLeft)).size === 1,
      offsetTop三端一致: new Set(gridOffsets.map((o) => o.offsetTop)).size === 1,
      offsetTop等于标题栏高度36: gridOffsets.every((o) => o.offsetTop === 36),
      offsetLeft全为0: gridOffsets.every((o) => o.offsetLeft === 0),
    });
    // 断言里要「打印出三组实际数值」，便于主控复核
    record("5-2a_并排三端实际偏移量", gridOffsets);

    // 2b. 单壳模式：依次 ?os=mac|win|linux，全尺寸下读探针 offset
    const singleOffsets = [];
    for (const os of ["mac", "win", "linux"]) {
      await open(`/#/shells?os=${os}`);
      await cdp.eval(HELPERS);
      // 单壳模式是 ShellsScreen 在 effect 里读 hash 参数后切换的，
      // 因此额外等一小段确保 React 已 commit（避免读到切换前的 grid 态）。
      await sleep(350);
      const one = await cdp.eval(`(() => {
        const single = window.__T5.q('[data-testid="shell-single"]');
        const probe = window.__T5.q('[data-testid="shell-content-probe"]');
        const hint = window.__T5.q('[data-testid="shells-mode-hint"]');
        // 单壳模式：shell-single 内部的窗口壳实例
        const frames = single ? single.querySelectorAll('[data-testid="window-shell"]') : [];
        return {
          shell_single存在: !!single,
          single_os: single ? single.dataset.os : null,
          probe存在: !!probe,
          probe_os: probe ? probe.dataset.os : null,
          offset: probe ? window.__T5.off(probe) : null,
          壳实例数: frames.length,
          shellFrame_os: frames.length === 1 ? frames[0].dataset.os : null,
          mode: hint ? hint.dataset.mode : null,
        };
      })()`);
      singleOffsets.push({ os, ...one });
      await sleep(200);
    }
    record("5-2b_单壳逐端原始观测", singleOffsets);

    const sOff = singleOffsets.map((s) => s.offset).filter(Boolean);
    assert("5-2b 单壳全尺寸：三端探针 offset 完全一致（核心）", {
      三次请求均得探针: singleOffsets.every((s) => s.probe存在 && s.offset !== null),
      每端shell_single与os匹配: singleOffsets.every((s) => s.shell_single存在 && s.single_os === s.os),
      每端探针os匹配: singleOffsets.every((s) => s.probe_os === s.os),
      每端壳os匹配: singleOffsets.every((s) => s.shellFrame_os === s.os),
      模式均为single: singleOffsets.every((s) => s.mode === "single"),
      /*
       * ⚠️ 本项**只断言三端一致**，不断言绝对值。
       * 单壳模式下探针的 offsetParent 是内容区三栏容器（此刻它是 ScreenArea 的子节点），
       * 因此 offsetLeft = 侧边栏宽 264、offsetTop = 标题栏36 + 页面头 + 模式提示条 + 内边距，
       * 这是**正确**的值；三端必须完全一致才是 5-2 的要害。
       * 绝对值 36 的口径只适用于并排模式（那时探针的 offsetParent 是缩放内层）。
       */
      offsetLeft三端一致: new Set(sOff.map((o) => o.offsetLeft)).size === 1,
      offsetTop三端一致: new Set(sOff.map((o) => o.offsetTop)).size === 1,
    });
    record("5-2b_单壳三端实际偏移量", singleOffsets.map((s) => ({ os: s.os, offset: s.offset })));

    // 2c. 并排模式横向尺寸一致性（三卡渲染宽度相同，说明缩放未污染）
    await open("/#/shells");
    await cdp.eval(HELPERS);
    const gridWidths = await cdp.eval(`(() => {
      const previews = window.__T5.qa('[data-testid="shell-preview"]');
      return previews.map((p) => {
        const r = p.getBoundingClientRect();
        const scaledOuter = p.querySelector('section > div > div') || p.querySelectorAll('div')[1];
        return { os: p.dataset.os, cardWidth: +r.width.toFixed(2), cardHeight: +r.height.toFixed(2) };
      });
    })()`);
    assert("5-2c 并排三卡尺寸一致（缩放口径统一）", {
      三卡宽度一致: new Set(gridWidths.map((w) => w.cardWidth)).size === 1,
      三卡高度一致: new Set(gridWidths.map((w) => w.cardHeight)).size === 1,
    });
    record("5-2c_并排三卡尺寸", gridWidths);

    /* ================= 3. 缩放不产生横向滚动 ================= */
    const gridScroll = await cdp.eval("window.__T5.hScroll()");
    assert("5-3 06 屏缩放不产生横向滚动（G6）", {
      scrollWidth不超clientWidth加1: gridScroll.scrollWidth <= gridScroll.clientWidth + 1,
    });
    record("5-3_06屏横向滚动量", gridScroll);

    // 单壳模式也不应横向滚动
    await open("/#/shells?os=win");
    await cdp.eval(HELPERS);
    const singleScroll = await cdp.eval("window.__T5.hScroll()");
    assert("5-3b 单壳模式无横向滚动", {
      scrollWidth不超clientWidth加1: singleScroll.scrollWidth <= singleScroll.clientWidth + 1,
    });

    /* ================= 4. 06 屏深浅两模式 ================= */
    await open("/#/shells");
    await cdp.eval(HELPERS);
    const lightProbe = await cdp.eval(`(() => {
      const screen = window.__T5.q('[data-testid="shells-screen"]');
      return {
        theme: document.documentElement.dataset.theme,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        screenBg: screen ? getComputedStyle(screen).backgroundColor : null,
      };
    })()`);

    // 硬重载到深色。
    // ⚠️ cache-buster 必须放在**真实查询串**里（`/?__r=...#/shells`），
    //    放到 hash 里（`#/shells?__r=...`）不触发文档重新加载 —— 同源仅 hash 变化
    //    不会重载文档、`initTheme()` 的模块级 `initialized` 开关不会重跑（M4 教训 2）。
    await cdp.eval("localStorage.setItem('theme','dark'); true");
    await open(`/?__r=${Date.now()}#/shells`);
    await cdp.eval(HELPERS);
    const darkProbe = await cdp.eval(`(() => {
      const screen = window.__T5.q('[data-testid="shells-screen"]');
      return {
        theme: document.documentElement.dataset.theme,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        screenBg: screen ? getComputedStyle(screen).backgroundColor : null,
        // 深色下正文对比度：取标签文字与卡片说明
        labelContrasts: window.__T5.qa('[data-testid="shell-preview-label"]').map((el) => {
          const spans = [...el.querySelectorAll('span')];
          return spans.map((s) => ({ text: (s.textContent || '').slice(0, 12), contrast: window.__T5.contrast(s) }));
        }),
        hints: window.__T5.qa('[data-testid="shells-mode-hint"] span').map((s) => window.__T5.contrast(s)),
      };
    })()`);

    /*
     * 对比度**分层口径**（沿用 M4 定稿，不另立标准，见 m4-acceptance.mjs 头注）：
     * - 卡片显示名（每张 label 的第 0 个 span，`text-text-primary`）→ 正文，门槛 4.5
     * - os 值徽标 / 说明文字（第 1、2 个 span，`text-text-tertiary`）→ 辅助文字，门槛 3
     * M4 已实测并留有留档：`--text-tertiary` 浅 #8A919E / 深 #6E7380 是设计稿第 7 轮定稿值，
     * 属「辅助文字 ≥3」档。早期版本对所有文字套 4.5，等于要求改设计稿颜色 —— 越界。
     */
    const bodySpans = darkProbe.labelContrasts.map((spans) => spans[0]);
    const auxSpans = darkProbe.labelContrasts.flatMap((spans) => spans.slice(1));
    const isDarkBg = (c) => {
      if (!c) return false;
      const m = c.match(/\d+/g);
      if (!m) return false;
      return Number(m[0]) < 80 && Number(m[1]) < 80 && Number(m[2]) < 80;
    };
    assert("5-4 06 屏深浅两模式（深色无大面积白底、对比度分层达标）", {
      浅色主题为light: lightProbe.theme === "light",
      深色主题为dark: darkProbe.theme === "dark",
      浅色屏底为亮色: lightProbe.screenBg === "rgb(255, 255, 255)",
      深色屏底非亮色: isDarkBg(darkProbe.screenBg),
      深色正文对比度达4_5: bodySpans.length > 0 && bodySpans.every((c) => c.contrast >= 4.5),
      深色辅助文字对比度达3: auxSpans.length > 0 && auxSpans.every((c) => c.contrast >= 3),
      深色提示条文字对比度达3: darkProbe.hints.length > 0 && darkProbe.hints.every((c) => c >= 3),
    });
    record("5-4_06屏深浅模式原始观测", { lightProbe, darkProbe });

    // 复位主题
    await cdp.eval("localStorage.removeItem('theme'); true");

    /* ================= 5. 交互三态（hover / active / 焦点环） ================= */
    await open("/#/shells");
    await cdp.eval(HELPERS);
    const interactive = await cdp.eval(`(() => {
      // 抽查 >=5 个可点击元素。
      // 用 sidebar-history-item-1（非激活项）而不是 -0：-0 是当前激活项，
      // 它的样式走 bg-active 分支、不再需要 hover/active 反馈 —— 拿激活项去查
      // 「有没有 hover/active」会得到假阴性（本轮踩过）。
      const sels = [
        '[data-testid="titlebar-toggle-sidebar"]',
        '[data-testid="titlebar-toggle-theme"]',
        '[data-testid="titlebar-toggle-preview"]',
        '[data-testid="sidebar-new-task"]',
        '[data-testid="sidebar-history-item-1"]',
        '[data-testid="sidebar-change-directory"]',
        '[data-testid="sidebar-search"]',
        '[data-testid="screen-back"]',
      ];
      const els = sels.map((s) => window.__T5.q(s)).filter(Boolean);
      return els.map((el) => {
        const cs = getComputedStyle(el);
        return {
          testid: el.dataset.testid,
          bg: cs.backgroundColor,
          color: cs.color,
          // hover/active 是 Tailwind 变体类，运行时读不到计算值，只能查 className
          hasHover: /hover:bg-|hover:text-/.test(el.className),
          hasActive: /active:bg-|active:text-/.test(el.className),
          hasTransition: /transition/.test(cs.transitionProperty) || cs.transitionDuration !== "0s",
          ariaLabel: el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').trim().slice(0, 12),
        };
      });
    })()`);

    assert("5-5 hover / active 三态齐全（抽查 ≥5 个可点击元素）", {
      抽查数量不少于5: interactive.length >= 5,
      全部有hover声明: interactive.every((e) => e.hasHover),
      全部有active声明: interactive.every((e) => e.hasActive),
      全部有过渡声明: interactive.every((e) => e.hasTransition),
      全部有可读名称: interactive.every((e) => (e.ariaLabel || "").length > 0),
    });
    record("5-5_交互元素三态抽查", interactive);

    /* ================= 5b. 焦点环（含 Composer textarea 修复点） ================= */
    // 用真实键盘 Tab 遍历，读 :focus-visible 命中元素的 outlineWidth
    // （直接 focus() 只命中 :focus，不命中 :focus-visible，因此必须走 CDP 键盘事件）
    await cdp.eval("document.body.focus(); true");
    const focusSamples = [];
    for (let i = 0; i < 14; i++) {
      await cdp.pressKey({ key: "Tab", code: "Tab", virtualKeyCode: 9 });
      await sleep(60);
      const sample = await cdp.eval(`(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        return {
          testid: el.dataset.testid || el.tagName.toLowerCase(),
          outlineWidth: cs.outlineWidth,
          outlineStyle: cs.outlineStyle,
          outlineColor: cs.outlineColor,
          matchesFocusVisible: el.matches(':focus-visible'),
          className: (el.className || '').toString().slice(0, 80),
        };
      })()`);
      if (sample) focusSamples.push(sample);
    }

    const fvSamples = focusSamples.filter((s) => s.matchesFocusVisible);
    assert("5-6 焦点环可见（纯键盘 Tab，:focus-visible 下 outlineWidth 非 0）", {
      采样到可聚焦元素: focusSamples.length >= 5,
      命中focus_visible: fvSamples.length >= 3,
      全部命中项outlineWidth非0: fvSamples.every((s) => parseFloat(s.outlineWidth) > 0),
      全部命中项outlineStyle非none: fvSamples.every((s) => s.outlineStyle !== "none"),
    });
    record("5-6_键盘Tab焦点环采样", focusSamples);

    // 专门验证 Composer textarea（本轮修复了点：去掉 outline-none）
    await open("/");
    await cdp.eval(HELPERS);
    const composerFocus = await cdp.eval(`(() => {
      const ta = window.__T5.q('[data-testid="composer-input"]');
      if (!ta) return null;
      return { 存在: true, className: ta.className, hasOutlineNone: /outline-none/.test(ta.className) };
    })()`);
    assert("5-6b Composer 输入框未被 outline-none 覆盖焦点环", {
      输入框存在: !!composerFocus && composerFocus.存在,
      类名不含outline_none: !!composerFocus && !composerFocus.hasOutlineNone,
    });
    record("5-6b_Composer焦点环检查", composerFocus);

    /* ================= 6. 空状态（?empty=1） ================= */
    await open("/?empty=1");
    await cdp.eval(HELPERS);
    const emptyState = await cdp.eval(`(() => {
      const empty = window.__T5.q('[data-testid="empty-state"]');
      const list = window.__T5.q('[data-testid="message-list"]');
      const r = empty ? empty.getBoundingClientRect() : null;
      return {
        emptyState存在: !!empty,
        emptyHeight: r ? +r.height.toFixed(2) : 0,
        list存在: !!list,
        listTotalCount: list ? list.dataset.totalCount : null,
        listHeight: list ? +list.getBoundingClientRect().height.toFixed(2) : 0,
        hScroll: window.__T5.hScroll(),
      };
    })()`);
    assert("5-7 空状态不塌陷（?empty=1 占位存在且高度 > 0）", {
      empty_state存在: emptyState.emptyState存在,
      占位高度大于0: emptyState.emptyHeight > 0,
      message_list存在: emptyState.list存在,
      totalCount为0: emptyState.listTotalCount === "0",
      列表未塌陷: emptyState.listHeight > 0,
      无横向滚动: emptyState.hScroll.scrollWidth <= emptyState.hScroll.clientWidth + 1,
    });
    record("5-7_空状态原始观测", emptyState);

    /* ================= 7. 长文本（省略后不横向溢出） ================= */
    await open("/#/shells");
    await cdp.eval(HELPERS);
    const longText = await cdp.eval(`(() => {
      // title 可能在截断元素自身，也可能在其最近的按钮/容器祖先上
      //（如 Sidebar 的 MenuItem 把 title 挂在 button 上、truncate 在内部 span 上）。
      const findTitle = (el) => {
        let n = el;
        while (n && n !== document.body) {
          const t = n.getAttribute && n.getAttribute('title');
          if (t) return t;
          n = n.parentElement;
        }
        return null;
      };
      const check = (el, name) => ({
        name,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        有省略: el.scrollWidth <= el.clientWidth,
        title: findTitle(el),
        hasTitle: !!findTitle(el),
      });
      const results = [];
      // 侧边栏历史会话标题（truncate + title）
      const hist = window.__T5.q('[data-testid="sidebar-history-item-0"] span:last-child');
      if (hist) results.push(check(hist, 'sidebar-history-title'));
      // 侧边栏工作目录（truncate + title）
      const wd = window.__T5.q('[data-testid="sidebar-working-directory"] span:last-child');
      if (wd) results.push(check(wd, 'sidebar-working-directory'));
      // 06 屏卡片说明文字（truncate + title）
      const note = window.__T5.q('[data-testid="shell-preview-label"] span:last-child');
      if (note) results.push(check(note, 'shell-preview-label-note'));
      // 标题栏会话标题（truncate + title，M5 新增 testid=titlebar-title）
      const title = window.__T5.q('[data-testid="titlebar-title"]');
      if (title) results.push(check(title, 'titlebar-session-title'));
      return { results, hScroll: window.__T5.hScroll() };
    })()`);

    assert("5-8 长文本有省略策略且不横向溢出", {
      采样到不少于3处文本: longText.results.length >= 3,
      全部无横向溢出: longText.results.every((r) => r.有省略),
      省略项均有title全称: longText.results.every((r) => r.hasTitle),
      屏无横向滚动: longText.hScroll.scrollWidth <= longText.hScroll.clientWidth + 1,
    });
    record("5-8_长文本省略策略", longText);

    /* ================= 8. 全局硬约束静态扫描 ================= */
    assert("G1 颜色来源唯一（hex 仅 tokens.css）", { G1: staticResult.G1_hex仅tokens });
    assert("G2 无 dark: 变体补丁", { G2: staticResult.G2_无dark变体 });
    assert("G5 不使用 Tailwind 内置调色板", { G5: staticResult.G5_无内置调色板 });
    assert("尺寸唯一来源：M5 新增文件无硬编码尺寸", {
      M5新增文件无硬编码尺寸: sizeResult.M5新增文件无硬编码尺寸,
    });
    record("静态扫描详情", { staticResult, sizeResult });

    /* ================= 附：折叠时长改动回归提示 ================= */
    record("8_1-10回归提示", {
      说明: "COLLAPSE_DURATION_REDUCED 已 90→120ms；本脚本不重复跑 accept:m1，请单独执行 npm run accept:m1",
      COLLAPSE_DURATION: 180,
      COLLAPSE_DURATION_REDUCED: 120,
    });

    const summary = ctx.save(EVIDENCE);
    process.exitCode = summary.failed > 0 ? 1 : 0;
  });
}

main().catch((err) => {
  console.error("M5 自查脚本失败:", err);
  process.exit(1);
});
