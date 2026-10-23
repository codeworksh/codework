import type { ReactNode } from "react";

import { ago } from "../time";

/** Both speakers share one reading edge; a quiet tint distinguishes the user's messages. */
export function Message({
	role,
	at,
	children,
}: {
	readonly role: "user" | "assistant";
	readonly at: number | undefined;
	readonly children: ReactNode;
}) {
	const user = role === "user";
	return (
		<article aria-label={user ? "Your message" : "Assistant message"} className="flex min-w-0 items-start gap-2.5">
			<div
				aria-hidden
				className={`grid size-7 shrink-0 place-items-center rounded-md text-[12px] font-medium select-none ${user ? "bg-brand/15 text-brand" : "bg-ink/8 text-ink-secondary"}`}
			>
				{user ? "U" : "A"}
			</div>
			<div className={`min-w-0 flex-1 rounded-lg px-3.5 py-3 ${user ? "bg-brand/8" : "bg-ink/3"}`}>
				<header className="mb-2 flex min-h-4 items-center gap-2 text-[12px] leading-4">
					{user && <span className="font-medium text-ink">You</span>}
					{at !== undefined && (
						<time
							dateTime={new Date(at).toISOString()}
							title={new Date(at).toLocaleString()}
							className="text-ink-muted"
						>
							{ago(at)}
						</time>
					)}
				</header>
				<div className="flex min-w-0 flex-col gap-3 wrap-anywhere text-ink/90">{children}</div>
			</div>
		</article>
	);
}
