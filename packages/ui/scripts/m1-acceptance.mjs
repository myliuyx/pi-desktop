/**
 * M1 验收脚本 —— 用 CDP 驱动真实 Chrome 量取实际数值。
 *
 * 为什么这么写：验收 1-2 / 1-3 / 1-4 / 1-8 要求「DevTools 里量到的实际值」，
 * 而本机没有装 puppeteer / playwright。所以直接用 Node 内置的 http + WebSocket
 * （Chrome 的 CDP 端点）驱动浏览器，不引入任何新依赖。
 *
 * 用法：先跑 vite dev server（默认 5180），再执行本脚本。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ORIGIN = process.env.M1_ORIGIN ?? "http://127.0.0.1:5180";
const PORT = 9333;
const OUT = process.argv[2] ?? "F:/DevelopWork/WorkBuddyWork/Tiktok_auto/packages/ui/_m1-evidence.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return res.json();
}

/** 极简 CDP 客户端：只用到 Runtime.evaluate + Page.navigate */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", (e) => reject(new Error(`ws error: ${e.message ?? "unknown"}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  /** 在页面里求值；awaitPromise 让 async 表达式能返回结果 */
  async eval(expression, awaitPromise = false) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`page exception: ${res.exceptionDetails.exception?.description ?? "unknown"}`);
    }
    return res.result.value;
  }
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "m1-cdp-"));
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-gpu",
      // 关键：给内层内容区一个明确的像素窗口，这样 1-3/1-12 的判定才有意义
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    // 先确认 dev server 在线。少了这步，Page.navigate 会静默失败、
    // 页面停在 about:blank，后面读 localStorage 时报
    // "SecurityError: Access is denied for this document"，完全看不出真实原因。
    try {
      const probe = await fetch(`${ORIGIN}/`);
      if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
    } catch (e) {
      throw new Error(
        `dev server 未就绪（${ORIGIN}）：${e.message}\n` +
          `  请先在 packages/ui 下启动：npm run dev -- --port 5180 --strictPort`,
      );
    }

    // 等 CDP 端点起来
    let target = null;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await fetchJson("/json/list");
        target = list.find((t) => t.type === "page");
        if (target?.webSocketDebuggerUrl) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }
    if (!target) throw new Error("Chrome CDP 端点未就绪");

    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    const report = { origin: ORIGIN, steps: [] };
    const record = (name, value) => {
      report.steps.push({ name, value });
      console.log(`\n### ${name}\n${JSON.stringify(value, null, 2)}`);
    };

    // ---------------------------------------------------------------- 打开页面
    await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
    // 等 React 挂载 + 字体就绪
    await cdp.eval(
      `new Promise(r => { const t = setInterval(() => { if (document.querySelector('[data-testid="sidebar"]')) { clearInterval(t); r(true); } }, 50); setTimeout(() => { clearInterval(t); r(false); }, 10000); })`,
      true,
    );
    await cdp.eval("document.fonts.ready.then(() => true)", true);
    await sleep(300);

    // 清掉上一次运行的折叠状态，保证从「两栏展开」这个已知状态开始
    await cdp.eval("localStorage.removeItem('sidebar-collapsed'); localStorage.removeItem('preview-collapsed'); true");
    await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
    await cdp.eval(
      `new Promise(r => { const t = setInterval(() => { if (document.querySelector('[data-testid="sidebar"]')) { clearInterval(t); r(true); } }, 50); setTimeout(() => { clearInterval(t); r(false); }, 10000); })`,
      true,
    );
    await sleep(400);

    // ------------------------------------------------- 1-1 三栏结构 + 1-6/1-7 顺序
    record(
      "1-1_三栏结构",
      await cdp.eval(`(() => {
        const shell = document.querySelector('[data-testid="window-shell"]');
        const main = shell.children[1];
        const roles = [...main.children].map(el => {
          const r = el.getBoundingClientRect();
          return { testid: el.dataset.testid || el.tagName.toLowerCase(), width: +r.width.toFixed(2), left: +r.left.toFixed(2), right: +r.right.toFixed(2) };
        });
        const cs = getComputedStyle(main);
        // 三栏并排：第二个的左边界 == 第一个的右边界，第三个的左边界 == 第二个的右边界
        const 相邻相接 = roles.length === 3 && roles.every((r, i) => i === 0 || Math.abs(r.left - roles[i-1].right) <= 1);
        const 总宽 = roles.reduce((n, r) => n + r.width, 0);
        return {
          标题栏高: +shell.children[0].getBoundingClientRect().height.toFixed(2),
          主区display: cs.display,
          主区flexDirection: cs.flexDirection,
          子节点数: main.children.length,
          三栏: roles,
          三栏宽度合计: +总宽.toFixed(2),
          主区宽度: +main.getBoundingClientRect().width.toFixed(2),
          宽度守恒: Math.abs(总宽 - main.getBoundingClientRect().width) <= 1,
          并排成立: roles.length === 3 && 相邻相接,
        };
      })()`),
    );

    record(
      "1-6_1-7_侧边栏顺序与无日期分组",
      await cdp.eval(`(() => {
        const content = document.querySelector('[data-testid="sidebar-content"]');
        const items = [...content.querySelectorAll('button, [data-testid^="sidebar-history"]')];
        const order = [...content.children].map(el => (el.dataset.testid || el.tagName.toLowerCase()));
        const text = content.innerText;
        const dateGroups = ['今天','昨天','本周','上周','更早','本月','前天'].filter(k => text.includes(k));
        const history = document.querySelector('[data-testid="sidebar-history"]');
        return {
          内容区直接子节点顺序: order,
          菜单项文案: [...content.querySelectorAll('[data-testid^="sidebar-"]')].map(el => (el.innerText||'').trim()).filter(Boolean),
          历史会话条目数: history ? history.querySelectorAll('button').length : 0,
          命中日期分组关键词: dateGroups,
          历史会话条目文案: history ? [...history.querySelectorAll('button')].map(b => b.innerText.trim()) : [],
        };
      })()`),
    );

    // ------------------------------------------------- 1-2 / 1-8 尺寸与内边距
    record(
      "1-2_侧边栏宽度",
      await cdp.eval(`(() => {
        const sb = document.querySelector('[data-testid="sidebar"]');
        const r = sb.getBoundingClientRect();
        const cs = getComputedStyle(sb);
        return {
          width_getBoundingClientRect: +r.width.toFixed(2),
          computed_width: cs.width,
          borderLeftWidth: cs.borderLeftWidth,
          borderRightWidth: cs.borderRightWidth,
          padding: cs.padding,
          gap: cs.gap,
          boxSizing: cs.boxSizing,
        };
      })()`),
    );

    record(
      "1-4_条带高度",
      await cdp.eval(`(() => {
        const f = document.querySelector('[data-testid="sidebar-footer"]');
        const r = f.getBoundingClientRect();
        const cs = getComputedStyle(f);
        return {
          height_getBoundingClientRect: +r.height.toFixed(2),
          computed_height: cs.height,
          width: +r.width.toFixed(2),
        };
      })()`),
    );

    record(
      "1-8_侧边栏内容区padding",
      await cdp.eval(`(() => {
        const c = document.querySelector('[data-testid="sidebar-content"]');
        const cs = getComputedStyle(c);
        return { paddingTop: cs.paddingTop, paddingRight: cs.paddingRight, paddingBottom: cs.paddingBottom, paddingLeft: cs.paddingLeft, gap: cs.gap };
      })()`),
    );

    // ------------------------------------------------- 1-3 条带三边通底
    record(
      "1-3_条带三边通底",
      await cdp.eval(`(() => {
        const sb = document.querySelector('[data-testid="sidebar"]');
        const f = document.querySelector('[data-testid="sidebar-footer"]');
        const r = sb.getBoundingClientRect();
        const fr = f.getBoundingClientRect();
        const cs = getComputedStyle(sb);
        const borderRight = parseFloat(cs.borderRightWidth) || 0;
        const winBottom = document.documentElement.clientHeight;
        /*
         * 分隔线已改为绝对定位伪元素（globals.css 的 divider-r），
         * 所以 borderRightWidth 现在是 0 —— 条带应贴到侧边栏的整个外框右边界（264）。
         * 这里保留 borderRight 的扣减是要与实测对齐：万一将来有人把分隔线改回 border，
         * 判定依然正确（扣掉那 1px 边框后再比），不会把「边框本身」误判成「残留内边距」。
         */
        const contentRight = r.right - borderRight;
        return {
          侧边栏外框: { left: +r.left.toFixed(2), right: +r.right.toFixed(2), bottom: +r.bottom.toFixed(2), borderRightWidth: borderRight },
          条带:        { left: +fr.left.toFixed(2), right: +fr.right.toFixed(2), bottom: +fr.bottom.toFixed(2) },
          规格判定项: {
            offsetLeft差值_条带left减侧边栏left: +(fr.left - r.left).toFixed(2),
            offsetBottom差值_窗口底减条带底: +(winBottom - fr.bottom).toFixed(2),
          },
          右侧参考值: {
            条带到侧边栏内容右界的差值: +(contentRight - fr.right).toFixed(2),
            说明: '这 1px 是侧边栏自身的 border-right（border-box 内），不是残留 padding',
          },
          条带外侧包裹HTML: (() => { let p = f.parentElement, chain = []; while (p && chain.length < 3) { const cs = getComputedStyle(p); chain.push({ tag: p.tagName.toLowerCase(), testid: p.dataset.testid || null, padding: cs.padding, margin: cs.margin }); p = p.parentElement; } return chain; })(),
          判定_左右底三边均贴边_按规格offsetLeft与offsetBottom: (fr.left - r.left) <= 0 && (winBottom - fr.bottom) <= 0 && (contentRight - fr.right) <= 0,
        };
      })()`),
    );

    // ------------------------------------------------- 1-5 条带无圆角无缝隙
    record(
      "1-5_条带无圆角无缝隙",
      await cdp.eval(`(() => {
        const f = document.querySelector('[data-testid="sidebar-footer"]');
        const halves = [...f.querySelectorAll('button')];
        const fcs = getComputedStyle(f);
        const rects = halves.map(b => { const r = b.getBoundingClientRect(); return { testid: b.dataset.testid, left: +r.left.toFixed(2), right: +r.right.toFixed(2), width: +r.width.toFixed(2) }; });
        const halfCs = halves.map(b => { const cs = getComputedStyle(b); return { testid: b.dataset.testid, borderRadius: cs.borderRadius, backgroundColor: cs.backgroundColor, marginLeft: cs.marginLeft, marginRight: cs.marginRight, borderLeftWidth: cs.borderLeftWidth, borderRightWidth: cs.borderRightWidth, borderTopWidth: cs.borderTopWidth, padding: cs.padding }; });
        return {
          外层: { borderRadius: fcs.borderRadius, gap: fcs.gap, padding: fcs.padding, columnGap: fcs.columnGap, rowGap: fcs.rowGap, backgroundColor: fcs.backgroundColor },
          两半: rects,
          两半之间实际缝隙px: +(rects[1].left - rects[0].right).toFixed(2),
          两半样式: halfCs,
          外层面色: fcs.backgroundColor,
          两半面色是否均等于外层面色: halfCs.every(h => h.backgroundColor === fcs.backgroundColor),
        };
      })()`),
    );

    // ------------------------------------------------- 1-9 / 1-10 折叠
    record(
      "1-9_1-10_折叠与过渡",
      await cdp.eval(`(async () => {
        const sb = document.querySelector('[data-testid="sidebar"]');
        const pv = document.querySelector('[data-testid="preview-pane"]');
        const ws = document.querySelector('[data-testid="workspace-area"]');
        const before = {
          sidebar: +sb.getBoundingClientRect().width.toFixed(2),
          preview: +pv.getBoundingClientRect().width.toFixed(2),
          workspace: +ws.getBoundingClientRect().width.toFixed(2),
          bodyScrollWidth: document.body.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        };
        const cs = getComputedStyle(sb);
        const transition = {
          property: cs.transitionProperty, duration: cs.transitionDuration, timing: cs.transitionTimingFunction,
        };
        const pvCs = getComputedStyle(pv);
        const previewTransition = { property: pvCs.transitionProperty, duration: pvCs.transitionDuration };
        const workspaceMinWidth = getComputedStyle(ws).minWidth;

        // 点「收起左侧」
        document.querySelector('[data-testid="titlebar-toggle-sidebar"]').click();
        const immediate = +sb.getBoundingClientRect().width.toFixed(2);
        await new Promise(r => setTimeout(r, 400));
        const afterCollapse = {
          sidebar: +sb.getBoundingClientRect().width.toFixed(2),
          collapsed: sb.dataset.collapsed,
          display: getComputedStyle(sb).display,
          overflow: getComputedStyle(sb).overflow,
          ariaHidden: sb.getAttribute('aria-hidden'),
          workspace: +ws.getBoundingClientRect().width.toFixed(2),
          preview: +pv.getBoundingClientRect().width.toFixed(2),
        };

        // 再点回来
        document.querySelector('[data-testid="titlebar-toggle-sidebar"]').click();
        await new Promise(r => setTimeout(r, 400));
        const afterExpand = { sidebar: +sb.getBoundingClientRect().width.toFixed(2), collapsed: sb.dataset.collapsed };

        // 两栏各自收起 → 全屏（右端按钮 2026-09-22 裁决后只收右侧，全屏由左右按钮分别触发）
        document.querySelector('[data-testid="titlebar-toggle-sidebar"]').click();
        document.querySelector('[data-testid="titlebar-toggle-preview"]').click();
        await new Promise(r => setTimeout(r, 400));
        const fullscreen = {
          sidebar: +sb.getBoundingClientRect().width.toFixed(2),
          preview: +pv.getBoundingClientRect().width.toFixed(2),
          workspace: +ws.getBoundingClientRect().width.toFixed(2),
          workspaceLeft: +ws.getBoundingClientRect().left.toFixed(2),
          workspaceRight: +ws.getBoundingClientRect().right.toFixed(2),
          clientWidth: document.documentElement.clientWidth,
          bodyScrollWidth: document.body.scrollWidth,
          bodyClientWidth: document.body.clientWidth,
          无横向滚动条: document.body.scrollWidth <= document.body.clientWidth,
          workspaceDisplay: getComputedStyle(ws).display,
        };
        // 回到展开
        document.querySelector('[data-testid="titlebar-toggle-sidebar"]').click();
        document.querySelector('[data-testid="titlebar-toggle-preview"]').click();
        await new Promise(r => setTimeout(r, 400));

        return { before, transition, previewTransition, workspaceMinWidth, sidebarDisplayWhileCollapsing: immediate > 0 ? '宽度过渡中(非瞬间0)' : '瞬间归零', afterCollapse, afterExpand, fullscreen };
      })()`, true),
    );

    // ------------------------------------------------- 1-11 持久化
    record(
      "1-11_折叠持久化",
      await cdp.eval(`(async () => {
        const sb = document.querySelector('[data-testid="sidebar"]');
        // 收起左侧
        document.querySelector('[data-testid="titlebar-toggle-sidebar"]').click();
        await new Promise(r => setTimeout(r, 400));
        const stored = { sidebar: localStorage.getItem('sidebar-collapsed'), preview: localStorage.getItem('preview-collapsed'), theme: localStorage.getItem('theme') };
        return { 点击后localStorage: stored, 点击后宽度: +sb.getBoundingClientRect().width.toFixed(2) };
      })()`, true),
    );

    // 整页重载，看是否保持
    await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
    await cdp.eval(
      `new Promise(r => { const t = setInterval(() => { if (document.querySelector('[data-testid="sidebar"]')) { clearInterval(t); r(true); } }, 50); setTimeout(() => { clearInterval(t); r(false); }, 10000); })`,
      true,
    );
    await sleep(500);
    record(
      "1-11_重载后仍然折叠",
      await cdp.eval(`(() => {
        const sb = document.querySelector('[data-testid="sidebar"]');
        return {
          reload后宽度: +sb.getBoundingClientRect().width.toFixed(2),
          reload后collapsed属性: sb.dataset.collapsed,
          reload后localStorage: { sidebar: localStorage.getItem('sidebar-collapsed') },
          首帧无跳动: '见 progress-M1.md 说明',
        };
      })()`),
    );

    // ------------------------------------------------- 1-12 全屏填满（重载后的初始态再走一遍）
    record(
      "1-12_全屏内容区填满",
      await cdp.eval(`(async () => {
        const sb = document.querySelector('[data-testid="sidebar"]');
        const pv = document.querySelector('[data-testid="preview-pane"]');
        const ws = document.querySelector('[data-testid="workspace-area"]');
        // 保证两栏都收起（逐栏条件点击：右端按钮只管预览区，两栏状态互不影响）
        if (sb.dataset.collapsed !== 'true') {
          document.querySelector('[data-testid="titlebar-toggle-sidebar"]').click();
          await new Promise(r => setTimeout(r, 400));
        }
        if (pv.dataset.collapsed !== 'true') {
          document.querySelector('[data-testid="titlebar-toggle-preview"]').click();
          await new Promise(r => setTimeout(r, 400));
        }
        const r = ws.getBoundingClientRect();
        const sbw = +sb.getBoundingClientRect().width.toFixed(4);
        const pvw = +pv.getBoundingClientRect().width.toFixed(4);
        const wsw = +r.width.toFixed(4);
        const viewport = document.documentElement.clientWidth;
        return {
          sidebar宽度: sbw,
          preview宽度: pvw,
          workspace宽度: wsw,
          workspace_left: +r.left.toFixed(4),
          workspace_right: +r.right.toFixed(4),
          视口宽: viewport,
          body_scrollWidth: document.body.scrollWidth,
          body_clientWidth: document.body.clientWidth,
          无横向滚动条: document.body.scrollWidth <= document.body.clientWidth,
          documentElement_scrollWidth: document.documentElement.scrollWidth,
          documentElement_clientWidth: document.documentElement.clientWidth,
          // 严格断言：不给容差（容差 1px 曾把 1422/1424 的缺口放过）
          严格判定: {
            内容区宽等于视口宽: wsw === viewport,
            内容区左边界为0: +r.left.toFixed(4) === 0,
            内容区右边界等于视口宽: +r.right.toFixed(4) === viewport,
          },
        };
      })()`, true),
    );

    // ------------------------------------------------- 1-13 折到严格 0（硬断言）
    // 这一段是补上的：早前 1-12 的判定带了 ≤1 的容差，结果「折叠后残留 1px、
    // 内容区 1422 而非 1424」被脚本判成了通过。既然验收要求「严格 0」，
    // 断言就必须是 === 0 / === 1424，不能给容差。
    record(
      "1-13_严格0宽硬断言",
      await cdp.eval(`(async () => {
        const sb = document.querySelector('[data-testid="sidebar"]');
        const pv = document.querySelector('[data-testid="preview-pane"]');
        const ws = document.querySelector('[data-testid="workspace-area"]');
        // 确保两栏都收起（逐栏条件点击）
        if (sb.dataset.collapsed !== 'true') {
          document.querySelector('[data-testid="titlebar-toggle-sidebar"]').click();
          await new Promise(r => setTimeout(r, 400));
        }
        if (pv.dataset.collapsed !== 'true') {
          document.querySelector('[data-testid="titlebar-toggle-preview"]').click();
          await new Promise(r => setTimeout(r, 500));
        }
        const sbw = +sb.getBoundingClientRect().width.toFixed(4);
        const pvw = +pv.getBoundingClientRect().width.toFixed(4);
        const wsw = +ws.getBoundingClientRect().width.toFixed(4);
        const viewport = document.documentElement.clientWidth;
        const sbBorder = parseFloat(getComputedStyle(sb).borderRightWidth) || 0;
        const pvBorder = parseFloat(getComputedStyle(pv).borderLeftWidth) || 0;
        const 断言 = {
          侧边栏严格为0: sbw === 0,
          预览区严格为0: pvw === 0,
          内容区等于视口宽: wsw === viewport,
          侧边栏无边框占位: sbBorder === 0,
          预览区无边框占位: pvBorder === 0,
        };
        return {
          侧边栏宽: sbw, 预览区宽: pvw, 内容区宽: wsw, 视口宽: viewport,
          侧边栏borderRight: sbBorder, 预览区borderLeft: pvBorder,
          断言, 全部通过: Object.values(断言).every(Boolean),
        };
      })()`, true),
    );

    // 回到展开态，避免影响后续步骤（逐栏条件点击）
    await cdp.eval(`(() => {
      const sb = document.querySelector('[data-testid="sidebar"]');
      const pv = document.querySelector('[data-testid="preview-pane"]');
      if (sb.dataset.collapsed === 'true') document.querySelector('[data-testid="titlebar-toggle-sidebar"]').click();
      if (pv.dataset.collapsed === 'true') document.querySelector('[data-testid="titlebar-toggle-preview"]').click();
      return true;
    })()`);
    await sleep(400);

    // ------------------------------------------------- G4 图标色
    record(
      "G4_图标色",
      await cdp.eval(`(() => {
        const icons = [...document.querySelectorAll('svg.lucide')].slice(0, 8);
        const colors = icons.map(el => getComputedStyle(el).color);
        return { 取色样本数: icons.length, 计算色值: colors, 全为8A919E: colors.every(c => c.replace(/\\s/g,'') === 'rgb(138,145,158)') };
      })()`),
    );

    // ------------------------------------------------- 主题切换（深色）
    await cdp.eval("document.querySelector('[data-testid=\"titlebar-toggle-theme\"]').click(); true");
    await sleep(300);
    record(
      "深色模式_骨架无白底黑字",
      await cdp.eval(`(() => {
        const pick = ['[data-testid="window-shell"]','[data-testid="sidebar"]','[data-testid="sidebar-footer"]','[data-testid="workspace-area"]','[data-testid="preview-pane"]'];
        return {
          theme: document.documentElement.dataset.theme,
          body背景: getComputedStyle(document.body).backgroundColor,
          元素: pick.map(s => { const el = document.querySelector(s); const cs = getComputedStyle(el); return { s, bg: cs.backgroundColor, color: cs.color }; }),
          图标色深色下: getComputedStyle(document.querySelector('svg.lucide')).color,
          无横向滚动条: document.body.scrollWidth <= document.body.clientWidth,
        };
      })()`),
    );

    // 还原浅色
    await cdp.eval(
      `(() => {
         if (document.documentElement.dataset.theme === 'dark') {
           document.querySelector('[data-testid="titlebar-toggle-theme"]').click();
         }
         localStorage.removeItem('sidebar-collapsed');
         localStorage.removeItem('preview-collapsed');
         return true;
       })()`,
    );

    // ------------------------------------------------- G7 键盘可达（真实 Tab 遍历）
    record(
      "G7_键盘可达",
      await cdp.eval(`(() => {
        const sel = 'button, [href], input, select, textarea, [tabindex]';
        const focusables = [...document.querySelectorAll(sel)].filter(el => el.getAttribute('tabindex') !== '-1');
        const noLabel = focusables.filter(el => !el.getAttribute('aria-label') && !(el.innerText||'').trim() && !el.getAttribute('title'));
        return {
          可聚焦元素数: focusables.length,
          无标签的元素: noLabel.map(el => el.outerHTML.slice(0, 90)),
          全部可聚焦元素均有可读名称: noLabel.length === 0,
          可聚焦元素testId: focusables.map(el => el.dataset.testid).filter(Boolean),
        };
      })()`),
    );

    // 真实按 Tab：用 CDP 派发 keydown，观察 document.activeElement 是否推进
    const tabTrail = [];
    await cdp.eval("document.body.focus(); true");
    for (let i = 0; i < 8; i++) {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      await sleep(60);
      tabTrail.push(
        await cdp.eval(`(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return { none: true };
          const cs = getComputedStyle(el);
          return {
            tag: el.tagName.toLowerCase(),
            testid: el.dataset.testid || null,
            label: el.getAttribute('aria-label') || (el.innerText||'').trim().slice(0, 20) || null,
            outlineStyle: cs.outlineStyle,
            outlineWidth: cs.outlineWidth,
            outlineColor: cs.outlineColor,
          };
        })()`),
      );
    }
    record("G7_Tab遍历焦点轨迹", { 步数: tabTrail.length, 轨迹: tabTrail, 焦点环可见: tabTrail.filter(t => t.outlineStyle === 'solid' && parseFloat(t.outlineWidth) >= 2).length });

    // Enter 触发：先把侧边栏复位为展开，聚焦「收起左侧」后按 Enter，看是否真的收起
    await cdp.eval(
      `(() => {
         const sb = document.querySelector('[data-testid="sidebar"]');
         if (sb.dataset.collapsed === 'true') {
           document.querySelector('[data-testid="titlebar-toggle-sidebar"]').click();
         }
         return true;
       })()`,
    );
    await sleep(350);
    const beforeEnter = await cdp.eval("document.querySelector('[data-testid=\"sidebar\"]').dataset.collapsed");
    await cdp.eval("document.querySelector('[data-testid=\"titlebar-toggle-sidebar\"]').focus(); true");
    /*
     * Enter 的 keyDown 必须带 text:"\r"，否则触发不了 <button> 的原生激活行为。
     * 第一版漏了这个字段，测出来「Enter 无效」是**测试工具的假阴性**，不是真的无障碍缺陷 ——
     * 浏览器里 Enter 激活按钮靠的是 keydown 的默认动作，而 CDP 只有给了 text 走完整输入路径才会走。
     */
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Enter", code: "Enter",
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r",
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Enter", code: "Enter",
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    await sleep(350);
    const afterEnter = await cdp.eval("document.querySelector('[data-testid=\"sidebar\"]').dataset.collapsed");
    record("G7_Enter触发结果", {
      按Enter前_collapsed: beforeEnter,
      按Enter后_collapsed: afterEnter,
      已触发: beforeEnter !== afterEnter,
      聚焦元素: "titlebar-toggle-sidebar",
    });

    // Space 触发：复位后聚焦「收起右侧」，按 Space 应收起预览区且侧边栏不动（2026-09-22 裁决后的按钮语义）
    await cdp.eval(
      `(() => {
         const sb = document.querySelector('[data-testid="sidebar"]');
         if (sb.dataset.collapsed === 'true') document.querySelector('[data-testid="titlebar-toggle-sidebar"]').click();
         return true;
       })()`,
    );
    await sleep(350);
    await cdp.eval("document.querySelector('[data-testid=\"titlebar-toggle-preview\"]').focus(); true");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: " " });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    await sleep(400);
    const spaceState = await cdp.eval(
      `[document.querySelector('[data-testid="sidebar"]').dataset.collapsed, document.querySelector('[data-testid="preview-pane"]').dataset.collapsed]`,
    );
    record("G7_Space触发结果", {
      两栏collapsed: spaceState,
      预览区已收起且侧边栏未动: spaceState[0] === 'false' && spaceState[1] === 'true',
      聚焦元素: "titlebar-toggle-preview",
    });
    await cdp.eval("localStorage.removeItem('sidebar-collapsed'); localStorage.removeItem('preview-collapsed'); true");

    // ------------------------------------------------- 1-10 过渡是「真动画」而非声明
    // 采集中间帧：若过渡真实生效，宽度序列应为单调递减的多个中间值；
    // 若是瞬间跳变，则只会有首尾两个值。这是比读 transitionProperty 更硬的证据。
    await cdp.eval("localStorage.removeItem('sidebar-collapsed'); true");
    await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
    await cdp.eval(
      `new Promise(r => { const t = setInterval(() => { if (document.querySelector('[data-testid="sidebar"]')) { clearInterval(t); r(true); } }, 50); setTimeout(() => { clearInterval(t); r(false); }, 10000); })`,
      true,
    );
    await sleep(500);

    record(
      "1-10_过渡中间帧采样",
      await cdp.eval(`(async () => {
        const sb = document.querySelector('[data-testid="sidebar"]');
        const ws = document.querySelector('[data-testid="workspace-area"]');
        const samples = [];
        const t0 = performance.now();
        document.querySelector('[data-testid="titlebar-toggle-sidebar"]').click();
        // 用 rAF 抓每一帧的宽度
        await new Promise(resolve => {
          const tick = () => {
            const w = sb.getBoundingClientRect().width;
            samples.push({ t: +(performance.now() - t0).toFixed(1), sidebar: +w.toFixed(2), workspace: +ws.getBoundingClientRect().width.toFixed(2) });
            if (performance.now() - t0 < 320) requestAnimationFrame(tick);
            else resolve();
          };
          requestAnimationFrame(tick);
        });
        const widths = samples.map(s => s.sidebar);
        const midFrames = samples.filter(s => s.sidebar > 1 && s.sidebar < 263).length;
        // 内容区宽度是否随过渡连续变化（说明没有瞬间重排）
        const wsWidths = samples.map(s => s.workspace);
        let wsMonotonic = true;
        for (let i = 1; i < wsWidths.length; i++) if (wsWidths[i] < wsWidths[i-1] - 0.5) wsMonotonic = false;
        return {
          首帧: samples[0],
          末帧: samples[samples.length - 1],
          采样帧数: samples.length,
          中间帧数_宽度介于1与263之间: midFrames,
          宽度序列_抽样: widths.filter((_, i) => i % Math.max(1, Math.floor(widths.length / 12)) === 0),
          内容区宽度序列_抽样: wsWidths.filter((_, i) => i % Math.max(1, Math.floor(wsWidths.length / 12)) === 0),
          内容区宽度单调递增_无回跳: wsMonotonic,
          结论: midFrames >= 3 ? '存在多帧中间态 → 宽度过渡真实生效（非瞬间跳变）' : '中间帧不足 → 疑似瞬间跳变',
        };
      })()`, true),
    );

    await cdp.eval("localStorage.removeItem('sidebar-collapsed'); localStorage.removeItem('preview-collapsed'); true");

    writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
    console.log(`\n== 证据已写入 ${OUT} ==`);
  } finally {
    chrome.kill();
    await sleep(300);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }
}

main().catch((err) => {
  console.error("验收脚本失败:", err);
  process.exit(1);
});
