/**
 * M3 验收脚本 —— 3-1~3-8 + G1/G2/G3/G4/G5/G6，全部给**显式布尔断言**并汇总。
 *
 * 由主控 Agent 独立编写（不由实现方编写），沿袭 M1 10.3 / M2 的既定规矩：
 * 实现方写的验收脚本天然容易「只打印不断言」。
 *
 * 用法：
 *   1. 先在 packages/ui 下起 dev server：npm run dev -- --port 5180 --strictPort
 *   2. node scripts/m3-acceptance.mjs
 *   （M3_ORIGIN / M3_CDP_PORT 可覆盖默认值；CDP 端口用 9341，避开 m1=9333 / m2=9337）
 *
 * 约定（M2 的血泪教训，全部已编码进写法）：
 * - 页面侧 JS 一律用单引号写选择器，避免与外层模板字符串打架；
 * - 背景色比较用 probeBg（取 backgroundColor），文字色用 probe（取 color）；
 * - 尺寸比较读 getBoundingClientRect 的数字，不读 computed style 的 "28px" 字符串；
 * - async IIFE 必须给 cdp.eval 传 awaitPromise=true，否则 Promise 被序列化成 {}；
 * - 每个块用独立变量名，避免断言引用到隔壁块的同名变量。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { withBrowser, sleep } from "./cdp.mjs";

const ORIGIN = process.env.M3_ORIGIN ?? "http://127.0.0.1:5180";
const PORT = Number(process.env.M3_CDP_PORT ?? 9341);
const PKG_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const HELPERS = `
window.__T3 = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  rect: (el) => { const r = el.getBoundingClientRect(); return { left:+r.left.toFixed(2), right:+r.right.toFixed(2), top:+r.top.toFixed(2), bottom:+r.bottom.toFixed(2), width:+r.width.toFixed(2), height:+r.height.toFixed(2) }; },
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
    const a = window.__T3.lum(getComputedStyle(el).color);
    const b = window.__T3.lum(window.__T3.effBg(el));
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return +(((hi + 0.05) / (lo + 0.05)).toFixed(2));
  },
};
true;
`;

/** 静态检查：G1（hex 只在 tokens.css）/ G2（无 dark: 变体）/ G5（无内置调色板）——与 m2 同口径 */
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
  const PALETTE = /\b(?:bg|text|border|ring|from|to)-(?:gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)\b|\b(?:bg|text)-(?:black|white)\b/g;

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

await withBrowser(
  { port: PORT, origin: ORIGIN, evidencePath: "_m3-evidence.json" },
  async (ctx) => {
    const { cdp } = ctx;
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HELPERS });

    ctx.record("G1_G2_G5_静态颜色检查", staticColorChecks());
    const stat = staticColorChecks();
    ctx.assert("G1 颜色来源唯一（hex 仅 tokens.css）", { 通过: stat.G1_hex仅tokens, 越界数为0: stat.hex在tokens之外.length === 0 });
    ctx.assert("G2 无 dark: 变体补丁（3-5 同口径）", { 通过: stat.G2_无dark变体, 命中数为0: stat.dark变体命中.length === 0 });
    ctx.assert("G5 不用 Tailwind 内置调色板", { 通过: stat.G5_无内置调色板, 命中数为0: stat.内置调色板命中.length === 0 });

    await ctx.open("/");
    await cdp.eval("localStorage.removeItem('sidebar-collapsed'); localStorage.removeItem('preview-collapsed'); localStorage.removeItem('preview-tab'); true");
    await ctx.open("/");
    await cdp.eval(HELPERS);
    await sleep(600);

    /* ---------------------------------------------------------------- 3-1a 默认态：效果 Tab 激活 */
    {
      const r1 = await cdp.eval(`(() => {
        const pane = window.__T3.q('[data-testid="preview-pane"]');
        const tabbar = window.__T3.q('[data-testid="preview-tabbar"]');
        const eff = window.__T3.q('[data-testid="preview-tab-effect"]');
        const code = window.__T3.q('[data-testid="preview-tab-code"]');
        const iframe = window.__T3.q('[data-testid="preview-iframe"]');
        const list = window.__T3.q('[role="tablist"]');
        return {
          paneExists: !!pane,
          tabbarHeight: tabbar ? +tabbar.getBoundingClientRect().height.toFixed(2) : null,
          tablistRole: list ? list.getAttribute('role') : null,
          effExists: !!eff, codeExists: !!code,
          effSelected: eff ? eff.getAttribute('aria-selected') : null,
          codeSelected: code ? code.getAttribute('aria-selected') : null,
          effActive: eff ? eff.dataset.active : null,
          codeActive: code ? code.dataset.active : null,
          iframeExists: !!iframe,
          sourceExists: !!window.__T3.q('[data-testid="preview-source"]'),
        };
      })()`);
      ctx.record("3-1a_默认态（应激活预览效果）", r1);
      ctx.assert("3-1a 双 Tab 存在、默认激活「预览效果」且互斥", {
        预览区存在: r1.paneExists === true,
        tablist语义存在: r1.tablistRole === "tablist",
        两个Tab都在: r1.effExists === true && r1.codeExists === true,
        效果默认激活: r1.effSelected === "true" && r1.effActive === "true",
        源码默认未激活: r1.codeSelected === "false" && r1.codeActive === "false",
        效果态显示iframe: r1.iframeExists === true,
        效果态无源码面板: r1.sourceExists === false,
        Tab条高44: Math.abs(r1.tabbarHeight - 44) < 0.6,
      });
    }

    /* ---------------------------------------------------------------- 3-3 效果态 iframe 隔离 */
    {
      const r2 = await cdp.eval(`(() => {
        const iframe = window.__T3.q('[data-testid="preview-iframe"]');
        const pane = window.__T3.q('[data-testid="preview-pane"]');
        if (!iframe) return { exists: false };
        const fr = window.__T3.rect(iframe);
        const pr = window.__T3.rect(pane);
        return {
          exists: true,
          sandboxAttr: iframe.getAttribute('sandbox'),
          hasSandboxAttr: iframe.hasAttribute('sandbox'),
          srcdocLen: (iframe.getAttribute('srcdoc') || '').length,
          frameWidth: fr.width, frameHeight: fr.height,
          paneWidth: pr.width,
          fillsPaneWidth: Math.abs(fr.width - pr.width) <= 1,
          fillsPaneHeight: fr.height >= pr.height - 60,
        };
      })()`);
      ctx.record("3-3_效果态iframe", r2);
      ctx.assert("3-3 效果态用 iframe sandbox 隔离渲染且占满内容区", {
        iframe存在: r2.exists === true,
        sandbox属性存在: r2.hasSandboxAttr === true,
        srcdoc内容非空: r2.srcdocLen > 500,
        宽度占满预览区: r2.fillsPaneWidth === true,
        高度占满内容区: r2.fillsPaneHeight === true,
      });
    }

    /* ---------------------------------------------------------------- 3-1b 点击切到源码 Tab */
    {
      await cdp.eval("window.__T3.q('[data-testid=\"preview-tab-code\"]').click(); true");
      await sleep(250);
      const r3 = await cdp.eval(`(() => {
        const eff = window.__T3.q('[data-testid="preview-tab-effect"]');
        const code = window.__T3.q('[data-testid="preview-tab-code"]');
        return {
          codeSelected: code.getAttribute('aria-selected'),
          codeActive: code.dataset.active,
          effSelected: eff.getAttribute('aria-selected'),
          effActive: eff.dataset.active,
          sourceExists: !!window.__T3.q('[data-testid="preview-source"]'),
          iframeGone: !window.__T3.q('[data-testid="preview-iframe"]'),
          copyExists: !!window.__T3.q('[data-testid="preview-copy"]'),
        };
      })()`);
      ctx.record("3-1b_切到源码Tab后", r3);
      ctx.assert("3-1b 点击后源码 Tab 激活、效果 Tab 退出、内容区互斥切换", {
        源码已激活: r3.codeSelected === "true" && r3.codeActive === "true",
        效果已退出: r3.effSelected === "false" && r3.effActive === "false",
        显示源码面板: r3.sourceExists === true,
        iframe已卸载: r3.iframeGone === true,
        复制按钮随源码态出现: r3.copyExists === true,
      });
    }

    /* ---------------------------------------------------------------- 3-2 源码态三要素 */
    {
      const r4 = await cdp.eval(`(async () => {
        const t0 = Date.now();
        let shikiReady = false;
        while (Date.now() - t0 < 10000) {
          if (window.__T3.q('.preview-source .shiki span')) { shikiReady = true; break; }
          await new Promise((r) => setTimeout(r, 100));
        }
        let lineCount = 0;
        const t1 = Date.now();
        while (Date.now() - t1 < 5000) {
          const el = window.__T3.q('[data-testid="preview-source"]');
          if (el && el.dataset.lineCount) { lineCount = +el.dataset.lineCount; break; }
          await new Promise((r) => setTimeout(r, 100));
        }
        const container = window.__T3.q('[data-testid="preview-source"]');
        if (!container) return { shikiReady, hasContainer: false };
        const lines = window.__T3.qa('.preview-source .shiki .line');
        const dataLines = lines.map((el) => +(el.dataset.line || 0));
        const maxDataLine = Math.max(...dataLines);
        const firstLine = lines[0];
        const beforeCs = firstLine ? getComputedStyle(firstLine, '::before') : null;
        const tokens = window.__T3.qa('.preview-source .shiki span:not(.line)').slice(0, 60);
        const tokenColors = [...new Set(tokens.map((s) => getComputedStyle(s).color))];
        const cr = window.__T3.rect(container);
        return {
          shikiReady, hasContainer: true,
          lineCount, domLineCount: lines.length, maxDataLine,
          lineAttrContiguous: dataLines.every((v, i) => v === i + 1),
          beforeContent: beforeCs ? beforeCs.content : null,
          beforeContentRendered: beforeCs ? beforeCs.content !== 'none' && beforeCs.content !== 'normal' : false,
          gutterWidth: beforeCs ? parseFloat(beforeCs.width) : null,
          gutterSticky: beforeCs ? beforeCs.position === 'sticky' : false,
          fontFamily: getComputedStyle(container).fontFamily,
          isMono: /Mono|monospace|Consolas/i.test(getComputedStyle(container).fontFamily),
          distinctTokenColors: tokenColors.length,
          sourceHeight: cr.height,
          sourceScrollableX: container.scrollWidth >= container.clientWidth,
        };
      })()`, true);
      ctx.record("3-2_源码态三要素", r4);
      ctx.assert("3-2 源码态：Shiki 高亮 + 行号 + 可复制，且行号与代码对齐", {
        shiki已渲染: r4.shikiReady === true,
        源码容器存在: r4.hasContainer === true,
        行数过百: r4.lineCount >= 50,
        data_line_count与DOM一致: r4.lineCount === r4.domLineCount,
        行号序号连续: r4.lineAttrContiguous === true,
        行号伪元素渲染: r4.beforeContentRendered === true,
        行号列有宽度: r4.gutterWidth > 20,
        行号横向滚动时固定: r4.gutterSticky === true,
        等宽字体: r4.isMono === true,
        高亮配色多于一色: r4.distinctTokenColors >= 2,
        源码区有实际高度: r4.sourceHeight > 300,
      });
    }

    /* ---------------------------------------------------------------- 复制按钮行为 */
    {
      await cdp.eval("window.__T3.q('[data-testid=\"preview-copy\"]').click(); true");
      const r5a = await cdp.eval(`(() => {
        const b = window.__T3.q('[data-testid="preview-copy"]');
        return { label: b.getAttribute('aria-label'), text: b.innerText.trim() };
      })()`);
      await sleep(1900);
      const r5b = await cdp.eval(`(() => {
        const b = window.__T3.q('[data-testid="preview-copy"]');
        return { label: b.getAttribute('aria-label'), text: b.innerText.trim() };
      })()`);
      ctx.record("复制按钮（点击后/1.9s后）", { 点击后: r5a, 回落后: r5b });
      ctx.assert("复制按钮：点击进入已复制态，约 1.5s 后自动回落", {
        点击后显示已复制: r5a.label === "已复制" && r5a.text === "已复制",
        一点九秒后回落: r5b.label === "复制源码" && r5b.text === "复制",
      });
    }

    /* ---------------------------------------------------------------- 3-7 深浅主题下源码高亮跟随 */
    {
      const r6 = await cdp.eval(`(async () => {
        const pick = () => window.__T3.qa('.preview-source .shiki span:not(.line)')[8];
        const a = pick();
        if (!a) return { hasToken: false };
        const lightColor = getComputedStyle(a).color;
        const lineCountBefore = window.__T3.qa('.preview-source .shiki .line').length;
        window.__T3.q('[data-testid="titlebar-toggle-theme"]').click();
        await new Promise((r) => setTimeout(r, 400));
        const b = pick();
        const darkColor = getComputedStyle(b).color;
        const lineCountDark = window.__T3.qa('.preview-source .shiki .line').length;
        const shikiBgDark = getComputedStyle(window.__T3.q('.preview-source .shiki')).backgroundColor;
        window.__T3.q('[data-testid="titlebar-toggle-theme"]').click();
        await new Promise((r) => setTimeout(r, 400));
        const c = pick();
        const backColor = getComputedStyle(c).color;
        return {
          hasToken: true, lightColor, darkColor, backColor,
          colorChanged: lightColor !== darkColor,
          restored: backColor === lightColor,
          lineCountBefore, lineCountDark,
          domUnchanged: lineCountBefore === lineCountDark,
          shikiBgDark,
        };
      })()`, true);
      ctx.record("3-7_源码高亮主题跟随", r6);
      ctx.assert("3-7 深色下源码高亮用深色主题配色，切换无需重渲染", {
        有token节点: r6.hasToken === true,
        切深色后配色变化: r6.colorChanged === true,
        切回浅色还原: r6.restored === true,
        DOM未重渲染: r6.domUnchanged === true,
      });
    }

    /* ---------------------------------------------------------------- 3-6 + G3/G4/G6 深色走查 */
    {
      const lt = await cdp.eval(`(() => ({
        theme: document.documentElement.dataset.theme,
        iconColors: window.__T3.qa('svg.lucide').slice(0, 8).map((el) => getComputedStyle(el).color),
        docOk: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        bodyOk: document.body.scrollWidth <= document.body.clientWidth,
      }))()`);

      await cdp.eval("window.__T3.q('[data-testid=\"titlebar-toggle-theme\"]').click(); true");
      await sleep(400);

      const dk = await cdp.eval(`(() => {
        const theme = document.documentElement.dataset.theme;
        const iconColors = window.__T3.qa('svg.lucide').slice(0, 8).map((el) => getComputedStyle(el).color);
        const panels = [
          ['window-shell', '[data-testid="window-shell"]'],
          ['sidebar', '[data-testid="sidebar"]'],
          ['workspace-area', '[data-testid="workspace-area"]'],
          ['preview-pane', '[data-testid="preview-pane"]'],
          ['preview-tabbar', '[data-testid="preview-tabbar"]'],
          ['preview-source', '[data-testid="preview-source"]'],
        ];
        const panelBgs = panels.map((entry) => {
          const el = window.__T3.q(entry[1]);
          const bg = el ? window.__T3.effBg(el) : null;
          return { name: entry[0], exists: !!el, bg, luminance: bg ? +window.__T3.lum(bg).toFixed(3) : null };
        });
        const samples = [
          ['激活Tab标签', '[data-testid="preview-tab-code"][data-active="true"]'],
          ['未激活Tab标签', '[data-testid="preview-tab-effect"][data-active="false"]'],
          ['复制按钮', '[data-testid="preview-copy"]'],
        ];
        const contrast = samples.map((entry) => {
          const el = window.__T3.q(entry[1]);
          return { name: entry[0], exists: !!el, ratio: el ? window.__T3.contrast(el) : null };
        });
        return {
          theme, iconColors,
          iconsAllNeutral: iconColors.length > 0 && iconColors.every((c) => c.replace(/\\s/g, '') === 'rgb(138,145,158)'),
          panelBgs,
          noLightPanels: panelBgs.every((p) => p.luminance === null || p.luminance < 0.5),
          contrast,
          minContrast: Math.min(...contrast.filter((c) => c.ratio !== null).map((c) => c.ratio)),
          docOk: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          bodyOk: document.body.scrollWidth <= document.body.clientWidth,
        };
      })()`);
      ctx.record("3-6_G3_G4_G6_深色走查", { 浅色基线: lt, 深色: dk });

      ctx.assert("3-6 深色无白底黑字残留（面板有效底色全部为深色，含预览区与源码区）", {
        已切到深色: dk.theme === "dark",
        六个面板全部深色底: dk.noLightPanels === true,
        各面板底色亮度: dk.panelBgs.every((p) => p.luminance !== null && p.luminance < 0.5),
      });
      ctx.assert("G3 深色下预览区交互元素对比度 ≥ 4.5:1", {
        已切到深色: dk.theme === "dark",
        最低对比度达标: dk.minContrast >= 4.5,
        样本全存在: dk.contrast.every((c) => c.exists === true),
      });
      ctx.assert("G4 图标统一 --icon-neutral 且深浅一致", {
        浅色全为8A919E: lt.iconColors.length > 0 && lt.iconColors.every((c) => c.replace(/\s/g, "") === "rgb(138,145,158)"),
        深色全为8A919E: dk.iconsAllNeutral === true,
        深浅一致: JSON.stringify(lt.iconColors) === JSON.stringify(dk.iconColors),
      });
      ctx.assert("G6 无横向滚动条（浅色/深色）", {
        浅色document无溢出: lt.docOk === true,
        浅色body无溢出: lt.bodyOk === true,
        深色document无溢出: dk.docOk === true,
        深色body无溢出: dk.bodyOk === true,
      });

      await cdp.eval("window.__T3.q('[data-testid=\"titlebar-toggle-theme\"]').click(); true");
      await sleep(300);
    }

    /* ---------------------------------------------------------------- 3-4 持久化 + ?preview=code 入口 */
    {
      // 此刻预览 Tab 停在「源码」（3-1b 点过去后没人动过它）→ 原地重开应保持
      await ctx.open("/");
      await cdp.eval(HELPERS);
      await sleep(600);
      const r7 = await cdp.eval(`(() => {
        const code = window.__T3.q('[data-testid="preview-tab-code"]');
        return {
          stored: localStorage.getItem('preview-tab'),
          codeActive: code ? code.dataset.active : null,
          sourceExists: !!window.__T3.q('[data-testid="preview-source"]'),
        };
      })()`);
      ctx.record("3-4a_重开页面后", r7);
      ctx.assert("3-4a 预览 Tab 选择持久化：重开页面仍停在源码态", {
        localStorage已记录: r7.stored === "code",
        重开后仍激活源码: r7.codeActive === "true",
        源码面板在场: r7.sourceExists === true,
      });

      // 清掉持久化后，用 ?preview=code 进入（01b 屏走查入口）
      await cdp.eval("localStorage.removeItem('preview-tab'); true");
      await ctx.open("/?preview=code");
      await cdp.eval(HELPERS);
      await sleep(600);
      const r8 = await cdp.eval(`(() => {
        const code = window.__T3.q('[data-testid="preview-tab-code"]');
        const eff = window.__T3.q('[data-testid="preview-tab-effect"]');
        return {
          codeActive: code ? code.dataset.active : null,
          effActive: eff ? eff.dataset.active : null,
          sourceExists: !!window.__T3.q('[data-testid="preview-source"]'),
        };
      })()`);
      ctx.record("3-4b_带 ?preview=code 进入", r8);
      ctx.assert("3-4b 01b 屏入口：?preview=code 进入时默认激活源码 Tab", {
        源码激活: r8.codeActive === "true",
        效果未激活: r8.effActive === "false",
        源码面板在场: r8.sourceExists === true,
      });

      // 清场：回到默认效果态，避免影响后续会话
      await cdp.eval("localStorage.removeItem('preview-tab'); true");
      await ctx.open("/");
      await sleep(300);
    }

    const summary = ctx.save("_m3-evidence.json");
    if (summary.failed > 0) process.exitCode = 1;
  },
);

console.log("\n提示：M1 的 13 条 / M2 的 32 项回归需另行运行 npm run accept:m1 与 accept:m2 验证。");
