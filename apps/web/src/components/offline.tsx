import { useNavigate } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Problem } from "../kernel/servers";

/**
 * Where the default server's problem shows, in the sidebar and the composer alike: one way to the
 * provider settings, which say what is wrong and fix it. The problem reads on hover.
 */
export function OpenProviderSettings({ problem, className }: { problem: Problem; className?: string }) {
	const navigate = useNavigate();
	return (
		<button
			type="button"
			title={`${problem.title}: ${problem.line}`}
			onClick={() => void navigate({ to: "/settings/servers" })}
			className={cn(
				"flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-warning outline-none press transition-colors hover:bg-warning/10 focus-visible:bg-warning/10",
				className,
			)}
		>
			<CircleAlert className="size-3.5 shrink-0" strokeWidth={2} aria-hidden />
			<span className="truncate">Open Provider Settings</span>
		</button>
	);
}
