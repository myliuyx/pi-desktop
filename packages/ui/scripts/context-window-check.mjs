/**
 * 上下文窗口真值解析断言 —— 纯函数、不需要浏览器、不需要 core。
 * 运行：npm run check:context-window
 *
 * 背景：输入框底行上下文环的窗口分母此前是 UI 侧 mock 演示值 128000（假事实）。
 * 本断言锁死 `resolveContextWindow` 的三级优先级与"未知纪律"：
 *   ① core 的 usage.contextWindow（>0，最新最权威）→ 直接用；
 *   ② GET /models 清单里**当前模型**的 contextWindow（覆盖首条消息前的空窗期）；
 *   ③ 都取不到 → 0（未知）⇒ 渲染层显示「—」，绝不回落任何演示值。
 */
import { resolveContextWindow } from "../src/lib/context-window.ts";

let failed = 0;
function check(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failed++;
	console.log(
		`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`,
	);
}

const model = (provider, id, contextWindow) => ({ id, provider, label: id, ...(contextWindow === undefined ? {} : { contextWindow }) });
const payload = (models, current) => ({
	models,
	current,
	thinkingLevel: "off",
	availableThinkingLevels: ["off"],
	settings: { provider: null, modelId: null, thinkingLevel: null },
	ready: true,
});

/* ① usage 事件/会话加载带来的窗口最权威 —— 即使清单里是别的模型的窗口也用它 */
check("①usage>0 优先", resolveContextWindow(1_000_000, payload([model("p", "a", 256_000)], { provider: "p", modelId: "a" })), 1_000_000);

/* ② usage 为 0（草稿清零）或 undefined ⇒ 回落当前模型的清单值 */
check("②usage=0 回落清单", resolveContextWindow(0, payload([model("p", "a", 1_000_000)], { provider: "p", modelId: "a" })), 1_000_000);
check("②usage=undefined 回落清单", resolveContextWindow(undefined, payload([model("p", "a", 31_072)], { provider: "p", modelId: "a" })), 31_072);

/* ③ 模型没配窗口 / 配 0 ⇒ 未知（0），不借用别的模型的窗口 */
check("③缺省不借用", resolveContextWindow(0, payload([model("p", "a")], { provider: "p", modelId: "a" })), 0);
check("③配0不借用", resolveContextWindow(0, payload([model("p", "a", 0)], { provider: "p", modelId: "a" })), 0);

/* ④ current 为 null（无模型/未选型）⇒ 未知 */
check("④current为null", resolveContextWindow(0, payload([model("p", "a", 1_000_000)], null)), 0);

/* ⑤ current 指向的模型不在清单里（切换后快照未刷新）⇒ 未知 */
check("⑤current不在清单", resolveContextWindow(0, payload([model("p", "other", 256_000)], { provider: "p", modelId: "a" })), 0);

/* ⑥ payload 未就绪（live 数据未到 / mock 形态）：无 usage ⇒ 未知；有 usage 真值 ⇒ usage 优先 */
check("⑥payload=null", resolveContextWindow(0, null), 0);
check("⑥payload=undefined", resolveContextWindow(128000, undefined), 128000);

/* ⑦ 同 provider 同 id 才算命中（provider 键是唯一性来源） */
check("⑦provider不匹配", resolveContextWindow(0, payload([model("other", "a", 1_000_000)], { provider: "p", modelId: "a" })), 0);

if (failed > 0) {
	console.error(`\n上下文窗口解析断言失败 ${failed} 项`);
	process.exit(1);
}
console.log("上下文窗口解析断言全部通过");