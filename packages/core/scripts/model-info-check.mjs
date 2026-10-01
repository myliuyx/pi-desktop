/**
 * `ModelInfo.contextWindow` 透传断言 —— 纯函数、不起 core 服务。
 * 运行：npm run check:model-info
 *
 * 背景：输入框上下文环的窗口分母必须来自模型配置真值（Pi 的 `Model.contextWindow`），
 * 而不是 UI 侧的 mock 演示值 128000。本断言锁死 `toModelInfo` 的透传与"未知纪律"：
 * 数值 >0 才写字段；0 / 缺省 / 脏值一律**不写键**（`undefined`），让消费方走降级态，
 * 绝不把 0 或字符串冒充成已知窗口。
 *
 * 依赖 Node 的 --experimental-strip-types（package.json 已加 flag）以 import .ts。
 */

import { toModelInfo } from "../src/models.ts";

let failed = 0;
function check(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failed++;
	console.log(
		`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`,
	);
}

const model = (over) => ({ id: "m", provider: "p", ...over });

/* 1. 正常透传：Pi 模型配置的窗口原样带出（本批次的核心用例） */
check("①contextWindow 透传", toModelInfo(model({ contextWindow: 1_000_000 })).contextWindow, 1_000_000);
check("①31072 透传", toModelInfo(model({ contextWindow: 31_072 })).contextWindow, 31_072);

/* 2. 缺省（窄桩 / 旧 payload）→ 键不存在，消费方走未知降级 */
check("②缺省不写键", "contextWindow" in toModelInfo(model({})), false);
check("②缺省值为 undefined", toModelInfo(model({})).contextWindow, undefined);

/* 3. 0 不写键：0 是"没配"，不是"窗口为零"（探针 U7 的 `invalid contextWindow` 同纪律） */
check("③contextWindow=0 不写键", "contextWindow" in toModelInfo(model({ contextWindow: 0 })), false);

/* 4. 脏值不写键：字符串 / NaN / 负数 —— 宁缺勿假 */
check("④字符串不写键", "contextWindow" in toModelInfo(model({ contextWindow: "128000" })), false);
check("④NaN 不写键", "contextWindow" in toModelInfo(model({ contextWindow: Number.NaN })), false);
check("④负数不写键", "contextWindow" in toModelInfo(model({ contextWindow: -1 })), false);

/* 5. 既有字段不许回归（contextWindow 是新增，不许顶掉别的） */
{
	const info = toModelInfo(model({ name: "X", reasoning: true, input: ["text", "image"], contextWindow: 256_000 }), "P");
	check("⑤label 仍正确", info.label, "X");
	check("⑤providerLabel 仍正确", info.providerLabel, "P");
	check("⑤supportsXhigh 仍正确", info.supportsXhigh, true);
	check("⑤input 仍正确", info.input, ["text", "image"]);
	check("⑤contextWindow 与 input 共存", info.contextWindow, 256_000);
}

if (failed > 0) {
	console.error(`\nModelInfo 透传断言失败 ${failed} 项`);
	process.exit(1);
}
console.log("ModelInfo 透传断言全部通过");