/**
 * core HTTP + SSE 服务 —— 默认绑定 127.0.0.1（CORE_HOST 可放开），安全三件套（S6 §七）：
 * ① 随机 token（Bearer）；② 校验 Host 头防 DNS rebinding；③ 拒绝跨来源（无 CORS）。
 *
 * 事件管道：
 * - Pi 原始事件经 `toAgentEvent` 翻译成我们的 AgentEvent，再经 SSE 广播；
 * - `message_update` 做 16–33ms 合并（同 Block 只发最新快照），避免渲染风暴；
 * - 终态事件（agent_end / agent_settled / approval_request / tool_execution_* 的 start/end）
 *   不参与合并、立即下发，否则 UI 永远停在 streaming（S6 §四·1）。
 *
 * 同源托管：当 `uiDist` 存在时，core 直接 serve 前端静态资源，
 * 浏览器 transport baseUrl 用相对路径 ""（零配置）。静态资源**不要求 Bearer token**
 * （仅是 shell，数据端点才受保护）；API 端点反之必须带 token。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { toAgentEvent } from "./adapt.ts";
import type { AgentEvent, ModelTestRequest, PromptDisposition, ProviderModelsRequest, PutProvidersRequest } from "./contract.ts";
import { DirListError, listDirectories } from "./fs-list.ts";
import { FsSearchError, searchFiles } from "./fs-search.ts";
import { FileReadError, readTextFile } from "./fs-read.ts";
import { checkFileRefs, IMAGE_MAX_BYTES, type PromptImage } from "./prompt-files.ts";

/** 单条消息贴图数量上限（D6；UI 侧 lib/image-attach.ts 的 MAX_IMAGES_PER_MESSAGE 同口径） */
const MAX_PASTED_IMAGES = 8;

/**
 * 粘贴图片批次（task-composer-paste-image.md §5.5）：解析 /prompt body 的可选
 * `images: [{data(base64), mimeType}]`。**不做魔数嗅探、不做缩放/转码** —— 附件
 * 进入 AgentSession.prompt 后由上游 `_normalizePromptImages` → processImage 统一
 * 兜底（异格式转 PNG / autoResize / 失败降级 hints）；这里只守传输层上限：
 * 字段合法性、单图 8MB（IMAGE_MAX_BYTES）、单条消息 8 张（MAX_PASTED_IMAGES），
 * 超限跳过并计入 skippedImages（UI 弹通知），绝不因一张坏图吞掉整条消息。
 */
function parsePastedImages(raw: unknown): { images: PromptImage[]; skipped: string[] } {
	const images: PromptImage[] = [];
	const skipped: string[] = [];
	if (!Array.isArray(raw)) return { images, skipped };
	for (let i = 0; i < raw.length; i++) {
		const label = `图片${i + 1}`;
		const item = raw[i] as { data?: unknown; mimeType?: unknown } | undefined;
		if (
			!item ||
			typeof item !== "object" ||
			typeof item.data !== "string" ||
			item.data.length === 0 ||
			typeof item.mimeType !== "string" ||
			item.mimeType.length === 0
		) {
			skipped.push(`${label}（格式无效）`);
			continue;
		}
		let decoded: Buffer;
		try {
			decoded = Buffer.from(item.data, "base64");
		} catch {
			skipped.push(`${label}（解码失败）`);
			continue;
		}
		if (decoded.length === 0) {
			skipped.push(`${label}（空图片）`);
			continue;
		}
		if (decoded.length > IMAGE_MAX_BYTES) {
			skipped.push(`${label}（超过 8MB）`);
			continue;
		}
		if (images.length >= MAX_PASTED_IMAGES) {
			skipped.push(`${label}（超过单条消息 ${MAX_PASTED_IMAGES} 张上限）`);
			continue;
		}
		images.push({ type: "image", data: item.data, mimeType: item.mimeType });
	}
	return { images, skipped };
}
import { isRecord } from "./guards.ts";
import { InvalidCwdError, SessionManageError, type CoreRuntime } from "./session.ts";
import { SkillNotFoundError } from "./skills.ts";
import { MAX_QUERY_LENGTH, SkillInstallError } from "./skills-install.ts";
import { PackageNotFoundError } from "./packages.ts";
import { ProvidersValidationError } from "./providers.ts";

export interface ServerHandle {
  port: number;
  token: string;
  close(): Promise<void>;
}

interface StartOptions {
  port?: number;
  token?: string;
  /** 绑定地址；默认 127.0.0.1。设 0.0.0.0 可对内网开放（需同步放宽 allowedHosts） */
  host?: string;
  /** 允许的主机名（Host 头校验，**不含端口**），默认 127.0.0.1 与 localhost */
  allowedHosts?: string[];
  /** 前端静态资源目录（vite build 产物）；存在则同源托管 UI */
  uiDist?: string;
  /**
   * POST /cwd 热切换**成功**后以新目录回调（task-desktop-stable-port.md F4）。
   * 装配方（main.ts）用它把 cwd 落回 core.json，桌面端下次启动据此恢复「上次工作目录」；
   * server 自身不感知 runDir，落盘职责留给装配方。缺省不回调 = 行为零变化。
   */
  onCwdChanged?: (cwd: string) => void;
}

const API_ROUTES = new Set([
	"/health",
	"/events",
	"/prompt",
	"/abort",
	"/approve",
	"/cancel-approval",
	// C4 · 会话列表与加载
	"/sessions",
	"/sessions/load",
	"/sessions/image",
	"/sessions/continue-recent",
	// 新建（换入）空白活动会话（task-new-session-page.md D7）
	"/sessions/new",
	// 重命名 / 删除会话（2026-09-28 用户需求：侧栏历史会话行内改名 + 删除）
	"/sessions/rename",
	"/sessions/delete",
	// C5 · 04/05 屏数据源
	"/resources",
	"/models",
	"/models/select",
	"/thinking",
	// C2 · 第二批：模型接真（Provider 读写 / 目录 / 测试）
	"/providers",
	"/models/catalog",
	"/models/test",
	// 拉取 Provider 真实模型清单（设置页「导入模型…」）
	"/providers/models",
	// C6 · 04 屏工具开关接 Pi
	"/tools/active",
	// C7 · 设置弹窗 · 技能 Tab（全量清单含禁用项 + 开关写 settings 模式数组）
	"/skills",
	"/skills/toggle",
	// S1-S2 · 设置弹窗「添加技能」（skills.sh 搜索代理 + GitHub 克隆安装）
	"/skills/search",
	"/skills/install",
	// C8 · 设置弹窗 · 插件 Tab（清单/开关/移除/安装/检查更新）+ 重新加载会话
	"/packages",
	"/packages/toggle",
	"/packages/remove",
	"/packages/install",
	"/packages/check-updates",
	"/packages/update",
	"/session/reload",
	// 斜杠命令清单（内置 / 扩展 / 技能）
	"/slash-commands",
	// D7 · 工作目录运行期热切换
	"/cwd",
	// task-trust-policy-switch · 设置页「项目扩展授权询问」开关（读写 defaultProjectTrust）
	"/trust-policy",
	// dir-picker · 自定义路径弹窗的浏览数据源（只读列子目录）
	"/fs/list",
	// dir-file-preview · 侧栏文件树点开文件的预览数据源（只读限长文本）
	"/fs/read",
	// at-file · Composer @ 弹层的文件模糊搜索数据源（只读文件名）
	"/fs/search",
]);

/**
 * core 直发 AgentEvent 的放行判据（C1 根治，2026-09-29 用户裁决）。
 *
 * **为什么是集中登记放行而不是散落在函数体内的枚举白名单**：原实现是 5 个
 * `e.type === "..."` 的正向枚举，登记点混在 `dispatchAgent` 的函数体里，新增事件类型
 * 要靠人记得手加 —— `skill_progress` 就是这么被静默丢掉的
 * （session.ts:1062-1068 已经发事件，UI 也在订阅，contract.ts:755-762 也已声明，
 * 唯独这里没放行 → 进度条永远不出现；探针/tsc/契约检查全绿也发现不了，
 * 因为漏项不产生任何错误）。改为「**core 直发通道已登记的一律放行、其余丢弃**」后，
 * 登记点从函数体内的 if 链提到模块级、与 `hostnameOf`/`contentTypeOf` 并列，成为单一
 * 可视的登记处：下一个人搜 `skill_progress` 一定能在本文件撞见这一行。
 *
 * **先说清局限，别把它当编译期保证**：本集合运行时仍是 `Set<string>` 白名单，判定逻辑
 * 一个字都没变 —— 新增第 7 种直发 type 而忘登记，**依旧静默丢弃，与 C1 同病同后果**。
 * 防复发不靠类型系统，靠两件事：这个显眼且有文档的登记处（比散落在 if 链里更难漏），
 * 以及 Task 6 落地的端到端 SSE 断言与静态断言兜底。登记依旧靠人记得；真要编译期保证
 * （类型级互斥联合 + 单一真源）需单独立项，本批不做。
 *
 * **本集合不是 `AgentEvent` 的全集**（别当全集看、也别把会话流那批塞进来）：
 * 两条通道是互斥的 —— `dispatch`（批量节流，吃 `runtime.onEvent` 的 Pi 原始事件，
 * 经 toAgentEvent 翻译，见 server.ts:238-248）与 `dispatchAgent`（终态立即下发，
 * 吃 `runtime.onAgentEvent` 的 core 直发事件，见 server.ts:251-256）若同时放行
 * 同一 type，就会双推。故此处只登记**不经会话流翻译**的 6 种：
 * usage、approval_request、approval_settled、cwd_changed、package_progress
 * （contract.ts:372）、skill_progress（contract.ts:374）。
 *
 * 与契约的对应关系（核对 contract.ts:319-374 的 `AgentEvent` 联合，共 16 个成员）：
 * - 会话流 10 种：message_start / message_update / message_end、
 *   tool_execution_start / update / end、turn_start、turn_end、agent_start、
 *   agent_settled —— 走 `dispatch` 通道（adapt.ts:103-139 的翻译清单，与本集合无关）；
 * - core 直发 6 种：usage、approval_request、approval_settled、cwd_changed、
 *   package_progress、skill_progress —— 走本通道。
 * 前者里 `message_update` 另走批量节流（server.ts:241-244），其余即时下发。
 *
 * 维护约定（**C1 防复发的唯一人肉护栏，必须执行**）：新增 core 直发事件时，在此补一行，
 * 并在 UI 侧确认有消费方（`package_progress` 见 ui/src/adapter/reduce.ts:363；
 * `skill_progress` 见 ui/src/screens/settings/SkillsSettingsTab.tsx:134）。补了没消费方
 * 无害（前端忽略即可），不补则事件静默消失（正是 C1 的病根）—— 与上面「先说清局限」
 * 一致：漏登记不会产生任何编译错误，自动化兜底指望 Task 6 的端到端 SSE 断言与静态断言，
 * 不要以为 tsc 能替你发现。
 */
const CORE_DIRECT_EVENT_TYPES = new Set([
	"approval_request",
	"approval_settled",
	"usage",
	"cwd_changed",
	"package_progress",
	"skill_progress",
]);

/**
 * core 直发事件的放行判据：只认本文件登记过的 type（见 CORE_DIRECT_EVENT_TYPES 的维护约定）。
 *
 * 中间的 `typeof e.type === "string"` 是**类型体操需要、不是行为需要**：`e` 形参是
 * `unknown`，`isRecord` 只把它收窄到 `Record<string, unknown>`，`.type` 仍推出
 * `unknown`，而 `Set<string>.has` 不收 `unknown`，tsc 会报错。运行上 `Set.has` 对非
 * string 天然返回 false，加不加这句结果完全一样。**别当冗余防御删掉，删了 typecheck 就红。**
 */
function isDeclaredAgentEvent(e: unknown): boolean {
	return isRecord(e) && typeof e.type === "string" && CORE_DIRECT_EVENT_TYPES.has(e.type);
}

/** 从 Host 头取主机名：`1.2.3.4:5190` → `1.2.3.4`；`[::1]:5190` → `::1`；`localhost` → `localhost` */
function hostnameOf(hostHeader: string): string {
	const h = hostHeader.trim();
	if (h.startsWith("[")) {
		const end = h.indexOf("]");
		return end >= 0 ? h.slice(1, end) : h;
	}
	const colon = h.indexOf(":");
	return colon >= 0 ? h.slice(0, colon) : h;
}

function contentTypeOf(p: string): string {
	const ext = path.extname(p).toLowerCase();
	const map: Record<string, string> = {
		".html": "text/html; charset=utf-8",
		".js": "text/javascript; charset=utf-8",
		".mjs": "text/javascript; charset=utf-8",
		".css": "text/css; charset=utf-8",
		".json": "application/json; charset=utf-8",
		".svg": "image/svg+xml",
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".ico": "image/x-icon",
		".woff2": "font/woff2",
		".map": "application/json; charset=utf-8",
	};
	return map[ext] ?? "application/octet-stream";
}

/**
 * P0-2 硬化：HTTP 入口拒绝 `apiKey` 以 `!` 开头的请求。
 *
 * 漏洞形状：apiKey 的 `!` 前缀语义（providers.ts 的 `resolveCredential`）会走
 * `execSync(raw.slice(1), { shell })` 在 core 进程内执行 shell。而 `!`-前缀的
 * `apiKey` 在「测试连接」路径上的**唯一来源就是 HTTP 请求体**
 * （POST /models/test、POST /providers/models），且无任何前置条件
 * （不需流式空闲、不需配过 models.json、不需目录受信任）⇒ 拿到 token 的任意主体
 * 一个 HTTP 请求 = 任意命令执行。
 *
 * 为什么在这里拦、而不改 `resolveCredential`：
 * - `!` 不是坏功能。保存到 models.json 后，Pi 自己读盘时仍会解析 `!`（该路径
 *   走 `inspectCredential`，providers.ts 明确**不执行**命令）⇒ 保存功能零影响。
 * - 唯一被切断的是「发测试请求时临时跑命令取凭证」这条便利路径（保存仍可用）。
 *   收益：HTTP 面上彻底没有单请求 RCE。
 * - 改 providers.ts 会连带影响磁盘上已配置的 `!` 凭证的读取口径，属过度改动。
 *
 * 与 deploy.md:159 的区别：那份声明的是「拿到 token 的人可以让 **agent** 执行命令」
 * （经对话 + 授权卡 + 审计）。本条是**与对话/模型/授权完全无关**的裸 shell 面。
 */
function credentialCommandRejected(apiKey: unknown): boolean {
	return typeof apiKey === "string" && apiKey.startsWith("!");
}

/** 与 `credentialCommandRejected` 配对的 400 响应（文案点明出路，不静默拒绝） */
const credentialCommandRejectedResponse = () => ({
	status: 400,
	body: {
		error: "不支持在请求里用 `!` 执行本机命令（安全限制）",
		hint: "请改用 $ENV_NAME 引用环境变量，或直接填密钥字面量；`!cmd` 仍可保存到 models.json，Pi 读盘时会自行解析。",
	},
});

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve) => {
		let d = "";
		req.on("data", (c) => (d += c));
		req.on("end", () => {
			try {
				resolve(JSON.parse(d || "{}"));
			} catch {
				resolve({});
			}
		});
	});
}

export function startServer(runtime: CoreRuntime, opts: StartOptions = {}): Promise<ServerHandle> {
	const token = opts.token ?? randomUUID();
	const sseClients = new Set<ServerResponse>();
	let actualPort = opts.port ?? 0;
	let batchTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingUpdate: AgentEvent | null = null;

	const push = (obj: unknown) => {
		const line = `data: ${JSON.stringify(obj)}\n\n`;
		for (const c of sseClients) c.write(line);
	};

	/** 冲掉待发的 message_update 快照（终态/其他事件前先下发最新进度） */
	const flushBatch = () => {
		if (batchTimer) {
			clearTimeout(batchTimer);
			batchTimer = null;
		}
		if (pendingUpdate) {
			push(pendingUpdate);
			pendingUpdate = null;
		}
	};

	/**
	 * SSE 批处理调度（S6 §四·1）：
	 * - message_update：同一窗口内只保留最新快照，~20ms 后下发一次；
	 * - 其余事件（含终态）：先冲掉待发 update，再立即下发。
	 */
	const BATCH_MS = 20;
	const dispatch = (raw: unknown) => {
		const event = toAgentEvent(raw);
		if (!event) return;
		if (event.type === "message_update") {
			pendingUpdate = event;
			if (!batchTimer) batchTimer = setTimeout(flushBatch, BATCH_MS);
		} else {
			flushBatch();
			push(event);
		}
	};

	/** core 直接生成的 AgentEvent（uiContext 授权请求 / 用量快照 / 目录热切换 / 包与技能进度），已是契约形状，终态立即下发；放行判据见 CORE_DIRECT_EVENT_TYPES */
	const dispatchAgent = (e: unknown) => {
		if (isDeclaredAgentEvent(e)) {
			flushBatch();
			push(e);
		}
	};

	runtime.onEvent(dispatch);
	runtime.onAgentEvent(dispatchAgent);

	function serveStatic(res: ServerResponse, urlPath: string): void {
		const uiDist = opts.uiDist;
		if (!uiDist) {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("UI dist 未构建");
			return;
		}
		/*
		 * P0-1 硬化：畸形百分号编码（`/%`、`/%zz`、`/a%2`）会让 decodeURIComponent 抛 URIError。
		 * 抛出去 ⇒ createServer 的 async handler 变成 unhandled rejection ⇒ main.ts 无
		 * unhandledRejection 兜底 ⇒ **整个 core 进程退出**（实测 GET /% ⇒ exit code=1）。
		 * 桌面版更糟：core 一死 desktop/src/main.ts 弹窗并 app.quit()，用户应用被一条本地请求关掉。
		 * ⇒ 400（客户端的错），不静默、不崩；不静默降级 ⇒ 走 HTTP 状态码而非假装 404。
		 */
		let rel: string;
		try {
			rel = decodeURIComponent(urlPath.split("?")[0]);
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "bad request" }));
			return;
		}
		if (rel === "/" || rel === "") rel = "/index.html";
		const filePath = path.normalize(path.join(uiDist, rel));
		// 防目录穿越
		if (filePath !== uiDist && !filePath.startsWith(uiDist + path.sep)) {
			res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("forbidden");
			return;
		}
		const sendFile = (file: string, isHtml: boolean) => {
			fs.readFile(file, (err, buf) => {
				if (err) {
					res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("not found");
					return;
				}
				let body = buf;
				if (isHtml) {
					/*
					 * 把同源 bootstrap token 注入 HTML：页面（feature-flags.getLiveConfig）优先读
					 * `window.__CORE_TOKEN__`，其次才读 `?token=`（供跨源 dev 场景覆盖）。
					 * ⇒ 用户只需要打开 `http://127.0.0.1:<port>/?live=1`，token 不再进 URL/收藏夹。
					 * 安全口径不变：Host 白名单 + Bearer 校验照旧；静态资源本就免鉴权，
					 * 注入不引入新攻击面（本机进程本就能读 run/core.json）。
					 */
					const inject = `<script>window.__CORE_TOKEN__=${JSON.stringify(token)};</script>`;
					body = Buffer.from(buf.toString("utf8").replace("</head>", `${inject}</head>`));
				}
				res.writeHead(200, { "Content-Type": isHtml ? "text/html; charset=utf-8" : contentTypeOf(file) });
				res.end(body);
			});
		};
		fs.stat(filePath, (err, st) => {
			if (!err && st.isFile()) {
				// HTML 判定按扩展名：index.html 真实存在时也必须注入 token（首跑实踩：
				// 只在 SPA 回退分支传 isHtml=true，导致 GET / 拿到的页面没有注入）
				sendFile(filePath, filePath.endsWith(".html"));
				return;
			}
			// SPA 回退：其余 GET 一律回 index.html（应用用 hash 路由，单页即可）
			sendFile(path.join(uiDist, "index.html"), true);
		});
	}

	/*
	 * P0-1 硬化：请求处理收敛为具名函数 + 顶层 try/catch。
	 *
	 * 为什么要这一层（serveStatic 内的 decode 防护只是「最常见的触发点」）：
	 * 整条链上任何一处抛错（未捕获的 JSON 解析、类型假设失败、上游库异常……）
	 * 都会让这个 async handler 返回一个 rejected promise，而 `createServer` **不 await 它**
	 * ⇒ unhandled rejection ⇒ 进程退出。也就是说「一个畸形请求打死后端」是个
	 * 通用形状，不止 /% 这一种载荷。顶层兜底把这类失败一律收敛成 500，
	 * core 继续服务 —— 单个坏请求不该让用户的整个应用消失。
	 *
	 * 纪律（与 main.ts:79 / skills-install.ts 一致）：错误必须**可见**。
	 * 堆栈只进 core 的 stderr（桌面版下用户可经"查看日志"看到），不外泄给客户端；
	 * 响应只给一句固定文案，不把 `String(e)` 直出（另见 P1-9）。
	 */
	const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
	try {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${actualPort}`);
		const urlPath = url.pathname;
		// 白名单按「主机名」比对（与端口解耦）：默认仅本机。CORE_HOST=0.0.0.0 时
		// 需由 CORE_ALLOWED_HOSTS 显式追加内网 IP/域名（见 main.ts），否则内网请求 403。
		const allowed = opts.allowedHosts ?? ["127.0.0.1", "localhost"];

		// ② 防 DNS rebinding：校验 Host 头（对所有请求生效，含静态资源）
		const host = req.headers["host"];
		if (!host || !allowed.includes(hostnameOf(host))) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "forbidden host" }));
			return;
		}

		// ① 鉴权：Bearer token（仅对 API 端点生效；静态资源为公开 shell）
		if (API_ROUTES.has(urlPath)) {
			const auth = req.headers["authorization"];
			// 唯一豁免：`/sessions/image` 额外接受 `?token=`（2026-10-01 图片预览批次）。
			//
			// 为什么需要这条豁免：调用方是浏览器里的 `<img src=...>`，而 `<img>` **无法携带
			// 自定义请求头** —— fetch/XHR 能在 headers 里放 Authorization，img 标签不能（用
			// cookie 就要改整套安全模型）。实测：带 Bearer 头的 agent 可以 GET，但页面里
			// 任何一个 <img> 拿 /sessions/image 都是 401 ⇒ Task 6/7 的 UI 接线全部拿不到字节。
			// 旁证：本仓已有同款先例 —— feature-flags.ts 的 `?token=`（跨源 dev 场景，
			// UI 读 getLiveConfig().token），core 同源托管时还会把 token 注入
			// `window.__CORE_TOKEN__`，本机进程本就能读 run/core.json。
			//
			// 为什么严格限定这一个路由：token 进 URL 会经 Referer 泄露给第三方资源、
			// 落在浏览器历史/日志里 —— 这是 Bearer 头**没有**的额外暴露面。若整条
			// API_ROUTES 都放开，任何一个能注入 <img>/<link> 的地方就等于把 core 的
			// 全权限（能读任意文件、驱动 agent）交出去。豁免只给「只读、已在
			// API_ROUTES 后面跑同一套 Host 白名单 + 三元组校验」的取图端点，不外扩。
			//
			// 比对口径：**严格相等**（非空串、不做前缀/大小写宽容）；token 由 config 生成，
			// 无形状可猜，猜中即等于拿到 Bearer 本身。
			const queryToken =
				urlPath === "/sessions/image" ? url.searchParams.get("token") ?? "" : "";
			if ((!auth || auth !== `Bearer ${token}`) && queryToken !== token) {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "unauthorized" }));
				return;
			}
		}

		const json = (code: number, body: unknown) => {
			res.writeHead(code, { "Content-Type": "application/json" });
			res.end(JSON.stringify(body));
		};

		if (req.method === "GET" && urlPath === "/health") {
			// C3：补发信任门结论与扩展数 —— 信任门三态（never/always/ask）的直接证据来源。
			// 会话就绪前 trust / extensions 为 null（服务已可用，只是会话还在初始化）。
			// model：2026-09-24 起服务允许「无模型」启动（首启 models.json 为空），
			// 这里显式暴露 null，运维一眼能看出「服务活着但还没配模型」。
			return json(200, {
				ok: true,
				sseClients: sseClients.size,
				port: actualPort,
				extensions: runtime.getExtensionCount(),
				trust: runtime.getTrust(),
				model: runtime.getActiveModel(),
				// D7：运维可见性（流式中的会话正在生成回复；POST /cwd 据此 409）
				streaming: runtime.isStreaming(),
			});
		}

		if (req.method === "GET" && urlPath === "/events") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			res.write(": connected\n\n");
			sseClients.add(res);
			/*
			 * ★ C3：补发「连接之前就已下发」的未决授权请求。
			 * 场景一（必须）：ask 态信任门在会话创建前提问，而 core 此时才刚 listen，
			 * 浏览器/脚本还没连上 SSE —— 不补发则提问永久丢失、启动卡死到超时。
			 * 场景二（顺手）：页面刷新 / SSE 短暂断线重连后，未决授权卡还能重新出现。
			 */
			for (const pending of runtime.getPendingApprovals()) push(pending);
			const hb = setInterval(() => res.write(": ping\n\n"), 15000);
			req.on("close", () => {
				clearInterval(hb);
				sseClients.delete(res);
			});
			return;
		}

		/* -----------------------------------------------------------------
		 * /prompt（at-file 批次扩展：body 增可选 fileRefs，task-composer-at-file.md §4.2）
		 * fileRefs 缺省/空 ⇒ 与旧请求逐字节等价（旧 UI 新 core 零风险）；非空时每个
		 * 引用展开成 <file> 前置块（文本）或图片附件（魔数判定），读不到的引用跳过
		 * 并在响应里带 skippedFiles（UI 弹通知）——不让一条坏引用吞掉整条消息。
		 * ----------------------------------------------------------------- */
		if (req.method === "POST" && urlPath === "/prompt") {
			const body = (await readBody(req)) as { text?: string; fileRefs?: unknown; images?: unknown };
			const text = String(body.text ?? "");
			const refs = Array.isArray(body.fileRefs)
				? body.fileRefs.filter((r): r is string => typeof r === "string" && r.trim().length > 0)
				: [];
			try {
				/*
				 * 粘图批次：贴图先行解析（超限/非法计 skippedImages，不阻塞发送）。
				 * ★ 2026-10-02：@引用不再注入上下文——`fileRefs` 仅用于「这个路径当前读不到」
				 * 的提前提示（skippedFiles），内容一律交给模型自己read/ls 取（见
				 * prompt-files.ts 文件头）。因此 finalText 恒等于用户原文。
				 */
				const pasted = parsePastedImages(body.images);
				const unreadable = refs.length > 0 ? checkFileRefs(refs, runtime.getCwd()) : [];
				const images = pasted.images.length > 0 ? pasted.images : undefined;
				// 纯图无文本兜底：Anthropic 对 content 里的空 text 块直接 400，补一行占位
				//（与上游 anthropic-messages.ts 纯图时插的 "(see attached image)" 同措辞）
				const finalText = images && !text.trim() ? "(see attached image)" : text;
				const disposition = await runtime.prompt(finalText, images);
				const resp: {
					ok: boolean;
					disposition: PromptDisposition;
					skippedFiles?: string[];
					skippedImages?: string[];
				} = { ok: true, disposition };
				if (unreadable.length > 0) resp.skippedFiles = unreadable;
				if (pasted.skipped.length > 0) resp.skippedImages = pasted.skipped;
				return json(200, resp);
			} catch (e) {
				return json(500, { ok: false, error: String(e) });
			}
		}

		if (req.method === "POST" && urlPath === "/abort") {
			await runtime.abort();
			return json(200, { ok: true });
		}

		if (req.method === "POST" && urlPath === "/approve") {
			const body = (await readBody(req)) as { requestId?: string; choice?: string };
			const r = runtime.resolveApproval(String(body.requestId ?? ""), String(body.choice ?? ""));
			return json(200, { ok: true, accepted: r.accepted });
		}

		// C3 新增：取消授权（与「拒绝」语义不同 —— 扩展读到的是「取消」而非某个选项文案）
		if (req.method === "POST" && urlPath === "/cancel-approval") {
			const body = (await readBody(req)) as { requestId?: string };
			const r = runtime.cancelApproval(String(body.requestId ?? ""));
			return json(200, { ok: true, accepted: r.accepted });
		}

		/* -----------------------------------------------------------------
		 * D7 · 工作目录运行期热切换（POST /cwd {dir?}）
		 * dir 缺省/空 = core 默认目录（process.cwd()）。流式中 409、目录无效 400，
		 * 成功回 `{ ok, cwd, trust }`；同时经 SSE 广播 `cwd_changed`（多标签页同步）。
		 * ----------------------------------------------------------------- */
		if (req.method === "POST" && urlPath === "/cwd") {
			const body = (await readBody(req)) as { dir?: string };
			// 前置护栏：不偷偷中止正在生成的回复（switchCwd 内还有同判据兜底）
			if (runtime.isStreaming()) {
				return json(409, { ok: false, error: "会话正在生成回复，请先停止再切换目录" });
			}
			const dir = typeof body.dir === "string" && body.dir.trim().length > 0 ? body.dir.trim() : null;
			try {
				const r = await runtime.switchCwd(dir);
				// F4：切换成功即回调（装配方落盘 core.json），与上面的 SSE 广播同为「成功后」副作用
				opts.onCwdChanged?.(r.cwd);
				return json(200, { ok: true, cwd: r.cwd, trust: r.trust });
			} catch (e) {
				if (e instanceof InvalidCwdError) return json(400, { ok: false, error: e.message });
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		/* -----------------------------------------------------------------
		 * dir-picker · 目录浏览（GET /fs/list?path=...，task-dir-picker.md §4.1）
		 * 只读列名字，给「自定义路径」弹窗（仅目录）与侧栏文件树（dir-tree 批次
		 * task-sidebar-file-tree.md，?include=files 时文件一并列入）当数据源；
		 * 可预期失败由 DirListError 带状态码（400 不存在/不是目录、403 无权限），
		 * 与意外错误 500 区分。
		 * ----------------------------------------------------------------- */
		if (req.method === "GET" && urlPath === "/fs/list") {
			// 参数口径沿用 /sessions 的 all=1 先例：精确匹配才生效，其它取值同缺省（仅目录）
			const includeFiles = url.searchParams.get("include") === "files";
			try {
				return json(
					200,
					listDirectories(url.searchParams.get("path") ?? "", runtime.getCwd(), { includeFiles }),
				);
			} catch (e) {
				if (e instanceof DirListError) return json(e.status, { ok: false, error: e.message });
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		/* -----------------------------------------------------------------
		 * dir-file-preview · 文件读取（GET /fs/read?path=...，fs-read.ts）
		 * 只读限长文本，给侧栏文件树点开的右侧预览区当数据源；
		 * 可预期失败由 FileReadError 带状态码（400 不存在/不是文件、403 无权限），
		 * 与意外错误 500 区分——/fs/list 同款分支。
		 * ----------------------------------------------------------------- */
		if (req.method === "GET" && urlPath === "/fs/read") {
			try {
				return json(200, readTextFile(url.searchParams.get("path") ?? "", runtime.getCwd()));
			} catch (e) {
				if (e instanceof FileReadError) return json(e.status, { ok: false, error: e.message });
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		/* -----------------------------------------------------------------
		 * at-file · 文件模糊搜索（GET /fs/search?q=&path=&limit=，fs-search.ts）
		 * Composer @ 弹层的数据源：cwd 内只读文件名，模糊匹配取 top N。
		 * 可预期失败由 FsSearchError 带状态码（400 不存在/不是目录、403 无权限），
		 * 与意外错误 500 区分——/fs/list 同款分支。
		 * ----------------------------------------------------------------- */
		if (req.method === "GET" && urlPath === "/fs/search") {
			const limitRaw = Number(url.searchParams.get("limit") ?? "");
			try {
				return json(
					200,
					searchFiles(url.searchParams.get("path") ?? "", runtime.getCwd(), url.searchParams.get("q") ?? "", {
						limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
					}),
				);
			} catch (e) {
				if (e instanceof FsSearchError) return json(e.status, { ok: false, error: e.message });
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		/* -----------------------------------------------------------------
		 * C4 · 会话列表与加载（S2：历史加载 ≠ 事件重放，映射在 sessions.ts）
		 * ----------------------------------------------------------------- */

		// 清单：默认当前工作目录；`?all=1` 跨项目目录（listAll）
		if (req.method === "GET" && urlPath === "/sessions") {
			const all = url.searchParams.get("all") === "1";
			try {
				const sessions = await runtime.listSessions({ all });
				return json(200, { ok: true, cwd: runtime.getCwd(), sessions });
			} catch (e) {
				return json(500, { ok: false, error: String(e), sessions: [] });
			}
		}

		// 加载：返回 `{ id, title, updatedAt, messages, tokenUsage, stats }`
		// —— `messages` 即规格书的 `Message[]`（外层带上标题/用量，省掉 UI 的二次请求）
		if (req.method === "POST" && urlPath === "/sessions/load") {
			const body = (await readBody(req)) as { id?: string };
			const id = String(body.id ?? "");
			if (!id) return json(400, { ok: false, error: "缺少 id" });
			try {
				const result = await runtime.loadSession(id);
				if (!result) return json(404, { ok: false, error: `会话不存在：${id}` });
				return json(200, { ok: true, ...result });
			} catch (e) {
				return json(500, { ok: false, error: String(e) });
			}
		}

		// 取历史会话里的单张图片（2026-10-01 图片预览批次）
		// ImageBlock 只带定位三元组，字节在这里兑现 —— 避免 base64 内联进
		// /sessions/load 响应（最坏 85MB/条消息打在这个零限制接口上）。
		// Cache-Control immutable：session 文件 append-only，历史图片字节永不改变。
		if (req.method === "GET" && urlPath === "/sessions/image") {
			const sessionId = url.searchParams.get("sessionId") ?? "";
			const entryId = url.searchParams.get("entryId") ?? "";
			const partIndexRaw = url.searchParams.get("partIndex") ?? "";
			const partIndex = Number(partIndexRaw);
			if (!sessionId || !entryId || !partIndexRaw || !Number.isInteger(partIndex)) {
				return json(400, { ok: false, error: "缺少或非法的 sessionId/entryId/partIndex" });
			}
			// ⚠️ 写头与写盘**在** try 内：ERR_INVALID_CHAR 是 writeHead 抛的、不是
			// readSessionImage 抛的。try 包在 await 外面这层（可读性），内层再兜一手
			// （纵深）—— 即使将来 mimeType 的白名单被绕过，也只掉一条连接，不掉整个进程。
			try {
				let result: Awaited<ReturnType<CoreRuntime["readSessionImage"]>>;
				try {
					result = await runtime.readSessionImage({ sessionId, entryId, partIndex });
				} catch (e) {
					return json(500, { ok: false, error: String(e) });
				}
				if (!result.ok) return json(result.status, { ok: false, error: result.error });
				res.writeHead(200, {
					// mimeType 已由 readSessionImage 过白名单（不含 CR/LF ⇒ 不触发 ERR_INVALID_CHAR）
					"Content-Type": result.mimeType,
					"Content-Length": String(result.bytes.length),
					// append-only 会话文件 ⇒ 历史图片字节不可变，可长期强缓存
					"Cache-Control": "private, max-age=31536000, immutable",
					// 成本 0：图片由白名单定型，不给浏览器嗅探空间
					"X-Content-Type-Options": "nosniff",
				});
				res.end(result.bytes);
			} catch (e) {
				// json() 自己只写死 Content-Type: application/json，值来自这里不受数据影响 ⇒ 不再复发
				return json(500, { ok: false, error: String(e) });
			}
			return;
		}

		// 续接最近：读出内容并把活动会话切过去（C6 §1.2，重建路径见 session.ts 的 rebuildSession）
		if (req.method === "POST" && urlPath === "/sessions/continue-recent") {
			try {
				const result = await runtime.continueRecentSession();
				return json(200, { ok: true, ...result });
			} catch (e) {
				return json(500, { ok: false, error: String(e) });
			}
		}

		// 新建（换入）空白活动会话（task-new-session-page.md D7）：只换内存活动会话，
		// Pi 首条 entry 追加时才落盘文件 —— 调用时机由 UI 把握（草稿态首条消息发送时）。
		if (req.method === "POST" && urlPath === "/sessions/new") {
			// 前置护栏：不偷偷中止正在生成的回复（runtime.newSession 内还有同判据兜底）
			if (runtime.isStreaming()) {
				return json(409, { ok: false, error: "会话正在生成回复，请先停止再新建会话" });
			}
			try {
				const id = await runtime.newSession();
				return json(200, { ok: true, id });
			} catch (e) {
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		// 重命名会话（2026-09-28 用户需求）：写 Pi 的 session_info name entry，
		// 清单与加载标题的 name 口径天然生效。false = 会话不存在（404）。
		if (req.method === "POST" && urlPath === "/sessions/rename") {
			const body = (await readBody(req)) as { id?: unknown; title?: unknown };
			const id = typeof body.id === "string" ? body.id : "";
			const title = typeof body.title === "string" ? body.title : "";
			if (!id) return json(400, { ok: false, error: "缺少 id" });
			if (!title.trim()) return json(400, { ok: false, error: "缺少 title" });
			try {
				const found = await runtime.renameSession(id, title);
				if (!found) return json(404, { ok: false, error: `会话不存在：${id}` });
				return json(200, { ok: true });
			} catch (e) {
				if (e instanceof SessionManageError) return json(e.status, { ok: false, error: e.message });
				return json(500, { ok: false, error: String(e) });
			}
		}

		// 删除会话（同上）：unlink 会话文件；目标是活动会话时 runtime 内部先换入空白会话。
		if (req.method === "POST" && urlPath === "/sessions/delete") {
			const body = (await readBody(req)) as { id?: unknown };
			const id = typeof body.id === "string" ? body.id : "";
			if (!id) return json(400, { ok: false, error: "缺少 id" });
			try {
				await runtime.deleteSession(id);
				return json(200, { ok: true });
			} catch (e) {
				if (e instanceof SessionManageError) return json(e.status, { ok: false, error: e.message });
				return json(500, { ok: false, error: String(e) });
			}
		}

		/* -----------------------------------------------------------------
		 * C5 · 04/05 屏数据源
		 * ----------------------------------------------------------------- */

		if (req.method === "GET" && urlPath === "/resources") {
			try {
				const resources = await runtime.getResources();
				return json(200, { ok: true, ...resources });
			} catch (e) {
				return json(500, { ok: false, error: String(e) });
			}
		}

		/* -----------------------------------------------------------------
		 * C7 · 设置弹窗 · 技能 Tab（skills.ts）
		 * 清单是 resolve() 的全量口径（**含被 `!路径` 模式禁用的技能**），
		 * 与 04 屏的 GET /resources（已加载子集）是两回事。
		 * ----------------------------------------------------------------- */

		if (req.method === "GET" && urlPath === "/skills") {
			try {
				const payload = await runtime.getSkills();
				return json(200, { ok: true, ...payload });
			} catch (e) {
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		if (req.method === "POST" && urlPath === "/skills/toggle") {
			const body = (await readBody(req)) as { path?: unknown; enabled?: unknown };
			if (typeof body.path !== "string" || body.path.length === 0 || typeof body.enabled !== "boolean") {
				return json(400, { ok: false, error: "请求体缺少 path / enabled" });
			}
			// 前置护栏：不偷偷打断正在生成的回复（runtime.toggleSkill 内还有同判据兜底）
			if (runtime.isStreaming()) {
				return json(409, { ok: false, error: "会话正在生成回复，请先停止再切换技能" });
			}
			try {
				const result = await runtime.toggleSkill({ path: body.path, enabled: body.enabled });
				return json(200, { ok: true, ...result });
			} catch (e) {
				// 技能不存在（被删/被移走）→ 404，与意外错误 500 区分
				if (e instanceof SkillNotFoundError) return json(404, { ok: false, error: e.message });
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		if (req.method === "GET" && urlPath === "/skills/search") {
			const q = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).searchParams
				.get("q")
				?.trim();
			if (!q) {
				return json(400, { ok: false, error: "缺少查询参数 q" });
			}
			// q 会原样拼进 skills.sh 的代理 URL（见 runtime.searchSkills），无上限时
			// 超长 q 会撑出超长请求行/URL（I8）。超出即判为非法入参 400，不去打上游。
			if (q.length > MAX_QUERY_LENGTH) {
				return json(400, {
					ok: false,
					error: `查询参数 q 过长（上限 ${MAX_QUERY_LENGTH} 字符）`,
				});
			}
			try {
				const payload = await runtime.searchSkills(q);
				return json(200, { ok: true, ...payload });
			} catch (e) {
				// 上游失败/超时原文透出（带 skills.sh host），不美化
				return json(502, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		if (req.method === "POST" && urlPath === "/skills/install") {
			const body = (await readBody(req)) as { source?: unknown; skillId?: unknown; scope?: unknown };
			if (
				typeof body.source !== "string" ||
				body.source.trim().length === 0 ||
				typeof body.skillId !== "string" ||
				body.skillId.trim().length === 0 ||
				(body.scope !== "user" && body.scope !== "project")
			) {
				return json(400, { ok: false, error: "请求体缺少 source / skillId / scope" });
			}
			if (runtime.isStreaming()) {
				return json(409, { ok: false, error: "会话正在生成回复，请先停止再安装技能" });
			}
			try {
				const result = await runtime.installSkill({
					source: body.source.trim(),
					skillId: body.skillId.trim(),
					scope: body.scope,
				});
				return json(200, { ok: true, ...result });
			} catch (e) {
				// 可预期失败（非法来源 400 / 仓库无此技能 404 / 同名目录冲突 409）与意外错误（500）区分
				if (e instanceof SkillInstallError) return json(e.status, { ok: false, error: e.message });
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		/* -----------------------------------------------------------------
		 * C8 · 设置弹窗 · 插件 Tab（packages.ts）
		 * 清单是 settings `packages` 的 user+project 双 scope 全量（含未安装的
		 * missing 项）；开关=对象形 `{source, autoload:false}`；进度经 SSE
		 * `package_progress` 下发（安装/移除/更新进行中）。
		 * ----------------------------------------------------------------- */

		if (req.method === "GET" && urlPath === "/packages") {
			try {
				const payload = await runtime.getPackages();
				return json(200, { ok: true, ...payload });
			} catch (e) {
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		if (req.method === "POST" && urlPath === "/packages/toggle") {
			const body = (await readBody(req)) as { source?: unknown; scope?: unknown; enabled?: unknown };
			if (
				typeof body.source !== "string" ||
				body.source.length === 0 ||
				(body.scope !== "user" && body.scope !== "project") ||
				typeof body.enabled !== "boolean"
			) {
				return json(400, { ok: false, error: "请求体缺少 source / scope / enabled" });
			}
			if (runtime.isStreaming()) {
				return json(409, { ok: false, error: "会话正在生成回复，请先停止再切换插件" });
			}
			try {
				const result = await runtime.togglePackage({
					source: body.source,
					scope: body.scope,
					enabled: body.enabled,
				});
				return json(200, { ok: true, ...result });
			} catch (e) {
				if (e instanceof PackageNotFoundError) return json(404, { ok: false, error: e.message });
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		if (req.method === "POST" && urlPath === "/packages/remove") {
			const body = (await readBody(req)) as { source?: unknown; scope?: unknown };
			if (typeof body.source !== "string" || body.source.length === 0 || (body.scope !== "user" && body.scope !== "project")) {
				return json(400, { ok: false, error: "请求体缺少 source / scope" });
			}
			if (runtime.isStreaming()) {
				return json(409, { ok: false, error: "会话正在生成回复，请先停止再移除插件" });
			}
			try {
				const result = await runtime.removePackage({ source: body.source, scope: body.scope });
				return json(200, { ok: true, ...result });
			} catch (e) {
				if (e instanceof PackageNotFoundError) return json(404, { ok: false, error: e.message });
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		if (req.method === "GET" && urlPath === "/slash-commands") {
			try {
				const payload = await runtime.getSlashCommands();
				return json(200, { ok: true, ...payload });
			} catch (e) {
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		if (req.method === "POST" && urlPath === "/session/reload") {
			// 重新加载会话：重读 settings + 资源 + 扩展（历史保留）；流式中拒绝
			if (runtime.isStreaming()) {
				return json(409, { ok: false, error: "会话正在生成回复，请先停止再重新加载会话" });
			}
			try {
				await runtime.reloadSession();
				return json(200, { ok: true });
			} catch (e) {
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		/* ----- C8 · B2：安装 / 检查更新（npm/git 需联网；本地路径包离线可用） ----- */

		if (req.method === "POST" && urlPath === "/packages/install") {
			const body = (await readBody(req)) as { source?: unknown; local?: unknown };
			if (typeof body.source !== "string" || body.source.trim().length === 0) {
				return json(400, { ok: false, error: "请求体缺少 source" });
			}
			if (runtime.isStreaming()) {
				return json(409, { ok: false, error: "会话正在生成回复，请先停止再安装插件" });
			}
			try {
				const result = await runtime.installPackage({
					source: body.source.trim(),
					local: body.local === true,
				});
				return json(200, { ok: true, ...result });
			} catch (e) {
				// 安装失败（source 非法 / 网络 / git 缺失）文案取 core 原文，UI 安装弹窗原样显示
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		if (req.method === "POST" && urlPath === "/packages/check-updates") {
			try {
				const result = await runtime.checkPackageUpdates();
				return json(200, { ok: true, ...result });
			} catch (e) {
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		if (req.method === "POST" && urlPath === "/packages/update") {
			const body = (await readBody(req)) as { source?: unknown };
			if (runtime.isStreaming()) {
				return json(409, { ok: false, error: "会话正在生成回复，请先停止再更新插件" });
			}
			try {
				const result = await runtime.updatePackage({
					...(typeof body.source === "string" && body.source.length > 0 ? { source: body.source } : {}),
				});
				return json(200, { ok: true, ...result });
			} catch (e) {
				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
			}
		}

		if (req.method === "GET" && urlPath === "/models") {
			try {
				const payload = await runtime.getModels();
				return json(200, { ok: true, ...payload });
			} catch (e) {
				return json(500, { ok: false, error: String(e) });
			}
		}

		if (req.method === "POST" && urlPath === "/models/select") {
			const body = (await readBody(req)) as { provider?: string; modelId?: string };
			const provider = String(body.provider ?? "");
			const modelId = String(body.modelId ?? "");
			if (!provider || !modelId) return json(400, { ok: false, error: "缺少 provider / modelId" });
			try {
				const payload = await runtime.selectModel(provider, modelId);
				return json(200, { ok: true, ...payload });
			} catch (e) {
				return json(400, { ok: false, error: String(e) });
			}
		}

		if (req.method === "POST" && urlPath === "/thinking") {
			const body = (await readBody(req)) as { level?: string };
			const level = String(body.level ?? "");
			if (!level) return json(400, { ok: false, error: "缺少 level" });
			try {
				const payload = await runtime.setThinkingLevel(level);
				return json(200, { ok: true, ...payload });
			} catch (e) {
				return json(400, { ok: false, error: String(e) });
			}
		}

		/* -----------------------------------------------------------------
		 * task-trust-policy-switch · 设置页「项目扩展授权询问」开关
		 *
		 * 读写 Pi settings.json 的 `defaultProjectTrust`（**全局字段**）。
		 * 返回形状就地内联 —— 与 `/cwd`、`/fs/list` 同款，**不进 `contract.ts`**
		 * （那三者也没进；`/thinking` 能复用 `ModelsPayload` 是特例，本批没有这个便利）。
		 * ----------------------------------------------------------------- */

		if (req.method === "GET" && urlPath === "/trust-policy") {
			// 只读、且不依赖会话就绪（getTrustPolicy 内部对未 boot 情形返回出厂口径）
			return json(200, { ok: true, ...runtime.getTrustPolicy() });
		}

		if (req.method === "POST" && urlPath === "/trust-policy") {
			const body = (await readBody(req)) as { ask?: unknown };
			// 必须严格布尔 —— 防 `"false"`（真值串）这类混入被当成 true 落盘
			if (typeof body.ask !== "boolean") {
				return json(400, { ok: false, error: "ask 必须是布尔值" });
			}
			try {
				const payload = await runtime.setTrustPolicy(body.ask);
				return json(200, { ok: true, ...payload });
			} catch (e) {
				return json(400, { ok: false, error: String(e) });
			}
		}

		/* -----------------------------------------------------------------
		 * C6 · 04 屏工具开关（`tools.ts`；安全三件套经 API_ROUTES 同样生效）
		 * ----------------------------------------------------------------- */

		if (req.method === "GET" && urlPath === "/tools/active") {
			try {
				const payload = await runtime.getTools();
				return json(200, { ok: true, ...payload });
			} catch (e) {
				return json(500, { ok: false, error: String(e) });
			}
		}

		if (req.method === "POST" && urlPath === "/tools/active") {
			const body = (await readBody(req)) as { names?: unknown };
			if (!Array.isArray(body.names)) return json(400, { ok: false, error: "缺少 names 数组" });
			const names = body.names.map((n) => String(n));
			try {
				const payload = await runtime.setTools(names);
				return json(200, { ok: true, ...payload });
			} catch (e) {
				// 未注册的工具名 → 400（core 侧显式校验，不依赖上游的静默忽略）
				return json(400, { ok: false, error: String(e) });
			}
		}

		/* -----------------------------------------------------------------
		 * C2 · 第二批：模型接真（Provider 读写 / 目录 / 测试）
		 * 安全面（Bearer 401 + Host 403）经上方 API_ROUTES 统一覆盖。
		 * ----------------------------------------------------------------- */

		// 读取并合并 models.json + sidecar（带 enabled 标志）；解析失败返回结构化 {error}，不 500
		if (req.method === "GET" && urlPath === "/providers") {
			try {
				const payload = runtime.listProviders();
				return json(200, { ok: true, ...payload });
			} catch (e) {
				return json(200, { error: e instanceof Error ? e.message : String(e) });
			}
		}

		// 全量替换写回：按 enabled 拆分写 models.json / sidecar，refresh + 回退检测
		if (req.method === "PUT" && urlPath === "/providers") {
			const body = (await readBody(req)) as PutProvidersRequest;
			if (!body || !Array.isArray(body.providers)) {
				return json(400, { error: "请求体缺少 providers 数组" });
			}
			try {
				const result = await runtime.saveProviders(body);
				return json(200, { ok: true, ...result });
			} catch (e) {
				// S-029：compat 等非法值 → 4xx 拒绝落盘（双闸之一：即便绕过 UI 直发 PUT 也拦得住）；
				// 其余（读失败等）沿用既有 200+error 口径，UI 回落 mock 并提示。
				if (e instanceof ProvidersValidationError) return json(e.status, { ok: false, error: e.message });
				return json(200, { error: e instanceof Error ? e.message : String(e) });
			}
		}

		// 内置目录检索（不出网），按 id/name 不区分大小写匹配，上限 20 条
		if (req.method === "GET" && urlPath === "/models/catalog") {
			try {
				const q = url.searchParams.get("q") ?? "";
				const payload = runtime.searchCatalog(q);
				return json(200, { ok: true, ...payload });
			} catch (e) {
				return json(200, { error: e instanceof Error ? e.message : String(e) });
			}
		}

		// 一次性最小真实请求（max_tokens:1），不落盘、不改当前选择
		if (req.method === "POST" && urlPath === "/models/test") {
			const body = (await readBody(req)) as ModelTestRequest;
			if (!body || typeof body.baseUrl !== "string" || typeof body.modelId !== "string") {
				return json(400, { error: "请求体缺少 baseUrl / modelId" });
			}
			if (credentialCommandRejected(body.apiKey)) {
				const r = credentialCommandRejectedResponse();
				return json(r.status, r.body);
			}
			try {
				const result = await runtime.testModel(body);
				return json(200, result);
			} catch (e) {
				return json(200, { error: e instanceof Error ? e.message : String(e) });
			}
		}

		// 拉取该 Provider 的真实模型清单（GET {baseUrl}/models），不落盘、不改当前选择
		if (req.method === "POST" && urlPath === "/providers/models") {
			const body = (await readBody(req)) as ProviderModelsRequest;
			if (!body || typeof body.baseUrl !== "string") {
				return json(400, { error: "请求体缺少 baseUrl" });
			}
			if (credentialCommandRejected(body.apiKey)) {
				const r = credentialCommandRejectedResponse();
				return json(r.status, r.body);
			}
			try {
				const result = await runtime.listProviderModels(body);
				return json(200, result);
			} catch (e) {
				return json(200, { ok: false, models: [], error: e instanceof Error ? e.message : String(e) });
			}
		}

		// API_ROUTES 声明过的路径落到这里 = 声明了却没匹配上（漏实现 / core 落后于前端），
		// 明确 404，绝不回 SPA HTML——否则 404 伪装成「HTTP 200」，前端 res.json() 解析失败
		// 只会报出自相矛盾的错误（2026-09-28 技能清单事故的根因路径在此关闭）。
		// 未声明路径的 GET 仍走 SPA 回退（应用用 hash 路由，单页即可）。
		if (API_ROUTES.has(urlPath)) {
			return json(404, { error: `端点未实现: ${urlPath}（core 版本可能落后于前端，请重新构建）` });
		}

		// 静态资源（SPA）：仅处理 GET，其余返回 404
		if (req.method === "GET") {
			return serveStatic(res, urlPath);
		}

		return json(404, { error: "not found" });
	} catch (e) {
		/*
		 * 逃逸到这里 = 某个 handler 抛了未预期的异常。记全堆栈（证据留给人），
		 * 回 500（不假装成功、不静默吞掉）。响应已发出则只能记日志不能改状态码 ——
		 * 那种情况下 res.writeHead 已抛 ERR_HTTP_HEADERS_SENT，再写会二次抛。
		 */
		console.error(`[core] ${req.method ?? "?"} ${req.url ?? "?"} 处理失败:`, e);
		if (!res.headersSent) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "internal error" }));
		}
	}
	};

	const server = createServer((req, res) => {
		// 显式吞掉 rejection：绝不把 async handler 的失败漏成 unhandledRejection
		void handleRequest(req, res).catch((e) => {
			console.error(`[core] ${req.method ?? "?"} ${req.url ?? "?"} 处理失败（外层）:`, e);
			if (!res.headersSent && !res.writableEnded) {
				try {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "internal error" }));
				} catch {
					/* 响应已不可写：只留上面的日志 */
				}
			}
		});
	});

	return new Promise((resolve) => {
		server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
			const addr = server.address();
			actualPort = typeof addr === "object" && addr ? addr.port : opts.port ?? 0;
			resolve({
				port: actualPort,
				token,
				close: () =>
					new Promise<void>((r) => {
						if (batchTimer) clearTimeout(batchTimer);
						flushBatch();
						for (const c of sseClients) c.end();
						server.close(() => r());
					}),
			});
		});
	});
}
