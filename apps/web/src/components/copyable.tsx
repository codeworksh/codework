import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/** A shell command to run by hand, with a copy button that confirms. */
export function CopyCommand({ command }: { command: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<span className="flex items-center gap-1 rounded-lg border border-edge bg-ink/3 py-1 pr-1 pl-3">
			<code className="flex-1 font-mono text-xs">{command}</code>
			<Button
				size="icon-xs"
				variant="ghost"
				aria-label="Copy command"
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
