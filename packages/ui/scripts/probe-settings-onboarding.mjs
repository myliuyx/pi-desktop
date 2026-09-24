/**
 * 引导链验收探针（probe:onboarding）—— 用户反馈批次 ①（2026-09-24）。
 *
 * 写作方：主控（非本批实现方）—— 流程铁律「验收脚本必须非实现方写」。
 *
 * 覆盖用户原话对应的三条判据：
 *   U1「我默认应该是启用才对」—— 新增 Provider 默认 `enabled`，且**存进 models.json**
 *      （不是被塞进 sidecar `models-disabled.json` 当软禁用）。
 *   U2「provider 禁用/启用的时候右边提示确认停用？这个不需要二次确认」——
 *      点开关**即时翻转**，且表单内**不存在**任何「确认停用 / 确认启用」按钮。
 *   U3（防回归）「删除」仍必须保留两步确认 —— 本轮只该删掉启用确认，不能连带删掉删除确认。
 *
 * 顺带覆盖上一轮的「空清单首启 + 首次配置自动选型」这条链（同样缺正式验收）：
 *   U0 空 models.json 启动：core 照常就绪、`/health.model === null`（不 exit(1) 死锁）。
 *   U4 保存后：响应 warning 提示「首次配置：已自动选中 …」，且 `/health.model` 变为可用模型
 *      （证明无模型启动的会话实例确实还能 setModel）。
 *
 * 批次 ②（2026-09-24）追加：
 *   U1b 未填 Base URL / API key ⇒ 保存被拦下、就地提示必填、且 **core 侧一字未写**。
 *   U8  模型选择菜单的分组标题是 **Provider 展示名**（不是 `provider-<数字>` 内部 key）。
 *   U9  `POST /providers/models` 真链路：起一个**本地 stub 上游**，验带 key 拉清单 / 去重保序 /
 *       错 key 与不可达都能定位（并直接断言 stub 收到的 Authorization 头）。
 *
 * ⚠️ 前置：`packages/ui` **必须已 build**（core 同源托管 `packages/ui/dist`）。
 *     夹具是**空** models.json（临时目录），绝不碰 `~/.pi/agent/models.json`。
 *
 * 端口：core 5360、CDP 9347、**stub 上游 5370**
 * （避开 probe:settings 9345 / probe:settings:live 9346）。
 * 证据：`packages/ui/_onboarding-evidence.json`
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser, sleep, SET_TEXT_HELPER } from "./cdp.mjs";
import { childEnv } from "../../core/scripts/lib/credentials.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const coreDir = path.join(repoRoot, "packages", "core");
const uiDist = path.join(repoRoot, "packages", "ui", "dist");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
const mainPath = path.join(coreDir, "src", "main.ts");

const PORT = 5360;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TOKEN = "onboarding-token";
const EVIDENCE = "_onboarding-evidence.json";

/* ---------------------------------------------------------------------------
 * 夹具：**空** models.json + 独立 agentDir（U0 的前提）
 * ------------------------------------------------------------------------- */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "onboarding-"));
const agentDir = path.join(tmpRoot, "agentdir");
fs.mkdirSync(agentDir, { recursive: true });
/* 2026-09-24：CORE_MODELS_PATH 覆盖口已删 —— 夹具清单只能落在 agentDir（Pi 的约定位置） */
const modelsPath = path.join(agentDir, "models.json");
const sidecarPath = path.join(agentDir, "models-disabled.json");
fs.writeFileSync(modelsPath, `${JSON.stringify({ providers: {} }, null, 2)}\n`);
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));

const readJson = (p) => {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return null;
	}
};
const fileProviderIds = () => Object.keys(readJson(modelsPath)?.providers ?? {});
const sidecarProviderIds = () => Object.keys(readJson(sidecarPath)?.providers ?? {});

/* ---------------------------------------------------------------------------
 * core 实例
 * ------------------------------------------------------------------------- */

function launchCore() {
	const logPath = path.join(repoRoot, "packages", "ui", "_onboarding-core.log");
	const logFd = fs.openSync(logPath, "w");
	const child = spawn(process.execPath, [tsxPath, mainPath], {
		cwd: coreDir,
		env: childEnv({
			CORE_TOKEN: TOKEN,
			CORE_PORT: String(PORT),
			CORE_AGENT_DIR: agentDir,
			CORE_UI_DIST: uiDist,
		}),
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
			fs.closeSync(logFd);
		},
	};
}

async function waitForHealth(timeoutMs = 90_000) {
	const t0 = Date.now();
	for (;;) {
		try {
			const res = await fetch(`${ORIGIN}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
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

async function api(p, init = {}) {
	const res = await fetch(`${ORIGIN}${p}`, {
		...init,
		headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
	});
	const json = await res.json().catch(() => null);
	return { status: res.status, json };
}

/* ---------------------------------------------------------------------------
 * 页面 helper
 * ------------------------------------------------------------------------- */

const HELPERS = `
window.__O = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  setAndDispatch: setNativeValue,
};
true;
`;

const OPEN_CHECK = `(() => {
  const d = window.__O.q('[role="dialog"]');
  return !!d && !d.hasAttribute('inert') && getComputedStyle(d).opacity === '1';
})()`;

async function openDialog(cdp) {
	await cdp.eval(`(() => { window.__O.q('[data-testid="sidebar-footer-settings"]').click(); return true; })()`);
	await sleep(600);
}

async function waitStatus(cdp, tones, timeout = 12_000) {
	const t0 = Date.now();
	for (;;) {
		const tone = await cdp.eval(`window.__O.q('[data-testid="settings-status"]')?.dataset.tone ?? null`);
		if (tones.includes(tone)) return tone;
		if (Date.now() - t0 > timeout) return tone ?? "timeout";
		await sleep(200);
	}
}

let failures = 0;
const exceptions = [];
/** U4 保存下来的 Provider id（U6 用它做「清空凭证」的边界验证） */
let savedProviderId = null;

/* ---------------------------------------------------------------------------
 * U9 用的 stub 上游：一个只认 `Bearer sk-probe-only` 的极小 /models 服务
 *
 * 为什么不直接打真实第三方：验收要**确定**（不依赖外网与配额），
 * 但拉的又必须是真链路（core 真的发 HTTP、真的带头、真的解析响应）。
 * stub 把这两点同时满足：断言里还能直接读它收到的 Authorization 头。
 * ------------------------------------------------------------------------- */

const STUB_PORT = 5370;
const stubHits = [];
const stub = http.createServer((req, res) => {
	stubHits.push({ url: req.url ?? null, auth: req.headers.authorization ?? null });
	if ((req.url ?? "").split("?")[0] !== "/v1/models") {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { message: "not found" } }));
		return;
	}
	if (req.headers.authorization !== "Bearer sk-probe-only") {
		res.writeHead(401, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { message: "stub api key required" } }));
		return;
	}
	res.writeHead(200, { "Content-Type": "application/json" });
	// 刻意给一条重复 id：验收「去重」，同时保住首次出现的位置（保序）
	res.end(
		JSON.stringify({
			object: "list",
			data: [{ id: "probe-alpha" }, { id: "probe-beta" }, { id: "probe-alpha" }],
		}),
	);
});

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */

console.log("[onboarding] 启动 core（空 models.json 夹具 + 同源托管 ui/dist）…");
if (!fs.existsSync(path.join(uiDist, "index.html"))) {
	console.error(`未找到 ${uiDist}\\index.html —— 请先在 packages/ui 下跑 npm run build`);
	process.exit(1);
}
await new Promise((resolve, reject) => {
	stub.once("error", reject);
	stub.listen(STUB_PORT, "127.0.0.1", resolve);
});
console.log(`[onboarding] stub 上游已就绪：http://127.0.0.1:${STUB_PORT}/v1/models`);
const core = launchCore();

try {
	const health0 = await waitForHealth();
	if (!health0) throw new Error("core 未就绪（/health 超时）");
	console.log(`[onboarding] core 就绪：${JSON.stringify(health0)}`);

	/* ============================================== U0 空清单首启不中断 */
	{
		const providersRes = (await api("/providers")).json;
		const snapshot = {
			core已就绪: health0.ok === true,
			health的model为null: health0.model === null,
			启动时清单为空: (providersRes?.providers ?? []).length === 0,
			ready标志: providersRes?.ready === true,
		};
		console.log("\n### U0_空清单首启");
		console.log(JSON.stringify(snapshot, null, 2));
		failures += ctxAssert("U0 空 models.json 时 core 照常就绪、无模型不中断（/health.model 为 null）", {
			core已就绪: snapshot.core已就绪,
			无模型不崩: snapshot.health的model为null,
			Provider清单为空: snapshot.启动时清单为空,
		});
	}

	await withBrowser({ port: 9347, origin: ORIGIN, evidencePath: EVIDENCE }, async (ctx) => {
		const { cdp } = ctx;
		await ctx.open("/?live=1");
		await cdp.eval(SET_TEXT_HELPER);
		await cdp.eval(HELPERS);

		cdp.ws.addEventListener("message", (ev) => {
			try {
				const msg = JSON.parse(ev.data);
				if (msg.method === "Runtime.exceptionThrown") {
					exceptions.push(msg.params?.exceptionDetails?.exception?.description ?? "unknown");
				}
			} catch {
				/* 忽略非 JSON */
			}
		});
		await cdp.send("Runtime.enable");

		/* ======================================= U1 新增 Provider 默认启用 */
		await openDialog(cdp);
		const emptyAtOpen = await cdp.eval(`window.__O.qa('[data-testid="provider-header"]').length`);
		await cdp.eval(`(() => { window.__O.q('[data-testid="add-provider"]').click(); return true; })()`);
		await sleep(500);
		{
			const r = await cdp.eval(`(() => {
				const headers = window.__O.qa('[data-testid="provider-header"]');
				const sw = window.__O.q('[data-testid="provider-enabled"]');
				const dot = headers[0] ? headers[0].querySelector('span[aria-hidden="true"]') : null;
				return {
					providerCount: headers.length,
					newProviderId: headers[0]?.dataset.providerId ?? null,
					switchExists: !!sw,
					switchEnabled: sw?.dataset.enabled ?? null,
					switchAriaChecked: sw?.getAttribute('aria-checked') ?? null,
					dotClass: dot ? dot.className : null,
					formShown: !!window.__O.q('[data-testid="provider-name"]'),
				};
			})()`);
			ctx.record("U1_新增Provider默认状态", { 打开时条目数: emptyAtOpen, ...r });
			failures +=
				ctx.assert("U1 新增 Provider 默认「启用」（开关 aria/data 双源一致，左栏状态点为 success）", {
					打开时无条目: emptyAtOpen === 0,
					新增后出现一条: r.providerCount === 1,
					开关存在: r.switchExists === true,
					data_enabled为true: r.switchEnabled === "true",
					aria_checked为true: r.switchAriaChecked === "true",
					左栏状态点为success: (r.dotClass ?? "").includes("bg-success"),
					表单已切到新Provider: r.formShown === true,
				})
					? 0
					: 1;
		}

		/* ================= U1b 未填 Base URL / API key ⇒ 保存被拦下且不写 core */
		/*
		 * 用户要求：「在添加 Provider 的时候不填写 apiKey 和 BaseUrl 不允许保存，直接给提示需要填写」。
		 * 判据两条腿：① 提示必须**直接**（状态条危险态 + 表单里就地红字，不能只靠会被 truncate 的一行）；
		 * ② 必须**真的没写**（core 侧 models.json 与本轮前逐字节一致）。
		 */
		{
			const fileBefore = fs.readFileSync(modelsPath, "utf8");
			await cdp.eval(`(() => { window.__O.q('[data-testid="settings-save"]').click(); return true; })()`);
			await sleep(700);
			const r = await cdp.eval(`(() => {
				const status = window.__O.q('[data-testid="settings-status"]');
				const errs = window.__O.qa('[data-testid="field-error"]').map(e => (e.textContent || '').trim());
				return {
					tone: status?.dataset.tone ?? null,
					text: (status?.textContent ?? '').trim(),
					title: status?.getAttribute('title') ?? null,
					stillOpen: ${OPEN_CHECK},
					rowCount: window.__O.qa('[data-testid="provider-header"]').length,
					fieldErrors: errs,
					baseUrlFieldShown: !!window.__O.q('[data-testid="provider-base-url"]'),
					apiKeyFieldShown: !!window.__O.q('[data-testid="provider-api-key"]'),
				};
			})()`);
			const fileAfter = fs.readFileSync(modelsPath, "utf8");
			const providersAfter = await api("/providers");
			const coreProviderCount = (providersAfter.json?.providers ?? []).length;

			ctx.record("U1b_未填拦截", {
				状态条: r.tone,
				状态文案: r.text,
				就地红字: r.fieldErrors,
				弹窗仍打开: r.stillOpen,
				左栏条目数: r.rowCount,
				表单已定位: r.baseUrlFieldShown && r.apiKeyFieldShown,
				core侧provider数: coreProviderCount,
				models_json未变动: fileAfter === fileBefore,
			});
			failures +=
				ctx.assert("U1b 未填 Base URL / API key ⇒ 保存被拦下、就地提示必填、且 core 侧一字未写", {
					状态条为危险态: r.tone === "danger",
					文案是明确拒绝: r.text.includes("无法保存"),
					文案点名缺什么: r.text.includes("Base URL") && r.text.includes("API key"),
					文案点名是哪个Provider: r.text.includes("新 Provider"),
					文案提到可停用跳过: r.text.includes("停用"),
					悬停可见全文: r.title === r.text,
					弹窗未关闭: r.stillOpen === true,
					草稿未丢: r.rowCount === 1,
					就地红字两处: r.fieldErrors.length === 2,
					就地红字写明必填: r.fieldErrors.every((t) => t.includes("必填")),
					已定位到出问题的表单: r.baseUrlFieldShown === true && r.apiKeyFieldShown === true,
					core侧没有写入: coreProviderCount === 0,
					models_json逐字节未变: fileAfter === fileBefore,
				})
					? 0
					: 1;
		}

		/* ================================= U2 启用开关即时翻转、无二次确认 */
		{
			const before = await cdp.eval(`window.__O.q('[data-testid="provider-enabled"]').dataset.enabled`);
			await cdp.eval(`(() => { window.__O.q('[data-testid="provider-enabled"]').click(); return true; })()`);
			await sleep(300);
			const afterOff = await cdp.eval(`(() => {
				const pane = window.__O.q('[data-testid="model-form-pane"]');
				const texts = [...pane.querySelectorAll('button')].map(b => (b.textContent || '').trim());
				return {
					enabled: window.__O.q('[data-testid="provider-enabled"]').dataset.enabled,
					confirmTestId: !!pane.querySelector('[data-testid*="enable-confirm"]'),
					confirmWords: texts.filter(t => /确认(停用|启用|禁用)/.test(t)),
					dotClass: window.__O.qa('[data-testid="provider-header"]')[0].querySelector('span[aria-hidden="true"]').className,
				};
			})()`);
			await cdp.eval(`(() => { window.__O.q('[data-testid="provider-enabled"]').click(); return true; })()`);
			await sleep(300);
			const backOn = await cdp.eval(`window.__O.q('[data-testid="provider-enabled"]').dataset.enabled`);

			ctx.record("U2_开关即时性", { 初始: before, 关闭后: afterOff, 再开: backOn });
			failures +=
				ctx.assert("U2 点开关即时翻转（关闭/开启各一次），全程无任何「确认停用/启用」按钮", {
					初始为启用: before === "true",
					点击后立即停用: afterOff.enabled === "false",
					无enable_confirm元素: afterOff.confirmTestId === false,
					无确认停用文案按钮: afterOff.confirmWords.length === 0,
					停用后状态点非success: !(afterOff.dotClass ?? "").includes("bg-success"),
					再点立即恢复启用: backOn === "true",
				})
					? 0
					: 1;
		}

		/* ============================== U3 删除仍保留两步确认（防回归） */
		{
			await cdp.eval(`(() => { window.__O.q('[data-testid="provider-delete"]').click(); return true; })()`);
			await sleep(300);
			const step2 = await cdp.eval(`!!window.__O.q('[data-testid="provider-delete-confirm"]')`);
			// 点「取消」收回，不做真删除（后面 U4 还要用这个 Provider）
			await cdp.eval(`(() => {
				const pane = window.__O.q('[data-testid="model-form-pane"]');
				const cancel = [...pane.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '取消');
				if (cancel) cancel.click();
				return true;
			})()`);
			await sleep(300);
			const backToStep1 = await cdp.eval(`(() => ({
				confirmGone: !window.__O.q('[data-testid="provider-delete-confirm"]'),
				deleteBtnBack: !!window.__O.q('[data-testid="provider-delete"]'),
			}))()`);
			ctx.record("U3_删除两步确认", { 出现确认按钮: step2, ...backToStep1 });
			failures +=
				ctx.assert("U3 「删除」仍需二次确认（本轮只删启用确认，未连带删掉删除确认）", {
					第一步点击后出现确认: step2 === true,
					取消后确认消失: backToStep1.confirmGone === true,
					"第一步按钮回到「删除」": backToStep1.deleteBtnBack === true,
				})
					? 0
					: 1;
		}

		/* ================== U4 填名字 + 加一个模型 → 保存 → 落 models.json 且自动选型 */
		/*
		 * apiKey 必须给一个**字面量**：Pi 的 `getAvailableSnapshot()` 只收录「已配置凭证」的
		 * provider（`configuredRequestAuthStatus().configured`），而 core 的模型清单/自动选型
		 * 都建立在该快照上（口径见 packages/core/src/models.ts 头注）。空 apiKey 的 provider
		 * 在 Pi 眼里 = 未配置 ⇒ 不进快照 —— 这条边界由 U6 单独断言。
		 */
		await cdp.eval(`(() => {
			const input = window.__O.q('[data-testid="provider-name"]');
			window.__O.setAndDispatch(input, 'probe-provider');
			const url = window.__O.q('[data-testid="provider-base-url"]');
			window.__O.setAndDispatch(url, 'http://127.0.0.1:1/v1');
			const key = window.__O.q('[data-testid="provider-api-key"]');
			window.__O.setAndDispatch(key, 'sk-probe-only');
			return true;
		})()`);
		await sleep(250);
		await cdp.eval(`(() => { window.__O.q('[data-testid="add-model"]').click(); return true; })()`);
		await sleep(400);
		const modelFormShown = await cdp.eval(`!!window.__O.q('[data-testid="model-id"]')`);
		await cdp.eval(`(() => {
			const input = window.__O.q('[data-testid="model-id"]');
			window.__O.setAndDispatch(input, 'probe-model-mini');
			return true;
		})()`);
		await sleep(250);
		await cdp.eval(`(() => { window.__O.q('[data-testid="settings-save"]').click(); return true; })()`);
		const tone = await waitStatus(cdp, ["success", "warning"]);
		const statusText = await cdp.eval(`window.__O.q('[data-testid="settings-status"]')?.textContent ?? null`);
		const healthAfter = await fetch(`${ORIGIN}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } })
			.then((r) => r.json())
			.catch(() => null);
		const apiAfter = await api("/providers");
		const fileAfter = readJson(modelsPath);
		const newId = Object.keys(fileAfter?.providers ?? {})[0] ?? null;
		savedProviderId = newId;
		const sidecarAfter = readJson(sidecarPath);

		ctx.record("U4_保存落盘", {
			模型表单出现: modelFormShown,
			状态条: tone,
			状态文案: statusText,
			models_json的key: Object.keys(fileAfter?.providers ?? {}),
			models_json内容: fileAfter?.providers?.[newId] ?? null,
			sidecar的key: Object.keys(sidecarAfter?.providers ?? {}),
			api: apiAfter.json?.providers?.map((p) => ({ id: p.id, enabled: p.enabled, models: p.models?.length })),
			api_current: apiAfter.json?.current ?? null,
			health_model: healthAfter?.model ?? null,
		});
		failures +=
			ctx.assert("U4 保存后进 models.json（不进 sidecar），且首次配置自动选中模型", {
				模型表单已出现: modelFormShown === true,
				状态条非危险: ["success", "warning"].includes(tone),
				落models_json: newId !== null,
				sidecar为空: sidecarProviderIds().length === 0,
				条目enabled为true: apiAfter.json?.providers?.[0]?.enabled === true,
				清单含一个模型: apiAfter.json?.providers?.[0]?.models?.length === 1,
				首次配置提示: typeof statusText === "string" && statusText.includes("首次配置：已自动选中"),
				current已选中:
					apiAfter.json?.current?.provider === newId &&
					apiAfter.json?.current?.modelId === "probe-model-mini",
				health_model已可用:
					healthAfter?.model?.provider === newId && healthAfter?.model?.modelId === "probe-model-mini",
				/* 关键：规格留空（0）必须被「省略」，不能原样落盘成 0 —— 否则 Pi 判非法、
				   整个 Provider 从可用集合消失（U7 是这条的反面证据）。 */
				规格0未落盘:
					fileAfter?.providers?.[newId]?.models?.[0]?.contextWindow === undefined &&
					fileAfter?.providers?.[newId]?.models?.[0]?.maxTokens === undefined,
			})
				? 0
				: 1;

		/* ============ U8 模型选择菜单的分组标题必须是 Provider 展示名 */
		/*
		 * 用户反馈：「输入框下方的模型选择的 provider 现在显示的不对」。
		 * 根因是分组标题用了 `ModelInfo.provider`（内部 key，`provider-1790227472338`）而不是
		 * 展示名。夹具里的 Provider `name` 是 `probe-provider`，所以分组标题必须就是它。
		 *
		 * ⚠️ 必须紧跟在 U4 之后：U6/U7 会把夹具改成「无可用模型」态（清 key / 写 0），
		 * 那时 `/models` 是空的、菜单自然没有分组 —— 那样测到的是夹具状态而不是本断言。
		 */
		{
			await cdp.eval(
				`(() => { window.__O.q('[data-testid="composer-chip-model-trigger"]').click(); return true; })()`,
			);
			await sleep(350);
			const r = await cdp.eval(`(() => {
				const menu = window.__O.q('[data-testid="composer-chip-model-menu"]');
				if (!menu) return { menuOpen: false, labels: [], optionCount: 0 };
				const labels = [...menu.querySelectorAll('[role="group"]')].map((g) => {
					const id = g.getAttribute('aria-labelledby');
					return id ? (document.getElementById(id)?.textContent || '').trim() : '';
				});
				return {
					menuOpen: true,
					labels,
					optionCount: menu.querySelectorAll('[role="option"]').length,
				};
			})()`);
			// 收起菜单，别影响后续断言
			await cdp.eval(
				`(() => { window.__O.q('[data-testid="composer-chip-model-trigger"]').click(); return true; })()`,
			);
			await sleep(250);
			ctx.record("U8_模型选择分组名", { ...r, 夹具里的providerKey: Object.keys(fileAfter?.providers ?? {}) });
			failures +=
				ctx.assert("U8 模型选择菜单的分组标题是 Provider 展示名（不是内部 key）", {
					菜单已展开: r.menuOpen === true,
					有分组标题: r.labels.length > 0,
					标题含展示名: r.labels.includes("probe-provider"),
					标题不含内部key: r.labels.every((l) => !/^provider-\d+$/.test(l)),
					可用模型都列出来了: r.optionCount === 1,
				})
					? 0
					: 1;
		}

		/* ============ U6 清空凭证 ⇒ 该 provider 在 Pi 眼里「未配置」⇒ 无可用模型 */
		/*
		 * 这条是 U4 的对照组，也是本次排查踩到的坑：`getAvailableSnapshot()` 只收录
		 * **已配置凭证**的 provider（`configuredRequestAuthStatus().configured`），
		 * 空 apiKey（合法的本地无鉴权服务，如 ollama）会让模型整批从快照里消失，
		 * 「自动选型」自然无从发生。断言 core 对此**给出明确文案**而不是静默不动。
		 */
		{
			// 用 GET /providers 的原文改一个字段回写（避免在探针里手搓契约形状）
			const beforePut = await api("/providers");
			const draft = (beforePut.json?.providers ?? []).map((p) =>
				p.id === savedProviderId ? { ...p, apiKey: "" } : p,
			);
			const put = await api("/providers", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ providers: draft }),
			});
			const payload = readJson(modelsPath);
			ctx.record("U6_清空凭证", {
				回写的provider数: draft.length,
				状态码: put.status,
				响应current: put.json?.current ?? null,
				响应warning: put.json?.warning ?? null,
				文件里仍有该provider: payload?.providers?.[savedProviderId] !== undefined,
			});
			failures +=
				ctx.assert("U6 清空 apiKey ⇒ core 明确告知「无可用模型」并点名「未填 API key」（不静默）", {
					请求未报错: put.status === 200,
					current被置空: (put.json?.current ?? null) === null,
					warning含无可用模型:
					typeof put.json?.warning === "string" && put.json.warning.includes("没有任何可用模型"),
					warning点名未填凭证:
					typeof put.json?.warning === "string" && put.json.warning.includes("未填写 API key"),
					provider仍在文件里: payload?.providers?.[savedProviderId] !== undefined,
				})
					? 0
					: 1;
		}

		/* ============ U7 定义非法（规格显式写 0）⇒ Pi 组合错误必须被透出 */
		/*
		 * U4 的反面证据：把 contextWindow 显式写成 0（UI 侧已不再可能产出，这里直接走 API
		 * 造出该状态）。Pi 的 `modelFromJson` 会 throw `invalid contextWindow` 并把该 provider
		 * 从可用集合摘掉；core 必须把这条**组合错误**（`runtime.getError()`）暴露到 warning，
		 * 而不是回一句「保存成功」把用户晾在那儿。
		 */
		{
			const beforePut = await api("/providers");
			const draft = (beforePut.json?.providers ?? []).map((p) =>
				p.id === savedProviderId
					? { ...p, apiKey: "sk-probe-only", models: p.models.map((m) => ({ ...m, contextWindow: 0 })) }
					: p,
			);
			const put = await api("/providers", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ providers: draft }),
			});
			const payload = readJson(modelsPath);
			ctx.record("U7_非法规格", {
				状态码: put.status,
				响应current: put.json?.current ?? null,
				响应warning: put.json?.warning ?? null,
				落盘contextWindow: payload?.providers?.[savedProviderId]?.models?.[0]?.contextWindow ?? null,
			});
			failures +=
				ctx.assert("U7 模型 contextWindow 显式写 0 ⇒ warning 透出 Pi 的组合错误（invalid contextWindow）", {
					请求未报错: put.status === 200,
					warning含无可用模型:
					typeof put.json?.warning === "string" && put.json.warning.includes("没有任何可用模型"),
					warning含组合错误:
					typeof put.json?.warning === "string" && put.json.warning.includes("invalid contextWindow"),
					"0被如实落盘": payload?.providers?.[savedProviderId]?.models?.[0]?.contextWindow === 0,
				})
					? 0
					: 1;
		}

		/* ===== U9 拉取 Provider 真实模型清单（POST /providers/models，本地 stub 上游做真链路） */
		/*
		 * 用一个只认 `Bearer sk-probe-only` 的本地 stub 充当上游：
		 * ① 成功路径要能解析 `{data:[{id}]}` 并**去重保序**；
		 * ② 断言 stub 收到的 Authorization 头 —— 证明 apiKey 真的带上了（不是空跑）；
		 * ③ 错 key 必须回 ok=false 且文案带目标 host 与 401（与「测试」按钮同一诊断口径）。
		 */
		{
			const okResp = await api("/providers/models", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`,
					apiKey: "sk-probe-only",
					api: "openai-completions",
					headers: {},
				}),
			});
			const badResp = await api("/providers/models", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`,
					apiKey: "sk-wrong",
					api: "openai-completions",
					headers: {},
				}),
			});
			const unreachable = await api("/providers/models", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-x", api: "openai-completions" }),
			});
			const stubAuth = stubHits.find((h) => h.auth === "Bearer sk-probe-only")?.auth ?? null;
			ctx.record("U9_拉取模型清单", {
				成功响应: okResp.json,
				错key响应: badResp.json,
				不可达响应: unreachable.json,
				stub收到的鉴权头: stubAuth,
				stub请求记录: stubHits,
			});
			failures +=
				ctx.assert("U9 POST /providers/models 真链路：带 key 拉清单 / 去重保序 / 失败可定位", {
					成功请求未报错: okResp.status === 200,
					成功ok: okResp.json?.ok === true,
					清单去重保序:
						JSON.stringify(okResp.json?.models) === JSON.stringify(["probe-alpha", "probe-beta"]),
					请求地址正确: okResp.json?.endpoint === `http://127.0.0.1:${STUB_PORT}/v1/models`,
					鉴权头确实带上: stubAuth === "Bearer sk-probe-only",
					错key为失败: badResp.json?.ok === false,
					错key带目标host: String(badResp.json?.error ?? "").includes(`127.0.0.1:${STUB_PORT}`),
					错key带状态码: String(badResp.json?.error ?? "").includes("401"),
					不可达可定位: String(unreachable.json?.error ?? "").includes("127.0.0.1:1"),
				})
					? 0
					: 1;
		}

		/* ===== U10 无可用模型态：模型芯片必须显式降级（2026-09-24） ===== */
		/*
		 * 承 U6/U7 留下的夹具状态：provider 仍 enabled、key 也在（`sk-probe-only`），
		 * 但模型规格非法（`contextWindow: 0`）⇒ Pi 判非法、该 provider 被摘掉 ⇒ 可用快照为空。
		 *
		 * 此时 UI **不能**回落到 ui-store 里的 mock `modelId` —— 那会让芯片显示一个并不存在、
		 * 却很像真的模型名（如「Claude Sonnet 4.5」），把「没配模型」藏起来；也不能留着可点
		 * 的空菜单（点了没反应）。必须显式说「未配置模型」+ 禁用 + 提示去处。
		 *
		 * 刷新页面是为了让 models-store 重新拉一次 `/models`（本探针的夹具变更都走 API，不经 UI）。
		 */
		{
			const modelsResp = (await api("/models")).json ?? {};
			await ctx.open("/?live=1");
			await cdp.eval(SET_TEXT_HELPER);
			await cdp.eval(HELPERS);
			const degraded = await cdp.eval(
				`new Promise((r) => {
					const t0 = Date.now();
					const iv = setInterval(() => {
						const t = window.__O.q('[data-testid="composer-chip-model-trigger"]');
						if (t && (t.textContent || '').trim() === '未配置模型') { clearInterval(iv); r(true); }
						else if (Date.now() - t0 > 10000) { clearInterval(iv); r(false); }
					}, 150);
				})`,
				true,
			);
			const chip = await cdp.eval(`(() => {
				const trigger = window.__O.q('[data-testid="composer-chip-model-trigger"]');
				const toolbar = window.__O.q('[data-testid="composer-toolbar"]');
				return {
					firstChildTestid: toolbar ? (toolbar.children[0]?.dataset.testid ?? null) : null,
					triggerThere: !!trigger,
					disabled: trigger ? trigger.disabled === true : null,
					text: trigger ? (trigger.textContent || '').trim() : null,
					title: trigger ? (trigger.title || '') : null,
					menuThere: !!window.__O.q('[data-testid="composer-chip-model-menu"]'),
				};
			})()`);
			ctx.record("U10_无可用模型态的模型芯片", {
				core侧模型数: (modelsResp.models ?? []).length,
				core侧current: modelsResp.current ?? null,
				芯片已降级: degraded,
				...chip,
			});
			failures +=
				ctx.assert("U10 无可用模型时模型芯片显式降级为「未配置模型」（禁用 + 无菜单，不回落 mock 名）", {
					core侧确实无可用模型: (modelsResp.models ?? []).length === 0 && (modelsResp.current ?? null) === null,
					芯片已降级: degraded === true,
					芯片仍在工具条原位: chip.firstChildTestid === "composer-chip-model",
					芯片已禁用: chip.disabled === true,
					文案是未配置模型: chip.text === "未配置模型",
					提示指向设置页: typeof chip.title === "string" && chip.title.includes("设置"),
					没有菜单: chip.menuThere === false,
				})
					? 0
					: 1;
		}

		/* ==================================== U5 无未捕获页面异常 */
		{
			ctx.record("U5_console", { exceptions });
			failures += ctx.assert("U5 全程无未捕获页面异常", { 无未捕获异常: exceptions.length === 0 }) ? 0 : 1;
		}

		await cdp.screenshot("_onboarding-probe.png");
		const summary = ctx.save();
		failures += summary.failed;
	});
} catch (e) {
	console.error("[onboarding] 脚本异常:", e && e.stack ? e.stack : e);
	try {
		const log = fs.readFileSync(path.join(repoRoot, "packages", "ui", "_onboarding-core.log"), "utf8");
		console.error(`[onboarding] core 日志尾部：\n${log.slice(-4000)}`);
	} catch {
		/* 日志不可读 */
	}
	failures += 1;
} finally {
	if (core) await core.close();
	await new Promise((resolve) => stub.close(resolve));
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		/* 忽略 */
	}
}

console.log(
	failures === 0 ? "\n引导链检查全部通过" : `\n引导链检查失败 ${failures} 项`,
);
process.exit(failures === 0 ? 0 : 1);

/** withBrowser 之外的断言（U0 在浏览器起来之前跑），沿用同一计数口径 */
function ctxAssert(name, detail) {
	const ok = Object.values(detail).every(Boolean);
	console.log(`\n### [${ok ? "PASS" : "FAIL"}] ${name}`);
	console.log(JSON.stringify(detail, null, 2));
	return ok ? 0 : 1;
}
