import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/common/icons";
import { Button } from "@/components/primitives";
import { Switch } from "@/components/screens/Switch";
import { ScopeToggle } from "./ScopeToggle";
import {
	SETTINGS_DIALOG_FORM_PADDING,
	SETTINGS_DIALOG_LEFT_WIDTH,
	SETTINGS_DIALOG_SPLIT_GAP,
} from "@/lib/layout";
import { PANE_SCROLL_CLASS } from "./form-fields";
import { isLiveEnabled } from "@/lib/feature-flags";
import { getLiveTransport } from "@/services/live-transport";
import { notifyFailure, useNoticeStore } from "@/store/notice-store";
import type { SkillListItem, SkillSearchEntry, SkillsPayload } from "@/mock/types";
import { MOCK_SKILLS_PAYLOAD } from "@/mock/skills-settings";

/**
 * 设置弹窗 · 「技能」Tab（C7 · task-settings-skills-plugins.md 批次 A）。
 *
 * 布局对齐参考图1（主控 2026-09-28 截图）：左栏分组技能树（全局 / 项目，
 * 条目前圆点 = 启用实心 accent / 禁用空心），右栏详情（scope 徽标 + SKILL.md
 * 路径 + 启用开关，Name / Description 只读展示），左栏钉底「添加技能」。
 *
 * 数据形态：**自取自渲染**（同 SkillsScreen 范式）—— mock 形态以
 * `MOCK_SKILLS_PAYLOAD` 起步、开关本地翻转；live 形态挂载时 `GET /skills`
 * 拉全量清单（含被 `!路径` 模式禁用的条目 —— 与 04 屏 `GET /resources`
 * 的已加载子集是两回事），开关走 `POST /skills/toggle` 并用**返回的最新清单**
 * 整体替换（免二次拉取）。
 *
 * 开关失败不丢选中态：清单整体替换后按 path 保位（切换响应必含该条目），
 * 错误经 notice 弹出（core 的 `{ error }` 原文，409 流式中 / 404 已被移除）。
 *
 * S4（2026-09-29）·「添加技能」右栏表单视图（参考图1）：钉底按钮 → 右栏原地
 * 切换为添加表单（非弹窗，左树保持可见；点左树条目回详情）。搜索走 core 代理
 * skills.sh（`GET /skills/search`），安装走 `POST /skills/install`（git clone →
 * frontmatter 匹配 → 拷贝，进度经 SSE `skill_progress`）。mock 形态表单照常
 * 渲染，搜索/安装给「仅 live 可用」提示。
 */
export function SkillsSettingsTab() {
	/** mock 形态直接以演示清单起步；live 打开后被 core 的全量清单覆盖 */
	const [payload, setPayload] = useState<SkillsPayload | null>(() =>
		isLiveEnabled() ? null : MOCK_SKILLS_PAYLOAD,
	);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	/** 正在切换中的技能 path（Switch 禁用态；防连点重复请求） */
	const [pendingPath, setPendingPath] = useState<string | null>(null);
	/** 右栏视图：detail=技能详情 / add=添加技能表单（S4） */
	const [mode, setMode] = useState<"detail" | "add">("detail");

	/* ----- S4 · 添加表单状态（进入 add 视图时由 openAdd 复位） ----- */
	const [searchQuery, setSearchQuery] = useState("");
	const [searching, setSearching] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);
	/** null = 尚未搜索（显示 skills.sh 提示行）；[] = 搜了但无结果 */
	const [searchResults, setSearchResults] = useState<SkillSearchEntry[] | null>(null);
	const [addScope, setAddScope] = useState<"user" | "project">("user");
	/** 正在安装的条目 key（`source/skillId`；防连点，其余行禁用安装按钮） */
	const [installingKey, setInstallingKey] = useState<string | null>(null);
	const [installProgress, setInstallProgress] = useState<string | null>(null);
	const [installError, setInstallError] = useState<string | null>(null);

	/** C5 同范式：live 首拉（mock 不发请求）；失败显示错误行但保留 mock 清单可交互 */
	useEffect(() => {
		if (!isLiveEnabled()) return;
		const transport = getLiveTransport();
		if (!transport) return;
		let alive = true;
		transport
			.listSkills()
			.then((p) => {
				if (!alive) return;
				setPayload(p);
				setLoadError(null);
			})
			.catch((e) => {
				if (!alive) return;
				setLoadError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			alive = false;
		};
	}, []);

	const skills = payload?.skills ?? [];

	/** 选中项兜底：清单到达 / 整体替换后保持在范围内，否则落第一项（含禁用项） */
	useEffect(() => {
		if (skills.length === 0) return;
		if (selectedPath && skills.some((s) => s.path === selectedPath)) return;
		setSelectedPath(skills[0].path);
	}, [skills, selectedPath]);

	const selected = skills.find((s) => s.path === selectedPath) ?? null;

	/** 分组渲染顺序固定：全局（user）在前、项目（project）在后（参考图口径） */
	const groups: Array<{ scope: SkillListItem["scope"]; label: string; items: SkillListItem[] }> = [
		{ scope: "user", label: "全局", items: skills.filter((s) => s.scope === "user") },
		{ scope: "project", label: "项目", items: skills.filter((s) => s.scope === "project") },
	];

	const handleToggle = (item: SkillListItem) => {
		const next = !item.enabled;
		const transport = isLiveEnabled() ? getLiveTransport() : null;
		if (!transport) {
			// mock：本地翻转（演示开关交互，不落盘、不通知 core）
			setPayload((prev) =>
				prev
					? {
							...prev,
							skills: prev.skills.map((s) => (s.path === item.path ? { ...s, enabled: next } : s)),
						}
					: prev,
			);
			return;
		}
		if (pendingPath) return;
		setPendingPath(item.path);
		transport
			.toggleSkill({ path: item.path, enabled: next })
			.then((res) => setPayload(res.skills))
			.catch((e) => notifyFailure("切换技能失败", e))
			.finally(() => setPendingPath(null));
	};

	/** S4：订阅 SSE 技能安装进度（阶段文案；mock 无 transport 不订阅） */
	useEffect(() => {
		const transport = getLiveTransport();
		if (!transport) return;
		return transport.subscribe((event) => {
			if (event.type === "skill_progress") {
				setInstallProgress(event.message ?? null);
			}
		});
	}, []);

	const openAdd = () => {
		setSearchQuery("");
		setSearchResults(null);
		setSearchError(null);
		setInstallError(null);
		setInstallProgress(null);
		setAddScope("user");
		setMode("add");
	};

	const runSearch = () => {
		const q = searchQuery.trim();
		if (q.length === 0 || searching) return;
		const transport = isLiveEnabled() ? getLiveTransport() : null;
		if (!transport) {
			useNoticeStore.getState().notify({ tone: "info", text: "技能搜索仅 live（?live=1）形态可用" });
			return;
		}
		setSearching(true);
		setSearchError(null);
		transport
			.searchSkills(q)
			.then((res) => setSearchResults(res.results))
			.catch((e) => {
				setSearchResults(null);
				setSearchError(e instanceof Error ? e.message : String(e));
			})
			.finally(() => setSearching(false));
	};

	const handleInstallSkill = (entry: SkillSearchEntry) => {
		const transport = isLiveEnabled() ? getLiveTransport() : null;
		if (!transport) {
			useNoticeStore.getState().notify({ tone: "info", text: "技能安装仅 live（?live=1）形态可用" });
			return;
		}
		if (installingKey) return;
		setInstallingKey(`${entry.source}/${entry.skillId}`);
		setInstallError(null);
		setInstallProgress(null);
		transport
			.installSkill({ source: entry.source, skillId: entry.skillId, scope: addScope })
			.then((res) => {
				setPayload(res.skills);
				useNoticeStore.getState().notify({ tone: "success", text: `技能已安装：${res.skillName}` });
				// 成功回详情并选中新技能（清单 name = frontmatter name = 返回的 skillName）
				const added = res.skills.skills.find((s) => s.name === res.skillName && s.scope === addScope);
				setSelectedPath(added?.path ?? null);
				setMode("detail");
			})
			.catch((e) => setInstallError(e instanceof Error ? e.message : String(e)))
			.finally(() => {
				setInstallingKey(null);
				setInstallProgress(null);
			});
	};

	return (
		<div className="flex h-full min-h-0 min-w-0" style={{ gap: SETTINGS_DIALOG_SPLIT_GAP }}>
			{/* 左栏：分组技能树（列表区自身滚动，「添加技能」钉在栏底不随滚动） */}
			<div
				className="flex min-h-0 min-w-0 flex-col overflow-hidden border border-border-subtle bg-bg-surface"
				style={{ width: SETTINGS_DIALOG_LEFT_WIDTH }}
				data-testid="settings-skills-tree"
			>
				<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
					{loadError ? (
						<p className="px-3 py-2 text-xs text-danger" data-testid="settings-skills-error">
							技能清单读取失败：{loadError}
						</p>
					) : null}
					{groups.map((group) =>
						group.items.length === 0 ? null : (
							<section key={group.scope}>
								<p className="px-3 pb-1 pt-3 text-xs font-medium text-text-tertiary">{group.label}</p>
								<ul>
									{group.items.map((item) => {
										// 添加视图下不高亮任何条目（参考图1：左树无选中态；详情选中项保留，回详情即恢复）
										const isActive = mode === "detail" && item.path === selectedPath;
										return (
											<li key={item.path}>
												<button
													type="button"
													onClick={() => {
														setSelectedPath(item.path);
														setMode("detail");
													}}
													data-testid="settings-skill-item"
													data-scope={item.scope}
													data-name={item.name}
													data-enabled={item.enabled}
													title={item.path}
													className={cn(
														"flex min-w-0 w-full items-center gap-2 px-3 py-1.5 text-left",
														isActive ? "bg-bg-active" : "hover:bg-bg-hover",
													)}
												>
													<span
														aria-hidden="true"
														className={cn(
															"h-1.5 w-1.5 shrink-0 rounded-full",
															item.enabled
																? "bg-accent"
																: "border border-border-strong bg-transparent",
														)}
													/>
													<span className="min-w-0 flex-1 truncate text-sm text-text-primary">
														{item.name}
													</span>
												</button>
											</li>
										);
									})}
								</ul>
							</section>
						),
					)}
					{payload && skills.length === 0 ? (
						<div
							className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center"
							data-testid="settings-skills-empty"
						>
							<p className="text-sm text-text-secondary">未发现任何技能</p>
							<p className="text-xs text-text-tertiary">
								可把技能目录放入 ~/.pi/agent/skills（全局）或项目 .pi/skills（本项目）
							</p>
						</div>
					) : null}
					{payload?.projectTrustBlocked ? (
						<p className="px-3 py-2 text-xs text-text-tertiary" data-testid="settings-skills-trust-note">
							本目录存在项目本地技能，但尚未信任 —— 本次未加载也未列出
						</p>
					) : null}
				</div>
				{/* 钉底：添加技能（S4 → 右栏添加表单视图） */}
					<div className="shrink-0 border-t border-border-subtle p-2">
						<button
							type="button"
							onClick={openAdd}
						data-testid="settings-skill-add"
						className="flex w-full min-w-0 items-center justify-center gap-1.5 rounded-md border border-dashed border-border-default px-3 py-2 text-sm text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
					>
						<Icon icon={Plus} size={15} />
						添加技能
					</button>
				</div>
			</div>

			{/* 右栏：S4 · mode=add → 「添加技能」表单（参考图1）；mode=detail → 技能详情
			    padding：两视图同源，左栏贴弹窗边缘、右栏靠内边距呼吸 */}
			{mode === "add" ? (
				<div
					className={cn("flex min-h-0 min-w-0 flex-1 flex-col gap-4", PANE_SCROLL_CLASS)}
					style={{ padding: SETTINGS_DIALOG_FORM_PADDING }}
					data-testid="settings-skill-add-view"
				>
					<p className="text-base font-medium text-text-primary">添加技能</p>

					{/* 搜索行（回车 = 点搜索；参考图1 placeholder 口径） */}
					<div className="flex min-w-0 items-center gap-2">
						<input
							type="text"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") runSearch();
							}}
							placeholder="例如 react、testing、deploy"
							disabled={searching}
							data-testid="settings-skill-search-input"
							className="min-w-0 flex-1 rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors duration-150 focus:border-accent"
						/>
						<Button
							variant="primary"
							size="sm"
							disabled={searching || searchQuery.trim().length === 0}
							onClick={runSearch}
							data-testid="settings-skill-search-submit"
						>
							{searching ? "搜索中…" : "搜索"}
						</Button>
					</div>

					{/* scope 行：分段切换 + 目标目录预览（随 scope 变化；口径=0.87.1 发现路径） */}
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<ScopeToggle
							value={addScope}
							onChange={setAddScope}
							label="安装范围"
							testId="settings-skill-scope"
							disabled={installingKey !== null}
						/>
						<span
							className="min-w-0 truncate font-mono text-xs text-text-tertiary"
							data-testid="settings-skill-path-preview"
						>
							→ {addScope === "user" ? "~/.pi/agent/skills/" : ".pi/skills/（项目根）"}
						</span>
					</div>

					{/* 提示行（参考图1 原文口径；Electron 外链经 setWindowOpenHandler 落系统浏览器） */}
					<p className="text-sm text-text-secondary">
						Search{" "}
						<a
							href="https://skills.sh"
							target="_blank"
							rel="noreferrer"
							className="text-accent underline underline-offset-2"
						>
							skills.sh
						</a>{" "}
						to discover and install skills for your agent.
					</p>

					{/* 安装阶段进度 / 搜索与安装错误（行内，不弹窗） */}
					{installProgress ? (
						<p className="text-xs text-text-tertiary" data-testid="settings-skill-install-progress">
							{installProgress}
						</p>
					) : null}
					{searchError ? (
						<p className="text-xs text-danger" data-testid="settings-skill-search-error">
							搜索失败：{searchError}
						</p>
					) : null}
					{installError ? (
						<p className="text-xs text-danger" data-testid="settings-skill-install-error">
							安装失败：{installError}
						</p>
					) : null}

					{/* 搜索结果列表（name + 来源仓库 + 安装量；逐行「添加」） */}
					{searchResults !== null ? (
						searchResults.length === 0 ? (
							<p className="text-sm text-text-tertiary" data-testid="settings-skill-search-empty">
								没有匹配「{searchQuery.trim()}」的技能
							</p>
						) : (
							<ul className="flex min-w-0 flex-col gap-1.5" data-testid="settings-skill-search-results">
								{searchResults.map((entry) => {
									const key = `${entry.source}/${entry.skillId}`;
									const busy = installingKey === key;
									return (
										<li
											key={key}
											data-testid="settings-skill-search-result"
											data-name={entry.skillId}
											data-source={entry.source}
											className="flex min-w-0 items-center gap-3 rounded-md border border-border-subtle px-3 py-2"
										>
											<div className="min-w-0 flex-1">
												<p className="truncate text-sm text-text-primary">{entry.name}</p>
												<p className="truncate font-mono text-xs text-text-tertiary" title={entry.source}>
													{entry.source}
												</p>
											</div>
											<span className="shrink-0 text-xs text-text-tertiary" title="skills.sh 累计安装量">
												{entry.installs.toLocaleString()}
											</span>
											<Button
												variant="ghost"
												size="sm"
												disabled={installingKey !== null}
												onClick={() => handleInstallSkill(entry)}
												data-testid="settings-skill-search-install"
											>
												{busy ? "安装中…" : "添加"}
											</Button>
										</li>
									);
								})}
							</ul>
						)
					) : null}
				</div>
			) : (
				<div
					className={cn("min-h-0 min-w-0 flex-1", PANE_SCROLL_CLASS)}
					style={{ padding: SETTINGS_DIALOG_FORM_PADDING }}
					data-testid="settings-skill-detail"
				>
					{selected ? (
					<div className="flex h-full min-w-0 flex-col gap-4">
						<div className="flex min-w-0 items-center gap-2">
							<span
								className={cn(
									"shrink-0 rounded-full px-2 py-0.5 text-xs",
									selected.scope === "user"
										? "bg-accent-soft text-accent"
										: "border border-border-default text-text-secondary",
								)}
							>
								{selected.scope === "user" ? "global" : "project"}
							</span>
							<span
								className="min-w-0 flex-1 truncate font-mono text-xs text-text-tertiary"
								title={selected.path}
							>
								{selected.path}
							</span>
							<Switch
								checked={selected.enabled}
								label={`启用技能 ${selected.name}`}
								disabled={pendingPath === selected.path}
								onToggle={() => handleToggle(selected)}
								data-testid="settings-skill-toggle"
								data-skill={selected.name}
							/>
						</div>

						<div className="flex min-w-0 flex-col gap-1">
							<p className="text-xs text-text-tertiary">Name</p>
							<p className="min-w-0 font-mono text-sm text-text-primary">{selected.name}</p>
						</div>

						<div className="flex min-w-0 flex-col gap-1">
							<p className="text-xs text-text-tertiary">Description</p>
							<p className="min-w-0 text-sm leading-relaxed text-text-secondary">
								{selected.description || "（该技能未提供描述）"}
							</p>
						</div>

						{selected.origin === "package" && selected.packageSource ? (
							<div className="flex min-w-0 flex-col gap-1">
								<p className="text-xs text-text-tertiary">来源插件</p>
								<p className="min-w-0 font-mono text-xs text-text-secondary">
									{selected.packageSource}
								</p>
							</div>
						) : null}
					</div>
				) : (
					<div className="flex h-full min-w-0 items-center justify-center text-sm text-text-tertiary">
						{skills.length === 0 ? "暂无可展示的技能" : "从左侧选择一个技能"}
					</div>
				)}
				</div>
			)}
		</div>
	);
}
