/**
 * S2 · 设置弹窗「添加技能」的安装写路径（server.ts 的 POST /skills/install）。
 *
 * 与官方 skills CLI（vercel-labs/skills）同款通道：git `--depth 1` 克隆 GitHub
 * 仓库 → 全树发现 SKILL.md → 按 **frontmatter `name`** 匹配定位（skills.sh 的
 * skillId 就是 frontmatter name，**≠ 仓库目录名**——2026-09-29 实证
 * vercel-labs/agent-skills：skillId `vercel-composition-patterns` 对应仓库目录
 * `skills/composition-patterns`）→ 技能目录整体拷到目标 skills 目录。
 *
 * 口径：
 * - 目标目录：user = `<agentDir>/skills/<dir>/`；project = `<cwd>/.pi/skills/<dir>/`
 *   （与 0.87.1 addAutoDiscoveredResources 的发现路径一致，装完 reload 即被加载）。
 * - 冲突不覆盖：目标目录已存在抛 409（v1 无更新/卸载入口，装错手动删目录）。
 * - 写路径加固：技能目录含符号链接抛 422（cp 默认 dereference:false 会原样搬运链接，
 *   装个技能会被升级为「读本机任意文件」）；SKILL.md 位于仓库根抛 400（cp 会连 .git 一起搬）。
 * - 私库/断网 = clone 失败；git stderr 细节只进 core 本地日志，HTTP 侧只回分类后的
 *   稳定文案（不逐字回显仓库 URL 认证原文，I3）。临时目录 finally 必清。
 * - 阶段进度经 onProgress 回调发 SSE `skill_progress`（session.ts 接线）。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** 可预期安装失败：status 即 HTTP 状态码（400 非法入参或仓库组织不合规 / 404 仓库无此技能或克隆不到 / 409 目录冲突**或项目未信任** / 422 技能目录不可安全拷贝 / 500 真实 IO 或环境故障，不伪装成 404 / 504 克隆超时）。`session.ts` 的 installSkill 也在装前抛本类（未信任项目），故 409 不只表示「目录已存在」。 */
export class SkillInstallError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

/** source 严格 `owner/repo`（其余形态——npm 包/任意 URL/本地路径——本批一律拒绝） */
const SOURCE_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** 落盘目录名消毒：frontmatter name 里可能带空格/全角/斜杠等（目录名只留 \w . -） */
function sanitizeDirName(skillId: string): string {
	const cleaned = skillId.replace(/[^\w.-]/g, "-").replace(/^[-.]+|[-.]+$/g, "");
	return cleaned.length > 0 ? cleaned : "skill";
}

const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

/** 单个技能目录的文件数上限（防「宽而浅」的巨型仓库把 walk/cp 拖死主事件循环，I2） */
export const MAX_SKILL_FILES = 5_000;

/** 入参长度上限（防超长 skillId 变成超长目录名、macOS APFS 单段 255 字节上限处报 500） */
export const MAX_SKILL_ID_LENGTH = 128;

/** 搜索入参 q 的长度上限（防超长 q 撑出超长上游 URL；skills.sh 真实查询都是几个词） */
export const MAX_QUERY_LENGTH = 200;

/** git clone --depth 1（失败细节只进本地日志，HTTP 侧只回稳定分类文案，I3） */
function gitClone(repoUrl: string, destDir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", ["clone", "--depth", "1", "--single-branch", repoUrl, destDir], {
			windowsHide: true,
		});
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			// 超时文案不含本机临时路径：URL 是用户自己填的 source 拼出来的，非内部信息
			reject(new SkillInstallError(504, `克隆超时（${CLONE_TIMEOUT_MS / 60000} 分钟）：${repoUrl}`));
		}, CLONE_TIMEOUT_MS);
		child.on("error", (e) => {
			clearTimeout(timer);
			const code = (e as NodeJS.ErrnoException).code;
			// 同上：不外送 (e as Error).message（spawn 错误文本可能带本机可执行文件路径）
			reject(
				code === "ENOENT"
					? new SkillInstallError(500, "未找到 git 命令——请先安装 Git（插件包安装同样依赖它）")
					: new SkillInstallError(500, `git 启动失败（${code ?? "未知错误"}）`),
			);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
			if (stderr.length > 4000) stderr = stderr.slice(-4000);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve();
				return;
			}
			// 细节（仓库 URL / 认证失败原文 / 远端主机名）**只进本地日志**，不回传浏览器（I3）：
			// git stderr 原文含 `fatal: could not read Username for 'https://…'`、认证失败细节、
			// 远端主机名，完整逐字回显给前端是超出必要的暴露面（经 server.ts 的 { error }
			// → transport 原文抛 → UI 直出）。与同文件 500 只带 errno code 同精神。
			console.error(`[skills-install] git clone 失败（exit ${code}）：${repoUrl}\n${stderr.trim()}`);
			// 128 = git 通用失败码（仓库不存在 / 无权访问 / 需认证 / 远端不可达）⇒ 归 404，
			// 对前端语义是「这个技能源取不到」，用户可换一个源；其余退出码（本地 git 配置错、
			// 磁盘满、clone 被中间件杀等）归 500。
			//
			// 注意：此处**必须用 reject 而非 throw** —— throw 发生在 child.on("close", …) 回调里
			//（不是 Promise executor 同步体），会变成该监听器的未捕获异常，既不让外层 Promise
			// settle，又会把 installSkillFromGitHub 的调用方挂成永不返回的 pending await。
			if (code === 128) {
				reject(
					new SkillInstallError(
						404,
						`无法克隆仓库：${repoUrl}（仓库不存在、无权访问，或需要认证）`,
					),
				);
				return;
			}
			reject(new SkillInstallError(500, `git clone 失败（退出码 ${code}）`));
		});
	});
}

/**
 * SKILL.md frontmatter 的 name（frontmatter 损坏/缺失回落空串，由调用方兜底目录名）。
 *
 * **为什么要分两类错误**（I6）：`parseFrontmatter` 解析失败回落目录名是合理降级；
 * 但 `readFileSync` 的 EACCES / EIO / EISDIR 若被同一个 catch 吞成「无 frontmatter」，
 * 最终会表现为 404「技能不在仓库中」—— 把真实 IO 故障伪装成业务失败，排查时
 * 完全看不出是权限问题还是文件损坏。IO 错误必须向上抛。
 */
function readFrontmatterName(skillMdPath: string): string {
	let raw: string;
	try {
		raw = fs.readFileSync(skillMdPath, "utf8");
	} catch (e) {
		// 只放行「文件确实不存在」，其余 IO 错误向上抛
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
		// 不外送 (e as Error).message —— 它含 /tmp/pi-skill-install-*/repo 内部路径，
		// 会经 server.ts 的 { error } → transport 原文抛 → UI 直出给用户（与
		// assertSkillDirSafe 同口径）。errno code 对用户已足够，排障者能看 core 日志。
		const code = (e as NodeJS.ErrnoException).code ?? "未知错误";
		throw new SkillInstallError(500, `读取 SKILL.md 失败（${code}）`);
	}
	try {
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(raw);
		return typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	} catch {
		// YAML 损坏 → 回落目录名（合理降级）。parseFrontmatter 内部直接调 yaml 的
		// parse()（node_modules/@earendil-works/pi-coding-agent/dist/utils/frontmatter.js:23），
		// 语法错误会抛出来，故这里必须兜住。
		return "";
	}
}

/** 递归收集仓库里所有 SKILL.md（跳过 .git / node_modules——克隆产物与依赖内技能不算） */
function findSkillFiles(rootDir: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, depth: number) => {
		if (depth > 12) return; // 防符号链接/异常深度的兜底
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			// 权限 / IO 故障让整棵子树消失 → 后续误报 404「技能不在仓库」，
			// 掩盖真实原因（I6）。ENOENT 才是可预期的「目录没了」。
			// 同上：不外送 (e as Error).message（内部临时路径），只带 errno code。
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
				const code = (e as NodeJS.ErrnoException).code ?? "未知错误";
				throw new SkillInstallError(500, `扫描仓库目录失败（${code}）`);
			}
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() && !entry.isFile()) continue; // 跳过符号链接等
			if (entry.isDirectory()) {
				if (entry.name === ".git" || entry.name === "node_modules") continue;
				walk(path.join(dir, entry.name), depth + 1);
			} else if (entry.name === "SKILL.md") {
				out.push(path.join(dir, entry.name));
			}
		}
	};
	walk(rootDir, 0);
	return out;
}

/**
 * 技能目录内的拷贝前安全闸门（export：供 `check:skills-install` 直接 import 断言）。
 *
 * **为什么**：`findSkillFiles` 跳过符号链接只作用于「发现哪些 SKILL.md」，
 * 对「技能目录里有哪些其他文件」零约束；而 `fs.promises.cp` 默认
 * `dereference:false`，会**原样搬运链接本身**。实测（2026-09-29）仓库里
 * `passwd -> /etc/passwd` 会被搬进 `~/.pi/agent/skills/<dir>/`，而 SKILL.md
 * 是**模型调用的指令**、模型有 read 工具 → 装个技能被升级为「读取任意本机文件
 * 并经对话外送」。链接落盘不增磁盘占用，故这层防护无法靠「事后清理」兜底。
 *
 * 口径：**命中即拒绝安装**（422），不静默跳过 —— 静默跳过会让用户
 * 以为装好了，实际缺文件，排查成本更高。
 */
export function assertSkillDirSafe(rootDir: string, skillId: string): void {
	let count = 0;
	/** lstat 判定（不用 stat：stat 会跟随链接，恰好是我们要避开的） */
	const walk = (dir: string, depth: number): void => {
		if (depth > 12) {
			// 超限 = 未校验 = 不可放行（与 I6 同口径：读不到就不能担保安全）。
			// 绝不能沿用 findSkillFiles 的 `return` —— 那是「发现」上限，
			// 超限只导致找不到技能；而这里是「安全」闸门，超限等于放行符号链接。
			throw new SkillInstallError(
				422,
				`技能「${skillId}」的目录层级过深（上限 12 层），无法完整校验，已拒绝安装。`,
			);
		}
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			// IO 错误不伪装成「目录为空」（I6）：读不出来就没法担保安全。
			// 不外送 (e as Error).message —— 它含 /tmp/pi-skill-install-*/repo 内部路径，
			// 会经 server.ts 的 { error } → transport 原文抛 → UI 直出给用户。
			// 对照同文件 409 口径：路径只出现用户自己的 skills 目录，不出现内部临时目录。
			const code = (e as NodeJS.ErrnoException).code ?? "未知错误";
			throw new SkillInstallError(500, `读取技能目录失败（${code}）`);
		}
		for (const entry of entries) {
			try {
				// 边扫边计数：宽而浅的巨型仓库在 cp 之前就被拦下（I2）
				if (++count > MAX_SKILL_FILES) {
					throw new SkillInstallError(
						422,
						`技能「${skillId}」的文件数超过上限 ${MAX_SKILL_FILES}，已拒绝安装。`,
					);
				}
				const full = path.join(dir, entry.name);
				if (entry.isSymbolicLink()) {
					throw new SkillInstallError(
						422,
						`技能「${skillId}」的目录内含符号链接（${entry.name}），已拒绝安装：` +
							`技能内容会被模型当指令读取，符号链接可指向本机任意文件。`,
					);
				}
				if (entry.isDirectory()) {
					walk(full, depth + 1);
				}
			} catch (e) {
				// 422 语义由本函数自己抛出，必须透传；只有非本函数的 IO 故障才兜成 500，
				// 否则会把「含符号链接」的 422 降级成 500，前端语义就错了。
				if (e instanceof SkillInstallError) throw e;
				const code = (e as NodeJS.ErrnoException).code ?? "未知错误";
				throw new SkillInstallError(500, `扫描技能目录失败（${code}）`);
			}
		}
	};
	walk(rootDir, 0);
}

/**
 * 多候选时的确定性选取。
 *
 * - **深度优先取更深**（I5）：`SKILL.md` 位于仓库根时最「浅」，而「最浅优先」会
 *   优先选中顶层那个与请求无关的技能（同 frontmatter name 撞车时尤其明显）。
 *   更深的路径才是 skills 规范期望的形态（`skills/<技能名>/SKILL.md`）。
 * - **码点比较**（I4）：原实现用 `localeCompare`，结果依赖 ICU locale
 *   （full-icu / small-icu、LANG 环境变量），同一仓库在不同机器上可能选出
 *   不同技能，与「确定性」的注释承诺矛盾。码点序跨平台一致。
 */
function pickBest(candidates: string[]): string {
	// 复制后再 sort：Array.prototype.sort 原地改序，直接排入参会连带改掉调用方
	// 拿到的 skillFiles（当前调用点虽无副作用，但这里是纯函数语义，别留雷）。
	return [...candidates].sort((a, b) => {
		const depthA = a.split(/[\\/]/).length;
		const depthB = b.split(/[\\/]/).length;
		return depthA !== depthB ? depthB - depthA : a < b ? -1 : a > b ? 1 : 0;
	})[0];
}

export interface SkillInstallOutcome {
	/** 落盘后的技能目录绝对路径 */
	installedPath: string;
	/** SKILL.md frontmatter 的 name（清单展示口径，与 /skills 的 name 同源） */
	skillName: string;
}

/**
 * 从 GitHub 仓库安装单个技能到目标 skills 目录。全程同步落盘动作之间经
 * `onProgress` 发阶段文案；任何失败都会清理克隆临时目录与 `.installing-*` 半成品
 * （落盘走「同目录下 `.` 开头的 staging + rename」，失败时目标目录保持不存在——
 * 半个技能目录无害且 reload 只认完整 SKILL.md，但残留会让重试永久 409，
 * 还会造成「报错说失败、reload 后技能却生效」的错位，I1）。
 * 注意：SIGKILL/OOM/断电下 catch 不执行，staging 仍会残留——它以 `.` 开头，
 * Pi 的技能发现（dist/core/skills.js:161-164）只跳过 `.` 开头条目，故残留
 * 不会被当成幽灵技能。
 */
export async function installSkillFromGitHub(args: {
	source: string;
	skillId: string;
	/** user = `<agentDir>/skills/`；project = `<cwd>/.pi/skills/` */
	targetSkillsDir: string;
	onProgress?: (message: string) => void;
}): Promise<SkillInstallOutcome> {
	const { source, skillId, targetSkillsDir } = args;
	if (!SOURCE_PATTERN.test(source)) {
		throw new SkillInstallError(400, `不支持的技术来源：「${source}」（本批仅支持 GitHub 仓库 owner/repo 形态）`);
	}
	if (skillId.trim().length === 0) {
		throw new SkillInstallError(400, "请求体缺少 skillId");
	}
	// 上限取**原始入参**长度而非 trim 后的：sanitizeDirName 把非法字符逐个换成 "-"
	// 且不截断，非法字符不会让目录名变短，超长 skillId 仍会撑爆目录名
	//（macOS APFS 单段名 255 字节上限处报 ENAMETOOLONG → 对用户是 500 而非 400）。
	if (skillId.length > MAX_SKILL_ID_LENGTH) {
		throw new SkillInstallError(400, `skillId 过长（上限 ${MAX_SKILL_ID_LENGTH} 字符）`);
	}

	const repoUrl = `https://github.com/${source}.git`;
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-skill-install-"));
	try {
		const cloneDir = path.join(tempDir, "repo");
		args.onProgress?.(`正在克隆 ${source}…`);
		await gitClone(repoUrl, cloneDir);

		args.onProgress?.("正在定位技能…");
		const skillFiles = findSkillFiles(cloneDir);
		// 匹配优先级：frontmatter name === skillId（skills.sh 口径）→ 目录 basename === skillId（直装仓库的常见形态）
		const byFrontmatter = skillFiles.filter((f) => readFrontmatterName(f) === skillId);
		const chosenFile =
			byFrontmatter.length > 0
				? pickBest(byFrontmatter)
				: pickBest(skillFiles.filter((f) => path.basename(path.dirname(f)) === skillId));
		if (!chosenFile) {
			throw new SkillInstallError(404, `技能「${skillId}」不在仓库 ${source} 中（未找到 SKILL.md 或 name 不匹配）`);
		}
		const skillDir = path.dirname(chosenFile);
		// C3：`SKILL.md` 位于**仓库根**时 skillDir === 克隆根，cp 会把 .git
		// （含全部历史/objects/config/refs）、README、CI 配置一并搬进用户
		// skills 目录（实测落地产物 ['.git','.github','README.md','SKILL.md']）。
		// 口径：报错拒绝，不默默排除 .git 后照装（用户 2026-09-29 裁决）。
		// 判据用 realpathSync 双侧 canonical 比较，而非 path.resolve 字符串等值：
		// 后者在大小写不敏感的平台（Windows）上会把同一目录判成不同（实测 /TMP vs /tmp
		// → false），导致根目录 SKILL.md 逃过 400、.git 全量落进用户 skills 目录。
		// realpathSync 会跟随符号链接，但这里两侧同源同法解析，恰好无害。
		const isRepoRoot = fs.realpathSync(skillDir) === fs.realpathSync(cloneDir);
		if (isRepoRoot) {
			throw new SkillInstallError(
				400,
				`仓库 ${source} 的技能未按 skills 规范组织：SKILL.md 位于仓库根目录。` +
					`该仓库仅在 SKILL.md 位于子目录时可安装；` +
					`请改用把技能放在子目录的仓库（如 skills/<技能名>/SKILL.md）。`,
			);
		}
		const skillName = readFrontmatterName(chosenFile) || path.basename(skillDir);

		const targetDir = path.join(targetSkillsDir, sanitizeDirName(skillId));
		if (fs.existsSync(targetDir)) {
			throw new SkillInstallError(409, `已存在同名技能目录：${targetDir}（如需重装请先手动删除旧目录）`);
		}

		// 闸门在 cp **之前**跑（422）；命中的技能目录一个字节都不落盘
		assertSkillDirSafe(skillDir, skillId);

		// 落盘走「staging + rename」（I1）。**旧行为**是 cp 直接写 targetDir：
		// cp 中途失败（ENOSPC/EIO/进程被杀）会留下含完整 SKILL.md 的残目录，
		// 造成「报错说失败、reload 后技能却生效」的错位，且残留目录让重试永久 409。
		await fs.promises.mkdir(targetSkillsDir, { recursive: true });
		// staging 名以 `.` 开头且落在 targetSkillsDir 内：① Pi 的 loadSkillsFromDir
		// 只跳过 `.` 开头的条目（skills.js:161-164），故崩溃/SIGKILL 留下的 staging
		// 不会被发现成幽灵技能；② 同目录 ⇒ rename 不跨卷，无 EXDEV。
		// 注意不能沿用 `<targetDir>.installing-*` 形态——那不以 `.` 开头。
		const stagingDir = path.join(
			targetSkillsDir,
			`.installing-${process.pid}-${Date.now()}-${sanitizeDirName(skillId)}`,
		);
		args.onProgress?.(`正在安装到 ${targetDir}…`);
		try {
			await fs.promises.cp(skillDir, stagingDir, { recursive: true });
			await fs.promises.rename(stagingDir, targetDir);
		} catch (e) {
			// 半拷贝残留一律清掉，不给「报错说失败、目录却生效」的错位留机会。
			// 代价（可接受）：rename 自身失败（ENOTEMPTY/EEXIST，即目标目录在
			// 409 检查之后被别人建出来）时，这份已拷完整的 staging 也被删掉，
			// 用户重试一次即可换回技能，不丢用户已有数据。
			await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
			throw e;
		}
		args.onProgress?.("安装完成");

		return { installedPath: targetDir, skillName };
	} finally {
		await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
}
