import { MinusIcon, PlusIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { quietField, SavingInput } from "./blocks";

export type StatusTone = "success" | "warning" | "danger" | "info" | "muted";

const DOTS: Record<StatusTone, string> = {
	success: "bg-success",
	warning: "bg-warning",
	danger: "bg-destructive",
	info: "bg-info",
	muted: "bg-ink-muted/50",
};

/** A compact status dot paired with a text label. */
export function StatusDot({ tone, children }: { readonly tone: StatusTone; readonly children: ReactNode }) {
	return (
		<span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
			<span className={`size-1.5 shrink-0 rounded-full ${DOTS[tone]}`} aria-hidden />
			<span className="truncate">{children}</span>
		</span>
	);
}

/** A compact segmented control for choosing one of a few options. */
export function Segmented<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	readonly label: string;
	readonly value: T;
	readonly options: ReadonlyArray<{ readonly value: T; readonly label: ReactNode }>;
	readonly onChange: (value: T) => void;
}) {
	return (
		<div
			role="radiogroup"
			aria-label={label}
			className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-edge/60 bg-ink/3 p-0.5 text-xs"
		>
			{options.map((option) => {
				const active = option.value === value;
				return (
					<button
						key={option.value}
						type="button"
						role="radio"
						aria-checked={active}
						onClick={() => onChange(option.value)}
						className={`rounded-md px-2.5 py-1 font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring ${
							active ? "bg-muted text-ink shadow-2xs" : "text-ink-muted hover:text-ink"
						}`}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}

/** A numeric stepper with an inline editable input and optional unit suffix. */
export function Stepper({
	label,
	value,
	min = 0,
	max = 999_999,
	step = 1,
	unit,
	onChange,
}: {
	readonly label: string;
	readonly value: number;
	readonly min?: number;
	readonly max?: number;
	readonly step?: number;
	readonly unit?: string;
	readonly onChange: (next: number) => void;
}) {
	const clamp = (n: number) => Math.min(max, Math.max(min, n));
	return (
		<div className="flex shrink-0 items-center gap-2">
			<div className="flex items-center">
				<Button
					size="icon-xs"
					variant="ghost"
					aria-label={`Decrease ${label}`}
					disabled={value <= min}
					onClick={() => onChange(clamp(value - step))}
				>
					<MinusIcon />
				</Button>
				<SavingInput
					value={String(value)}
					label={label}
					className={`${quietField} h-7 w-16 text-center font-mono text-xs`}
					onCommit={(typed) => {
						const parsed = Number(typed);
						if (Number.isFinite(parsed)) onChange(clamp(Math.round(parsed)));
					}}
				/>
				<Button
					size="icon-xs"
					variant="ghost"
					aria-label={`Increase ${label}`}
					disabled={value >= max}
					onClick={() => onChange(clamp(value + step))}
				>
					<PlusIcon />
				</Button>
			</div>
			{unit !== undefined && <span className="text-xs text-ink-muted">{unit}</span>}
		</div>
	);
}

/** A quiet empty-state card inside a settings section. */
export function EmptyState({
	icon,
	title,
	description,
	action,
}: {
	readonly icon?: ReactNode;
	readonly title: string;
	readonly description: string;
	readonly action?: ReactNode;
}) {
	return (
		<div className="flex flex-col items-center gap-2 rounded-lg border border-edge/60 px-5 py-8 text-center">
			{icon !== undefined && <div className="mb-1 text-ink-muted">{icon}</div>}
			<p className="font-medium text-ink">{title}</p>
			<p className="max-w-sm text-xs text-ink-muted">{description}</p>
			{action !== undefined && <div className="mt-2">{action}</div>}
		</div>
	);
}
