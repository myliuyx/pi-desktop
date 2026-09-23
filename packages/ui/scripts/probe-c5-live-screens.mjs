/**
 * C5 UI 探针 —— 04 屏 / 05 屏在**真实浏览器 + 真实 core** 下接真数据。
 *
 * core 侧 `check:c5` 的 26 条断言证明的是端点与 settings 落盘；真机上还差三件事：
 *   ① 04 屏 live 形态确实用 `GET /resources` 的三类数据渲染（分组结构不变、条目来自 core）；
 *   ② 04 屏的 MCP 区块仍由 `?mcp=1` 门控（默认不渲染 —— 这条是 C5 改动最容易被误伤的地方）；
 *   ③ 05 屏切换模型 / 思考档位时，**core 侧的 `settings.json` 真的被改写**（UI 可切换 + 写回）。
 *
 * 夹具（临时 agentDir，不落库；user scope 三类资源取自 `core/test/fixtures/resources/`）：
 *   extensions/demo-extension.ts、skills/demo-skill/SKILL.md、prompts/demo-prompt.md
 * 模型清单：**两个 provider 都引 `$ARK_API_KEY`**（`ark-coding` + 合成 `ark-coding-alt`），
 *   这样 `getAvailableSnapshot()` 返回 2 条，才能真的验证「切换」而不只是「重选同一个」。
 *
 * 运行前置：`packages/ui` 下先 `npm run build`。用法：`node scripts/probe-c5-live-screens.mjs`
 * 证据：`packages/ui/_probe-c5-evidence.json`；失败非 0 退出。
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
const fixtureDir = path.join(coreDir, "test", "fixtures", "resources");
const evidencePath = path.join(uiDir, "_probe-c5-evidence.json");

const CORE_PORT = Number(process.env.PROBE_C5_CORE_PORT ?? 5195);
const CDP_PORT = Number(process.env.PROBE_C5_CDP_PORT ?? 9355);
const TOKEN = process.env.PROBE_C5_TOKEN ?? "probe-c5-token";
/** 合成第二个 provider（同一个 env key）—— 让「切换模型」有第二个可选项 */
const ALT_PROVIDER = "ark-coding-alt";
const ALT_MODEL_ID = "deepseek-v4-pro";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "probe-c5-"));
const agentDir = path.join(tmpRoot, "agentdir");
const cwd = path.join(tmpRoot, "project");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
// 无项目本地资源（本探针只验三类 user scope 资源与模型写回；信任门过滤由 check:c5 双向覆盖）
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));
for (const kind of ["extensions", "skills", "prompts"]) {
	fs.cpSync(path.join(fixtureDir, kind), path.join(agentDir, kind), { recursive: true });
}
const modelsPath = path.join(tmpRoot, "models.json");
{
	const src = JSON.parse(fs.readFileSync(modelsSrc, "utf8"));
	const base = src.providers["ark-coding"];
	fs.writeFileSync(
		modelsPath,
		JSON.stringify(
			{
				providers: {
					...src.providers,
					[ALT_PROVIDER]: { ...base, models: [{ ...base.models[0], id: ALT_MODEL_ID, name: "DeepSeek V4 Pro (fixture)" }] },
				},
			},
			null,
			2,
		),
	);
}

const settingsFile = path.join(agentDir, "settings.json");
const readSettings = () => {
	try {
		return JSON.parse(fs.readFileSync(settingsFile, "utf8"));
	} catch {
		return null;
	}
};

function request(method, p) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port: CORE_PORT, path: p, method, headers: { Authorization: `Bearer ${TOKEN}` }, timeout: 20_000 },
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

/** 页内轮询：等某个选择器的条数 ≥ n */
const waitCount = (selector, n, timeout = 20000) => `new Promise((r) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const c = document.querySelectorAll(${JSON.stringify(selector)}).length;
    if (c >= ${n}) { clearInterval(iv); r(c); }
    else if (Date.now() - t0 > ${timeout}) { clearInterval(iv); r(c); }
  }, 100);
})`;

const logFd = fs.openSync(path.join(coreDir, "run", "probe-c5-core.log"), "w");
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

	// 探针自身的对照基线：直接读端点，确认 core 侧数据确实存在
	const resources = (await request("GET", "/resources")).json ?? {};
	const modelsBefore = (await request("GET", "/models")).json ?? {};

	phase = "CDP 驱动浏览器";
	await withBrowser({ port: CDP_PORT, origin: `http://127.0.0.1:${CORE_PORT}`, evidencePath }, async (ctx) => {
		const { cdp } = ctx;
		const A = (name, detail) => {
			try {
				ctx.assert(name, detail);
			} catch (e) {
				ctx.record(`${name}（断言登记异常）`, String(e));
			}
		};

		/* =============================================================== 04 屏 */
		phase = "04 屏：live 渲染真实三类资源";
		await ctx.open(`/?live=1&token=${TOKEN}#/skills`);
		await cdp.eval(waitCount('[data-testid="skill-group"]', 3), true);
		await sleep(300);

		const skills = await cdp.eval(`(() => {
		  const groups = [...document.querySelectorAll('[data-testid="skill-group"]')].map((g) => {
		    const entries = [...g.querySelectorAll('[data-testid="skill-item"]')].map((el) => ({
		      name: el.getAttribute('data-skill-name'),
		      text: (el.innerText || '').trim(),
		    }));
		    return { category: g.dataset.skillCategory, count: entries.length, entries };
		  });
		  const counts = [...document.querySelectorAll('[data-testid="skill-group-count"]')].map((el) => ({
		    type: el.dataset.skillType, text: el.innerText.trim(),
		  }));
		  return {
		    groups,
		    counts,
		    // 页面头（ScreenLayout 的 header 没有 testid，用屏根节点下的 header 取副标题）
		    subtitle: (document.querySelector('[data-testid="skills-screen"] header')?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
		    mcpPresent: !!document.querySelector('[data-testid="mcp-list"]'),
		    trustNotePresent: !!document.querySelector('[data-testid="resources-trust-note"]'),
		    // mock 侧独有条目（见 mock/skills.ts 的扩展组）：真实清单里绝不该出现
		    mockEntryPresent: [...document.querySelectorAll('[data-testid="skill-item"]')]
		      .some((el) => ['desktop-shell', 'preview-pane', 'token-meter', '/research'].includes(el.getAttribute('data-skill-name') || '')),
		  };
		})()`);
		ctx.record("04 屏 DOM 快照", {
			...skills,
			groups: skills.groups.map((g) => ({ ...g, entries: g.entries.map((e) => ({ ...e, text: e.text.slice(0, 40) })) })),
		});

		const namesOf = (cat) => skills.groups.find((g) => g.category === cat)?.entries.map((e) => e.name) ?? [];
		A("C5[04屏] live 用真实三类资源（分组 3 个且各 ≥1 条）", {
			分组数3: skills.groups.length === 3,
			扩展组至少1: namesOf("extension").length >= 1,
			提示词组至少1: namesOf("prompt").length >= 1,
			技能组至少1: namesOf("skill").length >= 1,
			扩展组含夹具: namesOf("extension").includes("demo-extension"),
			提示词组含夹具: namesOf("prompt").includes("/demo-prompt"),
			技能组含夹具: namesOf("skill").includes("demo-skill"),
		});
		A("C5[04屏] 条目来自 core（来源标记「用户目录」；mock 独有条目未出现）", {
			来源为用户目录: skills.groups.every((g) => g.entries.length > 0 && g.entries.every((e) => e.text.includes("用户目录"))),
			无mock条目: skills.mockEntryPresent === false,
			条数标记与条目数一致: skills.groups.every((g) => {
				const c = skills.counts.find((x) => x.type === g.category);
				return c && c.text === `${g.count} 条`;
			}),
		});
		A("C5[04屏] MCP 区块默认仍不渲染（未带 ?mcp=1）", {
			mcp未渲染: skills.mcpPresent === false,
			副标题不含MCP: !skills.subtitle.includes("MCP"),
			信任门说明未出现_本目录无可信任资源: skills.trustNotePresent === false,
		});

		phase = "04 屏：?mcp=1 门控仍然有效（回归）";
		await ctx.open(`/?live=1&token=${TOKEN}&mcp=1#/skills`);
		await cdp.eval(waitCount('[data-testid="mcp-server"]', 1), true);
		const mcp = await cdp.eval(`(() => ({
		  servers: [...document.querySelectorAll('[data-testid="mcp-server"]')].map((el) => el.getAttribute('data-mcp-name')),
		  note: (document.querySelector('[data-testid="mcp-note"]')?.innerText ?? '').trim().slice(0, 60),
		}))()`);
		ctx.record("04 屏 ?mcp=1 快照", mcp);
		A("C5[04屏] ?mcp=1 时 MCP 区块照旧渲染（既有验收 4-4 不受影响）", {
			服务器4个: mcp.servers.length === 4,
			含自建能力说明: mcp.note.includes("自建能力") || mcp.note.length > 0,
		});

		/* ================================================================ 设置弹窗（原 05 屏路由） */
		/*
		 * ⚠️ 口径迁移（2026-09-23，第一批 D1 / D3 修订）：
		 *   `#/settings` 路由已删（改为全局设置弹窗），常规 Tab 里的「模型」组也按 D3 修订删除
		 *   （模型管理走「模型」Tab，选用走工具条上拉菜单）。所以这里不再断言已消失的
		 *   `settings-model-option`，改断三件事：
		 *     ① 「模型」Tab 的 Provider 树读自 core 的 models.json（live 读）；
		 *     ② 「常规」Tab 的思考档位仍是 mock 契约 3 档，点击后写回 core 的 settings.json；
		 *     ③ 负断言：常规 Tab 不再挂模型单选组。
		 *   「切换模型 → 写回 settings.json」这条能力没丢，改由 core 侧 `check:c5` ④ 覆盖。
		 */
		phase = "设置弹窗：live 渲染 core 的 Provider 清单";
		await ctx.open(`/?live=1&token=${TOKEN}`);
		await cdp.eval(`(() => { document.querySelector('[data-testid="sidebar-footer-settings"]').click(); return true; })()`);
		await cdp.eval(waitCount('[data-testid="provider-header"]', 2), true);
		await sleep(600);

		const settings = await cdp.eval(`(() => {
		  const providers = [...document.querySelectorAll('[data-testid="provider-header"]')].map((el) => el.dataset.providerId);
		  const models = [...document.querySelectorAll('[data-testid="model-row"]')].map((el) => el.dataset.modelId);
		  const statusTone = document.querySelector('[data-testid="settings-status"]')?.dataset.tone ?? null;
		  return { providers, models, statusTone };
		})()`);
		ctx.record("设置弹窗 · 模型 Tab 快照", settings);

		/** core 端点 `/models` 去重后的 provider 集合（期望值现读，不写死） */
		const coreProviders = [...new Set((modelsBefore.models ?? []).map((m) => m.provider))].sort();
		const uiProviders = [...settings.providers].sort();
		A("C5[设置弹窗] live Provider 清单来自 core（命中 models.json 的 key、无演示数据）", {
			与端点一致: JSON.stringify(uiProviders) === JSON.stringify(coreProviders),
			含arkCoding: uiProviders.includes("ark-coding"),
			含合成provider: uiProviders.includes(ALT_PROVIDER),
			无演示数据: !settings.providers.some((id) => ["aliyun", "setfun", "local-buddy", "ark-plan"].includes(id)),
			模型行含合成模型id: settings.models.includes(ALT_MODEL_ID),
			状态条非危险态: settings.statusTone === "normal",
		});

		phase = "设置弹窗 · 常规 Tab：思考档位 3 档 + 模型组已迁出";
		await cdp.eval(`(() => { document.querySelector('[data-testid="settings-tab-general"]').click(); return true; })()`);
		await sleep(500);
		const general = await cdp.eval(`(() => ({
		  chips: [...document.querySelectorAll('[data-testid="settings-thinking-option"]')].map((el) => ({
		    level: el.dataset.thinkingLevel, active: el.dataset.active,
		  })),
		  modelOptions: document.querySelectorAll('[data-testid="settings-model-option"]').length,
		}))()`);
		ctx.record("设置弹窗 · 常规 Tab 快照", general);
		A("C5[设置弹窗] 思考档位仍是 mock 契约的 3 档（Low/High/Max，未因 live 改结构）", {
			三档: general.chips.length === 3,
			档位值不变: JSON.stringify(general.chips.map((c) => c.level)) === JSON.stringify(["low", "high", "max"]),
			无mock之外的档位: !general.chips.some((c) => ["off", "minimal", "medium", "xhigh"].includes(c.level)),
			初始无激活_未持久化: general.chips.every((c) => c.active === "false"),
		});
		A("C5[设置弹窗] D3 修订：常规 Tab 不再挂模型单选组（模型管理已迁到「模型」Tab）", {
			常规Tab无模型选项: general.modelOptions === 0,
		});

		phase = "设置弹窗 · 常规 Tab：切换思考档位（写回 settings.json）";
		const clickedThinking = await cdp.eval(`(() => {
		  const el = [...document.querySelectorAll('[data-testid="settings-thinking-option"]')].find((n) => n.dataset.thinkingLevel === 'high');
		  if (!el) return false;
		  el.click();
		  return true;
		})()`);
		await sleep(900);
		const afterThink = readSettings();
		const modelsAfterThink = (await request("GET", "/models")).json ?? {};
		const chipsAfter = await cdp.eval(
			`[...document.querySelectorAll('[data-testid="settings-thinking-option"]')].map((el) => ({ level: el.dataset.thinkingLevel, active: el.dataset.active }))`,
		);
		ctx.record("切换思考档位后", {
			已点击: clickedThinking,
			settings文件: afterThink,
			core_settings: modelsAfterThink.settings,
			chips: chipsAfter,
		});
		A("C5[设置弹窗] 切换思考档位：core 侧 settings.json 实写 defaultThinkingLevel", {
			已点击: clickedThinking === true,
			文件defaultThinkingLevel为high: afterThink?.defaultThinkingLevel === "high",
			端点settings同步: modelsAfterThink.settings?.thinkingLevel === "high",
			UI激活态在high: chipsAfter.find((c) => c.level === "high")?.active === "true",
		});
		ctx.record("core 端 /resources 原始载荷（对照基线）", {
			extensions: (resources.extensions ?? []).map((e) => e.name),
			prompts: (resources.prompts ?? []).map((e) => e.name),
			skills: (resources.skills ?? []).map((e) => e.name),
			trust: resources.trust,
			projectTrustBlocked: resources.projectTrustBlocked,
		});

		summary = ctx.save(evidencePath);
	});

	exitCode = summary && summary.failed === 0 ? 0 : 1;
} catch (e) {
	console.error(`[probe-c5] 异常（阶段：${phase}）：`, e.message);
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
		? `\nC5 UI 探针全部通过（${summary?.passed}/${summary?.assertions}）`
		: `\nC5 UI 探针失败：${summary?.failedNames?.join("; ") ?? "见证据文件"}`,
);
process.exit(exitCode);
