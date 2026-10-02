/**
 * 预览区「点开真图」端到端 CDP 探针 —— `probe:preview-image`（file-image-preview 批次，task-5-brief §Step 3）。
 *
 * 写作方：**验收方（非实现方）** —— 项目铁律「验收脚本必须由非实现方写」
 * （见 probe-image-preview.mjs 文件头）。本文件**只从冻结契约推导断言**，不读
 * PreviewPane 的 FileImagePreview 实现。契约：DOM testid 四个（容器 / <img> / 超限 / 失败）、
 * 图片点开后 <img> 的 src 来自 /fs/image、缓存破门 v=、超限走本地占位文案「图片过大」。
 *
 * 运行前置：`packages/ui` 下先 `npm run build`（core 同源托管的是 dist，不是源码）。
 * 用法：`npm run probe:preview-image`；证据 `_probe-preview-image-evidence.json`；失败非 0 退出。
 *
 * 纪律（本探针最容易踩的两个坑，从实现方探针的教训抄来）：
 * - G2 **不得**包在 `if (hasImage)` 里静默跳过：取不到图片元素 ⇒ 判红 + 非零退出，
 *   并在证据里写明「图片链路未获验证」。静默跳过会让本批最大的验证缺口被吞掉。
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

const CORE_PORT = Number(process.env.PROBE_PREVIEW_IMAGE_CORE_PORT ?? 5199);
const CDP_PORT = Number(process.env.PROBE_PREVIEW_IMAGE_CDP_PORT ?? 9370);
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
    await cdp.eval(`window.addEventListener('error', () => { window.__err = (window.__err||0)+1; }, true);
                   window.__err = 0;`, false);
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
    A("G3 <img> complete === true（解码完成，非挂起）", {
      complete为true: g2facts.complete === true,
    });

    /* ===== G4：img.src 含 &v=（缓存破门的端到端证据） ===== */
    {
      const src = String(g2facts.src ?? "");
      A("G4 <img> src 含 &v=（fsVersion 缓存破门端到端生效）", {
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
      `(() => ({ tooLarge: window.__PI.tooLargeExists(), text: window.__PI.tooLargeText(), hasImg: window.__PI.imgFacts().exists, name: window.__PI.fileName() }))()`,
      true,
    );
    ctx.record("G6 超限占位", g6);
    A("G6 点 toolarge.png ⇒ preview-file-image-too-large 出现且文案含「图片过大」", {
      超限行可点: clickedTooLarge === true,
      too_large占位出现: g6.tooLarge === true,
      文案含图片过大: g6.text.includes("图片过大"),
      超限时不出img: g6.hasImg === false,
      文件名是toolarge_png: g6.name === "toolarge.png",
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

    /* ===== G9：页面无未捕获异常（window.onerror 计数 0 + CDP exceptionThrown 为空） ===== */
    phase = "G9 无未捕获异常";
    const windowErrCount = (await cdp.eval(`window.__err ?? 0`, true)) ?? 0;
    ctx.record("G9 异常计数", { windowErrCount, cdpExceptions: pageErrors.length, samples: pageErrors.slice(0, 3) });
    A("G9 页面无未捕获异常（window.onerror=0 且无 CDP exceptionThrown）", {
      window_onerror为0: windowErrCount === 0,
      无cdp未捕获异常: pageErrors.length === 0,
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