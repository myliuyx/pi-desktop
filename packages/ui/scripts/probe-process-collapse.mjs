/**
 * 处理详情折叠探针（task-process-collapse.md 步骤 7）—— CDP 驱动真实链路（?live=1）。
 *
 * 流程（全部真实，不打桩）：起 core（临时 agentDir + 临时项目目录，目录里造 3 个文件）
 * → SSE 旁路观测并**自动应答授权请求**（工具执行可能触发 approval_request，无人值守必须代答）
 * → CDP 打开 `/?live=1&token=…` → composer 发工具导向 prompt（流式中走真实 agent_settled 链路）
 * → 断言：
 *   ① 流式进行中「处理详情」折叠行不出现（盯过程阶段不收起）；
 *   ② settled 后折叠行出现、data-expanded="false"、文案含计数；
 *   ③ 计数与 store 推导一致（N=assistant 条数 / M=toolCallId 去重）；
 *   ④ 收起态：中间 assistant 行 innerText 为空、tool-call-card 全部隐藏、尾条有可见文本；
 *   ⑤ 点击展开 → data-expanded="true"、工具卡恢复 M 张；
 *   ⑥ 再点收起 → 复原。
 *
 * 运行前置：`packages/ui` 下先 `npm run build`（core 托管的是 dist，不是源码）。
 * 用法：`npm run probe:process-collapse`；证据 `_probe-process-collapse-evidence.json`；
 * 截图 `_probe-collapse-shot-collapsed.png` / `-expanded.png`；失败非 0 退出。
 *
 * 模型不配合（不调工具）时按失败如实报 —— prompt 已强导向，不许放水成 skip。
 * 坑（沿用 cdp.mjs 备忘）：断言值必须 true/false；点击一律 evaluate(el.click)。
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
const coreLogPath = path.join(coreDir, "run", "probe-collapse-core.log");
const evidencePathAbs = path.join(uiDir, "_probe-process-collapse-evidence.json");
const shotCollapsed = path.join(uiDir, "_probe-collapse-shot-collapsed.png");
const shotExpanded = path.join(uiDir, "_probe-collapse-shot-expanded.png");

const CORE_PORT = Number(process.env.PROBE_COLLAPSE_CORE_PORT ?? 5196);
const CDP_PORT = Number(process.env.PROBE_COLLAPSE_CDP_PORT ?? 9364);
const TOKEN = process.env.PROBE_COLLAPSE_TOKEN ?? "probe-collapse-token";
const PROMPT =
  process.env.PROBE_COLLAPSE_PROMPT ??
  "请用 bash 工具执行 ls 查看当前目录里有什么文件，然后告诉我一共有几个文件。";
const HARD_MS = Number(process.env.PROBE_COLLAPSE_HARD_MS ?? 240_000);

// 先删上一轮证据（live-smoke 同款纪律：防旧断言混入汇总）
try {
  fs.rmSync(evidencePathAbs, { force: true });
} catch {
  /* 忽略 */
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
 * SSE 旁路观测 + 自动应答授权。
 * 工具执行可能触发 approval_request（select/confirm），无人值守场景下用首选项代答
 * （bash 类请求的选项首项即「允许」），否则探针会卡在授权门上直到超时。
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
    if (!ctrl.signal.aborted) console.error("[probe-collapse] SSE 观测异常:", e.message);
  });
  return { frames, close: () => ctrl.abort(), done };
}

console.log(`[probe-collapse] 起 core（端口 ${CORE_PORT}，真实模型）…`);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-collapse-"));
const agentDir = path.join(tmpRoot, "agentdir");
const cwd = path.join(tmpRoot, "project");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));
seedModelsJson(agentDir);
// 造 3 个文件：ls 有东西可列，模型有内容可答
for (const name of ["alpha.txt", "beta.txt", "gamma.txt"]) {
  fs.writeFileSync(path.join(cwd, name), `${name}\n`);
}

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

    phase = "composer 发送（工具导向 prompt）";
    await cdp.eval(
      `(() => { const el = document.querySelector('[data-testid="composer-input"]'); window.__LT.setText(el, ${JSON.stringify(PROMPT)}); return true; })()`,
    );
    await sleep(200);
    const clicked = await cdp.eval(
      `(() => { const b = document.querySelector('[data-testid="composer-send"]'); if (!b || b.disabled) return false; b.click(); return true; })()`,
    );
    A("composer 发送按钮可点击并已触发", { 已点击: clicked === true });
    console.log("[probe-collapse] 已发送，等待真实回复与 agent_settled …");

    phase = "轮询至 streaming 解除";
    let streamingSeen = false;
    let rowSeenDuringStreaming = false;
    let snap = null;
    const t0 = Date.now();
    while (Date.now() - t0 < HARD_MS) {
      snap = await cdp.eval(`(() => {
        const st = window.__chatStore.getState();
        const msgs = st.messages;
        let lastUserIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { lastUserIdx = i; break; }
        const toolIds = new Set();
        let text = '';
        const turnIds = [];
        for (let i = lastUserIdx + 1; i < msgs.length; i++) {
          const m = msgs[i];
          if (m.role !== 'assistant') continue;
          turnIds.push(m.id);
          for (const b of m.blocks) {
            if (b.type === 'tool_call') toolIds.add(b.toolCallId);
            if (b.type === 'text' && b.content.trim()) text = b.content;
          }
        }
        const row = document.querySelector('[data-testid="process-details"]');
        return { count: msgs.length, streaming: st.streaming, turnIds, toolCalls: toolIds.size,
                 text: text.slice(0, 200), rowExists: !!row,
                 rowExpanded: row ? row.getAttribute('data-expanded') : null,
                 settledKeys: [...st.settledTurnKeys] };
      })()`);
      if (snap.streaming === true) {
        streamingSeen = true;
        if (snap.rowExists) rowSeenDuringStreaming = true;
      }
      if (snap.streaming === false && snap.text && snap.toolCalls >= 1) break;
      await sleep(400);
    }
    if (!snap) throw new Error("轮询未取得任何快照");
    ctx.record("流式结束快照", {
      streamingSeen,
      流式中出现过折叠行: rowSeenDuringStreaming,
      本轮assistantIds: snap.turnIds,
      工具调用数: snap.toolCalls,
      文本预览: snap.text,
      settledKeys: snap.settledKeys,
    });

    phase = "收起态断言";
    await sleep(800); // 等 collapse 渲染与虚拟行重测完成

    const domCollapsed = await cdp.eval(`(() => {
      const list = document.querySelector('[data-testid="message-list"]');
      const row = document.querySelector('[data-testid="process-details"]');
      const items = Array.from(document.querySelectorAll('[data-testid="message-item"]')).map((el) => ({
        id: el.getAttribute('data-message-id'),
        role: el.getAttribute('data-role'),
        text: (el.innerText || '').trim(),
      }));
      return {
        rowExists: !!row,
        rowExpanded: row ? row.getAttribute('data-expanded') : null,
        rowText: row ? row.innerText.trim() : '',
        items,
        listTotal: list ? list.getAttribute('data-total-count') : null,
        cardCount: document.querySelectorAll('[data-testid="tool-call-card"]').length,
      };
    })()`);

    const turnAssistants = domCollapsed.items.filter(
      (it) => it.role === "assistant" && snap.turnIds.includes(it.id),
    );
    const emptyRows = turnAssistants.filter((it) => it.text === "");
    const multiAssistant = snap.turnIds.length > 1;

    A("流式中折叠行不出现（盯过程阶段不收起）", { 流式中出现过: rowSeenDuringStreaming === false });
    A("store：settled 后本轮已入 settledTurnKeys", { 标记数: snap.settledKeys.length >= 1 });
    A("DOM：折叠行出现且默认收起", {
      行存在: domCollapsed.rowExists === true,
      默认收起: domCollapsed.rowExpanded === "false",
    });
    A("DOM：折叠行文案含计数口径", {
      含条消息: /处理详情 · \d+ 条消息/.test(domCollapsed.rowText),
      含次工具调用: /\d+ 次工具调用/.test(domCollapsed.rowText),
    });
    A("DOM：计数与 store 推导一致", {
      assistant数一致: domCollapsed.rowText.includes(`${snap.turnIds.length} 条消息`),
      工具数一致: domCollapsed.rowText.includes(`${snap.toolCalls} 次工具调用`),
    });
    A("DOM：模型确实调用了工具（prompt 已强导向）", { 工具调用数: snap.toolCalls >= 1 });
    A("DOM：收起态工具卡全部隐藏", { 卡片数: domCollapsed.cardCount === 0 });
    A("DOM：中间 assistant 行内容为空（整轮收起）", {
      中间行为空:
        !multiAssistant || emptyRows.length === snap.turnIds.length - 1,
      本轮assistant条数: snap.turnIds.length,
      空行数: emptyRows.length,
    });
    A("DOM：尾条最终文本可见", { 有可见文本: turnAssistants.some((it) => it.text !== "") });
    A("DOM：data-total-count 与 store 一致（隐藏行包装保留）", {
      一致: String(domCollapsed.listTotal) === String(snap.count),
    });
    await ctx.cdp.screenshot(shotCollapsed);

    phase = "展开态断言";
    await cdp.eval(
      `(() => { const el = document.querySelector('[data-testid="process-details"]'); if (!el) return false; el.click(); return true; })()`,
    );
    await sleep(500);
    const domExpanded = await cdp.eval(`(() => {
      const row = document.querySelector('[data-testid="process-details"]');
      const items = Array.from(document.querySelectorAll('[data-testid="message-item"]')).map((el) => ({
        id: el.getAttribute('data-message-id'),
        role: el.getAttribute('data-role'),
        text: (el.innerText || '').trim(),
      }));
      return {
        rowExpanded: row ? row.getAttribute('data-expanded') : null,
        items,
        cardCount: document.querySelectorAll('[data-testid="tool-call-card"]').length,
      };
    })()`);
    const expandedAssistants = domExpanded.items.filter(
      (it) => it.role === "assistant" && snap.turnIds.includes(it.id),
    );
    const expandedEmpty = expandedAssistants.filter((it) => it.text === "").length;
    A("DOM：点击后展开", { 展开态: domExpanded.rowExpanded === "true" });
    A("DOM：展开后工具卡恢复", { 卡片数等于工具调用数: domExpanded.cardCount === snap.toolCalls, 实际: domExpanded.cardCount });
    A("DOM：展开后中间行内容恢复", {
      空行数归零: !multiAssistant || expandedEmpty === 0,
      空行数: expandedEmpty,
    });
    await ctx.cdp.screenshot(shotExpanded);

    phase = "再收起断言";
    await cdp.eval(
      `(() => { const el = document.querySelector('[data-testid="process-details"]'); if (!el) return false; el.click(); return true; })()`,
    );
    await sleep(500);
    const domReCollapsed = await cdp.eval(`(() => {
      const row = document.querySelector('[data-testid="process-details"]');
      return {
        rowExpanded: row ? row.getAttribute('data-expanded') : null,
        cardCount: document.querySelectorAll('[data-testid="tool-call-card"]').length,
      };
    })()`);
    A("DOM：再点恢复收起", {
      收起态: domReCollapsed.rowExpanded === "false",
      卡片隐藏: domReCollapsed.cardCount === 0,
    });

    ctx.save(evidencePathAbs);
  });

  phase = "传输层统计";
  await sleep(500);
  const frames = observer.frames;
  const eventSummary = frames.reduce((acc, t) => ((acc[t] = (acc[t] ?? 0) + 1), acc), {});
  const transportChecks = [
    ["传输层：SSE 收到 tool_execution_start（真实工具链路）", frames.includes("tool_execution_start")],
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
  console.error(`[probe-collapse] 异常（阶段：${phase}）：`, e.message);
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

console.log(fails.length === 0 ? "\n处理详情折叠探针全部通过" : `\n探针失败 ${fails.length} 项：\n - ${fails.join("\n - ")}`);
process.exit(exitCode);
