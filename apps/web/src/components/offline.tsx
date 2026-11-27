import { WarningCircleIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";

import { cn } from "@/lib/utils";
import type { Problem } from "../kernel/servers";

/**
 * Where this machine's server problem shows, in the sidebar and the composer alike: one way to its
 * page, which says what is wrong and fixes it. The problem reads on hover.
 */
export function OpenMachineSettings({ problem, className }: { problem: Problem; className?: string }) {
	const navigate = useNavigate();
	return (
		<button
			type="button"
			title={`${problem.title}: ${problem.line}`}
			onClick={() => void navigate({ to: "/settings/machines/localhost" })}
			className={cn(
				"flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-warning outline-none transition-colors hover:bg-warning/10 focus-visible:bg-warning/10",
				className,
			)}
		>
			<WarningCircleIcon className="size-3.5 shrink-0" weight="bold" aria-hidden />
			<span className="truncate">Open Machine Settings</span>
		</button>
	);
}
