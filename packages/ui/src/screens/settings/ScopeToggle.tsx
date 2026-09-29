import { cn } from "@/lib/cn";

/**
 * 设置弹窗「添加技能 / 添加插件」共用的 scope 分段切换（参考图1/图2 的
 * `global | project` 分段控件；本仓库无现成分段原语，按 M4 不引新依赖的铁律自绘）。
 *
 * 语义对齐契约：user =「global」（装 ~/.pi/agent 侧）/ project =「project」（装
 * <cwd>/.pi 侧）——按钮文案用 global（参考图口径），值域保持 scope 原词。
 *
 * 状态可见性：active 段 `data-scope-value` + 视觉高亮（bg-accent-soft）双输出，
 * 探针读 data 属性、不依赖样式。
 */
export function ScopeToggle({
	value,
	onChange,
	label,
	testId,
	disabled,
}: {
	value: "user" | "project";
	onChange: (next: "user" | "project") => void;
	/** 无障碍标签（分段组本身无可见文本语义） */
	label: string;
	testId: string;
	disabled?: boolean;
}) {
	const options: Array<{ value: "user" | "project"; text: string }> = [
		{ value: "user", text: "global" },
		{ value: "project", text: "project" },
	];
	return (
		<div
			role="radiogroup"
			aria-label={label}
			data-testid={testId}
			data-scope={value}
			className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border-default bg-bg-surface p-0.5"
		>
			{options.map((opt) => {
				const active = opt.value === value;
				return (
					<button
						key={opt.value}
						type="button"
						role="radio"
						aria-checked={active}
						disabled={disabled}
						data-scope-value={opt.value}
						onClick={() => {
							if (!active) onChange(opt.value);
						}}
						className={cn(
							"rounded px-3 py-1 text-xs transition-colors duration-150",
							"disabled:cursor-not-allowed disabled:opacity-40",
							active ? "bg-accent-soft text-accent" : "text-text-secondary hover:text-text-primary",
						)}
					>
						{opt.text}
					</button>
				);
			})}
		</div>
	);
}
