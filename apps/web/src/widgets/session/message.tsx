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
				className={`grid size-6 shrink-0 place-items-center rounded-md text-2xs font-medium select-none ${user ? "bg-selection text-ink" : "bg-selection-subtle text-ink-muted"}`}
			>
				{user ? "U" : "A"}
			</div>
			<div
				className={`min-w-0 flex-1 rounded-lg px-3 py-2.5 ${user ? "bg-message text-message-ink" : "text-ink-secondary"}`}
			>
				<header className="mb-2 flex min-h-4 items-center gap-2 text-2xs leading-4">
					<span className="font-medium">{user ? "You" : "Assistant"}</span>
					{at !== undefined && (
						<time
							dateTime={new Date(at).toISOString()}
							title={new Date(at).toLocaleString()}
							className={user ? "text-message-ink/65" : "text-ink-muted"}
						>
							{ago(at)}
						</time>
					)}
				</header>
				<div className="flex min-w-0 flex-col gap-3 text-body wrap-anywhere">{children}</div>
			</div>
		</article>
	);
}
