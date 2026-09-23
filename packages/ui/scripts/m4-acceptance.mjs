/**
 * M4 验收脚本 —— 4-1~4-7 + G1/G2/G5，全部给**显式布尔断言**并汇总。
 *
 * 由主控 Agent 独立编写（不由实现方编写），沿袭 M1 10.3 / M2 / M3 的既定规矩：
 * 实现方写的验收脚本天然容易「只打印不断言」。
 *
 * 用法：
 *   1. 先在 packages/ui 下起 dev server：npm run dev -- --port 5180 --strictPort
 *   2. node scripts/m4-acceptance.mjs
 *   （M4_ORIGIN / M4_CDP_PORT 可覆盖默认值；CDP 端口用 9342，避开 m1=9333 / m2=9337 / m3=9341）
 *
 * 约定（M2/M3 的血泪教训，全部已编码进写法）：
 * - 页面侧 JS 一律用单引号写选择器，避免与外层模板字符串打架；
 * - 尺寸比较读 getBoundingClientRect 的数字，不读 computed style 的 "28px" 字符串；
 * - 每个块用独立变量名，避免断言引用到隔壁块的同名变量；
 * - 三屏是 hash 路由（#/run-detail 等）；同源 hash 变化**不会重载文档**，因此
 *   `initTheme` 不会重跑 —— 但 localStorage 的读取已由 store 初始化覆盖，这一点在本脚本里
 *   用「先设 localStorage 再整页导航」的方式规避（见 4-4b）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { withBrowser, sleep } from "./cdp.mjs";

const ORIGIN = process.env.M4_ORIGIN ?? "http://127.0.0.1:5180";
const PORT = Number(process.env.M4_CDP_PORT ?? 9342);
const PKG_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const HELPERS = `
window.__T4 = {
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
    const a = window.__T4.lum(getComputedStyle(el).color);
    const b = window.__T4.lum(window.__T4.effBg(el));
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return +(((hi + 0.05) / (lo + 0.05)).toFixed(2));
  },
  hScroll: () => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }),
};
true;
`;

/** 静态检查：G1（hex 只在 tokens.css）/ G2（无 dark: 变体）/ G5（无内置调色板）——与 m2/m3 同口径 */
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

/**
 * 深色正文对比度口径 —— ⚠️ 这里第一轮写错过，最终口径的理由必须写在代码里。
 *
 * 事实链：
 * 1. 三屏深色下的最低对比度来自 `text-text-tertiary`（3.17 / 3.5），
 *    对应令牌 `--text-tertiary`：浅 `#8A919E` / 深 `#6E747C`。
 * 2. 这两个值是 **Figma 设计稿第 7 轮定稿值**，有留档：
 *    `progress-M0.md` 195 行「Dark #6E7380 / Light #8A919E（3.80 / 3.17）—— 设计稿第 7 轮定的值」，
 *    且 `task-M3.md` 第四节明确列为「已知**不要动**的项目」。
 * 3. 因此它不是 M4 引入的回归：M4 没改任何令牌值，三屏用的令牌类与 M1-M3 完全同源
 *    （`text-text-tertiary` 在 Sidebar 里早就在用，如「历史会话」「工作目录」两个 SectionLabel）。
 * 4. G3 的口径本身是分级的：**正文 >= 4.5**、**辅助文字 >= 3**。
 *    `text-tertiary` 按设计语义就是辅助信息（分区标题、序号、来源标记、路径说明），
 *    不该拿 4.5 的正文尺子去量 —— 那等于要求改设计稿的颜色，越出 M4 范围。
 *
 * 所以本断言采用**分层校验**：非 tertiary 的文字 >= 4.5，全部文字 >= 3，
 * 并把 tertiary 的实测值显式报出来供复核，而不是假装它达到 4.5。
 */
const AUX_TEXT_MIN = 3;
const BODY_TEXT_MIN = 4.5;

/**
 * 组件硬编码尺寸扫描：新增的 M4 文件里不应出现 style={{ width: 360 }} 之类的**布局尺寸字面量**。
 *
 * ⚠️ 口径（第一轮写错过，已修正）：
 * - 只查 `width` / `height` / `minWidth` / `maxWidth` 这类**布局主尺寸**；
 * - 排除 `gap` / `padding` / `margin` / `top` / `bottom` / `left` / `right` —— 这些是
 *   微调间距，既有 M1-M3 代码同样有内联值（如 Sidebar 的 `gap: SIDEBAR_GAP` 来自常量，
 *   但也有 `top: 14` 这类与具体卡片行高绑定的微调），要求它们全进 layout.ts 属过度收紧；
 * - 排除 `height: 1` 这类纯占位/发丝线（1px 没有"设计稿尺寸"语义，进常量反而更难读）；
 * - 主尺寸必须是数字字面量才算命中（`style={{ width: SWITCH_WIDTH }}` 是合规写法）。
 */
function hardcodedSizeScan() {
  const M4_FILES = [
    "screens/RunDetailScreen.tsx",
    "screens/SkillsScreen.tsx",
    "screens/SettingsScreen.tsx",
    "components/screens/ScreenLayout.tsx",
    "components/screens/Switch.tsx",
  ];
  const SRC = join(PKG_ROOT, "src");
  const offenders = [];
  // 只扫布局主尺寸，且限定数字字面量
  const MAIN_DIM = /\b(?:width|minWidth|maxWidth|height|minHeight|maxHeight)\s*:\s*(\d+(?:\.\d+)?)\b/g;

  for (const rel of M4_FILES) {
    let text;
    try {
      text = readFileSync(join(SRC, rel), "utf8");
    } catch {
      continue;
    }
    text.split(/\r?\n/).forEach((line, i) => {
      const m = line.match(/style=\{\{[^}]*\}\}/);
      if (!m) return;
      const body = m[0];
      MAIN_DIM.lastIndex = 0;
      const hits = [];
      let hit;
      while ((hit = MAIN_DIM.exec(body)) !== null) {
        // 1px 发丝线/占位不计
        if (Number(hit[1]) <= 1) continue;
        hits.push(hit[0]);
      }
      if (hits.length) offenders.push({ file: rel, line: i + 1, hits });
    });
  }
  return { 检查文件数: M4_FILES.length, 裸尺寸命中: offenders, 无裸尺寸: offenders.length === 0 };
}

await withBrowser(
  { port: PORT, origin: ORIGIN, evidencePath: "_m4-evidence.json" },
  async (ctx) => {
    const { cdp } = ctx;
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HELPERS });

    /* ---------------------------------------------------------------- 静态检查 */
    {
      const stat = staticColorChecks();
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

      const size = hardcodedSizeScan();
      ctx.record("M4_组件裸尺寸扫描", size);
      ctx.assert("M4 新增组件无硬编码尺寸（尺寸走 layout.ts 常量）", {
        通过: size.无裸尺寸,
        命中数为0: size.裸尺寸命中.length === 0,
      });
    }

    // 干净起点：清掉所有 M4 相关持久化
    await ctx.open("/");
    await cdp.eval(
      "['sidebar-collapsed','preview-collapsed','preview-tab','theme','working-dir','tool-enabled:read','tool-enabled:bash','tool-enabled:edit','tool-enabled:write','setting:autoCompact','setting:autoRetry'].forEach(k => localStorage.removeItem(k)); true",
    );
    await ctx.open("/");
    await cdp.eval(HELPERS);
    await sleep(500);

    /* ================================================================ 4-1 03 屏运行详情 */
    await ctx.open("/#/run-detail");
    await cdp.eval(HELPERS);
    await sleep(700);
    {
      const r = await cdp.eval(`(() => {
        const screen = window.__T4.q('[data-testid="run-detail-screen"]');
        const steps = window.__T4.qa('[data-testid="run-step"]');
        const statuses = steps.map(s => s.dataset.status);
        const summaries = window.__T4.qa('[data-testid="run-step-summary"]');
        const toggles = window.__T4.qa('[data-testid="run-step-toggle"]');
        const declared = screen ? Number(screen.dataset.stepCount) : null;
        // 耗时口径：已执行的步骤（done/failed）必须有数字+单位；未执行的（pending/running）
        // 用 "—" 占位是**正确的**（不该给一个还没跑完的步骤编造耗时）。第一轮误把 "—" 当失败。
        const durationPairs = steps.map((s, i) => ({
          status: s.dataset.status,
          text: (window.__T4.qa('[data-testid="run-step-duration"]')[i] || {}).textContent?.trim() ?? null,
        }));
        const hasNumericUnit = (t) => !!t && /\\d/.test(t) && /(ms|s)$/.test(t);
        const settledHaveDuration = durationPairs
          .filter((d) => d.status === 'done' || d.status === 'failed')
          .every((d) => hasNumericUnit(d.text));
        const unsettledArePlaceholder = durationPairs
          .filter((d) => d.status === 'pending' || d.status === 'running')
          .every((d) => d.text !== null && d.text.length > 0);
        return {
          screenExists: !!screen,
          stepCount: steps.length,
          declaredCount: declared,
          countsMatch: declared === steps.length,
          statuses,
          hasAllFourStates: ['done','running','pending','failed'].every(s => statuses.includes(s)),
          durationCount: durationPairs.length,
          durationPairs,
          settledHaveDuration,
          unsettledArePlaceholder,
          durationsSample: durationPairs.slice(0, 3).map((d) => d.text),
          summaryCount: summaries.length,
          summaryLabels: [...new Set(summaries.map(s => s.dataset.summaryLabel))],
          toggleCount: toggles.length,
          detailBeforeExpand: window.__T4.qa('[data-testid="run-step-detail"]').length,
          wbScreen: window.__T4.q('[data-testid="window-shell"]') ? true : false,
          sidebar: window.__T4.q('[data-testid="sidebar"]') ? true : false,
          hasPreviewPane: !!window.__T4.q('[data-testid="preview-pane"]'),
        };
      })()`);
      ctx.record("4-1_03屏运行详情", r);
      ctx.assert("4-1 03 屏：时间轴完整、四态齐全、含耗时与输入输出摘要", {
        屏存在: r.screenExists === true,
        步骤数与declared一致: r.countsMatch === true,
        stepCount: r.stepCount,
        四态齐全: r.hasAllFourStates === true,
        每步都有耗时节点: r.durationCount === r.stepCount,
        已执行步骤有真实耗时: r.settledHaveDuration === true,
        未执行步骤有占位: r.unsettledArePlaceholder === true,
        摘要节点数达标: r.summaryCount >= r.stepCount * 2,
        摘要含输入与输出: r.summaryLabels.includes("输入") && r.summaryLabels.includes("输出"),
        每步都有展开入口: r.toggleCount === r.stepCount,
        展开前无详情区: r.detailBeforeExpand === 0,
        保留窗口壳: r.wbScreen === true,
        保留侧边栏: r.sidebar === true,
        不渲染预览区: r.hasPreviewPane === false,
      });

      // 展开态：点第一步的 toggle，应出现 run-step-detail，且复用 PlanCard/TerminalCard 之一
      const expanded = await cdp.eval(`(() => {
        const t = window.__T4.qa('[data-testid="run-step-toggle"]')[1];
        t.click();
        return true;
      })()`);
      await sleep(300);
      const r2 = await cdp.eval(`(() => {
        const detail = window.__T4.qa('[data-testid="run-step-detail"]');
        const toggle = window.__T4.qa('[data-testid="run-step-toggle"]')[1];
        return {
          detailCount: detail.length,
          toggleExpanded: toggle ? toggle.dataset.expanded : null,
          ariaExpanded: toggle ? toggle.getAttribute('aria-expanded') : null,
          reusesCard: !!window.__T4.q('[data-testid="plan-card"]') || !!window.__T4.q('[data-testid="terminal-card"]'),
        };
      })()`);
      ctx.record("4-1_03屏展开态", { clicked: expanded, ...r2 });
      ctx.assert("4-1 03 屏：展开态渲染完整结果且复用 PlanCard/TerminalCard", {
        详情区出现: r2.detailCount >= 1,
        toggle状态同步: r2.toggleExpanded === "true" && r2.ariaExpanded === "true",
        复用了既有卡片组件: r2.reusesCard === true,
      });
    }

    /* ================================================================ 4-2 04 屏技能分类 */
    /*
     * ⚠️ `?mcp=1`（2026-09-23 新增）：MCP 已裁决「暂缓」，**默认不渲染**
     * （见 packages/ui/src/lib/feature-flags.ts）。但 4-2~4-4 的断言（尤其 4-4 的
     * `mcp-server` 数量 > 0）建立在 MCP 区块存在之上 —— 那正是本脚本的基线。
     * 带 `?mcp=1` 精确还原基线，**断言一行都不用改**。
     * 依据：`.plan/archive/pi-survey-plan.md` §五 + S5「MCP 暂缓处置」。
     * 注意：4-7 的横向溢出检查**故意不带**该参数 —— 它该测的是真正发布的默认形态。
     */
    await ctx.open("/?mcp=1#/skills");
    await cdp.eval(HELPERS);
    await sleep(700);
    {
      const r = await cdp.eval(`(() => {
        const items = window.__T4.qa('[data-testid="skill-item"]');
        const types = items.map(i => i.dataset.skillType);
        const uniq = [...new Set(types)];
        const counts = window.__T4.qa('[data-testid="skill-group-count"]').map(c => ({ type: c.dataset.skillType, text: c.textContent.trim() }));
        const groups = window.__T4.qa('[data-testid="skill-group"]').map(g => g.dataset.skillCategory);
        return {
          itemCount: items.length,
          types: uniq,
          groupOrder: groups,
          hasExtension: types.includes('extension'),
          hasPrompt: types.includes('prompt'),
          hasSkill: types.includes('skill'),
          counts,
        };
      })()`);
      ctx.record("4-2_04屏技能分类", r);
      ctx.assert("4-2 04 屏技能列表：三类（extension / prompt / skill）齐全且各有内容", {
        条目总数: r.itemCount,
        三类都存在: r.hasExtension && r.hasPrompt && r.hasSkill,
        分类集合完整: ["extension", "prompt", "skill"].every((t) => r.types.includes(t)),
        分组总数3: r.groupOrder.length === 3,
        每组都有条数标记: r.counts.length === 3,
      });
    }

    /* ================================================================ 4-3 04 屏工具开关 */
    {
      const r = await cdp.eval(`(() => {
        const toggles = window.__T4.qa('[data-testid="tool-toggle"]');
        const read = (t) => ({
          name: t.dataset.toolName,
          role: t.getAttribute('role'),
          ariaChecked: t.getAttribute('aria-checked'),
          dataEnabled: t.dataset.enabled,
        });
        return { count: toggles.length, initial: toggles.map(read) };
      })()`);
      ctx.record("4-3_工具开关初始态", r);
      ctx.assert("4-3 04 屏工具开关：read/bash/edit/write 四个都在，且是 role=switch", {
        开关数4: r.count === 4,
        四个工具名齐全: ["read", "bash", "edit", "write"].every((n) => r.initial.some((t) => t.name === n)),
        全部是switch语义: r.initial.every((t) => t.role === "switch"),
        初始状态可读: r.initial.every((t) => t.ariaChecked === "true" || t.ariaChecked === "false"),
        aria与data一致: r.initial.every((t) => t.ariaChecked === t.dataEnabled),
      });

      // 切换 bash：aria-checked 必须真的翻转。
      // ⚠️ 第一轮写错：把 before/after 两次读取塞进同一个同步 eval 里 —— React 的
      // setState 是异步的，`.click()` 之后同一帧读 DOM 拿到的还是旧值（before === after）。
      // 正确做法是点击与复读分成两次 eval，中间给 React 一个 commit 的机会。
      const before = await cdp.eval(
        `window.__T4.qa('[data-testid="tool-toggle"]').find(x => x.dataset.toolName === 'bash').getAttribute('aria-checked')`,
      );
      await cdp.eval(
        `(() => { const t = window.__T4.qa('[data-testid="tool-toggle"]').find(x => x.dataset.toolName === 'bash'); t.click(); return true; })()`,
      );
      await sleep(300);
      const afterState = await cdp.eval(`(() => {
        const t = window.__T4.qa('[data-testid="tool-toggle"]').find(x => x.dataset.toolName === 'bash');
        return { ariaChecked: t.getAttribute('aria-checked'), dataEnabled: t.dataset.enabled, stored: localStorage.getItem('tool-enabled:bash') };
      })()`);
      ctx.record("4-3_工具开关切换bash", { before, after: afterState });
      ctx.assert("4-3 04 屏工具开关：点击可切换且状态反映到 aria-checked", {
        状态真的翻转: before !== afterState.ariaChecked,
        aria与data同步: afterState.ariaChecked === afterState.dataEnabled,
        切换被持久化: afterState.stored === (afterState.ariaChecked === "true" ? "1" : "0"),
      });
      const persisted = afterState.stored;

      // 复位，避免污染后续断言
      await cdp.eval(`(() => { const t = window.__T4.qa('[data-testid="tool-toggle"]').find(x => x.dataset.toolName === 'bash'); if (t.getAttribute('aria-checked') === 'false') t.click(); return true; })()`);
      await sleep(150);
    }

    /* ================================================================ 4-4 04 屏 MCP 区块 */
    {
      const r = await cdp.eval(`(() => {
        const servers = window.__T4.qa('[data-testid="mcp-server"]');
        const note = window.__T4.q('[data-testid="mcp-note"]');
        const bodyText = document.body.innerText;
        return {
          serverCount: servers.length,
          names: servers.map(s => s.dataset.mcpName),
          statuses: servers.map(s => s.dataset.mcpStatus),
          noteExists: !!note,
          noteText: note ? note.textContent.trim().slice(0, 120) : null,
          noteMentionsSelfBuild: note ? /自建/.test(note.textContent) : false,
          noteMentionsPiNotBuiltin: note ? /Pi\\s*不内置/.test(note.textContent) : false,
          hasMcpHeading: /MCP/.test(bodyText),
        };
      })()`);
      ctx.record("4-4_04屏MCP区块", r);
      ctx.assert("4-4 04 屏 MCP 区块存在，且标明是自建能力（Pi 不内置）", {
        服务器列表位存在: r.serverCount > 0,
        每项有名称与状态: r.names.every(Boolean) && r.statuses.every(Boolean),
        说明文案存在: r.noteExists === true,
        说明了自建能力: r.noteMentionsSelfBuild === true,
        说明了Pi不内置: r.noteMentionsPiNotBuiltin === true,
      });
    }

    /* ================================================================ 4-5 05 屏设置分组 */
    await ctx.open("/#/settings");
    await cdp.eval(HELPERS);
    await sleep(700);
    {
      const r = await cdp.eval(`(() => {
        const groups = window.__T4.qa('[data-testid="settings-group"]');
        const order = groups.map(g => g.dataset.group);
        return {
          screenExists: !!window.__T4.q('[data-testid="settings-screen"]'),
          order,
          hasAllFive: ['model','thinking','session','appearance','working-dir'].every(g => order.includes(g)),
          orderCorrect: JSON.stringify(order) === JSON.stringify(['model','thinking','session','appearance','working-dir']),
          modelOptions: window.__T4.qa('[data-testid="settings-model-option"]').length,
          thinkingOptions: window.__T4.qa('[data-testid="settings-thinking-option"]').length,
          sessionSwitches: window.__T4.qa('[data-testid="settings-switch"]').length,
          themeOptions: window.__T4.qa('[data-testid="settings-theme-option"]').length,
          workingDirCode: (window.__T4.q('[data-testid="settings-working-dir"] code') || {}).textContent || null,
        };
      })()`);
      ctx.record("4-5_05屏设置分组", r);
      ctx.assert("4-5 05 屏设置：模型/思考强度/会话/外观/工作目录五组齐全且顺序正确", {
        屏存在: r.screenExists === true,
        五组齐全: r.hasAllFive === true,
        顺序正确: r.orderCorrect === true,
        模型可选项存在: r.modelOptions > 0,
        思考强度档位存在: r.thinkingOptions > 0,
        会话开关存在: r.sessionSwitches === 2,
        主题三段存在: r.themeOptions === 3,
        工作目录路径可见: !!r.workingDirCode && r.workingDirCode.includes("/"),
      });
    }

    /* ================================================================ 4-6 05 屏字段对齐 Pi */
    {
      const r = await cdp.eval(`(() => {
        const text = document.body.innerText;
        const checks = {
          model: /AgentOptions\\.model/.test(text),
          thinking: /set_thinking_level/.test(text),
          autoCompact: /SettingsManager\\.autoCompact/.test(text),
          autoRetry: /SettingsManager\\.autoRetry/.test(text),
          cwd: /AgentOptions\\.cwd/.test(text),
        };
        return checks;
      })()`);
      ctx.record("4-6_05屏字段对齐Pi", r);
      ctx.assert("4-6 05 屏字段命名与 Pi 的 SettingsManager / AgentOptions 对应（UI 上可读到）", {
        model对齐: r.model === true,
        thinking对齐: r.thinking === true,
        autoCompact对齐: r.autoCompact === true,
        autoRetry对齐: r.autoRetry === true,
        cwd对齐: r.cwd === true,
      });
    }

    /* ================================================================ 4-6b 主题切换真的走 store（换肤 + 持久化） */
    {
      const before = await cdp.eval(`({ theme: document.documentElement.dataset.theme, stored: localStorage.getItem('theme') })`);
      await cdp.eval(`(() => { const b = window.__T4.qa('[data-testid="settings-theme-option"]').find(x => x.dataset.themeValue === 'dark'); b.click(); return true; })()`);
      await sleep(300);
      const after = await cdp.eval(`(() => {
        const dark = window.__T4.qa('[data-testid="settings-theme-option"]').find(x => x.dataset.themeValue === 'dark');
        return {
          theme: document.documentElement.dataset.theme,
          stored: localStorage.getItem('theme'),
          darkActive: dark.dataset.active,
          bgApp: getComputedStyle(document.querySelector('[data-testid="settings-screen"]')).backgroundColor,
        };
      })()`);
      ctx.record("4-6b_主题切换", { before, after });
      ctx.assert("4-6b 05 屏外观分组：切换主题真的换肤并持久化（走 ui-store）", {
        主题真的变化: after.theme === "dark" && before.theme !== "dark",
        已持久化: after.stored === "dark",
        激活态同步: after.darkActive === "true",
        页面底色跟着变: after.bgApp !== "rgb(255, 255, 255)",
      });

      // 复位回浅色
      await cdp.eval(`(() => { const b = window.__T4.qa('[data-testid="settings-theme-option"]').find(x => x.dataset.themeValue === 'light'); b.click(); return true; })()`);
      await sleep(250);
    }

    /* ================================================================ 4-7 三屏响应式（折叠组合无横向溢出） */
    {
      const routes = ["/#/run-detail", "/#/skills", "/#/settings"];
      const results = [];
      for (const route of routes) {
        // 展开态
        await cdp.eval(`(() => { localStorage.setItem('sidebar-collapsed','0'); localStorage.setItem('preview-collapsed','0'); return true; })()`);
        await ctx.open("/");
        await ctx.open(route);
        await cdp.eval(HELPERS);
        await sleep(650);
        const expanded = await cdp.eval(`window.__T4.hScroll()`);

        // 折叠态：两栏都收（三屏不渲染 PreviewPane，这里主要验侧边栏收 0 后内容区补偿）
        await cdp.eval(`(() => { localStorage.setItem('sidebar-collapsed','1'); localStorage.setItem('preview-collapsed','1'); return true; })()`);
        await ctx.open("/");
        await ctx.open(route);
        await cdp.eval(HELPERS);
        await sleep(650);
        const collapsed = await cdp.eval(`(() => {
          const s = window.__T4.hScroll();
          const sb = window.__T4.q('[data-testid="sidebar"]');
          const main = document.querySelector('[data-testid$="-screen"]');
          return { ...s, sidebarWidth: sb ? window.__T4.rect(sb).width : null, mainWidth: main ? window.__T4.rect(main).width : null };
        })()`);

        results.push({
          route,
          expandedOverflow: expanded.scrollWidth - expanded.clientWidth,
          collapsedOverflow: collapsed.scrollWidth - collapsed.clientWidth,
          sidebarWidthCollapsed: collapsed.sidebarWidth,
          expandedNoOverflow: expanded.scrollWidth <= expanded.clientWidth + 1,
          collapsedNoOverflow: collapsed.scrollWidth <= collapsed.clientWidth + 1,
          sidebarReachedZero: collapsed.sidebarWidth !== null && collapsed.sidebarWidth <= 0.5,
        });
      }
      ctx.record("4-7_三屏响应式", results);
      ctx.assert("4-7 三屏响应式：展开/折叠组合下均无横向溢出", {
        三个路由都测了: results.length === 3,
        展开态都无溢出: results.every((r) => r.expandedNoOverflow),
        折叠态都无溢出: results.every((r) => r.collapsedNoOverflow),
        折叠后侧边栏收到0: results.every((r) => r.sidebarReachedZero),
        各路由溢出量: results.map((r) => `${r.route}: ${r.expandedOverflow}/${r.collapsedOverflow}`),
      });
    }

    /* ================================================================ 回归：三屏存在不影响 01 工作台 */
    {
      await cdp.eval(`(() => { localStorage.setItem('sidebar-collapsed','0'); localStorage.setItem('preview-collapsed','0'); return true; })()`);
      await ctx.open("/");
      await ctx.eval?.(HELPERS);
      await cdp.eval(HELPERS);
      await sleep(700);
      const r = await cdp.eval(`(() => ({
        previewPane: !!window.__T4.q('[data-testid="preview-pane"]'),
        messageList: !!window.__T4.q('[data-testid="message-list"]'),
        composer: !!window.__T4.q('[data-testid="composer"]'),
        tokensScreen: !!window.__T4.q('[data-testid="token-stats"]') || !!window.__T4.q('[data-testid="composer-toolbar"]'),
      }))()`);
      ctx.record("回归_01工作台", r);
      ctx.assert("回归：默认路由仍是 01 工作台（预览区/消息流/Composer 都在）", {
        预览区在: r.previewPane === true,
        消息流在: r.messageList === true,
        Composer在: r.composer === true,
      });
    }

    /* ================================================================ 深色走查（三屏） */
    /* 注：本段必须放在最后 —— 它会把 localStorage 的 theme 设成 dark 再复位，
       若排在前面会污染后续「主题切换」断言。 */
    {
      const routes = ["/#/run-detail", "/#/skills", "/#/settings"];
      const darkResults = [];
      for (const route of routes) {
        await cdp.eval(`localStorage.setItem('theme','dark'); true`);
        await ctx.open("/");
        await ctx.open(route);
        await cdp.eval(HELPERS);
        await sleep(700);
        const r = await cdp.eval(`(() => {
          const root = document.querySelector('[data-testid$="-screen"]');
          const all = [...document.querySelectorAll('*')].slice(0, 800);
          // 大面积浅底检测（同 M3 口径）
          let bright = 0;
          // ★ 正文对比度口径（第一轮写错，已修正）：
          //   - 必须排除 svg / svg * —— 图标按 G4 是**刻意固定**的 --icon-neutral (#8A919E)，
          //     它不随主题变，也从来不是"正文文字"，拿它算对比度必然得到 1.x 的假失败。
          //   - 必须排除 [aria-hidden="true"] 的装饰节点（同上）。
          //   - 只统计**有可见文字**的叶子文本节点：文本长度 >= 2 且不是纯符号/标点。
          const isIconish = (el) => !!el.closest('svg') || el.getAttribute('aria-hidden') === 'true' || !!el.closest('[aria-hidden="true"]');
          const readings = [];
          for (const el of all) {
            const bg = getComputedStyle(el).backgroundColor;
            const m = bg.match(/rgba?\\(([^)]+)\\)/);
            if (m) {
              const p = m[1].split(',').map(Number);
              const opaque = p.length < 4 || p[3] > 0.5;
              if (opaque) {
                const l = window.__T4.lum(bg);
                const rect = el.getBoundingClientRect();
                if (l > 0.9 && rect.width > 200 && rect.height > 60) bright++;
              }
            }
            if (el.children.length > 0) continue;
            if (isIconish(el)) continue;
            const txt = (el.textContent || '').trim();
            // 只算真正的文字：至少 2 个字符且含文字/数字
            if (txt.length < 2 || !/[\\p{L}\\p{N}]/u.test(txt)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1) continue;
            readings.push({ text: txt.slice(0, 24), contrast: window.__T4.contrast(el), tag: el.tagName.toLowerCase(), color: getComputedStyle(el).color, cls: String(el.className).slice(0, 70) });
          }
          readings.sort((a, b) => a.contrast - b.contrast);
          /*
           * 分层：按**计算后的文字颜色**判定，而不是按 class 名 ——
           * 第一轮只匹配了 'text-text-tertiary' 这一个 class 串，漏掉了
           * 继承 tertiary 的节点（如 ScreenHeader 的 subtitle 容器自身没有色 class，
           * 但继承到 3.77）。按计算色分组才能覆盖全部实际取值。
           *
           * 深色下：--text-primary #E8EAED、--text-secondary #9AA0A8、--text-tertiary #6E747C。
           * tertiary 是设计稿定稿的辅助色（见脚本顶部注释），单独统计。
           */
          const auxColor = getComputedStyle(document.documentElement).getPropertyValue('--text-tertiary').trim();
          const auxRgb = (() => {
            const d = document.createElement('div');
            d.style.color = auxColor;
            document.body.appendChild(d);
            const c = getComputedStyle(d).color;
            d.remove();
            return c;
          })();
          const isAux = (r) => r.color === auxRgb;
          const bodyReadings = readings.filter((r) => !isAux(r));
          const auxReadings = readings.filter(isAux);
          return {
            route: '${route}',
            theme: document.documentElement.dataset.theme,
            bigBrightBlocks: bright,
            measuredTextNodes: readings.length,
            minTextContrast: readings.length ? readings[0].contrast : null,
            bodyMinContrast: bodyReadings.length ? bodyReadings[0].contrast : null,
            bodyMinSample: bodyReadings.length ? bodyReadings[0] : null,
            auxCount: auxReadings.length,
            auxMinContrast: auxReadings.length ? auxReadings[0].contrast : null,
            worst3: readings.slice(0, 3),
            worst3Body: bodyReadings.slice(0, 3),
            rootBg: root ? getComputedStyle(root).backgroundColor : null,
            overflow: window.__T4.hScroll(),
          };
        })()`);
        darkResults.push(r);
      }
      await cdp.eval(`localStorage.setItem('theme','light'); true`);
      ctx.record("深色走查_三屏", darkResults);
      ctx.assert(
        `深色下三屏无大面积白底；正文对比度 >= ${BODY_TEXT_MIN}、辅助文字 >= ${AUX_TEXT_MIN}（分层口径见脚本注释）`,
        {
          三屏都测了: darkResults.length === 3,
          无大面积浅底: darkResults.every((r) => r.bigBrightBlocks === 0),
          每屏都量到文字节点: darkResults.every((r) => r.measuredTextNodes > 20),
          正文对比度达标: darkResults.every((r) => r.bodyMinContrast !== null && r.bodyMinContrast >= BODY_TEXT_MIN),
          辅助文字对比度达标: darkResults.every((r) => r.auxMinContrast === null || r.auxMinContrast >= AUX_TEXT_MIN),
          全部文字对比度达标: darkResults.every((r) => r.minTextContrast >= AUX_TEXT_MIN),
          深色确实生效: darkResults.every((r) => r.theme === "dark"),
          深色下仍无横向溢出: darkResults.every((r) => r.overflow.scrollWidth <= r.overflow.clientWidth + 1),
          各屏正文最低对比度: darkResults.map((r) => `${r.route}: ${r.bodyMinContrast}`),
          各屏正文最低样本: darkResults.map((r) => r.bodyMinSample),
          各屏辅助文字最低对比度: darkResults.map((r) => `${r.route}: ${r.auxMinContrast} (${r.auxCount} 处)`),
        },
      );
    }

    /* ---------------------------------------------------------------- 证据落盘 */
    // ⚠️ 第一版漏了这行：脚本跑完全绿，但 **没有 `_m4-evidence.json`** ——
    //    与 M1/M2/M3 的惯例（每次验收留一份证据 JSON）不一致。事后要复盘
    //    「当时正文最低对比度是多少」就只能重跑。补上后与既有三个里程碑对齐。
    const summary = ctx.save("_m4-evidence.json");
    process.exitCode = summary.failed > 0 ? 1 : 0;
  },
);
