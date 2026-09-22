/**
 * CDP 驱动公共模块 —— M1 / M2 验收与截图脚本共用。
 *
 * 为什么手写而不装 puppeteer / playwright：
 * ① 本机 Chromium 从 Google CDN 下载会超时（storage.googleapis.com 不可达），
 *    但系统已装 Chrome，直接把 CDP 端点接过来即可；
 * ② 项目约定「不随意新增依赖」，验收工具不该成为新的依赖负担；
 * ③ Node 自带 fetch 与 WebSocket，够用。
 *
 * 用法：
 * ```js
 * import { withBrowser } from "./cdp.mjs";
 * await withBrowser({ port: 9333, origin: "http://127.0.0.1:5182" }, async (ctx) => {
 *   await ctx.open("/");
 *   ctx.record("某某验收项", await ctx.cdp.eval(`...`));
 *   ctx.save("_m2-evidence.json");
 * });
 * ```
 *
 * ⚠️ 踩坑备忘（M1 已踩过，别重复）：
 * - 少了 dev server 前置探测，`Page.navigate` 会**静默失败**、页面停在 about:blank，
 *   后续读 localStorage 抛 "SecurityError: Access is denied"，完全看不出真实原因。
 *   所以这里把探测内置到 `open()` 与启动流程里。
 * - 派发 Enter 键必须带 `text: "\r"`，否则触发不了 <button> 的原生激活行为
 *   （M1 曾因此得出「Enter 无效」的**假阴性**结论）。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 系统已装的 Chrome（不用下载 Chromium） */
export const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端：Runtime.evaluate / Page.navigate / Input.dispatchKeyEvent / 截图 */
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    // ★ 必须有这个监听器：少了它，WebSocket 照样能连上、命令照样能发出去、
    //   Chrome 也照样会回，但**没有任何人处理返回值** → 每条命令都等到 30s 超时。
    //   症状与「端口被僵尸实例占用」「缺 --remote-allow-origins」几乎一样，极难排查
    //   （M2 阶段真的踩过一次：整份验收脚本卡在 Page.enable，最后发现是漏了这个 listener）。
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.error.message ?? JSON.stringify(msg.error)}`));
        else resolve(msg.result);
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

  /** 派发一次按键（含 Enter / Space 的特殊处理） */
  async pressKey({ key, code, virtualKeyCode, text }) {
    const base = {
      key,
      code,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
    };
    await this.send("Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown",
      ...base,
      ...(text ? { text, unmodifiedText: text } : {}),
    });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** 截图存 PNG */
  async screenshot(path) {
    const res = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(path, Buffer.from(res.data, "base64"), "base64");
    return path;
  }
}

/** 等页面里出现某选择器；超时返回 false 而不是抛错（让调用方自己决定怎么办） */
export function waitForSelector(cdp, selector, timeout = 10000) {
  return cdp.eval(
    `new Promise(r => {
       const t = setInterval(() => { if (document.querySelector(${JSON.stringify(selector)})) { clearInterval(t); r(true); } }, 50);
       setTimeout(() => { clearInterval(t); r(false); }, ${timeout});
     })`,
    true,
  );
}

/** 探测 dev server 是否在线，报错要能直接指导操作 */
export async function assertOriginAlive(origin) {
  try {
    const probe = await fetch(`${origin}/`);
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
  } catch (e) {
    throw new Error(
      `dev server 未就绪（${origin}）：${e.message}\n` +
        `  请先在 packages/ui 下启动：npm run dev -- --port ${new URL(origin).port} --strictPort`,
    );
  }
}

/**
 * 启动 Chrome + 连上 CDP，跑完回调后自动清理。
 *
 * @param {object} options
 * @param {number} [options.port]          Chrome 调试端口（多人并行时务必错开）
 * @param {string} [options.origin]        dev server 地址
 * @param {string} [options.evidencePath]  record 结果落盘路径
 * @param {(ctx: object) => Promise<void>} run
 */
export async function withBrowser(options, run) {
  const port = options.port ?? 9333;
  const origin = options.origin ?? "http://127.0.0.1:5180";
  const evidencePath = options.evidencePath ?? "_evidence.json";

  await assertOriginAlive(origin);

  const profile = mkdtempSync(join(tmpdir(), "cdp-"));
  const chrome = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${port}`,
      /*
       * Chrome 111+ 起，DevTools 的 WebSocket 端点会校验 Origin 头：
       * 没开这个开关时，某些客户端（Node 内建 WebSocket 在某些版本上）连上后会**静默挂起** ——
       * 表现为脚本卡死、既不报错也不超时，非常难查。M2 阶段被 Agent B 实跑踩到过一次。
       * 本地 headless 验收场景下开 `*` 无安全顾虑（只监听 127.0.0.1 的调试端口）。
       */
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-gpu",
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    let target = null;
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = await res.json();
        target = list.find((t) => t.type === "page");
        if (target?.webSocketDebuggerUrl) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }
    if (!target) throw new Error("Chrome CDP 端点未就绪");

    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);

    /*
     * 连通性自检（8s）：CDP「连得上但命令无响应」是本模块最隐蔽的失效模式 ——
     * 症状是一条命令干等 30s 超时，报错只说 "CDP timeout: Page.enable"，
     * 完全指不出原因（可能少了 message 监听器、也可能是端口被僵尸 Chrome 占着）。
     * 先花 8 秒做一次平凡求值，失败时给出可操作的结论，比让人盲猜划算得多。
     */
    try {
      await Promise.race([
        cdp.send("Runtime.evaluate", { expression: "1 + 1", returnByValue: true }),
        sleep(8000).then(() => {
          throw new Error("8s 内无响应");
        }),
      ]);
    } catch (e) {
      throw new Error(
        `CDP 连通性自检失败（调试端口 ${port}）：${e.message}\n` +
          `  正常应能立即求值。常见原因：① cdp.mjs 的 Cdp 构造函数漏了 ws message 监听器（命令无人处理，必然超时）；` +
          `② 该端口被残留的僵尸 Chrome 占用（` +
          `用 Get-NetTCPConnection -State Listen 查一下）。`,
      );
    }

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("DOM.enable");

    const report = { origin, startedAt: new Date().toISOString(), steps: [], assertions: [] };

    const ctx = {
      cdp,
      origin,
      sleep,
      /** 打开页面并等 React 挂载 */
      async open(path = "/", readySelector = '[data-testid="window-shell"]') {
        await cdp.send("Page.navigate", { url: `${origin}${path}` });
        const ok = await waitForSelector(cdp, readySelector);
        if (!ok) throw new Error(`页面就绪超时：未找到 ${readySelector}（${path}）`);
        await cdp.eval("document.fonts.ready.then(() => true)", true);
        await sleep(300);
      },
      async reload(path = "/", readySelector = '[data-testid="window-shell"]') {
        await ctx.open(path, readySelector);
      },
      /** 记录一条原始观测（非断言） */
      record(name, value) {
        report.steps.push({ name, value });
        console.log(`\n### ${name}\n${JSON.stringify(value, null, 2)}`);
      },
      /**
       * 记录一条**显式断言**。
       * ⚠️ M1 的教训：曾经有验收段只 print 数值、不判通过，结果
       * 「折叠后残留 1px、内容区 1422」被当成通过。所以这里强制要求
       * detail 里的每个 key 都是布尔，并汇总成分组结论。
       */
      assert(name, detail) {
        const booleans = Object.entries(detail).filter(([, v]) => typeof v === "boolean");
        if (booleans.length === 0) throw new Error(`断言「${name}」没有任何布尔项 —— 等于没有断言`);
        const failed = booleans.filter(([, v]) => !v).map(([k]) => k);
        const pass = failed.length === 0;
        report.assertions.push({ name, pass, failed, detail });
        console.log(
          `\n### [${pass ? "PASS" : "FAIL"}] ${name}\n` +
            JSON.stringify(detail, null, 2) +
            (failed.length ? `\n  ✗ 未通过：${failed.join(", ")}` : ""),
        );
        return pass;
      },
      save(path = evidencePath) {
        const total = report.assertions.length;
        const passed = report.assertions.filter((a) => a.pass).length;
        const failed = report.assertions.filter((a) => !a.pass);
        const summary = {
          assertions: total,
          passed,
          failed: failed.length,
          failedNames: failed.map((a) => a.name),
        };
        writeFileSync(path, JSON.stringify({ ...report, summary }, null, 2), "utf8");
        console.log(`\n=== 断言汇总：${passed}/${total} 通过 ===`);
        if (failed.length) {
          for (const f of failed) console.log(`  ✗ ${f.name} → ${f.failed.join(", ")}`);
        }
        console.log(`== 证据已写入 ${path} ==`);
        return summary;
      },
    };

    await run(ctx);
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

/**
 * 往受控输入框里写值（React 18/19 兼容）。
 * 直接改 el.value 不会触发 React 的 onChange —— React 会在原型上记 value 的旧值，
 * 必须用原型上的原生 setter 绕过它，再手动派发 input 事件。
 */
export const SET_TEXT_HELPER = `
function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
`;
