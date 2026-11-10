import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CheckIcon } from "@phosphor-icons/react";

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

type Icon = typeof SlidersHorizontal;

/** Menu rows read as an OS menu's: 13px text and a 15px leading icon. */
const ROW = "text-[13px] [&_svg:not([class*='size-'])]:size-[15px]";

/** One choice of a display menu: its icon and name, opening its picks beside it with the current one checked. */
export function DisplayChoice<A extends string>({
	label,
	icon: Icon,
	value,
	options,
	onChange,
}: {
	readonly label: string;
	readonly icon: Icon;
	readonly value: A;
	readonly options: ReadonlyArray<{ readonly value: A; readonly label: string; readonly icon: Icon }>;
	readonly onChange: (value: A) => void;
}) {
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger className={`${ROW} [&>svg:last-child]:size-3.5`}>
				<Icon aria-hidden />
				{label}
			</DropdownMenuSubTrigger>
			{/* Shifted up by its padding and border, so its first row lines up with the trigger. */}
			<DropdownMenuSubContent alignOffset={-5} className="min-w-40">
				{options.map(({ value: option, label: name, icon: OptionIcon }) => (
					<DropdownMenuItem
						key={option}
						role="menuitemradio"
						aria-checked={option === value}
						onSelect={() => onChange(option)}
						className={ROW}
					>
						<OptionIcon aria-hidden />
						{name}
						{option === value && <CheckIcon weight="bold" className="ml-auto size-3.5" aria-hidden />}
					</DropdownMenuItem>
				))}
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}
