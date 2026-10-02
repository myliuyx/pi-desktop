/**
 * Pi Workbench —— Electron 主进程（桌面壳，规格书 .plan/task-desktop-build.md P2）。
 *
 * 职责：起 core 子进程（D3：ELECTRON_RUN_AS_NODE + process.execPath，用户机器免装 Node）
 * → 轮询读 <userData>/run/core.json 拿 port+token（core 的既有稳定契约，core 在
 * listen 之后、会话就绪之前写入，见 core main.ts 的 C3 注释）→ 开窗口加载
 * http://127.0.0.1:<port>/?live=1（D7：恒 live，core 同源托管 ui/dist 并注入 token）。
 *
 * 资源布局（P3，electron-builder extraResources，与 package.json 的 build 段对齐）：
 *   打包后 process.resourcesPath/ 下：ui-dist/（前端构建产物）、core/dist + core/node_modules +
 *   core/package.json（core 以「dist + 依赖树」整体放置，保证 Node 的 node_modules 向上解析命中）。
 *   开发态直接用仓库相对路径（需先 build ui 与 core）。
 *
 * 退出纪律：Windows 上 core 还会 spawn 工具子进程，必须 taskkill /T 整树杀——
 * 孤儿进程是本项目历史重灾区（npm 包装一层导致孙进程存活占端口）。
 *
 * 运行：`npm run dev`（开窗口）/ `npm run smoke`（无窗口进程级冒烟：起 core → 读
 * core.json → /health 探活 → 整树杀干净 → 无残留进程才算过，对应判据 B3）。
 */

import { app, BrowserWindow, ipcMain, Menu, dialog, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { buildBootCoreEnv } from "./boot-env";
import { mergeExitLastRun, type LastRunState } from "./last-run";

/** --smoke：无窗口进程级冒烟（B3 的自动化口径） */
const SMOKE = process.argv.includes("--smoke");
/** core.json 轮询上限。首启要初始化 agentDir/模型清单，给足余量 */
const READINESS_TIMEOUT_MS = 90_000;

app.setName("Pi Workbench");
// dev 与安装版分开 userData：互不抢单实例锁，运行时文件（run/）也隔离
const userDataDir = path.join(
	app.getPath("appData"),
	app.isPackaged ? "Pi Workbench" : "Pi Workbench-dev",
);
/**
 * 旧版 userData 目录名（产品曾名为 Pi-Desktop）→ 新目录的一次性搬迁，避免重装像「配置全丢」。
 *
 * 为什么要搬：userData 里除 Electron 缓存外还有 run/last-run.json（**跨启动记忆**）。
 * 它一丢，下次启动就是随机端口 → origin 变动 → localStorage 里的 recent-dirs / theme
 * 等偏好分裂成新孤岛（多 origin 各存一份的旧问题）。搬一下成本极低。
 *
 * 只搬**同形态**的旧目录（安装版找 Pi-Desktop，dev 找 Pi-Desktop-dev）：两形态的 run/
 * 互相独立、刻意不共享，把对方的目录吞进来会串味。
 *
 * 纪律同 readLastRun：新目录已存在就不覆盖、旧目录一律保留（不擅自删用户数据），
 * 任何异常吞掉按无旧数据启动，绝不阻断。
 */
const legacyUserDir = app.isPackaged ? "Pi-Desktop" : "Pi-Desktop-dev";
{
	const from = path.join(app.getPath("appData"), legacyUserDir);
	if (fs.existsSync(from)) {
		try {
			if (!fs.existsSync(userDataDir)) {
				fs.renameSync(from, userDataDir);
				console.log(
					`[desktop] 已把旧用户数据目录 ${legacyUserDir} 迁移为 ${path.basename(userDataDir)}`,
				);
			} else {
				console.log(
					`[desktop] 跳过旧用户数据目录 ${legacyUserDir} 的迁移：新目录已存在（旧目录保留，未删除）`,
				);
			}
		} catch (err) {
			console.warn(`[desktop] 旧用户数据目录 ${legacyUserDir} 迁移失败（忽略，按新目录空启动）：${err}`);
		}
	}
}
app.setPath("userData", userDataDir);

const coreEntry = app.isPackaged
	? path.join(process.resourcesPath, "core", "dist", "main.js")
	: path.join(__dirname, "..", "..", "core", "dist", "main.js");
const uiDistDir = app.isPackaged
	? path.join(process.resourcesPath, "ui-dist")
	: path.join(__dirname, "..", "..", "ui", "dist");
const runDir = path.join(app.getPath("userData"), "run");
/**
 * agent 目录（CR-072/CR-074）：Pi 约定位置 `~/.pi/agent`，与 CLI / 自托管 core 共用同一份
 * models.json / settings.json / 会话；**由桌面壳自己算出，不由宿主 CORE_AGENT_DIR 决定**。
 * 注意这里用 Electron 的 `app.getPath("home")` 而非 core 侧的 `os.homedir()` —— 两者在
 * 打包形态下取值一致，但若删掉下方对 `CORE_AGENT_DIR` 的注入，core 会回落到自己的默认值，
 * 届时两边算法可能分叉，改动此处务必连带确认该前提。
 */
const agentDir = path.join(app.getPath("home"), ".pi", "agent");
/** 预加载脚本产物路径（tsc 与 main.js 同目录产出；sandbox 下暴露窗口控制 API） */
const preloadEntry = path.join(__dirname, "preload.js");

/**
 * 跨启动记忆（task-desktop-stable-port.md F1/F4）：上次 core 实际绑定端口 + 生效工作目录。
 *
 * 端口复用使页面 origin 稳定——localStorage 按 origin 隔离，CORE_PORT=0 的随机端口会把
 * recent-dirs/theme 等全部偏好变成各次启动的孤岛（leveldb 实证：10 个 origin 各存一份）。
 * cwd 记忆使重启自动回到上次目录——live 下此前根本没有这个机制（POST /cwd 只改内存，
 * core 启动回落 process.cwd()）。与 core.json 分开放的原因：core.json 每次 spawn 前必须删
 * （防旧端口竞态），这份恰恰要跨启动存活。坏文件一律视同缺失，不崩、下次成功启动后覆盖写好。
 */
/**
 * ★ F1/F4 断链修复（2026-10-02）：`writeLastRun` 的唯一调用点原本在启动编排的 `.then()`
 * 里 —— 记忆只在 core 就绪那一刻写一次，运行期 `POST /cwd` 热切换**无人在场回写**
 * ⇒ `last-run.json.cwd` 永远停在「上次启动时的快照」（A→B→C 用完退出，下次回到上次
 * 启动时的目录而非 C）。
 *
 * 修复 = 退出时补写一次：core.json 的 cwd 由 core 的 `updateCoreJsonCwd` 在
 * `POST /cwd` 返回 200 **之前**同步落盘（`writeFileSync`），恒为最后切到的目录、无竞态，
 * 故退出时直读即可，无需新增通知通道。判定逻辑在纯函数 `last-run.ts`
 * （`scripts/last-run-check.mjs` 回归）；取舍：崩溃/强杀丢这一次更新，退化到修复前行为。
 *
 * 读取失败（core 尚未就绪即被杀 / 旧版 core.json 无 cwd 字段）保留原记忆，见 mergeExitLastRun。
 */
function readLastRun(): LastRunState {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(runDir, "last-run.json"), "utf8")) as {
			port?: unknown;
			cwd?: unknown;
		};
		const port =
			typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535
				? raw.port
				: 0;
		const cwdRaw = typeof raw.cwd === "string" ? raw.cwd.trim() : "";
		const cwd = cwdRaw && path.isAbsolute(cwdRaw) ? cwdRaw : null;
		return { port, cwd };
	} catch {
		return { port: 0, cwd: null };
	}
}

function writeLastRun(state: LastRunState): void {
	try {
		fs.writeFileSync(path.join(runDir, "last-run.json"), JSON.stringify(state, null, 2));
	} catch {
		/* 写失败不影响本次运行（与 recent-dirs 同纪律） */
	}
}

let core: ChildProcess | null = null;
let quitting = false;
let stderrTail = "";

function killCore(): void {
	if (!core) return;
	const child = core;
	core = null;
	try {
		if (process.platform === "win32") {
			// 整树杀：core（及它 spawn 的工具进程）一个不留
			spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
		} else {
			child.kill("SIGTERM");
		}
	} catch {
		/* 已退出 */
	}
}

function failLoudly(title: string, detail: string): void {
	console.error(`[desktop] ${title}: ${detail}`);
	if (SMOKE) return; // smoke 走非 0 退出 + stderr，不弹窗
	dialog.showErrorBox(title, detail);
}

/** 递归取目录下指定扩展名文件的最新 mtime；目录不存在返回 0（调用方按「无从比对」放行） */
function newestMtime(root: string, exts: string[]): number {
	let newest = 0;
	const walk = (dir: string): void => {
		for (const name of fs.readdirSync(dir)) {
			const p = path.join(dir, name);
			const st = fs.statSync(p);
			if (st.isDirectory()) walk(p);
			else if (exts.some((e) => name.endsWith(e))) newest = Math.max(newest, st.mtimeMs);
		}
	};
	try {
		walk(root);
	} catch {
		return 0;
	}
	return newest;
}

/**
 * dev 形态的 core 产物新鲜度闸：core 以 dist 编译产物运行（tsx 直跑只存在于
 * CORE_PORT=5190 的验收链路），改了 core/src 不重 build 就会跑旧产物 ——
 * 2026-09-28 实锤事故：dist 停在 9-25，没有 /skills 路由，GET /skills 落进
 * SPA 回退返回 200 + index.html，前端报「读取技能清单失败（HTTP 200）」。
 * 这里在拉起 core 前比对 src 与 dist 的最新 mtime，过期点名报错并返回 false
 * （退出由调用点统一控制，避免 bootCore 同步栈里 exit 后仍把旧 core 拉起来）。
 * 打包形态 resourcesPath 里没有 core/src，无从比对即放行。
 */
function assertCoreDistFresh(): boolean {
	if (app.isPackaged) return true;
	const srcDir = path.join(__dirname, "..", "..", "core", "src");
	const distDir = path.join(__dirname, "..", "..", "core", "dist");
	if (!fs.existsSync(srcDir) || !fs.existsSync(distDir)) return true;
	const srcNewest = newestMtime(srcDir, [".ts"]);
	const distNewest = newestMtime(distDir, [".js"]);
	if (srcNewest <= distNewest) return true;
	const fmt = (ms: number) => (ms ? new Date(ms).toLocaleString() : "（无）");
	failLoudly(
		"Pi Workbench",
		`core 编译产物已过期（core/src 的改动晚于 core/dist）：\n` +
			`  最新源码：${fmt(srcNewest)}\n  现有产物：${fmt(distNewest)}\n\n` +
			`请先在 packages/core 下执行 npm run build，再启动 Pi Workbench。`,
	);
	return false;
}

/**
 * 拉起 core 子进程（**一次尝试**，不含重试编排——见 startCoreWithFallback）。
 *
 * 端口：`preferredPort` 非 0 = 复用 last-run.json 记忆端口（F1，origin 稳定保住
 * localStorage 偏好）；0 = OS 随机分配（首启 / smoke / 退避）。被占时 core 会因
 * server.ts 的 listen 无 error handler 直接崩退（stderr 带 EADDRINUSE、core.json
 * 不写出）——这个「崩溃」正是退避重试的结构信号，不要在 core 侧给它挂 error handler。
 * cwd：非空 = 上次工作目录（F4，core 对失效目录已有警告回落兜底）；null 不设该键，
 * 空字符串会踩 core 的「空白值警告回落」分支，白报警告。
 */
function bootCore(
	preferredPort: number,
	cwd: string | null,
): { child: ChildProcess; markReady: () => void } {
	fs.mkdirSync(runDir, { recursive: true });
	// CR-072/CR-074：agentDir 显式钉死为 Pi 约定位置 ~/.pi/agent（不随宿主 CORE_AGENT_DIR 漂移，
	// boot-env 白名单照旧丢弃宿主 CORE_*，安全性质与原先 userData 落点时期一致）
	fs.mkdirSync(agentDir, { recursive: true });
	// 上一次运行遗留的 core.json 是死端口，必须清掉——否则 waitForCore 会抢在
	// 新 core 覆盖之前读到旧文件，health 探活打在死端口上（B3 首跑实踩）
	fs.rmSync(path.join(runDir, "core.json"), { force: true });
	if (!fs.existsSync(coreEntry)) {
		failLoudly(
			"Pi Workbench",
			`找不到 core 入口：\n${coreEntry}\n\n请先在 packages/core 下执行 npm run build`,
		);
		app.exit(1);
	}
	if (!fs.existsSync(path.join(uiDistDir, "index.html"))) {
		failLoudly(
			"Pi Workbench",
			`找不到前端构建产物：\n${uiDistDir}\n\n请先在 packages/ui 下执行 npm run build`,
		);
		app.exit(1);
	}
	/*
	 * CR-072：env 白名单化（buildBootCoreEnv）——桌面壳对 core 的 env 完全收敛。宿主残留的
	 * CORE_HOST=0.0.0.0 / CORE_TOKEN / CORE_AGENT_DIR 等一律不透传；桌面 core 只绑回环
	 * （CORE_HOST=127.0.0.1）、token 由 core 随机生成、agentDir 由桌面壳自己算出（CR-074）。
	 * F1/F4 在此白名单内注入本轮取值：端口 = 记忆复用或 0（随机），cwd = 上次工作目录。
	 */
	const { env: coreEnv, warnings } = buildBootCoreEnv({
		parentEnv: process.env,
		runDir,
		uiDist: uiDistDir,
		agentDir,
		port: String(preferredPort),
		cwd: cwd ?? undefined,
	});
	// 宿主残留的 CORE_* 被逐条丢弃（CR-072）：点名告警，不静默吞掉
	for (const key of warnings) {
		console.warn(
			`[desktop] 警告: 检测到宿主环境变量 ${key} —— 桌面壳已忽略它，core 的该项按安全白名单取值（CR-072，桌面 core 仅绑回环、token 随机生成）`,
		);
	}
	const child = spawn(process.execPath, [coreEntry], {
		env: coreEnv,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	core = child;
	const tail = (chunk: Buffer) => {
		stderrTail = (stderrTail + chunk.toString()).slice(-4000);
	};
	child.stdout?.on("data", tail);
	child.stderr?.on("data", tail);
	/*
	 * 「意外死亡要弹窗」只对**已就绪**的 core 成立：就绪前退出是启动尝试的失败形态
	 * （端口被占的 EADDRINUSE 崩退也在其中），由 startCoreWithFallback 的重试/失败
	 * 路径统一处理——否则弹窗会拦住退避重试。ready 之后死亡仍立即点名退出。
	 */
	let ready = false;
	child.on("exit", (code) => {
		if (core === child) core = null;
		if (quitting || !ready) return;
		// 服务进程意外死亡：点名原因，不留一个白窗口
		failLoudly("后台服务已退出", `core 进程退出（code=${code ?? "?"}）：\n\n${stderrTail.slice(-800)}`);
		app.quit();
	});
	return {
		child,
		markReady: () => {
			ready = true;
		},
	};
}

interface CoreInfo {
	port: number;
	token: string;
	/** core 当前生效工作目录（F4）；旧 core.json 无该字段时为 undefined，按「无 cwd 记忆」处理 */
	cwd?: string;
}

function readCoreInfo(): CoreInfo | null {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(runDir, "core.json"), "utf8")) as CoreInfo;
		if (typeof raw.port === "number" && typeof raw.token === "string") {
			return {
				port: raw.port,
				token: raw.token,
				cwd: typeof raw.cwd === "string" && raw.cwd.trim().length > 0 ? raw.cwd : undefined,
			};
		}
	} catch {
		/* 未就绪 */
	}
	return null;
}

async function waitForCore(): Promise<CoreInfo | null> {
	const t0 = Date.now();
	for (;;) {
		const info = readCoreInfo();
		if (info) return info;
		if (Date.now() - t0 > READINESS_TIMEOUT_MS) return null;
		if (!core) return null; // 进程没了就别等了
		await new Promise((r) => setTimeout(r, 200));
	}
}

/**
 * 启动编排（F1/F2）：优先复用 last-run.json 记忆端口，被占退避随机。
 *
 * 「被占」的外形 = core 在 core.json 写出前就退了（listen EADDRINUSE 崩退，见
 * bootCore 注释）。**结构判定而非 stderr 字符串匹配**：非端口原因的启动失败重试一次
 * 也会同样失败，最终由调用方 failLoudly 带出 stderrTail 真实诊断——一次亚秒级冗余
 * spawn 换取不依赖错误文案的稳健性。CORE_CWD 两轮都带：目录恢复与端口无关（F4）。
 */
async function startCoreWithFallback(last: LastRunState): Promise<CoreInfo | null> {
	const attempts = last.port >= 1 ? [last.port, 0] : [0];
	for (let i = 0; i < attempts.length; i++) {
		const { child, markReady } = bootCore(attempts[i], last.cwd);
		const info = await waitForCore();
		if (info) {
			markReady();
			return info;
		}
		// 还活着但 90s 未就绪（挂起）：整树杀掉再换枪，不留占着端口的孤儿（A7）
		if (child.exitCode === null && !child.killed) killCore();
	}
	return null;
}

function healthOk(port: number, token: string): Promise<boolean> {
	return new Promise((resolve) => {
		// /health 在 core 的 API_ROUTES 里，同样要 Bearer token（401 会伪装成「服务没起」）
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path: "/health",
				method: "GET",
				timeout: 5000,
				headers: { Authorization: `Bearer ${token}` },
			},
			(res) => {
				res.resume();
				resolve(res.statusCode === 200);
			},
		);
		req.on("error", () => resolve(false));
		req.on("timeout", () => {
			req.destroy();
			resolve(false);
		});
		req.end();
	});
}

/** 等子进程真正退场（smoke 的「无孤儿进程」以它为准） */
async function waitForExit(child: ChildProcess, timeoutMs = 8000): Promise<boolean> {
	if (child.exitCode !== null || child.killed) return true;
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

async function runSmoke(): Promise<void> {
	// smoke 是一次性诊断进程：固定随机端口、不读写 last-run.json（二.7，不污染用户记忆）
	const { child, markReady } = bootCore(0, null);
	const info = await waitForCore();
	if (!info) {
		quitting = true;
		killCore();
		console.error(`[desktop] SMOKE_FAIL 未读到 core.json（${READINESS_TIMEOUT_MS}ms）\n${stderrTail}`);
		app.exit(1);
		return;
	}
	markReady();
	const ok = await healthOk(info.port, info.token);
	quitting = true;
	killCore();
	const exited = await waitForExit(child);
	if (ok && exited) {
		console.log(`[desktop] SMOKE_OK port=${info.port} core 已退场，无孤儿进程`);
		app.exit(0);
	} else {
		console.error(`[desktop] SMOKE_FAIL health=${ok} exited=${exited}\n${stderrTail}`);
		app.exit(1);
	}
}

let mainWindow: BrowserWindow | null = null;

function createWindow(url: string): void {
	/*
	 * 无边框（frame:false）：原生标题栏整体移除。
	 *
	 * 它显示 document.title（index.html 的 "Atlas Agent · 设计系统基础"）且跟随**系统**
	 * 主题配色 —— 应用内切深色后顶部会剩一条白色标题栏（2026-09-28 用户反馈；
	 * web 端无 OS chrome 所以没这个问题）。窗口 chrome 改由 UI 自绘标题栏
	 * （packages/ui 的 TitleBar）承担：拖拽走 -webkit-app-region，窗口控件经
	 * preload 的 window.piWorkbench 走 IPC 回到下面的 registerWindowIpc。
	 */
	if (!fs.existsSync(preloadEntry)) {
		failLoudly(
			"Pi Workbench",
			`找不到预加载脚本：\n${preloadEntry}\n\n请先在 packages/desktop 下执行 npm run build`,
		);
		app.exit(1);
		return;
	}
	mainWindow = new BrowserWindow({
		width: 1360,
		height: 860,
		title: "Pi Workbench",
		autoHideMenuBar: true,
		backgroundColor: "#111114",
		frame: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			preload: preloadEntry,
		},
	});
	registerWindowIpc(mainWindow);
	/*
	 * 导航守卫（2026-09-28 review P2）：agent 输出的链接是不可信内容，Markdown 渲染的
	 * 外链是 target="_blank" —— 触发的 window.open 一律拒绝弹窗，http/https 转交系统默认
	 * 浏览器（纯 deny 会把外链变成无声死链），其他协议静默拒绝。will-navigate 兜底主窗口
	 * 永不离站：hash 路由属 in-page 导航不触发该事件（electron 44 d.ts 口径），SPA 不受影响。
	 */
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url);
		return { action: "deny" };
	});
	mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());
	mainWindow.loadURL(url);
	mainWindow.on("closed", () => {
		mainWindow = null;
	});
}

/**
 * 窗口控制 IPC —— 渲染层（TitleBar 的窗口控件）经 preload 调到这里。
 *
 * 单窗口应用，随 createWindow 注册一次（IPC handler 不重复注册）；
 * win 由闭包持有，不再走 mainWindow 判空。maximize/unmaximize 事件回送
 * 渲染层，供最大化按钮在「最大化 / 还原」之间切换图标与标签。
 */
function registerWindowIpc(win: BrowserWindow): void {
	ipcMain.on("window:minimize", () => win.minimize());
	ipcMain.on("window:toggle-maximize", () => {
		if (win.isMaximized()) win.unmaximize();
		else win.maximize();
	});
	ipcMain.on("window:close", () => win.close());
	ipcMain.handle("window:is-maximized", () => win.isMaximized());
	const notifyMaximizeChange = () => {
		if (!win.isDestroyed()) win.webContents.send("window:maximize-change", win.isMaximized());
	};
	win.on("maximize", notifyMaximizeChange);
	win.on("unmaximize", notifyMaximizeChange);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.focus();
		}
	});

	app.whenReady().then(() => {
		Menu.setApplicationMenu(null); // 干净壳：不暴露菜单栏（v1）
		// core 产物新鲜度闸压在 smoke / 正常启动所有路径之前：过期就不拉 core
		if (!assertCoreDistFresh()) {
			app.exit(1);
			return;
		}
		if (SMOKE) {
			void runSmoke();
			return;
		}
		void startCoreWithFallback(readLastRun()).then((info) => {
			if (!info) {
				failLoudly(
					"启动失败",
					`后台服务未在 ${READINESS_TIMEOUT_MS / 1000}s 内就绪：\n\n${stderrTail.slice(-1200)}`,
				);
				app.exit(1);
				return;
			}
			// 端口 + 目录落成记忆（F1/F4）：无论是否走过退避都写，幂等；启动失败不写
			writeLastRun({ port: info.port, cwd: info.cwd ?? null });
			createWindow(`http://127.0.0.1:${info.port}/?live=1`);
		});
	});

	app.on("window-all-closed", () => {
		app.quit();
	});
	app.on("before-quit", () => {
		// ★ 必须排在 killCore 之前：core.json 的 cwd 是同步落盘的实时真值，
		// 但 core 一旦被杀后续写就没了 —— 先读后杀，顺序不能反。
		// 写失败不影响本次运行（与 recent-dirs 同纪律）。
		writeLastRun(mergeExitLastRun(readLastRun(), readCoreInfo()?.cwd));
		quitting = true;
		killCore();
	});
}
