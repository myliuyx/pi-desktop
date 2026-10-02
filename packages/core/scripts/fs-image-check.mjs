/**
 * /fs/image 图片字节端点检查 —— `check:fs-image`（file-image-preview 批次 P0 验收）。
 *
 * 写作方：**验收方（非实现方）** —— 项目铁律「验收脚本必须由非实现方写」
 * （见 `packages/ui/scripts/probe-image-preview.mjs` 文件头）。
 * 因此本文件**只从冻结契约推导断言**，不 import `src/fs-image.ts`、不读该路由实现：
 *   - 路由 `GET /fs/image?path=<绝对路径>`；Bearer 头或 `?token=`（**严格相等**）；
 *   - 状态码：200 / 400（不存在·不是文件）/ 401（无鉴权）/ 403（无权限）/ 413（>8MB）/ 415（非可预览格式）；
 *   - 200 响应头：Content-Type ∈ 五种白名单、`X-Content-Type-Options: nosniff`、`Cache-Control: no-cache`；
 *   - 200 响应字节**逐字节等于磁盘内容**。
 * 契约外仍额外锁两条「豁免不得外溢」：`?token=` 只对 /fs/image 与 /sessions/image 生效，
 * `/fs/read` 与 `/fs/list` 带正确 token 仍须 401（否则一条豁免就会变成全站放行）。
 *
 * 判据编号见 task-5-brief.md §Step 1（R1-R17）。覆盖：
 *   R1  无 token ⇒ 401            R10 .png 实为文本 ⇒ 415（魔数不信扩展名）
 *   R2  错 token ⇒ 401            R11 RIFF 容器是 WAVE ⇒ 415（防 wav 误判 webp）
 *   R3  Bearer 打真 PNG ⇒ 200 +   R12 >8MB ⇒ 413 且响应时延 < 2s（未整读进内存）
 *       image/png + 逐字节相等     R13 不存在 ⇒ 400「文件不存在」
 *       + nosniff + no-cache      R14 目录 ⇒ 400「不是文件」
 *   R4  ?token= 正确 ⇒ 200        R15 路径含空格/中文/& ⇒ 200 且字节正确
 *   R5  ?token= 错误 ⇒ 401        R16 缺省 path ⇒ 400（空串 resolve 到 cwd ⇒ 是目录）
 *   R6  JPEG/GIF/WEBP/BMP 四种    R17 413 之后 core 仍能 /health 200
 *       ⇒ 各自的 Content-Type
 *   R7  缺省 path 之外的 401 边界（token 大小写/前缀/空串 全 401）
 *   R8  403：无权限（chmod 000，用例跑完即 chmod 复原）
 *   R9  415：svg/txt/ico 等非白名单格式
 *
 * 夹具：五种 1x1 真图字节（PNG/JPEG/GIF/BMP/WEBP）以 base64 **常量手写**，不从磁盘拷
 * （验收方不依赖实现方产物）。这五份字节已在本机 Chromium 实测 `new Image().onload`
 * 触发且 `naturalWidth > 0`（PNG 1×1 / JPEG 1×1 / GIF 1×1 / BMP 1×1 / WEBP VP8L 48×1），
 * 所以「core 侧字节对」与「Task 5 Step 3 探针的浏览器真解码」指向同一批字节。
 *
 * 用法（在 packages/core 下）：`npm run check:fs-image`
 * 环境变量口径：`FS_IMAGE_PORT ?? 5235`、`FS_IMAGE_TOKEN ?? fs-image-token`（避让 5231/5233）。
 * 证据：`run/fs-image-evidence.json`；失败非 0 退出。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, seedModelsJson } from "./lib/credentials.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(here, "..");
const tsxPath = path.join(coreDir, "node_modules", "tsx", "dist", "cli.mjs");
const mainPath = path.join(coreDir, "src", "main.ts");
// CORE_ENTRY：指向编译产物（如 dist/main.js）时以 node 直跑，验「产物可用」而非源码
const mainArgs = process.env.CORE_ENTRY ? [path.resolve(process.env.CORE_ENTRY)] : [tsxPath, mainPath];
const runDir = path.join(coreDir, "run");
const evidencePath = path.join(runDir, "fs-image-evidence.json");
fs.mkdirSync(runDir, { recursive: true });

const PORT = Number(process.env.FS_IMAGE_PORT ?? 5235);
const TOKEN = process.env.FS_IMAGE_TOKEN ?? "fs-image-token";
const HTTP_TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fs-image-"));

/* ---------------------------------------------------------------------------
 * 夹具常量：五种 1x1 真图字节（base64 手写；Chromium 实测可解码，见文件头）
 * ------------------------------------------------------------------------- */
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);
const GIF_1x1 = Buffer.from("R0lGODlhAQABAPAAAAAAAP///ywAAAAAAQABAAACAkQBADs=", "base64");
const BMP_1x1 = Buffer.from("Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wA=", "base64");
const WEBP_1x1 = Buffer.from("UklGRhgAAABXRUJQVlA4TAwAAAAvLwAAAAAAAACIiAg=", "base64");
const JPG_1x1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABwn/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAAYqm//Z",
  "base64",
);

/** RIFF 容器但 form type 是 WAVE：字节 0..3 "RIFF"、8..11 "WAVE" ⇒ 必须 415，不得误判 webp */
function makeRiffWave(payloadLen = 16) {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(4 + payloadLen); // RIFF size = 4（'WAVE'）+ payload
  return Buffer.concat([Buffer.from("RIFF", "latin1"), size, Buffer.from("WAVE", "latin1"), Buffer.alloc(payloadLen, 0)]);
}

/* ---------------------------------------------------------------------------
 * 夹具落盘（core 以 cwd-fixture 为进程 cwd；请求一律走绝对路径）
 * ------------------------------------------------------------------------- */
const coreCwd = path.join(tmpRoot, "cwd-fixture");
fs.mkdirSync(coreCwd, { recursive: true });

/** [相对路径, 字节]：真图 + 非白名单格式 + 撒谎的扩展名 + 特殊字符路径 + 9MB 大文件 */
const fixtures = [
  ["shot.png", PNG_1x1],
  ["photo.jpg", JPG_1x1],
  ["anim.gif", GIF_1x1],
  ["bitmap.bmp", BMP_1x1],
  ["lossless.webp", WEBP_1x1],
  ["notes.md", Buffer.from("# notes\n\nfs-image 夹具\n", "utf8")],
  ["data.bin", Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff])],
  ["icon.ico", Buffer.from("AAABAAEAAQEAAAEAIAAoAAAAFgAAACgAAAABAAAAAg", "base64")],
  ["vector.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>', "utf8")],
  // R10：扩展名是 .png，内容是纯文本 ⇒ 415（魔数不信扩展名）
  ["liar.png", Buffer.from("这根本不是图片，只是一段文本。\n", "utf8")],
  // R11：RIFF 容器但 form type 是 WAVE
  ["sound.wav", makeRiffWave(16)],
  // R15：路径含空格 / 中文 / & / + / # —— encodeURIComponent 双端还原的考验
  ["空 格 中文 & plus+.png", PNG_1x1],
  ["子目录/嵌套 图&片.png", PNG_1x1],
];
for (const [rel, bytes] of fixtures) {
  const abs = path.join(coreCwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}
const f = (rel) => path.join(coreCwd, rel);

/** R8 夹具：chmod 000 的文件（POSIX 才有效；Windows 上 noop） */
const NO_PERM_REL = "locked.png";
const NO_PERM_ABS = f(NO_PERM_REL);
fs.writeFileSync(NO_PERM_ABS, PNG_1x1);
let chmodApplied = false;
if (process.platform !== "win32") {
  fs.chmodSync(NO_PERM_ABS, 0o000);
  chmodApplied = true;
  // root 能绕过读权限（uid 0），此时 403 不可观测 ⇒ 显式跳过而不是假红
  try {
    fs.readFileSync(NO_PERM_ABS);
    fs.chmodSync(NO_PERM_ABS, 0o644);
    chmodApplied = false;
    console.log("  - R8 跳过（当前进程是 root，chmod 000 仍可读 ⇒ 403 不可观测）");
  } catch {
    /* 权限确实生效 */
  }
}

/** R12 夹具：9MB = PNG 头 + 填充（>8MB 上限；故意不做成真图：超限判定发生在魔数之前） */
const OVERSIZE_BYTES = 9 * 1024 * 1024;
const OVERSIZE_REL = "toolarge.png";
const OVERSIZE_ABS = f(OVERSIZE_REL);
const oversize = Buffer.concat([PNG_1x1, Buffer.alloc(OVERSIZE_BYTES - PNG_1x1.length, 0x41)]);

/* R16 用的目录（也是 R14 的被测对象） */
const DIR_REL = "subdir";
fs.mkdirSync(f(DIR_REL), { recursive: true });

const checks = [];
const check = (name, pass, detail) => {
	checks.push({ name, pass: !!pass, detail });
	console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `  ${JSON.stringify(detail ?? "")}`}`);
};

/** 返回 { status, headers, buffer }；binary 端点不能按字符串收（逐字节比较的前提） */
function request(p, { token = TOKEN, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
	return new Promise((resolve, reject) => {
		const headers = {};
		if (token) headers.Authorization = `Bearer ${token}`;
		const req = http.request(
			{ host: "127.0.0.1", port: PORT, path: p, method: "GET", headers, timeout: timeoutMs },
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					const buffer = Buffer.concat(chunks);
					let json = null;
					try {
						json = JSON.parse(buffer.toString("utf8"));
					} catch {
						/* 非 JSON（正常：200 的图片字节） */
					}
					resolve({ status: res.statusCode, headers: res.headers, buffer, json });
				});
			},
		);
		req.on("error", reject);
		req.on("timeout", () => req.destroy(new Error(`timeout(${timeoutMs}ms)`)));
		req.end();
	});
}

const image = (target, opts) => request(`/fs/image?path=${encodeURIComponent(target)}`, opts);
/** 只带 ?token=（不带 Authorization）—— <img> 的真实形态 */
const imageWithQueryToken = (target, token, opts = {}) =>
	request(`/fs/image?path=${encodeURIComponent(target)}&token=${encodeURIComponent(token)}`, { token: "", ...opts });

const headerOf = (r, name) => {
	const v = r.headers[name.toLowerCase()];
	return Array.isArray(v) ? v.join(", ") : v;
};

async function waitForHealth(timeoutMs = 60_000) {
	const t0 = Date.now();
	for (;;) {
		try {
			const r = await request("/health");
			if (r.status === 200) return r.json;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() - t0 > timeoutMs) return null;
		await sleep(300);
	}
}

function bootCore() {
	const agentDir = path.join(tmpRoot, "agentdir");
	fs.mkdirSync(agentDir, { recursive: true });
	seedModelsJson(agentDir);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }, null, 2));
	const logFd = fs.openSync(path.join(runDir, "fs-image.log"), "w");
	return spawn(process.execPath, mainArgs, {
		cwd: coreCwd,
		env: childEnv({ CORE_TOKEN: TOKEN, CORE_PORT: String(PORT), CORE_AGENT_DIR: agentDir }),
		stdio: ["ignore", "ignore", logFd],
	});
}

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */

const evidence = { startedAt: new Date().toISOString(), checks: [], chmodApplied };
const child = bootCore();
try {
	const health = await waitForHealth();
	check("前置 core 正常启动", !!health, health);
	if (!health) throw new Error("core 未能在 60s 内就绪");

	/* ===== R1：无 token ⇒ 401 ===== */
	{
		const r = await image(f("shot.png"), { token: "" });
		check("R1 无 token ⇒ 401（API_ROUTES 鉴权生效）", r.status === 401, { status: r.status });
	}

	/* ===== R2：错 token（Bearer）⇒ 401 ===== */
	{
		const r = await image(f("shot.png"), { token: `${TOKEN}-wrong` });
		check("R2 Bearer 错 token ⇒ 401", r.status === 401, { status: r.status });
	}

	/* ===== R3：Bearer 打真 PNG ⇒ 200 + image/png + 逐字节相等 + nosniff + no-cache ===== */
	{
		const r = await image(f("shot.png"));
		const disk = fs.readFileSync(f("shot.png"));
		check(
			"R3 Bearer 打真 PNG ⇒ 200 + image/png + 字节逐字节等于磁盘 + nosniff + no-cache",
			r.status === 200 &&
				headerOf(r, "content-type") === "image/png" &&
				headerOf(r, "x-content-type-options") === "nosniff" &&
				headerOf(r, "cache-control") === "no-cache" &&
				r.buffer.length === disk.length &&
				r.buffer.equals(disk),
			{
				status: r.status,
				contentType: headerOf(r, "content-type"),
				nosniff: headerOf(r, "x-content-type-options"),
				cacheControl: headerOf(r, "cache-control"),
				respBytes: r.buffer.length,
				diskBytes: disk.length,
			},
		);
	}

	/* ===== R4：?token= 正确 ⇒ 200（<img> 豁免生效），字节同 R3 ===== */
	{
		const r = await imageWithQueryToken(f("shot.png"), TOKEN);
		const disk = fs.readFileSync(f("shot.png"));
		check(
			"R4 ?token= 正确 ⇒ 200（<img> 豁免生效）且字节与 R3 相同",
			r.status === 200 &&
				headerOf(r, "content-type") === "image/png" &&
				r.buffer.length === disk.length &&
				r.buffer.equals(disk),
			{ status: r.status, contentType: headerOf(r, "content-type"), respBytes: r.buffer.length, diskBytes: disk.length },
		);
	}

	/* ===== R5/R7：?token= 严格相等 —— 错值 / 大小写 / 前缀 / 空串 全 401 ===== */
	{
		const wrong = await imageWithQueryToken(f("shot.png"), `${TOKEN}-wrong`);
		const upper = await imageWithQueryToken(f("shot.png"), TOKEN.toUpperCase());
		const prefixed = await imageWithQueryToken(f("shot.png"), `x${TOKEN}`);
		const empty = await imageWithQueryToken(f("shot.png"), "");
		const emptyParam = await request(`/fs/image?path=${encodeURIComponent(f("shot.png"))}&token=`, { token: "" });
		check("R5 ?token= 错误 ⇒ 401（严格相等）", wrong.status === 401, { status: wrong.status });
		check(
			"R7 ?token= 大小写变体 ⇒ 401（不做大小写宽容）",
			upper.status === 401 && prefixed.status === 401,
			{ upper: upper.status, prefixed: prefixed.status },
		);
		check(
			"R7 ?token= 空串（空值 / 缺值）⇒ 401（不做空串通过）",
			empty.status === 401 && emptyParam.status === 401,
			{ emptyValue: empty.status, emptyParam: emptyParam.status },
		);
	}

	/* ===== R6：JPEG/GIF/WEBP/BMP 四种各一条 ⇒ 各自的 Content-Type（魔数定型全表） ===== */
	{
		const table = [
			["photo.jpg", JPG_1x1, "image/jpeg"],
			["anim.gif", GIF_1x1, "image/gif"],
			["lossless.webp", WEBP_1x1, "image/webp"],
			["bitmap.bmp", BMP_1x1, "image/bmp"],
		];
		for (const [rel, bytes, mime] of table) {
			const r = await image(f(rel));
			check(
				`R6 ${rel} ⇒ 200 + ${mime} + 字节逐字节相等`,
				r.status === 200 && headerOf(r, "content-type") === mime && r.buffer.equals(bytes),
				{ status: r.status, contentType: headerOf(r, "content-type"), want: mime, respBytes: r.buffer.length, wantBytes: bytes.length },
			);
		}
	}

	/* ===== R9：非白名单格式 ⇒ 415 ===== */
	{
		for (const rel of ["notes.md", "data.bin", "icon.ico", "vector.svg"]) {
			const r = await image(f(rel));
			check(`R9 ${rel}（非可预览格式）⇒ 415`, r.status === 415, { status: r.status, error: r.json?.error });
		}
	}

	/* ===== R10：.png 实为文本 ⇒ 415（魔数不信扩展名） ===== */
	{
		const r = await image(f("liar.png"));
		check("R10 .png 实为文本 ⇒ 415（魔数不信扩展名）", r.status === 415, { status: r.status, error: r.json?.error });
	}

	/* ===== R11：RIFF 容器是 WAVE ⇒ 415（防 wav 误判 webp） ===== */
	{
		const r = await image(f("sound.wav"));
		check("R11 RIFF 容器是 WAVE ⇒ 415（不得误判 webp）", r.status === 415, { status: r.status, error: r.json?.error });
	}

	/* ===== R12：>8MB ⇒ 413 且未整读进内存（时延 < 2s 佐证） ===== */
	{
		fs.writeFileSync(OVERSIZE_ABS, oversize);
		const t0 = Date.now();
		const r = await image(OVERSIZE_ABS, { timeoutMs: 30_000 });
		const elapsed = Date.now() - t0;
		check(
			"R12 9MB 文件 ⇒ 413 且响应时延 < 2s（未整读进内存的佐证）",
			r.status === 413 && elapsed < 2000 && r.buffer.length < OVERSIZE_BYTES,
			{ status: r.status, elapsedMs: elapsed, respBytes: r.buffer.length, fileBytes: OVERSIZE_BYTES, error: r.json?.error },
		);
		/*
		 * ★ 阳性对照（防空转断言）：413 判据若是「凡是这个目录/这个名字就打 413」或
		 *   脚本请求根本没打对，都同样能变绿。所以用一个**刚好未超限**的同路径同类型文件
		 *   （< 8MB ⇒ 200 且逐字节相等）证明 413 是**尺寸驱动**的，而不是路径/类型/请求形状误伤。
		 */
		const underLimitRel = "toolarge_under.png";
		const underLimitAbs = f(underLimitRel);
		const underBytes = Buffer.concat([PNG_1x1, Buffer.alloc(1 * 1024 * 1024 - PNG_1x1.length, 0x42)]);
		fs.writeFileSync(underLimitAbs, underBytes);
		const ru = await image(underLimitAbs);
		check(
			"R12 阳性对照：1MB 同类文件 ⇒ 200 且逐字节相等（证明 413 是尺寸驱动而非路径误伤）",
			ru.status === 200 && ru.buffer.equals(underBytes) && underBytes.length < OVERSIZE_BYTES,
			{ status: ru.status, respBytes: ru.buffer.length, fileBytes: underBytes.length },
		);
	}

	/* ===== R13：不存在 ⇒ 400「文件不存在」 ===== */
	{
		const r = await image(f("definitely-missing.png"));
		check(
			"R13 不存在的文件 ⇒ 400 且文案含「文件不存在」",
			r.status === 400 && String(r.json?.error ?? "").includes("文件不存在"),
			{ status: r.status, error: r.json?.error },
		);
	}

	/* ===== R14：目录 ⇒ 400「不是文件」 ===== */
	{
		const r = await image(f(DIR_REL));
		check(
			"R14 目录路径 ⇒ 400 且文案含「不是文件」",
			r.status === 400 && String(r.json?.error ?? "").includes("不是文件"),
			{ status: r.status, error: r.json?.error },
		);
	}

	/* ===== R15：路径含空格/中文/&/+/# ⇒ 200 且字节正确 ===== */
	{
		for (const rel of ["空 格 中文 & plus+.png", "子目录/嵌套 图&片.png"]) {
			const r = await image(f(rel));
			check(
				`R15 路径含空格/中文/&（${rel}）⇒ 200 且字节逐字节相等`,
				r.status === 200 && headerOf(r, "content-type") === "image/png" && r.buffer.equals(PNG_1x1),
				{ status: r.status, contentType: headerOf(r, "content-type"), respBytes: r.buffer.length, wantBytes: PNG_1x1.length },
			);
		}
	}

	/* ===== R16：缺省 path ⇒ 400（空串 resolve 到 cwd，是目录；与 /fs/list 的缺省=cwd 相反） ===== */
	{
		const omitted = await request("/fs/image", {});
		const emptyParam = await request("/fs/image?path=", {});
		check(
			"R16 缺省 path / path= 空串 ⇒ 400（空串 resolve 到 cwd ⇒ 是目录）",
			omitted.status === 400 && emptyParam.status === 400,
			{ omitted: omitted.status, emptyParam: emptyParam.status, cwdIsDir: fs.statSync(coreCwd).isDirectory() },
		);
	}

	/* ===== R8：无权限 ⇒ 403 ===== */
	if (chmodApplied) {
		const r = await image(NO_PERM_ABS);
		check("R8 chmod 000 的文件 ⇒ 403", r.status === 403, { status: r.status, error: r.json?.error });
		fs.chmodSync(NO_PERM_ABS, 0o644); // 复原，避免 tmp 清理踩坑
	} else {
		checks.push({ name: "R8 无权限 ⇒ 403", pass: true, detail: "不适用：当前环境无法构造不可读文件（root 或 win32）" });
		console.log("  - R8 跳过（无法构造不可读文件，见 evidence.detail）");
	}

	/* ===== 豁免零外溢：?token= 只对 /fs/image 与 /sessions/image 生效 ===== */
	{
		const read = await request(`/fs/read?path=${encodeURIComponent(f("shot.png"))}&token=${encodeURIComponent(TOKEN)}`, {
			token: "",
		});
		const list = await request(`/fs/list?path=${encodeURIComponent(coreCwd)}&token=${encodeURIComponent(TOKEN)}`, {
			token: "",
		});
		check(
			"豁免零外溢：/fs/read 与 /fs/list 带正确 ?token= 仍 401（豁免只对 /fs/image 与 /sessions/image）",
			read.status === 401 && list.status === 401,
			{ fsRead: read.status, fsList: list.status },
		);
		// 对照组：同样两条路由带 Bearer 头必须 200（证明上面 401 是「豁免没外溢」而非「路由本身坏了」）
		const readOk = await request(`/fs/read?path=${encodeURIComponent(f("notes.md"))}`);
		const listOk = await request(`/fs/list?path=${encodeURIComponent(coreCwd)}`);
		check(
			"豁免零外溢对照组：同两条路由带 Bearer 头 ⇒ 200（401 不是路由损坏造成的）",
			readOk.status === 200 && listOk.status === 200,
			{ fsRead: readOk.status, fsList: listOk.status },
		);
	}

	/* ===== R17：413 之后 core 仍能 /health 200（纵深 try 的回归守卫） ===== */
	{
		const r = await request("/health");
		check("R17 413 之后 core 仍能 /health 200（纵深 try 回归守卫）", r.status === 200 && !!r.json, {
			status: r.status,
			json: r.json,
		});
	}
} catch (e) {
	check("脚本异常终止", false, String(e));
} finally {
	child.kill("SIGTERM");
	await sleep(500);
}

evidence.finishedAt = new Date().toISOString();
evidence.checks = checks;
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

const failed = checks.filter((c) => !c.pass).length;
if (failed > 0) {
	console.error(`\nfs-image 检查失败 ${failed} 项（证据：${evidencePath}）`);
	process.exit(1);
}
console.log(`fs-image 检查全部通过：${checks.length} 项（证据：${evidencePath}）`);