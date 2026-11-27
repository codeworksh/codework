import type { ReactNode } from "react";

import { GLOW, onScreen, spritePath, TERMINAL_HEIGHT, TERMINAL_WIDTH } from "@/components/pixel";

// A prompt and its cursor.
const PROMPT = ["#.......", ".#...###", "#....###"];

const TERMINAL_PATH = spritePath(onScreen(PROMPT, 4, 3));
const GLOW_PATH = spritePath(GLOW);

/** The sidebar's message when it has nothing to list: a few quiet lines at the top, and what to do next. */
export function Empty({ children }: { children: ReactNode }) {
	return (
		<div className="flex w-full min-w-0 flex-col items-center gap-5 px-6 py-6 text-center text-body leading-relaxed text-ink-muted/70">
			<div className="flex flex-col items-center gap-2">{children}</div>
			<svg
				aria-hidden
				viewBox={`0 0 ${TERMINAL_WIDTH} ${TERMINAL_HEIGHT}`}
				shapeRendering="crispEdges"
				className="w-24 text-ink-muted/35"
				fill="currentColor"
			>
				<path d={GLOW_PATH} opacity={0.4} />
				<path d={TERMINAL_PATH} />
			</svg>
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
			className="inline-flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-2xs font-medium text-ink-muted transition-colors outline-none hover:bg-ink/5 hover:text-ink focus-visible:bg-ink/5 disabled:pointer-events-none disabled:opacity-60"
		>
			{icon}
			{children}
		</button>
	);
}
