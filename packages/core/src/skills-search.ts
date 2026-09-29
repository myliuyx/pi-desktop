/**
 * S1 · 设置弹窗「添加技能」的搜索代理（server.ts 的 GET /skills/search）。
 *
 * skills.sh 的搜索 API 公开可用（2026-09-29 实测 `GET /api/search?q=react`
 * → 200 JSON，无需鉴权），但浏览器侧直连有 CORS 限制，所以由 core 代理。
 *
 * 口径：
 * - **字段白名单映射**（source/skillId/name/installs）——不透传上游原始大 JSON，
 *   上游改版时爆炸面收在这一处；详情接口 401 不可用，故没有 description 可带。
 * - 纯只读：不落盘、不缓存、不重试（失败原文透出，UI 不美化）。
 * - 错误带目标 host（与 providers.ts 的 test()/listModels() 同口径），
 *   否则 "fetch failed" 不知道连的是谁。
 */

import type { SkillSearchPayload } from "./contract.ts";

const SKILLS_SH_HOST = "skills.sh";
const SEARCH_TIMEOUT_MS = 10_000;

/** skills.sh 搜索响应中我们关心的字段形状（多余字段一律丢弃） */
interface SkillsShSearchResponse {
	skills?: Array<{ source?: unknown; skillId?: unknown; name?: unknown; installs?: unknown }>;
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "");
const asNumber = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * 代理搜索 skills.sh 技能注册表。上游失败/超时/形状不符抛错（端点回 502 原文）。
 */
export async function searchSkillsSh(query: string): Promise<SkillSearchPayload> {
	const endpoint = `https://${SKILLS_SH_HOST}/api/search?q=${encodeURIComponent(query)}`;
	let res: Response;
	try {
		res = await fetch(endpoint, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		});
	} catch (e) {
		throw new Error(`${SKILLS_SH_HOST}：${e instanceof Error ? e.message : String(e)}`);
	}
	if (!res.ok) {
		throw new Error(`${SKILLS_SH_HOST} 返回 HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
	}
	let parsed: SkillsShSearchResponse;
	try {
		parsed = (await res.json()) as SkillsShSearchResponse;
	} catch (e) {
		throw new Error(`${SKILLS_SH_HOST} 返回的不是有效 JSON：${e instanceof Error ? e.message : String(e)}`);
	}
	const rows = Array.isArray(parsed.skills) ? parsed.skills : [];
	return {
		results: rows
			.map((row) => ({
				source: asString(row.source),
				skillId: asString(row.skillId),
				name: asString(row.name),
				installs: asNumber(row.installs),
			}))
			// source/skillId 缺失的条目无法安装也不可辨识，直接滤掉（不造展示假数据）
			.filter((r) => r.source.length > 0 && r.skillId.length > 0),
	};
}
