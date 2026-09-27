import { useEffect, useState } from "react";
import { Plus, RefreshCw, DownloadCloud } from "lucide-react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/common/icons";
import { Button, Dialog } from "@/components/primitives";
import { Switch } from "@/components/screens/Switch";
import {
	SETTINGS_DIALOG_LEFT_WIDTH,
	SETTINGS_DIALOG_SPLIT_GAP,
} from "@/lib/layout";
import { isLiveEnabled } from "@/lib/feature-flags";
import { getLiveTransport } from "@/services/live-transport";
import { notifyFailure, useNoticeStore } from "@/store/notice-store";
import type { PackageDetail, PackagesPayload, PackageUpdateEntry } from "@/mock/types";
import { MOCK_PACKAGES_PAYLOAD } from "@/mock/plugins";

/**
 * 设置弹窗 · 「插件」Tab（C8 · task-settings-skills-plugins.md 批次 B）。
 *
 * 布局对齐参考图2（主控 2026-09-28 截图）：左栏分组包树（全局 / 项目，条目圆点 =
 * 启用实心 / 禁用空心），右栏详情（scope 徽标 + source 标题 + 重新加载会话 / 移除 /
 * 启用开关；字段表 描述/状态/版本/包/资源/安装路径/CWD；「已解析资源」按
 * 扩展/技能/提示词/主题 分节列 名称+路径），底部统计条（四类启用计数 + 检查更新 / 刷新），
 * 左栏钉底「添加插件」。
 *
 * 数据形态：**自取自渲染**（同 SkillsSettingsTab 范式）—— mock 以
 * `MOCK_PACKAGES_PAYLOAD` 起步、开关/移除本地变更；live 挂载时 `GET /packages`
 * 拉全量（含未安装的 missing 项），变更走 `POST /packages/*` 并用**返回的最新清单**
 * 整体替换。安装（B2）走弹窗 + SSE `package_progress` 进度；检查更新走
 * `POST /packages/check-updates`（npm/git 需联网，本地包自动跳过）。
 *
 * 诚实展示纪律：version/description 缺失不造值（显示「未填」/「未提供描述」）；
 * 「检查」按钮按 2026-09-28 裁决不做（与详情内已解析资源重叠）。
 */

/** 侧栏条目展示名：git:/npm: 原样；本地路径 → `local/<目录名>`（参考图2 口径） */
function displaySource(source: string): string {
	if (/^(git|npm):/.test(source)) return source;
	const trimmed = source.replace(/[\\/]+$/, "");
	const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
	return `local/${base}`;
}

/** mock 专用：按当前包启用态重算四类计数（对齐 live 端 resolve() 的「启用」口径） */
function mockTotals(packages: PackageDetail[]): PackagesPayload["totals"] {
	const totals = { extensions: 0, skills: 0, prompts: 0, themes: 0 };
	for (const pkg of packages) {
		if (!pkg.enabled) continue;
		for (const kind of ["extensions", "skills", "prompts", "themes"] as const) {
			totals[kind] += pkg.resources[kind].filter((r) => r.enabled).length;
		}
	}
	return totals;
}

const STATUS_LABEL: Record<PackageDetail["status"], string> = {
	loaded: "Loaded",
	installed: "Installed",
	missing: "未安装",
};

export function PluginsSettingsTab() {
	/** mock 形态直接以演示清单起步；live 打开后被 core 的全量清单覆盖 */
	const [payload, setPayload] = useState<PackagesPayload | null>(() =>
		isLiveEnabled() ? null : MOCK_PACKAGES_PAYLOAD,
	);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [selectedSource, setSelectedSource] = useState<string | null>(null);
	/** 进行中变更的 source（开关/移除/安装期间禁用对应控件，防连点） */
	const [pendingSource, setPendingSource] = useState<string | null>(null);
	/** 移除的两步确认（选中项变化即复位） */
	const [confirmRemove, setConfirmRemove] = useState(false);
	/** B2 检查更新结果（有可更新项时详情头部出「更新」按钮） */
	const [updates, setUpdates] = useState<PackageUpdateEntry[]>([]);
	/** B2 安装弹窗（open / 输入源 / 进行中 / 错误 / SSE 进度文案） */
	const [installOpen, setInstallOpen] = useState(false);
	const [installSource, setInstallSource] = useState("");
	const [installing, setInstalling] = useState(false);
	const [installError, setInstallError] = useState<string | null>(null);
	const [progressText, setProgressText] = useState<string | null>(null);

	const refresh = () => {
		if (!isLiveEnabled()) return;
		const transport = getLiveTransport();
		if (!transport) return;
		let alive = true;
		transport
			.listPackages()
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
	};

	/** live 首拉（mock 不发请求） */
	useEffect(() => refresh(), []);

	/** B2：订阅 SSE 包进度（安装/更新进行中文案；mock 无 transport 不订阅） */
	useEffect(() => {
		const transport = getLiveTransport();
		if (!transport) return;
		return transport.subscribe((event) => {
			if (event.type === "package_progress") {
				setProgressText(event.message ?? `${event.action} ${event.source}…`);
			}
		});
	}, []);

	const packages = payload?.packages ?? [];

	/** 选中项兜底：清单到达 / 整体替换后保持在范围内，否则落第一项 */
	useEffect(() => {
		if (packages.length === 0) return;
		if (selectedSource && packages.some((p) => p.source === selectedSource)) return;
		setSelectedSource(packages[0].source);
	}, [packages, selectedSource]);

	const selected = packages.find((p) => p.source === selectedSource) ?? null;

	/** 选中项变化 → 复位两步确认（换包后不应残留上一包的「确认移除」态） */
	useEffect(() => {
		setConfirmRemove(false);
	}, [selectedSource]);

	const groups: Array<{ scope: PackageDetail["scope"]; label: string; items: PackageDetail[] }> = [
		{ scope: "user", label: "全局", items: packages.filter((p) => p.scope === "user") },
		{ scope: "project", label: "项目", items: packages.filter((p) => p.scope === "project") },
	];

	const handleToggle = (pkg: PackageDetail) => {
		const next = !pkg.enabled;
		const transport = isLiveEnabled() ? getLiveTransport() : null;
		if (!transport) {
			// mock：本地翻转（演示开关交互，不落盘、不通知 core）
			setPayload((prev) => {
				if (!prev) return prev;
				const packages = prev.packages.map((p) =>
					p.source === pkg.source && p.scope === pkg.scope ? { ...p, enabled: next } : p,
				);
				return { ...prev, packages, totals: mockTotals(packages) };
			});
			return;
		}
		if (pendingSource) return;
		setPendingSource(pkg.source);
		transport
			.togglePackage({ source: pkg.source, scope: pkg.scope, enabled: next })
			.then((res) => setPayload(res.packages))
			.catch((e) => notifyFailure("切换插件失败", e))
			.finally(() => setPendingSource(null));
	};

	const handleRemove = (pkg: PackageDetail) => {
		if (!confirmRemove) {
			setConfirmRemove(true);
			return;
		}
		const transport = isLiveEnabled() ? getLiveTransport() : null;
		setConfirmRemove(false);
		if (!transport) {
			// mock：本地移除（不落盘）
			setPayload((prev) => {
				if (!prev) return prev;
				const packages = prev.packages.filter(
					(p) => !(p.source === pkg.source && p.scope === pkg.scope),
				);
				return { ...prev, packages, totals: mockTotals(packages) };
			});
			return;
		}
		if (pendingSource) return;
		setPendingSource(pkg.source);
		transport
			.removePackage({ source: pkg.source, scope: pkg.scope })
			.then((res) => {
				setPayload(res.packages);
				useNoticeStore
					.getState()
					.notify({ tone: "success", text: `已移除插件：${displaySource(pkg.source)}` });
			})
			.catch((e) => notifyFailure("移除插件失败", e))
			.finally(() => setPendingSource(null));
	};

	const handleReloadSession = () => {
		const transport = isLiveEnabled() ? getLiveTransport() : null;
		if (!transport) {
			useNoticeStore.getState().notify({ tone: "info", text: "mock 形态无 core 可重新加载" });
			return;
		}
		transport
			.reloadSession()
			.then(() => {
				useNoticeStore.getState().notify({ tone: "success", text: "会话已重新加载（设置与资源已重读）" });
				refresh();
			})
			.catch((e) => notifyFailure("重新加载会话失败", e));
	};

	const handleCheckUpdates = () => {
		const transport = isLiveEnabled() ? getLiveTransport() : null;
		if (!transport) {
			useNoticeStore.getState().notify({ tone: "info", text: "mock 形态无 core 可检查更新" });
			return;
		}
		transport
			.checkPackageUpdates()
			.then((res) => {
				setUpdates(res.updates);
				useNoticeStore
					.getState()
					.notify(
						res.updates.length > 0
							? { tone: "info", text: `有 ${res.updates.length} 个插件可更新，详情页可逐个更新` }
							: { tone: "success", text: "全部插件已是最新" },
					);
			})
			.catch((e) => notifyFailure("检查更新失败", e));
	};

	const handleUpdate = (pkg: PackageDetail) => {
		const transport = isLiveEnabled() ? getLiveTransport() : null;
		if (!transport || pendingSource) return;
		setPendingSource(pkg.source);
		transport
			.updatePackage({ source: pkg.source })
			.then((res) => {
				setPayload(res.packages);
				setUpdates((prev) => prev.filter((u) => u.source !== pkg.source));
				useNoticeStore.getState().notify({ tone: "success", text: `已更新：${displaySource(pkg.source)}` });
			})
			.catch((e) => notifyFailure("更新插件失败", e))
			.finally(() => setPendingSource(null));
	};

	const confirmInstall = () => {
		const source = installSource.trim();
		if (source.length === 0) {
			setInstallError("请填写插件来源（npm:包名 / git:host/path / 本地路径）");
			return;
		}
		const transport = isLiveEnabled() ? getLiveTransport() : null;
		if (!transport) {
			useNoticeStore
				.getState()
				.notify({ tone: "info", text: "mock 形态无 core，安装仅在 live（?live=1）可用" });
			setInstallOpen(false);
			return;
		}
		setInstalling(true);
		setInstallError(null);
		transport
			.installPackage({ source })
			.then((res) => {
				setPayload(res.packages);
				setInstallOpen(false);
				setInstallSource("");
				useNoticeStore.getState().notify({ tone: "success", text: `插件已安装：${displaySource(source)}` });
			})
			.catch((e) => setInstallError(e instanceof Error ? e.message : String(e)))
			.finally(() => setInstalling(false));
	};

	const totals = payload?.totals;
	const summaryText = totals
		? `${totals.extensions} ext · ${totals.skills} skills · ${totals.prompts} prompts · ${totals.themes} themes`
		: "—";

	return (
		<div className="flex h-full min-h-0 min-w-0 flex-col">
			<div className="flex min-h-0 min-w-0 flex-1" style={{ gap: SETTINGS_DIALOG_SPLIT_GAP }}>
				{/* 左栏：分组包树（列表区自身滚动，「添加插件」钉在栏底不随滚动） */}
				<div
					className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-surface"
					style={{ width: SETTINGS_DIALOG_LEFT_WIDTH }}
					data-testid="settings-plugins-tree"
				>
					<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
						{loadError ? (
							<p className="px-3 py-2 text-xs text-danger" data-testid="settings-packages-error">
								插件清单读取失败：{loadError}
							</p>
						) : null}
						{groups.map((group) =>
							group.items.length === 0 ? null : (
								<section key={group.scope}>
									<p className="px-3 pb-1 pt-3 text-xs font-medium text-text-tertiary">{group.label}</p>
									<ul>
										{group.items.map((pkg) => {
											const isActive =
												pkg.source === selectedSource && pkg.scope === selected?.scope;
											return (
												<li key={`${pkg.scope}::${pkg.source}`}>
													<button
														type="button"
														onClick={() => setSelectedSource(pkg.source)}
														data-testid="settings-plugin-item"
														data-source={pkg.source}
														data-scope={pkg.scope}
														data-enabled={pkg.enabled}
														title={pkg.source}
														className={cn(
															"flex min-w-0 w-full items-center gap-2 px-3 py-1.5 text-left",
															isActive ? "bg-bg-active" : "hover:bg-bg-hover",
														)}
													>
														<span
															aria-hidden="true"
															className={cn(
																"h-1.5 w-1.5 shrink-0 rounded-full",
																pkg.enabled
																	? "bg-accent"
																	: "border border-border-strong bg-transparent",
															)}
														/>
														<span className="min-w-0 flex-1 truncate font-mono text-xs text-text-primary">
															{displaySource(pkg.source)}
														</span>
													</button>
												</li>
											);
										})}
									</ul>
								</section>
							),
						)}
						{payload && packages.length === 0 ? (
							<div
								className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center"
								data-testid="settings-packages-empty"
							>
								<p className="text-sm text-text-secondary">未安装任何插件</p>
								<p className="text-xs text-text-tertiary">
									可用「添加插件」安装 npm: / git: / 本地路径包，或用 pi install
								</p>
							</div>
						) : null}
					</div>
					{/* 钉底：添加插件（B2） */}
					<div className="shrink-0 border-t border-border-subtle p-2">
						<button
							type="button"
							onClick={() => {
								setInstallError(null);
								setInstallOpen(true);
							}}
							data-testid="settings-plugin-add"
							className="flex w-full min-w-0 items-center justify-center gap-1.5 rounded-md border border-dashed border-border-default px-3 py-2 text-sm text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
						>
							<Icon icon={Plus} size={15} />
							添加插件
						</button>
					</div>
				</div>

				{/* 右栏：包详情 */}
				<div
					className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
					data-testid="settings-plugin-detail"
				>
					{selected ? (
						<div className="flex h-full min-w-0 flex-col gap-4">
							{/* 头部：scope 徽标 + source + 重新加载会话 / 更新 / 移除 / 开关 */}
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
									className="min-w-0 flex-1 truncate font-mono text-sm text-text-primary"
									title={selected.source}
								>
									{selected.source}
								</span>
								<Button
									variant="ghost"
									size="sm"
									onClick={handleReloadSession}
									data-testid="settings-plugin-reload"
								>
									重新加载会话
								</Button>
								{updates.some((u) => u.source === selected.source) ? (
									<Button
										variant="ghost"
										size="sm"
										disabled={pendingSource === selected.source}
										onClick={() => handleUpdate(selected)}
										data-testid="settings-plugin-update"
									>
										更新
									</Button>
								) : null}
								<Button
									variant="ghost"
									size="sm"
									className={cn(confirmRemove && "text-danger hover:text-danger")}
									disabled={pendingSource === selected.source}
									onClick={() => handleRemove(selected)}
									data-testid="settings-plugin-remove"
								>
									{confirmRemove ? "确认移除" : "移除"}
								</Button>
								<Switch
									checked={selected.enabled}
									label={`启用插件 ${displaySource(selected.source)}`}
									disabled={pendingSource === selected.source}
									onToggle={() => handleToggle(selected)}
									data-testid="settings-plugin-toggle"
									data-source={selected.source}
								/>
							</div>

							{/* 字段表（参考图2：描述/状态/版本/包/资源/安装路径/CWD） */}
							<dl className="flex min-w-0 flex-col gap-2">
								{(
									[
										["描述", selected.description ?? "（未提供描述）", false],
										["状态", STATUS_LABEL[selected.status], false],
										[
											"版本",
											selected.status === "missing"
												? "未安装"
												: selected.version
													? `已安装 ${selected.version}`
													: "（未填）",
											false,
										],
										["包", selected.name ?? selected.source, true],
										["资源", selected.resourceSummary, false],
										["安装路径", selected.installedPath ?? "—", true],
										["CWD", selected.scope === "project" ? (payload?.cwd ?? "—") : "全局", true],
									] as Array<[string, string, boolean]>
								).map(([label, value, mono]) => (
									<div key={label} className="flex min-w-0 items-baseline gap-3">
										<dt className="w-16 shrink-0 text-xs text-text-tertiary">{label}</dt>
										<dd
											className={cn(
												"min-w-0 flex-1 break-all text-sm text-text-secondary",
												mono && "font-mono text-xs",
											)}
											data-testid={`settings-plugin-field-${label}`}
										>
											{value}
										</dd>
									</div>
								))}
							</dl>

							{/* 已解析资源（扩展/技能/提示词/主题 分节；参考图2 的「已解析资源」区块） */}
							{(["extensions", "skills", "prompts", "themes"] as const).map((kind) => {
								const entries = selected.resources[kind];
								if (entries.length === 0) return null;
								const sectionLabel =
									kind === "extensions"
										? "扩展"
										: kind === "skills"
											? "技能"
											: kind === "prompts"
												? "提示词"
												: "主题";
								return (
									<div key={kind} className="flex min-w-0 flex-col gap-1.5 border-t border-border-subtle pt-3">
										<p className="text-xs font-medium text-text-secondary">{sectionLabel}</p>
										<ul className="flex min-w-0 flex-col gap-2">
											{entries.map((entry) => (
												<li key={entry.path} className="min-w-0" data-testid="settings-plugin-resource">
													<p className="truncate text-sm text-text-primary" title={entry.path}>
														{entry.name}
													</p>
													<p className="truncate font-mono text-xs text-text-tertiary" title={entry.path}>
														{entry.path}
													</p>
												</li>
											))}
										</ul>
									</div>
								);
							})}
						</div>
					) : (
						<div className="flex h-full min-w-0 items-center justify-center text-sm text-text-tertiary">
							{packages.length === 0 ? "暂无可展示的插件" : "从左侧选择一个插件"}
						</div>
					)}
				</div>
			</div>

			{/* 底部统计条（参考图2：「2 ext · 14 skills · 0 prompts · 0 themes」+ 检查更新 / 刷新） */}
			<div
				className="flex min-h-0 shrink-0 items-center justify-between gap-3 border-t border-border-subtle pt-2"
				data-testid="settings-packages-footer"
			>
				<p className="min-w-0 truncate font-mono text-xs text-text-tertiary">{summaryText}</p>
				<div className="flex shrink-0 items-center gap-2">
					<Button variant="ghost" size="sm" onClick={handleCheckUpdates} data-testid="settings-packages-check-updates">
						<Icon icon={DownloadCloud} size={14} />
						检查更新
					</Button>
					<Button variant="ghost" size="sm" onClick={refresh} data-testid="settings-packages-refresh">
						<Icon icon={RefreshCw} size={14} />
						刷新
					</Button>
				</div>
			</div>

			{/* B2 · 添加插件弹窗（npm:/git:/本地路径；安装进度取 SSE package_progress 原文） */}
			{/* 注意：Dialog 原语不透传 data-testid（P7 实证被静默丢弃）—— 弹窗态用「输入框所在的 role=dialog」判定 */}
			<Dialog
				open={installOpen}
				onClose={() => {
					if (!installing) setInstallOpen(false);
				}}
				label="添加插件"
				width={480}
			>
				<div className="flex min-w-0 flex-col gap-3">
					<p className="text-sm text-text-secondary">
						填写插件来源并安装到用户级（<code className="font-mono text-xs">npm:包名</code> /{" "}
						<code className="font-mono text-xs">git:host/path</code> / 本地路径；npm/git 需联网）。
					</p>
					<input
						type="text"
						value={installSource}
						onChange={(e) => setInstallSource(e.target.value)}
						placeholder="git:github.com/obra/superpowers"
						disabled={installing}
						data-testid="settings-package-install-source"
						className="min-w-0 rounded-md border border-border-default bg-bg-surface px-3 py-2 font-mono text-sm text-text-primary outline-none transition-colors duration-150 focus:border-accent"
					/>
					{installing && progressText ? (
						<p className="text-xs text-text-tertiary" data-testid="settings-package-install-progress">
							{progressText}
						</p>
					) : null}
					{installError ? (
						<p className="text-xs text-danger" data-testid="settings-package-install-error">
							{installError}
						</p>
					) : null}
					<div className="flex shrink-0 items-center justify-end gap-2">
						<Button
							variant="ghost"
							size="sm"
							disabled={installing}
							onClick={() => setInstallOpen(false)}
							data-testid="settings-package-install-cancel"
						>
							取消
						</Button>
						<Button
							variant="primary"
							size="sm"
							disabled={installing || installSource.trim().length === 0}
							onClick={confirmInstall}
							data-testid="settings-package-install-confirm"
						>
							{installing ? "安装中…" : "安装"}
						</Button>
					</div>
				</div>
			</Dialog>
		</div>
	);
}
