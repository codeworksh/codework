import {
	Activity,
	ArrowUpDown,
	Check,
	Clock,
	Flag,
	GripVertical,
	LayoutGrid,
	ListFilter,
	Minus,
	Plus,
	TagIcon,
	X,
} from "@/components/vuesax";
import type { Priority, ThreadStatus } from "@codeworksh/contract";
import type { ReactNode } from "react";

import { DisplayMenu } from "@/components/display";
import { marked, MenuChoice } from "@/components/menu";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MachineAvatar, PRIORITIES, PRIORITY, PriorityIcon, STATUS, STATUSES, StatusIcon } from "./marks";
import type { Options } from "./options";

const GROUPS: ReadonlyArray<{
	readonly value: Options["group"];
	readonly label: string;
	readonly icon: typeof Activity;
}> = [
	{ value: "status", label: "Status", icon: Activity },
	{ value: "priority", label: "Priority", icon: Flag },
	{ value: "grouping", label: "Group", icon: TagIcon },
	{ value: "none", label: "No Grouping", icon: Minus },
];
const ORDERS: ReadonlyArray<{
	readonly value: Options["order"];
	readonly label: string;
	readonly icon: typeof Activity;
}> = [
	{ value: "manual", label: "Manual", icon: GripVertical },
	{ value: "updated", label: "Last Updated", icon: Clock },
	{ value: "priority", label: "Priority", icon: Flag },
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
				<DisplayMenu>
					<MenuChoice
						label="Grouping"
						mark={<LayoutGrid aria-hidden />}
						value={options.group}
						current={GROUPS.find(({ value }) => value === options.group)?.label}
						options={marked(GROUPS)}
						onChange={(group) => onChange({ group })}
					/>
					<MenuChoice
						label="Ordering"
						mark={<ArrowUpDown aria-hidden />}
						value={options.order}
						current={ORDERS.find(({ value }) => value === options.order)?.label}
						options={marked(ORDERS)}
						onChange={(order) => onChange({ order })}
					/>
					<DropdownMenuSeparator />
					<DropdownMenuCheckboxItem
						className="py-1 text-[13px]"
						checked={options.empty}
						onCheckedChange={(empty) => onChange({ empty })}
						onSelect={(event) => event.preventDefault()}
					>
						Show Empty Groups
					</DropdownMenuCheckboxItem>
				</DisplayMenu>
			</div>
			<Chips options={options} onChange={onChange} machines={machines} />
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
