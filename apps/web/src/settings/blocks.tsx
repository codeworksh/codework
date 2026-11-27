import { type ReactNode, useState } from "react";

import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

/** Building blocks every settings section is made of: a page of titled sections of row groups. */

export function Page({
	title,
	description,
	actions,
	children,
}: {
	title: string;
	description?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
}) {
	return (
		// A 640px column, set well below the panel's top edge: settings read as a document, not a dashboard.
		<div className="@container mx-auto flex w-full max-w-settings flex-col gap-12 px-5 pt-16 pb-16 text-ui sm:px-8">
			<header className="-mb-4 flex flex-col gap-1.5">
				<div className="flex items-center gap-4">
					<h1 className="min-w-0 flex-1 text-2xl/8 font-medium text-balance wrap-break-word">{title}</h1>
					{actions}
				</div>
				{description !== undefined && <p className="font-book text-ink-muted">{description}</p>}
			</header>
			{children}
		</div>
	);
}

export function Section({
	title,
	count,
	description,
	action,
	children,
}: {
	title: string;
	/** How many items it lists, after the title; none when there are none. */
	count?: number | undefined;
	/** A line under the title, for what is true of the whole section. */
	description?: string | undefined;
	/** A control at the right of the title. */
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-3">
				<div className="flex min-w-0 flex-col">
					<h2 className="flex min-h-7 min-w-0 items-center text-section font-medium">
						<span className="truncate" title={title}>
							{title}
						</span>
						{count !== undefined && count > 0 && (
							<span className="shrink-0 whitespace-pre text-ink-muted tabular-nums"> · {count}</span>
						)}
					</h2>
					{description !== undefined && <p className="font-book text-pretty text-ink-muted">{description}</p>}
				</div>
				{action}
			</div>
			{children}
		</section>
	);
}

/** A card of rows with a divider between each, raised on the page's brightest surface. */
export function Group({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-col divide-y divide-edge/60 rounded-[10px] bg-frame-top shadow-(--cw-card-shadow)">
			{children}
		</div>
	);
}

/** A labelled setting: title and a one-line description on the left, its control on the right. */
export function Row({
	title,
	description,
	children,
}: {
	title: ReactNode;
	description?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div className="flex min-h-15 flex-col items-start gap-3 px-4 py-3 @min-[560px]:flex-row @min-[560px]:items-center @min-[560px]:gap-4">
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="font-medium">{title}</span>
				{description !== undefined && <span className="text-xs font-book text-ink-muted">{description}</span>}
			</div>
			{children}
		</div>
	);
}

/** Rows the size of real ones while the first answer is on its way, so nothing jumps when it lands. */
export function Placeholder({ rows }: { readonly rows: number }) {
	return (
		<Group>
			{Array.from({ length: rows }, (_, index) => (
				<div key={index} aria-hidden className="flex min-h-15 items-center gap-4 px-4 py-3">
					<div className="flex min-w-0 flex-1 flex-col gap-2">
						<Skeleton className="h-3.5 w-40" />
						<Skeleton className="h-3 w-64 max-w-full" />
					</div>
					<Skeleton className="h-3 w-16" />
				</div>
			))}
		</Group>
	);
}

/** A setting in a dialog's bordered card: its title and description beside its field. */
export function DialogRow({
	title,
	description,
	htmlFor,
	top = false,
	children,
}: {
	title: ReactNode;
	description: ReactNode;
	/** The field the title labels. */
	htmlFor?: string | undefined;
	/** Title and field share their top line, for a field with a message line under it. */
	top?: boolean;
	children: ReactNode;
}) {
	return (
		<div
			className={`grid gap-x-6 gap-y-2 px-5 py-4 sm:grid-cols-[1fr_16rem] ${top ? "items-start" : "items-center"}`}
		>
			<span className={`flex flex-col gap-1 ${top ? "sm:pt-1" : ""}`}>
				{htmlFor === undefined ? (
					<span className="font-medium">{title}</span>
				) : (
					<label htmlFor={htmlFor} className="font-medium">
						{title}
					</label>
				)}
				<span className="text-sm text-ink-muted">{description}</span>
			</span>
			<span className="flex min-w-0 flex-col gap-1.5">{children}</span>
		</div>
	);
}

/** A shortcut as the keys to press. */
export function Keys({ children }: { children: ReactNode }) {
	return (
		<kbd className="shrink-0 rounded-md border border-edge bg-ink/5 px-1.5 py-0.5 font-sans text-ink-muted">
			{children}
		</kbd>
	);
}

/** A field that saves itself: Enter or leaving it passes on a changed value, trimmed; Escape puts the saved one back. */
export function SavingInput({
	id,
	value,
	label,
	placeholder,
	autoFocus = false,
	className,
	onCommit,
}: {
	id?: string | undefined;
	value: string;
	label: string;
	placeholder?: string | undefined;
	autoFocus?: boolean;
	className?: string;
	onCommit: (name: string) => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	// Reads the field itself: Escape resets it just before blurring, sooner than state would.
	const commit = (next: string) => {
		const trimmed = next.trim();
		setDraft(null);
		if (trimmed !== value) onCommit(trimmed);
	};
	return (
		<Input
			id={id}
			aria-label={label}
			value={draft ?? value}
			placeholder={placeholder}
			autoFocus={autoFocus}
			onFocus={(event) => autoFocus && event.currentTarget.select()}
			className={className}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={(event) => commit(event.currentTarget.value)}
			onKeyDown={(event) => {
				if (event.key === "Enter") event.currentTarget.blur();
				if (event.key === "Escape") {
					event.currentTarget.value = value;
					event.currentTarget.blur();
				}
			}}
		/>
	);
}

/** The quiet look of a settings field on every theme; the stock input fills in dark ones. */
export const quietField = "rounded-lg border-edge shadow-none";

/** A name as it is typed in a shell: a variable, a command or a flag. */
export const Code = ({ children }: { children: ReactNode }) => (
	<code className="rounded bg-ink/8 px-1 py-px font-mono text-[0.9em] text-ink">{children}</code>
);
