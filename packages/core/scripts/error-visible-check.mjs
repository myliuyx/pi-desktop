/**
 * 错误可见性回归断言 —— `check:error-visible`（2026-09-28 用户裁决：失败要直接可见）。
 *
 * 背景（2026-09-28 Linux 实测复现）：模型请求失败时 Pi 产出 `stopReason="error"` 的
 * assistant 消息 —— content 为空壳、错误文本只在 `errorMessage` 字段。此前该消息在
 * 三处被静默吞掉：adapt.ts 不透传（live）、sessions.ts empty-assistant-message 跳过
 * （历史重载）、渲染层空壳整行隐藏。用户视角就是「消息发出去没影了」。
 *
 * 覆盖（core 数据层两关；UI reducer 关在 ui/scripts/adapter-check.mjs 第八节）：
 *   E1  adapt.toAgentEvent：message_end 的 error 消息 ⇒ errorMessage 透传；
 *   E2  adapt.toAgentEvent：pending（流式常态）/ aborted（用户中止）不透传；
 *   E3  adapt.toAgentEvent：error 且 errorMessage 为空串 ⇒ 兜底「未知错误」；
 *   E4  entriesToMessages：error 空壳消息保留（blocks 空 + errorMessage + model）；
 *   E5  entriesToMessages：error 但有部分内容 ⇒ 内容保留且 errorMessage 附挂；
 *   E6  entriesToMessages：aborted 空壳维持原跳过行为（不算失败）；
 *   E7  entriesToMessages：普通空壳仍跳过 —— 修错误不能改坏既有口径。
 *
 * 用法（在 packages/core 下）：`npm run check:error-visible`（tsx 直跑 src，不起 core）。
 * 证据：`run/error-visible-evidence.json`；失败非 0 退出。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toAgentEvent } from "../src/adapt.ts";
import { entriesToMessages } from "../src/sessions.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const runDir = path.join(here, "..", "run");
fs.mkdirSync(runDir, { recursive: true });
const evidencePath = path.join(runDir, "error-visible-evidence.json");

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

/** 构造一条落盘会话 entry（sessions.ts entriesToMessages 的输入） */
const msgEntry = (id, message, timestamp = "2026-09-28T12:00:00.000Z") => ({
  type: "message",
  id,
  timestamp,
  message,
});

/* ===== E1：message_end 的 error 消息 ⇒ errorMessage 透传 ===== */
{
  const event = toAgentEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "The request limited providers for this model and they are currently at capacity.",
      model: "laguna-s-2.1-free",
      timestamp: 1759046000000,
    },
  });
  check("E1 error 消息被翻译（不丢弃）", event !== null, event);
  check("E1 errorMessage 透传", event?.message?.errorMessage === "The request limited providers for this model and they are currently at capacity.", event?.message?.errorMessage);
  check("E1 模型标签照常透传", event?.message?.model === "laguna-s-2.1-free", event?.message?.model);
  check("E1 content 仍为空数组", event?.message?.content?.length === 0, event?.message?.content?.length);
}

/* ===== E2：pending / aborted 不透传（不算失败） ===== */
{
  const pending = toAgentEvent({
    type: "message_start",
    message: { role: "assistant", content: [], stopReason: "pending", model: "m1" },
  });
  check("E2 pending 不挂 errorMessage", !!(pending?.message && !("errorMessage" in pending.message)), pending?.message);

  const aborted = toAgentEvent({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted" },
  });
  check("E2 aborted 不挂 errorMessage", !!(aborted?.message && !("errorMessage" in aborted.message)), aborted?.message);
}

/* ===== E3：error 且 errorMessage 缺失/空串 ⇒ 兜底「未知错误」 ===== */
{
  const noMsg = toAgentEvent({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error" },
  });
  check("E3 errorMessage 缺失 ⇒ 未知错误", noMsg?.message?.errorMessage === "未知错误", noMsg?.message?.errorMessage);

  const emptyMsg = toAgentEvent({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "  " },
  });
  check("E3 errorMessage 空白串 ⇒ 未知错误", emptyMsg?.message?.errorMessage === "未知错误", emptyMsg?.message?.errorMessage);
}

/* ===== E4：历史重载 —— error 空壳消息保留 ===== */
{
  const { messages, stats } = entriesToMessages([
    msgEntry("e1", { role: "user", content: [{ type: "text", text: "你好" }] }),
    msgEntry("e2", {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "poolside at capacity",
      model: "laguna-s-2.1-free",
    }),
  ]);
  check("E4 失败空壳不再被跳过（2 条消息）", messages.length === 2, messages.length);
  const err = messages[1];
  check("E4 errorMessage 保留", err?.errorMessage === "poolside at capacity", err?.errorMessage);
  check("E4 blocks 为空数组", err?.blocks?.length === 0, err?.blocks?.length);
  check("E4 模型标签回填", err?.model === "laguna-s-2.1-free", err?.model);
  check("E4 跳过统计不再计 empty-assistant-message", stats.skipped["empty-assistant-message"] === undefined, stats.skipped["empty-assistant-message"]);
}

/* ===== E5：error 但有部分内容 ⇒ 内容保留且 errorMessage 附挂 ===== */
{
  const { messages } = entriesToMessages([
    msgEntry("e1", {
      role: "assistant",
      content: [{ type: "text", text: "写到一半" }],
      stopReason: "error",
      errorMessage: "connection reset",
    }),
  ]);
  check("E5 部分内容保留", messages[0]?.blocks?.[0]?.content === "写到一半", messages[0]?.blocks?.[0]?.content);
  check("E5 errorMessage 附挂", messages[0]?.errorMessage === "connection reset", messages[0]?.errorMessage);
}

/* ===== E6：aborted 空壳维持原跳过行为 ===== */
{
  const { messages, stats } = entriesToMessages([
    msgEntry("e1", { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted" }),
  ]);
  check("E6 aborted 空壳仍跳过", messages.length === 0, messages.length);
  check("E6 跳过口径不变", stats.skipped["empty-assistant-message"] === 1, stats.skipped["empty-assistant-message"]);
}

/* ===== E7：普通空壳仍跳过（既有口径不回归） ===== */
{
  const { messages, stats } = entriesToMessages([msgEntry("e1", { role: "assistant", content: [] })]);
  check("E7 普通空壳仍跳过", messages.length === 0, messages.length);
  check("E7 跳过口径不变", stats.skipped["empty-assistant-message"] === 1, stats.skipped["empty-assistant-message"]);
}

/* ===== 出证据 + 退出码 ===== */
const failed = checks.filter((c) => !c.pass);
fs.writeFileSync(
  evidencePath,
  JSON.stringify({ date: "2026-09-28", total: checks.length, failed: failed.length, checks }, null, 2),
  "utf8",
);
console.log(`\n证据已出：${path.relative(process.cwd(), evidencePath)}`);
if (failed.length > 0) {
  console.error(`错误可见性断言失败 ${failed.length} 项`);
  process.exit(1);
}
console.log(`错误可见性断言全部通过：${checks.length} 项`);
