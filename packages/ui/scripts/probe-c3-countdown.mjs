/**
 * C3 探针 —— 授权卡片的「倒计时 / 超时失效态 / 拒绝理由明示」在真实浏览器里的行为。
 *
 * 为什么单独一个探针：这三条是规格书 §1.3 的 UI 交付项，但 §1.5 的三条判据全在 core 侧
 * —— `check:adapter` 只能证明 `timeoutMs` 走到了 Block（新增的 3 项），
 * 而「到点是否真的置灰不可点、文案是否明示后果」只能在 DOM 上看。
 *
 * 手法：mock 形态（**不加** `?live=1`）下用 `window.__chatStore.loadSession` 直接构造
 * 带 / 不带 `timeoutMs` 的授权卡 —— 不起 core、不烧模型、不依赖真实扩展，
 * 纯前端行为验证（与 m2 的 2-8 互补：2-8 锁的是既有 mock 形态不许变，这里锁的是新形态）。
 *
 * 运行前置：packages/ui 下 dev server 存活（默认 5180）。用法：
 *   node scripts/probe-c3-countdown.mjs
 * 证据：`_probe-c3-evidence.json`（含逐步快照与断言汇总）；失败时非 0 退出。
 */

import { withBrowser } from "./cdp.mjs";

const ORIGIN = process.env.PROBE_ORIGIN ?? "http://127.0.0.1:5180";
const PORT = Number(process.env.PROBE_CDP_PORT ?? 9345);
const EVIDENCE = "_probe-c3-evidence.json";

/** 三张卡的构造参数（timeoutMs 用于「到期」与「未到期即点」两条路径） */
const T_EXPIRE = 2500;
const T_CLICK = 8000;

const SEED = `(() => {
  const now = Date.now();
  const card = (id, title, options, timeoutMs) => ({
    id: 'm-' + id, role: 'assistant', timestamp: now,
    blocks: [{ type: 'approval', requestId: 'probe-' + id, title, options,
               ...(timeoutMs ? { timeoutMs } : {}) }],
  });
  window.__chatStore.getState().loadSession({
    id: 'c3-probe', title: 'C3 探针', updatedAt: now,
    messages: [
      card('expire', '到期卡（${T_EXPIRE}ms 后应失效）', ['允许', '拒绝'], ${T_EXPIRE}),
      card('reject', '无倒计时卡（点拒绝）', ['允许', '拒绝'], 0),
      card('click', '未到期即点卡', ['允许', '拒绝'], ${T_CLICK}),
    ],
  });
  return window.__chatStore.getState().messages.length;
})()`;

/** 三张卡的 DOM 快照 */
const SNAPSHOT = `(() => {
  const cards = [...document.querySelectorAll('[data-testid="approval-card"]')];
  return cards.map((card) => {
    const btns = [...card.querySelectorAll('[data-testid^="approval-option-"]')];
    const cd = card.querySelector('[data-testid="approval-countdown"]');
    const reason = card.querySelector('[data-testid="approval-reason"]');
    const title = card.querySelector('div') ? card.querySelector('div').innerText.trim() : '';
    return {
      title,
      resolved: card.dataset.resolved,
      expired: card.dataset.expired,
      optionCount: btns.length,
      allDisabled: btns.length > 0 && btns.every((b) => b.disabled),
      anyEnabled: btns.some((b) => !b.disabled),
      hasCountdown: !!cd,
      countdownText: cd ? cd.innerText.trim() : null,
      reasonText: reason ? reason.innerText.trim() : null,
      innerText: card.innerText,
    };
  });
})()`;

let summary = null;
await withBrowser({ port: PORT, origin: ORIGIN, evidencePath: EVIDENCE }, async (ctx) => {
  await ctx.open("/");
  await ctx.sleep(600);

  const seeded = await ctx.cdp.eval(SEED);
  await ctx.sleep(400);
  ctx.record("注入三张授权卡后 store 消息数", seeded);

  const initial = await ctx.cdp.eval(SNAPSHOT);
  ctx.record("初始快照", initial);

  const expire0 = initial[0];
  ctx.assert("C3[倒计时]", {
    三张卡都渲染: initial.length === 3,
    到期卡有倒计时元素: expire0?.hasCountdown === true,
    倒计时文案含剩余秒: typeof expire0?.countdownText === "string" && expire0.countdownText.includes("剩余"),
    到期卡初始未失效: expire0?.expired === "false" && expire0?.anyEnabled === true,
    无timeout卡不渲染倒计时: initial[1]?.hasCountdown === false,
    无timeout卡未失效且可点: initial[1]?.expired === "false" && initial[1]?.anyEnabled === true,
    无timeout卡保留已选择行结构: initial[1]?.resolved === "false",
  });

  // 未到期就点（T_CLICK=8s）：应正常结算，且倒计时停表（不再显示剩余）
  const clicked = await ctx.cdp.eval(
    `(() => { const c = [...document.querySelectorAll('[data-testid="approval-card"]')][2]; c.querySelector('[data-testid="approval-option-0"]').click(); return true; })()`,
  );
  // 点「拒绝」卡：走 B2 的拒绝理由明示
  await ctx.cdp.eval(
    `(() => { const c = [...document.querySelectorAll('[data-testid="approval-card"]')][1]; c.querySelector('[data-testid="approval-option-1"]').click(); return true; })()`,
  );
  await ctx.sleep(400);
  const afterClick = await ctx.cdp.eval(SNAPSHOT);
  const clickedCard = afterClick[2];
  const rejectCard = afterClick[1];
  ctx.record("点击后快照（未到期即点 / 拒绝）", { clicked, clickedCard, rejectCard });

  ctx.assert("C3[未到期即点]", {
    已结算: clickedCard?.resolved === "true",
    两按钮置灰: clickedCard?.allDisabled === true,
    倒计时停表: clickedCard?.hasCountdown === false,
    理由明示已允许: typeof clickedCard?.reasonText === "string" && clickedCard.reasonText.includes("已允许"),
    保留已选择行: typeof clickedCard?.innerText === "string" && clickedCard.innerText.includes("已选择"),
  });

  ctx.assert("C3[拒绝理由明示]", {
    已结算: rejectCard?.resolved === "true",
    两按钮置灰: rejectCard?.allDisabled === true,
    理由明示已拒绝: typeof rejectCard?.reasonText === "string" && rejectCard.reasonText.includes("已拒绝"),
    保留已选择行: typeof rejectCard?.innerText === "string" && rejectCard.innerText.includes("已选择"),
  });

  // 等到期：自然失效（不做任何交互）
  await ctx.sleep(T_EXPIRE + 600);
  const afterExpire = await ctx.cdp.eval(SNAPSHOT);
  const expiredCard = afterExpire[0];
  ctx.record("到期后快照", expiredCard);

  ctx.assert("C3[超时失效态]", {
    已失效: expiredCard?.expired === "true",
    两按钮置灰不可点: expiredCard?.allDisabled === true && expiredCard?.anyEnabled === false,
    倒计时文案为已超时: expiredCard?.countdownText === "已超时",
    理由明示已超时: typeof expiredCard?.reasonText === "string" && expiredCard.reasonText.includes("已超时"),
    数据未决状态仍为false: expiredCard?.resolved === "false",
  });

  summary = ctx.save(EVIDENCE);
});

console.log(
  summary.failed === 0
    ? `\nC3 UI 探针全部通过（${summary.passed}/${summary.assertions}）`
    : `\nC3 UI 探针失败 ${summary.failed} 项：${summary.failedNames.join("; ")}`,
);
process.exit(summary.failed === 0 ? 0 : 1);
