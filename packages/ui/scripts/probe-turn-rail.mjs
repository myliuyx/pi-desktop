/**
 * probe:turn-rail —— 会话提问导航刻度栏探针（task-turn-rail.md 步骤 7 · M 段 mock :5180）。
 * 常显（task-turn-rail-always-visible.md）后刻度栏恒渲染，T7（移离收起）随之退役。
 *
 * 断言：
 * ① 常显：进会话（无任何 mousemove）turn-rail 即渲染（翻转原「初始不在 DOM」）；
 * ② 刻度数 = 2（mock 默认会话 m1/m6 两条 user 消息，数据层锚点）+ 统一箭头光标；
 * ③ 刻度纵向递增（紧凑居中簇：后问的刻度在下方）且都落在刻度栏高度内、上下留白对称；
 * ④ 悬停首个刻度 → turn-preview 出现：问题含该 user 消息原文前缀、回答非空、
 *    时间行含「第 1 问」、pointer-events:auto（可交互，预览交互修订）；
 * ⑤ 点击刻度 → data-at-bottom 翻 false、scroll-to-bottom 按钮出现、
 *    目标行落视口顶 24px 呼吸位（±64 容差）、行带 message-flash（决策 6）；
 * ⑥ ~1.7s 后 flash 类摘除（计时器无残留）；
 * ⑧ ?stress=40 → 刻度数 = 20（数据层锚点，紧凑簇档距全等）+ 截图；
 * ⑨ 离列 → 气泡宽限桥：rail mouseout 起 150ms 宽限 → mouseover 气泡取消 → 300ms 后
 *    气泡仍在；mouseout 气泡 → 气泡收起（task-turn-rail-preview-interaction.md）；
 * ⑩ 走廊粘滞：列内移到非刻度区 300ms 气泡保持、内容不变；rail mouseout 离列 → 气泡收起、
 *    栏常显（task-turn-rail-sticky-column.md）；
 * ⑪ 粘滞区定界：界内（两刻度之间）保持；越出刻度簇上方 60px → 150ms 宽限后气泡收起、
 *    栏常显（task-turn-rail-corridor-bound.md）；
 * ⑫ 扫动节流：快速扫过（各 <80ms）气泡内容不逐颗换、停下 ≥80ms 后结算为停留那颗
 *    （task-turn-rail-smooth-sweep.md）。
 *
 * 运行前置：packages/ui dev server（:5180，cdp.mjs 自检并提示启动命令）。
 * 证据：_probe-turn-rail-evidence.json；截图 _probe-turn-rail-shot-{preview,rail,stress}.png；
 * 失败非 0 退出。坑（沿用 cdp.mjs 备忘）：断言值必须 true/false；点击一律 el.click()。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser, sleep } from "./cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(here, "..");
const evidencePath = path.join(uiDir, "_probe-turn-rail-evidence.json");

const CDP = Number(process.env.PROBE_TURN_RAIL_CDP ?? 9370);

/** 页内助手（probe:settings 同款 q/qa 范式 + 刻度栏专用取件器与 mousemove 注入） */
const HELPERS = `
window.__R = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  rail: () => window.__R.q('[data-testid="turn-rail"]'),
  ticks: () => window.__R.qa('[data-testid="turn-tick"]'),
  list: () => window.__R.q('[data-testid="message-list"]'),
  root: () => window.__R.list()?.parentElement,
  moveAt(clientX, clientY) {
    window.__R.root().dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX, clientY }),
    );
  },
};
true;
`;

let failures = 0;

try {
  await withBrowser({ port: CDP, origin: "http://127.0.0.1:5180", evidencePath }, async (ctx) => {
    const { cdp } = ctx;
    await ctx.open("/");
    await cdp.eval(HELPERS);

    /* ---- T1 常显：初始即渲染（无任何 mousemove） ---- */
    {
      const present = await cdp.eval(`(() => !!window.__R.rail())()`);
      ctx.record("T1_常显初始渲染", { present });
      failures += ctx.assert("T1 进会话即常显，无需鼠标靠近左缘（常显翻转决策 2）", {
        初始即渲染: present === true,
      })
        ? 0
        : 1;
    }

    /* ---- T2 左缘邻近 → 浮现；刻度数 = mock 会话 user 消息数 ---- */
    {
      const rect = await cdp.eval(`(() => {
        const r = window.__R.root().getBoundingClientRect();
        window.__R.moveAt(r.left + 8, r.top + r.height / 2);
        return { w: r.width, h: r.height };
      })()`);
      await sleep(250);
      const s = await cdp.eval(`(() => ({
        ticks: window.__R.ticks().length,
        tickCursor: window.__R.ticks()[0] ? getComputedStyle(window.__R.ticks()[0]).cursor : null,
        railCursor: window.__R.rail() ? getComputedStyle(window.__R.rail()).cursor : null,
      }))()`);
      ctx.record("T2_常显刻度数", { rect, ...s });
      failures += ctx.assert("T2 常显刻度数 = 2（m1/m6 两条提问）+ 统一箭头光标", {
        刻度数2: s.ticks === 2,
        统一箭头: s.tickCursor === "default" && s.railCursor !== "pointer",
      })
        ? 0
        : 1;
    }

    /* ---- T3 刻度纵向递增 + 上下留白对称（紧凑居中簇） ---- */
    {
      const s = await cdp.eval(`(() => {
        const rail = window.__R.rail();
        const rh = rail.clientHeight;
        const railTop = rail.getBoundingClientRect().top;
        const tops = window.__R.ticks().map(
          (t) => t.getBoundingClientRect().top + t.getBoundingClientRect().height / 2 - railTop,
        );
        return { rh, tops };
      })()`);
      ctx.record("T3_紧凑居中簇", s);
      failures += ctx.assert("T3 刻度纵向递增 + 上下留白对称（紧凑居中簇，第二次修订）", {
        递增: s.tops.length === 2 && s.tops[1] > s.tops[0],
        都在栏内: s.tops.every((t) => t >= 0 && t <= s.rh),
        上下对称: Math.abs(s.tops[0] - (s.rh - s.tops[1])) <= 1.5,
      })
        ? 0
        : 1;
    }

    /* ---- T4 悬停首刻度 → 预览气泡 ---- */
    {
      await cdp.eval(`(() => {
        const tick = window.__R.ticks()[0];
        const r = tick.getBoundingClientRect();
        const opts = { bubbles: true, clientX: r.left + 5, clientY: r.top + 1 };
        tick.dispatchEvent(new MouseEvent("mouseover", opts));
        tick.dispatchEvent(new MouseEvent("mousemove", opts));
        return true;
      })()`);
      await sleep(250);
      const s = await cdp.eval(`(() => {
        const p = window.__R.q('[data-testid="turn-preview"]');
        return {
          exists: !!p,
          question: p?.querySelector('[data-testid="turn-preview-question"]')?.textContent ?? "",
          answer: p?.querySelector('[data-testid="turn-preview-answer"]')?.textContent ?? "",
          time: p?.querySelector('[data-testid="turn-preview-time"]')?.textContent ?? "",
          pointerAuto: p ? getComputedStyle(p).pointerEvents === "auto" : false,
        };
      })()`);
      ctx.record("T4_预览气泡", {
        question: s.question.slice(0, 40),
        answerHead: s.answer.slice(0, 30),
        time: s.time,
        pointerAuto: s.pointerAuto,
      });
      failures += ctx.assert(
        "T4 悬停刻度出预览：问题原文 + 回答摘要 + 第 N 问 + 可交互（预览交互修订）",
        {
          气泡出现: s.exists === true,
          问题含原文前缀: s.question.includes("帮我调研一下怎么把 Pi 工具链接进我们的桌面 Agent"),
          回答非空: s.answer.length > 0,
          序号正确: s.time.includes("第 1 问"),
          可交互: s.pointerAuto === true,
        },
      )
        ? 0
        : 1;
      await cdp.screenshot(path.join(uiDir, "_probe-turn-rail-shot-preview.png"));
    }

    /* ---- T5 点击跳转 ---- */
    {
      const before = await cdp.eval(
        `(() => ({ top: window.__R.list().scrollTop, atBottom: window.__R.list().dataset.atBottom }))()`,
      );
      await cdp.eval(`(() => { window.__R.ticks()[0].click(); return true; })()`);
      await sleep(450);
      const after = await cdp.eval(`(() => {
        const list = window.__R.list();
        const row = window.__R.q('[data-message-id="m1"]');
        const lr = list.getBoundingClientRect();
        const rr = row?.getBoundingClientRect();
        return {
          top: list.scrollTop,
          atBottom: list.dataset.atBottom,
          hasJumpBtn: !!window.__R.q('[data-testid="scroll-to-bottom"]'),
          rowOffset: rr ? rr.top - lr.top : null,
          flash: !!window.__R.q(".message-flash"),
        };
      })()`);
      ctx.record("T5_点击跳转", { before, after });
      failures += ctx.assert(
        "T5 点击刻度跳转到该次提问：贴底翻 false + 回到底部按钮 + 落点闪烁（决策 6）",
        {
          位置变化: after.top !== before.top,
          贴底翻false: after.atBottom === "false",
          回底按钮出现: after.hasJumpBtn === true,
          落点近顶24px: after.rowOffset !== null && Math.abs(after.rowOffset - 24) <= 64,
          闪烁类在: after.flash === true,
        },
      )
        ? 0
        : 1;
      await cdp.screenshot(path.join(uiDir, "_probe-turn-rail-shot-rail.png"));
    }

    /* ---- T6 闪烁摘除 ---- */
    {
      await sleep(1300);
      const flashGone = await cdp.eval(`(() => !window.__R.q(".message-flash"))()`);
      failures += ctx.assert("T6 闪烁 1.2s 后类名由计时器摘除（无残留）", {
        无残留: flashGone === true,
      })
        ? 0
        : 1;
    }

    /* T7（移离左缘 → 宽限收起）已随常显退役：rail 恒渲染，不再有收起语义。 */

    /* ---- T8 stress：多刻度紧凑簇 ---- */
    {
      await ctx.open("/?stress=40");
      await cdp.eval(HELPERS);
      await cdp.eval(`(() => {
        const r = window.__R.root().getBoundingClientRect();
        window.__R.moveAt(r.left + 8, r.top + r.height / 2);
        return true;
      })()`);
      await sleep(300);
      const s = await cdp.eval(`(() => {
        const rail = window.__R.rail();
        if (!rail) return { open: false, ticks: 0, gapMin: null, gapMax: null };
        const railTop = rail.getBoundingClientRect().top;
        const ticks = window.__R.ticks();
        const centers = ticks.map(
          (t) => t.getBoundingClientRect().top + t.getBoundingClientRect().height / 2 - railTop,
        );
        const gaps = centers.slice(1).map((c, i) => c - centers[i]);
        return {
          open: true,
          ticks: ticks.length,
          gapMin: gaps.length ? Math.min(...gaps) : null,
          gapMax: gaps.length ? Math.max(...gaps) : null,
        };
      })()`);
      ctx.record("T8_stress多刻度", s);
      failures += ctx.assert("T8 ?stress=40 会话：刻度数 = 20（数据层锚点，紧凑簇档距全等）", {
        栏常显: s.open === true,
        刻度20: s.ticks === 20,
        间距全等: s.gapMin !== null && s.gapMax - s.gapMin <= 1.5,
      })
        ? 0
        : 1;
      await cdp.screenshot(path.join(uiDir, "_probe-turn-rail-shot-stress.png"));
    }

    /* ---- T9 预览悬停保持：刻度 → 气泡宽限桥 + 离开即收 ---- */
    {
      await ctx.open("/");
      await cdp.eval(HELPERS);
      await cdp.eval(`(() => {
        const r = window.__R.root().getBoundingClientRect();
        window.__R.moveAt(r.left + 8, r.top + r.height / 2);
        return true;
      })()`);
      await sleep(300);
      // 悬停首刻度，等气泡渲染出来（setHover 异步，同帧取不到 portal 节点）
      await cdp.eval(`(() => {
        const tick = window.__R.ticks()[0];
        const tr = tick.getBoundingClientRect();
        const opts = { bubbles: true, clientX: tr.left + 5, clientY: tr.top + 1 };
        tick.dispatchEvent(new MouseEvent("mouseover", opts));
        tick.dispatchEvent(new MouseEvent("mousemove", opts));
        return true;
      })()`);
      await sleep(200);
      // 离列（rail mouseout，走廊粘滞后收起扳机在列缘）→ 同帧移入气泡（取消宽限）
      const bridged = await cdp.eval(`(() => {
        const rail = window.__R.rail();
        const bubble = window.__R.q('[data-testid="turn-preview"]');
        if (!bubble) return { noBubble: true };
        const br = bubble.getBoundingClientRect();
        rail.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
        const bOpts = { bubbles: true, clientX: br.left + 10, clientY: br.top + 10 };
        bubble.dispatchEvent(new MouseEvent("mouseover", bOpts));
        bubble.dispatchEvent(new MouseEvent("mousemove", bOpts));
        return { noBubble: false };
      })()`);
      ctx.record("T9_桥派发", bridged);
      await sleep(300);
      const s1 = await cdp.eval(`(() => ({
        bubble: !!window.__R.q('[data-testid="turn-preview"]'),
        rail: !!window.__R.rail(),
      }))()`);
      ctx.record("T9_悬停保持", s1);
      failures += ctx.assert("T9 离列→气泡宽限桥：移入气泡 300ms 后气泡仍在（栏常显）", {
        气泡保持: s1.bubble === true,
        栏常显: s1.rail === true,
      })
        ? 0
        : 1;
      // 移出气泡 → 立即收起
      await cdp.eval(`(() => {
        const bubble = window.__R.q('[data-testid="turn-preview"]');
        if (!bubble) return false;
        const br = bubble.getBoundingClientRect();
        const opts = { bubbles: true, clientX: br.left + 10, clientY: br.top + 10 };
        bubble.dispatchEvent(new MouseEvent("mouseout", opts));
        bubble.dispatchEvent(new MouseEvent("mouseleave", opts));
        return true;
      })()`);
      await sleep(250);
      const s2 = await cdp.eval(`(() => ({ bubble: !!window.__R.q('[data-testid="turn-preview"]') }))()`);
      ctx.record("T9_离开气泡收起", s2);
      failures += ctx.assert("T9 移出气泡 → 预览立即收起", {
        气泡收起: s2.bubble === false,
      })
        ? 0
        : 1;
    }

    /* ---- T10 走廊粘滞：列内移动不丢气泡 + 离列收起 ---- */
    {
      await ctx.open("/");
      await cdp.eval(HELPERS);
      await cdp.eval(`(() => {
        const r = window.__R.root().getBoundingClientRect();
        window.__R.moveAt(r.left + 8, r.top + r.height / 2);
        return true;
      })()`);
      await sleep(300);
      // 悬停首刻度，等气泡渲染（setHover 异步，同帧取不到 portal 节点）
      await cdp.eval(`(() => {
        const tick = window.__R.ticks()[0];
        const tr = tick.getBoundingClientRect();
        const opts = { bubbles: true, clientX: tr.left + 5, clientY: tr.top + 1 };
        tick.dispatchEvent(new MouseEvent("mouseover", opts));
        tick.dispatchEvent(new MouseEvent("mousemove", opts));
        return true;
      })()`);
      await sleep(200);
      // 列内移到非刻度区（rail 中点，两刻度之间的空隙）→ 气泡应保持、内容不变
      const sticky = await cdp.eval(`(() => {
        const rail = window.__R.rail();
        const bubble = window.__R.q('[data-testid="turn-preview"]');
        if (!bubble) return { noBubble: true };
        const rr = rail.getBoundingClientRect();
        const question =
          bubble.querySelector('[data-testid="turn-preview-question"]')?.textContent ?? "";
        rail.dispatchEvent(
          new MouseEvent("mousemove", {
            bubbles: true,
            clientX: rr.left + 10,
            clientY: rr.top + rr.height / 2,
          }),
        );
        return { noBubble: false, question: question.slice(0, 30) };
      })()`);
      await sleep(300);
      const s1 = await cdp.eval(`(() => {
        const bubble = window.__R.q('[data-testid="turn-preview"]');
        return {
          bubble: !!bubble,
          question:
            (bubble?.querySelector('[data-testid="turn-preview-question"]')?.textContent ?? "").slice(0, 30),
        };
      })()`);
      ctx.record("T10_走廊粘滞", { sticky, s1 });
      failures += ctx.assert("T10 走廊粘滞：列内移到非刻度区 300ms 后气泡仍在、内容不变", {
        气泡保持: s1.bubble === true,
        内容不变: s1.question === sticky.question,
      })
        ? 0
        : 1;
      // 离列（rail mouseout）→ 宽限后收起
      await cdp.eval(`(() => {
        window.__R.rail().dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
        return true;
      })()`);
      await sleep(400);
      const s2 = await cdp.eval(
        `(() => ({ bubble: !!window.__R.q('[data-testid="turn-preview"]'), rail: !!window.__R.rail() }))()`,
      );
      ctx.record("T10_离列收起", s2);
      failures += ctx.assert("T10 离开列 → 预览收起、刻度栏仍常显", {
        气泡收起: s2.bubble === false,
        栏常显: s2.rail === true,
      })
        ? 0
        : 1;
    }

    /* ---- T11 粘滞区定界：越出刻度簇即收 ---- */
    {
      await ctx.open("/");
      await cdp.eval(HELPERS);
      await cdp.eval(`(() => {
        const r = window.__R.root().getBoundingClientRect();
        window.__R.moveAt(r.left + 8, r.top + r.height / 2);
        return true;
      })()`);
      await sleep(300);
      // 悬停首刻度（簇顶端），等气泡渲染
      await cdp.eval(`(() => {
        const tick = window.__R.ticks()[0];
        const tr = tick.getBoundingClientRect();
        const opts = { bubbles: true, clientX: tr.left + 5, clientY: tr.top + 1 };
        tick.dispatchEvent(new MouseEvent("mouseover", opts));
        tick.dispatchEvent(new MouseEvent("mousemove", opts));
        return true;
      })()`);
      await sleep(200);
      // 界内 sanity：移到两刻度之间（簇内空隙）→ 气泡保持
      await cdp.eval(`(() => {
        const rail = window.__R.rail();
        const rr = rail.getBoundingClientRect();
        rail.dispatchEvent(
          new MouseEvent("mousemove", { bubbles: true, clientX: rr.left + 10, clientY: rr.top + rr.height / 2 }),
        );
        return true;
      })()`);
      await sleep(200);
      const s1 = await cdp.eval(`(() => ({ bubble: !!window.__R.q('[data-testid="turn-preview"]') }))()`);
      // 越界：首刻度中心上方 60px（粘滞区外）→ 150ms 宽限后收
      await cdp.eval(`(() => {
        const rail = window.__R.rail();
        const tick = window.__R.ticks()[0];
        const rr = rail.getBoundingClientRect();
        const tr = tick.getBoundingClientRect();
        rail.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, clientX: rr.left + 10, clientY: tr.top - 60 }),
      );
      return true;
    })()`);
      // 两段宽限：预览 150ms → hover 清 → hold 释放 → 刻度栏再 150ms；500ms 留足余量
      await sleep(500);
      const s2 = await cdp.eval(
        `(() => ({ bubble: !!window.__R.q('[data-testid="turn-preview"]'), rail: !!window.__R.rail() }))()`,
      );
      ctx.record("T11_粘滞区定界", { 界内气泡保持: s1.bubble, 越界后: s2 });
      failures += ctx.assert("T11 粘滞区定界：界内保持、越出刻度簇上方后气泡收起（栏常显）", {
        界内保持: s1.bubble === true,
        越界收起: s2.bubble === false,
        栏常显: s2.rail === true,
      })
        ? 0
        : 1;
    }

    /* ---- T12 扫动节流：快速扫过不逐颗换内容、停下后结算 ---- */
    {
      await ctx.open("/");
      await cdp.eval(HELPERS);
      await cdp.eval(`(() => {
        const r = window.__R.root().getBoundingClientRect();
        window.__R.moveAt(r.left + 8, r.top + r.height / 2);
        return true;
      })()`);
      await sleep(300);
      // 悬停刻度 0，等节流结算
      await cdp.eval(`(() => {
        const tick = window.__R.ticks()[0];
        const tr = tick.getBoundingClientRect();
        const opts = { bubbles: true, clientX: tr.left + 5, clientY: tr.top + 1 };
        tick.dispatchEvent(new MouseEvent("mouseover", opts));
        tick.dispatchEvent(new MouseEvent("mousemove", opts));
        return true;
      })()`);
      await sleep(250);
      const q0 = await cdp.eval(
        `(() => (window.__R.q('[data-testid="turn-preview-question"]')?.textContent ?? "").slice(0, 30))()`,
      );
      // 快速扫 1→0→1（同一帧内，节流窗不断重置），停在刻度 1
      await cdp.eval(`(() => {
        const ticks = window.__R.ticks();
        for (const i of [1, 0, 1]) {
          const tr = ticks[i].getBoundingClientRect();
          const opts = { bubbles: true, clientX: tr.left + 5, clientY: tr.top + 1 };
          ticks[i].dispatchEvent(new MouseEvent("mouseover", opts));
          ticks[i].dispatchEvent(new MouseEvent("mousemove", opts));
        }
        return true;
      })()`);
      // 立即读（CDP 往返 ~20ms < 80ms 节流窗）：内容应仍是刻度 0 的
      const mid = await cdp.eval(
        `(() => (window.__R.q('[data-testid="turn-preview-question"]')?.textContent ?? "").slice(0, 30))()`,
      );
      // 停下 ≥80ms → 结算为刻度 1
      await sleep(250);
      const q1 = await cdp.eval(
        `(() => (window.__R.q('[data-testid="turn-preview-question"]')?.textContent ?? "").slice(0, 30))()`,
      );
      ctx.record("T12_扫动节流", { q0, mid, q1 });
      failures += ctx.assert("T12 扫动节流：快速扫过内容不逐颗换、停下后结算为停留刻度", {
        扫动中不换: mid === q0,
        停下结算: q1 !== q0 && q1.length > 0,
      })
        ? 0
        : 1;
    }

    ctx.save();
  });
  console.log("== probe:turn-rail 完成 ==");
} catch (e) {
  console.error("[probe-turn-rail] 异常：", e.message);
  failures += 1;
}

process.exit(failures > 0 ? 1 : 0);
