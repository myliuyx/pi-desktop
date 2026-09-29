/**
 * shots-add-views.mjs —— 「添加技能 / 添加插件」右栏表单视图截图（S3/S4 视觉验收用）。
 * 前置：dev server :5180。输出：_shots-add-skill.png / _shots-add-plugin.png。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser, sleep } from "./cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(here, "..");

const HELPERS = `
window.__S = { q: (s) => document.querySelector(s), qa: (s) => [...document.querySelectorAll(s)] };
true;
`;

await withBrowser({ port: 9358 }, async (ctx) => {
	const { cdp } = ctx;
	await ctx.open("/");
	await cdp.eval(HELPERS);

	await cdp.eval(`(() => { window.__S.q('[data-testid="sidebar-footer-settings"]').click(); return true; })()`);
	await sleep(450);

	// 添加技能视图
	await cdp.eval(`(() => { window.__S.q('[data-testid="settings-tab-skills"]').click(); return true; })()`);
	await sleep(350);
	await cdp.eval(`(() => { window.__S.q('[data-testid="settings-skill-add"]').click(); return true; })()`);
	await sleep(350);
	await cdp.screenshot(path.join(uiDir, "_shots-add-skill.png"));

	// 添加插件视图
	await cdp.eval(`(() => { window.__S.q('[data-testid="settings-tab-plugins"]').click(); return true; })()`);
	await sleep(350);
	await cdp.eval(`(() => { window.__S.q('[data-testid="settings-plugin-add"]').click(); return true; })()`);
	await sleep(350);
	await cdp.screenshot(path.join(uiDir, "_shots-add-plugin.png"));

	console.log("截图完成：_shots-add-skill.png / _shots-add-plugin.png");
});
