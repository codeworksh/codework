import { CaretUpDownIcon, CheckIcon, DesktopIcon, SquaresFourIcon } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";

import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Monogram } from "@/components/monogram";
import { formatCount, type Project, type ProjectOption } from "./data";

const ALL = "all";
const ROW = "min-h-7 gap-2 py-1 text-[13px]";
const GROUP = "[&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:pb-1";

/** cmdk filters on the value, so it carries the name; the id keeps two same-named projects apart. */
const valueOf = (item: { readonly id: string; readonly name: string }) => `${item.name}\u0000${item.id}`;

/** Whether a key press belongs to a field rather than to the page's shortcuts. */
const typing = (target: EventTarget | null) =>
	target instanceof HTMLElement &&
	(target.isContentEditable || target.closest("input, textarea, select, [role=textbox]") !== null);

/** The current pick's check, or the same room empty, so counts line up on every row. */
function Check({ on }: { readonly on: boolean }) {
	return on ? (
		<CheckIcon weight="bold" className="size-3.5 text-ink" aria-label="Current" />
	) : (
		<span className="size-3.5 shrink-0" aria-hidden />
	);
}

/** A header filter's button: what is picked, and the list it opens. */
function Filter({
	label,
	icon,
	name,
	open,
	onOpenChange,
	width,
	children,
}: {
	/** What it filters, for a screen reader: "Project". */
	readonly label: string;
	readonly icon: ReactNode;
	readonly name: string;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly width: string;
	readonly children: ReactNode;
}) {
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label={`${label}: ${name}`}
					className="flex h-7 max-w-56 min-w-0 items-center gap-1.5 rounded-md border border-edge px-2 text-xs text-ink outline-none hover:bg-selection-subtle focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] aria-expanded:bg-selection-subtle"
				>
					{icon}
					<span className="truncate">{name}</span>
					<CaretUpDownIcon size={12} className="shrink-0 text-ink-muted" aria-hidden />
				</button>
			</PopoverTrigger>
			<PopoverContent align="end" className={`${width} p-0`}>
				{children}
			</PopoverContent>
		</Popover>
	);
}

/** The page's project scope: every project, or one picked from a filterable list ordered by activity. */
export function ProjectSelect({
	value,
	onChange,
	options,
}: {
	readonly value: string | null;
	readonly onChange: (projectId: string | null) => void;
	readonly options: ReadonlyArray<ProjectOption>;
}) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [highlight, setHighlight] = useState(ALL);

	const active = options.filter((row) => row.prompts > 0).toSorted((a, b) => b.prompts - a.prompts);
	const idle = options
		.filter((row) => row.prompts === 0)
		.toSorted((a, b) => a.project.name.localeCompare(b.project.name));
	const sessions = options.reduce((sum, row) => sum + row.sessions, 0);
	const selected = options.find((row) => row.project.id === value)?.project;

	const show = (next: boolean) => {
		if (next) {
			setSearch("");
			setHighlight(selected === undefined ? ALL : valueOf(selected));
		}
		setOpen(next);
	};
	const pick = (projectId: string | null) => {
		onChange(projectId);
		setOpen(false);
	};

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() !== "p" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
				return;
			if (event.repeat || typing(event.target)) return;
			event.preventDefault();
			show(true);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	});

	const row = (project: Project, prompts: number | undefined) => (
		<CommandItem key={project.id} value={valueOf(project)} onSelect={() => pick(project.id)} className={ROW}>
			<Monogram id={project.id} name={project.name} />
			<span title={project.name} className={`truncate ${prompts === undefined ? "text-ink-muted" : ""}`}>
				{project.name}
			</span>
			<span className="ml-auto shrink-0 pl-2 text-xs text-ink-muted tabular-nums">
				{prompts !== undefined && formatCount(prompts)}
			</span>
			<Check on={project.id === value} />
		</CommandItem>
	);

	return (
		<Filter
			label="Project"
			icon={
				selected === undefined ? (
					<SquaresFourIcon size={14} className="shrink-0 text-ink-muted" aria-hidden />
				) : (
					<Monogram id={selected.id} name={selected.name} />
				)
			}
			name={selected?.name ?? "All Projects"}
			open={open}
			onOpenChange={show}
			width="w-96"
		>
			<Command loop value={highlight} onValueChange={setHighlight}>
				<div className="relative">
					<CommandInput
						autoFocus
						value={search}
						onValueChange={setSearch}
						placeholder="Filter Projects…"
						aria-label="Filter Projects"
						spellCheck={false}
						className="h-9 pr-6 text-[13px]"
					/>
					<kbd className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded-[4px] border border-edge px-1 font-sans text-3xs text-ink-muted">
						P
					</kbd>
				</div>
				<CommandList className="max-h-80">
					<CommandEmpty className="px-3 py-6 text-center text-xs break-words text-ink-muted">
						No Projects Match “{search.trim()}”
					</CommandEmpty>
					<CommandGroup>
						<CommandItem value={ALL} onSelect={() => pick(null)} className={ROW}>
							<SquaresFourIcon className="size-4 text-ink-muted" aria-hidden />
							<span className="truncate">All Projects</span>
							<span
								title={`${formatCount(sessions)} Active Sessions`}
								className="ml-auto shrink-0 pl-2 text-xs text-ink-muted tabular-nums"
							>
								{formatCount(sessions)}
							</span>
							<Check on={value === null} />
						</CommandItem>
					</CommandGroup>
					{active.length > 0 && (
						<CommandGroup heading="Active" className={GROUP}>
							{active.map(({ project, prompts }) => row(project, prompts))}
						</CommandGroup>
					)}
					{idle.length > 0 && (
						<CommandGroup heading="No Activity" className={GROUP}>
							{idle.map(({ project }) => row(project, undefined))}
						</CommandGroup>
					)}
				</CommandList>
			</Command>
		</Filter>
	);
}

/** The page's machine scope: every machine, or one by name. */
export function MachineSelect({
	value,
	onChange,
	machines,
}: {
	readonly value: string | null;
	readonly onChange: (machineId: string | null) => void;
	readonly machines: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}) {
	const [open, setOpen] = useState(false);
	const sorted = machines.toSorted((a, b) => a.name.localeCompare(b.name));
	const selected = machines.find((machine) => machine.id === value);
	const pick = (machineId: string | null) => {
		onChange(machineId);
		setOpen(false);
	};
	return (
		<Filter
			label="Machine"
			icon={<DesktopIcon size={14} className="shrink-0 text-ink-muted" aria-hidden />}
			name={selected?.name ?? "All Machines"}
			open={open}
			onOpenChange={setOpen}
			width="w-64"
		>
			<Command loop defaultValue={selected === undefined ? ALL : valueOf(selected)}>
				<CommandList className="max-h-80">
					<CommandGroup>
						<CommandItem value={ALL} onSelect={() => pick(null)} className={ROW}>
							<span className="truncate">All Machines</span>
							<span className="ml-auto" />
							<Check on={value === null} />
						</CommandItem>
						{sorted.map((machine) => (
							<CommandItem
								key={machine.id}
								value={valueOf(machine)}
								onSelect={() => pick(machine.id)}
								className={ROW}
							>
								<span title={machine.name} className="truncate">
									{machine.name}
								</span>
								<span className="ml-auto" />
								<Check on={machine.id === value} />
							</CommandItem>
						))}
					</CommandGroup>
				</CommandList>
			</Command>
		</Filter>
	);
}
