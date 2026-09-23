/**
 * MCP 门控探针 —— 验证「默认关闭、带 `?mcp=1` 恢复」这条交付行为。
 *
 * 为什么需要它（不是可选的补充测试）：
 * `accept:m2` / `accept:m4` 是带 `?mcp=1` 跑的，覆盖的是 **MCP 打开** 分支；
 * 而 2026-09-23 裁决「MCP 暂缓」后**真正发布的形态是关闭态** —— 在此之前
 * **没有任何脚本断言关闭态**。本探针补上这个缺口，防止门控被后来的改动悄悄破坏。
 *
 * 与 `.plan/pi-survey-plan.md` §五纪律的关系：
 * 验收处置选了「保留 mock 分支供回归」，本探针即该分支的守卫
 * （对照 `accept:m2` / `accept:m4` 覆盖打开态）。见 S5「MCP 暂缓处置」。
 *
 * 用法（dev server 已在 5180 时）：
 *   node scripts/probe-mcp-gate.mjs
 *   可覆盖：PROBE_ORIGIN / PROBE_CDP_PORT（默认 5180 / 9344）
 * 产出证据：`_probe-mcp-gate-evidence.json`（与 `_probe-r7-evidence.json` 同惯例）
 *
 * 踩坑备忘：取样必须限定在 04 屏**内容区**（`[data-testid="skills-screen"]`），
 * 不能用 `document.body.innerText` —— 侧边栏会话列表里有一条「整理 MCP 服务器配置」
 * （`mock/sessions.ts:269`），整页取样会把它误判成「区块没关掉」（首轮假失败）。
 */
import { withBrowser, sleep } from "./cdp.mjs";

const ORIGIN = process.env.PROBE_ORIGIN ?? "http://127.0.0.1:5180";
const PORT = Number(process.env.PROBE_CDP_PORT ?? 9344);

await withBrowser({ port: PORT, origin: ORIGIN, evidencePath: "_probe-mcp-gate-evidence.json" }, async (ctx) => {
  const { cdp } = ctx;

  const readSkillsScreen = () =>
    cdp.eval(`(() => {
      // ⚠️ 必须限定在 04 屏**内容区**内取样，不能用 document.body.innerText ——
      //    侧边栏的会话列表里有一条「整理 MCP 服务器配置」（mock/sessions.ts:269），
      //    用整页取样会把它误算成「MCP 区块没被关掉」（首轮就踩了这个假失败）。
      const scope = document.querySelector('[data-testid="skills-screen"]');
      const text = scope ? scope.innerText : "";
      return {
        servers: scope.querySelectorAll('[data-testid="mcp-server"]').length,
        note: !!scope.querySelector('[data-testid="mcp-note"]'),
        list: !!scope.querySelector('[data-testid="mcp-list"]'),
        count: !!scope.querySelector('[data-testid="mcp-count"]'),
        skillGroups: scope.querySelectorAll('[data-testid="skill-group-count"]').length,
        toolToggles: scope.querySelectorAll('[data-testid="tool-toggle"]').length,
        scopeHasMcp: /MCP/.test(text),
      };
    })()`);

  const readToolbar = () =>
    cdp.eval(`(() => ({
      mcpChip: !!document.querySelector('[data-testid="composer-chip-mcp"]'),
      order: [...document.querySelector('[data-testid="composer-toolbar"]').children]
        .map((el) => el.dataset.testid || el.tagName.toLowerCase()),
    }))()`);

  // ① 默认态（无参数）—— 这是发布形态
  await ctx.open("/#/skills");
  await sleep(500);
  const off = await readSkillsScreen();
  await ctx.open("/");
  await sleep(500);
  const offBar = await readToolbar();
  ctx.record("① 默认态 04 屏", off);
  ctx.record("① 默认态 工具条", offBar);

  // ② 带 ?mcp=1 —— 验收回归用的分支
  await ctx.open("/?mcp=1#/skills");
  await sleep(500);
  const on = await readSkillsScreen();
  await ctx.open("/?mcp=1");
  await sleep(500);
  const onBar = await readToolbar();
  ctx.record("② 带 ?mcp=1 的 04 屏", on);
  ctx.record("② 带 ?mcp=1 的工具条", onBar);

  ctx.assert("MCP 门控：默认关闭不渲染，带 ?mcp=1 恢复；且不误伤技能/工具区", {
    默认_零个MCP服务器: off.servers === 0,
    默认_无mcp_note: off.note === false,
    默认_无mcp_list: off.list === false,
    默认_无mcp_count: off.count === false,
    默认_正文不含MCP字样: off.scopeHasMcp === false,
    默认_技能三组仍在: off.skillGroups === 3,
    默认_工具开关仍四个: off.toolToggles === 4,
    默认_工具条无MCP芯片: offBar.mcpChip === false,
    带参数_四个MCP服务器: on.servers === 4,
    带参数_有mcp_note: on.note === true,
    带参数_正文含MCP: on.scopeHasMcp === true,
    带参数_芯片回来了: onBar.mcpChip === true,
    带参数_顺序还原:
      JSON.stringify(onBar.order) ===
      JSON.stringify(["composer-chip-model", "composer-chip-thinking", "composer-chip-mcp", "composer-toolbar-spacer", "token-stats"]),
  });

  const summary = ctx.save("_probe-mcp-gate-evidence.json");
  process.exitCode = summary.failed > 0 ? 1 : 0;
});
