/**
 * M2 验收脚本 —— 18 条验收 + G1~G8，全部给**显式布尔断言**并汇总。
 *
 * 由主控 Agent 独立编写（不由实现方编写），理由见 `.plan/progress-M1.md` 10.3：
 * 实现方写的验收脚本天然容易「只打印不断言」——M1 阶段就因此把
 * 「折叠后残留 1px、内容区 1422 而非 1424」当成了通过。
 * 「没有失败」和「有断言且通过」是两回事。
 *
 * 用法：
 *   1. 先在 packages/ui 下起 dev server：npm run dev -- --port 5182 --strictPort
 *   2. node scripts/m2-acceptance.mjs
 *
 * 约定：页面侧 JS 一律用**单引号**写 CSS 选择器，避免与外层模板字符串打架。
 * （上一个执行方就是栽在嵌套反引号上，脚本报 "Unexpected end of input"。）
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { withBrowser, sleep } from "./cdp.mjs";

const ORIGIN = process.env.M2_ORIGIN ?? "http://127.0.0.1:5182";
const PORT = Number(process.env.M2_CDP_PORT ?? 9337);
const PKG_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/* ---------------------------------------------------------------------------
 * 页面侧工具：一次性注入，后续断言表达式都短，减少嵌套字符串出错的机会
 * ------------------------------------------------------------------------- */
const HELPERS = `
window.__T = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  rect: (el) => { const r = el.getBoundingClientRect(); return { left:+r.left.toFixed(2), right:+r.right.toFixed(2), top:+r.top.toFixed(2), bottom:+r.bottom.toFixed(2), width:+r.width.toFixed(2), height:+r.height.toFixed(2) }; },
  scroll: (el) => ({ top: Math.round(el.scrollTop), height: el.scrollHeight, client: el.clientHeight, dist: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) }),
  probe: (cls) => { const el = document.createElement('span'); el.className = cls; document.body.appendChild(el); const c = getComputedStyle(el).color; el.remove(); return c; },
  probeBg: (cls) => { const el = document.createElement('span'); el.className = cls; document.body.appendChild(el); const c = getComputedStyle(el).backgroundColor; el.remove(); return c; },
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
    const a = window.__T.lum(getComputedStyle(el).color);
    const b = window.__T.lum(window.__T.effBg(el));
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return +(((hi + 0.05) / (lo + 0.05)).toFixed(2));
  },
  setText: (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },
  theme: (t) => { document.documentElement.setAttribute('data-theme', t); return document.documentElement.dataset.theme; },
};
true;
`;

/** 静态检查：G1（hex 只在 tokens.css）/ G2（无 dark: 变体）/ G5（无内置调色板） */
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
      // `dark:` 只找 Tailwind 变体写法（形如 dark:xxx），不匹配 data-theme="dark"
      const darkVariants = line.match(/(?:^|[\s"'`])dark:[a-z[]/g);
      if (darkVariants) darkVariantHits.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 100) });
      const pal = line.match(PALETTE);
      if (pal) paletteHits.push({ file: rel, line: i + 1, hits: pal });
    });
  }

  const hexOutsideTokens = hexHits.filter((h) => h.file !== "styles/tokens.css");
  return {
    扫描文件数: files.length,
    hex命中文件: [...new Set(hexHits.map((h) => h.file))],
    hex在tokens之外: hexOutsideTokens,
    dark变体命中: darkVariantHits,
    内置调色板命中: paletteHits,
    G1_hex仅tokens: hexOutsideTokens.length === 0,
    G2_无dark变体: darkVariantHits.length === 0,
    G5_无内置调色板: paletteHits.length === 0,
  };
}

await withBrowser(
  { port: PORT, origin: ORIGIN, evidencePath: "_m2-evidence.json" },
  async (ctx) => {
    const { cdp } = ctx;
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HELPERS });

    ctx.record("G1_G2_G5_静态颜色检查", staticColorChecks());
    const stat = staticColorChecks();
    ctx.assert("G1 颜色来源唯一（hex 仅 tokens.css）", { 通过: stat.G1_hex仅tokens, 越界: stat.hex在tokens之外.length === 0 });
    ctx.assert("G2 无 dark: 变体补丁", { 通过: stat.G2_无dark变体, 命中数: stat.dark变体命中.length === 0 });
    ctx.assert("G5 不用 Tailwind 内置调色板", { 通过: stat.G5_无内置调色板, 命中数: stat.内置调色板命中.length === 0 });

    await ctx.open("/");
    await cdp.eval("localStorage.removeItem('sidebar-collapsed'); localStorage.removeItem('preview-collapse'); localStorage.removeItem('preview-collapsed'); true");
    await ctx.open("/");
    await cdp.eval(HELPERS);
    await sleep(600);

    /* ---------------------------------------------------------------- 2-1 消息按序渲染 */
    {
      const r = await cdp.eval(`(() => {
        const list = window.__T.q('[data-testid="message-list"]');
        const items = window.__T.qa('[data-testid="message-item"]');
        const items_m2 = window.__T.qa('[data-testid="markdown-body"]');
        const ids = items.map((el) => el.dataset.messageId);
        const roles = items.map((el) => el.dataset.role);
        const idx = items.map((el) => +el.dataset.index);
        return {
          totalCount: +list.dataset.totalCount,
          rendered: items.length,
          ids, roles, idx,
          indexAscending: idx.every((v, i) => i === 0 || v > idx[i - 1]),
          rolePairsOk: roles.every((x) => x === 'user' || x === 'assistant'),
          hasMarkdownBodies: items_m2.length,
        };
      })()`);
      ctx.record("2-1_消息按序渲染", r);
      ctx.assert("2-1 消息按序渲染（user/assistant 交替、index 升序、总数 7）", {
        总数是7: r.totalCount === 7,
        有渲染节点: r.rendered > 0,
        index升序: r.indexAscending,
        角色合法: r.rolePairsOk,
        首条是user: r.roles[0] === "user",
      });
    }

    /* ---------------------------------------------------------------- 2-3 Markdown 渲染 */
    {
      // 滚到顶部，让第 2 条（markdown 富文本）进入虚拟窗口
      await cdp.eval("window.__T.q('[data-testid=\"message-list\"]').scrollTop = 0; true");
      await sleep(500);
      const r = await cdp.eval(`(() => {
        const item = window.__T.q('[data-message-id="m2"]');
        if (!item) return { found: false };
        // ⚠️ m2 同时含 thinking 与 text 两个 block，而 ThinkingCard 也渲染 markdown-body。
        // 直接 querySelector 会拿到**思考块**那个（只有一段带行内代码的段落），
        // 从而误判「h2/列表/表格/链接都没有」。所以按内容定位到正文那块。
        const bodies = [...item.querySelectorAll('[data-testid="markdown-body"]')];
        const body = bodies.find((b) => b.textContent.includes('调研结论'));
        if (!body) return { found: true, hasBody: false, bodyCount: bodies.length };
        const q = (s) => !!body.querySelector(s);
        return {
          found: true, hasBody: true, bodyCount: bodies.length,
          h2: q('h2'), ul: q('ul li'), ol: q('ol li'),
          inlineCode: q('p code, li code'), codeBlock: q('pre code'),
          table: q('table th, table td'), link: q('a[href]'),
          rawMarkdownLeak: body.textContent.includes('## ') || body.textContent.includes('| --- |'),
        };
      })()`);
      ctx.record("2-3_Markdown 渲染", r);
      ctx.assert("2-3 Markdown 渲染正确（标题/列表/代码/表格/链接）", {
        找到m2消息: r.found === true,
        有markdown根节点: r.hasBody === true,
        二级标题: r.h2 === true,
        无序列表: r.ul === true,
        有序列表: r.ol === true,
        行内代码: r.inlineCode === true,
        代码块: r.codeBlock === true,
        表格: r.table === true,
        链接: r.link === true,
        无markdown原文泄漏: r.rawMarkdownLeak === false,
      });
    }

    /* ---------------------------------------------------------------- 2-4 代码高亮双主题 */
    {
      // Shiki 是懒加载 + 异步，等 .shiki 出现（最多 8s）
      const appeared = await cdp.eval(
        `new Promise((res) => {
           const t0 = Date.now();
           const tick = () => {
             if (window.__T.q('[data-testid="code-block"] .shiki') || window.__T.q('[data-testid="code-block"] .shiki span')) return res('shiki');
             if (Date.now() - t0 > 8000) return res('timeout:' + (window.__T.q('[data-testid="code-block"]') ? 'block-without-shiki' : 'no-block'));
             setTimeout(tick, 100);
           };
           tick();
         })`,
        true,
      );
      const r = await cdp.eval(`(() => {
        const cb = window.__T.q('[data-testid="code-block"]');
        const span = document.querySelector('[data-testid="code-block"] .shiki span') || (cb ? cb.querySelector('span') : null);
        if (!span) return { appeared: '${appeared}', hasSpan: false };
        const before = getComputedStyle(span).color;
        document.documentElement.setAttribute('data-theme', 'dark');
        const afterDark = getComputedStyle(span).color;
        document.documentElement.setAttribute('data-theme', 'light');
        const afterLight = getComputedStyle(span).color;
        return {
          appeared: '${appeared}',
          hasSpan: true,
          hasShikiClass: !!document.querySelector('[data-testid="code-block"] .shiki'),
          lightColor: before, darkColor: afterDark, backToLight: afterLight,
          colorChangedWithTheme: before !== afterDark,
          restored: before === afterLight,
        };
      })()`);
      ctx.record("2-4_代码高亮双主题", r);
      ctx.assert("2-4 代码高亮深浅双主题跟随切换（不需刷新）", {
        shiki已渲染: r.appeared === "shiki",
        有tokenSpan: r.hasSpan === true,
        切深色后颜色变化: r.colorChangedWithTheme === true,
        切回浅色还原: r.restored === true,
        颜色确实不同: r.lightColor !== r.darkColor,
      });
    }

    /* ---------------------------------------------------------------- 2-6 计划四态 */
    {
      const r = await cdp.eval(`(() => {
        const card = window.__T.q('[data-testid="plan-card"]');
        if (!card) return { found: false };
        const steps = [...card.querySelectorAll('[data-testid="plan-step"]')];
        const statuses = steps.map((el) => el.dataset.status);
        const four = ['pending','running','done','failed'];
        return {
          found: true, stepCount: steps.length, statuses,
          coveredFour: four.every((s) => statuses.includes(s)),
          unknownStatus: statuses.filter((s) => !four.includes(s)),
        };
      })()`);
      ctx.record("2-6_执行计划四态", r);
      ctx.assert("2-6 执行计划卡片四种状态齐全", {
        找到卡片: r.found === true,
        有四步: r.stepCount === 4,
        覆盖四种状态: r.coveredFour === true,
        无非法状态: Array.isArray(r.unknownStatus) && r.unknownStatus.length === 0,
      });
    }

    /* ---------------------------------------------------------------- 2-7 终端卡片（含反例） */
    {
      const r = await cdp.eval(`(() => {
        const cards = window.__T.qa('[data-testid="terminal-card"]');
        const success = cards[0];
        const err = cards[1];
        const out = success.querySelector('[data-testid="terminal-output"]');
        const cmd = success.querySelector('[data-testid="terminal-command"]');
        const expand = success.querySelector('[data-testid="terminal-expand"]');
        const before = { truncated: out.dataset.truncated, len: out.innerText.length };
        const errOut = err ? err.querySelector('[data-testid="terminal-output"]') : null;
        return {
          cardCount: cards.length,
          commandFontFamily: getComputedStyle(cmd).fontFamily,
          commandIsMono: /Mono|monospace|Consolas/i.test(getComputedStyle(cmd).fontFamily),
          outputFontFamily: getComputedStyle(out).fontFamily,
          outputIsMono: /Mono|monospace|Consolas/i.test(getComputedStyle(out).fontFamily),
          truncatedBefore: before.truncated, lenBefore: before.len,
          expandExists: !!expand,
          expandText: expand ? expand.innerText.trim() : null,
          errorCardTruncated: errOut ? errOut.dataset.truncated : null,
          outputOverflow: getComputedStyle(out).overflowY,
        };
      })()`);
      ctx.record("2-7_终端卡片（截断前）", r);

      // 点「查看完整内容」，输出应变长且不再是截断态
      const after = await cdp.eval(`(() => {
        const expand = window.__T.q('[data-testid="terminal-expand"]');
        if (!expand) return { clicked: false };
        expand.click();
        const out = window.__T.q('[data-testid="terminal-output"]');
        return { clicked: true, truncated: out.dataset.truncated, len: out.innerText.length, stillHasExpand: !!window.__T.q('[data-testid="terminal-expand"]') };
      })()`);
      await sleep(200);
      const afterSettled = await cdp.eval(`(() => {
        const out = window.__T.q('[data-testid="terminal-output"]');
        return { truncated: out.dataset.truncated, len: out.innerText.length, stillHasExpand: !!window.__T.q('[data-testid="terminal-expand"]') };
      })()`);
      ctx.record("2-7_终端卡片（展开后）", afterSettled);

      ctx.assert("2-7 终端卡片：等宽字体 + 长输出截断 + 完整内容入口", {
        命令等宽: r.commandIsMono === true,
        输出等宽: r.outputIsMono === true,
        截断态为true: r.truncatedBefore === "true",
        有完整内容入口: r.expandExists === true,
        // 注意这里必须是单反斜杠：断言写在普通 JS 里（不在模板字符串内），
        // 写成 /还有\\s*\\d+\\s*行/ 会去匹配字面反斜杠，永远不通过。
        入口文案含剩余行数: typeof r.expandText === "string" && /还有\s*\d+\s*行/.test(r.expandText),
        输出可滚动: r.outputOverflow === "auto",
      });
      ctx.assert("2-7 点开完整内容后：不再截断且入口消失", {
        点击生效: afterSettled.truncated === "false",
        内容变长: afterSettled.len > r.lenBefore,
        入口消失: afterSettled.stillHasExpand === false,
      });
      ctx.assert("2-7 反例：error 终端的 data-truncated 必须为 false", {
        反例成立: r.errorCardTruncated === "false",
      });
    }

    /* ---------------------------------------------------------------- 2-8 授权卡片（含反例） */
    {
      const init = await cdp.eval(`(() => {
        const card = window.__T.q('[data-testid="approval-card"]');
        if (!card) return { found: false };
        const opts = [...card.querySelectorAll('[data-testid^="approval-option-"]')];
        return {
          found: true,
          resolved: card.dataset.resolved,
          optionCount: opts.length,
          allEnabled: opts.every((b) => !b.disabled),
          labels: opts.map((b) => b.dataset.option),
        };
      })()`);
      ctx.record("2-8_授权卡片（初始）", init);

      const clicked = await cdp.eval(`(() => {
        const btn = window.__T.q('[data-testid="approval-option-0"]');
        btn.click();
        return true;
      })()`);
      await sleep(250);
      const after = await cdp.eval(`(() => {
        const card = window.__T.q('[data-testid="approval-card"]');
        const opts = [...card.querySelectorAll('[data-testid^="approval-option-"]')];
        return {
          resolved: card.dataset.resolved,
          allDisabled: opts.every((b) => b.disabled),
          chosenPressed: card.querySelector('[data-testid="approval-option-0"]').getAttribute('aria-pressed'),
          shownChoice: card.innerText.includes('已选择'),
        };
      })()`);
      // 再点一次：已决状态不应有任何变化（不可再点）
      await cdp.eval(`(() => { window.__T.q('[data-testid="approval-option-1"]').click(); return true; })()`);
      await sleep(200);
      const afterSecond = await cdp.eval(`window.__T.q('[data-testid="approval-card"]').dataset.resolved`);
      ctx.record("2-8_授权卡片（已决）", { after, afterSecondClickResolved: afterSecond, clicked });

      ctx.assert("2-8a 授权卡片初始未决且可点", {
        找到卡片: init.found === true,
        data_resolved为false: init.resolved === "false",
        两个选项: init.optionCount === 2,
        初始可点: init.allEnabled === true,
        选项为允许拒绝: JSON.stringify(init.labels) === JSON.stringify(["允许", "拒绝"]),
      });
      ctx.assert("2-8b 点击后已决、两按钮置灰、且再点无效（反例）", {
        data_resolved变true: after.resolved === "true",
        两按钮均disabled: after.allDisabled === true,
        选中项高亮: after.chosenPressed === "true",
        显示已选择: after.shownChoice === true,
        二次点击不改状态: afterSecond === "true",
      });
    }

    /* ---------------------------------------------------------------- 2-9 / 2-10 发送按钮 */
    {
      // 先清空输入框，保证发送按钮处于「无内容禁用」态
      const r = await cdp.eval(`(() => {
        const composer = window.__T.q('[data-testid="composer"]');
        const send = window.__T.q('[data-testid="composer-send"]');
        const input = window.__T.q('[data-testid="composer-input"]');
        const cr = window.__T.rect(composer);
        const sr = window.__T.rect(send);
        const cs = getComputedStyle(composer);
        const ss = getComputedStyle(send);
        const inRightQuadrant = sr.left >= cr.left + cr.width * 0.6;
        const inBottomQuadrant = sr.top >= cr.top + cr.height * 0.4;
        return {
          isDescendant: composer.contains(send),
          composerBorderWidth: cs.borderTopWidth,
          composerHasVisibleBorder: parseFloat(cs.borderTopWidth) > 0,
          composerRect: cr, sendRect: sr,
          fullyInside: sr.left >= cr.left && sr.right <= cr.right && sr.top >= cr.top && sr.bottom <= cr.bottom,
          inRightQuadrant, inBottomQuadrant,
          // 用 rect（数字）而不是 computed style 的 "28px" 字符串 —— 字符串相减会得到 NaN
          sendWidth: sr.width, sendHeight: sr.height,
          computedWidth: ss.width, computedHeight: ss.height,
          sendBorderRadius: ss.borderTopLeftRadius,
          isCircle: parseFloat(ss.borderTopLeftRadius) >= 13.5,
          sendBg: ss.backgroundColor,
          // 底色要比 backgroundColor；用 probe()（取 color）会拿到继承来的文字色，永远不相等
          accentSoftProbe: window.__T.probeBg('bg-accent-soft'),
          accentProbe: window.__T.probe('text-accent'),
          arrowColor: send.querySelector('svg') ? getComputedStyle(send.querySelector('svg')).color : null,
          disabledWhenEmpty: send.disabled,
          inputValue: input.value,
        };
      })()`);
      ctx.record("2-9_2-10_发送按钮", r);
      ctx.assert("2-9 发送按钮在输入框内部右下角（DOM 子孙 + 几何内切）", {
        DOM是子孙: r.isDescendant === true,
        完全落在输入框内: r.fullyInside === true,
        位于右侧区: r.inRightQuadrant === true,
        位于下部区: r.inBottomQuadrant === true,
        输入框有可见边框: r.composerHasVisibleBorder === true,
        空内容时禁用: r.disabledWhenEmpty === true,
      });
      ctx.assert("2-10 发送按钮规格：28×28 正圆 + accent-soft 底 + accent 箭头", {
        宽28: Math.abs(r.sendWidth - 28) < 0.5,
        高28: Math.abs(r.sendHeight - 28) < 0.5,
        正圆: r.isCircle === true,
        底色为accentSoft: r.sendBg === r.accentSoftProbe,
        箭头为accent色: r.arrowColor === r.accentProbe,
      });
    }

    /* ---------------------------------------------------------------- 2-11 / 2-12 / 2-16 工具条 */
    {
      // 变量名刻意叫 tb（toolbar）：早前把它也叫 r，结果 2-16 的断言引用了
      // 下面 TokenStats 那个 r，`undefined >= 1` 恒为 false —— 假失败。
      const tb = await cdp.eval(`(() => {
        const toolbar = window.__T.q('[data-testid="composer-toolbar"]');
        const order = [...toolbar.children].map((el) => el.dataset.testid || el.tagName.toLowerCase());
        const chips = ['composer-chip-model','composer-chip-thinking','composer-chip-mcp'].map((id) => {
          const el = window.__T.q('[data-testid="' + id + '"]');
          return { id, exists: !!el, height: el ? +el.getBoundingClientRect().height.toFixed(2) : null, text: el ? el.innerText.trim() : null };
        });
        const spacer = window.__T.q('[data-testid="composer-toolbar-spacer"]');
        const stats = window.__T.q('[data-testid="token-stats"]');
        return {
          order, chips,
          chipHeights: chips.map((c) => c.height),
          allChips32: chips.every((c) => Math.abs(c.height - 32) < 0.6),
          spacerFlexGrow: spacer ? getComputedStyle(spacer).flexGrow : null,
          statsRight: stats ? window.__T.rect(stats).right : null,
          toolbarRight: window.__T.rect(toolbar).right,
        };
      })()`);
      ctx.record("2-11_2-12_2-16_工具条", tb);
      ctx.assert("2-11 工具条顺序：模型 → 思考强度 → MCP → 弹性占位 → TokenStats", {
        顺序正确: JSON.stringify(tb.order) === JSON.stringify(["composer-chip-model", "composer-chip-thinking", "composer-chip-mcp", "composer-toolbar-spacer", "token-stats"]),
        三个芯片都在: tb.chips.every((c) => c.exists),
      });
      ctx.assert("2-12 工具条芯片高 32", {
        三个芯片均为32: tb.allChips32 === true,
        实测高度: JSON.stringify(tb.chipHeights) === JSON.stringify([32, 32, 32]),
      });
      ctx.assert("2-16 TokenStats 靠右（弹性占位撑开）", {
        占位flexGrow大于等于1: parseFloat(tb.spacerFlexGrow) >= 1,
        右侧贴合工具条右边: Math.abs(tb.statsRight - tb.toolbarRight) <= 4,
      });
    }

    /* ---------------------------------------------------------------- 2-13 ~ 2-16 TokenStats */
    {
      const r = await cdp.eval(`(() => {
        const root = window.__T.q('[data-testid="token-stats"]');
        const keys = ['input','output','total','context'];
        const items = keys.map((k) => {
          const el = window.__T.q('[data-testid="token-stats-item-' + k + '"]');
          if (!el) return { key: k, exists: false };
          return {
            key: k, exists: true,
            text: el.innerText.trim(),
            color: getComputedStyle(el).color,
            value: el.lastElementChild ? el.lastElementChild.textContent.trim() : null,
          };
        });
        const dividers = window.__T.qa('[data-testid="token-stats-divider"]');
        const primary = window.__T.probe('text-text-primary');
        const secondary = window.__T.probe('text-text-secondary');
        return {
          items,
          dividerCount: dividers.length,
          rootBg: getComputedStyle(root).backgroundColor,
          subtleProbe: window.__T.probeBg('bg-bg-subtle'),
          primaryProbe: primary, secondaryProbe: secondary,
          highlightMap: items.map((i) => ({ key: i.key, isPrimary: i.color === primary, isSecondary: i.color === secondary })),
          values: items.map((i) => i.value),
        };
      })()`);
      ctx.record("2-13_2-14_2-15_TokenStats", r);
      ctx.assert("2-13 TokenStats 四段齐全 + 段间细分隔线", {
        四段都存在: r.items.every((i) => i.exists === true),
        三段分隔线: r.dividerCount === 3,
        段落顺序正确: JSON.stringify(r.items.map((i) => i.key)) === JSON.stringify(["input", "output", "total", "context"]),
        容器底色为bgSubtle: r.rootBg === r.subtleProbe,
      });
      ctx.assert("2-14 数值格式化为 12.4k / 128k 形式", {
        输入: r.values[0] === "12.4k",
        输出: r.values[1] === "6.2k",
        消耗: r.values[2] === "18.6k",
        上下文: r.values[3] === "128k",
        未出现128点0k: r.values[3] !== "128.0k",
      });
      ctx.assert("2-15 只有「消耗」段用 text-primary，其余为 text-secondary", {
        消耗是primary: r.highlightMap[2].isPrimary === true,
        输入是secondary: r.highlightMap[0].isSecondary === true,
        输出是secondary: r.highlightMap[1].isSecondary === true,
        上下文是secondary: r.highlightMap[3].isSecondary === true,
        反例_消耗不是secondary: r.highlightMap[2].isSecondary === false,
      });
    }

    /* ---------------------------------------------------------------- 2-17 输入框多行自适应 */
    {
      const measure = async (lines) => {
        const text = Array.from({ length: lines }, (_, i) => "第 " + (i + 1) + " 行输入内容").join("\n");
        await cdp.eval(`(() => { const el = window.__T.q('[data-testid="composer-input"]'); window.__T.setText(el, ${JSON.stringify(text)}); return true; })()`);
        await sleep(250);
        return cdp.eval(`(() => {
          const c = window.__T.q('[data-testid="composer"]');
          const t = window.__T.q('[data-testid="composer-input"]');
          return {
            composerHeight: +c.getBoundingClientRect().height.toFixed(2),
            inputScrollHeight: t.scrollHeight,
            inputClientHeight: t.clientHeight,
            valueLen: t.value.length,
          };
        })()`);
      };
      const h1 = await measure(1);
      const h10 = await measure(10);
      const h40 = await measure(40);
      ctx.record("2-17_输入框多行自适应", { 单行: h1, 十行: h10, 四十行: h40 });
      ctx.assert("2-17 输入框高度随内容自适应且有最大高度上限", {
        单行有值: h1.valueLen > 0,
        十行比单行高: h10.composerHeight > h1.composerHeight + 20,
        十行未超上限: h10.composerHeight <= 240,
        四十行被上限截住: Math.abs(h40.composerHeight - h10.composerHeight) < 2,
        达到上限后内部可滚动: h40.inputScrollHeight > h40.inputClientHeight,
      });
      // 清空输入框，避免影响后续
      await cdp.eval(`(() => { const el = window.__T.q('[data-testid="composer-input"]'); window.__T.setText(el, ''); return true; })()`);
      await sleep(200);
    }

    /* ---------------------------------------------------------------- 2-18 长文本不破版 */
    {
      await cdp.eval("window.__T.q('[data-testid=\"message-list\"]').scrollTop = 0; true");
      await sleep(400);
      const r = await cdp.eval(`(() => {
        const list = window.__T.q('[data-testid="message-list"]');
        const bodies = window.__T.qa('[data-testid="markdown-body"]');
        const longOne = bodies.find((b) => /sha256/.test(b.textContent));
        return {
          longMessageRendered: !!longOne,
          listScrollWidth: list.scrollWidth, listClientWidth: list.clientWidth,
          docScrollWidth: document.documentElement.scrollWidth,
          docClientWidth: document.documentElement.clientWidth,
          bodyScrollWidth: document.body.scrollWidth,
          bodyClientWidth: document.body.clientWidth,
          longBodyScrollWidth: longOne ? longOne.scrollWidth : null,
          longBodyClientWidth: longOne ? longOne.clientWidth : null,
          wrapMode: longOne ? getComputedStyle(longOne).overflowWrap + ' / ' + getComputedStyle(longOne).wordBreak : null,
        };
      })()`);
      ctx.record("2-18_长文本不破版", r);
      ctx.assert("2-18 超长不可断字符串不撑破容器", {
        长文本消息已渲染: r.longMessageRendered === true,
        消息流无横向溢出: r.listScrollWidth <= r.listClientWidth,
        长文本块无横向溢出: r.longBodyScrollWidth === null || r.longBodyScrollWidth <= r.longBodyClientWidth,
        body无横向溢出: r.bodyScrollWidth <= r.bodyClientWidth,
        document无横向溢出: r.docScrollWidth <= r.docClientWidth,
      });
    }

    /* ---------------------------------------------------------------- 2-5 自动滚底 + 上滚停止 */
    {
      // ⚠️ 这两个 eval 的表达式是 async IIFE，**必须传 awaitPromise=true**，
      //    否则 Runtime.evaluate 拿回来的是一个 Promise 对象，returnByValue 会把它序列化成 {} ——
      //    表现为 `a.dataAtBottom` 是 undefined、断言全 false，而日志里只看到一个空对象，极难定位。
      const a = await cdp.eval(`(async () => {
        const list = window.__T.q('[data-testid="message-list"]');
        list.scrollTop = list.scrollHeight;
        await new Promise((r) => setTimeout(r, 300));
        const s = window.__T.scroll(list);
        return { dataAtBottom: list.dataset.atBottom, dist: s.dist, scrollable: s.height > s.client };
      })()`, true);
      ctx.record("2-5_初始状态", a);
      ctx.assert("2-5a 初始贴底", {
        data_at_bottom为true: a.dataAtBottom === "true",
        距底在阈值内: a.dist <= 32,
      });

      // 上滚 → 应变为非贴底，且出现「回到底部」按钮
      const b = await cdp.eval(`(async () => {
        const list = window.__T.q('[data-testid="message-list"]');
        list.scrollTop = 0;
        await new Promise((r) => setTimeout(r, 350));
        return {
          dataAtBottom: list.dataset.atBottom,
          scrollTop: Math.round(list.scrollTop),
          hasScrollToBottom: !!window.__T.q('[data-testid="scroll-to-bottom"]'),
        };
      })()`, true);
      ctx.record("2-5_上滚后", b);
      ctx.assert("2-5b 上滚后 data-at-bottom 变 false 且出现回到底部按钮", {
        状态变false: b.dataAtBottom === "false",
        已滚到顶部: b.scrollTop <= 4,
        回底按钮出现: b.hasScrollToBottom === true,
      });

      // 上滚状态下发消息：新消息到达**不得**把视口拽回底部（这是 2-5 的关键反例）
      await cdp.eval(`(() => {
        const input = window.__T.q('[data-testid="composer-input"]');
        window.__T.setText(input, '上滚状态下的测试消息');
        return true;
      })()`);
      await sleep(200);
      await cdp.eval("window.__T.q('[data-testid=\"composer-send\"]').click(); true");
      await sleep(2800);
      const c = await cdp.eval(`(() => {
        const list = window.__T.q('[data-testid="message-list"]');
        const s = window.__T.scroll(list);
        return {
          dataAtBottom: list.dataset.atBottom,
          scrollTop: s.top, dist: s.dist,
          totalCount: +list.dataset.totalCount,
          hasScrollToBottom: !!window.__T.q('[data-testid="scroll-to-bottom"]'),
        };
      })()`);
      ctx.record("2-5_上滚时收到新消息", c);
      ctx.assert("2-5c 上滚状态下新消息到达不强制滚底（反例）", {
        消息数已增加: c.totalCount > 7,
        仍在顶部未被拽走: c.scrollTop <= 40,
        距底远超阈值: c.dist > 32,
        状态仍为false: c.dataAtBottom === "false",
        回底按钮仍在: c.hasScrollToBottom === true,
      });

      // 点回到底部 → 应真的回到底部，按钮消失
      await cdp.eval("window.__T.q('[data-testid=\"scroll-to-bottom\"]').click(); true");
      await sleep(400);
      const d = await cdp.eval(`(() => {
        const list = window.__T.q('[data-testid="message-list"]');
        const s = window.__T.scroll(list);
        return { dataAtBottom: list.dataset.atBottom, dist: s.dist, hasScrollToBottom: !!window.__T.q('[data-testid="scroll-to-bottom"]') };
      })()`);
      ctx.record("2-5_点回到底部后", d);
      ctx.assert("2-5d 点「回到底部」后回到底且按钮消失", {
        回到底部: d.dist <= 32,
        状态变true: d.dataAtBottom === "true",
        按钮消失: d.hasScrollToBottom === false,
      });

      // 贴底状态下发消息 → 应自动滚底
      await cdp.eval(`(() => { const input = window.__T.q('[data-testid="composer-input"]'); window.__T.setText(input, '贴底状态下的测试消息'); return true; })()`);
      await sleep(200);
      await cdp.eval("window.__T.q('[data-testid=\"composer-send\"]').click(); true");
      await sleep(2800);
      const e = await cdp.eval(`(() => {
        const list = window.__T.q('[data-testid="message-list"]');
        const s = window.__T.scroll(list);
        return { dataAtBottom: list.dataset.atBottom, dist: s.dist, totalCount: +list.dataset.totalCount };
      })()`);
      ctx.record("2-5_贴底时收到新消息", e);
      ctx.assert("2-5e 贴底状态下新消息自动滚底", {
        自动滚到底: e.dist <= 32,
        状态为true: e.dataAtBottom === "true",
      });
    }

    /* ---------------------------------------------------------------- G7 键盘可达 */
    {
      const r = await cdp.eval(`(() => {
        const sel = 'button, [href], input, select, textarea, [tabindex]';
        const focusables = [...document.querySelectorAll(sel)].filter((el) => el.getAttribute('tabindex') !== '-1' && !el.disabled || el.disabled === false);
        const all = [...document.querySelectorAll(sel)];
        const noLabel = all.filter((el) => !el.getAttribute('aria-label') && !(el.innerText || '').trim() && !el.getAttribute('title') && el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT');
        const inputLabelled = !!window.__T.q('[data-testid="composer-input"]').getAttribute('aria-label') || !!window.__T.q('[data-testid="composer-input"]').getAttribute('placeholder');
        return {
          focusableCount: focusables.length,
          noLabelCount: noLabel.length,
          noLabelSamples: noLabel.slice(0, 3).map((el) => el.outerHTML.slice(0, 80)),
          inputLabelled,
        };
      })()`);
      ctx.record("G7_可聚焦元素", r);

      const trail = [];
      await cdp.eval("document.body.focus(); true");
      for (let i = 0; i < 6; i++) {
        await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        await sleep(60);
        trail.push(
          await cdp.eval(`(() => {
            const el = document.activeElement;
            if (!el || el === document.body) return { none: true };
            const cs = getComputedStyle(el);
            return { testid: el.dataset.testid || null, tag: el.tagName.toLowerCase(), outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth };
          })()`),
        );
      }
      const ringVisible = trail.filter((t) => t.outlineStyle === "solid" && parseFloat(t.outlineWidth) >= 2).length;
      ctx.record("G7_Tab 轨迹", { trail, ringVisible });

      // Enter 激活 terminal-toggle（注意：必须带 text:"\\r"，否则原生激活不触发 —— M1 的假阴性教训）
      const before = await cdp.eval("window.__T.q('[data-testid=\"terminal-toggle\"]').dataset.expanded");
      await cdp.eval("window.__T.q('[data-testid=\"terminal-toggle\"]').focus(); true");
      await cdp.pressKey({ key: "Enter", code: "Enter", virtualKeyCode: 13, text: "\r" });
      await sleep(250);
      const afterEnter = await cdp.eval("window.__T.q('[data-testid=\"terminal-toggle\"]').dataset.expanded");

      await cdp.eval("window.__T.q('[data-testid=\"terminal-toggle\"]').focus(); true");
      await cdp.pressKey({ key: " ", code: "Space", virtualKeyCode: 32, text: " " });
      await sleep(250);
      const afterSpace = await cdp.eval("window.__T.q('[data-testid=\"terminal-toggle\"]').dataset.expanded");

      ctx.record("G7_Enter与Space", { before, afterEnter, afterSpace });
      ctx.assert("G7 交互元素键盘可达", {
        无缺标签元素: r.noLabelCount === 0,
        输入框有可读名称: r.inputLabelled === true,
        焦点环可见: ringVisible >= 6,
        Enter能触发: before !== afterEnter,
        Space能触发: afterEnter !== afterSpace,
      });
    }

    /* ---------------------------------------------------------------- G4 + G3 + G6（深色） */
    {
      const light = await cdp.eval(`(() => ({
        iconColors: window.__T.qa('svg.lucide').slice(0, 8).map((el) => getComputedStyle(el).color),
        docOk: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        bodyOk: document.body.scrollWidth <= document.body.clientWidth,
      }))()`);

      await cdp.eval("window.__T.q('[data-testid=\"titlebar-toggle-theme\"]').click(); true");
      await sleep(400);

      const dark = await cdp.eval(`(() => {
        const theme = document.documentElement.dataset.theme;
        const iconColors = window.__T.qa('svg.lucide').slice(0, 8).map((el) => getComputedStyle(el).color);
        const samples = [
          ['markdown-body p', '[data-testid="markdown-body"] p'],
          ['terminal-command', '[data-testid="terminal-command"]'],
          ['terminal-output', '[data-testid="terminal-output"]'],
          ['token-stats-total', '[data-testid="token-stats-item-total"]'],
          ['plan-step', '[data-testid="plan-step"]'],
          ['composer-input', '[data-testid="composer-input"]'],
        ];
        const contrast = samples.map((entry) => {
          const el = window.__T.q(entry[1]);
          return { name: entry[0], exists: !!el, ratio: el ? window.__T.contrast(el) : null };
        });
        const panels = ['[data-testid="window-shell"]','[data-testid="sidebar"]','[data-testid="workspace-area"]','[data-testid="preview-pane"]','[data-testid="composer"]'];
        const panelBgs = panels.map((s) => {
          const el = window.__T.q(s);
          const bg = el ? window.__T.effBg(el) : null;
          return { selector: s, bg, luminance: bg ? +window.__T.lum(bg).toFixed(3) : null };
        });
        return {
          theme, iconColors,
          iconsAllNeutral: iconColors.length > 0 && iconColors.every((c) => c.replace(/\\s/g, '') === 'rgb(138,145,158)'),
          contrast,
          minContrast: Math.min(...contrast.filter((c) => c.ratio !== null).map((c) => c.ratio)),
          panelBgs,
          noLightPanels: panelBgs.every((p) => p.luminance === null || p.luminance < 0.5),
          docOk: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          bodyOk: document.body.scrollWidth <= document.body.clientWidth,
        };
      })()`);
      ctx.record("G4_G3_G6_深色模式", dark);

      ctx.assert("G4 图标统一 --icon-neutral 且不随主题变化", {
        浅色全为8A919E: light.iconColors.length > 0 && light.iconColors.every((c) => c.replace(/\s/g, "") === "rgb(138,145,158)"),
        深色全为8A919E: dark.iconsAllNeutral === true,
        深浅一致: JSON.stringify(light.iconColors) === JSON.stringify(dark.iconColors),
      });
      ctx.assert("G3 深色模式主要文字对比度 ≥ 4.5:1", {
        已切到深色: dark.theme === "dark",
        最低对比度达标: dark.minContrast >= 4.5,
        逐项: dark.contrast.filter((c) => c.ratio !== null && c.ratio < 4.5).length === 0,
      });
      ctx.assert("G6 无横向滚动条（浅色/深色）", {
        浅色document无溢出: light.docOk === true,
        浅色body无溢出: light.bodyOk === true,
        深色document无溢出: dark.docOk === true,
        深色body无溢出: dark.bodyOk === true,
      });

      // 还原浅色
      await cdp.eval("window.__T.q('[data-testid=\"titlebar-toggle-theme\"]').click(); true");
      await sleep(300);
    }

    /* ---------------------------------------------------------------- 2-2 虚拟滚动（压力会话） */
    {
      await ctx.open("/?stress=600");
      await cdp.eval(HELPERS);
      await sleep(1200);
      const r = await cdp.eval(`(() => {
        const list = window.__T.q('[data-testid="message-list"]');
        const items = window.__T.qa('[data-testid="message-item"]');
        const inner = list.firstElementChild;
        // 加载后列表会自动贴底（见 2-5），所以 beforeTop 本来就接近底部 ——
        // 断言不能假设「从顶部开始」，要看**是否真的滚到了目标位置**。
        const beforeTop = Math.round(list.scrollTop);
        const targetTop = Math.round(list.scrollHeight / 2);
        list.scrollTop = targetTop;
        return {
          totalCount: +list.dataset.totalCount,
          rendered: items.length,
          innerHeight: inner ? Math.round(inner.getBoundingClientRect().height) : null,
          listClientHeight: list.clientHeight,
          maxScrollTop: Math.round(list.scrollHeight - list.clientHeight),
          beforeTop, targetTop,
          scrollable: list.scrollHeight > list.clientHeight,
        };
      })()`);
      await sleep(600);
      const after = await cdp.eval(`(() => {
        const list = window.__T.q('[data-testid="message-list"]');
        const items = window.__T.qa('[data-testid="message-item"]');
        return {
          scrollTop: Math.round(list.scrollTop),
          rendered: items.length,
          indexRange: items.map((el) => +el.dataset.index),
          stillWrappedInList: items.every((el) => list.contains(el)),
          noHorizontalOverflow: list.scrollWidth <= list.clientWidth,
        };
      })()`);
      const idx = after.indexRange;
      ctx.record("2-2_虚拟滚动（stress=600）", { 初始: r, 滚到中部后: after });
      ctx.assert("2-2 虚拟滚动生效（600 条消息，实际渲染远小于总数）", {
        总数是600: r.totalCount === 600,
        初始渲染数远小于总数: r.rendered > 0 && r.rendered < 100,
        滚动后渲染数仍远小于总数: after.rendered > 0 && after.rendered < 100,
        滚动位置落在目标附近: Math.abs(after.scrollTop - r.targetTop) <= 2000,
        确实换了一批节点: idx.length > 0 && idx[0] > 0 && idx[idx.length - 1] < 599,
        内容总高远大于视口: r.innerHeight > r.listClientHeight * 10,
        滚动后仍在容器内: after.stillWrappedInList === true,
        无横向溢出: after.noHorizontalOverflow === true,
      });
    }

    const summary = ctx.save("_m2-evidence.json");
    if (summary.failed > 0) process.exitCode = 1;
  },
);

console.log("\n提示：M1 的 13 条回归需另行运行 npm run accept:m1 验证。");
