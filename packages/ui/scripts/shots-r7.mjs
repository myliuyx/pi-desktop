/**
 * shots-r7 —— 第七/八轮终态存证截图。
 * ① 默认（双展开）：会话内容列居中 + 我方气泡贴右不占满 + 输入区全宽；
 * ② 双收：内容区 1424px 下列居中自适应保持。
 * 产物：.workbuddy/shots/r7-{default,collapsed}.png
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { withBrowser } from "./cdp.mjs";

const OUT_DIR = "F:/DevelopWork/WorkBuddyWork/Tiktok_auto/.workbuddy/shots";
mkdirSync(OUT_DIR, { recursive: true });

await withBrowser(
  { port: 9346, origin: process.env.PROBE_ORIGIN ?? "http://127.0.0.1:5180", evidencePath: "_shots-r7.json" },
  async (ctx) => {
    await ctx.open("/");
    await ctx.sleep(600); // 等自动贴底与 shiki 高亮稳定

    await ctx.cdp.screenshot(join(OUT_DIR, "r7-default.png"));
    console.log("saved r7-default.png");

    await ctx.cdp.eval(`document.querySelector('[data-testid="titlebar-toggle-sidebar"]').click(); true`);
    await ctx.sleep(400);
    await ctx.cdp.eval(`document.querySelector('[data-testid="titlebar-toggle-preview"]').click(); true`);
    await ctx.sleep(800); // 等两段折叠动画结束、布局稳定

    await ctx.cdp.screenshot(join(OUT_DIR, "r7-collapsed.png"));
    console.log("saved r7-collapsed.png");
  },
);
