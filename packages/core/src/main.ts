/**
 * core 入口 —— 装配会话 + 起 HTTP/SSE 服务。
 *
 * 配置位置（2026-09-24 起**回归 Pi 约定**，不再依赖 pi/_poc 这类 POC 资产）：
 * - agentDir 默认 `~/.pi/agent`（`CORE_AGENT_DIR` 可覆盖；验收脚本用临时夹具）；
 * - models.json 取 `<agentDir>/models.json` —— **唯一位置**，没有覆盖口
 *   （原 `CORE_MODELS_PATH` 已于 2026-09-24 删除，见 session.ts resolveModelsPath）。
 *   **文件缺失会自动创建空清单**，由用户在设置页添加 Provider。
 * - **无可用模型也能启动**（首次运行就是这个状态）：服务与设置页可用，
 *   配好 Provider 后会保存时自动选中第一个模型，随即可以对话（见 session.ts ready 注释）。
 *
 * 安全：随机 token 启动生成，写入 packages/core/run/core.json（run/ 已 gitignore）。
 * 需要 `$VAR` 插值凭据（如 `$ARK_API_KEY`）时，**在启动 core 的 shell 里 export** 即可
 * （`ARK_API_KEY=… npm run smoke`），或把密钥字面量直接写进 models.json。
 * core **不读任何 .env 文件**（原 `--env-file` 用法已于 2026-09-24 删除）。
 *
 * 启动：`npm run smoke`，等价于 `node node_modules/tsx/dist/cli.mjs src/main.ts`
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCoreRuntime } from "./session.ts";
import { startServer } from "./server.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
/*
 * 运行时文件目录（core.json + events.jsonl）。CORE_RUN_DIR 可覆盖 —— 打包桌面端 / 服务器
 * 部署场景下源码旁不可写（Electron 的 asar 只读、系统安装目录），必须显式指到可写位置
 * （如 Electron 的 userData）。坏值不崩：目录建不出来（指向了文件 / 无权限）⇒ 点名警告
 * 后回落默认值，不静默、不崩（与下方 CORE_CWD 同一契约）。
 */
const defaultRunDir = path.join(here, "..", "run");
let runDir = process.env.CORE_RUN_DIR ? path.resolve(process.env.CORE_RUN_DIR) : defaultRunDir;
try {
  fs.mkdirSync(runDir, { recursive: true });
} catch (e) {
  console.warn(
    `[core] 警告: CORE_RUN_DIR="${runDir}" 无法创建（${e instanceof Error ? e.message : String(e)}），回落 "${defaultRunDir}"`,
  );
  runDir = defaultRunDir;
  fs.mkdirSync(runDir, { recursive: true });
}

// 同源托管前端：默认 core 包上一级的 ui/dist；可用 CORE_UI_DIST 覆盖
const uiDist = process.env.CORE_UI_DIST
	? path.resolve(process.env.CORE_UI_DIST)
	: path.resolve(here, "..", "..", "ui", "dist");

const token = process.env.CORE_TOKEN ?? randomUUID();
const port = process.env.CORE_PORT ? Number(process.env.CORE_PORT) : 0;
// 绑定地址与 Host 白名单：默认仅本机；内网访问设 CORE_HOST=0.0.0.0，
// 并用 CORE_ALLOWED_HOSTS 追加允许的主机名（逗号分隔，不含端口），如 192.168.3.37
const host = process.env.CORE_HOST ?? "127.0.0.1";
const extraHosts = (process.env.CORE_ALLOWED_HOSTS ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const allowedHosts = ["127.0.0.1", "localhost", ...extraHosts];

/*
 * CORE_CWD：core 的工作目录（决定项目本地资源与信任门）。解析规则：
 * - env 缺省 ⇒ undefined ⇒ createCoreRuntime 内部回落 process.cwd() ⇒ 行为零变化；
 * - 有值 ⇒ path.resolve(value)；
 * - 指向不存在或不是目录 ⇒ 打一行点名警告（原值 + 回落后的值）并回落 process.cwd()，
 *   不静默、不崩（"静默降级"是本项目最忌讳的失败形态）。
 * 用法：cd packages/core && CORE_CWD=F:/path/to/project npm run smoke
 */
const rawCwd = process.env.CORE_CWD;
let resolvedCwd: string | undefined;
if (rawCwd) {
	if (!rawCwd.trim()) {
		// 有值但全是空白（如 CORE_CWD="   "）：点名警告后回落，不静默吞掉
		console.warn(
			`[core] 警告: CORE_CWD 为空白值，已回落 process.cwd()="${process.cwd()}"`,
		);
	} else {
		const candidate = path.resolve(rawCwd.trim());
		/*
		 * 用一次 statSync 判定“存在且是目录”，并整体 try/catch：
		 * existsSync + statSync 是两次系统调用，路径在两者之间消失（或不稳定挂载）时
		 * statSync 会抛 ⇒ core 启动直接失败，违背“坏值不崩”契约。
		 */
		try {
			if (!fs.statSync(candidate).isDirectory()) throw new Error("not a directory");
			resolvedCwd = candidate;
		} catch {
			resolvedCwd = undefined;
			console.warn(
				`[core] 警告: CORE_CWD="${rawCwd}" 不是存在的目录，已回落 process.cwd()="${process.cwd()}"`,
			);
		}
	}
}

/*
 * C3：**先起服务、再等会话就绪**。
 * 原因：`ask` 态的项目信任门（trust.ts）会在会话创建之前向 UI 提问，
 * 而提问要走 SSE/HTTP —— 若等服务就绪才 listen，提问必然没人应答、启动死锁
 *（提问早于首个 SSE 连接的那一小段窗口，由 server.ts 的未决请求补发兜住）。
 */
const boot = createCoreRuntime({
  agentDir: process.env.CORE_AGENT_DIR,
  cwd: resolvedCwd,
  shellPath: process.env.CORE_SHELL_PATH,
  modelProvider: process.env.CORE_MODEL_PROVIDER,
  modelId: process.env.PI_MODEL,
  // C3：信任门提问等待上限（默认 120s，超时按「不信任」收尾）；测试用小值验证超时语义
  trustTimeoutMs: process.env.CORE_TRUST_TIMEOUT_MS ? Number(process.env.CORE_TRUST_TIMEOUT_MS) : undefined,
});

const handle = await startServer(boot.runtime, { port, token, uiDist, host, allowedHosts });

// 写 run/core.json（含 token，绝不提交）
fs.writeFileSync(path.join(runDir, "core.json"), JSON.stringify({ port: handle.port, token }, null, 2));

// 事件落盘（真实冒烟证据）
const dumpPath = path.join(runDir, "events.jsonl");
fs.writeFileSync(dumpPath, "");
boot.runtime.onEvent((e) => {
  fs.appendFileSync(dumpPath, `${JSON.stringify(e)}\n`);
});

console.log(`[core] 工作目录: ${boot.runtime.getCwd()}`);
console.log(`[core] 监听 http://${host}:${handle.port}  (SSE: /events, 健康: /health)`);
if (host === "0.0.0.0" || host === "::") {
	console.log(`[core] 已对内网开放，允许的 Host: ${allowedHosts.join(", ")}`);
}
console.log(`[core] 同源托管 UI: ${uiDist}${fs.existsSync(uiDist) ? "" : "（不存在，浏览器请用 ?core= 指向本服务）"}`);

try {
  await boot.ready;
} catch (e) {
  console.error("[core] 会话初始化失败:", e instanceof Error ? e.message : String(e));
  await handle.close();
  process.exit(1);
}

async function shutdown() {
  console.log("\n[core] 关闭中…");
  await handle.close();
  boot.runtime.dispose();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
