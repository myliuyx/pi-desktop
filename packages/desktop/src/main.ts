/**
 * Pi-Desktop —— Electron 主进程（桌面壳，规格书 .plan/task-desktop-build.md P2）。
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

import { app, BrowserWindow, Menu, dialog } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

/** --smoke：无窗口进程级冒烟（B3 的自动化口径） */
const SMOKE = process.argv.includes("--smoke");
/** core.json 轮询上限。首启要初始化 agentDir/模型清单，给足余量 */
const READINESS_TIMEOUT_MS = 90_000;

app.setName("Pi-Desktop");
// dev 与安装版分开 userData：互不抢单实例锁，运行时文件（run/）也隔离
app.setPath(
	"userData",
	path.join(app.getPath("appData"), app.isPackaged ? "Pi-Desktop" : "Pi-Desktop-dev"),
);

const coreEntry = app.isPackaged
	? path.join(process.resourcesPath, "core", "dist", "main.js")
	: path.join(__dirname, "..", "..", "core", "dist", "main.js");
const uiDistDir = app.isPackaged
	? path.join(process.resourcesPath, "ui-dist")
	: path.join(__dirname, "..", "..", "ui", "dist");
const runDir = path.join(app.getPath("userData"), "run");

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

function bootCore(): ChildProcess {
	fs.mkdirSync(runDir, { recursive: true });
	// 上一次运行遗留的 core.json 是死端口，必须清掉——否则 waitForCore 会抢在
	// 新 core 覆盖之前读到旧文件，health 探活打在死端口上（B3 首跑实踩）
	fs.rmSync(path.join(runDir, "core.json"), { force: true });
	if (!fs.existsSync(coreEntry)) {
		failLoudly(
			"Pi-Desktop",
			`找不到 core 入口：\n${coreEntry}\n\n请先在 packages/core 下执行 npm run build`,
		);
		app.exit(1);
	}
	if (!fs.existsSync(path.join(uiDistDir, "index.html"))) {
		failLoudly(
			"Pi-Desktop",
			`找不到前端构建产物：\n${uiDistDir}\n\n请先在 packages/ui 下执行 npm run build`,
		);
		app.exit(1);
	}
	const child = spawn(process.execPath, [coreEntry], {
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			// electron 自身的 NODE_OPTIONS 可能含纯 Electron 才认的开关，别带进子进程
			NODE_OPTIONS: "",
			CORE_RUN_DIR: runDir,
			CORE_UI_DIST: uiDistDir,
			CORE_PORT: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const tail = (chunk: Buffer) => {
		stderrTail = (stderrTail + chunk.toString()).slice(-4000);
	};
	child.stdout?.on("data", tail);
	child.stderr?.on("data", tail);
	child.on("exit", (code) => {
		if (core === child) core = null;
		if (quitting) return;
		// 服务进程意外死亡：点名原因，不留一个白窗口
		failLoudly("后台服务已退出", `core 进程退出（code=${code ?? "?"}）：\n\n${stderrTail.slice(-800)}`);
		app.quit();
	});
	return child;
}

interface CoreInfo {
	port: number;
	token: string;
}

function readCoreInfo(): CoreInfo | null {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(runDir, "core.json"), "utf8")) as CoreInfo;
		if (typeof raw.port === "number" && typeof raw.token === "string") return raw;
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
	core = bootCore();
	const info = await waitForCore();
	if (!info) {
		quitting = true;
		killCore();
		console.error(`[desktop] SMOKE_FAIL 未读到 core.json（${READINESS_TIMEOUT_MS}ms）\n${stderrTail}`);
		app.exit(1);
		return;
	}
	const ok = await healthOk(info.port, info.token);
	const child = core;
	quitting = true;
	killCore();
	const exited = child ? await waitForExit(child) : false;
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
	mainWindow = new BrowserWindow({
		width: 1360,
		height: 860,
		title: "Pi-Desktop",
		autoHideMenuBar: true,
		backgroundColor: "#111114",
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	mainWindow.loadURL(url);
	mainWindow.on("closed", () => {
		mainWindow = null;
	});
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
		if (SMOKE) {
			void runSmoke();
			return;
		}
		core = bootCore();
		void waitForCore().then((info) => {
			if (!info) {
				failLoudly(
					"启动失败",
					`后台服务未在 ${READINESS_TIMEOUT_MS / 1000}s 内就绪：\n\n${stderrTail.slice(-1200)}`,
				);
				app.exit(1);
				return;
			}
			createWindow(`http://127.0.0.1:${info.port}/?live=1`);
		});
	});

	app.on("window-all-closed", () => {
		app.quit();
	});
	app.on("before-quit", () => {
		quitting = true;
		killCore();
	});
}
