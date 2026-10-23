import type { ReactNode } from "react";

/** The sidebar's message when it has nothing to list: a few quiet lines, centered, and what to do next. */
export function Empty({ children }: { children: ReactNode }) {
	return (
		<div className="flex w-full min-w-0 flex-col items-center gap-2 px-2 py-6 text-center text-[12px] text-ink-muted/70">
			{children}
		</div>
	);
}

/** The one thing to do from an empty sidebar, as a small outlined button. */
export function EmptyAction({
	icon,
	disabled = false,
	onClick,
	children,
}: {
	icon?: ReactNode;
	disabled?: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className="inline-flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-[11px] font-medium text-ink-muted transition-colors outline-none hover:bg-ink/5 hover:text-ink focus-visible:bg-ink/5 disabled:pointer-events-none disabled:opacity-60"
		>
			{icon}
			{children}
		</button>
	);
}
