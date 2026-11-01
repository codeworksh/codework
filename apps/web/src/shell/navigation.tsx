import { Link, useLocation } from "@tanstack/react-router";
import { House, Settings } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** App destinations stay available independently of the collapsible sessions sidebar. */
export function Navigation() {
	const pathname = useLocation({ select: (location) => location.pathname });
	return (
		<nav
			aria-label="Main navigation"
			className="fixed top-titlebar bottom-0 left-0 z-20 flex w-rail flex-col items-center gap-2 bg-desktop pt-2 pb-3 select-none"
		>
			<Tooltip>
				<TooltipTrigger asChild>
					<Link
						to="/"
						aria-label="Home"
						aria-current={pathname === "/" ? "page" : undefined}
						className={destination}
					>
						<House className="size-[18px]" strokeWidth={1.75} aria-hidden />
					</Link>
				</TooltipTrigger>
				<TooltipContent side="right" sideOffset={8}>
					Home
				</TooltipContent>
			</Tooltip>
			<div className="flex-1" />
			<Tooltip>
				<TooltipTrigger asChild>
					<Link
						to="/settings/workspaces"
						aria-label="Settings"
						aria-current={pathname.startsWith("/settings") ? "page" : undefined}
						className={destination}
					>
						<Settings className="size-[18px]" strokeWidth={1.75} aria-hidden />
					</Link>
				</TooltipTrigger>
				<TooltipContent side="right" sideOffset={8}>
					Settings
				</TooltipContent>
			</Tooltip>
		</nav>
	);
}

const destination =
	"grid size-8 place-items-center rounded-md text-ink-muted outline-none hover:bg-selection-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-selection aria-[current=page]:text-ink press [-webkit-app-region:no-drag]";
