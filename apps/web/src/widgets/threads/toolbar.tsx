import { Check, ListFilter, Plus, SlidersHorizontal, X } from "@/components/vuesax";
import type { Priority, ThreadStatus } from "@codeworksh/contract";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { MachineAvatar, PRIORITIES, PRIORITY, PriorityIcon, STATUS, STATUSES, StatusIcon } from "./marks";
import type { Options } from "./options";

const GROUPS: ReadonlyArray<{ readonly value: Options["group"]; readonly label: string }> = [
	{ value: "status", label: "Status" },
	{ value: "priority", label: "Priority" },
	{ value: "grouping", label: "Group" },
	{ value: "none", label: "No Grouping" },
];
const ORDERS: ReadonlyArray<{ readonly value: Options["order"]; readonly label: string }> = [
	{ value: "manual", label: "Manual" },
	{ value: "updated", label: "Last Updated" },
	{ value: "priority", label: "Priority" },
];

const toggled = <A,>(values: ReadonlyArray<A>, value: A) =>
	values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value];

export function Toolbar({
	options,
	onChange,
	machines,
	count,
	onNewGroup,
}: {
	readonly options: Options;
	readonly onChange: (patch: Partial<Options>) => void;
	readonly machines: ReadonlyArray<{ readonly id: string; readonly name: string }>;
	readonly count: number;
	readonly onNewGroup: () => void;
}) {
	return (
		<div className="flex shrink-0 flex-col border-b border-edge">
			<div className="flex h-10 items-center gap-1.5 px-3">
				<span className="mr-auto text-xs text-ink-muted tabular-nums">
					{count} {count === 1 ? "thread" : "threads"}
				</span>
				{options.group === "grouping" && (
					<Button variant="ghost" size="xs" onClick={onNewGroup}>
						<Plus aria-hidden />
						New Group
					</Button>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon-xs" aria-label="Filter" title="Filter">
							<ListFilter aria-hidden />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-44">
						<DropdownMenuSub>
							<DropdownMenuSubTrigger className="text-xs">Status</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="min-w-44">
								{STATUSES.map((status) => (
									<FilterItem
										key={status}
										checked={options.status.includes(status)}
										onToggle={() => onChange({ status: toggled(options.status, status) })}
										mark={<StatusIcon status={status} />}
										label={STATUS[status].label}
									/>
								))}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger className="text-xs">Priority</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="min-w-44">
								{PRIORITIES.map((priority) => (
									<FilterItem
										key={priority}
										checked={options.priority.includes(priority)}
										onToggle={() => onChange({ priority: toggled(options.priority, priority) })}
										mark={<PriorityIcon priority={priority} />}
										label={PRIORITY[priority].label}
									/>
								))}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger className="text-xs">Machine</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="min-w-44">
								{machines.map((machine) => (
									<FilterItem
										key={machine.id}
										checked={options.machine.includes(machine.id)}
										onToggle={() => onChange({ machine: toggled(options.machine, machine.id) })}
										mark={<MachineAvatar id={machine.id} name={machine.name} />}
										label={machine.name}
									/>
								))}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							className="text-xs"
							onSelect={() => onChange({ status: [], priority: [], machine: [] })}
						>
							Clear Filters
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<Popover>
					<PopoverTrigger asChild>
						<Button variant="ghost" size="icon-xs" aria-label="Display Options" title="Display Options">
							<SlidersHorizontal aria-hidden />
						</Button>
					</PopoverTrigger>
					<PopoverContent align="end" className="grid w-60 gap-1.5 p-3">
						<Field label="Grouping">
							<Select
								value={options.group}
								onValueChange={(group) => {
									const next = GROUPS.find((candidate) => candidate.value === group);
									if (next !== undefined) onChange({ group: next.value });
								}}
							>
								<SelectTrigger
									size="sm"
									aria-label="Grouping"
									className="w-32 gap-1 border-transparent bg-ink/5 px-2 text-xs shadow-none hover:bg-ink/8 data-[size=sm]:h-7 dark:bg-ink/5 dark:hover:bg-ink/8 [&_svg:not([class*='size-'])]:size-3.5"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{GROUPS.map((group) => (
										<SelectItem key={group.value} value={group.value} className="text-xs">
											{group.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
						<Field label="Ordering">
							<Select
								value={options.order}
								onValueChange={(order) => {
									const next = ORDERS.find((candidate) => candidate.value === order);
									if (next !== undefined) onChange({ order: next.value });
								}}
							>
								<SelectTrigger
									size="sm"
									aria-label="Ordering"
									className="w-32 gap-1 border-transparent bg-ink/5 px-2 text-xs shadow-none hover:bg-ink/8 data-[size=sm]:h-7 dark:bg-ink/5 dark:hover:bg-ink/8 [&_svg:not([class*='size-'])]:size-3.5"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{ORDERS.map((order) => (
										<SelectItem key={order.value} value={order.value} className="text-xs">
											{order.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
						<Field label="Show Empty Groups">
							<Switch
								size="sm"
								aria-label="Show Empty Groups"
								checked={options.empty}
								onCheckedChange={(empty) => onChange({ empty })}
							/>
						</Field>
					</PopoverContent>
				</Popover>
			</div>
			<Chips options={options} onChange={onChange} machines={machines} />
		</div>
	);
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
	return (
		<div className="flex min-h-7 items-center justify-between gap-2">
			<span className="text-xs text-ink-secondary">{label}</span>
			{children}
		</div>
	);
}

/** A filter value: its mark and name, checked while it narrows the list; picking it keeps the menu open. */
function FilterItem({
	checked,
	onToggle,
	mark,
	label,
}: {
	readonly checked: boolean;
	readonly onToggle: () => void;
	readonly mark: ReactNode;
	readonly label: string;
}) {
	return (
		<DropdownMenuItem
			onSelect={(event) => {
				event.preventDefault();
				onToggle();
			}}
			aria-checked={checked}
			role="menuitemcheckbox"
			className="text-xs"
		>
			{mark}
			<span className="truncate">{label}</span>
			{checked && <Check className="ml-auto size-3.5" aria-hidden />}
		</DropdownMenuItem>
	);
}

/** The active filters, one chip per kind, each cleared on its own. */
function Chips({
	options,
	onChange,
	machines,
}: {
	readonly options: Options;
	readonly onChange: (patch: Partial<Options>) => void;
	readonly machines: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}) {
	const chips: Array<{ key: string; label: string; values: string; clear: Partial<Options> }> = [];
	const named = (values: ReadonlyArray<ThreadStatus>) => values.map((status) => STATUS[status].label).join(", ");
	const ranked = (values: ReadonlyArray<Priority>) => values.map((priority) => PRIORITY[priority].label).join(", ");
	if (options.status.length > 0)
		chips.push({ key: "status", label: "Status", values: named(options.status), clear: { status: [] } });
	if (options.priority.length > 0)
		chips.push({ key: "priority", label: "Priority", values: ranked(options.priority), clear: { priority: [] } });
	if (options.machine.length > 0)
		chips.push({
			key: "machine",
			label: "Machine",
			values: options.machine.map((id) => machines.find((machine) => machine.id === id)?.name ?? id).join(", "),
			clear: { machine: [] },
		});
	if (chips.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1.5 px-3 pb-2">
			{chips.map((chip) => (
				<span
					key={chip.key}
					className="flex h-6 items-center gap-1 rounded-md border border-edge pl-2 text-2xs text-ink-secondary"
				>
					<span className="text-ink-muted">{chip.label} is</span>
					<span className="max-w-48 truncate">{chip.values}</span>
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={`Clear ${chip.label} filter`}
						onClick={() => onChange(chip.clear)}
						className="size-5"
					>
						<X aria-hidden />
					</Button>
				</span>
			))}
		</div>
	);
}
