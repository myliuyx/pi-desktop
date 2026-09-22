/**
 * 定位「折到 0 宽时仍占 1px」的真实原因。
 *
 * 背景：给 Sidebar / PreviewPane / 三栏容器都加了 min-w-0，但
 * 折叠后 getBoundingClientRect().width 仍是 1，内容区 1422 而非 1424。
 * 需要弄清那 1px 到底来自哪个盒子、哪条计算样式。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ORIGIN = "http://127.0.0.1:5180";
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 30000);
    });
  }
  async eval(expression, awaitPromise = false) {
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise, userGesture: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? "page exception");
    return res.result.value;
  }
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "m1-diag-"));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-gpu", "--window-size=1440,900", "about:blank",
  ], { stdio: "ignore" });

  try {
    const probe = await fetch(`${ORIGIN}/`);
    if (!probe.ok) throw new Error(`dev server HTTP ${probe.status}`);

    let target = null;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === "page");
        if (target?.webSocketDebuggerUrl) break;
      } catch { /* not up yet */ }
      await sleep(250);
    }
    if (!target) throw new Error("CDP 未就绪");

    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
    await cdp.eval(`new Promise(r => { const t = setInterval(() => { if (document.querySelector('[data-testid="sidebar"]')) { clearInterval(t); r(true); } }, 50); setTimeout(() => { clearInterval(t); r(false); }, 10000); })`, true);
    await sleep(400);

    // 收起两栏（逐栏条件点击），然后逐层量
    await cdp.eval(`(() => {
      const sb=document.querySelector('[data-testid="sidebar"]');
      const pv=document.querySelector('[data-testid="preview-pane"]');
      if (sb.dataset.collapsed!=='true') document.querySelector('[data-testid="titlebar-toggle-sidebar"]').click();
      if (pv.dataset.collapsed!=='true') document.querySelector('[data-testid="titlebar-toggle-preview"]').click();
      return true;
    })()`);
    await sleep(500);

    console.log("### 折叠后逐层量取（从 window-shell 往下）");
    console.log(JSON.stringify(await cdp.eval(`(() => {
      const chain = [];
      let el = document.querySelector('[data-testid="window-shell"]');
      const walk = (node, depth) => {
        const r = node.getBoundingClientRect();
        const cs = getComputedStyle(node);
        chain.push({
          层级: depth,
          tag: node.tagName.toLowerCase(),
          testid: node.dataset.testid || null,
          width: +r.width.toFixed(3),
          left: +r.left.toFixed(3),
          right: +r.right.toFixed(3),
          css_width: cs.width,
          minWidth: cs.minWidth,
          flexShrink: cs.flexShrink,
          flexBasis: cs.flexBasis,
          display: cs.display,
          flexDirection: cs.flexDirection,
          borderRight: cs.borderRightWidth,
          borderLeft: cs.borderLeftWidth,
          boxSizing: cs.boxSizing,
          overflow: cs.overflow,
          padding: cs.padding,
        });
        if (depth < 3) [...node.children].forEach(c => walk(c, depth + 1));
      };
      walk(el, 0);
      return chain;
    })()`), null, 2));

    console.log("\n### 直接测：手动把 sidebar 宽度设成 0 / 1px / 2px，看 rect 如何响应");
    console.log(JSON.stringify(await cdp.eval(`(() => {
      const sb = document.querySelector('[data-testid="sidebar"]');
      const ws = document.querySelector('[data-testid="workspace-area"]');
      const row = sb.parentElement;
      const out = [];
      const orig = sb.style.width;
      for (const w of ['0px', '0.5px', '1px', '2px', '10px']) {
        sb.style.width = w;
        void sb.offsetWidth;
        out.push({
          设定width: w,
          rect宽: +sb.getBoundingClientRect().width.toFixed(3),
          cssWidth: getComputedStyle(sb).width,
          内容区宽: +ws.getBoundingClientRect().width.toFixed(3),
          行宽: +row.getBoundingClientRect().width.toFixed(3),
        });
      }
      sb.style.width = orig;
      return out;
    })()`), null, 2));

    console.log("\n### 若在折叠时同时移除 border-right，表现如何");
    console.log(JSON.stringify(await cdp.eval(`(() => {
      const sb = document.querySelector('[data-testid="sidebar"]');
      const ws = document.querySelector('[data-testid="workspace-area"]');
      const row = sb.parentElement;
      const before = { sidebar: +sb.getBoundingClientRect().width.toFixed(3), workspace: +ws.getBoundingClientRect().width.toFixed(3), row: +row.getBoundingClientRect().width.toFixed(3) };
      sb.style.borderRightWidth = '0px';
      void sb.offsetWidth;
      const after = { sidebar: +sb.getBoundingClientRect().width.toFixed(3), workspace: +ws.getBoundingClientRect().width.toFixed(3), row: +row.getBoundingClientRect().width.toFixed(3) };
      return { 移除border前: before, 移除border后: after, 视口: document.documentElement.clientWidth };
    })()`), null, 2));

    console.log("\n### min-w-0 是否真的生效在 sidebar 上");
    console.log(JSON.stringify(await cdp.eval(`(() => {
      const sb = document.querySelector('[data-testid="sidebar"]');
      const row = sb.parentElement;
      return {
        sidebar_minWidth: getComputedStyle(sb).minWidth,
        row_minWidth: getComputedStyle(row).minWidth,
        row_class: row.className,
        sidebar_class_片段: sb.className.split(' ').filter(c => /min-w|shrink|w-/.test(c)),
        row_display: getComputedStyle(row).display,
        row_children_count: row.children.length,
      };
    })()`), null, 2));

    await cdp.eval("localStorage.removeItem('sidebar-collapsed'); localStorage.removeItem('preview-collapsed'); true");
  } finally {
    chrome.kill();
    await sleep(200);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error("诊断失败:", e); process.exit(1); });
