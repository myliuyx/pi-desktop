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
  // store 句柄（task-composer-inline-toolbar.md 2-15 三档颜色注入用）：DEV 形态下
  // chat-store 把实例挂到 window.__chatStore（live 形态同挂），5182 dev server 恒可用
  store: () => {
    const s = window.__chatStore && window.__chatStore.getState ? window.__chatStore.getState() : null;
    if (!s) throw new Error("window.__chatStore 不存在（m2 需要 DEV 形态的 dev server）");
    return s;
  },
  setUsage: (u) => { window.__chatStore.setState({ tokenUsage: u }); return true; },
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

    /*
     * ⚠️ `?mcp=1`（2026-09-23 新增）：MCP 已裁决「暂缓」，**默认不渲染**
     * （见 packages/ui/src/lib/feature-flags.ts）。但本脚本 2-11 / 2-12 的断言
     * 写死了三个芯片（含 `composer-chip-mcp`）与高度 `[32,32,32]` ——
     * 那正是本脚本设计时的基线。带 `?mcp=1` 即**精确还原该基线，断言一行都不用改**。
     * 依据：`.plan/archive/pi-survey-plan.md` §五 + S5「MCP 暂缓处置」的「保留 mock 分支供回归」。
     */
    await ctx.open("/?mcp=1");
    await cdp.eval("localStorage.removeItem('sidebar-collapsed'); localStorage.removeItem('preview-collapse'); localStorage.removeItem('preview-collapsed'); true");
    await ctx.open("/?mcp=1");
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

    /* ---------------------------------------------------------------- 2-11 / 2-12 内嵌底行工具条 */
    {
      // 变量名刻意叫 tb（toolbar）：早前把它也叫 r，结果 2-16 的断言引用了
      // 下面用量区那个 r，`undefined >= 1` 恒为 false —— 假失败。
      // 内嵌底行（task-composer-inline-toolbar.md）：原「输入框下方独立工具条」
      // 已迁入 composer 边框内部；左簇（+ / 环）是 composer-toolbar 的兄弟节点。
      const tb = await cdp.eval(`(() => {
        const row = window.__T.q('[data-testid="composer-bottom-row"]');
        const composer = window.__T.q('[data-testid="composer"]');
        const toolbar = window.__T.q('[data-testid="composer-toolbar"]');
        const childrenOf = (el) => (el ? [...el.children].map((n) => n.dataset.testid || n.tagName.toLowerCase()) : null);
        const chips = ['composer-chip-model','composer-chip-thinking','composer-chip-mcp'].map((id) => {
          const el = window.__T.q('[data-testid="' + id + '"]');
          return { id, exists: !!el, height: el ? +el.getBoundingClientRect().height.toFixed(2) : null, text: el ? el.innerText.trim() : null };
        });
        return {
          rowTestid: row ? row.dataset.testid : null,
          rowInsideComposer: !!(composer && row && composer.contains(row)),
          rowOrder: childrenOf(row),
          order: childrenOf(toolbar),
          chips,
          chipHeights: chips.map((c) => c.height),
          allChips32: chips.every((c) => Math.abs(c.height - 32) < 0.6),
        };
      })()`);
      ctx.record("2-11_2-12_内嵌底行工具条", tb);
      ctx.assert("2-11 内嵌底行顺序：+ → 上下文环 → 工具条（模型 → 思考强度 → MCP）", {
        底行在输入框边框内: tb.rowInsideComposer === true,
        底行顺序正确: JSON.stringify(tb.rowOrder) === JSON.stringify(["composer-plus", "composer-context-ring", "composer-toolbar"]),
        工具条顺序正确: JSON.stringify(tb.order) === JSON.stringify(["composer-chip-model", "composer-chip-thinking", "composer-chip-mcp"]),
        三个芯片都在: tb.chips.every((c) => c.exists),
      });
      ctx.assert("2-12 工具条芯片高 32", {
        三个芯片均为32: tb.allChips32 === true,
        实测高度: JSON.stringify(tb.chipHeights) === JSON.stringify([32, 32, 32]),
      });
    }

    /* ---------------------------------------------------------------- 2-13 ~ 2-16 上下文占用环 */
    {
      // 内嵌底行（task-composer-inline-toolbar.md D1=A1）：原 TokenStats 四段退役，
      // 「消耗」的行内代言改为上下文占用环；明细面板收进悬停浮框
      // （task-context-ring-token-popover.md，2-14 断言；原生 title 已退役）。
      const r = await cdp.eval(`(() => {
        const composer = window.__T.q('[data-testid="composer"]');
        const ring = window.__T.q('[data-testid="composer-context-ring"]');
        const value = window.__T.q('[data-testid="composer-context-ring-value"]');
        const row = window.__T.q('[data-testid="composer-bottom-row"]');
        const toolbar = window.__T.q('[data-testid="composer-toolbar"]');
        const plus = window.__T.q('[data-testid="composer-plus"]');
        const ws = window.__T.q('[data-testid="workspace-area"]');
        return {
          exists: !!ring,
          insideComposer: !!(composer && ring && composer.contains(ring)),
          hasSvg: !!(ring && ring.querySelector('svg')),
          valueText: value ? value.textContent.trim() : null,
          valueColor: value ? getComputedStyle(value).color : null,
          title: ring ? (ring.getAttribute('title') || '') : null,
          composer: composer ? window.__T.rect(composer) : null,
          row: row ? window.__T.rect(row) : null,
          plus: plus ? window.__T.rect(plus) : null,
          toolbar: toolbar ? window.__T.rect(toolbar) : null,
          wsOverflowX: ws.scrollWidth > ws.clientWidth,
        };
      })()`);
      ctx.record("2-13_2-14_上下文环", r);
      ctx.assert("2-13 上下文环结构（svg 圆环 + 数值，位于输入框边框内左簇）", {
        环存在: r.exists === true,
        在composer边框内: r.insideComposer === true,
        含svg圆环: r.hasSvg === true,
        数值节点存在: r.valueText !== null && r.valueText !== "",
      });
      ctx.assert("2-14 环数值口径（mock 合成 contextTokens = total → 14.5%）", {
        "环值14.5%": r.valueText === "14.5%",
      });

      // 2-14 悬停浮框（task-context-ring-token-popover.md）：原生 title 退役，明细面板
      // hover 即显 / 移出即收。React 的 onMouseEnter 由 mouseover 合成——显式派发
      // （bubbles:true）；关闭派发 mouseout 且 relatedTarget 指向非后裔（document.body）。
      // 注入带累计字段的 usage 断言各行文案（累计口径 D1），再注入旧形状断言降级
      // （D3 费用隐藏 + 回退最近一次）。⚠️ 派发与读面板拆开、中间 sleep：React 重渲染
      // 是调度式的（同 2-15 的 setUsage 手法）。
      await cdp.eval(`window.__T.setUsage({
        input: 12400, output: 6200, total: 18600, contextWindow: 128000, contextTokens: 18600,
        inputSum: 30584, outputSum: 8263, cacheReadSum: 441258, costTotal: 0.0217,
      })`);
      await sleep(150);
      await cdp.eval(`document.querySelector('[data-testid="composer-context-ring"]')
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
      await sleep(150);
      const pop = await cdp.eval(`(() => {
        const text = (id) => {
          const el = window.__T.q('[data-testid="composer-token-row-' + id + '"]');
          return el ? el.textContent.trim() : null;
        };
        return {
          exists: !!window.__T.q('[data-testid="composer-token-popover"]'),
          input: text('input'), output: text('output'), cacheRead: text('cache-read'),
          cacheWrite: text('cache-write'), total: text('total'), cost: text('cost'),
          context: text('context'), hitRate: text('hit-rate'),
        };
      })()`);
      await cdp.eval(`document.querySelector('[data-testid="composer-context-ring"]')
        .dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))`);
      await sleep(150);
      const popClosed = await cdp.eval(`!window.__T.q('[data-testid="composer-token-popover"]')`);
      // 降级：旧形状（无 sums / 无 costTotal）→ 费用与缓存行隐藏、命中率隐藏、
      // 输入/输出回退「最近一次」值（12,400 / 6,200）
      await cdp.eval("window.__T.setUsage({ input: 12400, output: 6200, total: 18600, contextWindow: 128000, contextTokens: 18600 })");
      await sleep(150);
      await cdp.eval(`document.querySelector('[data-testid="composer-context-ring"]')
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
      await sleep(150);
      const popDegrade = await cdp.eval(`(() => {
        const text = (id) => {
          const el = window.__T.q('[data-testid="composer-token-row-' + id + '"]');
          return el ? el.textContent.trim() : null;
        };
        return { input: text('input'), cost: text('cost'), cacheRead: text('cache-read'), hitRate: text('hit-rate') };
      })()`);
      // 还原 mock 初始用量（INITIAL_TOKEN_USAGE，含累计演示字段），不污染后续断言
      await cdp.eval("window.__T.setUsage({ input: 12400, output: 6200, total: 18600, contextWindow: 128000, contextTokens: 18600, inputSum: 12400, outputSum: 6200, costTotal: 0.0217 })");
      await sleep(150);
      ctx.record("2-14_悬停浮框", { pop, popClosed, popDegrade });
      ctx.assert("2-14 悬停浮框：hover 开合 + 各行文案（累计口径）", {
        浮框随hover出现: pop.exists === true,
        输入行: pop.input.includes("30,584"),
        输出行: pop.output.includes("8,263"),
        缓存读取行: pop.cacheRead.includes("441,258"),
        缓存写入行缺省隐藏: pop.cacheWrite === null,
        总计行: pop.total.includes("18,600"),
        费用行: pop.cost.includes("$0.0217"),
        上下文行: pop.context.includes("14.5% / 128k"),
        命中率行: pop.hitRate.includes("93.5%"),
        移出即收: popClosed === true,
      });
      ctx.assert("2-14 悬停浮框降级：缺省行隐藏 + 回退最近一次", {
        降级费用行隐藏: popDegrade.cost === null,
        降级缓存读取行隐藏: popDegrade.cacheRead === null,
        降级命中率行隐藏: popDegrade.hitRate === null,
        降级输入回退最近一次: popDegrade.input.includes("12,400"),
      });

      // 2-15 三档颜色：经 store 注入三档 tokenUsage（占比 0.5 / 0.75 / 0.95，窗口不变）。
      // ⚠️ setUsage 与读色必须拆成两次 eval 中间 sleep：React 对 store 变更的重渲染是
      // 调度式的，同一 eval 里改完立刻读会拿到旧颜色（假失败）。
      const toneTable = [
        ["0.5", "text-text-tertiary"],
        ["0.75", "text-warning"],
        ["0.95", "text-danger"],
      ];
      const toneResults = [];
      for (const [ratio, cls] of toneTable) {
        await cdp.eval(`window.__T.setUsage({ input: 0, output: 0, total: 0, contextWindow: 128000, contextTokens: Math.round(128000 * ${ratio}) })`);
        await sleep(150);
        const one = await cdp.eval(`(() => {
          const value = window.__T.q('[data-testid="composer-context-ring-value"]');
          return {
            text: value ? value.textContent.trim() : null,
            color: value ? getComputedStyle(value).color : null,
            probe: window.__T.probe('${cls}'),
          };
        })()`);
        toneResults.push({ ratio, cls, ...one });
      }
      // 还原 mock 初始用量（INITIAL_TOKEN_USAGE），不污染后续断言
      await cdp.eval("window.__T.setUsage({ input: 12400, output: 6200, total: 18600, contextWindow: 128000, contextTokens: 18600 })");
      await sleep(150);
      ctx.record("2-15_环三档颜色", toneResults);
      ctx.assert("2-15 环颜色三档：≥90% danger / ≥70% warning / 其余中性", {
        "中性档50%": toneResults[0].color === toneResults[0].probe,
        "警示档75%": toneResults[1].color === toneResults[1].probe,
        "危险档95%": toneResults[2].color === toneResults[2].probe,
        注入后数值随动: toneResults[1].text === "75%",
      });

      // 2-16 几何（原「弹性占位」结构断言随 TokenStats 退役）：左簇贴输入框内容左缘
      // （边框 1 + padding 12 = 13），工具条右缘距内容右缘一个发送净空
      // （边框 1 + COMPOSER_ROW_SEND_CLEARANCE 40 = 41）。
      ctx.record("2-16_底行几何", {
        composer: r.composer, row: r.row, plus: r.plus, toolbar: r.toolbar,
        plusInset: r.plus ? +(r.plus.left - r.composer.left).toFixed(2) : null,
        toolbarClearance: r.toolbar ? +(r.composer.right - r.toolbar.right).toFixed(2) : null,
      });
      ctx.assert("2-16 底行几何：左簇贴左、工具条贴右净空、无横向溢出", {
        加号贴左缘: Math.abs(r.plus.left - r.composer.left - 13) <= 2.5,
        工具条右净空: Math.abs(r.composer.right - r.toolbar.right - 41) <= 2.5,
        无横向溢出: r.wsOverflowX === false,
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
        // 上限的真身是 textarea（COMPOSER_MAX_HEIGHT=200 钳死，内部滚动承接溢出）；
        // 盒子总高 = textarea 200 + 内嵌底行 ~44 + 边框 2 ≈ 246（内嵌底行批次
        // task-composer-inline-toolbar.md 上修，旧口径 240 只认「无底行的盒子」）
        十行未超上限: h10.inputClientHeight <= 200.5 && h10.composerHeight <= 260,
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

      /*
       * 2-5c 上滚后**被动**收到新消息不拽走（关键反例）。
       *
       * ⚠️ 2026-10-01 语义拆分（发送即回底批次）：原 2-5c 是「上滚状态下**发消息**，
       * 新消息到达不得拽走视口」—— 该语义被「发送即回底」需求**明确推翻**
       * （用户主动重新提问 ⇒ 视口必须回最新位置），改写前先把两个场景切开：
       *   · 2-5c = 被动接收（流式增量 / 工具事件）→ 不得拽走（**契约不变**）
       *   · 2-5f = 主动发送（用户点了发送）→ 必须回底（**新增契约**）
       * 为让断言只测「视口反应」而不掺流式时序，本步用 store 直接注入一条
       * user 消息模拟「新消息到达」，再把真实发送留给 2-5f。
       */
      const c0 = await cdp.eval(`(() => {
        const list = window.__T.q('[data-testid="message-list"]');
        const s = window.__T.scroll(list);
        return { dataAtBottom: list.dataset.atBottom, scrollTop: s.top, dist: s.dist, totalCount: +list.dataset.totalCount };
      })()`);
      await cdp.eval(`(() => {
        // window.__chatStore 是 zustand store **实例**（chat-store 底部 DEV 挂载），
        // setState 在实例上而非 getState() 快照上 —— 探针别写成 st.messages 后调 setState。
        const store = window.__chatStore;
        const now = Date.now();
        const extra = { id: 'probe-passive', role: 'user', timestamp: now, blocks: [{ type: 'text', content: '被动到达的测试消息' }] };
        store.setState({ messages: [...store.getState().messages, extra] });
        return true;
      })()`);
      await sleep(600);
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
      ctx.record("2-5_上滚时被动收到新消息", { 注入前: c0, 注入后: c });
      ctx.assert("2-5c 上滚状态下被动收到新消息不强制滚底（反例）", {
        消息数已增加: c.totalCount > c0.totalCount,
        距底因新内容变大: c.dist > c0.dist,
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

      /*
       * 2-5f 上滚状态下**主动发送** → 视口必须回到底部（2026-10-01 新增契约）。
       *
       * 与 2-5c 成对，二者共同定义「主动发起 vs 被动接收」的语义边界：
       * 用户自己点发送 = 明确表达了「我要看最新回复」⇒ 拽到底部是响应而非打扰；
       * 而回看历史时陆续到达的流式增量 = 打扰，仍须守住 2-5c。
       *
       * 断言两段：① 发送后**立刻**（不等流式结束）就该回底 —— 这是本需求的
       *    核心体感（点完发送视口就跳，不该让人盯着顶部猜发出没发出去）；
       * ② 之后整轮流式期间持续贴底（末态 dist ≤ 阈值），验证增量自动贴底接管。
       */
      await cdp.eval(`(() => { const list = window.__T.q('[data-testid="message-list"]'); list.scrollTop = 0; return true; })()`);
      await sleep(400);
      const f0 = await cdp.eval(`(() => {
        const list = window.__T.q('[data-testid="message-list"]');
        const s = window.__T.scroll(list);
        return { scrollTop: s.top, dist: s.dist, dataAtBottom: list.dataset.atBottom, totalCount: +list.dataset.totalCount };
      })()`);
      await cdp.eval(`(() => {
        const input = window.__T.q('[data-testid="composer-input"]');
        window.__T.setText(input, '上滚状态下主动发送的测试消息');
        return true;
      })()`);
      await sleep(200);
      await cdp.eval("window.__T.q('[data-testid=\"composer-send\"]').click(); true");
      await sleep(260);
      const f1 = await cdp.eval(`(() => {
        const list = window.__T.q('[data-testid="message-list"]');
        const s = window.__T.scroll(list);
        return { scrollTop: s.top, dist: s.dist, dataAtBottom: list.dataset.atBottom };
      })()`);
      await sleep(2800);
      const f2 = await cdp.eval(`(() => {
        const list = window.__T.q('[data-testid="message-list"]');
        const s = window.__T.scroll(list);
        return { scrollTop: s.top, dist: s.dist, dataAtBottom: list.dataset.atBottom, totalCount: +list.dataset.totalCount };
      })()`);
      ctx.record("2-5_上滚后主动发送", { 发送前: f0, 发送后260ms: f1, 流式结束: f2 });
      ctx.assert("2-5f 上滚状态下主动发送回到底部，且整轮流式持续贴底", {
        发送前确实在顶部: f0.scrollTop <= 40 && f0.dataAtBottom === "false",
        发送前距底远超阈值: f0.dist > 32,
        发送后立刻回底: f1.dist <= 32,
        发送后状态变true: f1.dataAtBottom === "true",
        流式结束仍贴底: f2.dist <= 32,
        流式期间消息数已增加: f2.totalCount > f0.totalCount,
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

    /* ---------------------------------------------------------------- 2-6 上滚无自发跳变 */
    /*
     * 上滚时视口不得「回弹」（2026-10-01 新增）。
     *
     * 缺陷形态：虚拟列表对未渲染行用 estimateSize 估算（上滚进入新区域时由140px
     * 回填真实高度，总高缩水数千 px），scrollTop 被浏览器连带拽动 —— 表现为
     * 往上滚着突然被弹回去。内置补偿本应修正它，但自研 ResizeObserver 与
     * 内置补偿在同一帧抢写 scrollTop，互相踩掉。
     *
     * 测法（rAF 高频采样 + 用户意图标记）：从底部向上快速滚动，逐帧记录
     * scrollTop；标为「非用户输入」帧里若出现**向下**跳动（top 变大），
     * 即是被动拽动。向上滚（top 变小）本身是用户意图，不算。
     */
    {
      // ⚠️ 必须切到 stress=600（600 条消息）才能触发高度缩水：
      // 默认 mock 只有 12 条，整列表高度 < 视口，滚不动也测不出跳变（实测 total=12 时
      // 采样到的全是用户帧，passivePulls 恒 0 —— 假通过）。stress 形态下未渲染行
      // 以 estimateSize 估算、滚动到才回填真实高度，总高缩水数千 px 才会被拽。
      await ctx.open("/?stress=600");
      await sleep(1600);
      const g = await cdp.eval(`(async () => {
        const list = window.__T.q('[data-testid="message-list"]');
        list.scrollTop = list.scrollHeight;
        await new Promise(r => setTimeout(r, 900));
        return { atBottom: list.dataset.atBottom, total: +list.dataset.totalCount, h: list.scrollHeight };
      })()`, true);
      // 采样器：记录所有变化帧，并标注该帧之前是否有真实用户交互
      await cdp.eval(`(() => {
        const list = window.__T.q('[data-testid="message-list"]');
        window.__jumps = [];
        let prev = list.scrollTop;
        let userIntent = false;
        const mark = () => { userIntent = true; };
        list.addEventListener('wheel', mark, { passive: true });
        list.addEventListener('touchstart', mark, { passive: true });
        const tick = () => {
          const top = list.scrollTop;
          if (Math.abs(top - prev) > 1) {
            window.__jumps.push({ from: Math.round(prev), to: Math.round(top), user: userIntent });
            prev = top;
            userIntent = false;
          }
          if (!window.__doneSampling) requestAnimationFrame(tick);
        };
        window.__doneSampling = false;
        requestAnimationFrame(tick);
        return true;
      })()`);
      // 快速向上滚动（每轮较大delta，复现真实滚轮惯性）
      const { cx, cy } = await cdp.eval(`(() => {
        const r = window.__T.q('[data-testid="message-list"]').getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      })()`);
      for (let i = 0; i < 20; i++) {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel", x: cx, y: cy, deltaX: 0, deltaY: -500, pointerType: "mouse",
        });
        await sleep(40);
      }
      await sleep(900);
      const h = await cdp.eval(`(async () => {
        window.__doneSampling = true;
        const list = window.__T.q('[data-testid="message-list"]');
        const jumps = window.__jumps;
        // 被动拽动：非用户输入帧里 top 反而变大（往上滚时被往下拉）
        const passivePulls = jumps.filter(j => !j.user && j.to > j.from);
        return {
          totalFrames: jumps.length,
          passivePulls: passivePulls.length,
          maxPull: passivePulls.reduce((m, j) => Math.max(m, j.to - j.from), 0),
          samples: passivePulls.slice(0, 5),
        };
      })()`, true);
      ctx.record("2-6_上滚跳变采样", { 起点: g, 采样结果: h });
      ctx.assert("2-6 上滚过程中无自发跳变（无回弹）", {
        "数据量足够（能触发高度重算）": g.total >= 500 && g.h > 40000,
        "有滚动发生（采样非空）": h.totalFrames > 0,
        "无被动向下拽动": h.passivePulls === 0,
        "单次拽动幅度为0": h.maxPull === 0,
      });
      await ctx.open("/");
      await sleep(1200);
    }

    /* ---------------------------------------------------------------- 2-7 切换会话必贴底 */
    /*
     * 从会话 A 滚到顶后切到会话 B，B 必须贴底看最新（2026-10-01 新增）。
     *
     * 缺陷形态：MessageList 在切会话时不重挂，React 复用同一滚动容器 →
     * 浏览器保留 A 的 scrollTop（实测继承为 0），B 于是开在顶部看历史开头。
     * 同时 atBottomRef 残留 A 的 false，自动贴底门被关，回不来。
     */
    {
      const r = await cdp.eval(`(() => {
        const list = window.__T.q('[data-testid="message-list"]');
        list.scrollTop = 0;
        return { scrolledTop: Math.round(list.scrollTop), atBottom: list.dataset.atBottom };
      })()`);
      await sleep(400);
      const before = await cdp.eval(`(() => {
        const list = window.__T.q('[data-testid="message-list"]');
        const s = window.__T.scroll(list);
        return { top: s.top, dist: s.dist, dataAtBottom: list.dataset.atBottom };
      })()`);
      // mock 形态没有真实会话切换，用 store 直接换 messages 模拟「切到另一个会话」
      // （live 链路的真实切换由 2-7-live 探针覆盖；这里锁渲染层的重挂语义）
      await cdp.eval(`(() => {
        // ⚠️ 先备份再改：2-7 把messages 换成截断版，若不恢复会污染后续用例
        // （实测会连带打挂 G7 的 terminal-toggle 查找 —— 它需要真实会话里的终端块）
        const store = window.__chatStore;
        window.__backupMessages = store.getState().messages;
        window.__backupSessionId = store.getState().liveSessionId;
        const cur = store.getState();
        // ⚠️ 必须同时改 liveSessionId：WorkspaceArea 的 key={liveSessionId} 靠它重挂，
        // 只改 messages 不改 id 测不到重挂路径。
        const other = cur.messages.slice(0, Math.max(2, Math.floor(cur.messages.length / 2)))
          .map(m => ({ ...m, id: 'swapped-' + m.id }));
        store.setState({ messages: other, liveSessionId: 'probe-switched-session' });
        return true;
      })()`);
      await sleep(900);
      const after = await cdp.eval(`(() => {
        const list = window.__T.q('[data-testid="message-list"]');
        const s = window.__T.scroll(list);
        return { top: s.top, dist: s.dist, dataAtBottom: list.dataset.atBottom };
      })()`);
      ctx.record("2-7_切换会话前后", { 切换前滚到顶: before, 切换后: after });
      ctx.assert("2-7 切换会话后视口贴底看最新", {
        "切换前确实在顶部": before.top <= 40 && before.dataAtBottom === "false",
        "切换后距底在阈值内": after.dist <= 32,
        "切换后状态变true": after.dataAtBottom === "true",
        "切换后不再是旧位置": after.top > 40,
      });
      // 还原真实会话（后续 G7 等用例依赖它，见上方备份注释）
      await cdp.eval(`(() => {
        const store = window.__chatStore;
        store.setState({ messages: window.__backupMessages, liveSessionId: window.__backupSessionId ?? null });
        return true;
      })()`);
      await sleep(400);
    }

    /* ---------------------------------------------------------------- 2-8 首屏布局稳定（无开场跳变） */
    /*
     * 首屏不得出现「内容出现 → 画面剧烈上跳 → 才稳定」（2026-10-01 新增）。
     *
     * 缺陷实测（248 条真实会话）：首帧只有 ~34 行被估算，totalSize 是估算堆出来的；
     * 随后测量回填使总高缩水、已写入的 scrollTop 被连带拽走 —— 实测内容出现后
     * 194ms 内被拽 3877px。遮罩撤除前测量已完成，撤除后不该再有跳动。
     *
     * 测法：在文档创建前注入 rAF 采样器（早于 React 挂载），逐帧记录 scrollTop；
     * 遮罩存在期间的滚动属于「未就绪」不计，遮罩消失后的**任意**跳动即失败。
     */
    {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
          window.__boot = { started: performance.now(), frames: [], sawList: false, overlaySeen: false, overlayOffAt: null };
          (function loop() {
            const list = document.querySelector('[data-testid="message-list"]');
            const overlay = document.querySelector('[data-testid="layout-settling"]');
            if (overlay) window.__boot.overlaySeen = true;
            if (list) {
              window.__boot.sawList = true;
              if (!overlay && window.__boot.overlayOffAt === null) window.__boot.overlayOffAt = performance.now();
              window.__boot.frames.push({
                t: Math.round(performance.now() - window.__boot.started),
                top: Math.round(list.scrollTop),
                h: list.scrollHeight,
                settled: !overlay,
                // 顺带采一次遮罩样式（必须趁它还挂着时采，卸载后就读不到了）
                overlayBg: overlay ? getComputedStyle(overlay).backgroundColor : null,
                overlayOpacity: overlay ? getComputedStyle(overlay).opacity : null,
              });
            }
            if (performance.now() - window.__boot.started < 9000) requestAnimationFrame(loop);
          })();
        `,
      });
      await ctx.open("/?stress=600");
      await sleep(9500);
      const boot = await cdp.eval("window.__boot");
      const afterSettled = boot.frames.filter((f) => f.settled);
      // 遮罩撤除后的跳动（真正会伤害观感的）
      const postJumps = [];
      for (let i = 1; i < afterSettled.length; i++) {
        const d = afterSettled[i].top - afterSettled[i - 1].top;
        if (Math.abs(d) > 1) postJumps.push({ t: afterSettled[i].t, d, h: afterSettled[i].h });
      }
      const settledFrames = afterSettled.length;
      /*
       * 防回归：遮罩不得是黑半透明（用户反馈「灰色一闪而过像 bug」）—— 必须是主题色不透明。
       * 样式必须**趁遮罩还挂着时**采（卸载后读不到），所以在上面的 rAF 采样里顺带取。
       */
      const overlaySample = boot.frames.find((f) => f.overlayBg) ?? null;
      const overlayBg = overlaySample ? { bg: overlaySample.overlayBg, opacity: overlaySample.overlayOpacity } : null;
      ctx.record("2-8_首屏布局稳定", {
        见到遮罩: boot.overlaySeen,
        遮罩撤除时刻: boot.overlayOffAt,
        撤除后采样帧数: settledFrames,
        撤除后跳动: postJumps.slice(0, 6),
        遮罩背景: overlayBg,
      });
      ctx.assert("2-8 首屏遮罩存在且撤除后无跳动", {
        "首屏出现遮罩": boot.overlaySeen === true,
        "遮罩已撤除": boot.overlayOffAt !== null,
        "撤除后有采样帧": settledFrames > 0,
        "撤除后无跳动": postJumps.length === 0,
      });
      ctx.assert("2-8b 首屏遮罩为不透明主题色（防黑半透明回归）", {
        "遮罩背景为不透明主题色": overlayBg !== null && !/^rgba\\(.*,\\s*0?\\.\\d+\\)$/.test(overlayBg.bg ?? "") && overlayBg.bg !== "transparent",
        "遮罩初始不透明": overlayBg !== null && Number(overlayBg.opacity) === 1,
      });
      await ctx.open("/");
      await sleep(900);
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
          // token-stats-total 样本随 TokenStats 退役（task-composer-inline-toolbar.md）——
          // 环的中性灰是有意低强调的次要文字，不进「主要文字对比度」清单
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
