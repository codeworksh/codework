import { Plus } from "@/components/vuesax";
import { type ReactNode, useState } from "react";

import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandShortcut,
} from "@/components/ui/command";
import { MENU_ROW, MenuCheck } from "@/components/menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";

/** Rows as the menus' are: dense, 13px, one height. */
const PICKER_ROW = `${MENU_ROW} min-h-7 rounded-[8px] py-1`;

export interface Option {
	readonly value: string;
	readonly label: string;
	readonly mark: ReactNode;
}

/**
 * The list's one picker, as Linear's: a search field, then the options, the current one checked.
 * It opens at `anchor`, the row button it belongs to, so no row mounts a popover of its own. With
 * `digits`, 1-9 pick while the field is empty; with `onCreate`, a name no option has offers to
 * create it.
 */
export function Picker({
	anchor,
	placeholder,
	value,
	options,
	heading,
	onPick,
	onCreate,
	digits = false,
	onClose,
}: {
	readonly anchor: HTMLElement;
	readonly placeholder: string;
	readonly value: string;
	readonly options: ReadonlyArray<Option>;
	readonly heading?: string | undefined;
	readonly onPick: (value: string) => void;
	readonly onCreate?: { readonly noun: string; readonly create: (name: string) => void } | undefined;
	readonly digits?: boolean;
	readonly onClose: () => void;
}) {
	const [search, setSearch] = useState("");
	const name = search.trim();
	const creatable =
		onCreate !== undefined &&
		name !== "" &&
		!options.some((option) => option.label.toLowerCase() === name.toLowerCase());
	const create = () => {
		onCreate?.create(name);
		onClose();
	};
	const pick = (option: Option) => {
		if (option.value !== value) onPick(option.value);
		onClose();
	};
	return (
		<Popover open onOpenChange={(open) => !open && onClose()}>
			<PopoverAnchor virtualRef={{ current: anchor }} />
			<PopoverContent
				align="start"
				// Opened from a key, many times a day: shown at once, without the popover's zoom.
				className="w-52 p-0 data-[state=closed]:animate-none data-[state=open]:animate-none"
				// The list takes focus back, so the keyboard stays on it.
				onCloseAutoFocus={(event) => event.preventDefault()}
				// A click on its own button closes it there, rather than here and open again.
				onInteractOutside={(event) => {
					if (event.target instanceof Node && anchor.contains(event.target)) event.preventDefault();
				}}
				onMouseDown={(event) => event.stopPropagation()}
			>
				<Command loop>
					<CommandInput
						value={search}
						onValueChange={setSearch}
						placeholder={placeholder}
						aria-label={placeholder}
						onKeyDown={(event) => {
							const option =
								digits && search === "" && /^[1-9]$/.test(event.key)
									? options[Number(event.key) - 1]
									: undefined;
							if (option === undefined) return;
							event.preventDefault();
							pick(option);
						}}
						className="h-9 text-[13px]"
					/>
					<CommandList>
						<CommandEmpty className="py-4 text-center text-xs text-ink-muted">No results.</CommandEmpty>
						<CommandGroup heading={heading} className="[&_[cmdk-group-heading]]:text-2xs">
							{options.map((option, index) => (
								<CommandItem
									key={option.value}
									value={`${option.label}\u0000${option.value}`}
									onSelect={() => pick(option)}
									className={PICKER_ROW}
								>
									{option.mark}
									<span className="truncate">{option.label}</span>
									{option.value === value && <MenuCheck />}
									{digits && index < 9 && (
										<CommandShortcut className={option.value === value ? "ml-1.5" : undefined}>
											{index + 1}
										</CommandShortcut>
									)}
								</CommandItem>
							))}
						</CommandGroup>
						{creatable && (
							<CommandGroup forceMount>
								<CommandItem forceMount value={`\u0000create ${name}`} onSelect={create} className={PICKER_ROW}>
									<Plus aria-hidden />
									<span className="truncate">
										Create {onCreate.noun} <span className="text-ink-muted">“{name}”</span>
									</span>
								</CommandItem>
							</CommandGroup>
						)}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
