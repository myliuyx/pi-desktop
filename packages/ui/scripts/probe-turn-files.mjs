/**
 * 回复文件 chips 端到端 CDP 探针（task-turn-file-chips.md §三.4/§六）—— `probe:turn-files`。
 *
 * 与 model 无关的确定性 live 探针（probe:tool-diff 骨架）：**合成会话文件**预先写进
 * 临时 agentDir 的 sessions 目录——一轮含：成功 edit（src/demo.ts）+ 成功 write
 * （notes.md）+ bash + **失败 edit**（src/ghost.ts，isError）——项目目录里真实造好
 * demo.ts / notes.md 两个文件供预览读取。起 core（同源托管 dist）→ CDP 打开
 * `/?live=1` → 侧栏点击加载会话 → 断言 chips → 点击 chip 打开右侧预览。
 *
 * 判据（规格书 §六 P1-P8 的 DOM 落点）
 * ├─ F0 前置闸门：侧栏出现合成会话并可点击加载
 * ├─ F1 折叠态可见：「处理详情」默认收起时 chips 行已渲染（折叠共存判据）
 * ├─ F2 收录口径：chip 数 = 2（bash 不计、失败 edit 不计、无 ghost chip）
 * ├─ F3 顺序与路径：首触顺序 edit→write；data-path = 相对 display
 * ├─ F4 文本：chip 主文本 = basename
 * ├─ F5 徽标（D2=B）：edit chip「修改」、write chip「写入」
 * ├─ F6 tooltip：write chip 含「新建或覆盖」；edit chip 含「修改 · <相对路径>」
 * ├─ F7 点击 edit chip → 预览区展开 + 文件名条 + 源码内容命中（真 /fs/read 链路）
 * ├─ F8 关闭（清选择+收起）→ 点 write chip → .md 走效果 Tab（Markdown 渲染）内容命中
 * └─ F9 展开处理详情后 chips 仍在（折叠/展开两态共存）
 *
 * 运行前置：`packages/ui` 下先 `npm run build`（core 托管的是 dist，不是源码）。
 * 用法：`npm run probe:turn-files`；证据 `_probe-turn-files-evidence.json`；失败非 0 退出。
 * 坑（沿用 cdp.mjs / probe:tool-diff 备忘）：ctx.assert 的 detail 必须键全为布尔；
 * 合成 entry 链必须线性；点击一律 evaluate/el.click()。
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
const coreLogPath = path.join(coreDir, "run", "probe-turn-files-core.log");
const evidencePathAbs = path.join(uiDir, "_probe-turn-files-evidence.json");
const shotPreview = path.join(uiDir, "_probe-turn-files-shot-preview.png");

const CORE_PORT = Number(process.env.PROBE_TURN_FILES_CORE_PORT ?? 5198);
const CDP_PORT = Number(process.env.PROBE_TURN_FILES_CDP_PORT ?? 9368);
const TOKEN = process.env.PROBE_TURN_FILES_TOKEN ?? "probe-turn-files-token";

// 先删上一轮证据（live-smoke 同款纪律：防旧断言混入汇总）
try {
  fs.rmSync(evidencePathAbs, { force: true });
} catch {
  /* 忽略 */
}

/* ---------------------------------------------------------------------------
 * 合成会话夹具（与真实 pi 会话 jsonl 同构；entry 链必须线性——见 probe:tool-diff 头注）
 * ------------------------------------------------------------------------- */

const MARKER = "turn-files-探针会话";
const DEMO_REL = "src/demo.ts";
const NOTES_REL = "notes.md";
const GHOST_REL = "src/ghost.ts"; // 失败 edit：绝不允许出现在 chips 里
const DEMO_MARKER = "turn-files-demo-marker";
const NOTES_MARKER = "turn-files-notes-marker";

const T0 = Date.UTC(2026, 10, 1, 10, 0, 0);
const ts = (i) => new Date(T0 + i * 60_000).toISOString();
const base = (id, parentId, i) => ({ id, parentId, timestamp: ts(i) });

function buildSessionEntries(cwd) {
  return [
    { type: "session", version: 3, id: "probe-turnfiles-session", timestamp: ts(0), cwd },
    { ...base("e1", null, 1), type: "message", message: { role: "user", content: [{ type: "text", text: MARKER }] } },
    {
      ...base("e2", "e1", 2),
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t-edit", name: "edit", arguments: { path: DEMO_REL, edits: [{ oldText: "b = old", newText: "b = new" }] } }],
      },
    },
    {
      ...base("e3", "e2", 3),
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "t-edit",
        toolName: "edit",
        content: [{ type: "text", text: `Successfully replaced 1 block(s) in ${DEMO_REL}.` }],
        isError: false,
        timestamp: Date.now(),
      },
    },
    {
      ...base("e4", "e3", 4),
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t-write", name: "write", arguments: { path: NOTES_REL, content: `# notes\n\n${NOTES_MARKER}\n` } }],
      },
    },
    {
      ...base("e5", "e4", 5),
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "t-write",
        toolName: "write",
        content: [{ type: "text", text: `Successfully wrote to ${NOTES_REL}` }],
        isError: false,
        timestamp: Date.now(),
      },
    },
    {
      ...base("e6", "e5", 6),
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: "t-bash", name: "bash", arguments: { command: "echo hi" } }] },
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
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t-fail", name: "edit", arguments: { path: GHOST_REL, edits: [{ oldText: "x", newText: "y" }] } }],
      },
    },
    {
      ...base("e9", "e8", 9),
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "t-fail",
        toolName: "edit",
        content: [{ type: "text", text: `文件不存在：${GHOST_REL}` }],
        isError: true,
        timestamp: Date.now(),
      },
    },
    {
      ...base("e10", "e9", 10),
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "两个文件都改好了。" }] },
    },
  ];
}

console.log(`[probe-turn-files] 起 core（端口 ${CORE_PORT}，合成会话、无模型调用）…`);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-turnfiles-"));
const agentDir = path.join(tmpRoot, "agentdir");
const cwd = path.join(tmpRoot, "project");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));
seedModelsJson(agentDir);

// chips 点击要走真 /fs/read：demo.ts（ts 源码路径）与 notes.md（md 效果路径）必须真实存在
fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
fs.writeFileSync(
  path.join(cwd, "src", "demo.ts"),
  `const demoMarker = "${DEMO_MARKER}";\nexport const answer = 42;\n`,
);
fs.writeFileSync(path.join(cwd, NOTES_REL), `# notes\n\n${NOTES_MARKER}\n\n- a\n- b\n`);

// 合成会话写进 pi 会话档位目录（slug 算法照抄 pi session-manager.ts:503）
const slug = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const sessionDir = path.join(agentDir, "sessions", slug);
fs.mkdirSync(sessionDir, { recursive: true });
const sessionFile = path.join(sessionDir, "2026-11-01T10-00-00-000Z_probe-turnfiles.jsonl");
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

/** chips 查找/点击工具（evaluate 内执行；一律 el.click()，cua 坐标不可靠） */
const HELPERS = `
window.__TF = {
  chips() {
    return [...document.querySelectorAll('[data-testid="turn-file-chip"]')];
  },
  chipByTool(tool) {
    return this.chips().find((n) => n.getAttribute('data-tool') === tool) ?? null;
  },
  clickChip(tool) {
    const el = this.chipByTool(tool);
    if (!el) return false;
    el.click();
    return true;
  },
  paneCollapsed() {
    return document.querySelector('[data-testid="preview-pane"]')?.getAttribute('data-collapsed') ?? null;
  },
  fileName() {
    return (document.querySelector('[data-testid="preview-file-name"]')?.textContent ?? '').trim();
  },
  fileSourceText() {
    return (document.querySelector('[data-testid="preview-file-source"]')?.textContent ?? '');
  },
  fileEffectText() {
    return (document.querySelector('[data-testid="preview-file-effect"]')?.textContent ?? '');
  },
  closePreview() {
    const el = document.querySelector('[data-testid="preview-file-close"]');
    if (!el) return false;
    el.click();
    return true;
  },
  expandProcess() {
    const el = document.querySelector('[data-testid="process-details"]');
    if (!el) return false;
    if (el.getAttribute('data-expanded') !== 'true') el.click();
    return true;
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
        console.error(`[probe-turn-files] 断言异常 ${name}:`, e.message);
        fails.push(name);
      }
    };

    phase = "打开页面";
    await ctx.open(`/?live=1&token=${TOKEN}`);

    phase = "F0 侧栏定位合成会话并加载";
    await cdp.eval(HELPERS);
    const appeared = await waitForSelector(cdp, '[data-testid^="sidebar-history-item-"]', 15000);
    A("F0 侧栏历史项出现", appeared === true);
    const clicked = await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('[data-testid^="sidebar-history-item-"]')];
      const el = items.find((n) => (n.getAttribute('title') || '').includes(${JSON.stringify(MARKER)}));
      if (!el) return false;
      el.click();
      return true;
    })()`);
    A("F0 合成会话可点击", clicked === true);
    // 等消息树渲染出尾条（chips 的宿主）
    await waitForSelector(cdp, '[data-testid="message-list"]', 8000);

    phase = "F1 折叠态 chips 可见（关键判据：处理详情默认收起）";
    const chipsUp = await waitForSelector(cdp, '[data-testid="turn-file-chips"]', 8000);
    const chipsMeta = await cdp.eval(
      `(() => {
        const rows = [...document.querySelectorAll('[data-testid="turn-file-chips"]')];
        const collapse = document.querySelector('[data-testid="process-details"]');
        return {
          rows: rows.length,
          collapsedChipsUp: collapse !== null && collapse.getAttribute('data-expanded') !== 'true' && rows.length > 0,
        };
      })()`,
      true,
    );
    ctx.record("F1 折叠态 chips", chipsMeta);
    A("F1 chips 行渲染", chipsUp === true && chipsMeta.rows === 1);
    A("F1 处理详情收起态下 chips 可见", chipsMeta.collapsedChipsUp === true);

    phase = "F2 收录口径";
    const chipFacts = await cdp.eval(
      `(() => {
        const chips = window.__TF.chips();
        return {
          total: chips.length,
          tools: chips.map((n) => n.getAttribute('data-tool')),
          paths: chips.map((n) => n.getAttribute('data-path')),
          hasGhost: chips.some((n) => (n.getAttribute('data-path') || '').includes('ghost')),
          texts: chips.map((n) => (n.textContent || '').trim()),
          titles: chips.map((n) => n.getAttribute('title') ?? ''),
        };
      })()`,
      true,
    );
    ctx.record("F2 chips 事实", chipFacts);
    A("F2 chip 数 = 2（bash/失败 edit 不计）", chipFacts.total === 2);
    A("F2 无失败文件 ghost chip", chipFacts.hasGhost === false);
    A("F2 无 bash 路径混入", chipFacts.paths.every((p) => typeof p === "string" && p !== "") === true);

    phase = "F3 首触顺序 + 相对路径";
    A("F3 顺序 edit→write", chipFacts.tools[0] === "edit" && chipFacts.tools[1] === "write");
    A("F3 edit data-path = 相对 display", chipFacts.paths[0] === DEMO_REL);
    A("F3 write data-path = 相对 display", chipFacts.paths[1] === NOTES_REL);

    phase = "F4 chip 主文本 = basename";
    A("F4 edit 文本含 demo.ts", String(chipFacts.texts[0] ?? "").includes("demo.ts") === true);
    A("F4 write 文本含 notes.md", String(chipFacts.texts[1] ?? "").includes("notes.md") === true);

    phase = "F5 工具徽标（D2=B）";
    A("F5 edit chip 徽标「修改」", String(chipFacts.texts[0] ?? "").includes("修改") === true);
    A("F5 write chip 徽标「写入」", String(chipFacts.texts[1] ?? "").includes("写入") === true);

    phase = "F6 tooltip（诚实口径）";
    A(
      "F6 write title 含「新建或覆盖」",
      String(chipFacts.titles[1] ?? "").includes("新建或覆盖") === true && String(chipFacts.titles[1] ?? "").includes(NOTES_REL) === true,
    );
    A("F6 edit title = 修改 · 相对路径", String(chipFacts.titles[0] ?? "") === `修改 · ${DEMO_REL}`);

    phase = "F7 点击 edit chip → 右侧预览（ts 源码路径）";
    A("F7 edit chip 可点", (await cdp.eval(`window.__TF.clickChip('edit')`, true)) === true);
    await waitForSelector(cdp, '[data-testid="preview-file-source"]', 10000);
    const editPreview = await cdp.eval(
      `(() => ({
        collapsed: window.__TF.paneCollapsed(),
        bar: document.querySelector('[data-testid="preview-file-bar"]') !== null,
        name: window.__TF.fileName(),
        sourceHasMarker: window.__TF.fileSourceText().includes('${DEMO_MARKER}'),
      }))()`,
      true,
    );
    ctx.record("F7 edit 预览", editPreview);
    A("F7 预览区展开", editPreview.collapsed === "false");
    A("F7 文件名条出现", editPreview.bar === true);
    A("F7 文件名 = demo.ts", editPreview.name === "demo.ts");
    A("F7 源码内容命中（真 /fs/read）", editPreview.sourceHasMarker === true);
    await ctx.cdp.screenshot(shotPreview);

    phase = "F8 关闭再点 write chip（md 效果 Tab 路径）";
    A("F8 关闭可点", (await cdp.eval(`window.__TF.closePreview()`, true)) === true);
    await sleep(400); // 关闭 = 清选择 + 收起（PreviewPane 既有口径）
    const collapsedAfterClose = await cdp.eval(`window.__TF.paneCollapsed()`, true);
    A("F8 关闭后预览区收起", collapsedAfterClose === "true");
    A("F8 write chip 可点", (await cdp.eval(`window.__TF.clickChip('write')`, true)) === true);
    await waitForSelector(cdp, '[data-testid="preview-file-effect"]', 10000);
    const writePreview = await cdp.eval(
      `(() => ({
        collapsed: window.__TF.paneCollapsed(),
        name: window.__TF.fileName(),
        effectHasMarker: window.__TF.fileEffectText().includes('${NOTES_MARKER}'),
      }))()`,
      true,
    );
    ctx.record("F8 write 预览", writePreview);
    A("F8 再开预览区展开", writePreview.collapsed === "false");
    A("F8 文件名 = notes.md", writePreview.name === "notes.md");
    A("F8 md 走效果 Tab 内容命中", writePreview.effectHasMarker === true);
    A("F8 收起预览区（还原现场）", (await cdp.eval(`window.__TF.closePreview()`, true)) === true);
    await sleep(400);

    phase = "F9 展开处理详情后 chips 仍在";
    A("F9 处理详情可展开", (await cdp.eval(`window.__TF.expandProcess()`, true)) === true);
    await sleep(300);
    const chipsAfterExpand = await cdp.eval(
      `(() => ({ chips: window.__TF.chips().length }))()`,
      true,
    );
    ctx.record("F9 展开后 chips", chipsAfterExpand);
    A("F9 展开后 chips 仍为 2", chipsAfterExpand.chips === 2);

    // 证据落盘（probe-image-preview 同款：不 save 不出 JSON，断言只在 stdout）
    ctx.save(evidencePathAbs);
  });

  exitCode = fails.length === 0 ? 0 : 1;
} catch (e) {
  console.error(`[probe-turn-files] 异常（阶段：${phase}）：`, e.message);
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

console.log(fails.length === 0 ? "\n回复文件 chips 探针全部通过" : `\n探针失败 ${fails.length} 项：\n - ${fails.join("\n - ")}`);
process.exit(exitCode);
