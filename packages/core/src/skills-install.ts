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
 * - 私库/断网 = clone 失败原样报错；临时目录 finally 必清。
 * - 阶段进度经 onProgress 回调发 SSE `skill_progress`（session.ts 接线）。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** 可预期安装失败：status 即 HTTP 状态码（400 非法入参 / 404 仓库无此技能 / 409 目录冲突） */
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

/** git clone --depth 1（stderr 尾部进错误文案，ENETNOTFOUND/401 才有得排查） */
function gitClone(repoUrl: string, destDir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", ["clone", "--depth", "1", "--single-branch", repoUrl, destDir], {
			windowsHide: true,
		});
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`克隆超时（${CLONE_TIMEOUT_MS / 60000} 分钟）：${repoUrl}`));
		}, CLONE_TIMEOUT_MS);
		child.on("error", (e) => {
			clearTimeout(timer);
			const code = (e as NodeJS.ErrnoException).code;
			reject(
				code === "ENOENT"
					? new Error("未找到 git 命令——请先安装 Git（插件包安装同样依赖它）")
					: new Error(`git 启动失败：${e.message}`),
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
			const tail = stderr.trim().split("\n").slice(-3).join("\n");
			reject(new Error(`git clone 失败（exit ${code}）：${tail || repoUrl}`));
		});
	});
}

/** SKILL.md frontmatter 的 name（损坏/缺失回落空串，由调用方兜底目录名） */
function readFrontmatterName(skillMdPath: string): string {
	try {
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(skillMdPath, "utf8"));
		return typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	} catch {
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
		} catch {
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

/** 多个匹配时取「路径最浅 → 字母序」第一个（确定性，避免随机装错） */
function pickBest(candidates: string[]): string {
	return candidates.sort((a, b) => {
		const depthA = a.split(/[\\/]/).length;
		const depthB = b.split(/[\\/]/).length;
		return depthA !== depthB ? depthA - depthB : a.localeCompare(b);
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
 * `onProgress` 发阶段文案；任何失败都会清理克隆临时目录（已拷贝的目标不回滚——
 * 半个技能目录无害且 reload 只认完整 SKILL.md，残目录不会出现在清单里）。
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

	const repoUrl = `https://github.com/${source}.git`;
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-skill-install-"));
	try {
		args.onProgress?.(`正在克隆 ${source}…`);
		await gitClone(repoUrl, path.join(tempDir, "repo"));

		args.onProgress?.("正在定位技能…");
		const skillFiles = findSkillFiles(path.join(tempDir, "repo"));
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
		const skillName = readFrontmatterName(chosenFile) || path.basename(skillDir);

		const targetDir = path.join(targetSkillsDir, sanitizeDirName(skillId));
		if (fs.existsSync(targetDir)) {
			throw new SkillInstallError(409, `已存在同名技能目录：${targetDir}（如需重装请先手动删除旧目录）`);
		}

		args.onProgress?.(`正在安装到 ${targetDir}…`);
		await fs.promises.mkdir(targetSkillsDir, { recursive: true });
		await fs.promises.cp(skillDir, targetDir, { recursive: true });
		args.onProgress?.("安装完成");

		return { installedPath: targetDir, skillName };
	} finally {
		await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
}
