import { ClockIcon, DownloadSimpleIcon, type Icon, WarningCircleIcon, WarningIcon, XIcon } from "@phosphor-icons/react";
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
	readonly icon?: Icon;
	readonly disabled?: boolean;
	readonly onClick: () => void;
}

const tones: Record<Notice["tone"], { readonly icon: Icon; readonly text: string; readonly surface: string }> = {
	// A faint tint and border of the tone's color over the composer's tray surface.
	error: {
		icon: WarningCircleIcon,
		text: "text-destructive",
		surface: "border-destructive/30 bg-[color-mix(in_oklab,var(--color-destructive)_8%,var(--color-frame))]",
	},
	warning: {
		icon: WarningIcon,
		text: "text-warning",
		surface: "border-warning/30 bg-[color-mix(in_oklab,var(--color-warning)_8%,var(--color-frame))]",
	},
	info: {
		icon: DownloadSimpleIcon,
		text: "text-ink-muted",
		surface: "border-edge bg-frame",
	},
	expired: {
		icon: ClockIcon,
		text: "text-warning",
		surface: "border-warning/30 bg-[color-mix(in_oklab,var(--color-warning)_8%,var(--color-frame))]",
	},
};

/** The tone's tint and border, for a notice set on a surface of its own. */
export const noticeSurface = (tone: Notice["tone"]) => tones[tone].surface;

/**
 * A notice as a card of its own. Dismissible when `onDismiss` is given; a notice about a state
 * clears itself instead. The description is clamped to two lines, whole on hover.
 */
function NoticeCard({
	title,
	description,
	tone,
	actions = [],
	onDismiss,
}: Notice & { readonly onDismiss?: () => void }) {
	const { icon: Icon, text, surface } = tones[tone];
	return (
		<div
			role="alert"
			className={`flex items-start gap-2 rounded-xl border ${surface} px-3 py-2 transition-[transform,opacity] duration-180 ease-out starting:translate-y-1 starting:opacity-0`}
		>
			{/* Centered on the title's line, so a two-line description does not pull it down. */}
			<Icon className={`mt-0.5 size-3.5 shrink-0 ${text}`} weight="bold" aria-hidden />
			<div className="min-w-0 flex-1">
				<p className="text-ui font-medium text-ink">{title}</p>
				{description !== undefined && (
					<p title={description} className="mt-0.5 line-clamp-2 text-xs leading-snug text-ink-muted">
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
					className="inline-flex shrink-0 items-center gap-1.5 self-center rounded-md border border-edge px-2 py-0.5 text-xs font-medium text-ink-muted transition-[transform,background-color,color] duration-150 ease-out outline-none hover:bg-ink/5 hover:text-ink focus-visible:bg-ink/5 enabled:active:scale-[0.97] disabled:pointer-events-none disabled:opacity-60"
				>
					{action.icon !== undefined && <action.icon className="size-3" weight="bold" aria-hidden />}
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
					<XIcon className="size-3.5" aria-hidden />
				</button>
			)}
		</div>
	);
}

/**
 * A notice as a line of the conversation, where a reply would be: the tone's icon, the title, and
 * the fact after it, with no box around them. Its dismiss and actions show on hover.
 */
export function NoticeLine({
	title,
	description,
	tone,
	actions = [],
	onDismiss,
}: Notice & { readonly onDismiss?: () => void }) {
	const { icon: Icon, text } = tones[tone];
	return (
		<div
			role="alert"
			className="group flex max-w-full items-start gap-2 text-ui transition-[opacity,translate] duration-180 ease-out starting:translate-y-1 starting:opacity-0"
		>
			<Icon className={`mt-0.5 size-3.5 shrink-0 ${text}`} weight="bold" aria-hidden />
			<p className="min-w-0 text-ink-muted">
				<span className="font-medium text-ink">{title}</span>
				{description !== undefined && <span> · {description}</span>}
			</p>
			{actions.map((action) => (
				<button
					key={action.label}
					type="button"
					disabled={action.disabled}
					onClick={action.onClick}
					className="inline-flex shrink-0 items-center gap-1 rounded-md px-1 text-xs font-medium text-ink-muted transition-[transform,background-color,color] duration-150 ease-out outline-none hover:bg-ink/5 hover:text-ink focus-visible:bg-ink/5 enabled:active:scale-[0.97] disabled:pointer-events-none disabled:opacity-60"
				>
					{action.icon !== undefined && <action.icon className="size-3" weight="bold" aria-hidden />}
					{action.label}
				</button>
			))}
			{onDismiss !== undefined && (
				<button
					type="button"
					aria-label="Dismiss"
					onClick={onDismiss}
					className="grid size-5 shrink-0 place-items-center rounded-md text-ink-muted transition-[transform,background-color,color,opacity] duration-150 ease-out hover:bg-ink/10 hover:text-ink focus-visible:opacity-100 active:scale-95 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100"
				>
					<XIcon className="size-3.5" aria-hidden />
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
			<NoticeCard {...shown} />
		</div>
	);
}
