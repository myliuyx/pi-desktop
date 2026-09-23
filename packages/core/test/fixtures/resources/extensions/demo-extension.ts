/**
 * C5 夹具：**全局（user scope）最小扩展** —— 只证明「扩展确实被加载且能被列举」。
 *
 * 与 C3 的 `agentdir-ext/extensions/approval-gate.ts` 的区别：那条会拦截 bash 工具、
 * 逼出授权卡（判据①用）；这条**不参与任何拦截**，只注册一个命令并打一行日志，
 * 好让 C5 的 `/resources` 检查不必处理授权往返。
 *
 * 用法（`scripts/c5-resources-models-check.mjs`）：复制到临时 agentDir 的 `extensions/` 下
 * → 走 **user scope**（不受项目信任门管辖，任何 defaultProjectTrust 下都应被列举）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		console.log("[fixture-ext] demo-extension loaded (全局/user scope)");
	});

	pi.registerCommand("demo-hello", {
		description: "C5 夹具命令（仅用于验证扩展被加载并能被列举）",
		handler: async () => {
			console.log("[fixture-ext] demo-hello invoked");
		},
	});
}
