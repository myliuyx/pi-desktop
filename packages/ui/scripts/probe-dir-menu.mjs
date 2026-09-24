/**
 * 侧边栏「工作目录」改造验收探针 —— `probe:dir-menu`（mock）/ `probe:dir-menu:live`（live）。
 *
 * 写作方：**验收方（非实现方）** —— 项目铁律「验收脚本必须由非实现方写」。
 * 因此本文件**只从规格书推导断言**，不读 `packages/ui/src/**` 的实现细节。
 *
 * 规格：`.plan/task-sidebar-dir-menu.md`
 * - §4.0 接口冻结 = testid / role / `data-current-source` / 端口 的**唯一权威来源**；
 * - §七 验收 = C1–C16（通用，两形态都跑）+ C17–C22（形态差异）。
 *
 * 覆盖矩阵
 * ├─ mock（dev server :5180 + CDP 9348）：C1–C16 + C21
 * └─ live（core :5380 + CDP 9349，先 `npm run build`）：C1–C16 + C17/C18/C19/C20/C22
 *
 * 用法
 *   # 前置：packages/ui 起 dev server（默认 :5180）
 *   npm run probe:dir-menu
 *   # 前置：先 npm run build（core 同源托管 packages/ui/dist）
 *   npm run probe:dir-menu:live
 *
 * 模式切换：`--live` 命令行参数（跨平台，npm script 用它）**或** `PROBE_MODE=live` 环境变量。
 * 为什么 npm script 不用 `PROBE_MODE=live node …`：Windows 上 npm 用 cmd.exe 跑 script，
 * 前缀式 env 赋值会直接报「不是内部或外部命令」，而本项目禁止新增 cross-env 依赖。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * ★★★ C4 是全篇最关键的判据，**不要"优化"掉它** ★★★
 * ══════════════════════════════════════════════════════════════════════════════
 * 触发条位于 `sidebar-working-directory-content`（`overflow-y-auto`）内部，外层
 * `sidebar-working-directory-section` / `aside` **也都是 overflow-hidden**（规格 §4.7）。
 * 原地 `absolute bottom-full` 的上弹面板会落在容器的**负坐标区**被直接裁掉。
 *
 * 关键：那不是"没渲染"，是"渲染了但看不见" —— 被祖先裁掉的元素
 * `getBoundingClientRect()` **照样返回正常数值**（甚至是"恰好在上方"的漂亮数值）。
 * 所以**只量尺寸/位置的探针一定会假绿**，C3（rect 比较）单独用是不可信的。
 * 唯一可信证据是 `document.elementFromPoint(面板几何中心)` 命中的节点必须落在面板内 ——
 * 这正是 C4。任何"把 C4 换成 rect 判断"或"删掉 C4"的改动都会让整套上弹断言失去意义。
 *
 * 其它几处刻意的"防假绿"设计（同样别删）：
 * - C17：`CORE_CWD` 夹具用 `fs.mkdtempSync`，并在 Node 侧断言它 **≠ 默认值（core 的
 *   `process.cwd()`）**。夹具若等于默认值，「真接了 cwd」与「回落本地值」两种实现都会通过，
 *   这条判据就废了（本项目经典假绿模式）。
 * - C20：`unavailable` 与 `mock` 的**文字可能长得一样**（都可能是某个路径），只比对文字
 *   无法区分「诚实降级」与「悄悄回落」。所以必须有 `data-current-source` 属性断言，
 *   再加一条结构判据「显示值里不含 `/` 或 `\`」—— 回落成本地路径必被抓住。
 * - C13：面板 z=60 是为了盖住设置 Dialog 的 z-50（§4.9），因此必须用 elementFromPoint
 *   判"没被 backdrop 盖住"，不能只看"节点存在"。
 *
 * 端口（§4.0 冻结表；避开既有 CDP 9333/9337/9341/9342/9343/9345/9346/9347、
 * core 5350/5360、stub 5370）
 * | 脚本                 | dev/core        | CDP  | evidence                      |
 * |----------------------|-----------------|------|-------------------------------|
 * | probe:dir-menu       | dev :5180       | 9348 | _dir-menu-mock-evidence.json  |
 * | probe:dir-menu:live  | core :5380      | 9349 | _dir-menu-live-evidence.json  |
 *
 * 本脚本内部还会起两个**子 core 实例**（同一次实跑里串行，只为 C18 / C22 造不同 env）：
 *   :5381 不带 CORE_CWD（C18「缺省 ⇒ 回落 process.cwd()」）
 *   :5382 CORE_CWD 指向不存在的目录（C22「明确警告 + 回落 + 服务照常起来」）
 * 它们**不是**冻结表里的对外入口，只是 ::5380 之外的临时实例 —— 之所以不复用 5380，
 * 是为了避开 Windows 上端口 TIME_WAIT 的复用竞态（会让 core 起不来、报错还指不准）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser, waitForSelector, sleep } from "./cdp.mjs";
import { childEnv, seedModelsJson } from "../../core/scripts/lib/credentials.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiPkgDir = path.resolve(here, "..");
const repoRoot = path.resolve(here, "..", "..", "..");
const coreDir = path.join(repoRoot, "packages", "core");
const uiDist = path.join(repoRoot, "packages", "ui", "dist");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
const mainPath = path.join(coreDir, "src", "main.ts");

/* ---------------------------------------------------------------------------
 * 模式 / 端口 / 冻结常量
 * ------------------------------------------------------------------------- */

const LIVE = process.argv.includes("--live") || process.env.PROBE_MODE === "live";

/** mock：dev server（复用既有 :5180） */
const MOCK_ORIGIN = process.env.DIR_MENU_ORIGIN ?? "http://127.0.0.1:5180";
const MOCK_CDP = 9348;
const MOCK_EVIDENCE = "_dir-menu-mock-evidence.json";

/** live：core :5380 + CDP 9349（§4.0 冻结） */
const LIVE_PORT = 5380;
const LIVE_CDP = 9349;
const LIVE_EVIDENCE = "_dir-menu-live-evidence.json";
const LIVE_ORIGIN = `http://127.0.0.1:${LIVE_PORT}`;
const LIVE_TOKEN = "dir-menu-token";

/** 子 core（内部临时实例，见头注） */
const DEFAULT_CWD_PORT = 5381;
const DEFAULTCWD_ORIGIN = `http://127.0.0.1:${DEFAULT_CWD_PORT}`;
const BAD_CWD_PORT = 5382;
const BADCWD_ORIGIN = `http://127.0.0.1:${BAD_CWD_PORT}`;
/* C23：CORE_CWD 为纯空白（有值但 trim 后为空）——另一类坏值 */
const BLANK_CWD_PORT = 5383;
const BLANKCWD_ORIGIN = `http://127.0.0.1:${BLANK_CWD_PORT}`;

/** `mock/settings.ts:131` 的默认工作目录（mock 形态的回落值） */
const DEFAULT_WORKING_DIR = "~/projects/atlas-agent";
/** 规格 §4.8：超出该长度时保留末尾 N 字符、前缀补 `…` */
const MAX_PATH_TAIL_CHARS = 32;

/** mock 的 long path 夹具：> 32 字符，用来验 C16 的左侧省略分支 */
const MOCK_LONG_DIR = "/probe/very/long/working/directory/path/that/exceeds/thirty-two/characters";
/** mock 的短目录夹具（点击后验"短路径不截尾"与"首行立即变"） */
const MOCK_SHORT_DIRS = ["/probe/alpha", "/probe/beta"];
/**
 * live 的偏好夹具：`working-dir` 故意设为与真 cwd 不同的目录，
 * 这样 C19 的「下次启动」角标 / notice 才有可观测前提；
 * 同时让 C17 的「未回落成本地偏好」这条断言真正有鉴别力（否则等于没测）。
 */
const LIVE_PREF_DIR = "/probe/pref-other";
const LIVE_OTHER_DIR = "/probe/other-2";

/** C8 的 7 条夹具（含 1 条重复）：去重后 6 条，截 5 条 → d6..d2 */
const C8_SEED = [
  "/probe/d6",
  "/probe/d5",
  "/probe/d4",
  "/probe/d3",
  "/probe/d2",
  "/probe/d1",
  "/probe/d3",
];
const C8_EXPECT_FIRST = ["/probe/d6", "/probe/d5", "/probe/d4", "/probe/d3", "/probe/d2"];
const C8_CLICK_INDEX = 4; // 点最后一条（/probe/d2）→ 期望它被推到首位

/** 规格 §4.8 的展示规则：长度 > 32 时 = `…` + 末尾 32 字符 */
function expectedTailText(full) {
  return full.length > MAX_PATH_TAIL_CHARS ? `…${full.slice(-MAX_PATH_TAIL_CHARS)}` : full;
}

/* ---------------------------------------------------------------------------
 * 页面侧 helper（用 addScriptToEvaluateOnNewDocument 注入，reload 后仍在）
 * ⚠️ 模板字面量里正则的反斜杠必须**双写**，否则到浏览器里 `\d` 会变成 `d`、正则静默失效。
 * ------------------------------------------------------------------------- */

const HELPERS = `
window.__DM = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  rect: (el) => {
    const r = el.getBoundingClientRect();
    return { left: +r.left.toFixed(2), right: +r.right.toFixed(2), top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) };
  },
  trigger: () => document.querySelector('[data-testid="sidebar-working-directory"]'),
  panel: () => document.querySelector('[data-testid="sidebar-working-directory-menu"]'),
  pathEl: () => document.querySelector('[data-testid="sidebar-working-directory-path"]'),
  /*
   * ★ 当前行/最近项**必须限定在侧栏面板内**查找（2026-09-24 主控修正）：
   * 设置页面板的 recent/current 与侧栏**共用同一前缀 testid**（§4.0 如此冻结），
   * 而面板 portal 在 body 上 —— 若设置弹窗关闭后其面板仍残留（未修复前的实现缺陷），
   * 全文档前缀查询会把两个面板的条目混在一起（recentPaths 直接翻倍），
   * C6/C7/C8 全部读到脏数据。限定作用域后，这类污染会被 C13 的新增断言当场抓住，
   * 而不是静默渗进后续判据。
   */
  currentRow: () => {
    const p = window.__DM.panel();
    return p ? p.querySelector('[data-testid="sidebar-working-directory-current"]') : null;
  },
  pathTitle: () => {
    const p = window.__DM.pathEl();
    const t = window.__DM.trigger();
    return (p && p.getAttribute('title')) || (t && t.getAttribute('title')) || null;
  },
  /** 取"这一行的路径"：优先 title（全路径），否则取第一个叶子文本（避开"运行中/下次启动"角标） */
  itemPath: (el) => {
    if (!el) return null;
    if (el.getAttribute('title')) return el.getAttribute('title');
    const leaves = [...el.querySelectorAll('*')].filter(
      (n) => ![...n.children].some((c) => (c.textContent || '').trim().length > 0)
        && (n.textContent || '').trim().length > 0
        && !n.closest('[aria-hidden="true"]'),
    );
    return leaves.length ? leaves[0].textContent.trim() : (el.textContent || '').trim();
  },
  /** 只取真实的 recent-<index>，排除 recent-<index>-pending 这类后缀变体；**限定在侧栏面板内**（见 currentRow 注释） */
  recentItems: () => {
    const p = window.__DM.panel();
    if (!p) return [];
    return [...p.querySelectorAll('[data-testid^="sidebar-working-directory-recent-"]')]
      .filter((el) => /^sidebar-working-directory-recent-\\d+$/.test(el.dataset.testid || ''));
  },
  panelItems: () => {
    const p = window.__DM.panel();
    if (!p) return [];
    return window.__DM.qa('[role="menuitem"], [role="menuitemradio"]').filter((el) => p.contains(el));
  },
  activeId: () => {
    const a = document.activeElement;
    if (!a) return null;
    return (a.dataset && a.dataset.testid) ? a.dataset.testid : a.tagName.toLowerCase();
  },
  activeIndex: () => window.__DM.panelItems().indexOf(document.activeElement),
  panelState: () => {
    const p = window.__DM.panel();
    if (!p) return null;
    const cur = window.__DM.currentRow();
    const recents = window.__DM.recentItems();
    const pending = window.__DM.qa('[data-testid$="-pending"]')
      .filter((el) => p.contains(el))
      .map((el) => {
        /*
         * ★ ownerPath 必须取**所在行**（role=menuitemradio 的 button）的全路径 title。
         * 不能用 closest('[data-testid^="sidebar-working-directory-recent-"]')：
         * 角标自身的 testid 就带这个前缀（recent-<i>-pending），closest 从**自身**起匹配
         * 会命中角标自己 ⇒ itemPath(角标) 返回角标文字「下次启动」而不是路径
         * （2026-09-24 主控实踩：C19/C7/C8 的角标归属断言因此全挂，实现本身是对的）。
         */
        const row = el.closest('[role="menuitemradio"]');
        return {
          text: (el.textContent || '').trim(),
          owner: row ? row.dataset.testid : null,
          ownerPath: row ? row.getAttribute('title') : null,
        };
      });
    return {
      source: cur ? cur.getAttribute('data-current-source') : null,
      currentPath: cur ? window.__DM.itemPath(cur) : null,
      currentChecked: cur ? cur.getAttribute('aria-checked') : null,
      recentPaths: recents.map((el) => window.__DM.itemPath(el)),
      recentChecked: recents.map((el) => el.getAttribute('aria-checked')),
      pending,
      checkedTrueCount: p.querySelectorAll('[aria-checked="true"]').length,
      // 角标同样限定在侧栏面板内（设置页面板有同 testid 的角标，见 currentRow 注释）
      badgeRunning: !!p.querySelector('[data-testid="sidebar-working-directory-current-badge"]'),
    };
  },
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
    const a = window.__DM.lum(getComputedStyle(el).color);
    const b = window.__DM.lum(window.__DM.effBg(el));
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return +(((hi + 0.05) / (lo + 0.05)).toFixed(2));
  },
};
true;
`;

/** 取"最深叶子文本"节点：用来量「使用默认目录」「自定义路径…」的文字对比度 */
const LEAF_MEASURE = `
  const leaf = (el) => {
    if (!el) return null;
    const cands = [...el.querySelectorAll('*')].filter(
      (n) => ![...n.children].some((c) => (c.textContent || '').trim().length > 0)
        && (n.textContent || '').trim().length > 0
        && !n.closest('[aria-hidden="true"]'),
    );
    return cands.length ? cands[0] : el;
  };
  const measure = (el) => {
    const t = leaf(el);
    if (!t) return null;
    return { text: (t.textContent || '').trim().slice(0, 32), contrast: window.__DM.contrast(t) };
  };
`;

/**
 * notice 观测（C19 / C21 用）。
 * ⚠️ NoticeStack 的 item testid **不在 §4.0 冻结表里**，只赌单一 testid 会造成
 * 「探针找不到节点」型假失败。所以双通道：
 * ① `[data-testid^="notice"]` 前缀兜住常见命名（notice-item / notice-card / …）；
 * ② 文案通道 —— 规格 §4.6 明文要求 live 下选择目录的 notice 含「CORE_CWD」与「重启」，
 *    直接查 body 文本，完全从规格推导、不依赖任何实现命名。
 * C19（必须有 notice）：两通道任一命中即算有；C21（mock 不许有 notice）：两通道**都**为空。
 */
const NOTICE_PROBE = `(() => {
  const els = window.__DM.qa('[data-testid^="notice"]');
  const bodyText = (document.body.innerText || '');
  return {
    count: els.length,
    items: els.map((n) => ({ testid: n.dataset.testid ?? null, tone: n.dataset.tone ?? null, text: (n.textContent || '').trim().slice(0, 160) })),
    bodyTextHasCoreCwd: bodyText.includes('CORE_CWD'),
    bodyTextHasRestart: /重启/.test(bodyText),
  };
})()`;

/* ---------------------------------------------------------------------------
 * 键盘
 * ------------------------------------------------------------------------- */

const KEYS = {
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", virtualKeyCode: 38 },
  Home: { key: "Home", code: "Home", virtualKeyCode: 36 },
  End: { key: "End", code: "End", virtualKeyCode: 35 },
  Escape: { key: "Escape", code: "Escape", virtualKeyCode: 27 },
  Tab: { key: "Tab", code: "Tab", virtualKeyCode: 9 },
};

async function key(cdp, name, settle = 160) {
  await cdp.pressKey(KEYS[name]);
  await sleep(settle);
}

async function ensureClosed(cdp) {
  const open = await cdp.eval(`!!window.__DM.panel()`);
  if (open) {
    await key(cdp, "Escape");
    await sleep(120);
  }
}

/** 开面板（幂等）：先确保关，再点触发条，最后等面板真的挂上（首帧 opacity-0 → placed） */
async function openMenu(cdp) {
  await ensureClosed(cdp);
  const clicked = await cdp.eval(
    `(() => { const t = window.__DM.trigger(); if (!t) return false; t.focus(); t.click(); return true; })()`,
  );
  if (!clicked) return false;
  const appeared = await waitForSelector(cdp, '[data-testid="sidebar-working-directory-menu"]', 6000);
  await sleep(280); // 淡入 ~120ms + 长度余量
  return appeared;
}

/** 点某个 testid（返回是否存在） */
async function clickTestId(cdp, testid) {
  return cdp.eval(
    `(() => { const el = window.__DM.q('[data-testid=${JSON.stringify(testid)}]'); if (!el) return false; el.click(); return true; })()`,
  );
}

/** 等触发条路径的 title 变成期望全文（live 拿 cwd 是异步的） */
async function waitForPathTitle(cdp, expectedFull, timeout = 25000) {
  const t0 = Date.now();
  for (;;) {
    const got = await cdp.eval(`window.__DM.pathTitle()`);
    if (got === expectedFull) return { ok: true, got };
    if (Date.now() - t0 > timeout) return { ok: false, got };
    await sleep(300);
  }
}

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */

/*
 * ★ 必须定义在主派发（await runLive()/runMock()）**之前**：
 * 主派发会 await 到浏览器判据跑完才继续模块求值，其后的顶层 const 全在 TDZ 里 ——
 * C18/C22 曾因 cdpOf 定义在文件尾部而整段 ReferenceError 崩掉（2026-09-24 主控实踩）。
 */
const cdpOf = (ctx) => ctx.cdp;

let failures = 0;

if (LIVE) {
  await runLive();
} else {
  await runMock();
}

if (failures > 0) {
  console.error(`\n== probe:dir-menu（${LIVE ? "live" : "mock"}）有 ${failures} 条判据未通过 ==`);
  process.exit(1);
}
console.log(`\n== probe:dir-menu（${LIVE ? "live" : "mock"}）全部通过 ==`);

/* =========================================================================
 * mock 形态
 * ========================================================================= */
async function runMock() {
  await withBrowser({ port: MOCK_CDP, origin: MOCK_ORIGIN, evidencePath: MOCK_EVIDENCE }, async (ctx) => {
    const env = {
      mode: "mock",
      route: "/",
      seed: { working: MOCK_LONG_DIR, recent: MOCK_SHORT_DIRS },
      expectedFull: MOCK_LONG_DIR,
      coreDefaultCwd: null,
    };
    failures += await runSuite(ctx, env);
    finalize(ctx);
  });
}

/* =========================================================================
 * live 形态
 * ========================================================================= */
async function runLive() {
  console.log("[dir-menu:live] 检查 ui/dist 是否已 build …");
  if (!fs.existsSync(path.join(uiDist, "index.html"))) {
    console.error(`未找到 ${uiDist}\\index.html —— 请先在 packages/ui 下跑 npm run build`);
    process.exit(1);
  }

  /* 夹具：临时 agentDir（绝不碰 ~/.pi/agent）+ 临时 CORE_CWD */
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dir-menu-"));
  const agentDir = path.join(tmpRoot, "agentdir");
  fs.mkdirSync(agentDir, { recursive: true });
  /* 本探针只关心 "core 起得来 + /sessions 答得出来"，不需要可用模型；
     seedModelsJson 失败（夹具原件缺失）时兜底写空清单 —— 与 onboarding 同口径，core 照样就绪。 */
  if (!seedModelsJson(agentDir)) {
    fs.writeFileSync(path.join(agentDir, "models.json"), `${JSON.stringify({ providers: {} }, null, 2)}\n`);
  }
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ defaultProjectTrust: "never" }, null, 2),
  );

  /* ★ C17 的关键：夹具必须与默认值（core 的 process.cwd()）**不同**。
     若两者相同，「真接了 cwd」与「回落本地值」两种实现都会通过 ⇒ 判据失去鉴别力。
     另：刻意套一层子目录，保证路径长度 > MAX_PATH_TAIL_CHARS（否则 C16 的截尾分支测不到，
     例如某些机器 os.tmpdir() 就是 C:\\Temp）。 */
  const cwdRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dir-menu-cwd-fixture-"));
  const cwdFixture = path.join(cwdRoot, "workspace");
  fs.mkdirSync(cwdFixture, { recursive: true });
  const coreDefaultCwd = coreDir; // core 以 cwd: coreDir 启动 ⇒ 缺省 CORE_CWD 时 process.cwd() 就是它
  const fixtureDiffersFromDefault = cwdFixture !== coreDefaultCwd;
  console.log(
    `[dir-menu:live] CORE_CWD 夹具=${cwdFixture}\n[dir-menu:live] core 默认 cwd=${coreDefaultCwd}\n[dir-menu:live] 夹具与默认值不同=${fixtureDiffersFromDefault}`,
  );
  if (!fixtureDiffersFromDefault) {
    console.error("[dir-menu:live] 夹具与默认值相同 ⇒ C17 会假绿，脚本拒绝继续（请修夹具）");
    process.exit(1);
  }

  const cores = [];
  try {
    const coreA = launchCore({ port: LIVE_PORT, cwd: cwdFixture, suffix: "cwd-fixture", agentDir });
    cores.push(coreA);
    const healthA = await waitForHealth(LIVE_ORIGIN, LIVE_TOKEN, 90_000);
    if (!healthA) throw new Error("core 未就绪（/health 超时）");
    console.log(`[dir-menu:live] core 就绪：${JSON.stringify(healthA)}`);

    await withBrowser({ port: LIVE_CDP, origin: LIVE_ORIGIN, evidencePath: LIVE_EVIDENCE }, async (ctx) => {
      const env = {
        mode: "live",
        route: "/?live=1",
        seed: { working: LIVE_PREF_DIR, recent: [LIVE_OTHER_DIR, LIVE_PREF_DIR] },
        expectedFull: cwdFixture,
        coreDefaultCwd,
        // 供 C18 / C22 使用的子 core 启动器（也写进 cores 以便 finally 收尸）
        launch: (opts) => {
          const c = launchCore({ ...opts, agentDir });
          cores.push(c);
          return c;
        },
      };
      failures += await runSuite(ctx, env);

      /* ---------------- C18：不带 CORE_CWD 的子 core ---------------- */
      const coreB = env.launch({ port: DEFAULT_CWD_PORT, cwd: null, suffix: "default-cwd" });
      const healthB = await waitForHealth(DEFAULTCWD_ORIGIN, LIVE_TOKEN, 90_000);
      if (!healthB) throw new Error("C18 子 core 未就绪（/health 超时）");
      await navigateHard(ctx, `${DEFAULTCWD_ORIGIN}/?live=1`);
      const c18cwd = await waitForPathTitle(cdpOf(ctx), coreDefaultCwd, 25000);
      await openMenu(cdpOf(ctx));
      const c18 = await cdpOf(ctx).eval(`(() => {
        const p = window.__DM.pathEl();
        const cur = window.__DM.currentRow();
        return {
          pathTitle: p ? p.getAttribute('title') : null,
          pathText: p ? (p.textContent || '').trim() : null,
          source: cur ? cur.getAttribute('data-current-source') : null,
          apiCwd: null,
        };
      })()`);
      c18.apiCwd = await coreGet(DEFAULTCWD_ORIGIN, "/sessions").then((j) => j?.cwd ?? null);
      if (!c18cwd.ok) c18.waitedTitle = c18cwd.got;
      failures += checkLive(ctx, "C18", "live：CORE_CWD 缺省 ⇒ 侧栏显示 core 的 process.cwd()（行为与改动前一致）", {
        路径等于core的cwd: c18.pathTitle === coreDefaultCwd,
        "data_current_source为live": c18.source === "live",
        core自己回的cwd也是它: c18.apiCwd === coreDefaultCwd,
        与C17夹具不同: coreDefaultCwd !== env.expectedFull,
      }, { ...c18, 期望: coreDefaultCwd, "C17夹具": env.expectedFull });
      await coreB.close();
      cores.splice(cores.indexOf(coreB), 1);

      /* ---------------- C22：CORE_CWD 指向不存在的目录 ---------------- */
      const badCwd = path.join(tmpRoot, "definitely-missing-dir");
      const coreC = env.launch({ port: BAD_CWD_PORT, cwd: badCwd, suffix: "bad-cwd" });
      const healthC = await waitForHealth(BADCWD_ORIGIN, LIVE_TOKEN, 90_000);
      const log = readText(coreC.logPath);
      const lines = log.split(/\r?\n/);
      const sessionsC = await coreGet(BADCWD_ORIGIN, "/sessions");
      const warnLines = lines.filter((l) => /警告|WARN/i.test(l));
      const badLines = lines.filter((l) => l.includes(badCwd));
      const fallbackLines = lines.filter((l) => l.includes(coreDefaultCwd));
      failures += checkLive(ctx, "C22", "core：CORE_CWD 指向不存在的目录 ⇒ 明确警告（点名原值 + 回落值）+ 回落 process.cwd() + 服务照常起来", {
        服务正常起来: !!healthC && healthC.ok === true,
        生效cwd已回落: sessionsC?.cwd === coreDefaultCwd,
        有一行警告一起点名原值与回落值: lines.some(
          (l) => /警告|WARN/i.test(l) && l.includes(badCwd) && l.includes(coreDefaultCwd),
        ),
        警告点名了不存在的原值: badLines.length > 0,
        警告点名了回落后的值: fallbackLines.length > 0,
        确实有警告行: warnLines.length > 0,
        日志可读非空: lines.filter(Boolean).length > 0,
      }, {
        不存在的CORE_CWD: badCwd,
        期望回落值: coreDefaultCwd,
        警告行: warnLines.map((l) => l.trim().slice(0, 200)),
        核心cwd回落行: fallbackLines.map((l) => l.trim().slice(0, 200)),
        "sessions.cwd": sessionsC?.cwd ?? null,
        日志尾部: lines.slice(-8).map((l) => l.trim().slice(0, 200)),
      });
      await coreC.close();
      cores.splice(cores.indexOf(coreC), 1);

      /* ---------------- C23：CORE_CWD 为纯空白 ---------------- */
      /*
       * “有值但全是空白”是另一类坏值：旧实现用 `if (rawCwd && rawCwd.trim())` 直接跳过，
       * 既不警告也不回落 —— 属“静默降级”。本判据要求它与 C22 一样点名警告 + 回落。
       */
      const coreD = env.launch({ port: BLANK_CWD_PORT, cwd: "   ", suffix: "blank-cwd" });
      const healthD = await waitForHealth(BLANKCWD_ORIGIN, LIVE_TOKEN, 90_000);
      const logD = readText(coreD.logPath);
      const linesD = logD.split(/\r?\n/);
      const sessionsD = await coreGet(BLANKCWD_ORIGIN, "/sessions");
      failures += checkLive(ctx, "C23", "core：CORE_CWD 为纯空白 ⇒ 明确警告 + 回落 process.cwd() + 服务照常起来（不静默降级）", {
        服务正常起来: !!healthD && healthD.ok === true,
        生效cwd已回落: sessionsD?.cwd === coreDefaultCwd,
        确实有警告行: linesD.some((l) => /警告|WARN/i.test(l)),
        警告点名回落后的值: linesD.some((l) => /警告|WARN/i.test(l) && l.includes(coreDefaultCwd)),
      }, {
        "空白CORE_CWD": "   ",
        期望回落值: coreDefaultCwd,
        警告行: linesD.filter((l) => /警告|WARN/i.test(l)).map((l) => l.trim().slice(0, 200)),
        "sessions.cwd": sessionsD?.cwd ?? null,
        日志尾部: linesD.slice(-8).map((l) => l.trim().slice(0, 200)),
      });
      await coreD.close();
      cores.splice(cores.indexOf(coreD), 1);

      /* 所有判据（含 C18/C22/C23）跑完，统一落盘一次 */
      finalize(ctx);
    });

    /*
     * ★ 证据完整性自检：C18/C22/C23 是跑在 runSuite 之后的子 core 判据，
     *   必须出现在落盘 evidence 里。2026-09-24 实踩：ctx.save() 留在 runSuite 内，
     *   导致磁盘证据只有 19 条、三个 core 级判据“跑了却没证据”。此自检防止回归。
     */
    {
      const ev = JSON.parse(readText(path.join(uiPkgDir, LIVE_EVIDENCE)) || "{}");
      const names = (ev.assertions ?? []).map((a) => a.name);
      const required = ["C18", "C22", "C23"];
      const missing = required.filter((id) => !names.some((n) => n.startsWith(`${id} `)));
      if (missing.length) {
        console.error(
          `[dir-menu:live] 证据完整性失败：evidence 缺少 ${missing.join(", ")}（仅 ${names.length} 条断言）`,
        );
        failures += 1;
      } else {
        console.log(`[dir-menu:live] 证据完整性：C18/C22/C23 均已落盘（共 ${names.length} 条断言）`);
      }
    }
  } catch (e) {
    console.error("[dir-menu:live] 脚本异常:", e && e.stack ? e.stack : e);
    for (const c of cores) {
      try {
        console.error(`[dir-menu:live] ${path.basename(c.logPath)} 尾部：\n${readText(c.logPath).slice(-3000)}`);
      } catch {
        /* 日志不可读 */
      }
    }
    failures += 1;
  } finally {
    for (const c of cores) await c.close();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(cwdRoot, { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }
}

/* =========================================================================
 * 共用判据主体（mock / live 同一份，避免两份 90% 雷同的代码各自漂移）
 * ========================================================================= */

async function runSuite(ctx, env) {
  const { cdp } = ctx;
  let fails = 0;

  /** 统一的判据出口：先落原始观测（能定位失败原因），再判 pass */
  const check = (id, title, detail, measured) => {
    if (measured !== undefined) ctx.record(`${id}_实测`, measured);
    const pass = ctx.assert(`${id} ${title}`, detail);
    return pass ? 0 : 1;
  };

  /* 未捕获异常 / 控制台错误收集：必须在第一次导航前挂上监听器 */
  const exceptions = [];
  const consoleErrors = [];
  cdp.ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Runtime.exceptionThrown") {
        exceptions.push(msg.params?.exceptionDetails?.exception?.description ?? "unknown");
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" "));
      }
    } catch {
      /* 忽略非 JSON */
    }
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HELPERS });

  const isLive = env.mode === "live";

  /* ---------- 0. 播种 localStorage，再进正式形态 ---------- */
  // 先在 origin 上落一页，才能写 localStorage（同源限制）
  await ctx.open("/");
  await cdp.eval(HELPERS);
  await seedStorage(cdp, env.seed);
  await ctx.open(env.route);
  await cdp.eval(HELPERS);
  if (isLive) {
    // live 的 cwd 是异步拿到的，先等它落定，后面的 C16/C17 才有稳定口径
    const arrived = await waitForPathTitle(cdp, env.expectedFull, 25000);
    ctx.record("live_cwd_到达观测", arrived);
  }

  const noteSkipped = (id, why) => ctx.record(`${id}_不适用`, { mode: env.mode, 说明: why });

  /* =============================================================== C1 */
  {
    const r = await cdp.eval(`(() => {
      const el = window.__DM.q('[data-testid="sidebar-change-directory"]');
      return { exists: !!el, tag: el ? el.tagName.toLowerCase() : null };
    })()`);
    fails += check("C1", "哑按钮「打开文件夹」已从 DOM 删除", {
      "sidebar_change_directory不存在": r.exists === false,
    }, r);
  }

  /* =============================================================== C2 */
  {
    await ensureClosed(cdp);
    const closed = await cdp.eval(`(() => {
      const t = window.__DM.trigger();
      if (!t) return { exists: false };
      const focusable = (() => { t.focus(); return document.activeElement === t; })();
      return {
        exists: true,
        tag: t.tagName.toLowerCase(),
        type: t.getAttribute('type'),
        haspopup: t.getAttribute('aria-haspopup'),
        expandedClosed: t.getAttribute('aria-expanded'),
        controlsWhenClosed: t.hasAttribute('aria-controls'),
        title: t.getAttribute('title'),
        focusable,
      };
    })()`);
    const opened = await openMenu(cdp);
    const open = await cdp.eval(`(() => {
      const t = window.__DM.trigger();
      return {
        expandedOpen: t.getAttribute('aria-expanded'),
        controlsWhenOpen: t.hasAttribute('aria-controls'),
        panelPresent: !!window.__DM.panel(),
      };
    })()`);
    fails += check("C2", "触发条是可聚焦 <button> + aria-haspopup=menu；点击后 aria-expanded 翻转且面板出现", {
      触发条存在: closed.exists === true,
      是button: closed.tag === "button",
      可聚焦: closed.focusable === true,
      有haspopup_menu: closed.haspopup === "menu",
      收起时expanded为false: closed.expandedClosed === "false",
      展开时expanded为true: open.expandedOpen === "true",
      点击后面板出现: opened === true && open.panelPresent === true,
      说明_aria_controls仅展开时持有:
        open.controlsWhenOpen === true && closed.controlsWhenClosed === false,
    }, { closed, open, opened });
  }

  /* =============================================================== C3 */
  {
    await openMenu(cdp);
    const geo = await cdp.eval(`(() => ({
      trigger: window.__DM.rect(window.__DM.trigger()),
      panel: window.__DM.rect(window.__DM.panel()),
    }))()`);
    fails += check("C3", "面板**向上**弹出：panelRect.bottom <= triggerRect.top", {
      面板底不高于触发条顶: geo.panel.bottom <= geo.trigger.top + 0.5,
      面板有实际尺寸: geo.panel.width > 0 && geo.panel.height > 0,
    }, geo);
  }

  /* =============================================================== C4 ★核心★ */
  {
    // ⚠️ 只量 rect 会因为「被祖先 overflow 裁掉」而假绿 —— 唯一可信判据见文件头 ★C4 段。
    const c4 = await cdp.eval(`(() => {
      const p = window.__DM.panel();
      if (!p) return { exists: false };
      const r = p.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        exists: true,
        center: { x: +cx.toFixed(1), y: +cy.toFixed(1) },
        panelRect: window.__DM.rect(p),
        hitTag: hit ? hit.tagName.toLowerCase() : null,
        hitTestId: hit && hit.dataset ? (hit.dataset.testid ?? null) : null,
        hitInsidePanel: !!hit && p.contains(hit),
        hitIsPanel: hit === p,
      };
    })()`);
    fails += check(
      "C4",
      "面板**未被任何祖先裁剪**：elementFromPoint(面板几何中心) 命中节点在面板内（唯一可信判据）",
      {
        面板存在: c4.exists === true,
        中心命中在面板内: c4.hitInsidePanel === true,
      },
      c4,
    );
  }

  /* =============================================================== C5 */
  {
    const c5 = await cdp.eval(`(() => {
      const p = window.__DM.panel();
      const q = (s) => window.__DM.q('[data-testid="' + s + '"]');
      const cur = q('sidebar-working-directory-current');
      const def = q('sidebar-working-directory-default');
      const custom = q('sidebar-working-directory-custom');
      const recents = window.__DM.recentItems();
      const curMark = cur ? (!!cur.querySelector('svg') || /✓/.test(cur.textContent || '')) : false;
      return {
        panelRole: p ? p.getAttribute('role') : null,
        panelLabel: p ? p.getAttribute('aria-label') : null,
        curExists: !!cur,
        curRole: cur ? cur.getAttribute('role') : null,
        curDisabled: cur ? cur.getAttribute('aria-disabled') : null,
        curChecked: cur ? cur.getAttribute('aria-checked') : null,
        curMark,
        curPath: cur ? window.__DM.itemPath(cur) : null,
        recentCount: recents.length,
        recentRole: recents[0] ? recents[0].getAttribute('role') : null,
        recentCheckedAttr: recents[0] ? recents[0].getAttribute('aria-checked') : null,
        defExists: !!def,
        defRole: def ? def.getAttribute('role') : null,
        customExists: !!custom,
        customRole: custom ? custom.getAttribute('role') : null,
        customText: custom ? (custom.textContent || '').trim() : null,
      };
    })()`);
    fails += check("C5", "面板结构齐备：当前目录行（role=menuitemradio + aria-checked=true 且含 ✓）/ 最近目录区 / 使用默认目录 / 自定义路径…", {
      面板role_menu: c5.panelRole === "menu",
      面板aria_label为工作目录: c5.panelLabel === "工作目录",
      当前行存在: c5.curExists === true,
      当前行role_menuitemradio: c5.curRole === "menuitemradio",
      当前行aria_disabled为true: c5.curDisabled === "true",
      当前行aria_checked为true: c5.curChecked === "true",
      当前行含勾标记: c5.curMark === true,
      最近目录区非空: c5.recentCount >= 2,
      最近项目role_menuitemradio: c5.recentRole === "menuitemradio",
      最近项目带aria_checked: c5.recentCheckedAttr !== null,
      使用默认目录存在: c5.defExists === true && c5.defRole === "menuitem",
      自定义路径存在: c5.customExists === true && c5.customRole === "menuitem",
      自定义路径文案可读: c5.customText.includes("自定义路径"),
    }, c5);
  }

  /* =============================================================== C14 */
  {
    const c14 = await cdp.eval(
      `(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }))()`,
    );
    fails += check("C14", "无横向滚动：documentElement.scrollWidth <= clientWidth + 1（G6）", {
      无横向滚动: c14.scrollWidth <= c14.clientWidth + 1,
    }, c14);
  }

  /* =============================================================== C15 */
  {
    const light = await measureContrast(cdp);
    await ensureClosed(cdp);
    await clickTestId(cdp, "titlebar-toggle-theme");
    await sleep(400);
    const themeNow = await cdp.eval(`document.documentElement.dataset.theme || null`);
    await openMenu(cdp);
    const dark = await measureContrast(cdp);
    await ensureClosed(cdp);
    await clickTestId(cdp, "titlebar-toggle-theme"); // 还原主题，别污染后续判据
    await sleep(400);
    const restored = await cdp.eval(`document.documentElement.dataset.theme || null`);
    const minOf = (m) =>
      Math.min(
        ...[m.pathEl, m.defaultItem, m.customItem].filter(Boolean).map((x) => x.contrast),
      );
    fails += check("C15", "深浅两主题下路径 / 动作文字与面板背景对比度 >= 4.5（G3）", {
      浅色_路径对比度达标: !!light.pathEl && light.pathEl.contrast >= 4.5,
      浅色_默认目录对比度达标: !!light.defaultItem && light.defaultItem.contrast >= 4.5,
      浅色_自定义路径对比度达标: !!light.customItem && light.customItem.contrast >= 4.5,
      深色_路径对比度达标: !!dark.pathEl && dark.pathEl.contrast >= 4.5,
      深色_默认目录对比度达标: !!dark.defaultItem && dark.defaultItem.contrast >= 4.5,
      深色_自定义路径对比度达标: !!dark.customItem && dark.customItem.contrast >= 4.5,
      两主题确实切换过: light.theme !== dark.theme,
      主题已还原: restored === light.theme,
    }, { 浅色: light, 深色: dark, 切换后主题: themeNow, 还原后主题: restored, 浅色最低对比度: minOf(light), 深色最低对比度: minOf(dark) });
  }

  /* =============================================================== C16 */
  {
    await openMenu(cdp);
    const c16 = await cdp.eval(`(() => {
      const p = window.__DM.pathEl();
      const t = window.__DM.trigger();
      if (!p) return { exists: false };
      return {
        exists: true,
        text: (p.textContent || '').trim(),
        title: p.getAttribute('title'),
        triggerTitle: t ? t.getAttribute('title') : null,
        scrollWidth: p.scrollWidth,
        clientWidth: p.clientWidth,
        className: String(p.className),
        triggerScrollWidth: t ? t.scrollWidth : null,
        triggerClientWidth: t ? t.clientWidth : null,
      };
    })()`);
    const expectText = expectedTailText(env.expectedFull);
    /*
     * ★ 2026-09-24 主控修正口径：不能对 truncate 元素断言 scrollWidth <= clientWidth ——
     * 文本**真被截断**时 scrollWidth（内容宽）必然大于 clientWidth（盒宽），
     * 旧 5-8 能通过只因旧夹具路径太短、从未真正触发截断。
     * 正确口径：溢出**被 CSS 截断管住**（scrollWidth > clientWidth 时必须带 truncate 类）
     * + 承载它的触发条自身不横向溢出 + title 给全称（M5 5-8 的本意）。
     */
    const overflowContained = c16.exists
      && (c16.scrollWidth <= c16.clientWidth || /truncate/.test(c16.className));
    fails += check("C16", "长路径：溢出被 CSS 截断管住（truncate）、触发条自身无横向溢出、title = 全路径、左侧省略规则生效（>32 字符时首字符为 …）", {
      路径span存在: c16.exists === true,
      溢出被truncate管住: overflowContained,
      触发条无横向溢出: c16.exists && c16.triggerScrollWidth <= c16.triggerClientWidth + 1,
      title为全路径: c16.title === env.expectedFull,
      触发条title也是全路径: c16.triggerTitle === env.expectedFull,
    截尾规则正确: c16.text === expectText,
    保留truncate类: /truncate/.test(c16.className),
    夹具确实超过32字符: env.expectedFull.length > MAX_PATH_TAIL_CHARS,
  }, { ...c16, 期望全文: env.expectedFull, 期望文字: expectText, 全路径长度: env.expectedFull.length });
  }

  /* =============================================================== C11 */
  {
    // Esc 关闭并把焦点还给触发条
    await openMenu(cdp);
    await sleep(160); // 等"展开后焦点落到当前项"的 requestAnimationFrame
    const beforeEsc = await cdp.eval(`({ menuOpen: !!window.__DM.panel(), active: window.__DM.activeId() })`);
    await key(cdp, "Escape");
    await sleep(160);
    const afterEsc = await cdp.eval(`(() => ({
      menuGone: !window.__DM.panel(),
      focusOnTrigger: document.activeElement === window.__DM.trigger(),
      active: window.__DM.activeId(),
    }))()`);

    // 点面板外部关闭（规格 §4.7：外部 pointerdown）
    await openMenu(cdp);
    await cdp.eval(
      `(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true; })()`,
    );
    await sleep(280);
    const afterOutside = await cdp.eval(`!window.__DM.panel()`);

    fails += check("C11", "Escape 关闭并归还焦点；点面板外部关闭", {
      "Escape前焦点在面板内": beforeEsc.menuOpen === true,
      "Escape后面板关闭": afterEsc.menuGone === true,
      "Escape后焦点回到触发条": afterEsc.focusOnTrigger === true,
      外部pointerdown后面板关闭: afterOutside === true,
    }, { beforeEsc, afterEsc, 外部点击后已关闭: afterOutside });
  }

  /* =============================================================== C12 */
  {
    await ensureClosed(cdp);
    await cdp.eval(`(() => { const t = window.__DM.trigger(); t.focus(); return true; })()`);
    await key(cdp, "ArrowDown", 320);
    const opened = await cdp.eval(`(() => ({
      menuOpen: !!window.__DM.panel(),
      active: window.__DM.activeId(),
      index: window.__DM.activeIndex(),
      inPanel: (() => { const p = window.__DM.panel(); return !!p && p.contains(document.activeElement); })(),
      itemCount: window.__DM.panelItems().length,
    }))()`);
    await key(cdp, "ArrowDown");
    const down = await cdp.eval(`({ active: window.__DM.activeId(), index: window.__DM.activeIndex() })`);
    await key(cdp, "ArrowUp");
    const up = await cdp.eval(`({ active: window.__DM.activeId(), index: window.__DM.activeIndex() })`);
    await key(cdp, "End");
    const end = await cdp.eval(`({ active: window.__DM.activeId(), index: window.__DM.activeIndex() })`);
    await key(cdp, "Home");
    const home = await cdp.eval(`({ active: window.__DM.activeId(), index: window.__DM.activeIndex() })`);
    await key(cdp, "Tab");
    await sleep(200);
    const afterTab = await cdp.eval(`({ menuGone: !window.__DM.panel(), active: window.__DM.activeId() })`);

    fails += check("C12", "键盘：ArrowUp/Down 漫游、Home/End 跳两端、Tab 关闭后焦点自然离开", {
      收起时ArrowDown可展开: opened.menuOpen === true,
      展开后焦点落在面板内: opened.inPanel === true,
      展开后落在当前项: opened.active === "sidebar-working-directory-current",
      面板可漫游项不少于4: opened.itemCount >= 4,
      "ArrowDown前进一格": down.index === opened.index + 1,
      "ArrowUp后退一格": up.index === opened.index,
      "End跳到末项": end.index === opened.itemCount - 1,
      "Home跳回首端": home.index <= 1 && home.index !== end.index,
      面板收起了: afterTab.menuGone === true,
    }, { opened, down, up, end, home, afterTab });
  }

  /* =============================================================== C10 */
  {
    await openMenu(cdp);
    const beforeCollapse = await cdp.eval(`!!window.__DM.panel()`);
    await clickTestId(cdp, "titlebar-toggle-sidebar");
    await sleep(450);
    const collapsed = await cdp.eval(`(() => ({
      menuGone: !window.__DM.panel(),
      collapsed: window.__DM.q('[data-testid="sidebar"]').dataset.collapsed,
    }))()`);
    await clickTestId(cdp, "titlebar-toggle-sidebar");
    await sleep(450);
    const restored = await cdp.eval(`(() => ({
      collapsed: window.__DM.q('[data-testid="sidebar"]').dataset.collapsed,
      triggerThere: !!window.__DM.trigger(),
    }))()`);
    fails += check("C10", "点 titlebar-toggle-sidebar 折叠侧栏 ⇒ 面板自动关闭（portal 方案的必需项）", {
      折叠前面板是开的: beforeCollapse === true,
      折叠后面板已关闭: collapsed.menuGone === true,
      侧栏确实折叠了: collapsed.collapsed === "true",
      已复原未折叠: restored.collapsed === "false" && restored.triggerThere === true,
    }, { collapsed, restored });
  }

  /* =============================================================== C13 */
  {
    await openMenu(cdp); // 先让侧栏面板处于打开态
    await clickTestId(cdp, "sidebar-footer-settings");
    await sleep(700);
    const a = await cdp.eval(`(() => {
      const d = document.querySelector('[role="dialog"]');
      return { sidebarMenuGone: !window.__DM.panel(), dialogOpen: !!d && !d.hasAttribute('inert') };
    })()`);

    await clickTestId(cdp, "settings-tab-general");
    await sleep(350);
    /*
     * 「更改」按钮的 testid **不在 §4.0 冻结表里**（冻结的只有面板 testid
     * `settings-working-dir-menu`），赌单一 testid 会在实现方另起名字时变成
     * 「探针找不到节点」型失败。所以按规格可推导的口径定位：§4.9 说设置页是
     * 「更改」按钮，且 probe:settings P2 已验证 `settings-working-dir` 组存在 ——
     * 在该组内按文案找按钮。点击方式不冻结、面板 testid 才是断言对象。
     */
    const clickedChange = await cdp.eval(`(() => {
      const group = window.__DM.q('[data-testid="settings-working-dir"]');
      if (!group) return { groupFound: false, clicked: false };
      const btn = [...group.querySelectorAll('button')].find((b) => (b.textContent || '').includes('更改'));
      if (!btn) return { groupFound: true, clicked: false, buttons: [...group.querySelectorAll('button')].map((b) => (b.textContent || '').trim().slice(0, 20)) };
      const title = btn.getAttribute('title');
      btn.click();
      return { groupFound: true, clicked: true, title };
    })()`);
    await sleep(450);
    const b = await cdp.eval(`(() => {
      const m = window.__DM.q('[data-testid="settings-working-dir-menu"]');
      if (!m) return { exists: false };
      const r = m.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const d = document.querySelector('[role="dialog"]');
      return {
        exists: true,
        rect: window.__DM.rect(m),
        hitTag: hit ? hit.tagName.toLowerCase() : null,
        hitTestId: hit && hit.dataset ? (hit.dataset.testid ?? null) : null,
        hitInMenu: !!hit && m.contains(hit),
        sidebarMenuStillGone: !window.__DM.panel(),
        dialogStillOpen: !!d && !d.hasAttribute('inert'),
        text: (m.textContent || '').trim().slice(0, 80),
      };
    })()`);
    await clickTestId(cdp, "settings-dialog-close");
    await sleep(500);
    /*
     * ★ 关弹窗后必须收尾干净（2026-09-24 主控新增断言，抓的就是本次实踩的实现缺口）：
     * Dialog 关闭 = inert + opacity-0 + pointer-events-none，**不卸载 children**；
     * 而设置页面板 portal 在 body 上、**不是** dialog 的 DOM 后代 —— inert 管不到它。
     * 实现若不在 settingsOpen 变 false 时主动关面板，就会留下一个
     * 「弹窗已关、面板还浮着且可点」的孤儿浮层，且其同前缀 testid 会污染
     * 后续所有面板测量（C6/C7/C8 因此读到翻倍的 recentPaths，见 currentRow 注释）。
     */
    const c = await cdp.eval(`(() => {
      const d = document.querySelector('[role="dialog"]');
      return {
        dialogClosed: !d || d.hasAttribute('inert'),
        settingsMenuGone: !window.__DM.q('[data-testid="settings-working-dir-menu"]'),
      };
    })()`);

    fails += check("C13", "设置弹窗打开时侧栏面板不残留；设置页「更改」弹出的面板**可见**（未被 backdrop 盖住，z=60 生效）；**关弹窗后设置面板不残留**", {
      打开设置时侧栏面板已消失: a.sidebarMenuGone === true,
      设置弹窗确实打开了: a.dialogOpen === true,
      "设置页更改按钮可点": clickedChange.clicked === true,
      设置页面板存在: b.exists === true,
      设置页面板可见_未被backdrop盖住: b.exists === true && b.hitInMenu === true,
      设置打开期间侧栏面板未回流: b.exists === true && b.sidebarMenuStillGone === true,
      设置弹窗仍在: b.exists === true && b.dialogStillOpen === true,
      关闭设置后弹窗已收起: c.dialogClosed === true,
      关闭设置后设置面板不残留: c.settingsMenuGone === true,
      // mock 下选择即生效、无「重启」语义；live 下才提示「下次启动 core 时使用」
      ...(isLive
        ? { live设置更改按钮提示重启: /下次启动|重启/.test(clickedChange.title ?? "") }
        : { mock设置更改按钮不提示重启: !/下次启动|重启/.test(clickedChange.title ?? "") }),
    }, { a, clickedChange, b, c });
  }

  /* =============================================================== C17（live） */
  if (!isLive) {
    noteSkipped("C17", "形态差异判据，仅在 live 形态执行（请跑 probe:dir-menu:live）");
  } else {
    await openMenu(cdp);
    const st = await readPanelState(cdp);
    const triggerTitle = await cdp.eval(`window.__DM.pathTitle()`);
    fails += check("C17", "live：侧栏显示 core 的真实 cwd（CORE_CWD 夹具），**不是**本地偏好值", {
      首行等于夹具目录: st.currentPath === env.expectedFull,
      "data_current_source为live": st.source === "live",
      触发条title等于夹具目录: triggerTitle === env.expectedFull,
      未回落成本地偏好: st.currentPath !== env.seed.working && st.currentPath !== DEFAULT_WORKING_DIR,
      运行中角标在首行: st.badgeRunning === true,
      夹具与core默认cwd不同: env.expectedFull !== env.coreDefaultCwd,
    }, {
      ...st,
      期望: env.expectedFull,
      本地偏好: env.seed.working,
      "core默认cwd": env.coreDefaultCwd,
      触发条title: triggerTitle,
    });
  }

  /* =============================================================== C19（live） */
  if (!isLive) {
    noteSkipped("C19", "形态差异判据，仅在 live 形态执行");
  } else {
    await openMenu(cdp);
    const before = await readPanelState(cdp);
    await clickTestId(cdp, "sidebar-working-directory-recent-0");
    await sleep(450);
    const afterClick = await cdp.eval(`(() => ({
      menuGone: !window.__DM.panel(),
      notice: ${NOTICE_PROBE},
      workingDirStorage: localStorage.getItem('working-dir'),
    }))()`);
    await openMenu(cdp);
    const after = await readPanelState(cdp);
    const notice = afterClick.notice;
    const noticeTexts = notice.items.map((n) => n.text).join(" | ");
    fails += check("C19", "live：点最近目录 ⇒ 首行不变（仍真 cwd）+ 弹 notice 提示需 CORE_CWD 重启 + 偏好项出「下次启动」灰字且不出现第二个 ✓", {
      点击前首行是真cwd: before.currentPath === env.expectedFull,
      点击前角标只在偏好项上:
        before.pending.length === 1 &&
        before.pending[0].text === "下次启动" &&
        before.pending[0].ownerPath === env.seed.working,
      点击后面板关闭: afterClick.menuGone === true,
      点击后偏好已记下: afterClick.workingDirStorage === LIVE_OTHER_DIR,
      弹出了notice: notice.count > 0 || notice.bodyTextHasCoreCwd,
      notice文案含CORE_CWD:
        notice.items.some((t) => t.text.includes("CORE_CWD")) || notice.bodyTextHasCoreCwd,
      notice提示需重启:
        notice.items.some((t) => /重启/.test(t.text)) ||
        (notice.bodyTextHasCoreCwd && notice.bodyTextHasRestart),
      点击后首行不变: after.currentPath === env.expectedFull,
      "点击后data_current_source仍为live": after.source === "live",
      只有一个勾_无第二个:
        after.checkedTrueCount === 1 && after.recentChecked.every((c) => c !== "true"),
      角标指向新偏好:
        after.pending.length === 1 &&
        after.pending[0].text === "下次启动" &&
        after.pending[0].ownerPath === LIVE_OTHER_DIR,
      运行中角标仍在: after.badgeRunning === true,
    }, { before, afterClick, after, notice文案: noticeTexts });
  }

  /* =============================================================== C6 */
  {
    await openMenu(cdp);
    // 刻意选**最后一个**最近目录（不是 0）：live 下 C19 刚把 recent-0 记成偏好，
    // 若这里再点同一条，就成了「点了个没变化的值」——判据会退化成只测"关不关面板"。
    const st = await readPanelState(cdp);
    const idx = Math.max(0, st.recentPaths.length - 1);
    const target = st.recentPaths[idx] ?? null;
    const clicked = await clickTestId(cdp, `sidebar-working-directory-recent-${idx}`);
    await sleep(400);
    const r = await cdp.eval(`(() => ({
      workingDirStorage: localStorage.getItem('working-dir'),
      menuGone: !window.__DM.panel(),
      focusOnTrigger: document.activeElement === window.__DM.trigger(),
      active: window.__DM.activeId(),
    }))()`);
    fails += check("C6", "选一项后：localStorage[working-dir] 变更 + 面板关闭 + 焦点回到触发条", {
      "按钮可点": clicked === true,
      "localStorage_working_dir已是所选值": target !== null && r.workingDirStorage === target,
      所选值确实与点前不同: target !== null && target !== st.currentPath,
      面板已关闭: r.menuGone === true,
      焦点回到触发条: r.focusOnTrigger === true,
    }, { 点选索引: idx, 目标目录: target, 点前首行: st.currentPath, ...r });
  }

  /* =============================================================== C7 */
  {
    await openMenu(cdp);
    const clicked = await clickTestId(cdp, "sidebar-working-directory-default");
    await sleep(400);
    const stored = await cdp.eval(`(() => ({
      workingDir: localStorage.getItem('working-dir'),
      recent: (() => { try { const v = JSON.parse(localStorage.getItem('recent-dirs') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })(),
    }))()`);
    await openMenu(cdp);
    const panel = await readPanelState(cdp);
    await ensureClosed(cdp);
    /*
     * ★ 2026-09-24 裁决改写：「使用默认目录」= **清除偏好**，不再写回任何路径 ——
     * live 的「默认」是 core 未来启动时的 `process.cwd()`，UI 此刻拿不到；写死
     * mock 占位值只会落盘一个不存在但很像真的偏好（旧断言已随之作废）。
     * 新口径：偏好键被**移除**（`localStorage[working-dir] === null`）；
     * recentDirs **不含**占位值（不再推入假目录，存储里残留的也会被 store 读取侧滤掉）；
     * mock：首行回落 DEFAULT_WORKING_DIR、最近区不重复出现它；
     * live：首行恒为真 cwd（§4.6 只读真相）、全面板**无**「下次启动」角标、仍只有一个 ✓。
     */
    fails += check("C7", "点「使用默认目录」⇒ 清除偏好（localStorage[working-dir] 移除）；recentDirs 不含 mock 占位值；mock：首行回落 DEFAULT_WORKING_DIR；live：首行不变（真 cwd）、无「下次启动」角标、只有一个 ✓", {
      "按钮可点": clicked === true,
      偏好键已移除: stored.workingDir === null,
      recentDirs不含mock占位值: !stored.recent.includes(DEFAULT_WORKING_DIR),
      ...(isLive
        ? {
            live_首行仍是真实cwd: panel.currentPath === env.expectedFull,
            live_无下次启动角标: panel.pending.length === 0,
            live_只有一个勾: panel.checkedTrueCount === 1,
          }
        : {
            mock_面板首行是默认值: panel.currentPath === DEFAULT_WORKING_DIR,
            mock_最近区不重复出现当前项: !panel.recentPaths.includes(DEFAULT_WORKING_DIR),
          }),
    }, { ...stored, 面板: panel, 期望默认值: DEFAULT_WORKING_DIR });
  }

  /* =============================================================== C8 */
  {
    // 直接播 7 条（含 1 条重复）→ 期待：去重后截 5 条、最新在最上、无重复
    await cdp.eval(`(() => {
      localStorage.setItem('working-dir', ${JSON.stringify("/probe/current-x")});
      localStorage.setItem('recent-dirs', ${JSON.stringify(JSON.stringify(C8_SEED))});
      return true;
    })()`);
    await ctx.open(env.route);
    await cdp.eval(HELPERS);
    if (isLive) await waitForPathTitle(cdp, env.expectedFull, 25000);
    await openMenu(cdp);
    const first = await readPanelState(cdp);
    await clickTestId(cdp, `sidebar-working-directory-recent-${C8_CLICK_INDEX}`);
    await sleep(450);
    await openMenu(cdp);
    const second = await readPanelState(cdp);
    const stored = await cdp.eval(`(() => {
      try { const v = JSON.parse(localStorage.getItem('recent-dirs') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
    })()`);
    await ensureClosed(cdp);
    /*
     * ★ 2026-09-24 主控修正口径（同 C7）：「上限 5」的计数对象是**存储 recentDirs**；
     * 面板显示 = 首行（当前）+ 最近区（存储去掉当前项），当前项被点击后**移到首行**、
     * 不再占最近区一位 —— 这是 §4.6「不许两个 ✓」+ §4.8「当前目录恒置顶」的必然结果。
     * 所以「再次选择后置顶且仍只有 5 条」的正确断法 = 存储置顶且 5 条、
     * 面板首行 = 所点目录、最近区 = 存储去掉首行（顺序一致）。
     */
    const clickedDir = C8_EXPECT_FIRST[C8_CLICK_INDEX];
    /*
     * 「再次选择后首行是所点目录」**只在 mock 成立**；live 下首行恒为真实 cwd（§4.6），
     * 所点目录的变化形态 = 获得「下次启动」角标（ownerPath 断它）。
     */
    fails += check("C8", "依次选多个目录 ⇒ 存储 recentDirs 只留 5 条、最新在最上、无重复；再次选择后：mock 该目录成为首行、live 该目录获得「下次启动」角标", {
      只留5条: first.recentPaths.length === 5,
      最新在最上: JSON.stringify(first.recentPaths) === JSON.stringify(C8_EXPECT_FIRST),
      无重复_首次: new Set(first.recentPaths).size === first.recentPaths.length,
      ...(isLive
        ? {
            live_首行仍是真实cwd: second.currentPath === env.expectedFull,
            live_所点目录获得角标: second.pending.some((p) => p.ownerPath === clickedDir && p.text === "下次启动"),
          }
        : {
            mock_再次选择后首行是所点目录: second.currentPath === clickedDir,
          }),
      再次选择后存储置顶且5条: stored[0] === clickedDir && stored.length === 5,
      再次选择后存储无重复: new Set(stored).size === stored.length,
      最近区等于存储去掉当前项: JSON.stringify(second.recentPaths) === JSON.stringify(stored.filter((d) => d !== second.currentPath)),
      当前项不出现在最近区: !second.recentPaths.includes(second.currentPath),
    }, { 首次: first, 再次: second, "localStorage_recent_dirs": stored, 夹具: C8_SEED, 期望首次: C8_EXPECT_FIRST, 所点目录: clickedDir });
  }

  /* =============================================================== C21（mock） */
  if (isLive) {
    noteSkipped("C21", "形态差异判据，仅在 mock 形态执行（mock 下选择即改显示，不弹 notice）");
  } else {
    await openMenu(cdp);
    const before = await readPanelState(cdp);
    // 动态挑一个"与当前首行不同"的最近目录 —— 点同一条会让「首行立即变」失去意义
    const idx = before.recentPaths.findIndex((p) => p !== before.currentPath);
    const target = idx >= 0 ? before.recentPaths[idx] : null;
    await clickTestId(cdp, `sidebar-working-directory-recent-${idx}`);
    await sleep(400);
    const afterClick = await cdp.eval(`(() => ({
      triggerPath: window.__DM.pathTitle(),
      workingDirStorage: localStorage.getItem('working-dir'),
      notice: ${NOTICE_PROBE},
      menuGone: !window.__DM.panel(),
    }))()`);
    await openMenu(cdp);
    const after = await readPanelState(cdp);
    await ensureClosed(cdp);
    fails += check("C21", "mock：点最近目录 ⇒ 首行**立即变**，不出现「下次启动」灰字，不弹 notice", {
      点击前首行不是目标: before.currentPath !== target,
      首行立即变为目标: after.currentPath === target,
      触发条同步变化: afterClick.triggerPath === target,
      "localStorage_working_dir已变": afterClick.workingDirStorage === target,
      "data_current_source为mock": after.source === "mock",
      无下次启动灰字: after.pending.length === 0 && before.pending.length === 0,
      不弹notice: afterClick.notice.count === 0 && !afterClick.notice.bodyTextHasCoreCwd,
    }, { before, afterClick, after, 点选索引: idx, 目标目录: target });
  }

  /* =============================================================== C20（live） */
  if (!isLive) {
    noteSkipped("C20", "形态差异判据，仅在 live 形态执行");
  } else {
    // live 但拿不到 cwd：把 core 指到一个不可达地址 ⇒ /sessions 必失败
    await cdp.send("Page.navigate", { url: `${LIVE_ORIGIN}/?live=1&core=http://127.0.0.1:1` });
    await waitForSelector(cdp, '[data-testid="window-shell"]', 15000);
    await cdp.eval(HELPERS);
    await sleep(2500); // 让 /sessions 的失败跑完（fetch 到 127.0.0.1:1 立即被拒）
    await openMenu(cdp);
    const r = await readPanelState(cdp);
    const shown = r.currentPath ?? "";
    const localPref = await cdp.eval(`localStorage.getItem('working-dir')`);
    fails += check("C20", "live 拿不到 cwd ⇒ 显式占位（未知目录/连接中…），**不得**回落成本地偏好值（防「很像真的假事实」）", {
      "data_current_source为unavailable": r.source === "unavailable",
      未回落成本地偏好值: shown !== localPref && shown !== DEFAULT_WORKING_DIR && shown !== "",
      显示的不是目录路径_结构性反回落: !/[/\\]/.test(shown),
      占位文案可辨识: /未知目录|连接中|未连接|不可用/.test(shown),
      不是mock来源: r.source !== "mock",
    }, { ...r, 显示值: shown, 本地偏好值: localPref, 默认值: DEFAULT_WORKING_DIR });
    await ensureClosed(cdp);
  }

  /* =============================================================== C9（最后一步） */
  {
    await cdp.eval(`(() => { localStorage.setItem('recent-dirs', '{oops'); return true; })()`);
    const beforeCount = exceptions.length;
    await ctx.open(env.route);
    await cdp.eval(HELPERS);
    if (isLive) await waitForPathTitle(cdp, env.expectedFull, 25000);
    const page = await cdp.eval(`(() => ({
      shell: !!window.__DM.q('[data-testid="window-shell"]'),
      sidebar: !!window.__DM.q('[data-testid="sidebar"]'),
      recentStorage: localStorage.getItem('recent-dirs'),
    }))()`);
    await openMenu(cdp);
    const panel = await cdp.eval(`(() => ({
      panelPresent: !!window.__DM.panel(),
      recentCount: window.__DM.recentItems().length,
    }))()`);
    await ensureClosed(cdp);
    await sleep(300);
    const newExceptions = exceptions.slice(beforeCount);

    ctx.record("console_errors_全程", { consoleErrors, exceptions });
    fails += check("C9", "recent-dirs 写成非法 JSON 后重载 ⇒ 页面正常、最近目录回落空数组、无未捕获异常", {
      页面正常挂载: page.shell === true && page.sidebar === true,
      最近目录回落空数组: panel.recentCount === 0,
      面板仍可打开: panel.panelPresent === true,
      "本次重载无未捕获异常": newExceptions.length === 0,
      全程无未捕获异常: exceptions.length === 0,
    }, { page, panel, newExceptions, exceptions });
  }

  /*
   * ★ 落盘不在这里做：C18/C22/C23 是跑在 runSuite 之后的 live 子 core 判据，
   *   若在此处 ctx.save()，这些 core 级判据永远不会写进 evidence（2026-09-24 实踩，文件只有 19 条）。
   *   统一由调用方在所有判据跑完后 finalize(ctx) 落盘一次。
   */
  return fails;
}

/* =========================================================================
 * 小工具
 * ========================================================================= */

/** 手动导航（会切到另一个 core 的 origin，所以不能走 ctx.open 的 origin 前缀） */async function navigateHard(ctx, url) {
  await ctx.cdp.send("Page.navigate", { url });
  const ok = await waitForSelector(ctx.cdp, '[data-testid="window-shell"]', 15000);
  if (!ok) throw new Error(`页面就绪超时：${url}`);
  await ctx.cdp.eval(HELPERS);
  await sleep(400);
}

async function seedStorage(cdp, seed) {
  await cdp.eval(`(() => {
    localStorage.clear();
    localStorage.setItem('working-dir', ${JSON.stringify(seed.working)});
    localStorage.setItem('recent-dirs', ${JSON.stringify(JSON.stringify(seed.recent))});
    return true;
  })()`);
}

async function readPanelState(cdp) {
  return cdp.eval(`window.__DM.panelState()`);
}

async function measureContrast(cdp) {
  await openMenu(cdp);
  return cdp.eval(`(() => {
    ${LEAF_MEASURE}
    const q = (s) => window.__DM.q('[data-testid="' + s + '"]');
    return {
      theme: document.documentElement.dataset.theme || null,
      pathEl: measure(q('sidebar-working-directory-path')),
      defaultItem: measure(q('sidebar-working-directory-default')),
      customItem: measure(q('sidebar-working-directory-custom')),
    };
  })()`);
}

/**
 * 所有判据（含 live 子 core 的 C18/C22/C23）跑完后**统一落盘**。
 * 落盘前不写文件，避免“跑了却没落盘”（见 runSuite 末尾注释）。
 */
function finalize(ctx) {
  const summary = ctx.save();
  if (summary.failed !== failures) {
    // 让计数漂移可见，而不是静默
    console.log(`\n[dir-menu] 断言计数：本地 ${failures} / 报告 ${summary.failed}`);
  }
  return summary;
}

/** runSuite 里给 live 专用判据用的出口（复用同一计数口径；不在这里再落 record，调用处已给 measured） */
function checkLive(ctx, id, title, detail, measured) {
  ctx.record(`${id}_实测`, measured);
  const pass = ctx.assert(`${id} ${title}`, detail);
  return pass ? 0 : 1;
}

/* ---------------------------------------------------------------------------
 * core 实例
 * ------------------------------------------------------------------------- */

function launchCore({ port, cwd, suffix, agentDir }) {
  const logPath = path.join(uiPkgDir, `_dir-menu-${suffix}-core.log`);
  const logFd = fs.openSync(logPath, "w");
  const env = childEnv({
    CORE_TOKEN: LIVE_TOKEN,
    CORE_PORT: String(port),
    CORE_AGENT_DIR: agentDir,
    CORE_UI_DIST: uiDist,
  });
  // ★ 必须显式设置/删除 CORE_CWD：childEnv 会带上调用方 shell 的 process.env，
  //   若不做这一步，C18 的「缺省」会被外层环境变量悄悄污染 ⇒ 判据失效。
  if (cwd) env.CORE_CWD = cwd;
  else delete env.CORE_CWD;

  const child = spawn(process.execPath, [tsxPath, mainPath], {
    cwd: coreDir,
    env,
    stdio: ["ignore", logFd, logFd],
  });
  return {
    logPath,
    async close() {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((r) => child.once("exit", r)),
        sleep(5000).then(() => child.kill("SIGKILL")),
      ]);
      try {
        fs.closeSync(logFd);
      } catch {
        /* 已关 */
      }
    },
  };
}

async function waitForHealth(origin, token, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${origin}/health`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const json = await res.json();
        if (json.extensions !== null) return json;
      }
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(300);
  }
}

async function coreGet(origin, p) {
  try {
    const res = await fetch(`${origin}${p}`, { headers: { Authorization: `Bearer ${LIVE_TOKEN}` } });
    return await res.json();
  } catch {
    return null;
  }
}

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
