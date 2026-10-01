import { FilePlus, Pencil } from "lucide-react";
import { Chip } from "@/components/primitives/Chip";
import { cn } from "@/lib/cn";
import type { TurnFileEntry } from "@/lib/turn-files";

export interface TurnFileChipsProps {
	files: TurnFileEntry[];
	/** 点击 chip：打开右侧文件预览（MessageList 层的 openFile 两行模式） */
	onOpenFile: (path: string) => void;
}

/** 工具徽标（D2=B）：edit=「修改」/ write=「写入」；soft 语义令牌同 SPEED_TONE_CLASS 先例 */
const TOOL_BADGE: Record<TurnFileEntry["tool"], { label: string; className: string }> = {
	edit: { label: "修改", className: "bg-info-soft text-info" },
	write: { label: "写入", className: "bg-success-soft text-success" },
};

/**
 * 回复尾部的「本次修改文件」chips 行（task-turn-file-chips.md）。
 *
 * 数据由 lib/turn-files.ts 按轮推导（只收成功 edit/write，见该文件收录口径）；
 * 本组件纯展示：图标 + 文件名 + 工具徽标 + tooltip，点击交 onOpenFile。
 *
 * - 徽标语义（D2=B）：上游 write 的 details 为 undefined，「新建 vs 覆盖」数据上
 *   不可区分 → 徽标只写「写入」，tooltip 注明「新建或覆盖」是诚实口径。
 * - Chip 复用经 className 缩尺寸（h-6/gap-1/px-2/text-xs/rounded-lg）——cn() 对这些
 *   前缀组后者胜出（lib/cn.ts CONFLICT_PREFIXES 已核），**不动 Chip 内部**（工具条
 *   验收面零风险）。
 * - 徽标放 `trailing` 插槽而不是 children：children 会被 Chip 的 truncate 包裹，
 *   trailing 与文本 span 平级参与 flex 对齐、不被裁（Chip.tsx 的 trailing 注释先例）。
 * - testid 契约（探针用，实现后不改）：`turn-file-chips` / `turn-file-chip` +
 *   `data-tool`（edit|write）+ `data-path`（相对展示路径）。
 */
export function TurnFileChips({ files, onOpenFile }: TurnFileChipsProps) {
	return (
		<div data-testid="turn-file-chips" className="flex min-w-0 flex-wrap items-center gap-1.5">
			{files.map((file) => {
				const badge = TOOL_BADGE[file.tool];
				return (
					<Chip
						key={`${file.tool}:${file.path}`}
						variant="outline"
						icon={file.tool === "edit" ? Pencil : FilePlus}
						className="h-6 gap-1 rounded-lg px-2 text-xs"
						data-testid="turn-file-chip"
						data-tool={file.tool}
						data-path={file.display}
						title={`${badge.label}${file.tool === "write" ? "（新建或覆盖）" : ""} · ${file.display}`}
						onClick={() => onOpenFile(file.path)}
						trailing={
							<span
								className={cn(
									"inline-flex shrink-0 items-center rounded px-1 py-px text-[10px] leading-3 font-medium",
									badge.className,
								)}
							>
								{badge.label}
							</span>
						}
					>
						{file.name}
					</Chip>
				);
			})}
		</div>
	);
}
