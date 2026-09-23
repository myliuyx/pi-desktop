/**
 * 测试夹具：**逼出一次真实授权往返**的最小扩展（代码落在本仓库，不依赖 gitignore 的 `pi/`）。
 *
 * 用法（C3 检查脚本 `scripts/c3-approval-check.mjs`）：
 * - 判据①（真实授权往返）：本文件作为 **agentDir/extensions/** 的全局扩展加载；
 * - 判据③（信任门三态）：本文件被复制到临时 cwd 的 **.pi/extensions/** 下，
 *   成为「项目本地扩展」→ 是否被加载完全由信任门决定。
 *
 * 机制依据（`.plan/archive/survey/S3-tool-approval.md` §3.3）：
 * 授权靠 `pi.on("tool_call", handler)` 的**返回值**（`{ block: true, reason }` 拦下 /
 * `undefined` 放行），它**不是事件**，所以 Pi 不会把授权结果回显给 UI ——
 * UI 侧的收卡只能靠 core 补发的 `approval_settled`。
 *
 * 注意：`ctx.hasUI` 由「core 是否注入了 uiContext」推导（`runner.ts:530-532`）。
 * 若 core 忘了注入，这里会走「无 UI 直接 block」分支 —— 命令静默失败、UI 看不到卡片（S3 §2.4 陷阱）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = (event.input as { command?: string } | undefined)?.command ?? "";
		console.log(`[fixture-ext] tool_call bash hasUI=${ctx.hasUI} mode=${ctx.mode} command=${command}`);

		const choice = await ctx.ui.select(`允许执行这个命令？\n\n  ${command}`, ["允许", "拒绝"]);
		console.log(`[fixture-ext] ui.select → ${JSON.stringify(choice)}`);

		// 只有明确「允许」才放行；「拒绝」/「取消」(undefined) 一律 block。
		if (choice !== "允许") {
			return { block: true, reason: "被夹具扩展拒绝（approval-gate fixture）" };
		}
		return undefined;
	});
}
