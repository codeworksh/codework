import { Command as CommandPrimitive } from "cmdk";
import { Check, Plus } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface Option {
	readonly value: string;
	readonly label: string;
	readonly mark: ReactNode;
}

/**
 * A row's picker, as Linear's: a search field with the key that opens it, then the options, the
 * current one checked. With `digits`, 1-9 pick while the field is empty; with `onCreate`, a name
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
					narrow ? "w-2" : "min-w-6 px-1"
				}`}
			>
				{icon}
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-60 overflow-hidden rounded-lg border-edge p-0 shadow-lg"
				// The list takes focus back, so the keyboard stays on it.
				onCloseAutoFocus={(event) => event.preventDefault()}
				onMouseDown={(event) => event.stopPropagation()}
			>
				<Command loop className="bg-transparent">
					<div className="flex h-10 items-center gap-2 border-b border-edge pr-2.5 pl-3">
						<CommandPrimitive.Input
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
							className="h-full min-w-0 flex-1 bg-transparent text-ui text-ink outline-none placeholder:text-ink-muted"
						/>
						<kbd className="grid h-5 min-w-5 place-items-center rounded border border-edge px-1 font-sans text-2xs text-ink-muted">
							{shortcut}
						</kbd>
					</div>
					<CommandList className="max-h-72 p-1">
						<CommandGroup heading={heading} className="p-0">
							{options.map((option, index) => (
								<CommandItem
									key={option.value}
									value={`${option.label}\u0000${option.value}`}
									onSelect={() => pick(option)}
									className="h-8 gap-2.5 rounded-md px-2 text-ui text-ink"
								>
									<span className="grid size-4 shrink-0 place-items-center">{option.mark}</span>
									<span className="min-w-0 flex-1 truncate">{option.label}</span>
									{option.value === value && (
										<Check className="size-3.5 text-ink-secondary" aria-label="Current" />
									)}
									{digits && index < 9 && (
										<span className="w-3 text-right text-2xs text-ink-muted tabular-nums">{index + 1}</span>
									)}
								</CommandItem>
							))}
						</CommandGroup>
						{creatable && (
							<CommandItem
								forceMount
								value={`\u0000create ${name}`}
								onSelect={() => {
									onCreate.create(name);
									change(false);
								}}
								className="h-8 gap-2.5 rounded-md px-2 text-ui text-ink"
							>
								<Plus className="size-4 text-ink-secondary" aria-hidden />
								<span className="min-w-0 truncate">
									Create new {onCreate.noun}: <span className="text-ink-muted">“{name}”</span>
								</span>
							</CommandItem>
						)}
						{!creatable && (
							<CommandEmpty className="py-4 text-center text-ui text-ink-muted">No results</CommandEmpty>
						)}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
