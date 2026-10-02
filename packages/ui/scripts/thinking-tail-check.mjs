/**
 * thinking-tail 源码契约检查 —— .plan/task-thinking-tail.md（2026-10-02）§4.1。
 *
 * 思考卡「尾窗化」是纯渲染层改动（reducer streaming 标志语义已由 check:adapter
 * 第九节覆盖），本脚本对 ThinkingCard.tsx 与 globals.css 逐条对账规格 §2 的源码
 * 契约：三态 data-mode、data-expanded 真实口径、collapsed 条件渲染、尾窗底部锚定
 * /固定高度/顶部渐隐（含 mask 与 border-t 分离的实施修正）、脉冲点复用、mock/历史
 * 回退保留、D2 强制收口。这层是实现方自证的第一道闸；尾窗「末行可见/高度恒定」
 * 的端到端判据在实弹探针 probe:thinking-tail 里。
 *
 * 运行：npm run check:thinking-tail
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cardSrc = fs.readFileSync(path.join(here, "..", "src", "components", "chat", "ThinkingCard.tsx"), "utf8");
const globalsSrc = fs.readFileSync(path.join(here, "..", "src", "styles", "globals.css"), "utf8");

/** 压掉换行与连续空白，让跨行表达式可按单行匹配 */
const flat = (s) => s.replace(/\s+/g, " ");

/** 剥掉 JS 注释（块 + 行）：断言只对代码生效，避免文档注释里的规则引文误命中 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const cardCode = stripComments(cardSrc);
const cardFlat = flat(cardCode);

let passed = 0;
let total = 0;
const check = (name, fn) => {
  total++;
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
};

/* ------------------------------------------------- 三态与真实状态口径（§2.4） */

check("① 三态 data-mode 齐全且互斥：full / tail / collapsed 单表达式判定", () => {
  assert.match(
    flat(cardSrc),
    /data-mode=\{expanded \? "full" : tailing \? "tail" : "collapsed"\}/,
  );
});

check("② data-expanded 真实状态口径：只在 full 为 true（.plan/m2-notes-A 纪律）", () => {
  assert.match(cardSrc, /data-expanded=\{expanded\}/);
  // expanded 只由开关与 streaming 收口写入，不存在「tail 态硬编码 true」的旁路
  assert.doesNotMatch(cardSrc, /data-expanded="true"/);
});

check("③ collapsed 条件渲染：不占高度，无 display:none / 裸 hidden 类（task-M2 6.6）", () => {
  assert.doesNotMatch(cardCode, /display:\s*none/);
  assert.doesNotMatch(cardCode, /(^|[\s"'])hidden([\s"']|$)/);
});

/* ----------------------------------------------------- 尾窗形态（§2.2） */

check("④ 尾窗底部锚定：absolute + bottom-0 同节点（纯 CSS 钉末行，无 JS 滚动）", () => {
  assert.match(cardSrc, /className="absolute inset-x-3\.5 bottom-0"/);
  assert.doesNotMatch(cardSrc, /scrollTop/);
});

check("⑤ 尾窗固定高度 + 裁剪：thinking-tail 节点 h-[30px] overflow-hidden", () => {
  assert.match(
    cardSrc,
    /thinking-tail-window relative h-\[30px\] overflow-hidden/,
  );
});

check("⑥ 尾窗节点不带 border-t：mask 会把边线一起淡掉，分隔线在外层包裹", () => {
  const tailNode = cardSrc.match(/className="([^"]*)"[^>]*>\s*<div className="absolute/);
  assert.ok(tailNode, "未定位到尾窗内层结构");
  assert.ok(tailNode[1].includes("thinking-tail-window"), "锚定到的是 thinking-tail 节点");
  assert.ok(!tailNode[1].includes("border-t"), "mask 节点含 border-t 会被渐隐吞掉");
});

check("⑦ 顶部渐隐 mask 存在且为 rgb() 形态（globals.css，禁 #hex 口径）", () => {
  const block = globalsSrc.match(/\.thinking-tail-window \{[\s\S]*?\}/);
  assert.ok(block, "globals.css 缺 .thinking-tail-window");
  assert.ok(block[0].includes("mask-image"), "缺 mask-image");
  assert.ok(block[0].includes("rgb("), "渐变色必须 rgb() 形态");
  assert.ok(!block[0].includes("#"), "出现 #hex");
});

/* ----------------------------------------------------- 脉冲点（§2.3 / D3） */

check("⑧ 脉冲点复用 thinking-dot（reduced-motion 既有降级），不自造动画", () => {
  assert.match(cardSrc, /thinking-dot/);
  assert.doesNotMatch(cardSrc, /@keyframes|animation:/);
  // 仅流式中显示（与展开与否无关）
  assert.match(cardSrc, /block\.streaming === true && \(/);
});

/* ------------------------------------------- 状态机语义（§2.1 / D2 / 回退保留） */

check("⑨ mock/历史回退保留：初始式 streaming ? false : !collapsed（m2 演示态不回归）", () => {
  assert.match(flat(cardSrc), /useState\(block\.streaming \? false : !block\.collapsed\)/);
});

check("⑩ D2 强制收口：streaming 翻转 effect 恒 setExpanded(false)，无按值置 true 回潮", () => {
  assert.match(flat(cardSrc), /if \(block\.streaming === undefined\) return;\s*setExpanded\(false\);/);
  assert.doesNotMatch(cardSrc, /setExpanded\(block\.streaming\)/);
});

check("⑪ 尾窗空内容守卫：content 为空不渲染窗口（防 30px 哑壳，规格 §五.1）", () => {
  assert.match(flat(cardSrc), /tailing && block\.content\.trim\(\) !== ""/);
});

console.log(`\n${passed}/${total} 项通过`);
if (passed !== total) process.exitCode = 1;
