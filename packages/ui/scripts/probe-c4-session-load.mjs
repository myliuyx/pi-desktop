/**
 * C4 UI 探针 —— 「会话列表与加载」在**真实浏览器 + 真实 core** 下的闭环。
 *
 * 为什么还要一个 UI 探针（core 侧已有 `check:c4`）：规格书 §2.3 判据第 4 条要求
 * **加载回来的消息在 UI 里真的渲染出来**。core 的 25 条断言只能证明端点返回了正确的
 * `Message[]`，证明不了 Sidebar 用的是真实清单、也证明不了点击历史项会把消息填进 store/DOM。
 *
 * 流程（全部真实，不打桩）：
 *   起 core（临时 agentDir + 临时 cwd）→ `POST /prompt` 跑一轮真实会话（只有跑到第一
 *   条 entry 落盘，Pi 才会写会话文件）→ 轮询 `GET /sessions` 直到清单 ≥1 →
 *   CDP 打开 `/?live=1&token=…`（core 同源托管 ui/dist）→
 *   ① 断言 Sidebar 渲染的是**真实清单**（标题含探针标记、且 mock 的 7 条演示会话一条不见）；
 *   ② 点第一条历史项 → 断言 store 消息换成 core 的会话（`liveSessionId` 命中、消息数 ≥1、
 *      `tokenUsage.contextWindow` 来自 core）且 **DOM 真渲染出 ≥1 条 message-item**。
 *
 * 运行前置：`packages/ui` 下先 `npm run build`（core 托管的是 dist，不是源码）。
 * 用法：`node scripts/probe-c4-session-load.mjs`
 * 证据：`packages/ui/_probe-c4-evidence.json`；失败非 0 退出。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser, sleep } from "./cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(here, "..");
const coreDir = path.join(uiDir, "..", "core");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
/** ⚠️ 必须绝对路径：本脚本把 core 的 cwd 指到临时项目目录，相对路径会解析到临时目录下（首跑实踩） */
const mainPath = path.join(coreDir, "src", "main.ts");
const envLocal = path.resolve(coreDir, "..", "..", "pi", "_poc", ".env.local");
const modelsSrc = path.resolve(coreDir, "..", "..", "pi", "_poc", "models.json");
const evidencePath = path.join(uiDir, "_probe-c4-evidence.json");

const CORE_PORT = Number(process.env.PROBE_C4_CORE_PORT ?? 5194);
const CDP_PORT = Number(process.env.PROBE_C4_CDP_PORT ?? 9354);
const TOKEN = process.env.PROBE_C4_TOKEN ?? "probe-c4-token";
/** 探针标记：用来把「真实会话」与 mock 的 7 条演示会话区分开 */
const MARKER = process.env.PROBE_C4_MARKER ?? "C4-UI-探针";
const PROMPT = `这是${MARKER}：只回复两个字「收到」，不要调用任何工具。`;
const HARD_MS = Number(process.env.PROBE_C4_HARD_MS ?? 240_000);

/** mock 侧独有的演示会话标题（真实清单里绝不该出现）—— 取一条最典型的即可 */
const MOCK_ONLY_TITLE = "重构执行计划卡片";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-c4-"));
const agentDir = path.join(tmpRoot, "agentdir");
const cwd = path.join(tmpRoot, "project");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
// 无项目本地资源 ⇒ 不触发信任门（本探针只验会话链路）
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));
// 模型清单用仓库里那份（只有 ark-coding 有凭证）—— 探针只需要模型能跑一轮
const modelsPath = path.join(tmpRoot, "models.json");
fs.copyFileSync(modelsSrc, modelsPath);

function request(method, p, body) {
	return new Promise((resolve, reject) => {
		const headers = { Authorization: `Bearer ${TOKEN}` };
		let payload;
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			payload = JSON.stringify(body);
		}
		const req = http.request(
			{ host: "127.0.0.1", port: CORE_PORT, path: p, method, headers, timeout: 20_000 },
			(res) => {
				let d = "";
				res.on("data", (c) => (d += c));
				res.on("end", () => {
					let json = null;
					try {
						json = JSON.parse(d);
					} catch {
						/* 非 JSON */
					}
					resolve({ status: res.statusCode, json, raw: d });
				});
			},
		);
		req.on("error", reject);
		req.on("timeout", () => req.destroy(new Error("timeout")));
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

async function waitForHealth(timeoutMs = 60_000) {
	const t0 = Date.now();
	for (;;) {
		try {
			const r = await request("GET", "/health");
			if (r.status === 200 && r.json?.extensions !== null) return r.json;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() - t0 > timeoutMs) return null;
		await sleep(300);
	}
}

const logFd = fs.openSync(path.join(coreDir, "run", "probe-c4-core.log"), "w");
const child = spawn(process.execPath, ["--env-file=" + envLocal, tsxPath, mainPath], {
	cwd,
	env: {
		...process.env,
		CORE_TOKEN: TOKEN,
		CORE_PORT: String(CORE_PORT),
		CORE_MODELS_PATH: modelsPath,
		CORE_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "ignore", logFd],
});

let exitCode = 1;
let phase = "启动 core";
let summary = null;
try {
	phase = "等待 core 就绪";
	const health = await waitForHealth();
	if (!health) throw new Error(`core 未就绪（端口 ${CORE_PORT}）`);

	phase = "跑一轮真实会话（真实模型，约 10~60s）";
	console.log(`[probe-c4] 发送真实 prompt …（${PROMPT.slice(0, 20)}…）`);
	const promptRes = await request("POST", "/prompt", { text: PROMPT });
	if (promptRes.status !== 200) throw new Error(`POST /prompt -> ${promptRes.status}`);

	phase = "轮询会话清单";
	const t0 = Date.now();
	let sessions = [];
	while (Date.now() - t0 < HARD_MS) {
		const r = await request("GET", "/sessions");
		sessions = r.json?.sessions ?? [];
		if (sessions.some((s) => s.messageCount >= 1)) break;
		await sleep(600);
	}
	if (!sessions.some((s) => s.messageCount >= 1)) throw new Error("轮询超时：会话清单里始终没有 messageCount ≥1 的会话");
	const target = sessions.find((s) => s.messageCount >= 1) ?? sessions[0];
	console.log(`[probe-c4] 清单 ${sessions.length} 条；目标会话 ${target.id}`);

	phase = "CDP 驱动浏览器";
	await withBrowser({ port: CDP_PORT, origin: `http://127.0.0.1:${CORE_PORT}`, evidencePath }, async (ctx) => {
		const { cdp } = ctx;
		const A = (name, detail) => {
			try {
				if (!ctx.assert(name, detail)) summary = summary ?? {};
			} catch (e) {
				ctx.record(`${name}（断言登记异常）`, String(e));
			}
		};

		// 等 Sidebar 拿到真实清单（refreshSessions 是异步的）
		phase = "打开 live 页面并等待真实清单";
		await ctx.open(`/?live=1&token=${TOKEN}`);
		await sleep(400);
		const storeReady = await cdp.eval(
			`(() => { const s = window.__chatStore; return !!(s && s.getState && typeof s.getState().refreshSessions === 'function'); })()`,
		);
		const waited = await cdp.eval(
			`new Promise((r) => {
			   const t0 = Date.now();
			   const iv = setInterval(() => {
			     const n = window.__chatStore.getState().sessionSummaries.length;
			     if (n >= 1) { clearInterval(iv); r(n); }
			     else if (Date.now() - t0 > 20000) { clearInterval(iv); r(0); }
			   }, 100);
			 })`,
			true,
		);
		ctx.record("store 已挂载 / 等待到的清单条数", { storeReady, waited });

		const sidebar = await cdp.eval(`(() => {
		  const items = [...document.querySelectorAll('[data-testid^="sidebar-history-item-"]')];
		  return items.map((el) => ({ id: el.getAttribute('data-testid'), title: el.getAttribute('title'), text: (el.innerText || '').trim() }));
		})()`);
		const storeSummaries = await cdp.eval(
			`window.__chatStore.getState().sessionSummaries.map((s) => ({ id: s.id, title: s.title, messageCount: s.messageCount, updatedAtType: typeof s.updatedAt }))`,
		);
		ctx.record("Sidebar 历史项 / store 清单", { sidebar, storeSummaries });

		A("C4[列表] live Sidebar 用真实清单（≥1 条，标题含探针标记）", {
			条数至少1: sidebar.length >= 1,
			首项标题含标记: sidebar.some((s) => (s.title ?? "").includes(MARKER)),
			store清单非空: storeSummaries.length >= 1,
			store与DOM条数一致: storeSummaries.length === sidebar.length,
			updatedAt是数字: storeSummaries.every((s) => s.updatedAtType === "number"),
		});
		A("C4[列表] mock 的演示会话未混入真实清单（只能来自 core）", {
			无mock标题: !sidebar.some((s) => (s.title ?? "").includes(MOCK_ONLY_TITLE)),
			无mock条数7: storeSummaries.length !== 7 || !storeSummaries.some((s) => s.id.startsWith("session-demo-")),
			id来自core: storeSummaries.some((s) => s.id === target.id),
		});

		// 点击第一条历史项 → 触发 loadSessionById → chat-store.loadSession 内部走 transport
		phase = "点击历史项加载真实会话";
		const clicked = await cdp.eval(`(() => {
		  const items = [...document.querySelectorAll('[data-testid^="sidebar-history-item-"]')];
		  const el = items.find((n) => (n.getAttribute('title') || '').includes(${JSON.stringify(MARKER)})) ?? items[0];
		  if (!el) return false;
		  el.click();
		  return true;
		})()`);
		A("C4[加载] 侧边栏历史项可点击", { 已点击: clicked === true });

		// 等 store 消息被 core 的会话替换（liveSessionId 命中 + 消息 ≥1）
		const loadedCount = await cdp.eval(
			`new Promise((r) => {
			   const t0 = Date.now();
			   const iv = setInterval(() => {
			     const st = window.__chatStore.getState();
			     if (st.liveSessionId && st.messages.length >= 1) { clearInterval(iv); r(st.messages.length); }
			     else if (Date.now() - t0 > 20000) { clearInterval(iv); r(-1); }
			   }, 100);
			 })`,
			true,
		);

		const after = await cdp.eval(`(() => {
		  const st = window.__chatStore.getState();
		  const items = [...document.querySelectorAll('[data-testid="message-item"]')].map((el) => ({
		    id: el.getAttribute('data-message-id'), role: el.getAttribute('data-role'), text: (el.innerText || '').trim(),
		  }));
		  const list = document.querySelector('[data-testid="message-list"]');
		  return {
		    storeCount: st.messages.length,
		    liveSessionId: st.liveSessionId,
		    streaming: st.streaming,
		    tokenUsage: st.tokenUsage,
		    sessionTitle: st.sessionTitle,
		    roles: st.messages.map((m) => m.role),
		    storeTexts: st.messages.flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.content)),
		    domItems: items,
		    listTotal: list ? list.getAttribute('data-total-count') : null,
		  };
		})()`);
		ctx.record("加载后的 store / DOM 快照", {
			...after,
			storeTexts: after.storeTexts.map((t) => t.slice(0, 60)),
			domItems: after.domItems.map((it) => ({ ...it, text: it.text.slice(0, 60) })),
		});

		const domUser = after.domItems.filter((it) => it.role === "user");
		const domJoined = after.domItems.map((it) => it.text).join("\n");
		const storeJoined = after.storeTexts.join("\n");

		A("C4[加载] store 换成 core 的会话（id 命中 / 消息 ≥1 / 非流式）", {
			等待到消息: loadedCount >= 1,
			liveSessionId命中: after.liveSessionId === target.id,
			消息数至少1: after.storeCount >= 1,
			streaming已解除: after.streaming === false,
		});
		A("C4[加载] 消息内容来自会话文件（能读回探针 prompt 原文）", {
			store含探针原文: storeJoined.includes(MARKER),
			含user消息: after.roles.includes("user"),
			含assistant消息: after.roles.includes("assistant"),
		});
		A("C4[加载] tokenUsage 来自 core（contextWindow > 0）", {
			contextWindow为正: typeof after.tokenUsage?.contextWindow === "number" && after.tokenUsage.contextWindow > 0,
			total非负: typeof after.tokenUsage?.total === "number" && after.tokenUsage.total >= 0,
		});
		A("C4[加载] **DOM 真渲染出消息**（≥1 条 message-item，且 user 气泡含探针原文）", {
			DOM条目至少1: after.domItems.length >= 1,
			DOM与store条数一致: String(after.listTotal) === String(after.storeCount) && after.domItems.length === after.storeCount,
			存在user气泡: domUser.length >= 1,
			DOM含探针原文: domJoined.includes(MARKER),
		});

		summary = ctx.save(evidencePath);
	});

	exitCode = summary && summary.failed === 0 ? 0 : 1;
} catch (e) {
	console.error(`[probe-c4] 异常（阶段：${phase}）：`, e.message);
	fs.writeFileSync(
		evidencePath,
		JSON.stringify({ origin: `http://127.0.0.1:${CORE_PORT}`, failedAtPhase: phase, error: e.message }, null, 2),
	);
	exitCode = 1;
} finally {
	try {
		child.kill("SIGTERM");
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

console.log(
	exitCode === 0
		? `\nC4 UI 探针全部通过（${summary?.passed}/${summary?.assertions}）`
		: `\nC4 UI 探针失败：${summary?.failedNames?.join("; ") ?? "见证据文件"}`,
);
process.exit(exitCode);
