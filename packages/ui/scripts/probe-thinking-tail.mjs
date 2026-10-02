/**
 * 思考尾窗实弹探针（.plan/task-thinking-tail.md §4.2）—— CDP 驱动真实链路（?live=1）。
 *
 * 骨架照搬 probe-process-collapse：起 core（临时 agentDir + 临时项目目录，
 * seedModelsJson → deepseek-v4-flash reasoning:true 会真吐 thinking 增量）
 * → SSE 旁路观测并自动应答授权（本批 prompt 不导向工具，仅保底）→ CDP 打开
 * `/?live=1&token=…` → composer 发思考导向 prompt → 断言：
 *   T1 流式中思考卡 data-mode="tail" 且 thinking-tail 窗口可见；
 *   T2 尾窗高度钳制：clientHeight ≤ 40px；
 *   T3 高度恒定（本批核心性质）：流式中 ≥5 拍采样 thinking-card 总高波动 ≤ 12px；
 *   T4 底部锚定生效：内容底缘与窗口底缘距 ≤ 2.5px、内容实高 > 窗口高（确有裁剪）、
 *      采样期内容仍在增长（tail -f 而非定格）；
 *   T5 流式中点头部 → data-mode="full"、data-expanded="true"、正文区显著长高；
 *   T6 再点 → 回 data-mode="tail"、尾窗恢复；
 *   T7 settled 后：data-mode="collapsed"、thinking-tail 已移出 DOM、
 *      data-expanded="false"（D2：流式中被手动展开过也强制收起）。
 *
 * 运行前置：`packages/ui` 下先 `npm run build`（core 托管的是 dist，不是源码）。
 * 用法：`npm run probe:thinking-tail`；证据 `_probe-thinking-tail-evidence.json`；
 * 截图 `_probe-thinking-tail-shot-{tail,full,collapsed}.png`；失败非 0 退出。
 *
 * 模型不吐 thinking（没到尾窗态就直出正文）按失败如实报 —— prompt 已强导向思考，
 * 不许放水成 skip。坑（沿用 cdp.mjs 备忘）：断言值必须 true/false；点击一律
 * evaluate(el.click)。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser, sleep } from "./cdp.mjs";
import { childEnv, seedModelsJson } from "../../core/scripts/lib/credentials.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(here, "..");
const coreDir = path.join(uiDir, "..", "core");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
const coreLogPath = path.join(coreDir, "run", "probe-tail-core.log");
const evidencePathAbs = path.join(uiDir, "_probe-thinking-tail-evidence.json");
const shotTail = path.join(uiDir, "_probe-thinking-tail-shot-tail.png");
const shotFull = path.join(uiDir, "_probe-thinking-tail-shot-full.png");
const shotCollapsed = path.join(uiDir, "_probe-thinking-tail-shot-collapsed.png");

const CORE_PORT = Number(process.env.PROBE_TAIL_CORE_PORT ?? 5197);
const CDP_PORT = Number(process.env.PROBE_TAIL_CDP_PORT ?? 9365);
const TOKEN = process.env.PROBE_TAIL_TOKEN ?? "probe-tail-token";
const PROMPT =
  process.env.PROBE_TAIL_PROMPT ??
  "请先认真思考、把推理过程想清楚再回答：一个三位数，各位数字之和为 15，百位数字是个位数字的 2 倍，且这个数减去 198 后各位数字顺序正好颠倒。求这个三位数，并给出完整推理。";
const HARD_MS = Number(process.env.PROBE_TAIL_HARD_MS ?? 240_000);
const TAIL_WAIT_MS = Number(process.env.PROBE_TAIL_TAIL_WAIT_MS ?? 120_000);
const SAMPLES = 5;
const SAMPLE_GAP_MS = 400;

// 先删上一轮证据（live-smoke 同款纪律：防旧断言混入汇总）
for (const p of [evidencePathAbs, shotTail, shotFull, shotCollapsed]) {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* 忽略 */
  }
}

/** React 受控输入写入（live-smoke 同款 window.__LT） */
const SET_TEXT = `
window.__LT = {
  setText(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },
};
`;

/** 读「最后一张思考卡」的三态/尾窗几何快照（eval 内联，全部返回可 JSON 的纯值） */
const SNAP_TAIL = `(() => {
  const cards = document.querySelectorAll('[data-testid="thinking-card"]');
  if (cards.length === 0) return { exists: false };
  const card = cards[cards.length - 1];
  const toggle = card.querySelector('[data-testid="thinking-toggle"]');
  const tail = card.querySelector('[data-testid="thinking-tail"]');
  const inner = tail ? tail.firstElementChild : null;
  const md = inner ? inner.firstElementChild : null;
  const lastEl = md && md.lastElementChild ? md.lastElementChild : null;
  const cr = card.getBoundingClientRect();
  const tr = tail ? tail.getBoundingClientRect() : null;
  const ir = inner ? inner.getBoundingClientRect() : null;
  return {
    exists: true,
    mode: card.getAttribute('data-mode'),
    expanded: toggle ? toggle.getAttribute('data-expanded') : null,
    tailExists: !!tail,
    tailVisible: !!tail && tail.clientHeight > 0,
    tailH: tr ? Math.round(tr.height * 10) / 10 : null,
    cardH: Math.round(cr.height * 10) / 10,
    innerH: ir ? Math.round(ir.height * 10) / 10 : null,
    bottomDelta: tr && ir ? Math.round((ir.bottom - tr.bottom) * 10) / 10 : null,
    lastMarginBottom: lastEl ? getComputedStyle(lastEl).marginBottom : null,
    contentLen: inner ? (inner.textContent || '').length : 0,
  };
})()`;

async function waitForCoreUp(token, port, timeoutMs = 40000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(400);
  }
}

/**
 * SSE 旁路观测 + 自动应答授权（probe-collapse 同款）。本批 prompt 不导向工具，
 * 授权大概率不触发，但保底代答防无人值守卡门；frames 用于 agent_settled 终态确认。
 */
function openSseObserver(origin, token) {
  const frames = [];
  const ctrl = new AbortController();
  const done = (async () => {
    const res = await fetch(`${origin}/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`SSE 观测连接失败：HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          frames.push(ev.type);
          if (ev.type === "approval_request") {
            const choice = Array.isArray(ev.options) && ev.options.length > 0 ? ev.options[0] : "允许";
            await fetch(`${origin}/approve`, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ requestId: ev.requestId, choice }),
            });
          }
        } catch {
          /* 坏帧忽略 */
        }
      }
    }
  })().catch((e) => {
    if (!ctrl.signal.aborted) console.error("[probe-tail] SSE 观测异常:", e.message);
  });
  return { frames, close: () => ctrl.abort(), done };
}

console.log(`[probe-tail] 起 core（端口 ${CORE_PORT}，真实模型 reasoning:true）…`);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-tail-"));
const agentDir = path.join(tmpRoot, "agentdir");
const cwd = path.join(tmpRoot, "project");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));
seedModelsJson(agentDir);

fs.mkdirSync(path.dirname(coreLogPath), { recursive: true });
const logFd = fs.openSync(coreLogPath, "w");
const child = spawn(process.execPath, [tsxPath, "src/main.ts"], {
  cwd: coreDir,
  env: childEnv({ CORE_TOKEN: TOKEN, CORE_PORT: String(CORE_PORT), CORE_AGENT_DIR: agentDir, CORE_CWD: cwd }),
  stdio: ["ignore", "ignore", logFd],
});

let exitCode = 1;
let phase = "启动 core";
let observer = null;
const fails = [];
try {
  phase = "等待 core 就绪";
  if (!(await waitForCoreUp(TOKEN, CORE_PORT))) throw new Error(`core 未就绪（端口 ${CORE_PORT}）`);
  const origin = `http://127.0.0.1:${CORE_PORT}`;

  phase = "建立 SSE 观测（含自动应答授权）";
  observer = openSseObserver(origin, TOKEN);
  await sleep(300);

  phase = "CDP 驱动浏览器";
  await withBrowser({ port: CDP_PORT, origin, evidencePath: evidencePathAbs }, async (ctx) => {
    const { cdp } = ctx;
    const A = (name, detail) => {
      try {
        if (!ctx.assert(name, detail)) fails.push(name);
      } catch (e) {
        fails.push(`${name}（断言登记异常：${e.message}）`);
      }
    };

    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: SET_TEXT });

    phase = "打开 live 页面";
    await ctx.open(`/?live=1&token=${TOKEN}`);
    await cdp.eval(SET_TEXT);
    await sleep(600);

    const liveActive = await cdp.eval(
      `(() => { const s = window.__chatStore; return !!(s && s.getState && typeof s.getState().sendMessage === 'function'); })()`,
    );
    A("live 模式挂上真实 store 实例", { 已挂载: liveActive === true });

    phase = "composer 发送（思考导向 prompt）";
    await cdp.eval(
      `(() => { const el = document.querySelector('[data-testid="composer-input"]'); window.__LT.setText(el, ${JSON.stringify(PROMPT)}); return true; })()`,
    );
    await sleep(200);
    const clicked = await cdp.eval(
      `(() => { const b = document.querySelector('[data-testid="composer-send"]'); if (!b || b.disabled) return false; b.click(); return true; })()`,
    );
    A("composer 发送按钮可点击并已触发", { 已点击: clicked === true });
    console.log("[probe-tail] 已发送，等待思考流 …");

    phase = "等待尾窗态出现";
    let snap = null;
    const tTail = Date.now();
    while (Date.now() - tTail < TAIL_WAIT_MS) {
      snap = await cdp.eval(SNAP_TAIL);
      if (snap.exists && snap.mode === "tail" && snap.tailExists) break;
      // 还在等首字（ThinkingPending 占位 / awaitingModel）——继续等；
      // 整轮彻底空闲（模型直出正文没思考，已 settled）再如实判负
      const st = await cdp.eval(
        `(() => { const s = window.__chatStore.getState(); return { streaming: s.streaming, awaiting: s.awaitingModel }; })()`,
      );
      if (!st.streaming && !st.awaiting && Date.now() - tTail > 15000) break;
      await sleep(400);
    }
    if (!snap || !snap.exists) throw new Error("本轮未出现任何思考卡（模型未吐 thinking）");
    ctx.record("尾窗首拍", snap);

    A("T1 流式中尾窗态出现且窗口可见", {
      mode为tail: snap.mode === "tail",
      尾窗在DOM: snap.tailExists === true,
      尾窗可见: snap.tailVisible === true,
    });
    A("T2 尾窗高度钳制 ≤ 40px", { 实测高度: snap.tailH <= 40, tailH: snap.tailH });

    phase = "流式中采样（高度恒定 + 底部锚定 + 内容增长）";
    const samples = [];
    const tSample = Date.now();
    while (samples.length < SAMPLES && Date.now() - tSample < HARD_MS) {
      const s = await cdp.eval(SNAP_TAIL);
      if (s.exists && s.mode === "tail" && s.tailExists) samples.push(s);
      else break; // 思考已翻面（出现正文/工具）——采样期结束，用手头样本判
      await sleep(SAMPLE_GAP_MS);
    }
    ctx.record("采样序列", samples.map((s) => ({ cardH: s.cardH, tailH: s.tailH, contentLen: s.contentLen })));

    const cardHeights = samples.map((s) => s.cardH);
    const maxLen = Math.max(...samples.map((s) => s.contentLen));
    const minLen = Math.min(...samples.map((s) => s.contentLen));
    const last = samples[samples.length - 1] ?? snap;
    A("T3 流式中思考卡总高恒定（不再撑高跳动）", {
      样本数足够: samples.length >= 5,
      高度波动: Math.max(...cardHeights) - Math.min(...cardHeights) <= 12,
      波动px: Math.max(...cardHeights) - Math.min(...cardHeights),
    });
    A("T4 底部锚定生效（末行可见且确有裁剪、内容在长）", {
      内容底缘贴合窗口底缘: Math.abs(last.bottomDelta) <= 2.5,
      底缘距px: last.bottomDelta,
      末段下边距已归零: last.lastMarginBottom === "0px",
      实际末段marginBottom: last.lastMarginBottom,
      内容实高超出窗口: last.innerH > last.tailH + 4,
      采样期内容在增长: maxLen > minLen,
    });
    await cdp.screenshot(shotTail);

    phase = "流式中手动展开（T5）";
    await cdp.eval(
      `(() => { const cards = document.querySelectorAll('[data-testid="thinking-card"]'); const t = cards[cards.length - 1].querySelector('[data-testid="thinking-toggle"]'); if (!t) return false; t.click(); return true; })()`,
    );
    await sleep(500);
    const full = await cdp.eval(SNAP_TAIL);
    ctx.record("展开态快照", full);
    A("T5 流式中手动展开为全文", {
      mode为full: full.mode === "full",
      dataExpanded为true: full.expanded === "true",
      正文区显著长高: full.cardH > last.cardH + 15,
      实际cardH: full.cardH,
    });
    await cdp.screenshot(shotFull);

    phase = "流式中收回尾窗（T6）";
    await cdp.eval(
      `(() => { const cards = document.querySelectorAll('[data-testid="thinking-card"]'); const t = cards[cards.length - 1].querySelector('[data-testid="thinking-toggle"]'); if (!t) return false; t.click(); return true; })()`,
    );
    await sleep(500);
    const backTail = await cdp.eval(SNAP_TAIL);
    A("T6 再点回到尾窗态", {
      mode回tail: backTail.mode === "tail",
      尾窗恢复: backTail.tailExists === true,
    });

    phase = "等待 agent_settled";
    const tSettle = Date.now();
    for (;;) {
      const st = await cdp.eval(
        `(() => ({ streaming: window.__chatStore.getState().streaming, textLen: window.__chatStore.getState().messages.flatMap(m => m.blocks).filter(b => b.type === 'text' && b.content.trim()).length }))()`,
      );
      const settledFrame = observer.frames.includes("agent_settled");
      if (!st.streaming && (settledFrame || st.textLen >= 1)) break;
      if (Date.now() - tSettle > HARD_MS) throw new Error("等待 settled 超时");
      await sleep(500);
    }
    await sleep(800); // 等收起渲染与虚拟行重测完成

    const after = await cdp.eval(SNAP_TAIL);
    ctx.record("settled 后快照", after);
    A("T7 settled 后强制收起（D2）", {
      mode为collapsed: after.mode === "collapsed",
      尾窗已移出DOM: after.tailExists === false,
      dataExpanded为false: after.expanded === "false",
    });
    await cdp.screenshot(shotCollapsed);

    ctx.save(evidencePathAbs);
  });

  phase = "传输层统计";
  await sleep(500);
  const frames = observer.frames;
  const eventSummary = frames.reduce((acc, t) => ((acc[t] = (acc[t] ?? 0) + 1), acc), {});
  const transportChecks = [
    ["传输层：SSE 收到 message_update（思考增量真实到达）", frames.includes("message_update")],
    ["传输层：SSE 收到 agent_settled（终态到达）", frames.includes("agent_settled")],
  ];
  for (const [name, ok] of transportChecks) {
    console.log(`  ${ok ? "✓" : "✗"} ${name}`);
    if (!ok) fails.push(name);
  }

  let saved = { assertions: [] };
  try {
    saved = JSON.parse(fs.readFileSync(evidencePathAbs, "utf8"));
  } catch {
    /* 保持空对象 */
  }
  saved.transport = { 事件计数: eventSummary, 总帧数: frames.length };
  saved.summary = {
    assertions: (saved.assertions ?? []).length + transportChecks.length,
    failed: fails.length,
    failedNames: fails,
  };
  fs.writeFileSync(evidencePathAbs, JSON.stringify(saved, null, 2));

  exitCode = fails.length === 0 ? 0 : 1;
} catch (e) {
  console.error(`[probe-tail] 异常（阶段：${phase}）：`, e.message);
  fs.writeFileSync(
    evidencePathAbs,
    JSON.stringify({ failedAtPhase: phase, error: e.message, note: "本轮未走完流程，未生成完整断言证据。" }, null, 2),
  );
  exitCode = 1;
} finally {
  observer?.close();
  try {
    child.kill("SIGTERM");
  } catch {
    /* 已退出 */
  }
  fs.closeSync(logFd);
}

console.log(fails.length === 0 ? "\n思考尾窗探针全部通过" : `\n探针失败 ${fails.length} 项：\n - ${fails.join("\n - ")}`);
process.exit(exitCode);
