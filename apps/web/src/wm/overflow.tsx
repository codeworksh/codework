import type { FrameIcon } from "@codeworksh/widget/view";
import { ChevronUp } from "lucide-react";
import type { Rect } from "webwm";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconOf } from "./frame";

export interface Hidden {
	readonly id: string;
	readonly title: string;
	readonly lead?: string | undefined;
	readonly icon?: FrameIcon | undefined;
}

/**
 * The slot at a column's bottom holding the frames no title bar fit: "+N more", listing them.
 * Picking one focuses it, which opens it in the column.
 */
export function Overflow({
	rect,
	hidden,
	onPick,
}: {
	readonly rect: Rect;
	readonly hidden: readonly Hidden[];
	readonly onPick: (id: string) => void;
}) {
	return (
		<div
			className="absolute top-0 left-0 box-border p-1"
			style={{ width: rect.w, height: rect.h, transform: `translate(${rect.x}px, ${rect.y}px)` }}
		>
			<DropdownMenu>
				<DropdownMenuTrigger className="panel flex h-full w-full items-center gap-1.5 px-3 text-left text-ink-muted outline-none transition-colors select-none hover:text-ink data-[state=open]:text-ink">
					<ChevronUp className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
					<span className="font-semibold">+{hidden.length} more</span>
				</DropdownMenuTrigger>
				<DropdownMenuContent side="top" align="start" className="max-h-80 w-64 overflow-y-auto">
					{hidden.map(({ id, title, lead, icon }) => (
						<DropdownMenuItem key={id} onSelect={() => onPick(id)}>
							{icon !== undefined && <IconOf icon={icon} />}
							<span className="truncate">
								{lead !== undefined && <span className="text-ink-muted/70">{lead} / </span>}
								{title}
							</span>
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
