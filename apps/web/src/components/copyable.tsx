import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/** A shell command to run by hand, or a value to paste elsewhere, with a copy button that confirms. */
export function CopyCommand({ command, label = "Copy command" }: { command: string; label?: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<span className="flex min-w-0 items-center gap-1 rounded-lg border border-edge bg-ink/3 py-1 pr-1 pl-3">
			<code className="min-w-0 flex-1 truncate font-mono text-xs" title={command}>
				{command}
			</code>
			<Button
				size="icon-xs"
				variant="ghost"
				aria-label={label}
				title="Copy"
				onClick={() =>
					void navigator.clipboard.writeText(command).then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					})
				}
			>
				{copied ? <CheckIcon /> : <CopyIcon />}
			</Button>
		</span>
	);
}
