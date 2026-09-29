/**
 * probe:settings:plugins —— 设置弹窗「插件」Tab 验收探针（C8 · task-settings-skills-plugins.md 批次 B）。
 *
 * 两段：
 * - M 段（mock，dev server :5180）：
 *   · P1 包树分组（全局）+ 条目展示名（git: 原样 / 本地 → local/<目录名>）+ 默认选中；
 *   · P2 详情字段齐全（状态 Loaded / 版本 已安装 6.3.0 / 资源 1扩展·14技能 / 包名 /
 *     安装路径 / CWD=全局）+ 开关为开 + 重新加载会话/移除按钮；
 *   · P3 已解析资源分节（扩展 1 + 技能 14，首条 brainstorming）；
 *   · P4 底部统计条「2 ext · 14 skills · 0 prompts · 0 themes」+ 检查更新/刷新 + 添加插件钉底；
 *   · P5 mock 开关本地翻转（关→开→关）；
 *   · P6 mock 移除两步确认（移除 → 确认移除 → 条目消失）；
 *   · P7 添加插件 → 右栏表单视图（S3，参考图2：Source 输入 / Examples 点击回填 /
 *     scope 切换路径副标题变化 / mock 安装 → notice「live 可用」/ 点条目回详情）。
 * - L 段（live，临时 agentDir + 本地路径夹具包，真实 core :5197，dist 同源托管，全程离线）：
 *   · L1 GET /packages 清单正确（status=installed / 版本 1.2.3 / resourceSummary=1技能 / totals）；
 *   · L2 UI 渲染真实包（版本「已安装 1.2.3」、状态 Installed、CWD=全局、技能分节 demo-skill）；
 *   · L3 UI 关开关 → settings 写 `{source, autoload:false}` + /resources 已加载技能消失
 *     + /skills 该条 enabled=false（session.reload() 生效）；
 *   · L4 UI 开开关 → settings 塌回纯字符串 + /resources 恢复；
 *   · L5 UI 移除两步确认 → settings 条目删除 + GET /packages 清空；
 *   · L6 UI「添加插件」表单安装本地路径包（S3，离线）→ 条目恢复 + settings 写回 + 退回详情；
 *   · L7 检查更新 → notice「全部插件已是最新」（本地包跳过，不出网）；
 *   · L8 install 不存在的本地路径 → 500 + core 原文「Path does not exist」；
 *   · L9 POST /session/reload → 200。
 *
 * 运行前置：M 段需 packages/ui dev server（:5180）；L 段需先 `npm run build`。
 * CDP 端口 9347/9357（错开 9345/9346/9355/9356）。证据：_probe-settings-plugins-evidence-*.json。
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
/** ⚠️ 必须绝对路径：core 的 cwd 会被指到临时目录（probe-c5 首跑实踩） */
const mainPath = path.join(coreDir, "src", "main.ts");
const fixtureSkill = path.join(coreDir, "test", "fixtures", "resources", "skills", "demo-skill");
const evidenceMock = path.join(uiDir, "_probe-settings-plugins-evidence-mock.json");
const evidenceLive = path.join(uiDir, "_probe-settings-plugins-evidence-live.json");

const CORE_PORT = Number(process.env.PROBE_PLUGINS_CORE_PORT ?? 5197);
const CDP_MOCK = Number(process.env.PROBE_PLUGINS_CDP_M ?? 9347);
const CDP_LIVE = Number(process.env.PROBE_PLUGINS_CDP_L ?? 9357);
const TOKEN = process.env.PROBE_PLUGINS_TOKEN ?? "probe-plugins-token";

const HELPERS = `
window.__S = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
};
true;
`;

const ITEM = '[data-testid="settings-plugin-item"]';

let failures = 0;

/* ============================================================ M 段 · mock（:5180） */
try {
	await withBrowser({ port: CDP_MOCK, evidencePath: evidenceMock }, async (ctx) => {
		const { cdp } = ctx;
		await ctx.open("/");
		await cdp.eval(HELPERS);

		await cdp.eval(`(() => { window.__S.q('[data-testid="sidebar-footer-settings"]').click(); return true; })()`);
		await sleep(450);
		await cdp.eval(`(() => { window.__S.q('[data-testid="settings-tab-plugins"]').click(); return true; })()`);
		await sleep(400);

		/* ---- P1 包树分组 + 展示名 + 默认选中 ---- */
		{
			const r = await cdp.eval(`(() => {
				const tree = window.__S.q('[data-testid="settings-plugins-tree"]');
				const items = window.__S.qa('${ITEM}');
				return {
					treeExists: !!tree,
					groupLabels: tree ? [...tree.querySelectorAll('section > p')].map((el) => el.textContent.trim()) : [],
					names: items.map((el) => el.textContent.trim()),
					count: items.length,
					firstSelected: items[0]?.classList.contains('bg-bg-active') === true,
				};
			})()`);
			ctx.record("P1_包树", r);
			failures += ctx.assert("P1 包树分组（全局）+ 展示名（git: 原样 / 本地 local/<目录名>）+ 默认选中首项", {
				树存在: r.treeExists === true,
				分组为全局: JSON.stringify(r.groupLabels) === JSON.stringify(["全局"]),
				条目数2: r.count === 2,
				首条git原样: r.names[0] === "git:github.com/obra/superpowers",
				次条local前缀: r.names[1] === "local/pi-think-zh",
				默认选中: r.firstSelected === true,
			})
				? 0
				: 1;
		}

		/* ---- P2 详情字段 + 开关 + 操作按钮 ---- */
		{
			const r = await cdp.eval(`(() => {
				const detail = window.__S.q('[data-testid="settings-plugin-detail"]');
				const field = (label) => (window.__S.q('[data-testid="settings-plugin-field-' + label + '"]')?.textContent || '').trim();
				return {
					detailExists: !!detail,
					badge: (detail?.querySelector('span')?.textContent || '').trim(),
					sourceTitle: (detail?.querySelector('span.font-mono')?.textContent || '').trim(),
					描述: field('描述'),
					状态: field('状态'),
					版本: field('版本'),
					包: field('包'),
					资源: field('资源'),
					安装路径: field('安装路径'),
					CWD: field('CWD'),
					reloadBtn: !!detail?.querySelector('[data-testid="settings-plugin-reload"]'),
					removeBtn: !!detail?.querySelector('[data-testid="settings-plugin-remove"]'),
					switchChecked: detail?.querySelector('[data-testid="settings-plugin-toggle"]')?.getAttribute('aria-checked') ?? null,
				};
			})()`);
			ctx.record("P2_详情字段", r);
			failures += ctx.assert("P2 详情字段齐全：Loaded/已安装 6.3.0/1扩展·14技能/CWD=全局 + 开关与操作按钮", {
				详情存在: r.detailExists === true,
				徽标global: r.badge === "global",
				source标题: r.sourceTitle === "git:github.com/obra/superpowers",
				描述正确: r.描述.includes("Superpowers") === true,
				状态Loaded: r.状态 === "Loaded",
				版本已安装: r.版本 === "已安装 6.3.0",
				包名: r.包 === "superpowers",
				资源摘要: r.资源 === "1扩展·14技能",
				安装路径: r.安装路径.includes("superpowers") === true,
				CWD全局: r.CWD === "全局",
				重载按钮: r.reloadBtn === true,
				移除按钮: r.removeBtn === true,
				开关为开: r.switchChecked === "true",
			})
				? 0
				: 1;
		}

		/* ---- P3 已解析资源分节 ---- */
		{
			const r = await cdp.eval(`(() => {
				const detail = window.__S.q('[data-testid="settings-plugin-detail"]');
				const sections = [...(detail?.querySelectorAll('div.border-t') ?? [])];
				const extSection = sections.find((s) => (s.querySelector('p')?.textContent || '') === '扩展');
				const skillSection = sections.find((s) => (s.querySelector('p')?.textContent || '') === '技能');
				const skillEntries = [...(skillSection?.querySelectorAll('[data-testid="settings-plugin-resource"]') ?? [])];
				return {
					扩展首条: (extSection?.querySelector('li p')?.textContent || '').trim(),
					技能条数: skillEntries.length,
					技能首条: (skillEntries[0]?.querySelector('p')?.textContent || '').trim(),
				};
			})()`);
			ctx.record("P3_解析资源", r);
			failures += ctx.assert("P3 已解析资源分节：扩展 1 条（superpowers）+ 技能 14 条（首条 brainstorming）", {
				扩展首条: r.扩展首条 === "superpowers",
				技能14条: r.技能条数 === 14,
				技能首条: r.技能首条 === "brainstorming",
			})
				? 0
				: 1;
		}

		/* ---- P4 底部统计条 + 添加插件钉底 ---- */
		{
			const r = await cdp.eval(`(() => {
				const footer = window.__S.q('[data-testid="settings-packages-footer"]');
				const tree = window.__S.q('[data-testid="settings-plugins-tree"]');
				const addBtn = tree?.querySelector('[data-testid="settings-plugin-add"]');
				const treeRect = tree?.getBoundingClientRect();
				const btnRect = addBtn?.getBoundingClientRect();
				return {
					summary: (footer?.querySelector('p')?.textContent || '').trim(),
					检查更新: !!footer?.querySelector('[data-testid="settings-packages-check-updates"]'),
					刷新: !!footer?.querySelector('[data-testid="settings-packages-refresh"]'),
					添加插件: !!addBtn,
					钉底: treeRect && btnRect ? Math.abs(treeRect.bottom - btnRect.bottom) < 40 : false,
				};
			})()`);
			ctx.record("P4_统计条", r);
			failures += ctx.assert("P4 统计条「2 ext · 14 skills · 0 prompts · 0 themes」+ 检查更新/刷新 + 添加插件钉底", {
				统计文案: r.summary === "2 ext · 14 skills · 0 prompts · 0 themes",
				检查更新按钮: r.检查更新 === true,
				刷新按钮: r.刷新 === true,
				添加插件按钮: r.添加插件 === true,
				钉在栏底: r.钉底 === true,
			})
				? 0
				: 1;
		}

		/* ---- P5 mock 开关本地翻转 ---- */
		{
			await cdp.eval(`(() => { window.__S.q('[data-testid="settings-plugin-toggle"]').click(); return true; })()`);
			await sleep(250);
			const afterOff = await cdp.eval(`(() => ({
				itemEnabled: window.__S.qa('${ITEM}')[0]?.dataset.enabled ?? null,
				switchChecked: window.__S.q('[data-testid="settings-plugin-toggle"]')?.getAttribute('aria-checked') ?? null,
				summary: (window.__S.q('[data-testid="settings-packages-footer"] p')?.textContent || '').trim(),
			}))()`);
			await cdp.eval(`(() => { window.__S.q('[data-testid="settings-plugin-toggle"]').click(); return true; })()`);
			await sleep(250);
			const afterOn = await cdp.eval(`(() => ({
				itemEnabled: window.__S.qa('${ITEM}')[0]?.dataset.enabled ?? null,
				switchChecked: window.__S.q('[data-testid="settings-plugin-toggle"]')?.getAttribute('aria-checked') ?? null,
			}))()`);
			ctx.record("P5_mock开关", { afterOff, afterOn });
			failures += ctx.assert("P5 mock 开关本地翻转：关→开（条目/开关/统计同步）", {
				关后条目禁用: afterOff.itemEnabled === "false",
				关后开关为关: afterOff.switchChecked === "false",
				关后统计ext为1: afterOff.summary.startsWith("1 ext") === true,
				开后条目启用: afterOn.itemEnabled === "true",
				开后开关为开: afterOn.switchChecked === "true",
			})
				? 0
				: 1;
		}

		/* ---- P7 添加插件：右栏表单视图（S3，参考图2；先于 P6：P6 会删条目改变状态） ---- */
		{
			await cdp.eval(`(() => { window.__S.q('[data-testid="settings-plugin-add"]').click(); return true; })()`);
			await sleep(350);
			const opened = await cdp.eval(`(() => {
				const view = window.__S.q('[data-testid="settings-plugin-add-view"]');
				return {
					viewExists: !!view,
					detailGone: !window.__S.q('[data-testid="settings-plugin-detail"]'),
					input: !!view?.querySelector('[data-testid="settings-package-install-source"]'),
					confirm: !!view?.querySelector('[data-testid="settings-package-install-confirm"]'),
					scope: view?.querySelector('[data-testid="settings-plugin-scope"]')?.dataset.scope ?? null,
					pathHint: (view?.querySelector('[data-testid="settings-plugin-path-hint"]')?.textContent || '').trim(),
					examples: [...(view?.querySelectorAll('[data-testid="settings-plugin-example"]') ?? [])].map((el) => el.dataset.value),
					标题: (view?.querySelector('p')?.textContent || '').trim(),
				};
			})()`);
			// 点 Examples 第二条 → 输入框回填
			await cdp.eval(`(() => { window.__S.qa('[data-testid="settings-plugin-example"]')[1].click(); return true; })()`);
			await sleep(150);
			const filled = await cdp.eval(
				`(() => window.__S.q('[data-testid="settings-package-install-source"]')?.value ?? null)()`,
			);
			// 切 project → 路径副标题变化
			await cdp.eval(`(() => {
				window.__S.qa('[data-testid="settings-plugin-scope"] [data-scope-value="project"]')[0].click();
				return true;
			})()`);
			await sleep(200);
			const hintProject = await cdp.eval(
				`(() => (window.__S.q('[data-testid="settings-plugin-path-hint"]')?.textContent || '').trim())()`,
			);
			// mock 安装 → notice「live 可用」（停留添加视图）
			await cdp.eval(`(() => { window.__S.q('[data-testid="settings-package-install-confirm"]').click(); return true; })()`);
			await sleep(350);
			const notice = await cdp.eval(`(() => {
				const items = window.__S.qa('[data-testid="notice-item"]');
				return { count: items.length, text: (items[items.length - 1]?.textContent || '').trim() };
			})()`);
			// 点左树条目 → 回详情视图
			await cdp.eval(`(() => { window.__S.qa('${ITEM}')[0].click(); return true; })()`);
			await sleep(250);
			const back = await cdp.eval(`(() => ({
				detailBack: !!window.__S.q('[data-testid="settings-plugin-detail"]'),
				addViewGone: !window.__S.q('[data-testid="settings-plugin-add-view"]'),
			}))()`);
			ctx.record("P7_添加插件视图", { opened, filled, hintProject, notice, back });
			failures += ctx.assert("P7 添加插件 → 右栏表单：Source 输入/ Examples 点击回填 / scope 切换副标题变化 / mock 安装提示仅 live / 点条目回详情", {
				表单视图出现: opened.viewExists === true,
				详情已让位: opened.detailGone === true,
				Source输入框: opened.input === true,
				安装按钮: opened.confirm === true,
				scope默认global: opened.scope === "user",
				路径副标题全局: opened.pathHint.includes("~/.pi/agent/") === true,
				Examples三条: opened.examples.length === 3 && opened.examples[0] === "npm:@scope/pi-plugin",
				标题添加插件: opened.标题 === "添加插件",
				Example回填: filled === "git:https://github.com/user/repo",
				切project副标题变化: hintProject.startsWith(".pi/") === true,
				mock安装notice: notice.count > 0 && notice.text.includes("mock") === true,
				点条目回详情: back.detailBack === true && back.addViewGone === true,
			})
				? 0
				: 1;
		}

		/* ---- P6 mock 移除两步确认（放在最后：删条目改变状态） ---- */
		{
			const before = await cdp.eval(`(() => window.__S.qa('${ITEM}').length)()`);
			await cdp.eval(`(() => { window.__S.q('[data-testid="settings-plugin-remove"]').click(); return true; })()`);
			await sleep(200);
			const confirmText = await cdp.eval(
				`(() => (window.__S.q('[data-testid="settings-plugin-remove"]')?.textContent || '').trim())()`,
			);
			await cdp.eval(`(() => { window.__S.q('[data-testid="settings-plugin-remove"]').click(); return true; })()`);
			await sleep(300);
			const after = await cdp.eval(`(() => window.__S.qa('${ITEM}').length)()`);
			ctx.record("P6_两步移除", { before, confirmText, after });
			failures += ctx.assert("P6 mock 移除两步确认：移除 → 确认移除 → 条目消失", {
				初始2条: before === 2,
				一步后文案: confirmText === "确认移除",
				确认后1条: after === 1,
			})
				? 0
				: 1;
		}

		ctx.save();
	});
	console.log("== M 段（mock）完成 ==");
} catch (e) {
	console.error("[probe-plugins] M 段异常：", e.message);
	failures += 1;
}

/* ============================================================ L 段 · live（临时 core :5197） */

// 本地路径夹具包：package.json + 约定 skills/ 目录（离线可装可卸）
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-plugins-"));
const agentDir = path.join(tmpRoot, "agentdir");
const cwd = path.join(tmpRoot, "project");
const fixturePkg = path.join(tmpRoot, "fixture-pkg");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(path.join(fixturePkg, "skills"), { recursive: true });
fs.writeFileSync(
	path.join(fixturePkg, "package.json"),
	JSON.stringify(
		{ name: "probe-demo-pkg", version: "1.2.3", description: "C8 夹具插件（本地路径包，离线验收用）" },
		null,
		2,
	),
);
fs.cpSync(fixtureSkill, path.join(fixturePkg, "skills", "demo-skill"), { recursive: true });

const settingsFile = path.join(agentDir, "settings.json");
fs.writeFileSync(
	settingsFile,
	JSON.stringify({ defaultProjectTrust: "never", packages: [fixturePkg] }, null, 2),
);
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

function record(name, value) {
	console.log(`\n### ${name}\n${JSON.stringify(value, null, 2)}`);
}
function assertConsole(name, detail) {
	const booleans = Object.entries(detail).filter(([, v]) => typeof v === "boolean");
	if (booleans.length === 0) {
		console.log(`\n### [FAIL] ${name}（断言没有任何布尔项）`);
		return false;
	}
	const failed = booleans.filter(([, v]) => !v).map(([k]) => k);
	const pass = failed.length === 0;
	console.log(
		`\n### [${pass ? "PASS" : "FAIL"}] ${name}\n${JSON.stringify(detail, null, 2)}${failed.length ? `\n  ✗ 未通过：${failed.join(", ")}` : ""}`,
	);
	return pass;
}

const logFd = fs.openSync(path.join(coreDir, "run", "probe-plugins-core.log"), "w");
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

	/* ---- L1 GET /packages 清单 ---- */
	const pkgRes = await request("GET", "/packages");
	const pkg = (pkgRes.json?.packages ?? [])[0];
	record("L1_packages端点", pkgRes.json);
	failures += assertConsole("L1 GET /packages 清单正确（本地夹具包）", {
		状态200: pkgRes.status === 200,
		包存在: !!pkg,
		source一致: pkg?.source === fixturePkg,
		enabled: pkg?.enabled === true,
		scope_user: pkg?.scope === "user",
		状态installed: pkg?.status === "installed",
		包名: pkg?.name === "probe-demo-pkg",
		版本: pkg?.version === "1.2.3",
		资源摘要: pkg?.resourceSummary === "1技能",
		技能条目: pkg?.resources?.skills?.[0]?.name === "demo-skill",
		totals技能1: pkgRes.json?.totals?.skills === 1,
		totals扩展0: pkgRes.json?.totals?.extensions === 0,
	})
		? 0
		: 1;

	/* ---- L2-L7 UI 段 ---- */
	await withBrowser(
		{ port: CDP_LIVE, origin: `http://127.0.0.1:${CORE_PORT}`, evidencePath: evidenceLive },
		async (ctx) => {
			const { cdp } = ctx;
			await ctx.open(`/?live=1&token=${TOKEN}`);
			await cdp.eval(HELPERS);

			await cdp.eval(`(() => { window.__S.q('[data-testid="sidebar-footer-settings"]').click(); return true; })()`);
			await sleep(450);
			await cdp.eval(`(() => { window.__S.q('[data-testid="settings-tab-plugins"]').click(); return true; })()`);
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

			/* ---- L2 UI 渲染真实包 ---- */
			{
				const r = await cdp.eval(`(() => {
					const items = window.__S.qa('${ITEM}');
					const detail = window.__S.q('[data-testid="settings-plugin-detail"]');
					const field = (label) => (window.__S.q('[data-testid="settings-plugin-field-' + label + '"]')?.textContent || '').trim();
					const skillEntries = [...(detail?.querySelectorAll('[data-testid="settings-plugin-resource"]') ?? [])];
					return {
						found: items.length === 1,
						displayName: (items[0]?.textContent || '').trim(),
						sourceAttr: items[0]?.dataset.source ?? null,
						状态: field('状态'),
						版本: field('版本'),
						资源: field('资源'),
						CWD: field('CWD'),
						技能条目: skillEntries.some((el) => (el.textContent || '').includes('demo-skill')),
					};
				})()`);
				record("L2_UI渲染", r);
				failures += ctx.assert("L2 UI 渲染真实包：local/<目录名> 展示、Installed/已安装 1.2.3/1技能、CWD=全局、技能分节", {
					条目存在: r.found === true,
					展示名local前缀: r.displayName.startsWith("local/fixture-pkg") === true,
					dataSource原样: r.sourceAttr === fixturePkg,
					状态Installed: r.状态 === "Installed",
					版本已安装: r.版本 === "已安装 1.2.3",
					资源摘要: r.资源 === "1技能",
					CWD全局: r.CWD === "全局",
					技能分节: r.技能条目 === true,
				})
					? 0
					: 1;
			}

			/* ---- L3 UI 关开关 ---- */
			{
				await cdp.eval(`(() => { window.__S.q('[data-testid="settings-plugin-toggle"]').click(); return true; })()`);
				await cdp.eval(
					`new Promise((r) => {
						const t0 = Date.now();
						const iv = setInterval(() => {
							const el = document.querySelector('${ITEM}');
							if (el && el.dataset.enabled === 'false') { clearInterval(iv); r(true); }
							else if (Date.now() - t0 > 15000) { clearInterval(iv); r(false); }
						}, 150);
					})`,
					true,
				);
				await sleep(300);
				const settings = readSettings();
				const entry = (settings?.packages ?? [])[0];
				const resources = await request("GET", "/resources");
				const skillsFull = await request("GET", "/skills");
				const skillItem = (skillsFull.json?.skills ?? []).find((s) => s.name === "demo-skill");
				record("L3_关开关", { settings, resourcesSkills: resources.json?.skills, skillItem });
				failures += ctx.assert("L3 UI 关开关：settings 写 {source, autoload:false} + /resources 技能消失 + /skills enabled=false", {
					条目禁用: (await cdp.eval(`(() => document.querySelector('${ITEM}')?.dataset.enabled ?? null)()`)) === "false",
					settings对象形: typeof entry === "object" && entry?.autoload === false && entry?.source === fixturePkg,
					resources技能消失: (resources.json?.skills ?? []).some((s) => s.name === "demo-skill") === false,
					// 包禁用 = applyPackageDeltaFilter 不加任何资源 → 其技能从全量清单**整体消失**（pi 语义）
					skills清单条目消失: skillItem === undefined,
				})
					? 0
					: 1;
			}

			/* ---- L4 UI 开开关 ---- */
			{
				await cdp.eval(`(() => { window.__S.q('[data-testid="settings-plugin-toggle"]').click(); return true; })()`);
				await cdp.eval(
					`new Promise((r) => {
						const t0 = Date.now();
						const iv = setInterval(() => {
							const el = document.querySelector('${ITEM}');
							if (el && el.dataset.enabled === 'true') { clearInterval(iv); r(true); }
							else if (Date.now() - t0 > 15000) { clearInterval(iv); r(false); }
						}, 150);
					})`,
					true,
				);
				await sleep(300);
				const settings = readSettings();
				const resources = await request("GET", "/resources");
				record("L4_开开关", { settings, resourcesSkills: resources.json?.skills });
				failures += ctx.assert("L4 UI 开开关：settings 塌回纯字符串 + /resources 技能恢复", {
					条目启用: (await cdp.eval(`(() => document.querySelector('${ITEM}')?.dataset.enabled ?? null)()`)) === "true",
					settings纯字符串: JSON.stringify(settings?.packages ?? []) === JSON.stringify([fixturePkg]),
					resources技能恢复: (resources.json?.skills ?? []).some((s) => s.name === "demo-skill") === true,
				})
					? 0
					: 1;
			}

			/* ---- L5 UI 移除两步确认 ---- */
			{
				await cdp.eval(`(() => { window.__S.q('[data-testid="settings-plugin-remove"]').click(); return true; })()`);
				await sleep(200);
				const confirmText = await cdp.eval(
					`(() => (window.__S.q('[data-testid="settings-plugin-remove"]')?.textContent || '').trim())()`,
				);
				await cdp.eval(`(() => { window.__S.q('[data-testid="settings-plugin-remove"]').click(); return true; })()`);
				await cdp.eval(
					`new Promise((r) => {
						const t0 = Date.now();
						const iv = setInterval(() => {
							if (!document.querySelector('${ITEM}')) { clearInterval(iv); r(true); }
							else if (Date.now() - t0 > 15000) { clearInterval(iv); r(false); }
						}, 150);
					})`,
					true,
				);
				await sleep(300);
				const settings = readSettings();
				const after = await request("GET", "/packages");
				record("L5_移除", { confirmText, settings, count: after.json?.packages?.length });
				failures += ctx.assert("L5 UI 移除两步确认：条目消失 + settings 条目删除 + 清单清空", {
					一步后确认文案: confirmText === "确认移除",
					条目消失: (await cdp.eval(`(() => document.querySelector('${ITEM}') === null)()`)) === true,
					settings条目已删: (settings?.packages ?? []).length === 0,
					清单清空: (after.json?.packages ?? []).length === 0,
				})
					? 0
					: 1;
			}

			/* ---- L6 UI「添加插件」表单安装本地路径包（S3 离线） ---- */
			{
				await cdp.eval(`(() => { window.__S.q('[data-testid="settings-plugin-add"]').click(); return true; })()`);
				await sleep(350);
				await cdp.eval(`(() => {
					const input = window.__S.q('[data-testid="settings-package-install-source"]');
					const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
					set.call(input, ${JSON.stringify(fixturePkg)});
					input.dispatchEvent(new Event('input', { bubbles: true }));
					return true;
				})()`);
				await sleep(150);
				await cdp.eval(`(() => { window.__S.q('[data-testid="settings-package-install-confirm"]').click(); return true; })()`);
				await cdp.eval(
					`new Promise((r) => {
						const t0 = Date.now();
						const iv = setInterval(() => {
							if (document.querySelector('${ITEM}')) { clearInterval(iv); r(true); }
							else if (Date.now() - t0 > 20000) { clearInterval(iv); r(false); }
						}, 150);
					})`,
					true,
				);
				await sleep(300);
				const settings = readSettings();
				const resources = await request("GET", "/resources");
				const back = await cdp.eval(`(() => ({
					addViewGone: !window.__S.q('[data-testid="settings-plugin-add-view"]'),
					detailBack: !!window.__S.q('[data-testid="settings-plugin-detail"]'),
				}))()`);
				record("L6_安装", { settings, resourcesSkills: resources.json?.skills, back });
				failures += ctx.assert("L6 UI 添加插件（本地路径，离线）：条目恢复 + settings 写回 + 成功后退回详情视图", {
					条目恢复: (await cdp.eval(`(() => !!document.querySelector('${ITEM}'))()`)) === true,
					// pi 的 addSourceToSettings 会把本地路径相对化存储（L6 首跑实测 `..\fixture-pkg`）
					settings写回: (settings?.packages ?? []).length === 1 && path.resolve(cwd, settings.packages[0]) === path.resolve(fixturePkg),
					表单退回详情: back.addViewGone === true && back.detailBack === true,
					resources技能加载: (resources.json?.skills ?? []).some((s) => s.name === "demo-skill") === true,
				})
					? 0
					: 1;
			}

			/* ---- L7 检查更新（本地包跳过，不出网） ---- */
			{
				await cdp.eval(`(() => { window.__S.q('[data-testid="settings-packages-check-updates"]').click(); return true; })()`);
				await sleep(1200);
				const notice = await cdp.eval(`(() => {
					const items = window.__S.qa('[data-testid="notice-item"]');
					return { count: items.length, text: (items[items.length - 1]?.textContent || '').trim() };
				})()`);
				record("L7_检查更新", notice);
				failures += ctx.assert("L7 检查更新：本地包跳过 → notice「全部插件已是最新」", {
					notice弹出: notice.count > 0,
					文案最新: notice.text.includes("已是最新") === true,
				})
					? 0
					: 1;
			}

			ctx.save();
		},
	);

	/* ---- L8 install 不存在的本地路径 → 500 + core 原文 ---- */
	{
		const ghost = await request("POST", "/packages/install", { source: path.join(tmpRoot, "ghost-pkg") });
		record("L8_安装不存在路径", { status: ghost.status, json: ghost.json });
		failures += assertConsole("L8 install 不存在的本地路径 → 500 + core 原文", {
			状态500: ghost.status === 500,
			文案含不存在: String(ghost.json?.error ?? "").includes("Path does not exist"),
		})
			? 0
			: 1;
	}

	/* ---- L9 POST /session/reload → 200 ---- */
	{
		const reload = await request("POST", "/session/reload", {});
		failures += assertConsole("L9 POST /session/reload → 200", {
			状态200: reload.status === 200,
			ok: reload.json?.ok === true,
		})
			? 0
			: 1;
	}
} catch (e) {
	console.error("[probe-plugins] L 段异常：", e.message);
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

console.log(
	failures === 0
		? "\n== probe:settings:plugins 全部通过 =="
		: `\n== probe:settings:plugins 有 ${failures} 处失败（见上方 ✗ 与证据文件） ==`,
);
process.exit(failures === 0 ? 0 : 1);
