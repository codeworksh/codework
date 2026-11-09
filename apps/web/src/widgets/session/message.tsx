import { Check, Copy, GitFork } from "@/components/vuesax";
import { type ReactNode, useEffect, useState } from "react";

/** Wall-clock stamp for a message or finished turn, in the reader's own locale. */
function clockTime(epochMs: number) {
	return new Date(epochMs).toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
}

function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<button
			type="button"
			title={copied ? "Copied" : label}
			aria-label={copied ? "Copied" : label}
			onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
			className="-ml-1 grid place-items-center rounded-md p-1 text-ink-muted transition-[transform,background-color,color] duration-150 ease-out hover:bg-ink/8 hover:text-ink active:scale-95"
		>
			<Copy
				className={`col-start-1 row-start-1 size-3.5 transition-[transform,opacity,filter] duration-150 ease-out ${
					copied ? "scale-75 opacity-0 blur-[2px]" : "scale-100 opacity-100"
				}`}
				strokeWidth={1.75}
				aria-hidden
			/>
			<Check
				className={`col-start-1 row-start-1 size-3.5 transition-[transform,opacity,filter] duration-150 ease-out ${
					copied ? "scale-100 opacity-100" : "scale-75 opacity-0 blur-[2px]"
				}`}
				strokeWidth={1.75}
				aria-hidden
			/>
		</button>
	);
}

function ForkButton({ onFork }: { readonly onFork: () => void }) {
	return (
		<button
			type="button"
			title="Fork from here"
			aria-label="Fork from here"
			onClick={onFork}
			className="-ml-1 rounded-md p-1 text-ink-muted transition-[transform,background-color,color] duration-150 ease-out hover:bg-ink/8 hover:text-ink active:scale-95"
		>
			<GitFork className="size-3.5" strokeWidth={1.75} aria-hidden />
		</button>
	);
}

/**
 * A user message sits in a right-aligned bubble with its actions and timestamp tucked beneath; an
 * assistant reply flows directly down the reading column and signs off with its copy action and time.
 */
export function Message({
	role,
	promptId,
	at,
	ended,
	copyText,
	onFork,
	children,
}: {
	readonly role: "user" | "assistant";
	readonly promptId?: string | undefined;
	readonly at: number | undefined;
	readonly ended?: number | undefined;
	readonly copyText?: string | undefined;
	/** Forks the conversation at this message; absent where it cannot be forked. */
	readonly onFork?: (() => void) | undefined;
	readonly children: ReactNode;
}) {
	if (role === "user") {
		const hasCopy = copyText !== undefined && copyText !== "";
		return (
			<article
				aria-label="Your message"
				data-prompt-anchor={promptId}
				className="user-message-row flex flex-col items-end pt-1.5 pr-4 pb-5 pl-14"
			>
				<div className="user-message-hover-zone flex w-fit max-w-full min-w-0 flex-col items-end">
					<div className="w-fit max-w-full min-w-0 rounded-xl bg-message px-3 py-2 text-body text-message-ink transition-colors duration-200 sm:max-w-xl">
						{children}
					</div>
					{(hasCopy || onFork !== undefined || at !== undefined) && (
						<div className="user-message-actions flex items-center gap-1 px-3 pt-1">
							{hasCopy && <CopyButton text={copyText} label="Copy message" />}
							{onFork !== undefined && <ForkButton onFork={onFork} />}
							{at !== undefined && (
								<time
									dateTime={new Date(at).toISOString()}
									title={new Date(at).toLocaleString()}
									className="ml-1 text-xs text-ink-muted"
								>
									{clockTime(at)}
								</time>
							)}
						</div>
					)}
				</div>
			</article>
		);
	}

	const hasCopy = copyText !== undefined && copyText !== "";
	return (
		<article
			aria-label="Assistant message"
			data-assistant-reply=""
			className="flex min-w-0 flex-col text-body wrap-anywhere"
		>
			{children}
			{ended !== undefined && (
				<div className="flex w-full min-w-0 items-center gap-2.5 px-4 pt-1 pb-3 text-body text-ink-muted">
					<span className="flex shrink-0 items-center gap-1">
						{hasCopy ? (
							<CopyButton text={copyText} label="Copy response" />
						) : (
							<Check className="size-3.5 text-ink-muted" strokeWidth={1.75} aria-hidden />
						)}
						{onFork !== undefined && <ForkButton onFork={onFork} />}
					</span>
					{ended > 0 && (
						<span className="flex shrink-0 items-center gap-2.5">
							<span aria-hidden className="size-1 shrink-0 rounded-full bg-ink/25" />
							<time
								dateTime={new Date(ended).toISOString()}
								title={new Date(ended).toLocaleString()}
								className="shrink-0 text-xs text-ink-muted"
							>
								{clockTime(ended)}
							</time>
						</span>
					)}
				</div>
			)}
		</article>
	);
}
