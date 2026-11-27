import { CheckCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { useNowMinute } from "@/hooks/now";
import { ago } from "../widgets/time";

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
	// Cut short in a narrow column; the whole status shows on hover.
	const title = typeof children === "string" ? children : undefined;
	return (
		<span className="inline-flex max-w-full min-w-0 items-center gap-1.5 text-xs text-ink-muted">
			<span className={`size-1.5 shrink-0 rounded-full ${DOTS[tone]}`} aria-hidden />
			<span className="truncate" title={title}>
				{children}
			</span>
		</span>
	);
}

/** Whether a machine answers now, else when it last did. */
export function SeenStatus({ online, seenAt }: { readonly online: boolean; readonly seenAt: number | null }) {
	if (online) return <StatusDot tone="success">Online</StatusDot>;
	// Read as a number: a server that predates the field sends none.
	if (typeof seenAt !== "number") return <StatusDot tone="muted">Never Seen</StatusDot>;
	return (
		<StatusDot tone="muted">
			<span className="tabular-nums">
				<LastSeen time={seenAt} />
			</span>
		</StatusDot>
	);
}

/** A short confirmation that something just worked, fading in where it appears. */
export function Done({ children }: { readonly children: ReactNode }) {
	return (
		<span
			role="status"
			className="flex animate-in items-center gap-1.5 text-xs text-ink-secondary duration-200 fade-in-0 motion-reduce:animate-none"
		>
			<CheckCircleIcon size={14} weight="fill" className="shrink-0 text-success" aria-hidden />
			{children}
		</span>
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

/** "Last Seen Now", "Last Seen 5h Ago": a status label, in title case. */
function LastSeen({ time }: { readonly time: number }) {
	const since = ago(time, useNowMinute());
	return since === "now" ? "Last Seen Now" : `Last Seen ${since} Ago`;
}
