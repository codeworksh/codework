import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SlidersHorizontal } from "@/components/vuesax";

/** A view's display options: a dense menu whose choices open to the side, as an OS menu's do. */
export function DisplayMenu({
	children,
	align = "end",
	side = "bottom",
	triggerClassName,
}: {
	readonly children: ReactNode;
	readonly align?: ComponentProps<typeof DropdownMenuContent>["align"];
	readonly side?: ComponentProps<typeof DropdownMenuContent>["side"];
	readonly triggerClassName?: string;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label="Display Options"
					title="Display Options"
					className={triggerClassName}
				>
					<SlidersHorizontal aria-hidden />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align={align} side={side} className="min-w-40">
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
