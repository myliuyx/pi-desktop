/**
 * R7 探针 —— 会话内容列居中 + 输入区全宽还原（2026-09-22 双裁决）。
 *
 * 裁决轨迹（防回退，重要）：
 * ① 用户要求「会话内容居中显示，且注意左右两侧收起展开的状态」→
 *    MessageList 内层虚拟容器 maxWidth=720 + 左右 auto margin，在内容区内居中，
 *    折叠组合变化时由 flexbox 自动重排、无需按状态补偿。
 * ② 首版实施把 Composer 也拉进同一列（composer-area maxWidth=768 + auto margin），
 *    实测被挤成 ~180px 内容宽的小盒 —— 根因：composer-area 是 flex-col 的子项，
 *    **交叉轴 auto margin 会禁用 align-items:stretch**，盒子退化为 fit-content。
 *    用户随即裁决「底部输入框相关的还原成原来的样子」→ composer-area 全宽还原，
 *    仅消息流居中。本探针同时锁定这两条：列居中 + 输入区贴边。
 *
 * 四种折叠状态（点击真实按钮驱动）：
 *   双展开 → 仅收左 → 双收 → 仅收右（→ 复位双展开）。
 * 每态断言：
 *   - 消息列中心 ≈ 工作区中心（±8px；全局滚动条 10px 使消息流内容盒左移 5px，
 *     属固有偏差，容差覆盖，不改滚动条）；
 *   - composer-area 全宽贴边（左右边缘与工作区重合 ±1px）；
 *   - composer-toolbar 距工作区左右边缘各 24px（±2px，即 padding 语义未变）；
 *   - 无横向溢出（workspace 与 document 两级）。
 *
 * 运行前置：dev server 5180 存活（M2_ORIGIN 同源）。用法：
 *   node scripts/probe-r7.mjs
 */
import { withBrowser } from "./cdp.mjs";

const ORIGIN = process.env.PROBE_ORIGIN ?? "http://127.0.0.1:5180";
const PORT = 9344;
const EVIDENCE = "_probe-r7-evidence.json";

/** 消息列居中容差（px）：10px 滚动条 → 内容盒中心左偏 5px，8px 给采样留余量 */
const TOL_CENTER = 8;
/** 输入区贴边容差（px） */
const TOL_EDGE = 2;
/** toolbar 距边缘的期望内边距 = MESSAGE_LIST_PADDING */
const EXPECTED_INSET = 24;

/** 每态测量：关键节点几何 + 溢出 + 折叠状态 */
const MEASURE = `(() => {
  const q = (t) => document.querySelector('[data-testid="' + t + '"]');
  const ws = q("workspace-area"), item = q("message-item"), toolbar = q("composer-toolbar"),
        area = q("composer-area"), sidebar = q("sidebar"), preview = q("preview-pane"),
        list = q("message-list");
  const has = { ws: !!ws, item: !!item, toolbar: !!toolbar, area: !!area, list: !!list,
                sidebar: !!sidebar, preview: !!preview };
  if (Object.values(has).some((v) => !v)) return { error: "missing node", has };
  const r = (el) => {
    const b = el.getBoundingClientRect();
    return { left: +b.left.toFixed(2), right: +b.right.toFixed(2),
             width: +b.width.toFixed(2), cx: +((b.left + b.right) / 2).toFixed(2) };
  };
  return {
    ws: r(ws), msg: r(item), toolbar: r(toolbar), area: r(area),
    sidebarCollapsed: sidebar.dataset.collapsed === "true",
    previewCollapsed: preview.dataset.collapsed === "true",
    wsOverflowX: ws.scrollWidth > ws.clientWidth,
    docOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
})()`;

/** 单态断言 */
function assertState(ctx, label, m, expect) {
  const stateOk = m.sidebarCollapsed === expect.sidebar && m.previewCollapsed === expect.preview;
  const msgCentered = Math.abs(m.msg.cx - m.ws.cx) <= TOL_CENTER;
  const areaFullLeft = Math.abs(m.area.left - m.ws.left) <= 1;
  const areaFullRight = Math.abs(m.ws.right - m.area.right) <= 1;
  const toolbarInsetLeft = Math.abs(m.toolbar.left - m.ws.left - EXPECTED_INSET) <= TOL_EDGE;
  const toolbarInsetRight = Math.abs(m.ws.right - m.toolbar.right - EXPECTED_INSET) <= TOL_EDGE;
  const noOverflowX = !m.wsOverflowX && !m.docOverflowX;
  ctx.assert(`R7[${label}]`, {
    [`stateOk(侧收=${expect.sidebar},预收=${expect.preview})`]: stateOk,
    [`msgCentered(|Δ|≤${TOL_CENTER}px, Δ=${(m.msg.cx - m.ws.cx).toFixed(1)})`]: msgCentered,
    [`areaFullWidth(左Δ=${(m.area.left - m.ws.left).toFixed(1)},右Δ=${(m.ws.right - m.area.right).toFixed(1)})`]:
      areaFullLeft && areaFullRight,
    [`toolbarInset24(左=${(m.toolbar.left - m.ws.left).toFixed(1)},右=${(m.ws.right - m.toolbar.right).toFixed(1)})`]:
      toolbarInsetLeft && toolbarInsetRight,
    noOverflowX,
  });
}

await withBrowser({ port: PORT, origin: ORIGIN, evidencePath: EVIDENCE }, async (ctx) => {
  await ctx.open("/");
  ctx.record("首次测量（双展开）", await ctx.cdp.eval(MEASURE));

  const click = (testid) =>
    ctx.cdp.eval(`document.querySelector('[data-testid="${testid}"]').click(); true`);
  const measure = () => ctx.cdp.eval(MEASURE);
  const settle = () => ctx.sleep(600); // 折叠动画 180ms，留足余量

  // S1 双展开（初始态即为此）
  assertState(ctx, "双展开", await measure(), { sidebar: false, preview: false });

  // 补充断言：我方气泡内容自适应宽、贴右（2026-09-22 三次裁决，参考截图）
  const bubbles = await ctx.cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('[data-testid="message-item"][data-role="user"]')];
    const list = document.querySelector('[data-testid="message-list"]');
    const infos = rows.map((row) => {
      const inner = row.firstElementChild;
      const wrap = inner.lastElementChild;
      const r = wrap.getBoundingClientRect();
      const ir = inner.getBoundingClientRect();
      return {
        width: +r.width.toFixed(1),
        colWidth: +ir.width.toFixed(1),
        rightGap: +(ir.right - r.right).toFixed(2),
      };
    });
    return {
      userRows: rows.length,
      infos,
      allRightAligned: infos.every((x) => Math.abs(x.rightGap) <= 2),
      someNotFull: infos.some((x) => x.width < x.colWidth - 40),
      listOverflowX: list.scrollWidth > list.clientWidth,
    };
  })()`);
  ctx.record("我方气泡几何", bubbles);
  ctx.assert("R7[我方气泡]", {
    存在我方消息: bubbles.userRows > 0,
    我方气泡全部贴右: bubbles.allRightAligned === true,
    我方气泡内容自适应不占满: bubbles.someNotFull === true,
    无横向溢出: bubbles.listOverflowX === false,
  });

  // R9：发送按钮图标光学居中（2026-09-22）——lucide Send 质心偏右上，
  // svg 几何居中（Δ=0）不等于视觉居中，Composer 给字形加了半量反向 translate。
  // ⚠️ 期望值须与 lib/layout.ts 的 SEND_ICON_OPTICAL_SHIFT_X/Y 同步，改常量必改这里。
  const EXPECTED_SHIFT_X = -0.5;
  const EXPECTED_SHIFT_Y = 0.5;
  const icon = await ctx.cdp.eval(`(() => {
    const btn = document.querySelector('[data-testid="composer-send"]');
    const svg = btn.querySelector('svg');
    const wrap = svg.parentElement;
    const b = btn.getBoundingClientRect(), s = svg.getBoundingClientRect();
    const m = new DOMMatrixReadOnly(getComputedStyle(wrap).transform === "none" ? "" : getComputedStyle(wrap).transform);
    return {
      dxSvg: +(s.x + s.width / 2 - (b.x + b.width / 2)).toFixed(2),
      dySvg: +(s.y + s.height / 2 - (b.y + b.height / 2)).toFixed(2),
      tx: +m.e.toFixed(2),
      ty: +m.f.toFixed(2),
    };
  })()`);
  ctx.record("R9 发送图标光学偏移", icon);
  ctx.assert("R9[发送图标]", {
    声明偏移已应用: icon.tx === EXPECTED_SHIFT_X && icon.ty === EXPECTED_SHIFT_Y,
    svg偏移与声明一致: Math.abs(icon.dxSvg - icon.tx) <= 0.3 && Math.abs(icon.dySvg - icon.ty) <= 0.3,
  });

  // S2 仅收左
  await click("titlebar-toggle-sidebar");
  await settle();
  assertState(ctx, "仅收左", await measure(), { sidebar: true, preview: false });

  // S3 双收
  await click("titlebar-toggle-preview");
  await settle();
  assertState(ctx, "双收", await measure(), { sidebar: true, preview: true });

  // S4 仅收右
  await click("titlebar-toggle-sidebar");
  await settle();
  assertState(ctx, "仅收右", await measure(), { sidebar: false, preview: true });

  // 复位：回到双展开，并复核与初始态一致（折叠循环不残留位移）
  await click("titlebar-toggle-preview");
  await settle();
  assertState(ctx, "复位双展开", await measure(), { sidebar: false, preview: false });

  ctx.save(EVIDENCE);
});
