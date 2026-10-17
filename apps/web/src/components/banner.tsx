import { CircleAlert, Clock, X } from "lucide-react";

/**
 * Something the reader should know before writing more: a short title and a one-line description.
 * `expired` is a state the session is in, not a fault, so it reads neutral rather than red.
 */
export interface Notice {
	readonly title: string;
	readonly description: string;
	readonly tone: "error" | "expired";
}

/**
 * A notice tucked behind the composer's top edge, as its tray is tucked under the bottom one: subtle,
 * attached to what it is about, and dismissible. The description is clamped to two lines, whole on hover.
 */
export function ComposerNotice({
	title,
	description,
	tone,
	onDismiss,
}: Notice & {
	readonly onDismiss: () => void;
}) {
	const Icon = tone === "expired" ? Clock : CircleAlert;
	// A faint tint and border of the tone's color over the composer's tray surface.
	const colors =
		tone === "expired"
			? "border-warning/30 bg-[color-mix(in_oklab,var(--color-warning)_8%,var(--color-frame))]"
			: "border-destructive/30 bg-[color-mix(in_oklab,var(--color-destructive)_8%,var(--color-frame))]";
	return (
		<div
			role="alert"
			className={`mx-5.5 -mb-4 flex items-center gap-2.5 rounded-t-[16px] border border-b-0 ${colors} px-3 pt-2.5 pb-6 text-[12px] leading-snug`}
		>
			<Icon
				className={`size-4 shrink-0 ${tone === "expired" ? "text-warning" : "text-destructive"}`}
				strokeWidth={2}
				aria-hidden
			/>
			<div className="min-w-0 flex-1">
				<p className="font-medium text-ink">{title}</p>
				<p title={description} className="mt-0.5 line-clamp-2 text-ink-muted">
					{description}
				</p>
			</div>
			<button
				type="button"
				aria-label="Dismiss"
				onClick={onDismiss}
				className="-mr-1 grid size-5 shrink-0 place-items-center rounded-md text-ink-muted transition-colors hover:bg-ink/10 hover:text-ink"
			>
				<X className="size-3" strokeWidth={2} aria-hidden />
			</button>
		</div>
	);
}
