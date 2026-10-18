import { CircleAlert, Clock, type LucideIcon, TriangleAlert, X } from "lucide-react";

/**
 * Something the reader should know before writing more: a short title, and a line only when it adds
 * a fact. `expired` is a state the session is in, not a fault, so it reads neutral rather than red;
 * `warning` is a state outside the session (its server is down) that one action may fix.
 */
export interface Notice {
	readonly title: string;
	readonly description?: string;
	readonly tone: "error" | "warning" | "expired";
	readonly action?: NoticeAction;
}

export interface NoticeAction {
	readonly label: string;
	readonly icon?: LucideIcon;
	readonly disabled?: boolean;
	readonly onClick: () => void;
}

const tones: Record<Notice["tone"], { readonly icon: LucideIcon; readonly text: string; readonly surface: string }> = {
	// A faint tint and border of the tone's color over the composer's tray surface.
	error: {
		icon: CircleAlert,
		text: "text-destructive",
		surface: "border-destructive/30 bg-[color-mix(in_oklab,var(--color-destructive)_8%,var(--color-frame))]",
	},
	warning: {
		icon: TriangleAlert,
		text: "text-warning",
		surface: "border-warning/30 bg-[color-mix(in_oklab,var(--color-warning)_8%,var(--color-frame))]",
	},
	expired: {
		icon: Clock,
		text: "text-warning",
		surface: "border-warning/30 bg-[color-mix(in_oklab,var(--color-warning)_8%,var(--color-frame))]",
	},
};

/**
 * A notice tucked behind the composer's top edge, as its tray is tucked under the bottom one: subtle
 * and attached to what it is about. Dismissible when `onDismiss` is given; a notice about a state
 * clears itself instead. The description is clamped to two lines, whole on hover.
 */
export function ComposerNotice({
	title,
	description,
	tone,
	action,
	onDismiss,
}: Notice & {
	readonly onDismiss?: () => void;
}) {
	const { icon: Icon, text, surface } = tones[tone];
	return (
		<div
			role="alert"
			className={`mx-5.5 -mb-4 flex items-center gap-2.5 rounded-t-[16px] border border-b-0 ${surface} px-3 pt-2.5 pb-6 text-[12px] leading-snug`}
		>
			<Icon className={`size-4 shrink-0 ${text}`} strokeWidth={2} aria-hidden />
			<div className="min-w-0 flex-1">
				<p className="font-medium text-ink">{title}</p>
				{description !== undefined && (
					<p title={description} className="mt-0.5 line-clamp-2 text-ink-muted">
						{description}
					</p>
				)}
			</div>
			{action !== undefined && (
				<button
					type="button"
					disabled={action.disabled}
					onClick={action.onClick}
					className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-edge px-2 py-0.5 font-medium text-ink-muted transition-colors outline-none hover:bg-ink/5 hover:text-ink focus-visible:bg-ink/5 disabled:pointer-events-none disabled:opacity-60"
				>
					{action.icon !== undefined && <action.icon className="size-3" strokeWidth={2} aria-hidden />}
					{action.label}
				</button>
			)}
			{onDismiss !== undefined && (
				<button
					type="button"
					aria-label="Dismiss"
					onClick={onDismiss}
					className="-mr-1 grid size-5 shrink-0 place-items-center rounded-md text-ink-muted transition-colors hover:bg-ink/10 hover:text-ink"
				>
					<X className="size-3" strokeWidth={2} aria-hidden />
				</button>
			)}
		</div>
	);
}
