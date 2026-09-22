/**
 * M5 验收脚本 —— 由**主控（非实现方）**编写。这是项目铁律（M2 定下）：
 * 验收脚本必须由非实现方写，执行方的 `m5-selfcheck.mjs` 只是自查留痕。
 *
 * 覆盖：5-1 ~ 5-9（含 G1~G8）+ 三端内容区零位移（5-2，本里程碑核心）+ 既有遗留裁决复核。
 *
 * 用法：
 *   1. 先在 packages/ui 起 dev server（端口 5180）
 *   2. node scripts/m5-acceptance.mjs
 *   （M5_ORIGIN / M5_CDP_PORT 可覆盖；CDP 端口 9343，避开 m1=9333 / m2=9337 / m3=9341 / m4=9342）
 *
 * ── 为什么坐标一律读 offsetLeft / offsetTop，绝不读 getBoundingClientRect ──
 * 06 屏缩略窗口用 `transform: scale(0.42)`。`rect` 会被 transform 缩放，
 * 三端之间哪怕有亚像素差异也会被放大成「看起来不一致」的假失败；
 * 而 `offsetLeft/offsetTop` 是**布局坐标**，不受 transform 影响，正是 5-2 要的口径。
 *
 * ── 对比度分层口径（沿用 M4 定稿，不另立标准）──
 * 按**计算后文字颜色**分层：正文（text-primary / secondary）≥4.5，辅助（text-tertiary 及其继承者）≥3。
 * 排除 svg / svg * / aria-hidden 节点（G4 图标是刻意固定的非文字色）。
 * 理由：`--text-tertiary` 是设计稿第 7 轮定稿值且有留档，属 G3「辅助文字 ≥3」档。
 * 详见 `m4-acceptance.mjs` 头部注释与 `.plan/progress-M4.md` 第 11.5 节。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { withBrowser, sleep } from "./cdp.mjs";

const ORIGIN = process.env.M5_ORIGIN ?? "http://127.0.0.1:5180";
const PORT = Number(process.env.M5_CDP_PORT ?? 9343);
const PKG_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const EVIDENCE = "_m5-acceptance-evidence.json";

/** 三端 os 的期望集合 */
const OS_SET = ["linux", "mac", "win"];

/** 对比度门槛（分层口径，见头注） */
const BODY_TEXT_MIN = 4.5;
const AUX_TEXT_MIN = 3;

/** 页面侧工具（与 m4-acceptance 同口径 + offset 坐标读取） */
const HELPERS = `
window.__TM5 = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  /** 布局坐标：不受 transform: scale() 影响（5-2 的唯一可信口径） */
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
    const a = window.__TM5.lum(getComputedStyle(el).color);
    const b = window.__TM5.lum(window.__TM5.effBg(el));
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return +(((hi + 0.05) / (lo + 0.05)).toFixed(2));
  },
  hScroll: () => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }),
  /** 主题 tertiary 的计算色，用于对比度分层（M4 口径） */
  tertiaryRgb: () => {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--text-tertiary').trim();
    const d = document.createElement('div');
    d.style.color = v;
    document.body.appendChild(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  },
};
true;
`;

/** G1 / G2 / G5 静态扫描（主控独立口径，与 m2/m3/m4 一致） */
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

  const hexOutsideTokens = [];
  const darkVariantHits = [];
  const paletteHits = [];
  const PALETTE =
    /\b(?:bg|text|border|ring|from|to)-(?:gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)\b|\b(?:bg|text)-(?:black|white)\b/g;

  for (const file of files) {
    const rel = relative(SRC, file).replace(/\\/g, "/");
    const text = readFileSync(file, "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      const hexes = line.match(/#[0-9a-fA-F]{3,8}\b/g);
      if (hexes && rel !== "styles/tokens.css") {
        hexOutsideTokens.push({ file: rel, line: i + 1, hits: hexes });
      }
      const darkVariants = line.match(/(?:^|[\s"'`])dark:[a-z[]/g);
      if (darkVariants) darkVariantHits.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 100) });
      const pal = line.match(PALETTE);
      if (pal) paletteHits.push({ file: rel, line: i + 1, hits: pal });
    });
  }

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
 * M5 新增/修改文件里的硬编码尺寸扫描。
 * 口径（M4 定稿）：只看对象字面量里的 width/minWidth/maxWidth/height/minHeight/maxHeight
 * 的数字字面量，排除 <=1 的发丝线。**不把 gap / padding 算作「布局尺寸」**——
 * M4 首轮就误把 `gap: 12` 算进去导致假失败（progress-M4 §11.2 第 1 条）。
 */
function hardcodedSizeScan() {
  const TARGETS = [
    "components/screens/ShellPreview.tsx",
    "screens/ShellsScreen.tsx",
    "mock/shells.ts",
    "components/shell/WorkbenchScreen.tsx",
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
      const m = line.match(/\b(width|minWidth|maxWidth|height|minHeight|maxHeight)\s*:\s*(\d+(?:\.\d+)?)/g);
      if (!m) return;
      for (const item of m) {
        const num = parseFloat(item.split(":")[1]);
        if (num > 1) hits.push({ file: rel, line: i + 1, code: item });
      }
    });
  }
  return { 扫描文件: TARGETS, 命中: hits, M5文件无硬编码尺寸: hits.length === 0 };
}

await withBrowser({ port: PORT, origin: ORIGIN, evidencePath: EVIDENCE }, async (ctx) => {
  const { cdp, open, record, assert } = ctx;
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HELPERS });

  /* ================================================================ 静态检查 */
  const stat = staticColorChecks();
  const sizeResult = hardcodedSizeScan();
  ctx.record("G1_G2_G5_静态颜色检查", stat);
  ctx.assert("G1 颜色来源唯一（hex 仅 tokens.css）", {
    通过: stat.G1_hex仅tokens,
    越界数: stat.hex在tokens之外.length,
  });
  ctx.assert("G2 无 dark: 变体补丁", {
    通过: stat.G2_无dark变体,
    命中数为0: stat.dark变体命中.length === 0,
  });
  ctx.assert("G5 不用 Tailwind 内置调色板", {
    通过: stat.G5_无内置调色板,
    命中数为0: stat.内置调色板命中.length === 0,
  });
  ctx.record("M5_硬编码尺寸扫描", sizeResult);
  ctx.assert("M5 新增/改动文件无硬编码布局尺寸（尺寸走 layout.ts）", {
    无裸尺寸: sizeResult.M5文件无硬编码尺寸,
    命中数: sizeResult.命中.length,
  });

  /* ================================================================ 5-1 三端并存（并排） */
  await open("/#/shells");
  await cdp.eval(HELPERS);
  await sleep(600);

  const grid = await cdp.eval(`(() => {
    const previews = window.__TM5.qa('[data-testid="shell-preview"]');
    const osList = previews.map((el) => el.dataset.os);
    const labels = window.__TM5.qa('[data-testid="shell-preview-label"]').map((el) => el.dataset.os);
    const probes = window.__TM5.qa('[data-testid="shell-content-probe"]');
    // ⚠️ 06 屏自身的 WindowShell 也带 data-testid="window-shell"，
    //    所以必须**限定在每张卡片内**数壳实例，否则会数出 4 个（3 卡 + 屏自身）。
    const framesPerCard = previews.map((p) => p.querySelectorAll('[data-testid="window-shell"]').length);
    const cardsWithOs = previews.map((p) => {
      const frame = p.querySelector('[data-testid="window-shell"]');
      return { card: p.dataset.os, frame: frame ? frame.dataset.os : null };
    });
    const hint = window.__TM5.q('[data-testid="shells-mode-hint"]');
    return {
      screenExists: !!window.__TM5.q('[data-testid="shells-screen"]'),
      previewCount: previews.length,
      osList,
      osUnique: [...new Set(osList)].length,
      labelCount: labels.length,
      labelOs: labels,
      probeCount: probes.length,
      framesPerCard,
      cardsWithOs,
      mode: hint ? hint.dataset.mode : null,
      hScroll: window.__TM5.hScroll(),
    };
  })()`);

  ctx.record("5-1_并排模式原始观测", grid);
  ctx.assert("5-1 三端壳并存：mac / win / linux 三种表现均呈现", {
    屏存在: grid.screenExists === true,
    恰好三张卡片: grid.previewCount === 3,
    os集合为mac_win_linux: JSON.stringify([...grid.osList].sort()) === JSON.stringify(OS_SET),
    os三者互不相同: grid.osUnique === 3,
    三张标签齐全: grid.labelCount === 3 && JSON.stringify([...grid.labelOs].sort()) === JSON.stringify(OS_SET),
    每卡恰一个窗口壳: grid.framesPerCard.length === 3 && grid.framesPerCard.every((n) => n === 1),
    卡片os与壳os一致: grid.cardsWithOs.every((c) => c.card === c.frame),
    模式为grid: grid.mode === "grid",
  });

  /* ================================================================ 5-2 内容区零位移（核心） */
  // 2a. 并排模式：三卡内探针的布局坐标必须完全一致
  const gridOffsets = await cdp.eval(`(() => {
    return window.__TM5.qa('[data-testid="shell-content-probe"]').map((p) => ({
      os: p.dataset.os,
      ...window.__TM5.off(p),
      parent: p.offsetParent ? (p.offsetParent.tagName.toLowerCase() + (p.offsetParent.dataset.testid ? '[' + p.offsetParent.dataset.testid + ']' : '')) : null,
    }));
  })()`);
  ctx.record("5-2a_并排三端实际布局坐标", gridOffsets);
  ctx.assert("5-2a 内容区零位移（并排三卡）：三端布局坐标完全一致", {
    三端齐全: gridOffsets.length === 3,
    offsetLeft三端一致: new Set(gridOffsets.map((o) => o.offsetLeft)).size === 1,
    offsetTop三端一致: new Set(gridOffsets.map((o) => o.offsetTop)).size === 1,
    // 并排模式下探针的 offsetParent 是缩放内层，因此 offsetTop 应等于标题栏高 36
    offsetTop等于标题栏高36: gridOffsets.every((o) => o.offsetTop === 36),
    offsetLeft全为0: gridOffsets.every((o) => o.offsetLeft === 0),
  });

  // 2b. 单壳全尺寸模式：逐端切 os，坐标必须完全一致
  const singles = [];
  for (const os of ["mac", "win", "linux"]) {
    await open(`/#/shells?os=${os}`);
    await cdp.eval(HELPERS);
    await sleep(450);
    const one = await cdp.eval(`(() => {
      const single = window.__TM5.q('[data-testid="shell-single"]');
      const probe = window.__TM5.q('[data-testid="shell-content-probe"]');
      const hint = window.__TM5.q('[data-testid="shells-mode-hint"]');
      const frame = single ? single.querySelector('[data-testid="window-shell"]') : null;
      /*
       * 三端标题栏形态差异的直接证据（5-1 的「表现均呈现」要靠它落地）：
       * - mac：交通灯在左 → 标题栏第一个子元素是含 3 个圆点的容器
       * - win：控件在右且关闭键染危险色
       * - linux：控件在右、三键同色
       */
      const tb = frame ? frame.querySelector('div') : null;
      const controls = tb ? tb.children[0] : null;
      return {
        singleExists: !!single,
        singleOs: single ? single.dataset.os : null,
        probeOs: probe ? probe.dataset.os : null,
        offset: probe ? window.__TM5.off(probe) : null,
        frameOs: frame ? frame.dataset.os : null,
        frameCount: single ? single.querySelectorAll('[data-testid="window-shell"]').length : 0,
        mode: hint ? hint.dataset.mode : null,
        // 标题栏高度：三端必须一致（否则内容区必位移）
        titleBarHeight: tb ? +tb.getBoundingClientRect().height.toFixed(2) : null,
        // 首个子元素的形态线索（mac 应为圆点组，win/linux 为控件组）
        firstChildDots: controls ? controls.querySelectorAll('span.rounded-full').length : null,
      };
    })()`);
    singles.push({ os, ...one });
    await sleep(200);
  }
  ctx.record("5-2b_单壳逐端原始观测", singles);

  const sOff = singles.map((s) => s.offset).filter(Boolean);
  ctx.assert("5-2b 内容区零位移（单壳全尺寸）：三端布局坐标完全一致", {
    三次请求均得探针: singles.length === 3 && singles.every((s) => s.offset !== null),
    每端shellSingle存在且os匹配: singles.every((s) => s.singleExists && s.singleOs === s.os),
    每端探针os匹配: singles.every((s) => s.probeOs === s.os),
    每端壳os匹配: singles.every((s) => s.frameOs === s.os),
    每端恰一个壳实例: singles.every((s) => s.frameCount === 1),
    模式均为single: singles.every((s) => s.mode === "single"),
    // ⚠️ 只断言三端一致，不断言绝对值 —— 单壳下 offsetParent 是内容区三栏容器，
    //    绝对值会含样式层偏移（屏自身也有标题栏），数值本身不具跨屏可比性。
    offsetLeft三端一致: sOff.length === 3 && new Set(sOff.map((o) => o.offsetLeft)).size === 1,
    offsetTop三端一致: sOff.length === 3 && new Set(sOff.map((o) => o.offsetTop)).size === 1,
    三端标题栏高度一致: new Set(singles.map((s) => s.titleBarHeight)).size === 1,
    三端标题栏高为36: singles.every((s) => s.titleBarHeight === 36),
  });

  // 2c. 三端标题栏形态差异真的存在（5-1 的「表现均呈现」）
  const macDots = singles.find((s) => s.os === "mac");
  const winDots = singles.find((s) => s.os === "win");
  ctx.assert("5-1b 三端壳的形态差异真的呈现（mac 交通灯 3 圆点，win/linux 为控件）", {
    mac有3个圆点: macDots && macDots.firstChildDots === 3,
    win无圆点: winDots && winDots.firstChildDots === 0,
  });

  // 2d. 并排模式三卡尺寸一致（缩放口径统一，否则坐标没有可比性）
  await open("/#/shells");
  await cdp.eval(HELPERS);
  await sleep(500);
  const gridSizes = await cdp.eval(`(() => {
    return window.__TM5.qa('[data-testid="shell-preview"]').map((p) => {
      const r = p.getBoundingClientRect();
      return { os: p.dataset.os, w: +r.width.toFixed(2), h: +r.height.toFixed(2) };
    });
  })()`);
  ctx.record("5-2c_并排三卡尺寸", gridSizes);
  ctx.assert("5-2c 并排三卡尺寸一致（缩放口径统一，坐标才有可比性）", {
    三卡宽度一致: new Set(gridSizes.map((s) => s.w)).size === 1,
    三卡高度一致: new Set(gridSizes.map((s) => s.h)).size === 1,
  });

  /* ================================================================ 5-3 06 屏无横向滚动 */
  const gridScroll = await cdp.eval("window.__TM5.hScroll()");
  ctx.record("5-3_06屏并排横向滚动", gridScroll);
  ctx.assert("5-3 06 屏缩放视图不产生横向滚动（G6）", {
    scrollWidth不超clientWidth加1: gridScroll.scrollWidth <= gridScroll.clientWidth + 1,
  });

  await open("/#/shells?os=win");
  await cdp.eval(HELPERS);
  await sleep(450);
  const singleScroll = await cdp.eval("window.__TM5.hScroll()");
  ctx.record("5-3b_06屏单壳横向滚动", singleScroll);
  ctx.assert("5-3b 06 屏单壳视图不产生横向滚动", {
    scrollWidth不超clientWidth加1: singleScroll.scrollWidth <= singleScroll.clientWidth + 1,
  });

  /* ================================================================ 5-9 全局硬约束 G6/G4 走查（8 屏） */
  /*
   * ⚠️ ready 选择器要按屏给：00 屏（TokensScreen）是独立体检页，
   * **不渲染 WindowShell**（无三栏），默认的 `window-shell` 等待会直接超时 ——
   * 第一轮就是在这里崩的（探针缺陷，非产品缺陷）。00 屏改等它自己的 `<main>`。
   */
  const allRoutes = [
    { name: "01 工作台", url: "/", ready: null },
    { name: "00 令牌", url: "/#/tokens", ready: "main" },
    { name: "01b 源码态", url: "/?preview=code", ready: null },
    { name: "03 运行详情", url: "/#/run-detail", ready: null },
    { name: "04 技能与工具", url: "/#/skills", ready: null },
    { name: "05 设置", url: "/#/settings", ready: null },
    { name: "06 窗口壳", url: "/#/shells", ready: null },
  ];
  const routeChecks = [];
  for (const route of allRoutes) {
    await open(route.url, route.ready ?? undefined);
    await cdp.eval(HELPERS);
    await sleep(500);
    const r = await cdp.eval(`(() => {
      // G4：图标中性色是否出现（浅色下应恒为 rgb(138,145,158)）
      const svgs = [...document.querySelectorAll('svg')].slice(0, 400);
      const strokes = new Set();
      for (const s of svgs) {
        const cs = getComputedStyle(s);
        if (cs.stroke && cs.stroke !== 'none') strokes.add(cs.stroke);
      }
      return {
        hScroll: window.__TM5.hScroll(),
        hasNeutralIcon: strokes.has('rgb(138, 145, 158)'),
        strokeSamples: [...strokes].slice(0, 12),
      };
    })()`);
    routeChecks.push({ route: route.name, ...r });
    await sleep(150);
  }
  ctx.record("5-9_八屏横向滚动与图标色走查", routeChecks);
  ctx.assert("5-9a 全部屏（含 06）无横向滚动（G6）", {
    所有屏都测了: routeChecks.length === 7,
    每屏scrollWidth不超clientWidth: routeChecks.every((r) => r.hScroll.scrollWidth <= r.hScroll.clientWidth + 1),
    各屏溢出量: routeChecks.map((r) => `${r.route}: ${r.hScroll.scrollWidth - r.hScroll.clientWidth}`),
  });
  ctx.assert("5-9b 各屏可见中性图标色 rgb(138,145,158)（G4）", {
    所有屏都测了: routeChecks.length === 7,
    每屏都含中性图标色: routeChecks.every((r) => r.hasNeutralIcon),
  });

  /* ================================================================ 5-4 深色模式（06 屏 + 全屏正文对比度） */
  /*
   * 深色 URL 的构造：cache-buster 必须放在**真实查询串**里 —— 同源仅 hash 变化
   * 不会重载文档，模块级 initTheme() 的 initialized 开关不会重跑（M4 教训 2）。
   * 三种形态分别拼：
   * - "/#/xxx"  → "/?__r=T#/xxx"（hash 原样跟在真实查询串后）
   * - "/?p=v"   → "/?__r=T&p=v"（参数并入真实查询串；第一轮把 01b 的 preview=code 丢了 —— 探针缺陷）
   * - "/"       → "/?__r=T/"（尾斜杠并入 __r 值，无害）
   */
  const darkUrl = (u, ts) =>
    u.startsWith("/#") ? `/?__r=${ts}${u}` : u === "/" ? `/?__r=${ts}/` : `/?__r=${ts}&${u.slice(2)}`;
  const darkChecks = [];
  for (const route of allRoutes) {
    await cdp.eval("localStorage.setItem('theme','dark'); true");
    await open(darkUrl(route.url, Date.now()), route.ready ?? undefined);
    await cdp.eval(HELPERS);
    await sleep(550);
    const r = await cdp.eval(`(() => {
      const auxRgb = window.__TM5.tertiaryRgb();
      const isIconish = (el) => !!el.closest('svg') || el.getAttribute('aria-hidden') === 'true' || !!el.closest('[aria-hidden="true"]');
      /*
       * ★ 颜色字面量是「被展示的令牌值」，不是 UI 文案（M5 主控复核裁决，见 diff Note-1）：
       *   00 屏色板预览块刻意把令牌原始值（#hex 与 rgba()/rgb() 等）渲染在**对侧主题的固定底色**上
       *   （TokensScreen.tsx:198-209，如 --bg-hover 的展示值 rgba(0,0,0,0.045)），
       *   色块标签的颜色就是色值本身，对比度天然参差 —— 这是数据可视化的本意，不是正文缺陷。
       *   探针把它从正文分类里排除，但要**计数并断言它只出现在 00 屏**，
       *   防止这个排除把真正的 UI 文案也吞掉。
       */
      // 注意：本探针整体在 cdp.eval 的模板字符串里 —— 正则的反斜杠必须双写（\\( \\s），
      // 否则模板字面量先吞一层转义，浏览器里拿到的正则就是坏的（本轮实踩：\\s 变 s 导致 rgba 排除失效）。
      const TOKEN_VALUE_LIT = /^(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\\(\\s*[\\d.,%\\s]+\\))$/;
      const readings = [];
      let bright = 0;
      let tokenValues = 0;
      for (const el of [...document.querySelectorAll('*')].slice(0, 900)) {
        const bg = getComputedStyle(el).backgroundColor;
        const m = bg.match(/rgba?\\(([^)]+)\\)/);
        if (m) {
          const p = m[1].split(',').map(Number);
          const opaque = p.length < 4 || p[3] > 0.5;
          if (opaque) {
            const l = window.__TM5.lum(bg);
            const rect = el.getBoundingClientRect();
            if (l > 0.9 && rect.width > 200 && rect.height > 60) bright++;
          }
        }
        if (el.children.length > 0) continue;
        if (isIconish(el)) continue;
        const txt = (el.textContent || '').trim();
        if (txt.length < 2 || !/[\\p{L}\\p{N}]/u.test(txt)) continue;
        if (TOKEN_VALUE_LIT.test(txt)) { tokenValues++; continue; }
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        readings.push({ t: txt.slice(0, 20), c: window.__TM5.contrast(el), color: getComputedStyle(el).color });
      }
      readings.sort((a, b) => a.c - b.c);
      const bodyR = readings.filter((r) => r.color !== auxRgb);
      const auxR = readings.filter((r) => r.color === auxRgb);
      return {
        theme: document.documentElement.dataset.theme,
        brightBlocks: bright,
        measured: readings.length,
        tokenValuesExcluded: tokenValues,
        bodyMin: bodyR.length ? bodyR[0].c : null,
        bodyMinSample: bodyR.length ? bodyR[0] : null,
        auxMin: auxR.length ? auxR[0].c : null,
        auxCount: auxR.length,
        minText: readings.length ? readings[0].c : null,
        hScroll: window.__TM5.hScroll(),
      };
    })()`);
    darkChecks.push({ route: route.name, ...r });
    await sleep(150);
  }
  await cdp.eval("localStorage.setItem('theme','light'); true");

  ctx.record("5-4_深色七屏走查", darkChecks);
  ctx.assert(
    `5-4 深色下全部屏无大面积白底；正文对比度 >= ${BODY_TEXT_MIN}、辅助文字 >= ${AUX_TEXT_MIN}（分层口径同 M4；颜色字面量令牌展示值除外）`,
    {
      七屏都测了: darkChecks.length === 7,
      深色确实生效: darkChecks.every((r) => r.theme === "dark"),
      无大面积浅底: darkChecks.every((r) => r.brightBlocks === 0),
      每屏量到文字节点: darkChecks.every((r) => r.measured > 20),
      // 令牌展示值（颜色字面量）只允许出现在 00 屏（色板预览块）—— 防止排除规则吞掉真正的 UI 文案
      令牌展示值仅出现在00屏: darkChecks.every((r) => r.route === "00 令牌" || r.tokenValuesExcluded === 0),
      "00屏确实排除了令牌展示值": (darkChecks.find((r) => r.route === "00 令牌")?.tokenValuesExcluded ?? 0) > 0,
      正文对比度达标: darkChecks.every((r) => r.bodyMin !== null && r.bodyMin >= BODY_TEXT_MIN),
      辅助文字对比度达标: darkChecks.every((r) => r.auxMin === null || r.auxMin >= AUX_TEXT_MIN),
      深色下仍无横向滚动: darkChecks.every((r) => r.hScroll.scrollWidth <= r.hScroll.clientWidth + 1),
      各屏正文最低对比度: darkChecks.map((r) => `${r.route}: ${r.bodyMin}`),
      各屏正文最低样本: darkChecks.map((r) => (r.bodyMinSample ? `${r.route}: "${r.bodyMinSample.t}"` : `${r.route}: -`)),
      各屏辅助最低对比度: darkChecks.map((r) => `${r.route}: ${r.auxMin} (${r.auxCount} 处)`),
      各屏排除的令牌展示值数: darkChecks.map((r) => `${r.route}: ${r.tokenValuesExcluded}`),
    },
  );

  /* ================================================================ 5-5 hover / active 齐全 */
  await open("/#/shells");
  await cdp.eval(HELPERS);
  await sleep(500);
  const interactive = await cdp.eval(`(() => {
    /*
     * 抽查 >=5 个**非激活**可点击元素。
     * ⚠️ 不要拿激活项（如 sidebar-history-item-0）去查：
     *    它的样式走 bg-active 分支、本就不需要 hover/active 反馈 —— 会得到假阴性（本轮踩过）。
     */
    const sels = [
      '[data-testid="titlebar-toggle-sidebar"]',
      '[data-testid="titlebar-toggle-theme"]',
      '[data-testid="titlebar-toggle-preview"]',
      '[data-testid="sidebar-new-task"]',
      '[data-testid="sidebar-history-item-1"]',
      '[data-testid="sidebar-history-item-2"]',
      '[data-testid="sidebar-change-directory"]',
      '[data-testid="screen-back"]',
    ];
    return sels.map((s) => window.__TM5.q(s)).filter(Boolean).map((el) => {
      const cs = getComputedStyle(el);
      const cls = String(el.className);
      return {
        testid: el.dataset.testid,
        hasHover: /hover:(bg|text)-/.test(cls),
        hasActive: /active:(bg|text)-/.test(cls),
        hasTransition: cs.transitionDuration !== '0s' || /transition/.test(cs.transitionProperty),
        name: el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').trim().slice(0, 12),
      };
    });
  })()`);
  ctx.record("5-5_交互元素三态抽查", interactive);
  ctx.assert("5-5 hover / active 状态齐全（抽查 ≥5 个可点击元素）", {
    抽查数量不少于5: interactive.length >= 5,
    全部有hover反馈: interactive.every((e) => e.hasHover),
    全部有active反馈: interactive.every((e) => e.hasActive),
    全部有过渡声明: interactive.every((e) => e.hasTransition),
    全部有可读名称: interactive.every((e) => (e.name || "").length > 0),
  });

  /* ================================================================ 5-6 焦点环可见 */
  // 真实键盘 Tab 遍历（直接 focus() 只命中 :focus，不命中 :focus-visible）
  await cdp.eval("document.body.focus(); true");
  const focusSamples = [];
  for (let i = 0; i < 14; i++) {
    await cdp.pressKey({ key: "Tab", code: "Tab", virtualKeyCode: 9 });
    await sleep(60);
    const s = await cdp.eval(`(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return {
        testid: el.dataset.testid || el.tagName.toLowerCase(),
        outlineWidth: cs.outlineWidth,
        outlineStyle: cs.outlineStyle,
        outlineColor: cs.outlineColor,
        focusVisible: el.matches(':focus-visible'),
      };
    })()`);
    if (s) focusSamples.push(s);
  }
  const fv = focusSamples.filter((s) => s.focusVisible);
  ctx.record("5-6_键盘 Tab 焦点环采样", focusSamples);
  ctx.assert("5-6 焦点环可见（纯键盘 Tab，:focus-visible 下 outlineWidth 非 0）", {
    采样到可聚焦元素: focusSamples.length >= 5,
    命中focus_visible: fv.length >= 3,
    全部命中项outlineWidth非0: fv.length > 0 && fv.every((s) => parseFloat(s.outlineWidth) > 0),
    全部命中项outlineStyle非none: fv.every((s) => s.outlineStyle !== "none"),
  });

  /* ================================================================ 5-7 空状态不塌陷 */
  await open("/?empty=1");
  await cdp.eval(HELPERS);
  await sleep(600);
  const emptyState = await cdp.eval(`(() => {
    const empty = window.__TM5.q('[data-testid="empty-state"]');
    const list = window.__TM5.q('[data-testid="message-list"]');
    return {
      emptyExists: !!empty,
      emptyHeight: empty ? +empty.getBoundingClientRect().height.toFixed(2) : 0,
      emptyText: empty ? (empty.textContent || '').trim().slice(0, 40) : null,
      listExists: !!list,
      totalCount: list ? list.dataset.totalCount : null,
      listHeight: list ? +list.getBoundingClientRect().height.toFixed(2) : 0,
      hScroll: window.__TM5.hScroll(),
    };
  })()`);
  ctx.record("5-7_空状态原始观测", emptyState);
  ctx.assert("5-7 空状态不塌陷（?empty=1 占位存在且高度 > 0）", {
    占位节点存在: emptyState.emptyExists === true,
    占位高度大于0: emptyState.emptyHeight > 0,
    占位有提示文案: (emptyState.emptyText || "").length > 0,
    消息列表存在: emptyState.listExists === true,
    列表总数为0: emptyState.totalCount === "0",
    列表未塌陷: emptyState.listHeight > 0,
    无横向滚动: emptyState.hScroll.scrollWidth <= emptyState.hScroll.clientWidth + 1,
  });

  /* ================================================================ 5-8 长文本有处理 */
  await open("/#/shells");
  await cdp.eval(HELPERS);
  await sleep(550);
  const longText = await cdp.eval(`(() => {
    // title 可能在截断元素自身，也可能在其祖先（Sidebar 的 MenuItem 把 title 挂在 button 上）
    const findTitle = (el) => {
      let n = el;
      while (n && n !== document.body) {
        if (n.getAttribute && n.getAttribute('title')) return n.getAttribute('title');
        n = n.parentElement;
      }
      return null;
    };
    const check = (el, name) => ({
      name,
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
      noOverflow: el.scrollWidth <= el.clientWidth,
      hasTitle: !!findTitle(el),
    });
    const out = [];
    const push = (sel, name) => { const el = window.__TM5.q(sel); if (el) out.push(check(el, name)); };
    push('[data-testid="sidebar-history-item-0"] span:last-child', 'sidebar-history-title');
    push('[data-testid="sidebar-working-directory"] span:last-child', 'sidebar-working-directory');
    push('[data-testid="shell-preview-label"] span:last-child', 'shell-preview-note');
    push('[data-testid="titlebar-title"]', 'titlebar-session-title');
    return { results: out, hScroll: window.__TM5.hScroll() };
  })()`);
  ctx.record("5-8_长文本省略策略", longText);
  ctx.assert("5-8 长文本有省略策略且不横向溢出", {
    采样到不少于3处文本: longText.results.length >= 3,
    全部无横向溢出: longText.results.every((r) => r.noOverflow),
    省略项均可查看全称: longText.results.every((r) => r.hasTitle),
    屏无横向滚动: longText.hScroll.scrollWidth <= longText.hScroll.clientWidth + 1,
  });

  /* ================================================================ 遗留复核 1：折叠时长 120ms 与 1-10 */
  await open("/");
  await cdp.eval(HELPERS);
  await sleep(500);
  const collapse = await cdp.eval(`(() => {
    const sidebar = window.__TM5.q('[data-testid="sidebar"]');
    return {
      sidebarTransition: sidebar ? getComputedStyle(sidebar).transitionDuration : null,
      prefersReduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  })()`);
  ctx.record("遗留_折叠时长观测", collapse);
  ctx.assert("遗留裁决 1：reduced-motion 下折叠时长已改为 120ms（非 90ms / 非瞬间跳变）", {
    // headless Chrome 默认即为 reduce，因此这里应直接读到 0.12s
    折叠时长为012s: collapse.sidebarTransition !== null && collapse.sidebarTransition.startsWith("0.12s"),
    未出现0s或0_001s: collapse.sidebarTransition !== "0s",
  });

  /* ================================================================ 遗留复核 2：Tabs aria 接线 */
  await open("/?preview=code");
  await cdp.eval(HELPERS);
  await sleep(600);
  const tabsAria = await cdp.eval(`(() => {
    const panels = window.__TM5.qa('[role="tabpanel"]');
    const tabs = window.__TM5.qa('[role="tab"]');
    return {
      tabCount: tabs.length,
      panelCount: panels.length,
      panels: panels.map((p) => ({
        id: p.id,
        labelledby: p.getAttribute('aria-labelledby'),
        labelledbyResolves: !!document.getElementById(p.getAttribute('aria-labelledby') || ''),
      })),
      tabsAriaControls: tabs.map((t) => ({
        controls: t.getAttribute('aria-controls'),
        resolves: !!document.getElementById(t.getAttribute('aria-controls') || ''),
        selected: t.getAttribute('aria-selected'),
      })),
      activeTab: (() => {
        const a = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
        return a ? a.dataset.testid || a.id : null;
      })(),
    };
  })()`);
  ctx.record("遗留_Tabs aria 接线观测", tabsAria);
  /*
   * 契约（M5 主控复核裁决）：面板侧必须 id + role=tabpanel + aria-labelledby 全闭环；
   * tab 侧 aria-controls **只允许出现在激活 tab 上** —— 面板是互斥渲染的
   * （M3 3-1a/3-1b 要求未激活面板不在 DOM），非激活 tab 带上它必然是悬空引用。
   */
  ctx.assert("遗留裁决 2：Tab 面板 role=tabpanel + aria-labelledby 闭环；aria-controls 仅激活 tab 持有且可解析（G7）", {
    存在面板: tabsAria.panelCount > 0,
    存在tab: tabsAria.tabCount > 0,
    每个面板有id: tabsAria.panels.every((p) => !!p.id),
    每个面板有aria_labelledby: tabsAria.panels.every((p) => !!p.labelledby),
    aria_labelledby可解析到tab: tabsAria.panels.every((p) => p.labelledbyResolves),
    恰一个激活tab: tabsAria.tabsAriaControls.filter((t) => t.selected === "true").length === 1,
    激活tab带aria_controls: tabsAria.tabsAriaControls.filter((t) => t.selected === "true").every((t) => !!t.controls),
    非激活tab不带aria_controls: tabsAria.tabsAriaControls.filter((t) => t.selected !== "true").every((t) => !t.controls),
    出现的aria_controls均可解析: tabsAria.tabsAriaControls.filter((t) => t.controls).every((t) => t.resolves),
  });

  /* ================================================================ 回归：01 工作台未被 M5 改动破坏 */
  await open("/");
  await cdp.eval(HELPERS);
  await sleep(600);
  const workbench = await cdp.eval(`(() => ({
    previewPane: !!window.__TM5.q('[data-testid="preview-pane"]'),
    messageList: !!window.__TM5.q('[data-testid="message-list"]'),
    composer: !!window.__TM5.q('[data-testid="composer"]'),
    titleBarHeight: (() => { const t = window.__TM5.q('[data-testid="title-bar"]') || window.__TM5.q('[data-testid="window-shell"]')?.children[0]; return t ? +t.getBoundingClientRect().height.toFixed(2) : null; })(),
    hasProbe: !!window.__TM5.q('[data-testid="shell-content-probe"]'),
  }))()`);
  ctx.record("回归_01工作台", workbench);
  ctx.assert("回归：01 工作台未被破坏，且未残留 06 屏专用探针", {
    预览区在: workbench.previewPane === true,
    消息流在: workbench.messageList === true,
    Composer在: workbench.composer === true,
    标题栏高36: workbench.titleBarHeight === 36,
    无06屏探针残留: workbench.hasProbe === false,
  });

  const summary = ctx.save(EVIDENCE);
  process.exitCode = summary.failed > 0 ? 1 : 0;
});
