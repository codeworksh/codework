import { Check, Plus } from "lucide-react";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface Option {
	readonly value: string;
	readonly label: string;
	readonly mark: ReactNode;
}

/**
 * A row's picker, as Linear's: a search field, then the options, the current one checked. With `digits`, 1-9 pick while the field is empty; with `onCreate`, a name
 * no option has offers to create it.
 */
export function Picker({
	label,
	placeholder,
	shortcut,
	icon,
	value,
	options,
	heading,
	onPick,
	onCreate,
	digits = false,
	open,
	onOpenChange,
	narrow = false,
}: {
	readonly label: string;
	readonly placeholder: string;
	readonly shortcut: string;
	readonly icon: ReactNode;
	readonly value: string;
	readonly options: ReadonlyArray<Option>;
	readonly heading?: string | undefined;
	readonly onPick: (value: string) => void;
	readonly onCreate?: { readonly noun: string; readonly create: (name: string) => void };
	readonly digits?: boolean;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly narrow?: boolean;
}) {
	const [search, setSearch] = useState("");
	const name = search.trim();
	const creatable =
		onCreate !== undefined &&
		name !== "" &&
		!options.some((option) => option.label.toLowerCase() === name.toLowerCase());
	const change = (next: boolean) => {
		if (!next) setSearch("");
		onOpenChange(next);
	};
	const create = () => {
		onCreate?.create(name);
		change(false);
	};
	const pick = (option: Option) => {
		if (option.value !== value) onPick(option.value);
		change(false);
	};
	return (
		<Popover open={open} onOpenChange={change}>
			<PopoverTrigger
				aria-label={label}
				title={`${label} (${shortcut})`}
				tabIndex={-1}
				onMouseDown={(event) => event.stopPropagation()}
				className={`flex h-6 shrink-0 items-center justify-center rounded-md text-ink-muted outline-none hover:bg-ink/8 hover:text-ink ${
					narrow ? "w-3" : "min-w-6 px-1"
				}`}
			>
				{icon}
			</PopoverTrigger>
			<PopoverContent
				align="start"
				// Opened from a key, many times a day: shown at once, without the popover's zoom.
				className="w-52 p-0 data-[state=closed]:animate-none data-[state=open]:animate-none"
				// The list takes focus back, so the keyboard stays on it.
				onCloseAutoFocus={(event) => event.preventDefault()}
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
						className="h-9 text-xs"
					/>
					<CommandList>
						<CommandEmpty className="py-4 text-center text-xs text-ink-muted">No results.</CommandEmpty>
						<CommandGroup heading={heading} className="[&_[cmdk-group-heading]]:text-2xs">
							{options.map((option, index) => (
								<CommandItem
									key={option.value}
									value={`${option.label}\u0000${option.value}`}
									onSelect={() => pick(option)}
									className="text-xs"
								>
									{option.mark}
									<span className="truncate">{option.label}</span>
									{option.value === value && <Check className="ml-auto size-3.5" aria-label="Current" />}
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
								<CommandItem forceMount value={`\u0000create ${name}`} onSelect={create} className="text-xs">
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
