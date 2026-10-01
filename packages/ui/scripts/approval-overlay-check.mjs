/**
 * approval-overlay 纯逻辑检查 —— task-hostless-approval-overlay.md（2026-10-01）。
 *
 * 背景：信任门（cwd 切换/启动期）的 approval_request 发生在**零消息时刻**，reducer
 * 的宿主判据找不到 assistant 会静默丢弃事件 → 授权卡永不渲染、core 等应答到 120s
 * 超时（「点了没反应」根因）。本批把无宿主事件改落顶层 pendingApprovals 由全局
 * 模态浮层渲染；这里逐条对账纯逻辑层（规格 §三.2/§三.3）：
 * 宿主判定（含 bug 场景）、事件→块映射（消息树内嵌卡与浮层共用一份）、reducer
 * 「有宿主挂块 / 无宿主丢弃」的既有口径不回归。
 *
 * store 路由粘合层（setState 去重/settled 移除/重连清洗）与浮层 DOM/倒计时的
 * 端到端判据在 5190 实弹与验收方探针里，实现方不写（probe 文件头铁律）。
 *
 * 运行：npm run check:approval-overlay
 */
import assert from "node:assert/strict";
import {
  approvalEventToBlock,
  approvalRequestHasHost,
  applyEvent,
  createDraft,
} from "../src/adapter/reduce.ts";

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

/** 事件构造器：信任门的真实形状（select + 多行 title + 120s 超时） */
const trustEvent = (overrides = {}) => ({
  type: "approval_request",
  requestId: "req-1",
  method: "select",
  title: "将加载并执行项目本地扩展\n\n目录：/tmp/trust-me\n\n该目录下的 .pi/extensions 等资源是可执行代码。",
  options: ["信任并加载项目本地扩展", "不信任（本次不加载）"],
  timeoutMs: 120_000,
  ...overrides,
});

/* --------------------------------------------------------------- 宿主判定 */

check("① bug 场景：空消息树（新建会话草稿态）→ 无宿主", () => {
  assert.equal(approvalRequestHasHost(createDraft([])), false);
});

check("② 仅 user 消息 → 无宿主", () => {
  const draft = createDraft([{ id: "u1", role: "user", timestamp: 0, blocks: [] }]);
  assert.equal(approvalRequestHasHost(draft), false);
});

check("③ 流式中（currentAssistantId 在位）→ 有宿主", () => {
  const draft = {
    ...createDraft([]),
    currentAssistantId: "a1",
  };
  assert.equal(approvalRequestHasHost(draft), true);
});

check("④ 有历史 assistant 消息 → 有宿主（已有对话页切目录的正常路径）", () => {
  const draft = createDraft([
    { id: "u1", role: "user", timestamp: 0, blocks: [] },
    { id: "a1", role: "assistant", timestamp: 1, blocks: [] },
  ]);
  assert.equal(approvalRequestHasHost(draft), true);
});

/* ------------------------------------------------------- 事件 → 块映射 */

check("⑤ 映射：信任门全字段透传（title/message/method/options/timeoutMs）", () => {
  const block = approvalEventToBlock(trustEvent());
  assert.equal(block.type, "approval");
  assert.equal(block.requestId, "req-1");
  assert.equal(block.method, "select");
  assert.equal(block.title, trustEvent().title);
  assert.deepEqual(block.options, ["信任并加载项目本地扩展", "不信任（本次不加载）"]);
  assert.equal(block.timeoutMs, 120_000);
  // resolved 不在映射里写：未决态由渲染层可点
  assert.equal(block.resolved, undefined);
});

check("⑥ 映射缺省归一：options 缺省 → []，可选项缺省 → undefined（mock 行为不变）", () => {
  const block = approvalEventToBlock(trustEvent({ options: undefined, timeoutMs: undefined }));
  assert.deepEqual(block.options, []);
  assert.equal(block.timeoutMs, undefined);
  assert.equal(block.method, "select");
});

/* ----------------------------------------------------- reducer 既有口径回归 */

check("⑦ reducer：有宿主 → 块挂上最后一条 assistant（内嵌卡口径不回归）", () => {
  const draft = createDraft([
    { id: "u1", role: "user", timestamp: 0, blocks: [] },
    { id: "a1", role: "assistant", timestamp: 1, blocks: [] },
  ]);
  const next = applyEvent(draft, trustEvent());
  assert.equal(next.messages.length, 2);
  const approvalBlocks = next.messages[1].blocks.filter((b) => b.type === "approval");
  assert.equal(approvalBlocks.length, 1);
  assert.equal(approvalBlocks[0].requestId, "req-1");
  assert.deepEqual(approvalBlocks[0].options, ["信任并加载项目本地扩展", "不信任（本次不加载）"]);
});

check("⑧ reducer：无宿主 → 原样返回（丢弃口径不变；渲染责任在浮层路由）", () => {
  const draft = createDraft([]);
  const next = applyEvent(draft, trustEvent());
  assert.equal(next, draft);
  assert.equal(next.messages.length, 0);
});

check("⑨ reducer：approval_settled 收卡（resolved 写回，浮层与内嵌卡共用结算口径）", () => {
  const draft = createDraft([{ id: "a1", role: "assistant", timestamp: 0, blocks: [] }]);
  const requested = applyEvent(draft, trustEvent());
  const settled = applyEvent(requested, { type: "approval_settled", requestId: "req-1", resolution: "accepted" });
  const block = settled.messages[0].blocks.find((b) => b.type === "approval");
  assert.equal(block.resolved, "accepted");
});

console.log(`\n${passed}/${total} 项通过`);
if (passed !== total) process.exitCode = 1;
