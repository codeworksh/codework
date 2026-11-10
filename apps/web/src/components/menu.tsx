import { CheckIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import {
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import type { Check } from "@/components/vuesax";

/** Menu rows read as an OS menu's: 13px text and a 15px leading mark. */
export const MENU_ROW = "text-[13px] [&_svg:not([class*='size-'])]:size-[15px]";

/** Options named with an icon, as `MenuChoice` takes them: each icon drawn as its mark. */
export const marked = <A extends string>(
	options: ReadonlyArray<{ readonly value: A; readonly label: string; readonly icon: typeof Check }>,
) => options.map(({ icon: Icon, ...option }) => ({ ...option, mark: <Icon aria-hidden /> }));

/** The current pick of a list, at the end of its row. */
export function MenuCheck() {
	return <CheckIcon weight="bold" className="ml-auto size-3.5" aria-label="Current" />;
}

/**
 * One choice of a menu: its mark and name, opening its picks beside it with the current one checked.
 * `after` holds actions rather than picks, such as clearing it, below a separator.
 */
export function MenuChoice<A extends string>({
	label,
	mark,
	value,
	options,
	onChange,
	after,
}: {
	readonly label: string;
	readonly mark: ReactNode;
	readonly value: A | undefined;
	readonly options: ReadonlyArray<{ readonly value: A; readonly label: string; readonly mark: ReactNode }>;
	readonly onChange: (value: A) => void;
	readonly after?: ReactNode;
}) {
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger className={`${MENU_ROW} [&>svg:last-child]:size-3.5`}>
				{mark}
				{label}
			</DropdownMenuSubTrigger>
			{/* Shifted up by its padding and border, so its first row lines up with the trigger. */}
			<DropdownMenuSubContent alignOffset={-5} className="min-w-40">
				{options.map((option) => (
					<DropdownMenuItem
						key={option.value}
						role="menuitemradio"
						aria-checked={option.value === value}
						onSelect={() => onChange(option.value)}
						className={MENU_ROW}
					>
						{option.mark}
						{option.label}
						{option.value === value && <MenuCheck />}
					</DropdownMenuItem>
				))}
				{after !== undefined && (
					<>
						<DropdownMenuSeparator />
						{after}
					</>
				)}
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}
