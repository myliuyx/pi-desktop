/**
 * C5 夹具：**项目本地扩展**（`<cwd>/.pi/extensions/`，`scope: "project"`）。
 *
 * 它的唯一用途是验证 **04 屏数据源的信任门过滤**（`S6 §四·3`）：
 * - 信任门结论 `trusted=false`（never / ask+拒绝 / 超时）→ **不得出现在 `/resources.extensions`**，
 *   且 `filteredProjectCount ≥ 1`；
 * - `trusted=true`（always / ask+信任）→ 出现在清单里，来源标记为「项目内」。
 *
 * 与 `approval-gate.ts` 一样，**代码落在本仓库**，不依赖被 gitignore 的 `pi/`。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		console.log("[fixture-ext] project-local extension loaded（项目本地扩展，受信任门管辖）");
	});

	pi.registerCommand("project-hello", {
		description: "C5 夹具：项目本地扩展注册的命令",
		handler: async () => {
			console.log("[fixture-ext] project-hello invoked");
		},
	});
}
