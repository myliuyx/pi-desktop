/**
 * probe:turn-rail —— 会话提问导航刻度栏探针（task-turn-rail.md 步骤 7 · M 段 mock :5180）。
 *
 * 断言：
 * ① 初始（未 hover）：turn-rail 不在 DOM（无常驻遮罩条，决策 2）；
 * ② 左缘 mousemove（clientX ≤ 24）→ turn-rail 出现、data-open="true"、刻度数 = 2
 *    （mock 默认会话恰好两条 user 消息 m1/m6；锚点来自数据层，与虚拟行渲染无关）；
 * ③ 刻度纵向递增（紧凑居中簇：后问的刻度在下方）且都落在刻度栏高度内、上下留白对称；
 * ④ 悬停首个刻度 → turn-preview 出现：问题含该 user 消息原文前缀、回答非空、
 *    时间行含「第 1 问」、pointer-events:none（纯展示，决策 5）；
 * ⑤ 点击刻度 → data-at-bottom 翻 false、scroll-to-bottom 按钮出现、
 *    目标行落视口顶 24px 呼吸位（±64 容差）、行带 message-flash（决策 6）；
 * ⑥ ~1.7s 后 flash 类摘除（计时器无残留）；
 * ⑦ 鼠标移离左缘 → 150ms 宽限后 turn-rail 收起；
 * ⑧ ?stress=40 → 刻度数 = 20（数据层锚点，紧凑簇档距全等）+ 截图。
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

    /* ---- T1 初始无刻度栏 ---- */
    {
      const absent = await cdp.eval(`(() => !window.__R.rail())()`);
      ctx.record("T1_初始无刻度栏", { absent });
      failures += ctx.assert("T1 初始（未悬停）无常驻刻度栏（决策 2：无常驻遮罩条）", {
        初始不渲染: absent === true,
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
        open: window.__R.rail()?.dataset.open ?? null,
        ticks: window.__R.ticks().length,
      }))()`);
      ctx.record("T2_左缘浮现", { rect, ...s });
      failures += ctx.assert("T2 左缘 mousemove 浮现刻度栏，刻度数 = 2（m1/m6 两条提问）", {
        栏出现: s.open === "true",
        刻度数2: s.ticks === 2,
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
          pointerNone: p ? getComputedStyle(p).pointerEvents === "none" : false,
        };
      })()`);
      ctx.record("T4_预览气泡", {
        question: s.question.slice(0, 40),
        answerHead: s.answer.slice(0, 30),
        time: s.time,
        pointerNone: s.pointerNone,
      });
      failures += ctx.assert(
        "T4 悬停刻度出预览：问题原文 + 回答摘要 + 第 N 问 + 纯展示层（决策 5）",
        {
          气泡出现: s.exists === true,
          问题含原文前缀: s.question.includes("帮我调研一下怎么把 Pi 工具链接进我们的桌面 Agent"),
          回答非空: s.answer.length > 0,
          序号正确: s.time.includes("第 1 问"),
          纯展示层: s.pointerNone === true,
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

    /* ---- T7 移离左缘 → 宽限收起 ---- */
    {
      await cdp.eval(`(() => {
        const r = window.__R.root().getBoundingClientRect();
        window.__R.moveAt(r.left + 200, r.top + r.height / 2);
        return true;
      })()`);
      await sleep(450);
      const closed = await cdp.eval(`(() => !window.__R.rail())()`);
      failures += ctx.assert("T7 鼠标移离左缘，150ms 宽限后刻度栏收起", {
        已收起: closed === true,
      })
        ? 0
        : 1;
    }

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
        if (!rail) return { open: null, ticks: 0, gapMin: null, gapMax: null };
        const railTop = rail.getBoundingClientRect().top;
        const ticks = window.__R.ticks();
        const centers = ticks.map(
          (t) => t.getBoundingClientRect().top + t.getBoundingClientRect().height / 2 - railTop,
        );
        const gaps = centers.slice(1).map((c, i) => c - centers[i]);
        return {
          open: rail.dataset.open,
          ticks: ticks.length,
          gapMin: gaps.length ? Math.min(...gaps) : null,
          gapMax: gaps.length ? Math.max(...gaps) : null,
        };
      })()`);
      ctx.record("T8_stress多刻度", s);
      failures += ctx.assert("T8 ?stress=40 会话：刻度数 = 20（数据层锚点，紧凑簇档距全等）", {
        栏出现: s.open === "true",
        刻度20: s.ticks === 20,
        间距全等: s.gapMin !== null && s.gapMax - s.gapMin <= 1.5,
      })
        ? 0
        : 1;
      await cdp.screenshot(path.join(uiDir, "_probe-turn-rail-shot-stress.png"));
    }

    ctx.save();
  });
  console.log("== probe:turn-rail 完成 ==");
} catch (e) {
  console.error("[probe-turn-rail] 异常：", e.message);
  failures += 1;
}

process.exit(failures > 0 ? 1 : 0);
