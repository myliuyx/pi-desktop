/**
 * 设置弹窗 · **live 形态**验收探针（probe:settings:live）—— 设置改版第二批。
 *
 * 与 `probe:settings`（mock 形态，跑 dev server）互补：它验证「设置弹窗 ⇄ core 的 models.json」
 * 这条**真实读写链路**。由主控（非第二批实现方）书写。
 *
 * 覆盖（规格书 `.plan/task-settings-c2.md` §四·4「probe:settings 升级 live 段」）：
 *   L1 打开弹窗即看见 **core 的真实清单**（models.json 的 key），而不是 mock 的 aliyun/setfun/…；
 *   L2 改 Provider 名称 → 保存 → **core 侧确认**：`GET /providers` 复读一致 + models.json 落盘；
 *   L3 删除 Provider → 保存 → **core 侧确认**：models.json 里物理消失（不是软标记）；
 *   L4 core 不可达 → 弹窗回落到演示数据、状态条给出失败原因（不白屏、不静默）；
 *   L5 全程无 console error 泄漏、状态条终态不为 danger。
 *
 * ⚠️ 前置：`packages/ui` **必须已 build**（core 同源托管 `packages/ui/dist`）。
 *     core 用 `--env-file` 读 `pi/_poc/.env.local` 的 ARK_API_KEY（和 smoke 同口径）。
 *
 * 端口：core 5350（服 + API）、CDP 9346（避开 probe:settings 的 9345）。
 * 证据：`packages/ui/_settings-live-evidence.json`
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser, sleep, SET_TEXT_HELPER } from "./cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const coreDir = path.join(repoRoot, "packages", "core");
const uiDist = path.join(repoRoot, "packages", "ui", "dist");
const envLocal = path.join(repoRoot, "pi", "_poc", ".env.local");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
const mainPath = path.join(coreDir, "src", "main.ts");

const PORT = 5350;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TOKEN = "settings-live-token";
const EVIDENCE = "_settings-live-evidence.json";

const sleepMs = sleep;

/* ---------------------------------------------------------------------------
 * 夹具：临时 models.json + agentDir（绝不碰 pi/_poc/models.json）
 * ------------------------------------------------------------------------- */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "settings-live-"));
const modelsPath = path.join(tmpRoot, "models.json");
const agentDir = path.join(tmpRoot, "agentdir");
fs.mkdirSync(agentDir, { recursive: true });

/** 两个 provider：一个真可用（有凭证插值），一个纯占位（用来验证删除） */
const FIXTURE_PROVIDERS = ["ark-coding", "probe-spare"];
fs.writeFileSync(
	modelsPath,
	JSON.stringify(
		{
			providers: {
				"ark-coding": {
					baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
					api: "openai-completions",
					apiKey: "$ARK_API_KEY",
					models: [{ id: "deepseek-v4-flash" }],
				},
				"probe-spare": {
					name: "Probe Spare",
					baseUrl: "http://127.0.0.1:1/v1",
					api: "openai-completions",
					apiKey: "sk-fixture-only",
					models: [{ id: "spare-mini" }],
				},
			},
		},
		null,
		2,
	),
);
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));

const readModelsFile = () => JSON.parse(fs.readFileSync(modelsPath, "utf8"));
const fileProviderIds = () => Object.keys(readModelsFile()?.providers ?? {});

/* ---------------------------------------------------------------------------
 * core 实例
 * ------------------------------------------------------------------------- */

function launchCore() {
	// 日志落固定路径（不随 tmpRoot 清理）—— core 起不来时必须能看见原因
	const logPath = path.join(repoRoot, "packages", "ui", "_settings-live-core.log");
	const logFd = fs.openSync(logPath, "w");
	const child = spawn(process.execPath, ["--env-file=" + envLocal, tsxPath, mainPath], {
		cwd: coreDir,
		env: {
			...process.env,
			CORE_TOKEN: TOKEN,
			CORE_PORT: String(PORT),
			CORE_MODELS_PATH: modelsPath,
			CORE_AGENT_DIR: agentDir,
			CORE_UI_DIST: uiDist,
		},
		stdio: ["ignore", logFd, logFd],
	});
	return {
		logPath,
		async close() {
			child.kill("SIGTERM");
			await Promise.race([
				new Promise((r) => child.once("exit", r)),
				sleepMs(5000).then(() => child.kill("SIGKILL")),
			]);
			fs.closeSync(logFd);
		},
	};
}

async function waitForHealth(timeoutMs = 90_000) {
	const t0 = Date.now();
	for (;;) {
		try {
			// ⚠️ /health 也在 API_ROUTES 里，同样要 Bearer（首跑漏了这一步 ⇒ 90s 假超时）
			const res = await fetch(`${ORIGIN}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
			if (res.ok) {
				const json = await res.json();
				if (json.extensions !== null) return json;
			}
		} catch {
			/* 还没起来 */
		}
		if (Date.now() - t0 > timeoutMs) return null;
		await sleepMs(300);
	}
}

/** core API 调用（Bearer 必填；静态资源免鉴权，这里只调 API） */
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
window.__L = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  setAndDispatch: setNativeValue,
};
true;
`;

const OPEN_CHECK = `(() => {
  const d = window.__L.q('[role="dialog"]');
  return !!d && !d.hasAttribute('inert') && getComputedStyle(d).opacity === '1';
})()`;

const PROVIDER_IDS = `window.__L.qa('[data-testid="provider-header"]').map(el => el.dataset.providerId)`;

async function openDialog(cdp) {
	await cdp.eval(`(() => { window.__L.q('[data-testid="sidebar-footer-settings"]').click(); return true; })()`);
	await sleepMs(600);
}

async function waitClosed(cdp, timeout = 12_000) {
	const t0 = Date.now();
	for (;;) {
		const open = await cdp.eval(OPEN_CHECK);
		if (!open) return true;
		if (Date.now() - t0 > timeout) return false;
		await sleepMs(200);
	}
}

let failures = 0;
const consoleErrors = [];

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */

console.log("[settings-live] 启动 core（同源托管 ui/dist）…");
if (!fs.existsSync(path.join(uiDist, "index.html"))) {
	console.error(`未找到 ${uiDist}\\index.html —— 请先在 packages/ui 下跑 npm run build`);
	process.exit(1);
}
const core = launchCore();
let health = null;

try {
	health = await waitForHealth();
	if (!health) throw new Error("core 未就绪（/health 超时）");
	console.log(`[settings-live] core 就绪：${JSON.stringify(health)}`);

	await withBrowser({ port: 9346, origin: ORIGIN, evidencePath: EVIDENCE }, async (ctx) => {
		const { cdp } = ctx;
		await ctx.open("/?live=1");
		await cdp.eval(SET_TEXT_HELPER);
		await cdp.eval(HELPERS);

		/* 收集 console error（StrickMode 之外的真实报错，例如未捕获异常） */
		const cdpAny = cdp;
		cdpAny.ws.addEventListener("message", (ev) => {
			try {
				const msg = JSON.parse(ev.data);
				if (msg.method === "Runtime.exceptionThrown") {
					consoleErrors.push(msg.params?.exceptionDetails?.exception?.description ?? "unknown");
				}
			} catch {
				/* 忽略非 JSON */
			}
		});
		await cdp.send("Runtime.enable");

		/* ============================================ L1 弹窗展示 core 真实清单 */
		await openDialog(cdp);
		{
			const r = await cdp.eval(`(() => ({
				open: ${OPEN_CHECK},
				providerIds: ${PROVIDER_IDS},
				modelIds: window.__L.qa('[data-testid="model-row"]').map(el => el.dataset.modelId),
				statusTone: window.__L.q('[data-testid="settings-status"]')?.dataset.tone ?? null,
				statusText: window.__L.q('[data-testid="settings-status"]')?.textContent ?? null,
			}))()`);
			ctx.record("L1_弹窗数据源", { ...r, 文件里的provider: fileProviderIds() });
			failures += ctx.assert("L1 live 形态下弹窗列出 core 的真实 Provider（不是演示数据）", {
				弹窗已打开: r.open === true,
				清单等于models_json的key:
					JSON.stringify(r.providerIds) === JSON.stringify(fileProviderIds()),
				含真实provider_arkcoding: r.providerIds.includes("ark-coding"),
				不含演示数据aliyun: !r.providerIds.includes("aliyun"),
				不含演示数据setfun: !r.providerIds.includes("setfun"),
				状态条非危险态: r.statusTone === "normal",
			})
				? 0
				: 1;
		}
		await cdp.eval(`(() => { window.__L.q('[data-testid="settings-dialog-close"]').click(); return true; })()`);
		await sleepMs(500);

		/* ================================== L2 改名 → 保存 → core 侧落盘复读一致 */
		await openDialog(cdp);
		await cdp.eval(
			`(() => { window.__L.q('[data-testid="provider-header"][data-provider-id="ark-coding"]').click(); return true; })()`,
		);
		await sleepMs(400);
		await cdp.eval(
			`(() => {
				const input = window.__L.q('[data-testid="provider-name"]');
				if (!input) return false;
				window.__L.setAndDispatch(input, 'ark-coding-renamed');
				return true;
			})()`,
		);
		await sleepMs(300);
		const draftValue = await cdp.eval(`window.__L.q('[data-testid="provider-name"]').value`);
		await cdp.eval(`(() => { window.__L.q('[data-testid="settings-save"]').click(); return true; })()`);
		const closed = await waitClosed(cdp);
		const apiAfterSave = await api("/providers");
		const fileAfterSave = readModelsFile();

		ctx.record("L2_保存写回", {
			输入框现值: draftValue,
			弹窗已关闭: closed,
			api: apiAfterSave.json,
			文件: fileAfterSave,
		});
		failures += ctx.assert("L2 改名保存后 core 侧确认：API 复读一致 + models.json 已落盘", {
			输入框改到了新名字: draftValue === "ark-coding-renamed",
			保存后弹窗关闭: closed === true,
			响应ok: apiAfterSave.json?.ok === true,
			API复读一致:
				apiAfterSave.json?.providers?.find((p) => p.id === "ark-coding")?.name === "ark-coding-renamed",
			文件里名字同步:
				fileAfterSave?.providers?.["ark-coding"]?.name === "ark-coding-renamed",
			另一个provider未受影响: fileAfterSave?.providers?.["probe-spare"] !== undefined,
		})
			? 0
			: 1;

		/* ============================== L3 删除 Provider → models.json 物理消失 */
		await openDialog(cdp);
		const beforeIds = await cdp.eval(PROVIDER_IDS);
		await cdp.eval(
			`(() => { window.__L.q('[data-testid="provider-header"][data-provider-id="probe-spare"]').click(); return true; })()`,
		);
		await sleepMs(400);
		await cdp.eval(`(() => { window.__L.q('[data-testid="provider-delete"]').click(); return true; })()`);
		await sleepMs(300);
		await cdp.eval(`(() => { window.__L.q('[data-testid="provider-delete-confirm"]').click(); return true; })()`);
		await sleepMs(300);
		await cdp.eval(`(() => { window.__L.q('[data-testid="settings-save"]').click(); return true; })()`);
		const closed3 = await waitClosed(cdp);
		const fileAfterDelete = readModelsFile();
		const apiAfterDelete = await api("/providers");
		const sidecarAfterDelete = await (async () => {
			try {
				return JSON.parse(fs.readFileSync(path.join(tmpRoot, "models-disabled.json"), "utf8"));
			} catch {
				return null;
			}
		})();

		ctx.record("L3_删除落盘", {
			保存前列表: beforeIds,
			弹窗已关闭: closed3,
			文件: fileAfterDelete,
			api: apiAfterDelete.json?.providers?.map((p) => p.id),
			sidecar: sidecarAfterDelete,
		});
		failures += ctx.assert("L3 删除保存后 models.json 里物理消失（且没进 sidecar 变软标记）", {
			保存后弹窗关闭: closed3 === true,
			models_json里已消失: fileAfterDelete?.providers?.["probe-spare"] === undefined,
			sidecar里也没有: (sidecarAfterDelete?.providers?.["probe-spare"] ?? undefined) === undefined,
			API不再列出: !(apiAfterDelete.json?.providers ?? []).some((p) => p.id === "probe-spare"),
			剩下的那个还在: fileAfterDelete?.providers?.["ark-coding"] !== undefined,
		})
			? 0
			: 1;

		/* ============================ L4 core 不可达 → 回落演示数据且不白屏 */
		await ctx.open("/?live=1&core=http://127.0.0.1:1");
		await cdp.eval(SET_TEXT_HELPER);
		await cdp.eval(HELPERS);
		await openDialog(cdp);
		{
			const r = await cdp.eval(`(() => ({
				open: ${OPEN_CHECK},
				providerIds: ${PROVIDER_IDS},
				statusTone: window.__L.q('[data-testid="settings-status"]')?.dataset.tone ?? null,
				statusText: window.__L.q('[data-testid="settings-status"]')?.textContent ?? null,
				panelHeight: window.__L.q('[role="dialog"]').lastElementChild.getBoundingClientRect().height,
			}))()`);
			ctx.record("L4_不可达回落", r);
			failures += ctx.assert("L4 core 不可达 ⇒ 回落演示数据 + 状态条给出失败原因（不白屏、不静默）", {
				弹窗仍可用: r.open === true,
				面板有实际高度: r.panelHeight > 100,
				回落演示数据: r.providerIds.includes("aliyun") || r.providerIds.includes("setfun"),
				状态条为危险态: r.statusTone === "danger",
				原因文案可读: (r.statusText ?? "").includes("core 读取失败"),
			})
				? 0
				: 1;
		}

		/* ==================================================== L5 无未捕获异常 */
		{
			ctx.record("L5_console", { exceptions: consoleErrors });
			failures += ctx.assert("L5 全程无未捕获页面异常", {
				无未捕获异常: consoleErrors.length === 0,
			})
				? 0
				: 1;
		}

		const summary = ctx.save();
		failures += summary.failed;
	});
} catch (e) {
	console.error("[settings-live] 脚本异常:", e && e.stack ? e.stack : e);
	try {
		const log = fs.readFileSync(path.join(repoRoot, "packages", "ui", "_settings-live-core.log"), "utf8");
		console.error(`[settings-live] core 日志尾部：\n${log.slice(-4000)}`);
	} catch {
		console.error("[settings-live] core 日志不可读（启动器可能没来得及写）");
	}
	failures += 1;
} finally {
	if (core) await core.close();
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		/* 忽略 */
	}
}

console.log(
	failures === 0
		? "\n设置弹窗 live 形态检查全部通过"
		: `\n设置弹窗 live 形态检查失败 ${failures} 项`,
);
process.exit(failures === 0 ? 0 : 1);
