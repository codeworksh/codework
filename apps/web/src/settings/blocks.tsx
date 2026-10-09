import type { ReactNode } from "react";

/** Building blocks every settings section is made of: a page of titled sections of row groups. */

export function Page({
	title,
	description,
	children,
}: {
	title: string;
	description?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 md:px-10 md:py-12">
			<header className="flex flex-col gap-1">
				<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
				{description !== undefined && <p className="text-ink-muted">{description}</p>}
			</header>
			{children}
		</div>
	);
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<h2 className="font-medium">{title}</h2>
			{children}
		</section>
	);
}

/** A card of rows with a divider between each. */
export function Group({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-col divide-y divide-edge rounded-xl border border-edge bg-ink/[0.02]">{children}</div>
	);
}

/** A labelled setting: title and a one-line description on the left, its control on the right. */
export function Row({
	title,
	description,
	children,
}: {
	title: string;
	description?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div className="flex items-center gap-4 px-4 py-3">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="font-medium">{title}</span>
				{description !== undefined && <span className="text-ink-muted">{description}</span>}
			</div>
			{children}
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
