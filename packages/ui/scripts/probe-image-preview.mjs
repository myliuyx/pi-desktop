/**
 * 图片预览端到端 CDP 探针 —— `probe:image-preview`。
 *
 * 写作方：**验收方（非实现方）** —— 项目铁律「验收脚本必须由非实现方写」。
 * 因此本文件**只从规格与已冻结的 testid 推导断言**，不读 `packages/ui/src/**` 的实现细节。
 *
 * 规格：`docs/superpowers/plans/2026-10-01-paste-image-preview.md` Task 8；
 * 设计：`docs/superpowers/specs/2026-10-01-paste-image-preview-design.md`
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★★ 本探针是本批的**硬门禁**：它是「聊天历史图片 + 大图预览」整条链路的
 *     **唯一端到端证据**。核心那一环是
 *       imageUrl(block, token) → GET /sessions/image?...&token=… → 字节
 *       → 浏览器解码 → <img>.naturalWidth > 0
 *     在此之前**从未被真正跑通过**（前一个 implementer 实测时拿不到含图会话）。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ★★★ 最重要的一条纪律：**不允许静默跳过** ★★★
 * brief 原文的探针是
 *     if (hasHistoryImage) { /* ② ③ 断言在这里 *\/ }
 * —— 整段包在条件里，`hasHistoryImage` 为 false 时**整段跳过、探针仍报「全过」**，
 * 本批最大的验证缺口会被静默吞掉。
 * 本脚本改为：**取不到含图历史消息 ⇒ 判红 + 非零退出**，并在输出里写明
 * 「未能在 live 会话中找到含图历史消息 —— 取图链路未获验证」。
 * 见 `C0` 断言。
 *
 * 判据
 * ├─ C0  前置闸门：确实找到含图历史消息（找不到即判红，见上）
 * ├─ C1  历史图是**真缩略图元素**（`message-image-thumb` 存在）+ 缩略图 `<img>` 自然宽 > 0
 * ├─ C2  `[图片]` 占位文本已从页面消失（core 不再产出那个文本块）
 * ├─ C3  点击缩略图 ⇒ 弹层出现 ⇒ 弹层内大图 `naturalWidth > 0`
 * ├─ C4  真实 Esc 键（CDP `Input.dispatchKeyEvent`）⇒ 弹层从 DOM 移除
 * ├─ C5  焦点归还：`document.activeElement` 回到那个缩略图，**不是 body**
 * ├─ C6  composer 待发区：粘贴 ⇒ 缩略图可点开大图（dataUrl 通道，与历史图通道对照）
 * ├─ C7  点「移除」不误开预览（且图确实被移除）
 * └─ C8  坏坐标不崩：不存在的 entryId ⇒ 404（不是 500）、core 进程不死、页面不崩
 *
 * 关于 C8 的来历：前一版取图端点有个 Critical —— 恶意/非法 mimeType 会让
 * `writeHead` 抛 `ERR_INVALID_CHAR`，**整个 core 进程死亡**。已修（Content-Type
 * 过白名单）。C8 正是这个修复的回归守卫：它必须看到 404 而不是 500。
 *
 * 前置条件（⚠️ 与既有 probe 的关键差异）
 * ────────────────────────────────────────────────────────────────────────────
 * **必须打真实 live core（同源托管 dist 形态）**：`PROBE_ORIGIN=http://127.0.0.1:5299/?live=1`
 * mock 通道不产出 ImageBlock（`mock/` 里没有 image block），对 C1–C5、C8 零鉴别力。
 *
 * ⚠️ **core 的 cwd 决定能不能找到含图会话**，这不是探针能改的：
 * core 的 `findById` 只扫 `~/.pi/agent/sessions/--<cwd 派生档位>--/` 那一档目录
 * （与 `/sessions/load` 同一口径，是既有架构的边界，不是本批的 bug）。
 * 常规 5190 实例的 cwd 是 `packages/web` ⇒ 那个档位目录里没有含图会话 ⇒ C0 必红。
 * 所以本探针要求 `PROBE_ORIGIN` 指向一个 **cwd = 含图会话所在档位**的 core
 * （本机实测：`/home/jony/agent_work/pi_work` 档位下有 13 张图的会话）。
 * 前置没配对时，C0 会判红并把两条可用线索（`/sessions` 的 cwd、可用会话 id）打进证据。
 *
 * 用法
 *   PROBE_ORIGIN=http://127.0.0.1:5299 npm run probe:image-preview
 *
 * 端口：CDP 9405（避开既有 9333/9337/9341-9349、9401-9404）。
 * 证据：`_image-preview-evidence.json`（含全部断言 + 原始观测）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser, sleep } from "./cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiPkgDir = path.resolve(here, "..");

const ORIGIN = process.env.PROBE_ORIGIN ?? "http://127.0.0.1:5190";
const CDP_PORT = 9405;
const EVIDENCE = "_image-preview-evidence.json";

/**
 * 含图会话的锚点。⚠️ 这不是「本探针知道内部实现」——它只用到 `/sessions/load` 公开返回的
 * 契约字段（`messages[].blocks[].type === "image"` 与定位三元组），而这些字段正是
 * `imageUrl(block, token)` 的输入。找不到时会在 C0 的证据里列出候选会话，便于换目标。
 */
const KNOWN_IMAGE_SESSION = "01a0e886-8eaf-7426-ac5c-af55dd3ce7e6";

/** 1x1 PNG（composer 粘贴通道用；真实粘贴事件需要合法图片字节才能解出缩略图） */
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/* ---------------------------------------------------------------------------
 * 页面侧 helper（Page.addScriptToEvaluateOnNewDocument 注入，reload 后仍在）
 * ------------------------------------------------------------------------- */

const HELPERS = `
window.__IP = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  /** 缩略图按钮上的 <img>：缩略图本体就是 button > img，查 img 才拿得到 naturalWidth */
  thumbImg: (el) => (el && el.querySelector ? el.querySelector('img') : null),
  imgInfo: (img) => (img ? {
    src: (img.getAttribute('src') || '').slice(0, 200),
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    complete: img.complete,
    renderedWidth: Math.round(img.getBoundingClientRect().width),
    renderedHeight: Math.round(img.getBoundingClientRect().height),
  } : null),
  activeDesc: () => {
    const a = document.activeElement;
    if (!a) return { tag: null, testid: null, isBody: false, isThumb: false };
    return {
      tag: a.tagName.toLowerCase(),
      testid: a.dataset ? (a.dataset.testid ?? null) : null,
      isBody: a === document.body,
      isThumb: !!(a.dataset && a.dataset.testid === 'message-image-thumb'),
      ariaLabel: a.getAttribute ? a.getAttribute('aria-label') : null,
    };
  },
  dialog: () => document.querySelector('[data-testid="image-preview-dialog"]'),
  dialogImg: () => document.querySelector('[data-testid="image-preview-img"]'),
};
true;
`;

/** 首条历史缩略图的观测（只取第一张，避免一次性量 13 张把证据撑爆） */
const THUMB_SNAPSHOT = `(() => {
  const t = window.__IP.q('[data-testid="message-image-thumb"]');
  return {
    count: window.__IP.qa('[data-testid="message-image-thumb"]').length,
    exists: !!t,
    tag: t ? t.tagName.toLowerCase() : null,
    type: t ? t.getAttribute('type') : null,
    title: t ? t.getAttribute('title') : null,
    ariaLabel: t ? t.getAttribute('aria-label') : null,
    img: window.__IP.imgInfo(window.__IP.thumbImg(t)),
  };
})()`;

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */

let summary = null;
let fatal = null;

try {
  await withBrowser({ port: CDP_PORT, origin: ORIGIN, evidencePath: EVIDENCE }, async (ctx) => {
    const { cdp } = ctx;

    /* 未捕获异常 / console.error 收集：必须在第一次导航前挂上 */
    const exceptions = [];
    const consoleErrors = [];
    cdp.ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.method === "Runtime.exceptionThrown") {
          exceptions.push(msg.params?.exceptionDetails?.exception?.description ?? "unknown");
        } else if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
          consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" "));
        }
      } catch {
        /* 忽略非 JSON */
      }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HELPERS });

    /* ---------- 前置：live 形态 + core 现状 ---------- */
    await ctx.open("/?live=1");
    await cdp.eval(HELPERS);

    const pre = await cdp.eval(`(() => {
      const st = window.__chatStore ? window.__chatStore.getState() : null;
      return {
        liveEnabled: !!window.__CORE_TOKEN__,
        hasStore: !!st,
        cwd: st ? (st.liveCwd ?? null) : null,
        summaries: st ? st.sessionSummaries.length : 0,
        messages: st ? st.messages.length : 0,
        imageBlocks: st
          ? st.messages.reduce(
              (n, m) => n + m.blocks.filter((b) => b.type === 'image').length,
              0,
            )
          : 0,
      };
    })()`);
    ctx.record("0_前置_live形态与当前会话", pre);

    /* ---------- C0：必须找到含图历史消息（**找不到即判红**） ---------- */
    let loadReport = { clicked: false, target: null };
    if (pre.imageBlocks === 0) {
      /*
       * 侧栏历史项按 updatedAt 倒序，探针要主动去找「那张有图的会话」而不是碰运气
       * —— 当前活动会话可能压根没有图。这里用 title 精确匹配已知含图会话，
       * 找不到就退化成「逐个试」（最多 8 个），并把每次尝试记进证据。
       */
      const picked = await cdp.eval(
        `(() => {
          const st = window.__chatStore.getState();
          const want = ${JSON.stringify(KNOWN_IMAGE_SESSION)};
          const hit = st.sessionSummaries.find((s) => s.id === want);
          return hit ? { id: hit.id, title: hit.title } : null;
        })()`,
      );
      loadReport.target = picked;
      if (picked) {
        loadReport.clicked = await cdp.eval(
          `(() => {
            const st = window.__chatStore.getState();
            const idx = st.sessionSummaries.findIndex((s) => s.id === ${JSON.stringify(picked.id)});
            if (idx < 0) return false;
            const el = document.querySelector('[data-testid="sidebar-history-item-' + idx + '"]');
            if (!el) return false;
            el.click();
            return true;
          })()`,
        );
      }
      if (loadReport.clicked) {
        /* 等消息真正换进 store（loadSessionById → POST /sessions/load 是异步的） */
        await cdp.eval(
          `new Promise((r) => {
             const t0 = Date.now();
             const iv = setInterval(() => {
               const st = window.__chatStore.getState();
               if (st.liveSessionId === ${JSON.stringify(picked.id)} && st.messages.length > 0) { clearInterval(iv); r(true); }
               else if (Date.now() - t0 > 25000) { clearInterval(iv); r(false); }
             }, 150);
           })`,
          true,
        );
      }
      await sleep(600);
    }

    /*
     * ★ 必须把虚拟列表滚到「图真的被渲染」为止，闸门才有意义。
     *
     * `MessageList` 用 `useVirtualizer`（overscan 6），含图会话有 200+ 条消息 ⇒
     * store 里 image 块是有的，但图所在的那几条**不在 DOM 里**。
     * 第一版探针只在 store 层判 image 块 > 0 就放行，闸门因此**两次给出不同结论**
     * （取决于 bootstrap 续上的那条会话首屏有没有图）—— 假绿/假红都来自这一处。
     *
     * 正确口径：只认**已渲染进 DOM 的** `[data-testid="message-image-thumb"]`。
     *
     * ★★★ 第二版（本文件此前的滚动块是**探针 bug**，不是产品 bug）★★★
     * 旧实现只会「往下滚」（`list.scrollTop = prev + step`），而：
     *   - 容器 = `data-testid="message-list"` 那个 `overflow-y-auto` div
     *     （`getScrollElement: () => parentRef.current`，它是唯一滚动容器）；
     *   - 加载完默认**贴底**（实测 scrollTop 30711 / scrollHeight 31354）；
     *   - 含图消息在 store 里的下标是 **0**（最顶部），底部往下滚永远够不着。
     * ⇒ thumbCount 恒为 0，C0 必红，而产品链路其实完全正常
     *   （手动 `scrollTop = 0` 立刻出现缩略图，naturalWidth = 1062）。
     *
     * 现在按**先顶 → 逐步下滚**的顺序找（等价于「先看当前视口，再向上滚到顶，
     * 仍没有再向下滚到底」—— 从底部出发时，第一步就是直接跳顶）：
     *   ① 当前视口（不动，等渲染）；
     *   ② `scrollTop = 0` 跳到最顶（含图消息通常就在最顶部）；
     *   ③ 逐步下滚扫完全程。
     * 三步都找不到才判红，并如实落下诊断（scrollTop/scrollHeight/totalCount/
     * store 里的 image 块下标），**不做任何静默跳过**。
     */
    const scrolled = await cdp.eval(
      `new Promise((r) => {
         const list = window.__IP.q('[data-testid="message-list"]');
         if (!list) { r({ ok: false, why: 'no message-list' }); return; }
         const st = window.__chatStore ? window.__chatStore.getState() : null;
         const diag = () => ({
           totalCount: list.getAttribute('data-total-count'),
           scrollTop: Math.round(list.scrollTop),
           scrollHeight: Math.round(list.scrollHeight),
           clientHeight: Math.round(list.clientHeight),
           // 诊断：store 里含图消息的下标 —— 若全在靠前位置而 thumbCount=0，就是滚动没找对
           含图消息下标: st
             ? st.messages
                 .map((m, i) => (m.blocks.some((b) => b.type === 'image') ? i : -1))
                 .filter((i) => i >= 0)
                 .slice(0, 12)
             : null,
           渲染行下标: window.__IP
             .qa('[data-testid="message-item"]')
             .map((el) => Number(el.getAttribute('data-index')))
             .filter((i) => Number.isFinite(i))
             .slice(0, 4),
         });
         const t0 = Date.now();
         const maxTop = () => Math.max(0, list.scrollHeight - list.clientHeight);
         const step = Math.max(300, Math.floor(list.clientHeight * 0.75));
         const thumbs = () => window.__IP.qa('[data-testid="message-image-thumb"]');
         const done = (extra) => r(Object.assign({ ok: false }, diag(), extra || {}));
         const hit = (phase) => {
           const n = thumbs().length;
           if (n > 0) {
             r({ ok: true, phase, thumbCount: n, scrollTop: Math.round(list.scrollTop) });
             return true;
           }
           return false;
         };
         let phase = '当前视口';
         const run = () => {
           if (hit(phase)) return;
           if (Date.now() - t0 > 20000) { done({ why: '三个方向都试完仍未渲染出缩略图', phase }); return; }
           if (phase === '当前视口') { phase = '滚到顶'; list.scrollTop = 0; setTimeout(run, 300); return; }
           if (phase === '滚到顶') {
             // 贴底逻辑可能把 scrollTop 又推回底部（pinningRef / ResizeObserver）；
             // 检测到就被拉回顶部再等一拍，仍不归零就继续下滚。
             if (list.scrollTop > 0) { list.scrollTop = 0; setTimeout(run, 300); return; }
             phase = '逐步下滚';
           }
           const next = Math.min(list.scrollTop + step, maxTop());
           if (next <= list.scrollTop) { done({ why: '已滚到底仍未渲染出缩略图', phase }); return; }
           list.scrollTop = next;
           setTimeout(run, 220);
         };
         run();
       })`,
      true,
    );
    ctx.record("0_前置_把虚拟列表滚到图被渲染", scrolled);
    await sleep(500); // 让缩略图 <img> 完成解码

    const found = await cdp.eval(`(() => {
      const st = window.__chatStore.getState();
      const thumbs = window.__IP.qa('[data-testid="message-image-thumb"]');
      return {
        loadedSession: st.liveSessionId,
        messageCount: st.messages.length,
        imageBlocks: st.messages.reduce((n, m) => n + m.blocks.filter((b) => b.type === 'image').length, 0),
        thumbCount: thumbs.length,
        // 取图链路最上游的一环：img 的 src 必须真的是 /sessions/image?…&token=…
        firstSrc: thumbs[0] ? window.__IP.thumbImg(thumbs[0])?.getAttribute('src') ?? null : null,
        可用会话id: st.sessionSummaries.slice(0, 8).map((s) => s.id),
        会话cwd: st.liveCwd ?? null,
        滚动找图结果: null,
      };
    })()`);
    found.滚动找图结果 = scrolled;
    ctx.record("0_前置_加载含图会话的结果", { ...loadReport, ...found });

    const hasHistoryImage = found.thumbCount > 0;

    ctx.assert(
      "C0 闸门：live 会话里找到含图历史消息（取图链路的前提）",
      {
        live形态已启用: pre.liveEnabled === true,
        历史图缩略图存在: hasHistoryImage === true,
        store里有image块: found.imageBlocks > 0,
      },
    );
    if (!hasHistoryImage) {
      /*
       * ★ 静默跳过 = 本批最大的验证缺口被吞掉。走到这里就是**硬失败**：
       *   下面所有依赖历史图的判据都拿不到证据，必须让探针红。
       * 证据里写清「未获验证」以及怎么解开。
       */
      const hint = {
        结论: "未能在 live 会话中找到含图历史消息 —— 取图链路未获验证",
        原因候选: [
          "core 的 cwd 不在含图会话所在档位（core findById 只扫当前 cwd 派生的那一档 sessions 目录）",
          "PROBE_ORIGIN 指到了没有含图会话的实例（如常规 5190）",
          "dist 未重新构建，页面里的 UI 还没有 image 接线",
        ],
        解法: "PROBE_ORIGIN 指向 cwd = 含图会话档位的 live core（本机 /home/jony/agent_work/pi_work 档位可用）",
        证据: found,
      };
      ctx.record("未获验证_闸门未通过", hint);
      console.error(
        "\n>> 未能在 live 会话中找到含图历史消息 —— 取图链路未获验证。\n" +
          ">> 历史图相关判据（C1/C2/C3/C4/C5）**全部未执行**，本探针判红。\n" +
          `>> 候选会话 id：${JSON.stringify(found.可用会话id)}\n` +
          `>> core 报告的 cwd：${JSON.stringify(found.会话cwd)}\n` +
          ">> 详见 _image-preview-evidence.json 的「未获验证_闸门未通过」。",
      );
      // 仍然落盘证据并让退出码非零 —— 由 save() 的 failed>0 触发。
      summary = ctx.save(EVIDENCE);
      return;
    }

    /* =============================================================== C1 */
    {
      const snap = await cdp.eval(THUMB_SNAPSHOT);
      ctx.record("C1_首条历史缩略图快照", snap);
      ctx.assert(
        "C1 历史图片是真缩略图元素，且 <img> 真的解码出字节（naturalWidth > 0）",
        {
          缩略图元素存在: snap.exists === true,
          是button: snap.tag === "button",
          内含img: snap.img !== null,
          源是sessions_image端点: typeof snap.img?.src === "string" && snap.img.src.startsWith("/sessions/image?"),
          "src带token参数": typeof snap.img?.src === "string" && snap.img.src.includes("&token="),
          "img已complete": snap.img?.complete === true,
          // ★★★ 整条取图链路的落点：token 拼装正确 + core 鉴权通过 +
          // Content-Type 与浏览器解码匹配，三者缺一 naturalWidth 都会是 0。
          "naturalWidth大于0": (snap.img?.naturalWidth ?? 0) > 0,
        },
      );
    }

    /* =============================================================== C2 */
    {
      const r = await cdp.eval(`(() => {
        const text = document.body.innerText || '';
        // ⚠️ innerText 只覆盖**已渲染进 DOM 的**那几十行（虚拟列表 216 条里只渲染一小段），
        // 单看它会假绿。store 里那份才是 core 真实产出的全部块，所以再扫一遍。
        const storeHits = [];
        const st = window.__chatStore ? window.__chatStore.getState() : null;
        (st ? st.messages : []).forEach((m, i) => {
          (m.blocks || []).forEach((b, j) => {
            const t = typeof b.text === 'string' ? b.text : '';
            if (t.includes('[图片]')) storeHits.push({ 消息下标: i, 块下标: j, text: t.slice(0, 60) });
          });
        });
        return {
          含图片占位: text.includes('[图片]'),
          匹配处数: (text.match(/\\[图片\\]/g) || []).length,
          // 「纯文本块里的占位」也算：innerText 已覆盖，但另记一条 DOM 文本节点通道便于复核
          文本节点命中数: [...document.querySelectorAll('p, span, div')]
            .filter((n) => n.children.length === 0 && (n.textContent || '').trim() === '[图片]').length,
          store消息总数: st ? st.messages.length : 0,
          store占位命中: storeHits.slice(0, 5),
          store占位命中数: storeHits.length,
        };
      })()`);
      ctx.record("C2_占位符扫描", r);
      ctx.assert("C2 `[图片]` 占位文本已从页面消失（core 不再产出该文本块）", {
        innerText不含占位: r.含图片占位 === false,
        无占位文本节点: r.文本节点命中数 === 0,
        // ★ store 级（覆盖全部 216 条，不受虚拟列表只渲染窗口的影响）
        store全文无占位: r.store占位命中数 === 0,
      });
    }

    /* =============================================================== C3 */
    {
      // 用真实鼠标事件（CDP Input）而不是 el.click()：el.click() 不产生 userActivation，
      // 将来若实现里加「非用户手势不开预览」的守卫，这条会假绿。
      const box = await cdp.eval(`(() => {
        const t = window.__IP.q('[data-testid="message-image-thumb"]');
        if (!t) return null;
        t.scrollIntoView({ block: 'center' });
        const r = t.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      if (box) {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await cdp.send("Input.dispatchMouseEvent", {
            type,
            x: box.x,
            y: box.y,
            button: "left",
            clickCount: 1,
          });
        }
      }
      // 等弹层内大图解码完成（naturalWidth 要等 load 事件，不是挂载即有值）
      const opened = await cdp.eval(
        `new Promise((r) => {
           const t0 = Date.now();
           const iv = setInterval(() => {
             const dlg = window.__IP.dialog();
             const img = window.__IP.dialogImg();
             if (dlg && img && img.complete && img.naturalWidth > 0) {
               clearInterval(iv);
               r({
                 dialogExists: true,
                 dialogVisible: getComputedStyle(dlg).opacity === '1',
                 dialogHasPointerEvents: getComputedStyle(dlg).pointerEvents !== 'none',
                 role: dlg.getAttribute('role'),
                 ariaModal: dlg.getAttribute('aria-modal'),
                 img: window.__IP.imgInfo(img),
                 activeIsInsideDialog: !!(dlg.contains(document.activeElement)),
               });
             } else if (Date.now() - t0 > 10000) {
               clearInterval(iv);
               const d2 = window.__IP.dialog();
               const i2 = window.__IP.dialogImg();
               r({
                 dialogExists: !!d2,
                 dialogVisible: d2 ? getComputedStyle(d2).opacity === '1' : false,
                 dialogHasPointerEvents: d2 ? getComputedStyle(d2).pointerEvents !== 'none' : false,
                 role: d2 ? d2.getAttribute('role') : null,
                 ariaModal: d2 ? d2.getAttribute('aria-modal') : null,
                 img: window.__IP.imgInfo(i2),
                 activeIsInsideDialog: !!(d2 && d2.contains(document.activeElement)),
                 超时: true,
               });
             }
           }, 100);
         })`,
        true,
      );
      ctx.record("C3_弹层与弹层大图快照", opened);
      ctx.assert("C3 点击缩略图打开大图，弹层内大图自然宽 > 0（预览走的是同一取图端点）", {
        弹层出现: opened.dialogExists === true,
        弹层可见: opened.dialogVisible === true,
        弹层可点: opened.dialogHasPointerEvents === true,
        "role为dialog": opened.role === "dialog",
        "aria_modal为true": opened.ariaModal === "true",
        大图存在: opened.img !== null,
        "大图naturalWidth大于0": (opened.img?.naturalWidth ?? 0) > 0,
        // 大图应显著大于 64px 缩略图：证明放大的确实是原图，不是同一份缩略图元素
        大图尺寸大于缩略图: (opened.img?.naturalWidth ?? 0) > 100,
        焦点已进弹层: opened.activeIsInsideDialog === true,
      });
    }

    /* =============================================================== C4 */
    {
      // ★ 必须用真实按键：Dialog 的 Esc 挂在自身 onKeyDown（React 合成事件）上，
      //   `new KeyboardEvent(...)` 能触发，但真实输入才是用户路径的证据。
      await cdp.pressKey({ key: "Escape", code: "Escape", virtualKeyCode: 27 });
      // closePreview 用 requestAnimationFrame 归还焦点，等两帧再采样
      await sleep(700);
      const closed = await cdp.eval(`(() => ({
        dialogGone: !window.__IP.dialog(),
        dialogImgGone: !window.__IP.dialogImg(),
        残留role_dialog: window.__IP.qa('[role="dialog"]').map((el) => ({
          testid: el.dataset ? (el.dataset.testid ?? null) : null,
          ariaLabel: el.getAttribute('aria-label'),
          ariaHidden: el.getAttribute('aria-hidden'),
          inert: el.hasAttribute('inert'),
          opacity: getComputedStyle(el).opacity,
        })),
        active: window.__IP.activeDesc(),
      }))()`);
      ctx.record("C4_Esc关闭后快照", closed);
      ctx.assert("C4 真实 Esc 键关闭弹层（从 DOM 硬卸载）", {
        弹层已从DOM移除: closed.dialogGone === true,
        大图已从DOM移除: closed.dialogImgGone === true,
        // 关闭后文档里**不得残留预览弹层自己**的 role=dialog。
        // ⚠️ 不能判「全文档无 role=dialog」：Chromium CDP 自己的 <select> 弹层会进
        //    文档（ariaLabel 形如「Select a value」），与产品无关 —— 判全文档会把
        //    浏览器内部节点误算成产品缺陷。改按 testid 精确对位。
        无残留预览弹层: closed.残留role_dialog.every((d) => d.testid !== "image-preview-dialog"),
      });

      /* =============================================================== C5 */
      ctx.assert("C5 关闭后焦点归还给缩略图（不是 body）", {
        activeElement是缩略图: closed.active.isThumb === true,
        activeElement不是body: closed.active.isBody === false,
        缩略图仍可聚焦: closed.active.testid === "message-image-thumb",
      });
    }

    /* =============================================================== C6 */
    {
      // composer 通道：dataUrl 直连，不经 core。它是对照组（证明 UI 侧预览/关闭/焦点三件套
      // 本身没问题，若这里也挂就不是取图链路的问题）。
      const pasted = await cdp.eval(
        `new Promise((r) => {
           const ta = window.__IP.q('[data-testid="composer-input"]');
           if (!ta) { r({ skipped: 'no composer-input' }); return; }
           ta.focus();
           const bin = atob(${JSON.stringify(PNG_1PX)});
           const arr = new Uint8Array(bin.length);
           for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
           const dt = new DataTransfer();
           dt.items.add(new File([arr], 'p.png', { type: 'image/png' }));
           ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
           const t0 = Date.now();
           const iv = setInterval(() => {
             const n = window.__IP.qa('[data-testid^="composer-image-"]')
               .filter((el) => /^composer-image-\\d+$/.test(el.dataset.testid || ''));
             if (n.length > 0) { clearInterval(iv); r({ thumbCount: n.length }); }
             else if (Date.now() - t0 > 5000) { clearInterval(iv); r({ thumbCount: 0 }); }
           }, 100);
         })`,
        true,
      );
      ctx.record("C6_待发区粘贴", pasted);

      let c6opened = null;
      if ((pasted.thumbCount ?? 0) > 0) {
        const cbox = await cdp.eval(`(() => {
          const el = window.__IP.q('[data-testid="composer-image-0"]');
          if (!el) return null;
          const btn = el.querySelector('button');
          if (!btn) return null;
          btn.scrollIntoView({ block: 'center' });
          const r = btn.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        if (cbox) {
          for (const type of ["mousePressed", "mouseReleased"]) {
            await cdp.send("Input.dispatchMouseEvent", {
              type,
              x: cbox.x,
              y: cbox.y,
              button: "left",
              clickCount: 1,
            });
          }
        }
        c6opened = await cdp.eval(
          `new Promise((r) => {
             const t0 = Date.now();
             const iv = setInterval(() => {
               const dlg = window.__IP.dialog();
               const img = window.__IP.dialogImg();
               if (dlg && img && img.complete && img.naturalWidth > 0) { clearInterval(iv); r({ ok: true, img: window.__IP.imgInfo(img) }); }
               else if (Date.now() - t0 > 8000) { clearInterval(iv); r({ ok: false, dialogExists: !!dlg, img: window.__IP.imgInfo(img) }); }
             }, 100);
           })`,
          true,
        );
        ctx.record("C6_待发缩略图点开大图", c6opened);
      }
      ctx.assert("C6 待发区缩略图可点开大图（dataUrl 通道，与历史图通道对照）", {
        粘贴后有待发缩略图: (pasted.thumbCount ?? 0) > 0,
        弹层打开: c6opened?.ok === true,
        "大图naturalWidth大于0": (c6opened?.img?.naturalWidth ?? 0) > 0,
      });

      /* =============================================================== C7 */
      {
        await cdp.pressKey({ key: "Escape", code: "Escape", virtualKeyCode: 27 });
        await sleep(600);
        const removeObs = await cdp.eval(
          `new Promise((r) => {
             const btn = window.__IP.q('[data-testid="composer-image-remove-0"]');
             if (!btn) { r({ skipped: 'no remove button' }); return; }
             const before = window.__IP.qa('[data-testid^="composer-image-"]')
               .filter((el) => /^composer-image-\\d+$/.test(el.dataset.testid || '')).length;
             btn.click();
             setTimeout(() => {
               r({
                 before,
                 after: window.__IP.qa('[data-testid^="composer-image-"]')
                   .filter((el) => /^composer-image-\\d+$/.test(el.dataset.testid || '')).length,
                 previewOpened: !!window.__IP.dialog(),
                 dialogImgPresent: !!window.__IP.dialogImg(),
               });
             }, 600);
           })`,
          true,
        );
        ctx.record("C7_点移除后的快照", removeObs);
        ctx.assert("C7 点「移除」不误开预览（且图确实被移除）", {
          有移除按钮可点: removeObs.skipped === undefined,
          图片已移除: removeObs.after === 0 && removeObs.before > 0,
          未误开预览: removeObs.previewOpened === false,
          无大图元素: removeObs.dialogImgPresent === false,
        });
      }
    }

    /* =============================================================== C8 */
    {
      /*
       * 坏坐标健壮性。用浏览器里的 fetch 打同一个 origin（带 Bearer，与 UI 侧口径一致），
       * 再额外用 Node fetch 打一次带 `?token=` 的路径（与 <img> 口径一致）——
       * 两条通道都必须是 404，且之后页面仍然活着。
       */
      const inPage = await cdp.eval(
        `(async () => {
           const tok = window.__CORE_TOKEN__ || '';
           const base = '/sessions/image?sessionId=' + encodeURIComponent(${JSON.stringify(found.loadedSession ?? "")})
             + '&entryId=definitely-no-such-entry&partIndex=1';
           const out = {};
           const shots = [['bearer', ''], ['queryToken', '&token=' + encodeURIComponent(tok)]];
           for (const [k, q] of shots) {
             try {
               const r = await fetch(base + q, { headers: { Authorization: 'Bearer ' + tok } });
               out[k] = { status: r.status, ct: r.headers.get('content-type'), body: (await r.text()).slice(0, 200) };
             } catch (e) { out[k] = { status: 0, error: String(e && e.message || e) }; }
           }
           out.pageAlive = typeof window.__chatStore.getState().messages.length === 'number';
           return out;
         })()`,
        true,
      );
      const viaQuery = inPage?.queryToken ?? {};
      ctx.record("C8_坏坐标响应", { inPage, 核心说明: "entryId 不存在 ⇒ 应 404；500 说明 server 抛了未捕获异常（曾导致 core 进程死亡）" });
      ctx.assert("C8 坏坐标不崩：不存在的 entryId ⇒ 404（不是 500）、两条鉴权通道口径一致、页面仍活着", {
        bearer通道404: inPage?.bearer?.status === 404,
        queryToken通道404: viaQuery.status === 404,
        "都不是500": inPage?.bearer?.status !== 500 && viaQuery.status !== 500,
        不是401: inPage?.bearer?.status !== 401 && viaQuery.status !== 401,
        错误体是json: (inPage?.bearer?.ct ?? "").includes("json"),
        错误体有error字段: typeof inPage?.bearer?.body === "string" && inPage.bearer.body.includes("error"),
        页面仍可响应: inPage?.pageAlive === true,
      });
    }

    /* ---------- 收尾：把观测到的异常/console 错误一起落盘 ---------- */
    ctx.record("9_页面异常与console错误", {
      异常: exceptions.slice(0, 10),
      异常条数: exceptions.length,
      console错误: consoleErrors.slice(0, 10),
      console错误条数: consoleErrors.length,
    });

    summary = ctx.save(EVIDENCE);
  });
} catch (e) {
  fatal = e;
  console.error("[probe:image-preview] 脚本异常：", e && e.stack ? e.stack : e);
}

/* ---------------------------------------------------------------------------
 * 退出码：非零 = 门禁没过。⚠️ 静默通过 = 本批唯一验证缺口的等价物，所以这里从严。
 * ------------------------------------------------------------------------- */

if (fatal) {
  process.exit(1);
}
if (!summary || summary.failed > 0) {
  console.error(
    `\n== probe:image-preview 门禁未过：${summary ? `${summary.passed}/${summary.assertions} 通过` : "未产出汇总"} ==`,
  );
  process.exit(1);
}
console.log(`\n== probe:image-preview 全部通过（${summary.passed}/${summary.assertions}）==`);
