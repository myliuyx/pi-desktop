/** 诊断脚本：定位 1-1 / 1-3 / 1-9 三个失败项的根因 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout " + method)); } }, 30000);
    });
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "page error");
    return r.result.value;
  }
}

const probe = `(() => {
  const shell = document.querySelector('[data-testid="window-shell"]');
  const sb = document.querySelector('[data-testid="sidebar"]');
  const pv = document.querySelector('[data-testid="preview-pane"]');
  const ws = document.querySelector('[data-testid="workspace-area"]');
  const chain = (el, label) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { label, tag: el.tagName.toLowerCase(), testid: el.dataset.testid || null,
      rect: { w:+r.width.toFixed(2), h:+r.height.toFixed(2), top:+r.top.toFixed(2), bottom:+r.bottom.toFixed(2) },
      height: cs.height, minHeight: cs.minHeight, flex: cs.flex, flexShrink: cs.flexShrink,
      overflow: cs.overflow, transitionProperty: cs.transitionProperty, transitionDuration: cs.transitionDuration,
      width: cs.width, minWidth: cs.minWidth, position: cs.position, display: cs.display };
  };
  const out = [];
  out.push({ '视口': { innerHeight: window.innerHeight, innerWidth: window.innerWidth, docClientH: document.documentElement.clientHeight } });
  out.push({ '媒体查询': {
    prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    prefersReducedMotionNoPref: window.matchMedia('(prefers-reduced-motion: no-preference)').matches,
  } });
  out.push(chain(document.documentElement, 'html'));
  out.push(chain(document.body, 'body'));
  out.push(chain(document.getElementById('root'), '#root'));
  out.push(chain(shell, 'shell'));
  out.push(chain(shell.children[0], 'shell>TitleBar'));
  out.push(chain(shell.children[1], 'shell>主区'));
  out.push(chain(sb, 'sidebar'));
  out.push(chain(ws, 'workspace'));
  out.push(chain(pv, 'preview'));

  // 侧边栏折叠到 0 时为什么是 1
  const sbCs = getComputedStyle(sb);
  out.push({ 'sidebar盒模型': { width: sbCs.width, borderRight: sbCs.borderRightWidth, boxSizing: sbCs.boxSizing, inlineStyleWidth: sb.style.width } });

  // transition 规则来源
  const rules = [];
  for (const sheet of document.styleSheets) {
    let list; try { list = sheet.cssRules; } catch { continue; }
    for (const rule of list) {
      if (rule.selectorText && /transition-\\\\[width\\\\]|transition-width/.test(rule.selectorText)) rules.push(rule.cssText);
      if (rule.selectorText && /^\\\\.duration/.test(rule.selectorText) && /180/.test(rule.cssText)) rules.push(rule.cssText);
    }
  }
  out.push({ 'transition相关规则': rules });
  return out;
})()`;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "m1-diag-"));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--headless=new",
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1440,900", "about:blank",
  ], { stdio: "ignore" });

  try {
    let target = null;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (target) break;
      } catch { /* 等 */ }
      await sleep(250);
    }
    if (!target) throw new Error("CDP 未就绪");
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
    await cdp.eval(`new Promise(r=>{const t=setInterval(()=>{if(document.querySelector('[data-testid="sidebar"]')){clearInterval(t);r(1)}},50);setTimeout(()=>{clearInterval(t);r(0)},10000)})`, true);
    await sleep(600);
    const result = await cdp.eval(probe);
    writeFileSync("F:/DevelopWork/WorkBuddyWork/Tiktok_auto/packages/ui/_m1-diagnose.json", JSON.stringify(result, null, 2), "utf8");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    chrome.kill(); await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
  }
}
main().catch((e) => { console.error("诊断失败:", e); process.exit(1); });
