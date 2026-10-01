/**
 * 工具 diff/内容预览 端到端 CDP 探针（task-tool-diff-preview.md）—— `probe:tool-diff`。
 *
 * 与 model 无关的确定性 live 探针：**合成会话文件**（edit 带 details.diff、write 带
 * args.content、bash 无 details 的三张工具卡）预先写进临时 agentDir 的 sessions 目录，
 * 起 core（同源托管 dist 形态）→ CDP 打开 `/?live=1` → 侧栏点击加载会话 → 展开工具卡断言。
 * 覆盖链路：会话 jsonl（历史真源）→ /sessions/load → sessions.ts details 回填 →
 * reducer/TerminalBlock → ToolCallCard 分派 → ToolDiffView / ToolWritePreview 渲染。
 * live SSE 的 adapt.ts 透传由 core check:tool-details 以 fixture 锁定，本探针不烧模型。
 *
 * 判据
 * ├─ C0 前置闸门：侧栏出现合成会话并可点击加载（找不到即判红——合成文件写错位置会静默空过）
 * ├─ C1 store 侧：加载后的 edit 终端块带 details.diff（sessions.ts 透传链真源证据）
 * ├─ C2 D3 行首摘要：edit 卡收起态显示 `path · 1 处替换`、write 卡只显示 `path`（内容不外泄）
 * ├─ C3 edit 展开区：tool-diff 出现，data-kind 计数与 fixture 精确一致（add/del/ctx/skip），
 * │      新增行行号 = 新文件行号、删除行行号 = 旧文件行号，新增行底色非透明（diff 令牌生效）
 * ├─ C4 截断口径：首屏 12 行 + 「查看完整内容（还有 N 行）」，点击后全量
 * ├─ C5 write 展开区：头行 `path · 新写入 N 行`；shiki 就绪后 .line 行数正确（shiki 懒加载，兜底纯文本不算失败但要等到）；行号 gutter（::before）存在
 * ├─ C6 write 截断口径：同 C4
 * └─ C7 回落路径：bash 卡（无 details）展开仍是 $ 命令 + 输出文本，行为不变
 *
 * 运行前置：`packages/ui` 下先 `npm run build`（core 托管的是 dist，不是源码）。
 * 用法：`npm run probe:tool-diff`；证据 `_probe-tool-diff-evidence.json`；失败非 0 退出。
 * 坑（沿用 cdp.mjs 备忘）：断言值必须 true/false；点击一律 evaluate(el.click)。
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
const coreLogPath = path.join(coreDir, "run", "probe-tool-diff-core.log");
const evidencePathAbs = path.join(uiDir, "_probe-tool-diff-evidence.json");

const CORE_PORT = Number(process.env.PROBE_TOOL_DIFF_CORE_PORT ?? 5197);
const CDP_PORT = Number(process.env.PROBE_TOOL_DIFF_CDP_PORT ?? 9366);
const TOKEN = process.env.PROBE_TOOL_DIFF_TOKEN ?? "probe-tool-diff-token";
const HARD_MS = Number(process.env.PROBE_TOOL_DIFF_HARD_MS ?? 150_000);

// 先删上一轮证据（live-smoke 同款纪律：防旧断言混入汇总）
try {
  fs.rmSync(evidencePathAbs, { force: true });
} catch {
  /* 忽略 */
}

/* ---------------------------------------------------------------------------
 * 合成会话夹具（与真实 pi 会话 jsonl 同构，session-rename-delete 批次验证过的手法）
 * ------------------------------------------------------------------------- */

const MARKER = "diff-write-探针会话";

/** 16 行 diff（>TERMINAL_MAX_LINES=12，触发截断口径）；行格式见 lib/diff-parse.ts 头注释 */
const DIFF_LINES = [
  ["skip", null, null],
  ["ctx", 10, "\tfunction demo() {"],
  ["ctx", 11, "\t  const keep = 1;"],
  ["del", 12, "\t  let removed = 2;"],
  ["add", 12, "\t  const added = 3;"],
  ["add", 13, "\t  const addedToo = 4;"],
  ["ctx", 14, "\t  return keep;"],
  ["ctx", 15, "}"],
  ["skip", null, null],
  ["ctx", 20, "\tfunction second() {"],
  ["del", 21, "\t  oldCall();"],
  ["add", 21, "\t  newCall();"],
  ["add", 22, "\t  anotherCall();"],
  ["add", 23, "\t  thirdCall();"],
  ["ctx", 24, "}"],
  ["skip", null, null],
];
const DIFF = DIFF_LINES.map(([kind, lineNo, content]) => {
  if (kind === "skip") return "     ...";
  const sign = kind === "add" ? "+" : kind === "del" ? "-" : " ";
  return `${sign}${lineNo} ${content}`;
}).join("\n");
const KIND_COUNTS = DIFF_LINES.reduce((acc, [kind]) => ({ ...acc, [kind]: (acc[kind] ?? 0) + 1 }), {});
const WRITE_LINES = 20;
const WRITE_CONTENT = Array.from({ length: WRITE_LINES }, (_, i) => `${i + 1}. notes line ${i + 1}`).join("\n");

const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);
const ts = (i) => new Date(T0 + i * 60_000).toISOString();
const base = (id, parentId, i) => ({ id, parentId, timestamp: ts(i) });

function buildSessionEntries(cwd) {
  // ⚠️ entry 链必须**线性**（每条 parentId = 上一条 id）——真实 pi 会话是线性链，
  // getBranch 从叶子回溯；分叉（如 toolResult 与下一条 assistant 同父）会把
  // toolResult 甩出活动分支 → 终端块丢失 → 卡片全回落无 testid 的 ToolCallInline。
  return [
    { type: "session", version: 3, id: "probe-tooldiff-session", timestamp: ts(0), cwd },
    { ...base("e1", null, 1), type: "message", message: { role: "user", content: [{ type: "text", text: MARKER }] } },
    {
      ...base("e2", "e1", 2),
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t-edit", name: "edit", arguments: { path: "src/demo.ts", edits: [{ oldText: "b = old", newText: "b = new" }] } }],
      },
    },
    {
      ...base("e3", "e2", 3),
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "t-edit",
        toolName: "edit",
        content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/demo.ts." }],
        details: { diff: DIFF, patch: "--- a/src/demo.ts\n+++ b/src/demo.ts\n", firstChangedLine: 12 },
        isError: false,
        timestamp: Date.now(),
      },
    },
    {
      ...base("e4", "e3", 4),
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t-write", name: "write", arguments: { path: "notes.md", content: WRITE_CONTENT } }],
      },
    },
    {
      ...base("e5", "e4", 5),
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "t-write",
        toolName: "write",
        content: [{ type: "text", text: "Successfully wrote to notes.md" }],
        isError: false,
        timestamp: Date.now(),
      },
    },
    {
      ...base("e6", "e5", 6),
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t-bash", name: "bash", arguments: { command: "echo hi" } }],
      },
    },
    {
      ...base("e7", "e6", 7),
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "t-bash",
        toolName: "bash",
        content: [{ type: "text", text: "hi" }],
        isError: false,
        timestamp: Date.now(),
      },
    },
    {
      ...base("e8", "e7", 8),
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "编辑与写入都完成了。" }] },
    },
  ];
}

console.log(`[probe-tool-diff] 起 core（端口 ${CORE_PORT}，合成会话、无模型调用）…`);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-tooldiff-"));
const agentDir = path.join(tmpRoot, "agentdir");
const cwd = path.join(tmpRoot, "project");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));
seedModelsJson(agentDir);

// 合成会话写进 pi 会话档位目录（slug 算法照抄 pi session-manager.ts:503）
const slug = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const sessionDir = path.join(agentDir, "sessions", slug);
fs.mkdirSync(sessionDir, { recursive: true });
const sessionFile = path.join(sessionDir, "2026-10-01T10-00-00-000Z_probe-tooldiff.jsonl");
fs.writeFileSync(sessionFile, buildSessionEntries(cwd).map((e) => JSON.stringify(e)).join("\n") + "\n");

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

/** 卡片查找/展开工具（evaluate 内执行；一律 el.click()，cua 坐标不可靠） */
const HELPERS = `
window.__TD = {
  cardRow(partial) {
    const el = [...document.querySelectorAll('[data-testid="tool-call-card"]')]
      .find((n) => (n.innerText || '').includes(partial));
    return el ? !!el : false;
  },
  expand(partial) {
    const el = [...document.querySelectorAll('[data-testid="tool-call-card"]')]
      .find((n) => (n.innerText || '').includes(partial));
    if (!el) return false;
    const btn = el.querySelector('button[aria-expanded]');
    if (!btn) return false;
    btn.click();
    return true;
  },
  rowText(partial) {
    const el = [...document.querySelectorAll('[data-testid="tool-call-card"]')]
      .find((n) => (n.innerText || '').includes(partial));
    return el ? (el.innerText || '').trim() : '';
  },
  kinds(container) {
    const rows = [...(container ?? document).querySelectorAll('[data-testid="tool-diff"] [data-kind]')];
    const counts = {};
    for (const r of rows) counts[r.getAttribute('data-kind')] = (counts[r.getAttribute('data-kind')] ?? 0) + 1;
    return { counts, total: rows.length };
  },
  gutterOf(kind, index) {
    const rows = [...document.querySelectorAll('[data-testid="tool-diff"] [data-kind="' + kind + '"]')];
    const row = rows[index];
    if (!row) return null;
    return (row.querySelector('span')?.textContent ?? '').trim();
  },
  addBgColor() {
    const row = document.querySelector('[data-testid="tool-diff"] [data-kind="add"]');
    return row ? getComputedStyle(row).backgroundColor : null;
  },
  writeHeader() {
    const el = document.querySelector('[data-testid="tool-write-preview"]');
    if (!el) return null;
    return (el.querySelector('div')?.textContent ?? '').trim();
  },
  shikiLineCount() {
    return document.querySelectorAll('[data-testid="tool-write-preview"] .preview-source .shiki .line').length;
  },
  gutterWidthPx() {
    const line = document.querySelector('[data-testid="tool-write-preview"] .preview-source .shiki .line');
    if (!line) return null;
    const w = getComputedStyle(line, '::before').width;
    return parseFloat(w);
  },
  clickTruncateMore(scope) {
    const root = scope === 'write'
      ? document.querySelector('[data-testid="tool-write-preview"]')
      : document.querySelector('[data-testid="tool-diff"]');
    if (!root) return false;
    const btn = [...root.querySelectorAll('button')].find((b) => (b.textContent || '').includes('查看完整内容'));
    if (!btn) return false;
    btn.click();
    return true;
  },
  diffRowCount() {
    return document.querySelectorAll('[data-testid="tool-diff"] [data-kind]').length;
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

  phase = "CDP 驱动浏览器";
  await withBrowser({ port: CDP_PORT, origin, evidencePath: evidencePathAbs }, async (ctx) => {
    const { cdp } = ctx;
    const A = (name, detail) => {
      try {
        // ctx.assert 纪律：detail 必须是「键全为布尔」的对象；裸布尔在这里归一成 { ok }
        const d = detail !== null && typeof detail === "object" ? detail : { ok: detail === true };
        if (!ctx.assert(name, d)) fails.push(name);
      } catch (e) {
        console.error(`[probe-tool-diff] 断言异常 ${name}:`, e.message);
        fails.push(name);
      }
    };

    phase = "打开页面";
    await ctx.open(`/?live=1&token=${TOKEN}`);

    phase = "C0 侧栏定位合成会话并加载";
    await cdp.eval(HELPERS);
    const appeared = await waitForSelector(cdp, '[data-testid^="sidebar-history-item-"]', 15000);
    const sidebarCount = await cdp.eval(
      `[...document.querySelectorAll('[data-testid^="sidebar-history-item-"]')].length`,
      true,
    );
    ctx.record("C0 侧栏历史项", { count: sidebarCount });
    A("C0 侧栏历史项出现", appeared === true);
    const clicked = await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('[data-testid^="sidebar-history-item-"]')];
      const el = items.find((n) => (n.getAttribute('title') || '').includes(${JSON.stringify(MARKER)}));
      if (!el) return false;
      el.click();
      return true;
    })()`);
    ctx.record("C0 侧栏点击", { clicked, marker: MARKER });
    A("C0 合成会话可点击", clicked === true);

    // 历史加载同样会把可折叠轮次收进「处理详情」（chat-store 对 loaded.messages 也写
    // settledTurnKeys）→ 先断言折叠行出现、点开，工具卡才渲染
    phase = "C0b 展开处理详情";
    const collapseRow = await waitForSelector(cdp, '[data-testid="process-details"]', 8000);
    A("C0b 处理详情折叠行出现（历史轮默认收起）", collapseRow === true);
    const expanded = await cdp.eval(
      `(() => { const el = document.querySelector('[data-testid="process-details"]'); if (!el) return false; if (el.getAttribute('data-expanded') !== 'true') el.click(); return true; })()`,
      true,
    );
    A("C0b 处理详情可点开", expanded === true);
    await sleep(300);

    phase = "C0c 工具卡渲染";
    const cardsUp = await waitForSelector(cdp, '[data-testid="tool-call-card"]', 8000);
    const cardCount = await cdp.eval(`document.querySelectorAll('[data-testid="tool-call-card"]').length`, true);
    ctx.record("C0c 工具卡", { rendered: cardsUp, count: cardCount });
    A("C0c 展开后工具卡渲染 3 张", cardsUp === true && cardCount === 3);

    phase = "C1 store 侧 details 证据";
    const storeProbe = await cdp.eval(
      `(() => {
        const st = window.__chatStore?.getState?.();
        const msgs = st?.messages ?? [];
        const term = msgs.flatMap((m) => m.blocks ?? []).find((b) => b.type === 'terminal' && b.toolCallId === 't-edit');
        return term ? { hasDetails: 'details' in term, diffHead: String(term.details?.diff ?? '').slice(0, 8), toolName: msgs.flatMap((m) => m.blocks ?? []).find((b) => b.type === 'tool_call' && b.toolCallId === 't-edit')?.toolName } : { hasDetails: false };
      })()`,
      true,
    );
    ctx.record("C1 store 侧终端块", storeProbe);
    A("C1 store：edit 终端块带 details", storeProbe.hasDetails === true);
    A("C1 store：details.diff 内容来自会话文件", String(storeProbe.diffHead ?? "").startsWith("     ...") === true);

    phase = "C2 行首摘要（D3）";
    const editRow = await cdp.eval(`window.__TD.rowText('src/demo.ts')`, true);
    const writeRow = await cdp.eval(`window.__TD.rowText('notes.md')`, true);
    ctx.record("C2 收起态行文本", { editRow, writeRow });
    A("C2 edit 行首显示 path · 处数", editRow.includes("src/demo.ts · 1 处替换") === true);
    A("C2 edit 行首不外泄 edits 内容", editRow.includes("b = old") === false);
    A("C2 write 行首只显示 path", writeRow.startsWith("write") === true && writeRow.includes("notes.md") === true);
    A("C2 write 行首不外泄 content", writeRow.includes("notes line") === false);

    phase = "C3 edit 展开区 diff 渲染（首屏截断态）";
    A("C3 edit 卡可展开", (await cdp.eval(`window.__TD.expand('src/demo.ts')`, true)) === true);
    await waitForSelector(cdp, '[data-testid="tool-diff"]', 8000);
    const firstScreen = await cdp.eval(`window.__TD.kinds(document)`, true);
    ctx.record("C3 首屏 data-kind 计数", firstScreen);
    A("C3 首屏 12 行（TERMINAL_MAX_LINES 口径）", firstScreen.total === 12);
    const addGutter = await cdp.eval(`window.__TD.gutterOf('add', 0)`, true);
    const delGutter = await cdp.eval(`window.__TD.gutterOf('del', 0)`, true);
    A("C3 新增行行号 = 新文件行号（12）", addGutter === "12");
    A("C3 删除行行号 = 旧文件行号（首条 12）", delGutter === "12");
    const addBg = await cdp.eval(`window.__TD.addBgColor()`, true);
    ctx.record("C3 新增行底色", addBg);
    A("C3 新增行底色非透明（diff 令牌生效）", typeof addBg === "string" && addBg !== "rgba(0, 0, 0, 0)" && addBg !== "transparent");

    phase = "C4 diff 截断口径 + 全量分类计数";
    const beforeRows = await cdp.eval(`window.__TD.diffRowCount()`, true);
    A("C4 截断入口可点", (await cdp.eval(`window.__TD.clickTruncateMore('diff')`, true)) === true);
    await sleep(200);
    const afterRows = await cdp.eval(`window.__TD.diffRowCount()`, true);
    A("C4 展开后 16 行", beforeRows === 12 && afterRows === 16);
    const full = await cdp.eval(`window.__TD.kinds(document)`, true);
    ctx.record("C4 全量 data-kind 计数", full);
    A("C4 add 行 5 条", full.counts.add === 5);
    A("C4 del 行 2 条", full.counts.del === 2);
    A("C4 ctx 行 6 条", full.counts.ctx === 6);
    A("C4 skip 行 3 条", full.counts.skip === 3);
    await ctx.cdp.screenshot(path.join(uiDir, "_probe-tool-diff-shot-diff.png"));

    phase = "C5 write 展开区内容预览";
    A("C5 write 卡可展开", (await cdp.eval(`window.__TD.expand('notes.md')`, true)) === true);
    await waitForSelector(cdp, '[data-testid="tool-write-preview"]', 8000);
    const header = await cdp.eval(`window.__TD.writeHeader()`, true);
    ctx.record("C5 write 头行", header);
    A(
      "C5 头行含路径与行数",
      typeof header === "string" && header.includes("notes.md") === true && header.includes("新写入 20 行") === true,
    );
    // shiki 懒加载：轮询等它就绪（失败兜底纯文本也要等到稳定再断言行数）
    let shikiReady = false;
    for (let i = 0; i < 50; i++) {
      shikiReady = (await cdp.eval(`window.__TD.shikiLineCount() > 0`, true)) === true;
      if (shikiReady) break;
      await sleep(200);
    }
    A("C5 shiki 高亮就绪", shikiReady === true);
    const linesTruncated = await cdp.eval(`window.__TD.shikiLineCount()`, true);
    A("C5 首屏 12 行", linesTruncated === 12);
    const gutterW = await cdp.eval(`window.__TD.gutterWidthPx()`, true);
    ctx.record("C5 行号 gutter 宽", gutterW);
    A("C5 行号 gutter 存在", typeof gutterW === "number" && gutterW > 0);
    // 行距回归守卫：shiki 行间 \n + .line block 化会把行距翻倍（shiki.css white-space 修复），
    // 相邻行 top 差应 ≈ 1.6 × 12px ≈ 19.2px，翻倍则 ≈ 38px
    const pitch = await cdp.eval(
      `(() => {
         const lines = [...document.querySelectorAll('[data-testid="tool-write-preview"] .preview-source .shiki .line')];
         if (lines.length < 2) return null;
         return lines[1].getBoundingClientRect().top - lines[0].getBoundingClientRect().top;
       })()`,
      true,
    );
    ctx.record("C5 相邻行距 px", pitch);
    A("C5 行距紧凑未翻倍（<30px）", typeof pitch === "number" && pitch > 0 && pitch < 30);

    phase = "C6 write 截断口径";
    A("C6 展开全部可点", (await cdp.eval(`window.__TD.clickTruncateMore('write')`, true)) === true);
    // 点击后按全量内容重新高亮（异步）：轮询等行数到 20，防 shiki 二次渲染竞态
    let linesFull = 0;
    for (let i = 0; i < 25; i++) {
      linesFull = await cdp.eval(`window.__TD.shikiLineCount()`, true);
      if (linesFull === WRITE_LINES) break;
      await sleep(200);
    }
    A("C6 展开后 20 行", linesFull === WRITE_LINES);
    await ctx.cdp.screenshot(path.join(uiDir, "_probe-tool-diff-shot-write.png"));

    phase = "C7 bash 回落路径（无 details）";
    A("C7 bash 卡可展开", (await cdp.eval(`window.__TD.expand('echo hi')`, true)) === true);
    await waitForSelector(cdp, '[data-testid="terminal-output"]', 8000);
    const bashOutput = await cdp.eval(
      `document.querySelector('[data-testid="terminal-output"]')?.textContent ?? ''`,
      true,
    );
    A("C7 bash 输出文本照旧", typeof bashOutput === "string" && bashOutput.includes("hi") === true);
  });

  exitCode = fails.length === 0 ? 0 : 1;
} catch (e) {
  console.error(`[probe-tool-diff] 异常（阶段：${phase}）：`, e.message);
  fs.writeFileSync(
    evidencePathAbs,
    JSON.stringify({ failedAtPhase: phase, error: e.message, note: "本轮未走完流程，未生成完整断言证据。" }, null, 2),
  );
  exitCode = 1;
} finally {
  try {
    child.kill("SIGTERM");
  } catch {
    /* 已退出 */
  }
  fs.closeSync(logFd);
}

console.log(fails.length === 0 ? "\n工具 diff/内容预览探针全部通过" : `\n探针失败 ${fails.length} 项：\n - ${fails.join("\n - ")}`);
process.exit(exitCode);
