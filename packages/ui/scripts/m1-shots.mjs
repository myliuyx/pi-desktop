/** 截图脚本：产出 M1 骨架的视觉证据（浅色 / 深色 / 折叠态） */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ORIGIN = "http://127.0.0.1:5180";
const PORT = 9336;
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
    await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
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
  async eval(e, a = false) {
    const r = await this.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: a, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "page error");
    return r.result.value;
  }
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "m1-shot-"));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--headless=new",
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--force-device-scale-factor=1", "--window-size=1440,900", "about:blank",
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

    // 用 Emulation 锁定视口为 1440×900，与设计画布一致
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });

    const shoot = async (name) => {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const file = `F:/DevelopWork/WorkBuddyWork/Tiktok_auto/.plan/shots/${name}.png`;
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log("已截图:", file);
    };

    const load = async (hash = "") => {
      await cdp.send("Page.navigate", { url: `${ORIGIN}/${hash}` });
      await cdp.eval(`new Promise(r=>{const t=setInterval(()=>{if(document.querySelector('[data-testid="sidebar"]')||document.querySelector('h1')){clearInterval(t);r(1)}},50);setTimeout(()=>{clearInterval(t);r(0)},10000)})`, true);
      await cdp.eval("document.fonts.ready.then(()=>true)", true);
      await sleep(500);
    };

    // 1) 浅色 · 两栏展开
    // 先导航到目标源再动 localStorage：about:blank 上访问 localStorage 会被拒（SecurityError）
    await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
    await sleep(1500);
    await cdp.eval("localStorage.clear(); true");
    await load();
    await shoot("m1-01-light-expanded");

    // 2) 深色 · 两栏展开
    await cdp.eval("document.querySelector('[data-testid=\"titlebar-toggle-theme\"]').click(); true");
    await sleep(400);
    await shoot("m1-02-dark-expanded");

    // 3) 深色 · 两栏全收起（验收 1-12 全屏态；左右按钮分别触发）
    await cdp.eval(`(() => {
      document.querySelector('[data-testid="titlebar-toggle-sidebar"]').click();
      document.querySelector('[data-testid="titlebar-toggle-preview"]').click();
      return true;
    })()`);
    await sleep(500);
    await shoot("m1-03-dark-fullscreen");

    // 4) 浅色 · 仅收起左侧（上一步两栏全收，这里只需把预览区展开，侧边栏保持收起）
    await cdp.eval(`(() => {
      if (document.documentElement.dataset.theme === 'dark') document.querySelector('[data-testid="titlebar-toggle-theme"]').click();
      document.querySelector('[data-testid="titlebar-toggle-preview"]').click();
      return true;
    })()`);
    await sleep(500);
    await shoot("m1-04-light-sidebar-collapsed");

    // 5) 00 屏 /tokens 路由仍可用
    await cdp.eval("localStorage.clear(); true");
    await load("#/tokens");
    await shoot("m1-05-tokens-route");
    // 6) win 壳（验证三端壳结构，M5 才做完整 06 屏）
    await load("");
    await shoot("m1-06-light-expanded-2");
  } finally {
    chrome.kill(); await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
  }
}
main().catch((e) => { console.error("截图失败:", e); process.exit(1); });
