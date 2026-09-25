/**
 * 新建会话页 + 惰性建会话 · 验收探针。
 *
 * mock 模式（`probe:new-session`，dev server :5180）：N1–N10。
 * live 模式（`probe:new-session:live`，自起 core :5390 + 托管 ui/dist）：L1–L4。
 *
 * 规格：`.plan/task-new-session-page.md`
 * - §4.0 接口冻结 = testid / 文案 的唯一权威来源；
 * - §七 验收 = N1–N10（mock）+ 本脚本 live 段 L1–L4（D6/D8 在真实链路下的闭环）。
 *
 * live 段覆盖（真实 core + 真实模型，不打桩）：
 *   L1  空清单启动 ⇒ 直接进草稿态（D8）：hero 出现、无消息列表、core 清单为空；
 *   L2  草稿态首条发送 ⇒ 此刻才建会话：回复完成后 core 清单**恰好 1 条**且 id =
 *       store 的 liveSessionId（D6 的浏览器级实证 —— 点击时零创建、发送时才创建）；
 *   L3  有会话后点「新建会话」⇒ 回草稿态且 **core 清单不变**（U2 的 live 实证：
 *       点击只是本地视图态）；
 *   L4  点历史项 ⇒ 离开草稿态回到正常会话视图（草稿的出路仍通）。
 *
 * ★ 防假绿设计（mock 段，别"优化"掉）：
 * - N1 同时断言 `message-list` 与 `empty-state` **不存在** —— 只断言 hero 存在时，
 *   「hero 没渲染但旧空态兜底」的假实现照样绿（两个互斥状态必须查双面）。
 * - N2 断言卡片**无 hover 类**：D3 是"纯展示"，实现若加了 hover: 类（看着能点）会红。
 * - N4 断言发送后 placeholder **回退旧文案**：草稿文案若常驻，说明没跟草稿位联动。
 *
 * 用法：
 *   # mock（前置：packages/ui 起 dev server :5180）
 *   npm run probe:new-session
 *   # live（前置：packages/ui 先 npm run build；脚本自起 core，串行纪律）
 *   npm run probe:new-session:live
 *
 * 端口：mock CDP 9350；live core 5390 + CDP 9355（避开既有 9333-9354 / core 5350-5383 / 5194）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser, waitForSelector, SET_TEXT_HELPER, sleep } from "./cdp.mjs";
import { childEnv, seedModelsJson } from "../../core/scripts/lib/credentials.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(here, "..");
const coreDir = path.join(uiDir, "..", "core");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
const mainPath = path.join(coreDir, "src", "main.ts");

/* ---------------------------------------------------------------------------
 * 模式 / 端口 / 冻结文案（§4.0 文案表逐字拷贝 —— 探针不读 src，规格即真相）
 * ------------------------------------------------------------------------- */

const LIVE = process.argv.includes("--live") || process.env.PROBE_MODE === "live";

const MOCK_ORIGIN = process.env.NEW_SESSION_ORIGIN ?? "http://127.0.0.1:5180";
const MOCK_CDP = 9350;
const MOCK_EVIDENCE = "_new-session-evidence.json";

const LIVE_PORT = Number(process.env.NEW_SESSION_LIVE_PORT ?? 5390);
const LIVE_CDP = 9355;
const LIVE_EVIDENCE = "_new-session-live-evidence.json";
const LIVE_ORIGIN = `http://127.0.0.1:${LIVE_PORT}`;
const LIVE_TOKEN = "new-session-live-token";
const LIVE_PROMPT = process.env.NEW_SESSION_LIVE_PROMPT ?? "只回复四个字：已收到，不要调用任何工具。";
/** 真实模型一轮的上限（与 check:c4 的 PROMPT_HARD_MS 同量级） */
const LIVE_PROMPT_TIMEOUT_MS = Number(process.env.NEW_SESSION_LIVE_HARD_MS ?? 240_000);

const TITLE = "开始一个新会话";
const SUBTITLE = "描述你想完成的任务，Pi 会先给出执行计划，再动手改代码。";
const HINT = "Enter 发送 · Shift+Enter 换行 · / 唤起技能 · @ 引用文件";
const DRAFT_PLACEHOLDER = "描述你想完成的任务，或输入 / 调用某个技能…";
const DEFAULT_PLACEHOLDER = "给 Pi 下达任务…（Enter 发送，Shift+Enter 换行）";
const CARDS = [
  ["读懂这个代码库", "扫描项目结构与依赖，列出关键模块、入口文件和调用链，先建立一份全局认知。"],
  ["跑通测试并修复失败项", "先复现失败用例，定位根因，再按最小改动逐个修好并跑一遍回归。"],
  ["实现一个小需求", "描述目标即可，我先给出分步执行计划，等你确认后再动手改代码。"],
  ["排查最近的报错", "从终端输出与日志定位根因，给出复现路径、影响范围和修复建议。"],
];

/** 页内小工具（每个导航后重新注入；store 读取在 mock 与 live 形态都可用） */
const HELPERS = `
  window.__NS = {
    q(sel) { return document.querySelector(sel); },
    exists(sel) { return !!document.querySelector(sel); },
    text(sel) { const el = document.querySelector(sel); return el ? (el.textContent || "").trim() : null; },
    store() {
      const s = window.__chatStore?.getState?.();
      if (!s) throw new Error("window.__chatStore 不存在（需 DEV 或 live 形态）");
      return {
        newSessionDraft: s.newSessionDraft,
        streaming: s.streaming,
        messageCount: s.messages.length,
        liveSessionId: s.liveSessionId,
        tokenUsage: { input: s.tokenUsage.input, output: s.tokenUsage.output, total: s.tokenUsage.total },
      };
    },
  };
  "ok"`;

/* ===========================================================================
 * mock 段（N1–N10）
 * ======================================================================== */
async function runMock() {
  await withBrowser({ port: MOCK_CDP, origin: MOCK_ORIGIN, evidencePath: MOCK_EVIDENCE }, async (ctx) => {
    const { cdp } = ctx;

    /* ================================================================ N6 · 按钮本身（D1） */
    await ctx.open("/");
    // ⚠️ 注入必须在 open 之后：Page.navigate 会换掉整个 JS 环境，先注入必被冲掉
    await cdp.eval(HELPERS);
    const btn = await cdp.eval(`(() => {
    const el = window.__NS.q('[data-testid="sidebar-new-task"]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      label: (el.textContent || "").trim(),
      title: el.getAttribute("title"),
      hasHover: /hover:(bg|text)-/.test(String(el.className)),
      hasActive: /active:(bg|text)-/.test(String(el.className)),
      hasTransition: cs.transitionDuration !== "0s" || /transition/.test(cs.transitionProperty),
    };
  })()`);
    ctx.record("N6_按钮原始观测", btn);
    ctx.assert("N6 按钮文案=新建会话、testid 沿用、三件套在（m5 5-5 同口径）", {
      按钮存在: !!btn,
      文案是新建会话: btn?.label === "新建会话",
      title同文案: btn?.title === "新建会话",
      hover反馈: btn?.hasHover === true,
      active反馈: btn?.hasActive === true,
      transition在: btn?.hasTransition === true,
    });

    /* ================================================================ N1 · 点按钮 → hero（互斥双面断言） */
    await cdp.eval(`window.__NS.q('[data-testid="sidebar-new-task"]').click()`);
    await sleep(400);
    const hero = await cdp.eval(`(() => {
    const root = window.__NS.q('[data-testid="new-session-hero"]');
    if (!root) return null;
    const cards = [0, 1, 2, 3].map((i) => {
      const c = window.__NS.q('[data-testid="new-session-card-' + i + '"]');
      return c ? { tag: c.tagName, title: (c.querySelector("span") || {}).textContent, desc: (c.querySelector("p") || {}).textContent } : null;
    });
    return {
      exists: !!root,
      visibleHeight: root.getBoundingClientRect().height,
      messageListAbsent: !window.__NS.exists('[data-testid="message-list"]'),
      emptyStateAbsent: !window.__NS.exists('[data-testid="empty-state"]'),
      cardsPresent: cards.every((c) => !!c),
      cards,
      h1: (root.querySelector("h1") || {}).textContent,
      fullText: (root.textContent || "").replace(/\\s+/g, ""),
    };
  })()`);
    ctx.record("N1_hero原始观测", hero);
    ctx.assert("N1 点按钮 → hero 出现、互斥双面不在、四卡齐全、文案逐字", {
      hero存在: !!hero?.exists,
      hero有高度: (hero?.visibleHeight ?? 0) > 0,
      消息列表不存在: hero?.messageListAbsent === true,
      旧空态不存在: hero?.emptyStateAbsent === true,
      四卡齐全: hero?.cardsPresent === true,
      标题逐字: hero?.h1 === TITLE,
      副标题逐字: hero?.fullText.includes(SUBTITLE.replace(/\s+/g, "")) === true,
      提示行逐字: hero?.fullText.includes(HINT.replace(/\s+/g, "")) === true,
      四卡文案逐字: (hero?.cards ?? []).every((c, i) => (c?.title || "").trim() === CARDS[i][0] && (c?.desc || "").trim() === CARDS[i][1]),
      草稿位真值: await cdp.eval("window.__NS.store().newSessionDraft"),
    });

    /* ================================================================ N2 · 卡片纯展示（D3） */
    const cardsMeta = await cdp.eval(`(() => {
    return [0, 1, 2, 3].map((i) => {
      const el = window.__NS.q('[data-testid="new-session-card-' + i + '"]');
      if (!el) return null;
      return {
        tag: el.tagName,
        hasHoverClass: /hover:/.test(String(el.className)),
        hasActiveClass: /active:/.test(String(el.className)),
        tabindex: el.getAttribute("tabindex"),
        cursor: getComputedStyle(el).cursor,
      };
    });
  })()`);
    ctx.record("N2_卡片原始观测", cardsMeta);
    ctx.assert("N2 卡片纯展示：div、无 hover:/active: 类、无 tabindex、非 pointer 光标", {
      四卡都是div: (cardsMeta ?? []).every((c) => c?.tag === "DIV"),
      无hover类: (cardsMeta ?? []).every((c) => c?.hasHoverClass === false),
      无active类: (cardsMeta ?? []).every((c) => c?.hasActiveClass === false),
      无tabindex: (cardsMeta ?? []).every((c) => c?.tabindex === null),
      光标非pointer: (cardsMeta ?? []).every((c) => c?.cursor !== "pointer"),
    });

    /* ================================================================ N3 · 草稿态 placeholder（D5） */
    const draftPlaceholder = await cdp.eval(
      `window.__NS.q('[data-testid="composer-input"]')?.getAttribute("placeholder")`,
    );
    ctx.assert("N3 草稿态 placeholder = 图中文案", {
      placeholder逐字: draftPlaceholder === DRAFT_PLACEHOLDER,
      非默认文案: draftPlaceholder !== DEFAULT_PLACEHOLDER,
    });

    /* ================================================================ N10 · 草稿态用量归零（D9） */
    // 数值读 item 的 lastElementChild（数值 span）—— 与 m2 验收 2-13 的口径一致；
    // item 的 textContent 会带上（窄视口下隐藏的）标签字符，不能直接比。
    const stats = await cdp.eval(`({
    input: window.__NS.q('[data-testid="token-stats-item-input"]')?.lastElementChild?.textContent,
    output: window.__NS.q('[data-testid="token-stats-item-output"]')?.lastElementChild?.textContent,
    total: window.__NS.q('[data-testid="token-stats-item-total"]')?.lastElementChild?.textContent,
    store: window.__NS.store(),
  })`);
    ctx.record("N10_草稿态用量观测", stats);
    ctx.assert("N10 草稿态 TokenStats 归零（不显示上一会话的 12.4k/6.2k）", {
      输入为0: stats?.input === "0",
      输出为0: stats?.output === "0",
      消耗为0: stats?.total === "0",
      store归零: stats?.store?.tokenUsage?.input === 0 && stats?.store?.tokenUsage?.output === 0 && stats?.store?.tokenUsage?.total === 0,
    });

    /* ================================================================ N9 · 幂等（再点一次无副作用） */
    const beforeReclick = await cdp.eval("window.__NS.store()");
    await cdp.eval(`window.__NS.q('[data-testid="sidebar-new-task"]').click()`);
    await sleep(300);
    const afterReclick = await cdp.eval(`({
    store: window.__NS.store(),
    heroStill: window.__NS.exists('[data-testid="new-session-hero"]'),
  })`);
    ctx.record("N9_幂等观测", { beforeReclick, afterReclick: afterReclick.store, heroStill: afterReclick.heroStill });
    ctx.assert("N9 草稿态再点按钮幂等", {
      hero仍在: afterReclick?.heroStill === true,
      草稿位不变: afterReclick?.store?.newSessionDraft === beforeReclick.newSessionDraft,
      消息数不变: afterReclick?.store?.messageCount === beforeReclick.messageCount,
      streaming为假: afterReclick?.store?.streaming === false,
    });

    /* ================================================================ N8 · 流式中点按钮 → 中止 + 草稿 */
    await ctx.open("/");
    await cdp.eval(HELPERS);
    await cdp.eval(`${SET_TEXT_HELPER}
    setNativeValue(window.__NS.q('[data-testid="composer-input"]'), "帮我看看这个项目");
    "ok"`);
    await cdp.eval(`window.__NS.q('[data-testid="composer-send"]').click()`);
    await sleep(150);
    const streamingBefore = await cdp.eval("window.__NS.store().streaming");
    await cdp.eval(`window.__NS.q('[data-testid="sidebar-new-task"]').click()`);
    await sleep(300);
    const afterAbort = await cdp.eval(`({
    store: window.__NS.store(),
    hero: window.__NS.exists('[data-testid="new-session-hero"]'),
    list: window.__NS.exists('[data-testid="message-list"]'),
  })`);
    ctx.record("N8_流式中止观测", { streamingBefore, afterAbort: afterAbort.store, hero: afterAbort.hero, list: afterAbort.list });
    ctx.assert("N8 流式中点按钮 → 中止 + 进入草稿态", {
      点击前确实在流式: streamingBefore === true,
      点击后streaming解除: afterAbort?.store?.streaming === false,
      进入草稿态: afterAbort?.store?.newSessionDraft === true,
      hero出现: afterAbort?.hero === true,
      消息列表被清: afterAbort?.list === false,
    });

    /* ================================================================ N4 · 草稿态发送 → 正常会话视图 */
    await cdp.eval(`${SET_TEXT_HELPER}
    setNativeValue(window.__NS.q('[data-testid="composer-input"]'), "帮我读懂这个代码库");
    "ok"`);
    await cdp.eval(`window.__NS.q('[data-testid="composer-send"]').click()`);
    await sleep(500);
    const sent = await cdp.eval(`(() => {
    const items = [...document.querySelectorAll('[data-testid="message-item"]')];
    return {
      heroAbsent: !window.__NS.exists('[data-testid="new-session-hero"]'),
      listBack: window.__NS.exists('[data-testid="message-list"]'),
      firstIsUser: items[0]?.dataset.role === "user",
      firstText: (items[0]?.textContent || "").slice(0, 40),
      draftCleared: window.__NS.store().newSessionDraft === false,
      placeholderRestored: window.__NS.q('[data-testid="composer-input"]')?.getAttribute("placeholder") === ${JSON.stringify(DEFAULT_PLACEHOLDER)},
    };
  })()`);
    ctx.record("N4_草稿发送观测", sent);
    ctx.assert("N4 草稿态发送 → hero 消失、用户消息上屏、placeholder 回退", {
      hero消失: sent?.heroAbsent === true,
      消息列表回归: sent?.listBack === true,
      首条是用户消息: sent?.firstIsUser === true,
      首条含原文: (sent?.firstText ?? "").includes("帮我读懂这个代码库"),
      草稿位清除: sent?.draftCleared === true,
      placeholder回退: sent?.placeholderRestored === true,
    });
    // 等 mock 流式收尾，避免把 streaming 带进下一段
    await sleep(2300);

    /* ================================================================ N5 · ?empty=1 旧空态原样（5-7 回归锚） */
    await ctx.open("/?empty=1");
    await cdp.eval(HELPERS);
    await sleep(400);
    const emptyState = await cdp.eval(`({
    emptyExists: window.__NS.exists('[data-testid="empty-state"]'),
    emptyText: window.__NS.text('[data-testid="empty-state"]'),
    listExists: window.__NS.exists('[data-testid="message-list"]'),
    heroAbsent: !window.__NS.exists('[data-testid="new-session-hero"]'),
    draftOff: window.__NS.store().newSessionDraft === false,
  })`);
    ctx.record("N5_旧空态观测", emptyState);
    ctx.assert("N5 ?empty=1 仍是旧空态（m5 5-7 锚不受影响）", {
      旧空态存在: emptyState?.emptyExists === true,
      有提示文案: (emptyState?.emptyText ?? "").length > 0,
      消息列表存在: emptyState?.listExists === true,
      hero不出现: emptyState?.heroAbsent === true,
      草稿位关闭: emptyState?.draftOff === true,
    });

    /* ================================================================ N7 · 从 #/skills 点击 → 回工作台 + 草稿 */
    await ctx.open("/#/skills");
    await cdp.eval(HELPERS);
    await sleep(400);
    await cdp.eval(`window.__NS.q('[data-testid="sidebar-new-task"]').click()`);
    const nav = await cdp.eval(`new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const hero = document.querySelector('[data-testid="new-session-hero"]');
      if (hero || Date.now() - t0 > 5000) {
        resolve({
          hash: window.location.hash,
          hero: !!hero,
          workbenchBack: !!document.querySelector('[data-testid="workspace-area"]'),
          draft: window.__chatStore?.getState?.()?.newSessionDraft === true,
        });
      } else setTimeout(tick, 50);
    };
    tick();
  })`, true);
    ctx.record("N7_跨屏导航观测", nav);
    ctx.assert("N7 #/skills 点按钮 → hash 回 #/workbench 且进草稿态", {
      hash回工作台: nav?.hash === "#/workbench",
      hero出现: nav?.hero === true,
      工作台回归: nav?.workbenchBack === true,
      草稿位开启: nav?.draft === true,
    });

    ctx.save();
  });
}

/* ===========================================================================
 * live 段（L1–L4）：自起 core（临时 agentDir / 空清单），走真实模型
 * ======================================================================== */

/** Node 侧带 token 的 GET /sessions（清单真相在 core，不在页面里） */
async function listSessions(origin, token) {
  const res = await fetch(`${origin}/sessions`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => null);
  return { status: res.status, sessions: Array.isArray(body?.sessions) ? body.sessions : [] };
}

async function runLive() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "new-session-live-"));
  const agentDir = path.join(tmpRoot, "agentdir");
  const projectDir = path.join(tmpRoot, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  // 无项目本地资源 ⇒ 不触发信任门；模型清单由 seedModelsJson 注入（真实模型）
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));
  seedModelsJson(agentDir);

  const logFd = fs.openSync(path.join(uiDir, "_new-session-live-core.log"), "w");
  const core = spawn(process.execPath, [tsxPath, mainPath], {
    cwd: projectDir,
    env: childEnv({ CORE_TOKEN: LIVE_TOKEN, CORE_PORT: String(LIVE_PORT), CORE_AGENT_DIR: agentDir }),
    stdio: ["ignore", "ignore", logFd],
  });

  try {
    // 等 core 就绪（extensions 非空 = 会话初始化完成）
    let health = null;
    const t0 = Date.now();
    for (;;) {
      try {
        const r = await fetch(`${LIVE_ORIGIN}/health`, { headers: { Authorization: `Bearer ${LIVE_TOKEN}` } });
        const j = await r.json().catch(() => null);
        if (r.ok && j?.extensions !== null) { health = j; break; }
      } catch { /* 还没起来 */ }
      if (Date.now() - t0 > 60_000) break;
      await sleep(300);
    }
    if (!health) throw new Error("core 未在 60s 内就绪（看 _new-session-live-core.log）");

    await withBrowser({ port: LIVE_CDP, origin: LIVE_ORIGIN, evidencePath: LIVE_EVIDENCE }, async (ctx) => {
      const { cdp } = ctx;

      /* ================================================================ L1 · 空清单启动 ⇒ 直接草稿态（D8） */
      await ctx.open(`/?live=1&token=${LIVE_TOKEN}`, '[data-testid="window-shell"]');
      // D8：空清单 → 草稿态。hero 可能晚于 window-shell 出现（等 live 启动加载分支跑完）
      const heroReady = await waitForSelector(cdp, '[data-testid="new-session-hero"]', 15000);
      await cdp.eval(HELPERS);
      const l1Page = await cdp.eval(`({
        hero: window.__NS.exists('[data-testid="new-session-hero"]'),
        listAbsent: !window.__NS.exists('[data-testid="message-list"]'),
        emptyStateAbsent: !window.__NS.exists('[data-testid="empty-state"]'),
        store: window.__NS.store(),
        placeholder: window.__NS.q('[data-testid="composer-input"]')?.getAttribute("placeholder"),
      })`);
      const l1List = await listSessions(LIVE_ORIGIN, LIVE_TOKEN);
      ctx.record("L1_空清单启动观测", { heroReady, page: l1Page, coreSessions: l1List.sessions.map((s) => s.id) });
      ctx.assert("L1 live 空清单启动 ⇒ 直接进草稿态（D8）", {
        hero出现: l1Page?.hero === true,
        无消息列表: l1Page?.listAbsent === true,
        无旧空态: l1Page?.emptyStateAbsent === true,
        草稿位开启: l1Page?.store?.newSessionDraft === true,
        placeholder是草稿文案: l1Page?.placeholder === DRAFT_PLACEHOLDER,
        core清单为空: l1List.sessions.length === 0,
      });

      /* ================================================================ L2 · 草稿态发送 ⇒ 此刻才建会话（D6） */
      await cdp.eval(`${SET_TEXT_HELPER}
      setNativeValue(window.__NS.q('[data-testid="composer-input"]'), ${JSON.stringify(LIVE_PROMPT)});
      "ok"`);
      await cdp.eval(`window.__NS.q('[data-testid="composer-send"]').click()`);
      // 等：发送后离开草稿态；一轮真实回复完成（streaming 解除 + user/assistant 齐了）
      const l2Wait = await cdp.eval(`new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const s = window.__chatStore?.getState?.();
        const done = s && s.newSessionDraft === false && s.streaming === false && s.messages.length >= 2 && s.liveSessionId;
        if (done || Date.now() - t0 > ${LIVE_PROMPT_TIMEOUT_MS}) {
          resolve({ done: !!done, elapsedMs: Date.now() - t0, state: s ? {
            newSessionDraft: s.newSessionDraft, streaming: s.streaming,
            messageCount: s.messages.length, liveSessionId: s.liveSessionId } : null });
        } else setTimeout(tick, 300);
      };
      tick();
    })`, true);
      const l2List = await listSessions(LIVE_ORIGIN, LIVE_TOKEN);
      ctx.record("L2_草稿发送观测", { wait: l2Wait, coreSessions: l2List.sessions.map((s) => ({ id: s.id, messageCount: s.messageCount })) });
      ctx.assert("L2 草稿态首条发送 ⇒ 此刻才创建会话（清单恰 1 条且 id 命中 liveSessionId）", {
        一轮完成: l2Wait?.done === true,
        离开草稿态: l2Wait?.state?.newSessionDraft === false,
        liveSessionId非空: typeof l2Wait?.state?.liveSessionId === "string" && l2Wait.state.liveSessionId.length > 0,
        core清单恰一条: l2List.sessions.length === 1,
        清单id命中: l2List.sessions[0]?.id === l2Wait?.state?.liveSessionId,
        消息数达标: (l2List.sessions[0]?.messageCount ?? 0) >= 2,
      });

      /* ================================================================ L3 · 点「新建会话」⇒ 草稿态且清单不变（U2） */
      await cdp.eval(`window.__NS.q('[data-testid="sidebar-new-task"]').click()`);
      await sleep(500);
      const l3Page = await cdp.eval(`({
        hero: window.__NS.exists('[data-testid="new-session-hero"]'),
        listAbsent: !window.__NS.exists('[data-testid="message-list"]'),
        store: window.__NS.store(),
      })`);
      const l3List = await listSessions(LIVE_ORIGIN, LIVE_TOKEN);
      ctx.record("L3_点击不创建观测", { page: l3Page, coreSessions: l3List.sessions.map((s) => s.id) });
      ctx.assert("L3 有会话后点新建 ⇒ 回草稿态且 core 清单不变（点击零创建）", {
        hero回归: l3Page?.hero === true,
        消息列表清空: l3Page?.listAbsent === true,
        草稿位开启: l3Page?.store?.newSessionDraft === true,
        liveSessionId已清: l3Page?.store?.liveSessionId === null,
        core清单仍恰一条: l3List.sessions.length === 1,
        仍是原会话: l3List.sessions[0]?.id === l2List.sessions[0]?.id,
      });

      /* ================================================================ L4 · 点历史项 ⇒ 离开草稿（出路仍通） */
      await cdp.eval(`window.__NS.q('[data-testid="sidebar-history-item-0"]').click()`);
      const l4Wait = await cdp.eval(`new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const s = window.__chatStore?.getState?.();
        const done = s && s.newSessionDraft === false && s.liveSessionId && document.querySelector('[data-testid="message-list"]');
        if (done || Date.now() - t0 > 15000) {
          resolve({ done: !!done, state: s ? { newSessionDraft: s.newSessionDraft, liveSessionId: s.liveSessionId, messageCount: s.messages.length } : null });
        } else setTimeout(tick, 200);
      };
      tick();
    })`, true);
      ctx.record("L4_离稿出路观测", l4Wait);
      ctx.assert("L4 点历史项 ⇒ 离开草稿态回到会话视图", {
        草稿位关闭: l4Wait?.state?.newSessionDraft === false,
        liveSessionId回归: typeof l4Wait?.state?.liveSessionId === "string" && l4Wait.state.liveSessionId.length > 0,
        消息列表回归: l4Wait?.done === true,
      });

      ctx.save();
    });
  } finally {
    try {
      core.kill("SIGTERM");
    } catch {
      /* 已退出 */
    }
    fs.closeSync(logFd);
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
}

if (LIVE) await runLive();
else await runMock();
