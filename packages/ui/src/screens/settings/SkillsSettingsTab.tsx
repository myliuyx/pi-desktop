import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/common/icons";
import { Switch } from "@/components/screens/Switch";
import {
	SETTINGS_DIALOG_LEFT_WIDTH,
	SETTINGS_DIALOG_SPLIT_GAP,
} from "@/lib/layout";
import { isLiveEnabled } from "@/lib/feature-flags";
import { getLiveTransport } from "@/services/live-transport";
import { notifyFailure, useNoticeStore } from "@/store/notice-store";
import type { SkillListItem, SkillsPayload } from "@/mock/types";
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

	const addSkill = () => {
		// 2026-09-28 主控裁决：本批只保留入口，具体交互后续再定
		useNoticeStore
			.getState()
			.notify({ tone: "info", text: "「添加技能」的交互形态待定，本批仅保留入口" });
	};

	return (
		<div className="flex h-full min-h-0 min-w-0" style={{ gap: SETTINGS_DIALOG_SPLIT_GAP }}>
			{/* 左栏：分组技能树（列表区自身滚动，「添加技能」钉在栏底不随滚动） */}
			<div
				className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-surface"
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
										const isActive = item.path === selectedPath;
										return (
											<li key={item.path}>
												<button
													type="button"
													onClick={() => setSelectedPath(item.path)}
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
				{/* 钉底：添加技能（2026-09-28 用户裁决：本批仅保留入口） */}
				<div className="shrink-0 border-t border-border-subtle p-2">
					<button
						type="button"
						onClick={addSkill}
						data-testid="settings-skill-add"
						className="flex w-full min-w-0 items-center justify-center gap-1.5 rounded-md border border-dashed border-border-default px-3 py-2 text-sm text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
					>
						<Icon icon={Plus} size={15} />
						添加技能
					</button>
				</div>
			</div>

			{/* 右栏：技能详情（scope 徽标 + 路径 + 开关 / Name / Description） */}
			<div
				className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
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
		</div>
	);
}
