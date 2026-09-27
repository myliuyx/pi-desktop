/**
 * probe:settings:skills —— 设置弹窗「技能」Tab 验收探针（C7 · task-settings-skills-plugins.md 批次 A）。
 *
 * 两段：
 * - M 段（mock，dev server :5180）：
 *   · M1 Tab 顺序 = 常规/模型/技能/插件/子代理（2026-09-28 换位裁决）；
 *   · M2 技能树分组（全局/项目）+ 默认选中首项 + 详情字段齐全；
 *   · M3 禁用条目：data-enabled=false + 空心点；
 *   · M4 mock 开关本地翻转（关→开→关，不落盘）；
 *   · M5 「添加技能」钉底 + 点击出 notice（2026-09-28 裁决：本批仅入口）；
 *   · M6 插件 / 子代理仍为占位（位置已互换，内容未实现）。
 * - L 段（live，临时 agentDir + 真实 core :5196，dist 同源托管）：
 *   · L1 GET /skills 全量清单（夹具 demo-skill：enabled/scope/origin/path 正确）；
 *   · L2 UI 渲染真实清单（含页内直连 fetch 诊断：隔离 transport 与服务端）；
 *   · L3 POST /skills/toggle 关 → 响应 enabled=false + 临时 settings.json 出现 `!路径` 模式；
 *   · L4 session.reload() 生效：GET /resources（已加载子集）里该技能消失；
 *   · L5 UI 重开显示禁用态（重挂载拉新清单）；
 *   · L6 UI 开关开回 → 条目/开关联动恢复 + settings 模式移除 + /resources 恢复；
 *   · L7 toggle 不存在的技能 → 404 + core 原文。
 *
 * 运行前置：M 段需 packages/ui dev server（:5180，cdp.mjs 自检并提示启动命令）；
 * L 段需先 `npm run build`（core 同源托管 dist）。CDP 端口 9346/9356（错开 9345/9355）。
 * 证据：_probe-settings-skills-evidence-{mock,live}.json；失败非 0 退出。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser, sleep } from "./cdp.mjs";
import { childEnv } from "../../core/scripts/lib/credentials.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(here, "..");
const coreDir = path.join(uiDir, "..", "core");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
/** ⚠️ 必须绝对路径：core 的 cwd 会被指到临时目录，相对路径会解析错（probe-c5 首跑实踩） */
const mainPath = path.join(coreDir, "src", "main.ts");
const fixtureDir = path.join(coreDir, "test", "fixtures", "resources");
const evidenceMock = path.join(uiDir, "_probe-settings-skills-evidence-mock.json");
const evidenceLive = path.join(uiDir, "_probe-settings-skills-evidence-live.json");

const CORE_PORT = Number(process.env.PROBE_SKILLS_CORE_PORT ?? 5196);
const CDP_MOCK = Number(process.env.PROBE_SKILLS_CDP_M ?? 9346);
const CDP_LIVE = Number(process.env.PROBE_SKILLS_CDP_L ?? 9356);
const TOKEN = process.env.PROBE_SKILLS_TOKEN ?? "probe-skills-token";

/** 页内助手（与 probe:settings 同款 q/qa） */
const HELPERS = `
window.__S = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
};
true;
`;

const ITEM = '[data-testid="settings-skill-item"]';
const TABS_EXPECT = JSON.stringify([
	"settings-tab-general",
	"settings-tab-models",
	"settings-tab-skills",
	"settings-tab-plugins",
	"settings-tab-subagents",
]);

let failures = 0;

/* ============================================================ M 段 · mock（:5180） */
try {
	await withBrowser({ port: CDP_MOCK, evidencePath: evidenceMock }, async (ctx) => {
		const { cdp } = ctx;
		await ctx.open("/");
		await cdp.eval(HELPERS);

		// 打开设置弹窗（默认落在「模型」Tab）
		await cdp.eval(`(() => { window.__S.q('[data-testid="sidebar-footer-settings"]').click(); return true; })()`);
		await sleep(450);

		/* ---- M1 Tab 顺序（换位裁决） ---- */
		{
			const tabs = await cdp.eval(
				`(() => window.__S.qa('[role="dialog"] [role="tab"]').map((el) => el.getAttribute('data-testid')))()`,
			);
			ctx.record("M1_Tab顺序", tabs);
			failures += ctx.assert("M1 设置弹窗 Tab 顺序 = 常规/模型/技能/插件/子代理（2026-09-28 换位）", {
				顺序正确: JSON.stringify(tabs) === TABS_EXPECT,
			})
				? 0
				: 1;
		}

		// 切到「技能」Tab
		await cdp.eval(`(() => { window.__S.q('[data-testid="settings-tab-skills"]').click(); return true; })()`);
		await sleep(400);

		/* ---- M2 分组渲染 + 默认选中 + 详情字段 ---- */
		{
			const r = await cdp.eval(`(() => {
				const tree = window.__S.q('[data-testid="settings-skills-tree"]');
				const items = window.__S.qa('${ITEM}');
				const detail = window.__S.q('[data-testid="settings-skill-detail"]');
				const labels = tree ? [...tree.querySelectorAll('section > p')].map((el) => el.textContent.trim()) : [];
				return {
					treeExists: !!tree,
					labels,
					itemCount: items.length,
					firstSelected: items[0]?.classList.contains('bg-bg-active') === true,
					detailExists: !!detail,
					badge: (detail?.querySelector('span')?.textContent || '').trim(),
					pathText: (detail?.querySelector('.font-mono')?.textContent || '').trim(),
					hasName: (detail?.textContent || '').includes('Name'),
					hasDescription: (detail?.textContent || '').includes('Description'),
					switchChecked: detail?.querySelector('[data-testid="settings-skill-toggle"]')?.getAttribute('aria-checked') ?? null,
				};
			})()`);
			ctx.record("M2_分组与详情", r);
			failures += ctx.assert("M2 技能树分组（全局/项目）渲染、默认选中首项、详情字段齐全", {
				树存在: r.treeExists === true,
				分组顺序: JSON.stringify(r.labels) === JSON.stringify(["全局", "项目"]),
				条目数5: r.itemCount === 5,
				默认选中首项: r.firstSelected === true,
				详情存在: r.detailExists === true,
				徽标global: r.badge === "global",
				路径以SKILL_md结尾: r.pathText.endsWith("SKILL.md"),
				Name块: r.hasName === true,
				Description块: r.hasDescription === true,
				开关存在且为开: r.switchChecked === "true",
			})
				? 0
				: 1;
		}

		/* ---- M3 禁用条目形态（weekly-report，mock 里唯一 enabled=false） ---- */
		{
			const r = await cdp.eval(`(() => {
				const el = window.__S.qa('${ITEM}').find((n) => n.dataset.name === 'weekly-report');
				if (!el) return { found: false };
				return {
					found: true,
					enabled: el.dataset.enabled,
					空心点: (el.querySelector('span.rounded-full')?.className || '').includes('border-border-strong'),
				};
			})()`);
			ctx.record("M3_禁用条目", r);
			failures += ctx.assert("M3 禁用技能（weekly-report）data-enabled=false 且圆点空心", {
				条目存在: r.found === true,
				enabled为false: r.enabled === "false",
				圆点空心: r.空心点 === true,
			})
				? 0
				: 1;
		}

		/* ---- M4 mock 开关本地翻转（关→开→关） ---- */
		{
			// 选中禁用项 → 开关应为关
			await cdp.eval(`(() => {
				window.__S.qa('${ITEM}').find((n) => n.dataset.name === 'weekly-report').click();
				return true;
			})()`);
			await sleep(250);
			const before = await cdp.eval(
				`(() => window.__S.q('[data-testid="settings-skill-toggle"]')?.getAttribute('aria-checked') ?? null)()`,
			);
			// 翻开
			await cdp.eval(`(() => { window.__S.q('[data-testid="settings-skill-toggle"]').click(); return true; })()`);
			await sleep(300);
			const afterOn = await cdp.eval(`(() => ({
				itemEnabled: window.__S.qa('${ITEM}').find((n) => n.dataset.name === 'weekly-report')?.dataset.enabled ?? null,
				switchChecked: window.__S.q('[data-testid="settings-skill-toggle"]')?.getAttribute('aria-checked') ?? null,
			}))()`);
			// 翻回
			await cdp.eval(`(() => { window.__S.q('[data-testid="settings-skill-toggle"]').click(); return true; })()`);
			await sleep(300);
			const afterOff = await cdp.eval(
				`(() => window.__S.qa('${ITEM}').find((n) => n.dataset.name === 'weekly-report')?.dataset.enabled ?? null)()`,
			);
			ctx.record("M4_mock开关翻转", { before, afterOn, afterOff });
			failures += ctx.assert("M4 mock 开关本地翻转：关→开→关（aria 与 data-enabled 同步）", {
				选中禁用项后开关为关: before === "false",
				翻转后条目为开: afterOn.itemEnabled === "true",
				翻转后开关为开: afterOn.switchChecked === "true",
				翻回后条目为关: afterOff === "false",
			})
				? 0
				: 1;
		}

		/* ---- M5 添加技能：钉底 + 点击出 notice ---- */
		{
			const r = await cdp.eval(`(() => {
				const tree = window.__S.q('[data-testid="settings-skills-tree"]');
				const btn = tree?.querySelector('[data-testid="settings-skill-add"]');
				if (!tree || !btn) return { btnExists: false };
				const treeRect = tree.getBoundingClientRect();
				const btnRect = btn.getBoundingClientRect();
				return {
					btnExists: true,
					钉底: Math.abs(treeRect.bottom - btnRect.bottom) < 40,
					text: (btn.textContent || '').trim(),
				};
			})()`);
			await cdp.eval(`(() => { window.__S.q('[data-testid="settings-skill-add"]').click(); return true; })()`);
			await sleep(300);
			const notice = await cdp.eval(`(() => {
				const items = window.__S.qa('[data-testid="notice-item"]');
				return { count: items.length, text: (items[items.length - 1]?.textContent || '').trim() };
			})()`);
			ctx.record("M5_添加技能", { button: r, notice });
			failures += ctx.assert("M5 「添加技能」钉底可见；点击出「交互待定」notice（本批仅入口）", {
				按钮存在: r.btnExists === true,
				钉在栏底: r.钉底 === true,
				文案正确: r.text === "添加技能",
				notice弹出: notice.count > 0,
				文案含待定: notice.text.includes("待定"),
			})
				? 0
				: 1;
			await cdp.eval(`(() => { window.__S.q('[data-testid="settings-dialog-close"]').click(); return true; })()`);
			await sleep(350);
		}

		/* ---- M6 插件 / 子代理仍占位（换位后内容未实现） ---- */
		{
			await cdp.eval(`(() => { window.__S.q('[data-testid="sidebar-footer-settings"]').click(); return true; })()`);
			await sleep(450);
			await cdp.eval(`(() => { window.__S.q('[data-testid="settings-tab-plugins"]').click(); return true; })()`);
			await sleep(300);
			const plugins = await cdp.eval(
				`(() => document.body.textContent.includes('插件（占位）本批暂不实现'))()`,
			);
			await cdp.eval(`(() => { window.__S.q('[data-testid="settings-tab-subagents"]').click(); return true; })()`);
			await sleep(300);
			const subagents = await cdp.eval(
				`(() => document.body.textContent.includes('子代理（占位）本批暂不实现'))()`,
			);
			ctx.record("M6_占位Tab", { plugins, subagents });
			failures += ctx.assert("M6 插件 / 子代理 Tab 仍为占位（换位后内容未实现）", {
				插件占位: plugins === true,
				子代理占位: subagents === true,
			})
				? 0
				: 1;
		}

		ctx.save();
	});
	console.log("== M 段（mock）完成 ==");
} catch (e) {
	console.error("[probe-skills] M 段异常：", e.message);
	failures += 1;
}

/* ============================================================ L 段 · live（临时 core :5196） */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-skills-"));
const agentDir = path.join(tmpRoot, "agentdir");
const cwd = path.join(tmpRoot, "project");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
// 无项目本地资源（信任门过滤由 check:c5 覆盖；本探针只验 user scope 全量清单与开关写路径）
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));
fs.cpSync(path.join(fixtureDir, "skills"), path.join(agentDir, "skills"), { recursive: true });

const settingsFile = path.join(agentDir, "settings.json");
const readSettings = () => {
	try {
		return JSON.parse(fs.readFileSync(settingsFile, "utf8"));
	} catch {
		return null;
	}
};

function request(method, p, body) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port: CORE_PORT,
				path: p,
				method,
				headers: {
					Authorization: `Bearer ${TOKEN}`,
					...(body ? { "Content-Type": "application/json" } : {}),
				},
				timeout: 30_000,
			},
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
					resolve({ status: res.statusCode, json });
				});
			},
		);
		req.on("error", reject);
		req.on("timeout", () => req.destroy(new Error("timeout")));
		if (body) req.write(JSON.stringify(body));
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

const logFd = fs.openSync(path.join(coreDir, "run", "probe-skills-core.log"), "w");
const child = spawn(process.execPath, [tsxPath, mainPath], {
	cwd,
	env: childEnv({
		CORE_TOKEN: TOKEN,
		CORE_PORT: String(CORE_PORT),
		CORE_AGENT_DIR: agentDir,
	}),
	stdio: ["ignore", "ignore", logFd],
});

try {
	const health = await waitForHealth();
	if (!health) throw new Error(`core 未就绪（端口 ${CORE_PORT}）`);

	/* ---- L1 GET /skills 全量清单 ---- */
	const skillsRes = await request("GET", "/skills");
	const skillItem = (skillsRes.json?.skills ?? []).find((s) => s.name === "demo-skill");
	const skillPath = skillItem?.path ?? "";
	ctx_record("L1_skills端点", skillsRes.json);
	failures += recordAssert("L1 GET /skills 全量清单正确", {
		状态200: skillsRes.status === 200,
		技能存在: !!skillItem,
		enabled: skillItem?.enabled === true,
		scope_user: skillItem?.scope === "user",
		origin_top_level: skillItem?.origin === "top-level",
		path是SKILL_md: skillPath.endsWith(path.join("demo-skill", "SKILL.md")),
	})
		? 0
		: 1;

	/* ---- L3 关开关（端点直发；UI 联动在 L5 验证） ---- */
	const offRes = await request("POST", "/skills/toggle", { path: skillPath, enabled: false });
	const offItem = (offRes.json?.skills?.skills ?? []).find((s) => s.name === "demo-skill");
	const settingsAfterOff = readSettings();
	const offArr = Array.isArray(settingsAfterOff?.skills) ? settingsAfterOff.skills : [];
	ctx_record("L3_关开关响应", { body: offRes.json, settings: settingsAfterOff });
	failures += recordAssert("L3 toggle 关：响应清单 enabled=false + settings 写入 `!路径` 模式", {
		状态200: offRes.status === 200,
		响应enabled为false: offItem?.enabled === false,
		settings有排除模式: offArr.some((p) => p === `!${skillPath}`),
	}) ? 0 : 1;

	/* ---- L4 reload 生效：04 屏的已加载清单（GET /resources）里该技能消失 ---- */
	const resourcesOff = await request("GET", "/resources");
	const stillLoadedOff = (resourcesOff.json?.skills ?? []).some((s) => s.name === "demo-skill");
	ctx_record("L4_resources关后", resourcesOff.json);
	failures += recordAssert("L4 session.reload() 生效：/resources 已加载清单里该技能消失", {
		已消失: stillLoadedOff === false,
	}) ? 0 : 1;

	/* ---- L2/L5/L6 UI 段（重挂载拉新清单 + 真实开关链路） ---- */
	await withBrowser(
		{ port: CDP_LIVE, origin: `http://127.0.0.1:${CORE_PORT}`, evidencePath: evidenceLive },
		async (ctx) => {
			const { cdp } = ctx;
			await ctx.open(`/?live=1&token=${TOKEN}`);
			await cdp.eval(HELPERS);

			/* ---- L2 诊断先行：页内直连 fetch /skills（隔离 transport 层与服务端） ---- */
			const direct = await cdp.eval(
				`(async () => {
					const token = window.__CORE_TOKEN__ || new URLSearchParams(location.search).get('token');
					const res = await fetch('/skills', { headers: { Authorization: 'Bearer ' + token } });
					const body = await res.json().catch(() => null);
					return {
						status: res.status,
						ok: body?.ok === true,
						count: Array.isArray(body?.skills) ? body.skills.length : -1,
						names: (body?.skills ?? []).map((s) => s.name),
					};
				})()`,
				true,
			);
			ctx.record("L2_页内直连fetch", direct);

			// 打开设置 → 技能 Tab
			await cdp.eval(`(() => { window.__S.q('[data-testid="sidebar-footer-settings"]').click(); return true; })()`);
			await sleep(450);
			await cdp.eval(`(() => { window.__S.q('[data-testid="settings-tab-skills"]').click(); return true; })()`);
			// 等 live 清单到达（首拉异步；15s 上限）
			await cdp.eval(
				`new Promise((r) => {
					const t0 = Date.now();
					const iv = setInterval(() => {
						if (document.querySelector('${ITEM}')) { clearInterval(iv); r(true); }
						else if (Date.now() - t0 > 15000) { clearInterval(iv); r(false); }
					}, 100);
				})`,
				true,
			);
			await sleep(300);

			const uiDiag = await cdp.eval(`(() => ({
				errRow: window.__S.q('[data-testid="settings-skills-error"]')?.textContent ?? null,
				empty: !!window.__S.q('[data-testid="settings-skills-empty"]'),
				itemCount: window.__S.qa('${ITEM}').length,
				names: window.__S.qa('${ITEM}').map((el) => el.dataset.name),
			}))()`);
			ctx.record("L2_UI诊断", uiDiag);
			failures += ctx.assert("L2 UI 渲染真实清单：demo-skill 条目存在且启用、scope=user", {
				端点直连通: direct.ok === true && direct.names.includes("demo-skill"),
				UI无错误行: uiDiag.errRow === null,
				UI非空态: uiDiag.empty === false,
				条目存在: uiDiag.names.includes("demo-skill"),
			}) ? 0 : 1;

			/* ---- L5：L3 已把技能关掉 → UI 应显示禁用态 ---- */
			{
				await cdp.eval(`(() => {
					window.__S.qa('${ITEM}').find((n) => n.dataset.name === 'demo-skill')?.click();
					return true;
				})()`);
				await sleep(250);
				const r = await cdp.eval(`(() => {
					const el = window.__S.qa('${ITEM}').find((n) => n.dataset.name === 'demo-skill');
					const sw = window.__S.q('[data-testid="settings-skill-toggle"]');
					return {
						found: !!el,
						enabled: el?.dataset.enabled ?? null,
						switchChecked: sw?.getAttribute('aria-checked') ?? null,
					};
				})()`);
				ctx.record("L5_UI_关闭态", r);
				failures += ctx.assert("L5 UI 联动：core 关掉后重开弹窗显示禁用态、开关为关", {
					条目存在: r.found === true,
					enabled为false: r.enabled === "false",
					开关为关: r.switchChecked === "false",
				}) ? 0 : 1;
			}

			/* ---- L6：UI 开关开回（真实链路）→ 条目/开关恢复 + 端点/settings/resources 复核 ---- */
			{
				const swExists = await cdp.eval(`(() => !!window.__S.q('[data-testid="settings-skill-toggle"]'))()`);
				if (swExists) {
					await cdp.eval(`(() => { window.__S.q('[data-testid="settings-skill-toggle"]').click(); return true; })()`);
					// 等切换完成（写 settings + session.reload() + 清单回传）
					await cdp.eval(
						`new Promise((r) => {
							const t0 = Date.now();
							const iv = setInterval(() => {
								const el = [...document.querySelectorAll('${ITEM}')].find((n) => n.dataset.name === 'demo-skill');
								if (el && el.dataset.enabled === 'true') { clearInterval(iv); r(true); }
								else if (Date.now() - t0 > 15000) { clearInterval(iv); r(false); }
							}, 150);
						})`,
						true,
					);
					await sleep(300);
				}
				const uiOn = await cdp.eval(`(() => {
					const el = window.__S.qa('${ITEM}').find((n) => n.dataset.name === 'demo-skill');
					const sw = window.__S.q('[data-testid="settings-skill-toggle"]');
					return {
						itemEnabled: el?.dataset.enabled ?? null,
						switchChecked: sw?.getAttribute('aria-checked') ?? null,
					};
				})()`);
				ctx.record("L6_UI_开回", uiOn);
				failures += ctx.assert("L6 UI 开关开回：条目与开关同步回到启用态", {
					条目为开: uiOn.itemEnabled === "true",
					开关为开: uiOn.switchChecked === "true",
				}) ? 0 : 1;
			}

			ctx.save();
		},
	);

	/* ---- L6 续：settings 模式已移除 + /resources 恢复（端点复核） ---- */
	{
		const settingsAfterOn = readSettings();
		const onArr = Array.isArray(settingsAfterOn?.skills) ? settingsAfterOn.skills : [];
		const onRes = await request("GET", "/skills");
		const onItem = (onRes.json?.skills ?? []).find((s) => s.name === "demo-skill");
		const resourcesOn = await request("GET", "/resources");
		const loadedAgain = (resourcesOn.json?.skills ?? []).some((s) => s.name === "demo-skill");
		ctx_record("L6_settings与resources恢复", {
			settings: settingsAfterOn,
			skills: onRes.json,
			resources: resourcesOn.json,
		});
		failures += recordAssert("L6 开回后：settings 无 `!路径` 模式 + /resources 已加载清单恢复", {
			响应enabled为true: onItem?.enabled === true,
			settings无排除模式: onArr.every((p) => p !== `!${skillPath}`),
			resources恢复: loadedAgain === true,
		}) ? 0 : 1;
	}

	/* ---- L7 toggle 不存在的技能 → 404 + core 原文 ---- */
	{
		const missing = await request("POST", "/skills/toggle", {
			path: path.join(agentDir, "skills", "ghost", "SKILL.md"),
			enabled: false,
		});
		ctx_record("L7_404", missing.json);
		failures += recordAssert("L7 toggle 不存在的技能 → 404 + 错误文案", {
			状态404: missing.status === 404,
			文案含不存在: String(missing.json?.error ?? "").includes("不存在"),
		}) ? 0 : 1;
	}
} catch (e) {
	console.error("[probe-skills] L 段异常：", e.message);
	fs.writeFileSync(evidenceLive, JSON.stringify({ failedAt: "live", error: e.message }, null, 2));
	failures += 1;
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

/* ---- 辅助：无浏览器上下文时的记录/断言（写进证据文件 + 控制台） ---- */
function ctx_record(name, value) {
	console.log(`\n### ${name}\n${JSON.stringify(value, null, 2)}`);
}
function recordAssert(name, detail) {
	return ctx_assert_console(name, detail);
}
function ctx_assert_console(name, detail) {
	const booleans = Object.entries(detail).filter(([, v]) => typeof v === "boolean");
	if (booleans.length === 0) {
		console.log(`\n### [FAIL] ${name}\n  （断言没有任何布尔项）`);
		return false;
	}
	const failed = booleans.filter(([, v]) => !v).map(([k]) => k);
	const pass = failed.length === 0;
	console.log(`\n### [${pass ? "PASS" : "FAIL"}] ${name}\n${JSON.stringify(detail, null, 2)}${failed.length ? `\n  ✗ 未通过：${failed.join(", ")}` : ""}`);
	return pass;
}

console.log(
	failures === 0
		? "\n== probe:settings:skills 全部通过 =="
		: `\n== probe:settings:skills 有 ${failures} 处失败（见上方 ✗ 与证据文件） ==`,
);
process.exit(failures === 0 ? 0 : 1);
