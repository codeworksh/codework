import type { Priority, ThreadStatus } from "@codeworksh/contract";
import { ListFilter, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import type { ReactNode } from "react";

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
import { Input } from "@/components/ui/input";
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
				<span className="text-xs text-ink-muted tabular-nums">
					{count} {count === 1 ? "thread" : "threads"}
				</span>
				<div className="relative ml-auto w-40 min-w-0">
					<Search
						className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-muted"
						aria-hidden
					/>
					<Input
						value={options.text}
						onChange={(event) => onChange({ text: event.currentTarget.value })}
						onKeyDown={(event) => {
							if (event.key === "Escape") onChange({ text: "" });
						}}
						placeholder="Filter by Title"
						aria-label="Filter by Title"
						className="h-7 pl-7 text-xs"
					/>
				</div>
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
					<DropdownMenuContent align="end" className="w-48">
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>Status</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								{STATUSES.map((status) => (
									<DropdownMenuCheckboxItem
										key={status}
										checked={options.status.includes(status)}
										onSelect={(event) => event.preventDefault()}
										onCheckedChange={() => onChange({ status: toggled(options.status, status) })}
										className="gap-2"
									>
										<StatusIcon status={status} />
										{STATUS[status].label}
									</DropdownMenuCheckboxItem>
								))}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>Priority</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								{PRIORITIES.map((priority) => (
									<DropdownMenuCheckboxItem
										key={priority}
										checked={options.priority.includes(priority)}
										onSelect={(event) => event.preventDefault()}
										onCheckedChange={() => onChange({ priority: toggled(options.priority, priority) })}
										className="gap-2"
									>
										<PriorityIcon priority={priority} />
										{PRIORITY[priority].label}
									</DropdownMenuCheckboxItem>
								))}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>Machine</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								{machines.map((machine) => (
									<DropdownMenuCheckboxItem
										key={machine.id}
										checked={options.machine.includes(machine.id)}
										onSelect={(event) => event.preventDefault()}
										onCheckedChange={() => onChange({ machine: toggled(options.machine, machine.id) })}
										className="gap-2"
									>
										<MachineAvatar id={machine.id} name={machine.name} />
										{machine.name}
									</DropdownMenuCheckboxItem>
								))}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => onChange({ status: [], priority: [], machine: [], text: "" })}>
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
					<PopoverContent align="end" className="w-64 gap-3 p-3 text-xs">
						<Field label="Grouping">
							<Select
								value={options.group}
								onValueChange={(group) => {
									const next = GROUPS.find((candidate) => candidate.value === group);
									if (next !== undefined) onChange({ group: next.value });
								}}
							>
								<SelectTrigger size="sm" aria-label="Grouping" className="h-7 w-32 text-xs">
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
								<SelectTrigger size="sm" aria-label="Ordering" className="h-7 w-32 text-xs">
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
		<div className="flex items-center justify-between gap-2">
			<span className="text-ink-secondary">{label}</span>
			{children}
		</div>
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
