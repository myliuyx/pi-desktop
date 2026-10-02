/**
 * 预览区「点开真图」端到端 CDP 探针 —— `probe:preview-image`（file-image-preview 批次，task-5-brief §Step 3）。
 *
 * 写作方：**验收方（非实现方）** —— 项目铁律「验收脚本必须由非实现方写」
 * （见 probe-image-preview.mjs 文件头）。本文件**只从冻结契约推导断言**，不读
 * PreviewPane 的 FileImagePreview 实现。契约：DOM testid 四个（容器 / <img> / 超限 / 失败）、
 * 图片点开后 <img> 的 src 来自 /fs/image、缓存破门 v=、超限走本地占位文案「图片过大，
 * 暂不支持预览」、解码失败走本地占位文案「图片无法加载」。四条文案都是冻结契约的一部分 ——
 * 「随便写点非空串」不是合规实现，所以断言逐字比对（口径同 core 侧 fs-image-check
 * 的 R13「文案含『文件不存在』」）。
 *
 * 运行前置：`packages/ui` 下先 `npm run build`（core 同源托管的是 dist，不是源码）。
 * 用法：`npm run probe:preview-image`；证据 `_probe-preview-image-evidence.json`；失败非 0 退出。
 *
 * 端口与避让（README「会起 core 的脚本请串行执行」——共享端口与 run/ 目录）：
 *   core 5199 ✗ `packages/core/scripts/c3-approval-check.mjs:462` 的信任门 `always` 用例；
 *            CDP 9370 ✗ `packages/ui/scripts/probe-turn-rail.mjs:36`（PROBE_TURN_RAIL_CDP）。
 *   本脚本取 **core 5236 / CDP 9376**：5231/5233/5235（fs-list / fs-search / fs-image 三个
 *   core 侧 check）与 5236 一并落在 `packages/core/scripts/**` 与 `packages/ui/scripts/**`
 *   的 `PORT ?? NNNNN` 现取值空档里（52xx 只用到 5200-5207/5210/5212/5217/5219/5221/5225/
 *   5231/5233/5235，93xx 只用到 9333-9358/9364/9366/9368/9370）；两者都可用环境变量改。
 *
 * 纪律（本探针最容易踩的两个坑，从实现方探针的教训抄来）：
 * - G2 **不得**包在 `if (hasImage)` 里静默跳过：取不到图片元素 ⇒ 判红 + 非零退出，
 *   并在证据里写明「图片链路未获验证」。静默跳过会让本批最大的验证缺口被吞掉。
 * - G11（坏字节图 ⇒ error 占位）**不得**「取不到就跳过」：取不到 error 占位判红 ——
 *   它的性质是「浏览器拿不到可解码字节时的诚实呈现」，必须始终被观测。
 * - ⚠️ G9 与 G11 **不再有先后约束**（fix round 2 · Important 2）：原实现用单个不区分来源的
 *   `window.__err` 计数，而资源加载错误（`<img>` 的 error，以捕获阶段事件到达 window）
 *   会计进去 —— 实测（本机 Google Chrome 154 + `addEventListener('error', h, true)`）
 *   坏字节图确实把计数推成 1。那样 G9 就只能是「**探针前半程**无未捕获异常」，
 *   半程口径既没写进断言名、也没写进汇总，还逼出一条「G9 必须排在 G11 之前」的
 *   隐式顺序契约（谁调整检查顺序，G9 就静默改语义）。现在拆成两个计数器：
 *     `__scriptErr` = 脚本类异常（捕获阶段 error 事件里 target 不是 <img> 的那些）
 *     `__resErr`     = 资源类异常（target 是 <img> 的那些，即图片加载失败）
 *   G9 只看 `__scriptErr`，于是「脚本类异常全程为 0」成了与位置无关的陈述，
 *   可以放在流程任意位置 —— 顺序契约直接消失，G11 挪到 G9 前后均不影响 G9。
 *   `__resErr` 不作判据（图片加载失败本身正是 G11 要观测的现象），只在证据里留读数。
 * - 文件行点击用 `[data-kind="file"]` + textContent 匹配后 `.click()`；**不要**点
 *   `sidebar-file-tree-file-row-N`（那是外层 div，没有 onClick，点了没有任何反应）。
 *   目录展开用 `[data-kind="dir"]`，展开结果读 `data-expanded`。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser, sleep, waitForSelector } from "./cdp.mjs";
import { childEnv, seedModelsJson } from "../../core/scripts/lib/credentials.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(here, "..");
const coreDir = path.join(uiDir, "..", "core");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
const coreLogPath = path.join(coreDir, "run", "probe-preview-image-core.log");
const evidencePathAbs = path.join(uiDir, "_probe-preview-image-evidence.json");
const shotPreview = path.join(uiDir, "_probe-preview-image-shot.png");

const CORE_PORT = Number(process.env.PROBE_PREVIEW_IMAGE_CORE_PORT ?? 5236);
const CDP_PORT = Number(process.env.PROBE_PREVIEW_IMAGE_CDP_PORT ?? 9376);
const TOKEN = process.env.PROBE_PREVIEW_IMAGE_TOKEN ?? "probe-preview-image-token";

/* 与 core 侧 fs-image-check 共用的 1x1 真图字节（Chromium 实测 naturalWidth>0）：
   PNG 三块 CRC 全对、自然宽 1。用它保证「core 字节对」与「浏览器真解码」指向同一批字节。 */
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);

// 先删上一轮证据（live-smoke 同款纪律：防旧断言混入汇总）
try {
  fs.rmSync(evidencePathAbs, { force: true });
} catch {
  /* 忽略 */
}

console.log(`[probe-preview-image] 起 core（端口 ${CORE_PORT}，无模型调用）…`);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-previmage-"));
const agentDir = path.join(tmpRoot, "agentdir");
const cwd = path.join(tmpRoot, "project");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));
seedModelsJson(agentDir);

// 夹具：assets/ 下真 PNG + 超限 PNG；根目录放 notes.md（G8 对照：非图片仍走既有双 Tab 路径）。
const assetsDir = path.join(cwd, "assets");
fs.mkdirSync(assetsDir, { recursive: true });
fs.writeFileSync(path.join(assetsDir, "shot.png"), PNG_1x1);
// 超限：9MB = PNG 头 + 填充（>8MB；UI 侧靠 /fs/read 的 size 本地占位，不发第二次请求）
fs.writeFileSync(path.join(assetsDir, "toolarge.png"), Buffer.concat([PNG_1x1, Buffer.alloc(9 * 1024 * 1024 - PNG_1x1.length, 0x41)]));
/*
 * G11 夹具：**扩展名合法、字节不是图**（<script>alert(1)</script> —— 连 PNG 魔数都没有）。
 * 与 core 侧 check:fs-image 的 R10「.png 实为文本」同一条契约（魔数不信扩展名）：
 * /fs/read 正常返回 200（kind 仍按扩展名判成 image），/fs/image 回 415 ⇒ <img> 加载失败
 * ⇒ 应诚实呈现 `preview-file-image-error` 占位。字节里带 <script> 是刻意的：
 * 若端点绕过魔数直接回 200 且 Content-Type 仍写 image/png，浏览器仍解不出图；
 * 若回的是 text/html 则**可能**被当文档渲染 —— 那本身就是一条失败证据。
 */
const LIAR_MARKER = "probe-preview-image-liar";
fs.writeFileSync(path.join(assetsDir, "liar.png"), `<script>alert(${JSON.stringify(LIAR_MARKER)})</script>\n这根本不是图片。\n`, "utf8");
const NOTES_MARKER = "preview-image-notes-marker";
fs.writeFileSync(path.join(cwd, "notes.md"), `# notes\n\n${NOTES_MARKER}\n\n- a\n- b\n`);
// G8 的源码型对照（.ts 走 preview-file-source）
fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
const SRC_MARKER = "preview-image-src-marker";
fs.writeFileSync(path.join(cwd, "src", "demo.ts"), `const m = "${SRC_MARKER}";\nexport const n = 1;\n`);

fs.mkdirSync(path.dirname(coreLogPath), { recursive: true });
const logFd = fs.openSync(coreLogPath, "w");
const child = spawn(process.execPath, [tsxPath, "src/main.ts"], {
  cwd: coreDir,
  env: childEnv({ CORE_TOKEN: TOKEN, CORE_PORT: String(CORE_PORT), CORE_AGENT_DIR: agentDir, CORE_CWD: cwd }),
  stdio: ["ignore", "ignore", logFd],
});

async function waitForCoreUp(token, port, timeoutMs = 40000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(400);
  }
}

/** 页面侧 helper：文件树点击 / 预览区观测。data-kind + textContent 定位（外层 div 无 onClick）。 */
const HELPERS = `
window.__PI = {
  paneCollapsed() {
    return document.querySelector('[data-testid="preview-pane"]')?.getAttribute('data-collapsed') ?? null;
  },
  fileName() {
    return (document.querySelector('[data-testid="preview-file-name"]')?.textContent ?? '').trim();
  },
  img() {
    return document.querySelector('[data-testid="preview-file-image-img"]');
  },
  imgFacts() {
    const im = window.__PI.img();
    if (!im) return { exists: false };
    return {
      exists: true,
      src: im.getAttribute('src') ?? null,
      naturalWidth: im.naturalWidth,
      naturalHeight: im.naturalHeight,
      complete: im.complete,
      tagName: im.tagName.toLowerCase(),
    };
  },
  containerExists() {
    return document.querySelector('[data-testid="preview-file-image"]') !== null;
  },
  tooLargeExists() {
    return document.querySelector('[data-testid="preview-file-image-too-large"]') !== null;
  },
  tooLargeText() {
    return (document.querySelector('[data-testid="preview-file-image-too-large"]')?.textContent ?? '').trim();
  },
  errorExists() {
    return document.querySelector('[data-testid="preview-file-image-error"]') !== null;
  },
  errorText() {
    return (document.querySelector('[data-testid="preview-file-image-error"]')?.textContent ?? '').trim();
  },
  readErrorExists() {
    return document.querySelector('[data-testid="preview-file-error"]') !== null;
  },
  binaryExists() {
    return document.querySelector('[data-testid="preview-file-binary"]') !== null;
  },
  tabCounts() {
    return {
      effect: document.querySelectorAll('[data-testid="preview-file-effect"]').length,
      source: document.querySelectorAll('[data-testid="preview-file-source"]').length,
      // 哑 Tab 纪律看的是**双 Tab 按钮**（FILE_PREVIEW_TABS 的 file-tab-effect / file-tab-code）
      // 与 tabbar 容器，不是内容面板；面板 testid 恒不存在时计数恒 0（真值断言）。
      tabEffectBtn: document.querySelectorAll('[data-testid="file-tab-effect"]').length,
      tabCodeBtn: document.querySelectorAll('[data-testid="file-tab-code"]').length,
      tabbar: document.querySelectorAll('[data-testid="preview-tabbar"]').length,
    };
  },
  sourceText() {
    return document.querySelector('[data-testid="preview-file-source"]')?.textContent ?? '';
  },
  effectText() {
    return document.querySelector('[data-testid="preview-file-effect"]')?.textContent ?? '';
  },
  closePreview() {
    const el = document.querySelector('[data-testid="preview-file-close"]');
    if (!el) return false;
    el.click();
    return true;
  },
  expandDir(name) {
    const btn = [...document.querySelectorAll('[data-kind="dir"]')].find((n) => (n.textContent || '').includes(name));
    if (!btn) return false;
    if (btn.getAttribute('data-expanded') !== 'true') btn.click();
    return true;
  },
  dirExpanded(name) {
    const btn = [...document.querySelectorAll('[data-kind="dir"]')].find((n) => (n.textContent || '').includes(name));
    return btn ? btn.getAttribute('data-expanded') : null;
  },
  clickFile(name) {
    const btn = [...document.querySelectorAll('[data-kind="file"]')].find((n) => (n.textContent || '').includes(name));
    if (!btn) return false;
    btn.click();
    return true;
  },
  treePresent() {
    return document.querySelector('[data-testid="sidebar-file-tree"]') !== null;
  },
};
true;
`;

let exitCode = 1;
let phase = "启动 core";
const fails = [];
try {
  phase = "等待 core 就绪";
  if (!(await waitForCoreUp(TOKEN, CORE_PORT))) throw new Error(`core 未就绪（端口 ${CORE_PORT}）`);
  const origin = `http://127.0.0.1:${CORE_PORT}`;

  // 未捕获异常计数（G9）：必须在导航前挂 window.onerror 记录器。
  const collectErrors = (cdp) => {
    const errors = [];
    cdp.ws.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.method === "Runtime.exceptionThrown") {
          errors.push(m.params?.exceptionDetails?.exception?.description ?? "unknown");
        }
      } catch {
        /* 忽略非 JSON */
      }
    });
    return errors;
  };

  phase = "CDP 驱动浏览器";
  await withBrowser({ port: CDP_PORT, origin, evidencePath: evidencePathAbs }, async (ctx) => {
    const { cdp } = ctx;
    const A = (name, detail) => {
      try {
        const d = detail !== null && typeof detail === "object" ? detail : { ok: detail === true };
        if (!ctx.assert(name, d)) fails.push(name);
      } catch (e) {
        console.error(`[probe-preview-image] 断言异常 ${name}:`, e.message);
        fails.push(name);
      }
    };

    const pageErrors = collectErrors(cdp);

    phase = "打开页面";
    await ctx.open(`/?live=1&token=${TOKEN}`);
    /*
     * 未捕获异常**双计数器**（G9；fix round 2 · Important 2）。必须挂在导航之后、任何检查之前，
     * 且用捕获阶段监听（不设 capture 就不会到 window）。拆分依据：捕获阶段 error 事件的
     * `target` 就是事件源元素 —— 资源加载失败（<img> 的 error）的 target 是那个 <img>，
     * 脚本抛错的 target 是出错的元素/Window。复审已在本机 Chrome 154 独立复现确认
     * 「资源错误会计入不区分来源的计数器」（{"all":1,"res":1,"script":0}），
     * 即这种区分是可观测的、不是凭感觉分的类。
     * `window.__err` 保留为不区分来源的全量读数，只写进证据做对照（可核「脚本类 + 资源类
     * 是否刚好等于全量」，即上面那个 tagName 分类有没有漏归类），不参与判据。
     */
    await cdp.eval(`window.addEventListener('error', (h) => {
                     window.__err = (window.__err||0)+1;
                     if (h && h.target && h.target.tagName === 'IMG') window.__resErr = (window.__resErr||0)+1;
                     else window.__scriptErr = (window.__scriptErr||0)+1;
                   }, true);
                   window.__err = 0; window.__scriptErr = 0; window.__resErr = 0;`, false);
    await cdp.eval(HELPERS);

    /* ===== G0：前置闸门 —— 侧栏文件树出现，展到 assets/ ===== */
    phase = "G0 侧栏文件树定位并展到 assets/";
    const treeUp = await waitForSelector(cdp, '[data-testid="sidebar-file-tree"]', 15000);
    // 等根级文件树加载完（有 entries 才出现 dir 行）；先等 assets 的 dir 行可点
    let dirSeen = false;
    for (let i = 0; i < 40; i++) {
      dirSeen = (await cdp.eval(`window.__PI.treePresent() && !!([...document.querySelectorAll('[data-kind="dir"]')].find(n => (n.textContent||'').includes('assets')))`)) === true;
      if (dirSeen) break;
      await sleep(250);
    }
    const expanded = (await cdp.eval(`window.__PI.expandDir('assets')`)) === true;
    // 展开后等子文件行出现
    let shotSeen = false;
    for (let i = 0; i < 40; i++) {
      shotSeen = (await cdp.eval(`!!([...document.querySelectorAll('[data-kind="file"]')].find(n => (n.textContent||'').includes('shot.png')))`)) === true;
      if (shotSeen) break;
      await sleep(250);
    }
    const dirExpandedAfter = await cdp.eval(`window.__PI.dirExpanded('assets')`);
    A("G0 前置闸门：文件树出现、assets/ 展开、shot.png 行可见", {
      文件树出现: treeUp === true,
      assets目录行可见: dirSeen === true,
      点击展开已触发: expanded === true,
      展开后data_expanded为true: dirExpandedAfter === "true",
      shot_png行可见: shotSeen === true,
    });

    /* ===== G1：点 shot.png ⇒ 预览区展开 + 文件名 = shot.png ===== */
    phase = "G1 点击 shot.png 打开预览";
    const clickedShot = (await cdp.eval(`window.__PI.clickFile('shot.png')`)) === true;
    await sleep(2000); // /fs/read + <img> 解码
    const g1 = await cdp.eval(
      `(() => ({ collapsed: window.__PI.paneCollapsed(), name: window.__PI.fileName() }))()`,
      true,
    );
    ctx.record("G1 预览区状态", g1);
    A("G1 点 [data-kind=file] shot.png ⇒ 预览区展开 + 文件名 = shot.png", {
      文件行可点: clickedShot === true,
      预览区展开: g1.collapsed === "false",
      文件名是shot_png: g1.name === "shot.png",
    });

    /* ===== G2★：容器出现 + <img> naturalWidth > 0（图片链路通的证据） ===== */
    phase = "G2 断言 <img> 真解码（核心判据，不得跳过）";
    const g2facts = await cdp.eval(`window.__PI.imgFacts()`, true);
    const containerUp = await cdp.eval(`window.__PI.containerExists()`, true);
    ctx.record("G2 img 事实", g2facts);
    // 判据只有布尔项；naturalWidth>0 是链路通的核心证据。
    // 这里刻意**不**加 if(hasImage) 保护 —— 取不到就是判红（纪律 1）。
    A("G2 预览区出 preview-file-image 容器 + <img> naturalWidth > 0（真解码，链路通）", {
      容器存在: containerUp === true,
      img元素存在: g2facts.exists === true,
      img标签是img: g2facts.tagName === "img",
      naturalWidth大于0: (g2facts.naturalWidth ?? 0) > 0,
      naturalHeight大于0: (g2facts.naturalHeight ?? 0) > 0,
    });
    // 证据里显式写明链路是否获验证（纪律 1：取不到 img 时不能吞掉这个缺口）。
    if (!(g2facts.exists === true && (g2facts.naturalWidth ?? 0) > 0)) {
      ctx.record("G2_链路未获验证", {
        note: "图片链路未获验证：未取到 naturalWidth>0 的 <img>。",
        facts: g2facts,
      });
    }

    /* ===== G3：img.complete === true（解码完成，非挂起） ===== */
    /*
     * ⚠️ 「img 元素存在」这项不是凑数（follow-up fix round 1 · Minor 1）：
     * 变异测试发现，只要实现渲染的 <img> 永远 complete=true，下面这条判据就**永不红** ——
     * 鉴别力寄生在 G2 上。所以这里显式带一项 img 元素存在性：
     *   - <img> 真的没渲染时 ⇒ 「img元素存在: false」判红（真失败）；
     *   - <img> 渲染了但仍挂起（complete=false）⇒ 「complete为true: false」判红。
     * 两种「图片链路没走完」的形态各自能被看见，证据里不留字段缺失的歧义。
     */
    A("G3 <img> 元素存在且 complete === true（解码完成，非挂起）", {
      img元素存在: g2facts.exists === true,
      complete为true: g2facts.complete === true,
    });

    /* ===== G4：img.src 含 &v=（缓存破门的端到端证据） ===== */
    {
      const src = String(g2facts.src ?? "");
      /* 同 G3：img 缺失时「src含v参数 / src来自fs_image」会因字段缺失一并假绿，
         必须显式挂上 img 元素存在性，缺失 ⇒ 判红而非「字段不存在所以没红」。 */
      A("G4 <img> 元素存在且 src 含 &v=（fsVersion 缓存破门端到端生效）", {
        img元素存在: g2facts.exists === true,
        src含v参数: src.includes("&v="),
        src来自fs_image路由: src.includes("/fs/image"),
      });
    }

    /* ===== G5：该文件行无 file-tab-effect / file-tab-code（无哑 Tab 纪律） ===== */
    {
      const tabs = await cdp.eval(`window.__PI.tabCounts()`, true);
      ctx.record("G5 Tab 计数", tabs);
      A("G5 点开图片无哑 Tab：双 Tab 按钮（file-tab-effect / file-tab-code）与 tabbar 均不出现", {
        无file_tab_effect按钮: tabs.tabEffectBtn === 0,
        无file_tab_code按钮: tabs.tabCodeBtn === 0,
        无tabbar容器: tabs.tabbar === 0,
        无效果面板: tabs.effect === 0,
      });
    }
    await ctx.cdp.screenshot(shotPreview);

    /* ===== G6：点 toolarge.png ⇒ preview-file-image-too-large 出现且文案含「图片过大」 ===== */
    phase = "G6 点击超限图片 toolarge.png";
    const clickedTooLarge = (await cdp.eval(`window.__PI.clickFile('toolarge.png')`)) === true;
    await sleep(2000);
    const g6 = await cdp.eval(
      `(() => ({ tooLarge: window.__PI.tooLargeExists(), text: window.__PI.tooLargeText(), hasImg: window.__PI.imgFacts().exists, name: window.__PI.fileName(), error: window.__PI.errorExists() }))()`,
      true,
    );
    ctx.record("G6 超限占位", g6);
    A("G6 点 toolarge.png ⇒ preview-file-image-too-large 出现且文案含「图片过大」", {
      超限行可点: clickedTooLarge === true,
      too_large占位出现: g6.tooLarge === true,
      文案含图片过大: g6.text.includes("图片过大"),
      超限时不出img: g6.hasImg === false,
      文件名是toolarge_png: g6.name === "toolarge.png",
      /*
       * ★ 直接阳性对照（fix round 2 · Important 1 增补）：在**已知健康**的超限场景
       *   （同一组件、同一 kind、同一 FileStatusBlock）要求 error 占位**不存在**。
       *   作用：G11 的 `error占位出现` 与本项「同一选择器在健康态下为 false」互为反证，
       *   排掉「error 选择器恒非空 / testid 拼错导致组件压根没渲染」这两类假阳性。
       *   G11 里那对阳性对照（非空文案 + G6 无 img）都证明不了这一点 ——
       *   「文案非空」无法区分「文案写对」与「组件整体没渲染/没报错」。
       */
      阳性对照_健康态不出error占位: g6.error === false,
    });

    /* ===== G7：点 preview-file-close ⇒ 清选择 + 预览区收起 ===== */
    phase = "G7 关闭预览（清选择 + 收起）";
    const closedClicked = (await cdp.eval(`window.__PI.closePreview()`)) === true;
    await sleep(600);
    const g7 = await cdp.eval(
      `(() => ({ collapsed: window.__PI.paneCollapsed(), name: window.__PI.fileName(), tooLarge: window.__PI.tooLargeExists() }))()`,
      true,
    );
    ctx.record("G7 关闭后状态", g7);
    A("G7 点 preview-file-close ⇒ 预览区收起 + 清选择（既有口径零回归）", {
      close可点: closedClicked === true,
      预览区收起: g7.collapsed === "true",
      文件名已清空: g7.name === "",
      占位消失: g7.tooLarge === false,
    });

    /* ===== G8：源码型 .ts 走 preview-file-source；.md 走 preview-file-effect + 双 Tab ===== */
    phase = "G8 源码型与 markdown 对照（图片分支未误伤既有路径）";
    // demo.ts 在 src/ 子目录里 ⇒ 先展开 src/（G8 用到的目录与 G0 的 assets/ 各自独立）
    const srcExpanded = (await cdp.eval(`window.__PI.expandDir('src')`)) === true;
    let tsSeen = false;
    for (let i = 0; i < 40; i++) {
      tsSeen = (await cdp.eval(`!!([...document.querySelectorAll('[data-kind="file"]')].find(n => (n.textContent||'').includes('demo.ts')))`)) === true;
      if (tsSeen) break;
      await sleep(250);
    }
    const clickedTs = (await cdp.eval(`window.__PI.clickFile('demo.ts')`)) === true;
    await sleep(1500);
    const g8ts = await cdp.eval(
      `(() => ({ name: window.__PI.fileName(), tabs: window.__PI.tabCounts(), srcHas: window.__PI.sourceText().includes(${JSON.stringify(SRC_MARKER)}), hasImg: window.__PI.imgFacts().exists }))()`,
      true,
    );
    ctx.record("G8 .ts 源码型", g8ts);
    A("G8 .ts 仍走 preview-file-source（图片分支未误伤源码路径）", {
      src目录展开可见ts: srcExpanded === true && tsSeen === true,
      ts行可点: clickedTs === true,
      文件名是demo_ts: g8ts.name === "demo.ts",
      出source面板: g8ts.tabs.source === 1,
      ts不出双Tab按钮: g8ts.tabs.tabEffectBtn === 0 && g8ts.tabs.tabCodeBtn === 0,
      源码命中marker: g8ts.srcHas === true,
      ts不出img: g8ts.hasImg === false,
    });

    // G7 已覆盖「close ⇒ 收起 + 清选择」，此处直接切到 notes.md（根目录，两步前已可见）
    (await cdp.eval(`window.__PI.closePreview()`));
    await sleep(500);
    const clickedMd = (await cdp.eval(`window.__PI.clickFile('notes.md')`)) === true;
    await sleep(1500);
    const g8md = await cdp.eval(
      `(() => ({ name: window.__PI.fileName(), tabs: window.__PI.tabCounts(), effectHas: window.__PI.effectText().includes(${JSON.stringify(NOTES_MARKER)}), hasImg: window.__PI.imgFacts().exists }))()`,
      true,
    );
    ctx.record("G8 .md 效果型", g8md);
    A("G8 .md 走 preview-file-effect + 双 Tab（图片分支未误伤双 Tab 纪律）", {
      md行可点: clickedMd === true,
      文件名是notes_md: g8md.name === "notes.md",
      出一个effect面板: g8md.tabs.effect === 1,
      效果内容命中marker: g8md.effectHas === true,
      md不出img: g8md.hasImg === false,
      /*
       * ★ 阳性对照（防空转断言）：G5 断言「图片点开没有双 Tab 按钮」，
       *   若这两个选择器**恒为 0**（testid 拼错/节点根本不存在），G5 就成了恒真断言。
       *   所以这里对同一条 .md（hasEffect 文件，按实现契约必带双 Tab）要求
       *   两个按钮各存在 1 个 —— 用一条真值事实给 G5 的选择器做鉴别力证明。
       */
      阳性对照_effect按钮存在: g8md.tabs.tabEffectBtn === 1,
      阳性对照_code按钮存在: g8md.tabs.tabCodeBtn === 1,
    });

    /* ===== G9：页面无未捕获**脚本**异常（__scriptErr 全程为 0 + CDP exceptionThrown 为空） ===== */
    /*
     * 口径（fix round 2 · Important 2）：判据只看 `__scriptErr`（脚本类），不看
     * `__resErr`（<img> 等资源类）。资源类错误是本探针**故意制造**的（G11 的 415 坏字节图），
     * 它进不进 G9 由「是不是资源类」决定，与本块在流程里的位置无关 ——
     * 因此不再有“G9 必须在 G11 之前”的顺序契约（已实测：G11 挪到 G9 之前，G9 仍绿）。
     * 语义也从「前半程无异常」收回到它字面上真正在说的东西：脚本类异常全程为 0。
     */
    phase = "G9 无未捕获脚本异常";
    const errCounts = await cdp.eval(
      `({ script: window.__scriptErr ?? 0, resource: window.__resErr ?? 0, all: window.__err ?? 0 })`,
      true,
    );
    const windowErrCount = errCounts?.script ?? 0;
    ctx.record("G9 异常计数", {
      脚本类异常: windowErrCount,
      资源类异常_不作判据: errCounts?.resource ?? null,
      全量异常_仅对照: errCounts?.all ?? null,
      cdpExceptions: pageErrors.length,
      samples: pageErrors.slice(0, 3),
    });
    A("G9 页面无未捕获脚本异常（window.__scriptErr=0 且无 CDP exceptionThrown；资源类异常不计入）", {
      window脚本类异常为0: windowErrCount === 0,
      无cdp未捕获异常: pageErrors.length === 0,
    });

    /* ===== G11★：字节损坏但扩展名合法的图片 ⇒ core 回 415 ⇒ <img> 加载失败 ⇒ error 占位 ===== */
    /*
     * 补上的第四个冻结 testid（`preview-file-image-error`）在此首次被断言 ——
     * 此前 helper 里的 errorExists() 定义了却全文从未调用，该 testid 零覆盖。
     * 覆盖「浏览器拿不到可解码字节时的诚实呈现」这条路径：
     *   /fs/read 仍 200（kind 按扩展名判成 image）⇒ 不应落到 preview-file-error / binary 占位；
     *   /fs/image 因魔数不信扩展名回 415 ⇒ <img> 触发 onError ⇒ preview-file-image-error。
     * ⚠️ 取不到 error 占位 ⇒ **判红**，不得「取不到就跳过」（同 G2 纪律）。
     */
    phase = "G11 坏字节图片（扩展名合法）应诚实呈现 error 占位";
    const clickedLiar = (await cdp.eval(`window.__PI.clickFile('liar.png')`)) === true;
    let g11 = null;
    for (let i = 0; i < 40; i++) {
      g11 = await cdp.eval(
        `(() => ({
           error: window.__PI.errorExists(),
           text: window.__PI.errorText(),
           hasImg: window.__PI.imgFacts().exists,
           readError: window.__PI.readErrorExists(),
           binary: window.__PI.binaryExists(),
           tooLarge: window.__PI.tooLargeExists(),
           name: window.__PI.fileName(),
           src: window.__PI.imgFacts().src,
           naturalWidth: window.__PI.imgFacts().naturalWidth,
         }))()`,
        true,
      );
      // error 占位出现即可收；或到点仍未出现也照样往下走（判红，不跳过）
      if (g11.error) break;
      await sleep(250);
    }
    ctx.record("G11 坏字节图 error 占位", g11);
    A("G11 点 liar.png（扩展名 png、字节是文本）⇒ core 415 ⇒ <img> 加载失败 ⇒ 出 preview-file-image-error 占位且文案为「图片无法加载」", {
      liar_png行可点: clickedLiar === true,
      文件名是liar_png: g11.name === "liar.png",
      error占位出现: g11.error === true,
      /*
       * 逐字文案断言（fix round 2 · Important 1）。原判据是 `文案非空: (g11.text ?? "").length > 0`
       * —— 复审实测把实现的文案改成任意非空串后它**仍然 PASS、探针仍 exit=0**，
       * 对「文案写错」零鉴别力（假阳性口：看着绿、实则什么都没测）。
       * 现在按冻结契约比对 FileImagePreview 的 text prop —— 口径跟随 core 侧
       * fs-image-check 的 R13「文案含『文件不存在』」，是精确文案而非非空。
       */
      文案是图片无法加载: g11.text === "图片无法加载",
      不落读取失败占位: g11.readError === false,
      不落binary占位: g11.binary === false,
      不落超限占位: g11.tooLarge === false,
    });
    /*
     * ★ 阳性对照（防空转断言）：若 error 占位是因为「组件压根没渲染」而出现，上面的
     *   `error占位出现` 就恒真。**直接**反证由 G6 的新判据给出：同一 FileStatusBlock、
     *   同一 image kind、同样点得开的 toolarge.png 上，error 占位为 false
     *   （见 G6 的「阳性对照_健康态不出error占位」= true）。此前这里写的
     *   「对照_超大图G6无error占位: 见 G6 的『超时不出现 img』」其实不成立 ——
     *   「不出 <img>」并不蕴含「不出 error 占位」，组件没渲染时两者会同时消失。
     * 这里把 liar.png 的观测（源 URL 仍指向 /fs/image ⇒ 请求真发出过且被 415 拒了）
     * 一并留在证据里，供人复核，而不是只留一个布尔。
     */
    ctx.record("G11_链路佐证", {
      注: "img 已被 error 占位替换 ⇒ src/naturalWidth 应为 null/0（浏览器已卸下 <img>）；换文件重试后由 G12 复位证明失败态可清",
      src: g11.src ?? null,
      naturalWidth: g11.naturalWidth ?? 0,
      文案原文: g11.text ?? "",
      "对照_健康态(G6超限图)无error占位": "见 G6 断言项『阳性对照_健康态不出error占位』= true",
    });

    /* ===== G12：失败态可复位 —— 回到 shot.png ⇒ 又出 preview-file-image-img（onError 不粘手） ===== */
    phase = "G12 失败态复位（回到真图）";
    const clickedBackToShot = (await cdp.eval(`window.__PI.clickFile('shot.png')`)) === true;
    await sleep(2000);
    const g12 = await cdp.eval(
      `(() => ({ facts: window.__PI.imgFacts(), error: window.__PI.errorExists(), name: window.__PI.fileName() }))()`,
      true,
    );
    ctx.record("G12 失败态复位后", g12);
    A("G12 坏图之后切回 shot.png ⇒ error 占位消失、<img> 重新挂上且真解码（失败态按 path 复位）", {
      shot_png行可点: clickedBackToShot === true,
      文件名是shot_png: g12.name === "shot.png",
      error占位消失: g12.error === false,
      img重新出现: g12.facts.exists === true,
      naturalWidth大于0: (g12.facts.naturalWidth ?? 0) > 0,
    });

    // 证据落盘
    ctx.save(evidencePathAbs);
  });

  exitCode = fails.length === 0 ? 0 : 1;
} catch (e) {
  console.error(`[probe-preview-image] 异常（阶段：${phase}）：`, e.message);
  fs.writeFileSync(
    evidencePathAbs,
    JSON.stringify({ failedAtPhase: phase, error: e.message, note: "本轮未走完流程，未生成完整断言证据。" }, null, 2),
  );
  exitCode = 1;
} finally {
  /* ===== G10：进程零残留（finally SIGTERM core）—— 本块即 G10 的实现 ===== */
  try {
    child.kill("SIGTERM");
    await sleep(500);
    // 确认端口已释放（core 已退出）
    let stillUp = false;
    try {
      const res = await fetch(`http://127.0.0.1:${CORE_PORT}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      stillUp = res.ok;
    } catch {
      stillUp = false;
    }
    const g10ok = stillUp === false;
    const g10name = "G10 探针结束 core 进程零残留（SIGTERM 后端口释放）";
    if (g10ok) {
      console.log(`\n### [PASS] ${g10name}\n${JSON.stringify({ 端口仍应答: stillUp })}`);
    } else {
      console.error(`\n### [FAIL] ${g10name}\n${JSON.stringify({ 端口仍应答: stillUp })}`);
      fails.push(g10name);
      exitCode = 1;
    }
    // 把 G10 也并进证据（assert 汇总在 ctx.save 里已跑完，这里补一条落盘记录）
    try {
      const prev = JSON.parse(fs.readFileSync(evidencePathAbs, "utf8"));
      prev.assertions = prev.assertions ?? [];
      prev.assertions.push({ name: g10name, pass: g10ok, failed: g10ok ? [] : ["端口仍应答"], detail: { 端口仍应答: stillUp } });
      prev.summary = {
        assertions: prev.assertions.length,
        passed: prev.assertions.filter((a) => a.pass).length,
        failed: prev.assertions.filter((a) => !a.pass).length,
        failedNames: prev.assertions.filter((a) => !a.pass).map((a) => a.name),
      };
      fs.writeFileSync(evidencePathAbs, JSON.stringify(prev, null, 2));
    } catch {
      /* 证据不可读则跳过合并 */
    }
  } finally {
    fs.closeSync(logFd);
    // 清理临时夹具
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }
}

console.log(
  fails.length === 0
    ? "\n预览区图片预览探针全部通过"
    : `\n探针失败 ${fails.length} 项：\n - ${fails.join("\n - ")}`,
);
process.exit(exitCode);
