/**
 * 授权体验探针 —— 「input 型授权卡 + 旧式 select 卡回归」在真实浏览器里的行为。
 * （验收方独立编写，规格书 .plan/task-auth-polish.md §四）
 *
 * 为什么单独一个探针：`check:adapter` 只能证明契约字段（method/placeholder）透传到
 * Block，证明不了「输入框真的能打字提交、空文本禁提交、Enter 可达、已决后禁用、
 * 与 options 按钮互斥」这些 DOM 行为；也锁不住「method 缺省走旧渲染」这条硬约束。
 *
 * 手法（照 probe-c3 / probe-c4 范式）：脚本**自己起** mock 形态的 vite dev server
 * （不起 core、不烧模型），CDP 连系统 Chrome，用 `window.__chatStore.loadSession`
 * 直接构造三张授权卡：
 *   ① method:"input" 卡（点「提交」按钮路径）
 *   ② method:"input" 卡（Enter 键路径）
 *   ③ method 缺省 + options 的旧式卡（回归锁定）
 *
 * 运行前置：无（dev server 由本脚本拉起，端口 5195，占用时换 PROBE_AUTH_PORT）。
 * 用法：`node scripts/probe-auth-input.mjs`
 * 证据：`_probe-auth-evidence.json`；失败非 0 退出。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser, sleep, SET_TEXT_HELPER } from "./cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(here, "..");
const vitePath = path.join(uiDir, "node_modules", "vite", "bin", "vite.js");
const evidencePath = path.join(uiDir, "_probe-auth-evidence.json");
const devLogFd = fs.openSync(path.join(uiDir, "run", "probe-auth-dev.log"), "w");

const ORIGIN = process.env.PROBE_AUTH_ORIGIN ?? "http://127.0.0.1:5195";
const CDP_PORT = Number(process.env.PROBE_AUTH_CDP_PORT ?? 9356);
const PORT = Number(new URL(ORIGIN).port);

const PLACEHOLDER = "请输入审批口令";
const SECRET_A = "口令OVERRIDE-777"; // ① 点按钮路径
const SECRET_B = "口令ENTER-42"; // ② Enter 路径

/** 等 dev server 就绪（实现方首跑曾因未就绪连 CDP 失败，这里显式轮询 HTTP 200） */
async function waitForDevServer(timeoutMs = 90_000) {
	const t0 = Date.now();
	for (;;) {
		try {
			const r = await fetch(`${ORIGIN}/`);
			if (r.ok) return true;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() - t0 > timeoutMs) return false;
		await sleep(400);
	}
}

const devServer = spawn(process.execPath, [vitePath, "--port", String(PORT), "--strictPort"], {
	cwd: uiDir,
	env: { ...process.env, BROWSER: "none" },
	stdio: ["ignore", devLogFd, devLogFd],
});

let exitCode = 1;
let phase = "启动 dev server";
let summary = null;
try {
	phase = "等待 dev server 就绪";
	if (!(await waitForDevServer())) throw new Error(`dev server 未就绪（${ORIGIN}），日志见 packages/ui/run/probe-auth-dev.log`);
	console.log(`[probe-auth] dev server 就绪：${ORIGIN}`);

	/** 按序号取第 n 张授权卡的容器级快照（断言取样全部限定在卡片容器内，不跨卡串味） */
	const CARD_SNAP = (n) => `(() => {
	  const card = [...document.querySelectorAll('[data-testid="approval-card"]')][${n}];
	  if (!card) return null;
	  const input = card.querySelector('[data-testid="approval-input"]');
	  const submit = card.querySelector('[data-testid="approval-input-submit"]');
	  const options = [...card.querySelectorAll('[data-testid^="approval-option-"]')];
	  return {
	    resolved: card.dataset.resolved,
	    expired: card.dataset.expired,
	    innerText: card.innerText,
	    input: input ? { value: input.value, disabled: input.disabled, placeholder: input.getAttribute("placeholder") } : null,
	    submit: submit ? { text: submit.innerText.trim(), disabled: submit.disabled } : null,
	    optionTestids: options.map((b) => b.getAttribute("data-testid")),
	    optionDisabled: options.map((b) => b.disabled),
	  };
	})()`;

	const storeApprovals = `(() => {
	  const st = window.__chatStore.getState();
	  return st.messages.flatMap((m) => m.blocks).filter((b) => b.type === "approval")
	    .map((b) => ({ requestId: b.requestId, method: b.method, placeholder: b.placeholder, options: b.options, resolved: b.resolved ?? "" }));
	})()`;

	/** 三张卡的构造（照 probe-c3：loadSession 直接注入 mock 会话） */
	const SEED = `(() => {
	  const now = Date.now();
	  const msg = (id, blocks) => ({ id: 'm-' + id, role: 'assistant', timestamp: now, blocks });
	  window.__chatStore.getState().loadSession({
	    id: 'auth-probe', title: '授权体验探针', updatedAt: now,
	    messages: [
	      msg('input-a', [{ type: 'approval', requestId: 'probe-input-a', title: '口令卡A（点提交）',
	                        method: 'input', placeholder: ${JSON.stringify(PLACEHOLDER)}, options: [] }]),
	      msg('input-b', [{ type: 'approval', requestId: 'probe-input-b', title: '口令卡B（Enter）',
	                        method: 'input', placeholder: ${JSON.stringify(PLACEHOLDER)}, options: [] }]),
	      msg('legacy',  [{ type: 'approval', requestId: 'probe-legacy', title: '旧式卡（method 缺省）',
	                        options: ['允许', '拒绝'] }]),
	    ],
	  });
	  return window.__chatStore.getState().messages.length;
	})()`;

	await withBrowser({ port: CDP_PORT, origin: ORIGIN, evidencePath }, async (ctx) => {
		const { cdp } = ctx;

		phase = "注入三张授权卡";
		await ctx.open("/");
		await ctx.sleep(600);
		const seeded = await cdp.eval(SEED);
		await sleep(400);
		ctx.record("注入后 store 消息数（应 3）", seeded);
		if (seeded !== 3) throw new Error(`loadSession 注入异常：messages=${seeded}`);

		/* ---------- ① input 卡初始态：互斥 + placeholder + 空文本禁提交 ---------- */
		phase = "断言 input 卡初始态";
		const a0 = await cdp.eval(CARD_SNAP(0));
		const b0 = await cdp.eval(CARD_SNAP(1));
		const legacy0 = await cdp.eval(CARD_SNAP(2));
		ctx.record("初始快照（input A / input B / legacy）", { a0, b0, legacy0 });

		ctx.assert("AUTH[input] 卡片存在且与 options 按钮互斥（不出 approval-option-*）", {
			input卡渲染出输入框: !!a0?.input && !!b0?.input,
			input卡不渲染options按钮A: Array.isArray(a0?.optionTestids) && a0.optionTestids.length === 0,
			input卡不渲染options按钮B: Array.isArray(b0?.optionTestids) && b0.optionTestids.length === 0,
			提交按钮存在且文案为提交: a0?.submit?.text === "提交" && b0?.submit?.text === "提交",
		});
		ctx.assert("AUTH[input] placeholder 正确下发", {
			卡A占位符: a0?.input?.placeholder === PLACEHOLDER,
			卡B占位符: b0?.input?.placeholder === PLACEHOLDER,
		});
		ctx.assert("AUTH[input] 空文本时提交按钮 disabled（未决初始态）", {
			卡A提交禁用: a0?.submit?.disabled === true,
			卡B提交禁用: b0?.submit?.disabled === true,
			卡A输入框可用: a0?.input?.disabled === false,
			卡A未决: a0?.resolved === "false" && a0?.expired === "false",
		});

		/* ---------- ② 输入文本 → 点「提交」→ resolved 写回 + 已决禁用 ---------- */
		phase = "卡 A：输入并点击提交";
		await cdp.eval(
			`${SET_TEXT_HELPER}
			 (() => {
			   const card = [...document.querySelectorAll('[data-testid="approval-card"]')][0];
			   const input = card.querySelector('[data-testid="approval-input"]');
			   input.focus();
			   setNativeValue(input, ${JSON.stringify(SECRET_A)});
			   return input.value;
			 })()`,
		);
		const a1 = await cdp.eval(CARD_SNAP(0));
		ctx.record("卡 A 输入后快照", a1);
		ctx.assert("AUTH[input] 输入文本后提交按钮可用（输入框可聚焦可输入）", {
			输入值生效: a1?.input?.value === SECRET_A,
			提交按钮解禁: a1?.submit?.disabled === false,
		});

		await cdp.eval(
			`(() => {
			   const card = [...document.querySelectorAll('[data-testid="approval-card"]')][0];
			   card.querySelector('[data-testid="approval-input-submit"]').click();
			   return true;
			 })()`,
		);
		await sleep(400);
		const a2 = await cdp.eval(CARD_SNAP(0));
		const store1 = await cdp.eval(storeApprovals);
		ctx.record("卡 A 点击提交后快照 / store", { a2, store1 });

		ctx.assert("AUTH[input] 点击提交后 resolved 写回 + 已提交文本 + 已决禁用", {
			dataResolved为true: a2?.resolved === "true",
			卡片显示已提交与原文: typeof a2?.innerText === "string" && a2.innerText.includes(`已提交：${SECRET_A}`),
			输入框已禁用: a2?.input?.disabled === true,
			提交按钮已禁用: a2?.submit?.disabled === true,
			store乐观写入: store1.some((b) => b.requestId === "probe-input-a" && b.resolved === SECRET_A),
		});

		/* ---------- ③ 已决后再提交无效（resolved 不被覆盖） ---------- */
		phase = "卡 A：已决后再次提交（应无效）";
		await cdp.eval(
			`(() => {
			   const card = [...document.querySelectorAll('[data-testid="approval-card"]')][0];
			   const input = card.querySelector('[data-testid="approval-input"]');
			   const submit = card.querySelector('[data-testid="approval-input-submit"]');
			   try { input.focus(); } catch {}
			   submit.click(); // disabled 按钮点击应被浏览器吞掉
			   return true;
			 })()`,
		);
		await sleep(300);
		const store2 = await cdp.eval(storeApprovals);
		ctx.record("已决后再提交的 store 快照", store2);
		ctx.assert("AUTH[input] 已决后再次提交不覆盖 resolved", {
			卡Aresolved保持原值: store2.some((b) => b.requestId === "probe-input-a" && b.resolved === SECRET_A),
			无其它卡被串写: store2.filter((b) => b.resolved !== "" && b.requestId !== "probe-input-a").length === 0,
		});

		/* ---------- ④ Enter 键提交路径（卡 B） ---------- */
		phase = "卡 B：输入后按 Enter 提交";
		const focused = await cdp.eval(
			`${SET_TEXT_HELPER}
			 (() => {
			   const card = [...document.querySelectorAll('[data-testid="approval-card"]')][1];
			   const input = card.querySelector('[data-testid="approval-input"]');
			   input.focus();
			   setNativeValue(input, ${JSON.stringify(SECRET_B)});
			   return { active: document.activeElement === input, value: input.value };
			 })()`,
		);
		ctx.record("卡 B 聚焦并输入", focused);
		await cdp.pressKey({ key: "Enter", code: "Enter", virtualKeyCode: 13 });
		await sleep(400);
		const b1 = await cdp.eval(CARD_SNAP(1));
		const store3 = await cdp.eval(storeApprovals);
		ctx.record("卡 B Enter 提交后快照 / store", { b1, store3 });

		ctx.assert("AUTH[input] Enter 键提交路径可用", {
			dataResolved为true: b1?.resolved === "true",
			卡片显示已提交与原文: typeof b1?.innerText === "string" && b1.innerText.includes(`已提交：${SECRET_B}`),
			输入框已禁用: b1?.input?.disabled === true,
			store乐观写入: store3.some((b) => b.requestId === "probe-input-b" && b.resolved === SECRET_B),
		});

		/* ---------- ⑤ 旧式卡回归：method 缺省走旧渲染 ---------- */
		phase = "旧式卡：点 approval-option-0";
		ctx.assert("AUTH[回归] method 缺省卡走旧渲染（options 按钮、无输入框）", {
			两个options按钮: legacy0?.optionTestids?.join(",") === "approval-option-0,approval-option-1",
			无输入框: legacy0?.input === null,
			无提交按钮: legacy0?.submit === null,
			按钮初始可点: legacy0?.optionDisabled?.every((d) => d === false) === true,
		});

		await cdp.eval(
			`(() => {
			   const card = [...document.querySelectorAll('[data-testid="approval-card"]')][2];
			   card.querySelector('[data-testid="approval-option-0"]').click();
			   return true;
			 })()`,
		);
		await sleep(400);
		const legacy1 = await cdp.eval(CARD_SNAP(2));
		const store4 = await cdp.eval(storeApprovals);
		ctx.record("旧式卡点击后快照 / store", { legacy1, store4 });

		ctx.assert("AUTH[回归] approval-option-0 可点且 resolved 乐观写入", {
			dataResolved为true: legacy1?.resolved === "true",
			显示已选择允许: typeof legacy1?.innerText === "string" && legacy1.innerText.includes("已选择：允许"),
			按钮全部置灰: legacy1?.optionDisabled?.every((d) => d === true) === true,
			store乐观写入: store4.some((b) => b.requestId === "probe-legacy" && b.resolved === "允许"),
		});

		summary = ctx.save(evidencePath);
	});

	exitCode = summary && summary.failed === 0 ? 0 : 1;
} catch (e) {
	console.error(`[probe-auth] 异常（阶段：${phase}）：`, e.message);
	try {
		fs.writeFileSync(
			evidencePath,
			JSON.stringify({ origin: ORIGIN, failedAtPhase: phase, error: e.message }, null, 2),
		);
	} catch {
		/* 忽略 */
	}
	exitCode = 1;
} finally {
	try {
		devServer.kill("SIGTERM");
	} catch {
		/* 已退出 */
	}
	fs.closeSync(devLogFd);
}

console.log(
	exitCode === 0
		? `\n授权体验探针全部通过（${summary?.passed}/${summary?.assertions}）`
		: `\n授权体验探针失败：${summary?.failedNames?.join("; ") ?? "见证据文件"}`,
);
process.exit(exitCode);
