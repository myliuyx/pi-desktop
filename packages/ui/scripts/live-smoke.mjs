/**
 * C2 live 烟测 —— CDP 驱动真实链路（?live=1）。
 *
 * 流程：起 core（真实模型，凭证经 `./lib/credentials.mjs` 注入）→ core 同源托管 UI dist
 * → 浏览器打开 `http://127.0.0.1:<port>/?live=1&token=<token>` → 在 composer 输入并发送
 * → 断言「出现 assistant 消息块且 streaming 态最终解除」。证据写入 `_live-smoke-evidence.json`。
 *
 * 三层证据（任一层的失败都会让脚本非 0 退出）：
 *   ① 传输层：另起一个 Node SSE 客户端直连 `/events`，统计 core 实际下发的 AgentEvent
 *      —— 验证「终态事件不被批处理吞掉 / 不晚于 agent_settled 之后再冒 message_update」，
 *      并核对 message_update 无放大；
 *   ② store 层：`window.__chatStore`（live 模式下挂真实 store 实例）读 streaming 终态与消息；
 *   ③ DOM 层：`message-item[data-role=assistant]` 真实渲染出文本。
 *
 * 关键设计：
 * - core 同源 serve UI：transport baseUrl 为相对 ""，浏览器与 core 同 origin，避开 CORS/Host 限制；
 * - 页面从 `?token=` 取 Bearer token（core 启动时写入 run/core.json）；
 * - 若 CDP / Chrome 在本机不可用，脚本如实失败、非 0 退出，并落盘「降级证据」说明失败阶段，
 *   便于主控判断是否改按 SSE 层断言验收。
 *
 * 坑（沿用 cdp.mjs 备忘）：断言值必须 true/false（ctx.assert 只认布尔项），
 * 中文裸键以数字开头要加引号。
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
const coreJsonPath = path.join(coreDir, "run", "core.json");
const rawDumpPath = path.join(coreDir, "run", "events.jsonl");
const coreLogPath = path.join(coreDir, "run", "live-smoke-core.log");
const evidenceFile = "_live-smoke-evidence.json";
/** 证据落 packages/ui 下（与既有 _m1-evidence.json 同处），与 cwd 无关 */
const evidencePathAbs = path.join(uiDir, evidenceFile);

/**
 * React 受控输入写入。
 * 注意：cdp.mjs 的 SET_TEXT_HELPER 只声明了一个**局部**函数 `setNativeValue`（没挂到 window），
 * 直接 `window.setText(...)` 会抛 "not a function"（本脚本首跑实踩）；这里自建 `window.__LT`。
 * 直接改 `el.value` 不触发 React 的 onChange —— 必须用原型上的原生 setter 绕过，再派发 input。
 */
const SET_TEXT = `
window.__LT = {
  setText(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },
};
`;

const CORE_PORT = Number(process.env.LIVE_CORE_PORT ?? 5188);
const CORE_TOKEN = process.env.LIVE_CORE_TOKEN ?? "live-smoke-token";
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9344);
const PROMPT = process.env.LIVE_PROMPT ?? "用一句话介绍 Pi 这个项目，不要使用任何工具。";
const HARD_MS = Number(process.env.LIVE_HARD_MS ?? 180000);

// 先删上一轮证据：否则旧 summary 会被当成本轮结果叠加（首跑实踩：本地残留 4 条旧断言混进汇总）
try {
  fs.rmSync(evidencePathAbs, { force: true });
} catch {
  /* 忽略 */
}

function readCoreJson() {
  try {
    return JSON.parse(fs.readFileSync(coreJsonPath, "utf8"));
  } catch {
    return null;
  }
}

/** core 原始 Pi 事件 dump 里 message_update 的条数（作为「无放大」的对照基线） */
function rawUpdateCount() {
  try {
    const lines = fs.readFileSync(rawDumpPath, "utf8").split("\n").filter(Boolean);
    let n = 0;
    for (const l of lines) {
      try {
        if (JSON.parse(l).type === "message_update") n++;
      } catch {
        /* 半行忽略 */
      }
    }
    return n;
  } catch {
    return 0;
  }
}

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
 * 传输层观测：Node 侧直连 SSE，按到达顺序记录 { type, t }。
 * 与浏览器 transport 收到的是同一批广播帧，因此这段统计即「core 实际下发的帧序列」。
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
          frames.push({ type: ev.type, t: Date.now() });
        } catch {
          /* 坏帧忽略 */
        }
      }
    }
  })().catch((e) => {
    if (!ctrl.signal.aborted) console.error("[live-smoke] SSE 观测异常:", e.message);
  });
  return { frames, close: () => ctrl.abort(), done };
}

const fails = [];
console.log(`[live-smoke] 起 core（端口 ${CORE_PORT}，真实模型）…`);

// 1) 起 core（key 只走 env；stderr 落 run/ 便于排查）
/* 2026-09-24：CORE_MODELS_PATH 与 --env-file 用法均已删除 —— 清单放临时 agentDir（Pi 约定位置），
   凭证由 childEnv 注入；用临时 agentDir 也保证冒烟不写用户的全局 ~/.pi/agent。 */
const smokeAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-smoke-agent-"));
seedModelsJson(smokeAgentDir);
fs.writeFileSync(
  path.join(smokeAgentDir, "settings.json"),
  JSON.stringify({ defaultProjectTrust: "never" }, null, 2),
);
fs.mkdirSync(path.dirname(coreLogPath), { recursive: true });
const logFd = fs.openSync(coreLogPath, "w");
const child = spawn(process.execPath, [tsxPath, "src/main.ts"], {
  cwd: coreDir,
  env: childEnv({ CORE_TOKEN, CORE_PORT: String(CORE_PORT), CORE_AGENT_DIR: smokeAgentDir }),
  stdio: ["ignore", "ignore", logFd],
});

let exitCode = 1;
let phase = "启动 core";
let observer = null;
const startedAt = new Date().toISOString();
try {
  phase = "等待 core 就绪";
  const up = await waitForCoreUp(CORE_TOKEN, CORE_PORT);
  if (!up) throw new Error(`core 未在限定时间内就绪（端口 ${CORE_PORT}）`);
  const cfg = readCoreJson() ?? { port: CORE_PORT, token: CORE_TOKEN };
  const origin = `http://127.0.0.1:${cfg.port}`;

  phase = "建立 SSE 观测连接";
  observer = openSseObserver(origin, cfg.token);
  await sleep(300);

  phase = "CDP 驱动浏览器";
  await withBrowser(
    { port: CDP_PORT, origin, evidencePath: evidencePathAbs },
    async (ctx) => {
      const { cdp } = ctx;
      // ctx.assert 只认布尔项，用薄包装顺便收集失败名单
      const A = (name, detail) => {
        try {
          if (!ctx.assert(name, detail)) fails.push(name);
        } catch (e) {
          fails.push(`${name}（断言登记异常：${e.message}）`);
        }
      };

      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: SET_TEXT });

      phase = "打开 live 页面";
      await ctx.open(`/?live=1&token=${cfg.token}`);
      await cdp.eval(SET_TEXT);
      await sleep(600);

      const liveActive = await cdp.eval(
        `(() => { const s = window.__chatStore; return !!(s && s.getState && typeof s.getState().sendMessage === 'function'); })()`,
      );
      ctx.record("live_store_已挂载", liveActive);
      A("live 模式挂上真实 store 实例（window.__chatStore）", { 已挂载: liveActive === true });

      const initialCount = await cdp.eval(`window.__chatStore.getState().messages.length`);
      // 发送前的 DOM assistant 条目 id —— 用于把「新渲染出来的」和 mock 初始会话区分开
      const initialAssistantIds = await cdp.eval(
        `Array.from(document.querySelectorAll('[data-testid="message-item"][data-role="assistant"]')).map((el) => el.getAttribute('data-message-id'))`,
      );
      ctx.record("初始消息数 / 初始 DOM assistant 条目", { initialCount, initialAssistantIds });

      phase = "composer 发送";
      await cdp.eval(
        `(() => { const el = document.querySelector('[data-testid="composer-input"]'); window.__LT.setText(el, ${JSON.stringify(PROMPT)}); return true; })()`,
      );
      await sleep(200);
      const clicked = await cdp.eval(
        `(() => { const b = document.querySelector('[data-testid="composer-send"]'); if (!b || b.disabled) return false; b.click(); return true; })()`,
      );
      A("composer 发送按钮可点击并已触发", { 已点击: clicked === true });
      console.log("[live-smoke] 已发送，等待 assistant 消息与 streaming 解除 …");

      phase = "轮询 assistant 消息 + streaming 解除";
      let assistantText = "";
      let streamingResolved = false;
      let streamingSeen = false;
      let newAssistantCount = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < HARD_MS) {
        /*
         * ★ 只看**发送之后新增**的消息（slice(initialCount)）。
         * live 页仍以 INITIAL_SESSION 的 7 条 mock 消息起步，若把整段消息一起扫，
         * mock 里的 assistant 文本会立刻命中「有文本 + streaming=false」→ 假通过（本脚本首跑实踩）。
         */
        const snap = await cdp.eval(`(() => {
          const st = window.__chatStore.getState();
          const msgs = st.messages;
          const fresh = msgs.slice(${initialCount});
          let text = '';
          let assistants = 0;
          for (const m of fresh) {
            if (m.role !== 'assistant') continue;
            assistants++;
            for (const b of m.blocks) {
              if (b.type === 'text' && b.content && b.content.trim()) text = b.content;
            }
          }
          return { count: msgs.length, streaming: st.streaming, text: text.slice(0, 400), assistants };
        })()`);
        if (snap.streaming === true) streamingSeen = true;
        if (snap.text) assistantText = snap.text;
        newAssistantCount = snap.assistants;
        if (snap.text && snap.streaming === false) {
          streamingResolved = true;
          break;
        }
        await sleep(300);
      }

      phase = "DOM 断言";
      const domSnap = await cdp.eval(`(() => {
        const list = document.querySelector('[data-testid="message-list"]');
        const items = Array.from(document.querySelectorAll('[data-testid="message-item"]')).map((el) => ({
          id: el.getAttribute('data-message-id'),
          role: el.getAttribute('data-role'),
          text: (el.innerText || '').trim(),
        }));
        return { items, total: items.length,
                 listTotal: list ? list.getAttribute('data-total-count') : null };
      })()`);
      // 只认「发送后新增」的 assistant 条目（mock 初始会话里本来就有 assistant）
      const newDomAssistants = domSnap.items.filter(
        (it) => it.role === "assistant" && !initialAssistantIds.includes(it.id),
      );
      const newDomText = newDomAssistants.map((it) => it.text).join("\n").trim();
      ctx.record("DOM 快照", {
        总条目: domSnap.total,
        新增assistant条目: newDomAssistants.map((it) => it.id),
        新增assistant文本: newDomText.slice(0, 300),
        "列表data-total-count": domSnap.listTotal,
      });

      const finalSnap = await cdp.eval(`(() => {
        const st = window.__chatStore.getState();
        return { count: st.messages.length, streaming: st.streaming,
                 assistantIds: st.messages.filter((m) => m.role === 'assistant').map((m) => m.id) };
      })()`);
      ctx.record("live_结果快照", {
        initialCount,
        末消息数: finalSnap.count,
        assistantIds: finalSnap.assistantIds,
        assistantText,
        streamingSeen,
        streamingResolved,
        newAssistantCount,
      });

      A("store：发送后新增 assistant 消息块（含非空文本）", {
        新增assistant消息数: newAssistantCount >= 1,
        新增文本非空: assistantText.trim().length > 0,
      });
      A("store：等待期间观察到 streaming=true（真实链路确实进入流式态）", {
        流式态出现过: streamingSeen === true,
      });
      A("store：streaming 态最终解除（终态事件到达后）", { streaming已解除: streamingResolved === true });
      A("store：消息数较初始增加", { 数量增加: finalSnap.count > initialCount });
      A("DOM：渲染出新增 assistant 的 message-item 且含可见文本", {
        新增assistant条目: newDomAssistants.length >= 1,
        条目含文本: newDomText.length > 0,
        "列表 data-total-count 与 store 一致": String(domSnap.listTotal) === String(finalSnap.count),
      });
      A("DOM：最终 streaming 态已解除", { streaming为false: finalSnap.streaming === false });

      // 落盘 CDP 侧证据（steps + assertions + summary）；传输层证据随后并入同一文件
      ctx.save(evidencePathAbs);
    },
  );

  // 传输层统计（等一拍，确保最后的帧已读到）
  phase = "传输层统计";
  await sleep(500);
  // ★ 基线必须在**生成结束之后**读：core 启动时 events.jsonl 是空的（首跑在发送前读，得到 0，误判「放大」）
  const before = rawUpdateCount();
  const frames = observer.frames;
  const updateFrames = frames.filter((f) => f.type === "message_update");
  const settledFrames = frames.filter((f) => f.type === "agent_settled");
  const lastIndex = frames.length - 1;
  const settledAt = frames.findIndex((x) => x.type === "agent_settled");
  const updatesAfterSettled =
    settledAt < 0 ? 0 : frames.slice(settledAt + 1).filter((f) => f.type === "message_update").length;
  const orderSummary = frames.reduce((acc, f) => {
    acc[f.type] = (acc[f.type] ?? 0) + 1;
    return acc;
  }, {});

  const evidence = {
    sse观测_事件计数: orderSummary,
    sse观测_总帧数: frames.length,
    原始dump_message_update: before,
    sse_message_update: updateFrames.length,
    合并率: before > 0 ? Number((1 - updateFrames.length / before).toFixed(3)) : null,
    末帧类型: lastIndex >= 0 ? frames[lastIndex].type : null,
    agent_settled之后仍有message_update: updatesAfterSettled,
  };

  // 把传输层证据合并进已落盘的证据文件（cdp.ctx.save 刚写过 CDP 侧证据）
  let saved = { assertions: [], steps: [] };
  try {
    saved = JSON.parse(fs.readFileSync(evidencePathAbs, "utf8"));
  } catch {
    /* 保持空对象 */
  }
  saved.transport = evidence;
  saved.startedAt = startedAt;
  fs.writeFileSync(evidencePathAbs, JSON.stringify(saved, null, 2));

  // 传输层断言直接并入退出码
  const transportChecks = [
    ["传输层：SSE 收到 message_update（真实链路有事件下发）", updateFrames.length > 0],
    ["传输层：SSE 收到 agent_settled（终态未被批处理吞掉）", settledFrames.length >= 1],
    ["传输层：message_update 无放大（下发条数 ≤ 原始条数）", updateFrames.length <= before],
    ["传输层：agent_settled 之后不再冒 message_update（终态顺序正确）", updatesAfterSettled === 0],
  ];
  for (const [name, ok] of transportChecks) {
    console.log(`  ${ok ? "✓" : "✗"} ${name}`);
    if (!ok) fails.push(name);
  }
  console.log("\n### 传输层证据\n" + JSON.stringify(evidence, null, 2));

  // 汇总 = CDP 侧断言（ctx.save 已算）+ 传输层 4 项；整体重算，避免叠加到旧文件上
  const cdpAssertions = saved.assertions ?? [];
  const cdpFailed = cdpAssertions.filter((a) => !a.pass).map((a) => a.name);
  const transportFailed = transportChecks.filter(([, ok]) => !ok).map(([n]) => n);
  const transportPassed = transportChecks.length - transportFailed.length;
  saved.summary = {
    assertions: cdpAssertions.length + transportChecks.length,
    passed: cdpAssertions.filter((a) => a.pass).length + transportPassed,
    failed: cdpFailed.length + transportFailed.length,
    failedNames: [...cdpFailed, ...transportFailed],
    transportChecks: transportChecks.map(([n, ok]) => ({ name: n, pass: ok })),
  };
  fs.writeFileSync(evidencePathAbs, JSON.stringify(saved, null, 2));
  console.log(`== 传输层断言并入证据：${evidenceFile} ==`);

  exitCode = fails.length === 0 ? 0 : 1;
} catch (e) {
  console.error(`[live-smoke] 异常（阶段：${phase}）：`, e.message);
  // 降级证据：失败也要留痕（含失败阶段与 core 日志路径），便于主控判断是否改 SSE 层验收
  const fallback = {
    startedAt,
    failedAtPhase: phase,
    error: e.message,
    coreLogPath: path.relative(process.cwd(), coreLogPath),
    transport: observer
      ? { 已收到的帧数: observer.frames.length, 事件计数: observer.frames.reduce((a, f) => ((a[f.type] = (a[f.type] ?? 0) + 1), a), {}) }
      : null,
    note: "本轮未走完 CDP 流程，未生成完整断言证据。",
  };
  fs.writeFileSync(evidencePathAbs, JSON.stringify(fallback, null, 2));
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

console.log(fails.length === 0 ? "\nlive 烟测全部通过" : `\nlive 烟测失败 ${fails.length} 项：\n - ${fails.join("\n - ")}`);
process.exit(exitCode);
