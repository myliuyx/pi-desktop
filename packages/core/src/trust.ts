/**
 * 项目本地资源信任门（C3）—— 用户裁决 **A3：跟随 Pi**（`decision-rulings-2026-09-23.md` A·5）。
 *
 * ## 为什么需要我们自己写这一段
 *
 * 归因实验（裁决单 A·2）结论：**信任门存在，但 SDK 模式默认绕过它**
 * —— 门在 `resource-loader.ts` 的 `reload({ resolveProjectTrust })` 两段式里，
 * 只有显式传了回调的入口（CLI `main.ts:745`、`package-manager-cli.ts:773`）才有门。
 * `createAgentSession` 内部的 `DefaultResourceLoader.reload()` **不传该回调**
 * （`sdk.js:77-78`）→ 项目本地扩展按可信加载并直接执行（spike 实测到 5 个扩展）。
 *
 * ## 实现路径（本模块的定位）
 *
 * 我们**不重新发明机制**，只把 Pi 的语义搬进来：
 * ① core 自建 `DefaultResourceLoader` 并显式 `reload({ resolveProjectTrust })`
 *    （两段式由 Pi 执行：先 bootstrap 加载「全局/临时」扩展，再由本模块裁决，最后全量加载）；
 * ② 裁决规则 = `hasTrustRequiringProjectResources(cwd)` + `settingsManager.getDefaultProjectTrust()`：
 *    - `always` → 直接信任；`never` → 不信任；
 *    - `ask`（默认）→ 经 `uiContext` 向 UI 提问（与授权卡同一条 SSE 往返），
 *      结论经 `settingsManager.setProjectTrusted(...)` 写回（`reload` 也会再写一次）。
 * 未使用的 Pi 现成实现：`resolveProjectTrusted()`（`project-trust.js`，**未从包顶层导出**）
 * —— 它的选项集（Trust / Trust parent / session-only）是 CLI 口径，我们只做「信任 / 不信任」两键。
 *
 * ## 安全底线（裁决原文）
 *
 * 「默认配置下，未经用户确认的项目本地扩展**不得执行**」→ 因此：
 * 提问**超时**、**无人应答**、**任何异常**，一律按**不信任**收尾。
 */

import {
	hasTrustRequiringProjectResources,
	type DefaultProjectTrust,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** 信任结论的归因（写进证据/日志/`/health`，便于复核「为什么信任/不信任」） */
export type TrustReason =
	| "no-project-resources"
	| "always"
	| "never"
	| "user-accepted"
	| "user-declined"
	| "cancelled"
	| "error";

export interface TrustQuestion {
	title: string;
	options: string[];
	/** 用户选中的文案；超时/取消为 undefined */
	answer?: string;
	timeoutMs?: number;
}

export interface TrustDecision {
	trusted: boolean;
	reason: TrustReason;
	cwd: string;
	defaultProjectTrust: DefaultProjectTrust;
	/** 是否真的向 UI 提问过（`never`/`always`/无项目资源时为 false） */
	asked: boolean;
	question?: TrustQuestion;
	elapsedMs: number;
	error?: string;
}

/** 提问标题必须**明示后果**（裁决单 A·5 的要求）：项目本地扩展是会被执行的代码 */
export const TRUST_TITLE_HEAD = "将加载并执行项目本地扩展";
export const TRUST_ACCEPT = "信任并加载项目本地扩展";
export const TRUST_DECLINE = "不信任（本次不加载）";

/**
 * 提问等待上限。超时按**不信任**收尾（安全默认）。
 * 存在的意义：core 启动早期就会提问，若此时没有任何 UI 客户端连着，
 * 没有上限就会永久卡在启动阶段（无人应答 ⇒ 死锁）。
 */
export const DEFAULT_TRUST_TIMEOUT_MS = 120_000;

/** 提问函数（由 ui-context 提供；抽成函数类型便于单测与解耦） */
export type AskFn = (title: string, options: string[], timeoutMs?: number) => Promise<string | undefined>;

export interface ResolveProjectTrustOptions {
	cwd: string;
	settingsManager: SettingsManager;
	ask: AskFn;
	timeoutMs?: number;
}

export async function resolveProjectTrust(options: ResolveProjectTrustOptions): Promise<TrustDecision> {
	const startedAt = Date.now();
	const { cwd, settingsManager } = options;
	const defaultProjectTrust = settingsManager.getDefaultProjectTrust();

	const done = (trusted: boolean, reason: TrustReason, extra: Partial<TrustDecision> = {}): TrustDecision => {
		// 裁决结论交给 SettingsManager：后续 `packageManager.resolve()` 按它决定
		// 是否加载项目本地扩展/包（reload 内部还会用返回值再写一次，这里是显式留痕）
		settingsManager.setProjectTrusted(trusted);
		return {
			trusted,
			reason,
			cwd,
			defaultProjectTrust,
			asked: false,
			elapsedMs: Date.now() - startedAt,
			...extra,
		};
	};

	// 无项目本地资源 ⇒ 没什么可信任的，不必打扰用户（裁决单 A·2 指定谓词）
	if (!hasTrustRequiringProjectResources(cwd)) return done(true, "no-project-resources");

	if (defaultProjectTrust === "always") return done(true, "always");
	if (defaultProjectTrust === "never") return done(false, "never");

	const title = [
		TRUST_TITLE_HEAD,
		"",
		`目录：${cwd}`,
		"",
		"该目录下的 .pi/extensions 等资源是可执行代码，授权后本次会话会加载并执行它们。",
		"（来源：Pi settings.json 的 defaultProjectTrust = ask）",
	].join("\n");
	const timeoutMs = options.timeoutMs ?? DEFAULT_TRUST_TIMEOUT_MS;
	const question: TrustQuestion = { title, options: [TRUST_ACCEPT, TRUST_DECLINE], timeoutMs };

	try {
		const answer = await options.ask(title, question.options, timeoutMs);
		question.answer = answer;
		if (answer === TRUST_ACCEPT) return done(true, "user-accepted", { asked: true, question });
		if (answer === undefined) return done(false, "cancelled", { asked: true, question });
		// 其余（含显式选择「不信任」）一律按不信任处理 —— 白名单式判定
		return done(false, "user-declined", { asked: true, question });
	} catch (error) {
		return done(false, "error", { asked: true, question, error: String(error) });
	}
}
