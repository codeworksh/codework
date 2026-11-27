import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A shell command to run by hand, or a value to paste elsewhere, with a copy button that confirms.
 * `shown` stands in for it on one line, where the full command is too much to read.
 */
export function CopyCommand({
	command,
	shown = command,
	label = "Copy command",
}: {
	command: string;
	shown?: ReactNode;
	label?: string;
}) {
	return (
		<span className="flex min-w-0 items-center gap-1 rounded-lg border border-edge bg-ink/3 py-1 pr-1 pl-3">
			<code className="min-w-0 flex-1 truncate font-mono text-xs" title={command}>
				{shown}
			</code>
			<CopyButton value={command} label={label} />
		</span>
	);
}

/** Copies a value, and shows a check for a moment once it has. */
export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			// Inside a form it would otherwise submit it.
			type="button"
			size="icon-xs"
			variant="ghost"
			aria-label={label}
			title="Copy"
			className={cn("relative before:absolute before:-inset-2 before:content-['']", className)}
			onClick={() =>
				void navigator.clipboard.writeText(value).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				})
			}
		>
			{copied ? <CheckIcon /> : <CopyIcon />}
		</Button>
	);
}
