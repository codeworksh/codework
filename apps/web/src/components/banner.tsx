import { CircleAlert, Clock, Download, TriangleAlert, type IconComponent, X } from "@/components/vuesax";
import { useLast } from "@/hooks/last";

/**
 * Something the reader should know before writing more: a short title, and a line only when it adds
 * a fact. `expired` is a state the session is in, not a fault, so it reads neutral rather than red.
 */
export interface Notice {
	readonly title: string;
	readonly description?: string;
	readonly tone: "error" | "warning" | "info" | "expired";
	readonly actions?: ReadonlyArray<NoticeAction>;
}

export interface NoticeAction {
	readonly label: string;
	readonly icon?: IconComponent;
	readonly disabled?: boolean;
	readonly onClick: () => void;
}

const tones: Record<Notice["tone"], { readonly icon: IconComponent; readonly text: string; readonly surface: string }> =
	{
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
		info: {
			icon: Download,
			text: "text-ink-muted",
			surface: "border-edge bg-frame",
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
	actions = [],
	onDismiss,
	detached = false,
}: Notice & {
	readonly onDismiss?: () => void;
	/** A card of its own rather than tucked behind the composer's top edge. */
	readonly detached?: boolean;
}) {
	const { icon: Icon, text, surface } = tones[tone];
	return (
		<div
			role="alert"
			className={`flex items-center gap-2.5 border ${detached ? "rounded-xl" : "mx-3 rounded-t-xl border-b-0 transition-[transform,opacity] duration-180 ease-out starting:translate-y-1 starting:opacity-0"} ${surface} px-3 py-2 text-xs leading-snug`}
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
			{actions.map((action) => (
				<button
					key={action.label}
					type="button"
					disabled={action.disabled}
					onClick={action.onClick}
					className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-edge px-2 py-0.5 font-medium text-ink-muted transition-[transform,background-color,color] duration-150 ease-out outline-none hover:bg-ink/5 hover:text-ink focus-visible:bg-ink/5 enabled:active:scale-[0.97] disabled:pointer-events-none disabled:opacity-60"
				>
					{action.icon !== undefined && <action.icon className="size-3" strokeWidth={2} aria-hidden />}
					{action.label}
				</button>
			))}
			{onDismiss !== undefined && (
				<button
					type="button"
					aria-label="Dismiss"
					onClick={onDismiss}
					className="-mr-1 grid size-5 shrink-0 place-items-center rounded-md text-ink-muted transition-[transform,background-color,color] duration-150 ease-out hover:bg-ink/10 hover:text-ink active:scale-95"
				>
					<X className="size-3" strokeWidth={2} aria-hidden />
				</button>
			)}
		</div>
	);
}

/**
 * A notice detached below the composer and out of its flow, so it comes and goes without moving
 * anything. It eases in, and fades out quicker on the last notice it showed.
 */
export function NoticeSlot({ notice }: { readonly notice: Notice | undefined }) {
	const shown = useLast(notice);
	if (shown === undefined) return null;
	return (
		<div
			data-shown={notice !== undefined}
			inert={notice === undefined}
			className="absolute inset-x-0 top-full z-10 pt-2 transition-[opacity,translate] duration-200 ease-out data-[shown=false]:-translate-y-1 data-[shown=false]:opacity-0 data-[shown=false]:duration-150 data-[shown=false]:ease-out motion-reduce:transition-none"
		>
			<ComposerNotice {...shown} detached />
		</div>
	);
}
