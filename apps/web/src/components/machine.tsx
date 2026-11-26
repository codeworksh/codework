import type { RemoteServerStatus, ServerStatus } from "@codeworksh/contract";
import type { Relay } from "@codeworksh/schema";
import { useAtomValue } from "@effect/atom-react";
import {
	CaretDownIcon,
	CaretRightIcon,
	CheckIcon,
	DesktopIcon,
	GearSixIcon,
	HardDrivesIcon,
	LaptopIcon,
	MagnifyingGlassIcon,
	PlusIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { Command as CommandPrimitive } from "cmdk";
import { AsyncResult, Atom } from "effect/reactivity";
import { type ReactNode, type Ref, useRef, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useNowMinute } from "@/hooks/now";
import { machinesAtom } from "../kernel/relay";
import { serversAtom } from "../kernel/servers";
import { useWorkspace } from "../settings/machines/shared";
import { machineAtom } from "../landing/place";
import { useMachineAtom } from "../shell/connect";
import { projectsAtom } from "../widgets/session/projects";
import { ago } from "../widgets/time";

/** Whether a session can start on a machine now, else what stops it. */
type Availability =
	| { readonly kind: "ready" }
	| { readonly kind: "stopped" }
	| { readonly kind: "offline"; readonly seenAt: number | null }
	| { readonly kind: "unpaired" }
	| { readonly kind: "mismatch"; readonly what: "machine" | "clock" }
	| { readonly kind: "relay" };

/** A machine as the picker lists it. `id` is its server row's, or `relay:<id>` for one only the workspace lists. */
export interface MachineEntry {
	readonly id: string;
	readonly name: string;
	readonly host: string | null;
	readonly os: string | null;
	readonly relation: "local" | "paired" | "linked";
	readonly isDefault: boolean;
	readonly inWorkspace: boolean;
	readonly availability: Availability;
	readonly rtt: number | null;
}

const RECENT = 3;
// Long enough to cross a neighbouring row on the way to the open submenu.
const SWITCH_DELAY = 150;
// A row is h-7; the submenu adds its padding and border, and lists at most this much before scrolling.
const ROW_HEIGHT = 28;
const SUB_CHROME = 10;
const SUB_LIST = 288;
const EDGE = 8;

const isReady = (machine: MachineEntry) => machine.availability.kind === "ready";

// Signed out, there is no workspace to ask Relay about.
const noLinked: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<Relay.Machine>, unknown>> = Atom.make(
	AsyncResult.success([]),
);

export const availabilityOf = (status: ServerStatus): Availability => {
	if (status.kind === "local") return status.server._tag === "Running" ? { kind: "ready" } : { kind: "stopped" };
	if (!status.paired) return { kind: "unpaired" };
	if (status.mismatch !== null) return { kind: "mismatch", what: status.mismatch.kind };
	return status.online ? { kind: "ready" } : { kind: "offline", seenAt: status.seenAt };
};

/** The name of the machine with this row id; undefined until the app server has listed it. */
export function useMachineName(machineId: string) {
	const servers = useAtomValue(serversAtom);
	if (!AsyncResult.isSuccess(servers)) return undefined;
	return servers.value.find((candidate) => candidate.id === machineId)?.name;
}

/** The row id host calls name `machineId` by: none is the default machine's. */
export function useRowId(machineId: string | undefined) {
	const servers = useAtomValue(serversAtom);
	if (machineId !== undefined) return machineId;
	return AsyncResult.isSuccess(servers) ? servers.value.find((status) => status.isDefault)?.id : undefined;
}

const holds = (status: RemoteServerStatus, workspaceId: string) =>
	status.workspaces.some((link) => link.id === workspaceId && link.leaving !== true);

/**
 * Every machine the app knows, in the picker's sections: this computer's servers, the machines
 * sessions started on lately, the workspace's, and the paired ones. A workspace machine this
 * computer is paired with is listed as paired; one it is not paired with can only be paired.
 */
function useMachines() {
	const servers = useAtomValue(serversAtom);
	const projects = useAtomValue(projectsAtom);
	const { workspace } = useWorkspace();
	const linked = useAtomValue(workspace === undefined ? noLinked : machinesAtom(workspace.id));
	const local = useAtomValue(useMachineAtom());
	const statuses = AsyncResult.isSuccess(servers) ? servers.value : [];
	// Relay's list is the membership; the link a host keeps is only its last word, until Relay answers.
	const members = AsyncResult.isSuccess(linked) ? new Set(linked.value.map((machine) => machine.id)) : undefined;
	const inWorkspace = (status: ServerStatus) =>
		workspace !== undefined &&
		status.kind === "remote" &&
		(members === undefined
			? holds(status, workspace.id)
			: status.machineId !== null && members.has(status.machineId));

	const entries: Array<MachineEntry> = statuses.map((status) => ({
		id: status.id,
		name: status.name,
		host: status.host,
		os: null,
		relation: status.kind === "local" ? "local" : "paired",
		isDefault: status.isDefault,
		inWorkspace: inWorkspace(status),
		availability: availabilityOf(status),
		rtt: status.rtt,
	}));
	const pairedIds = new Set(
		statuses.flatMap((status) => (status.kind === "remote" && status.machineId !== null ? [status.machineId] : [])),
	);
	const localId = AsyncResult.isSuccess(local) ? local.value.id : null;
	const relayOnly: ReadonlyArray<Relay.Machine> =
		workspace !== undefined && AsyncResult.isSuccess(linked)
			? linked.value.filter((machine) => machine.id !== localId && !pairedIds.has(machine.id))
			: [];
	for (const machine of relayOnly)
		entries.push({
			id: `relay:${machine.id}`,
			name: machine.givenName ?? machine.localHostName,
			host: machine.localHostName,
			os: machine.os,
			relation: "linked",
			isDefault: false,
			inWorkspace: true,
			availability: { kind: "relay" },
			rtt: null,
		});

	// The machines of the newest sessions, this computer's own default left out: it is always first.
	const lastActive = new Map<string, number>();
	if (AsyncResult.isSuccess(projects))
		for (const project of projects.value)
			for (const session of project.sessions)
				lastActive.set(project.machine.id, Math.max(lastActive.get(project.machine.id) ?? 0, session.updated));
	const recent = entries
		.filter((entry) => !entry.isDefault && lastActive.has(entry.id))
		.toSorted((a, b) => (lastActive.get(b.id) ?? 0) - (lastActive.get(a.id) ?? 0))
		.slice(0, RECENT);

	return {
		entries,
		workspaceName: workspace?.name,
		local: entries.filter((entry) => entry.relation === "local"),
		recent,
		workspace: entries.filter((entry) => entry.relation !== "local" && entry.inWorkspace),
		paired: entries.filter((entry) => entry.relation === "paired"),
		defaultEntry: entries.find((entry) => entry.isDefault),
	};
}

export type Machines = ReturnType<typeof useMachines>;

/** The machine a selection names while a session can start on it, else the default one. */
const resolveMachine = (machines: Machines, selected: string | undefined) => {
	const found = machines.entries.find((entry) => entry.id === selected);
	return found !== undefined && isReady(found) ? found : machines.defaultEntry;
};

/**
 * The start page's machine: the one picked while a session can start on it, else the default.
 * `machineId` is what host calls name: none for the default machine.
 */
export function useStartMachine() {
	const machines = useMachines();
	const machine = resolveMachine(machines, useAtomValue(machineAtom));
	return { machines, machine, machineId: machine === undefined || machine.isDefault ? undefined : machine.id };
}

/** What keeps a machine from being picked, in a few words. */
export function useReason(machine: Pick<MachineEntry, "availability">) {
	const now = useNowMinute();
	const a = machine.availability;
	switch (a.kind) {
		case "ready":
			return null;
		case "stopped":
			return "Not Running";
		case "offline": {
			if (a.seenAt === null) return "Never Seen";
			const since = ago(a.seenAt, now);
			return since === "now" ? "Offline" : `Offline · ${since} ago`;
		}
		case "unpaired":
			return "Pair Again";
		case "mismatch":
			return a.what === "clock" ? "Clock Differs" : "Different Machine";
		case "relay":
			return "Not Paired";
	}
}

/** Where a machine that can't be picked is fixed; none for one that is only away. */
const fixOf = (machine: MachineEntry) => {
	switch (machine.availability.kind) {
		case "ready":
		case "offline":
		case "stopped":
			return null;
		case "relay":
			return { label: "Pair This Machine", page: undefined } as const;
		case "unpaired":
		case "mismatch":
			return { label: "Open Machine Settings", page: machine.id } as const;
	}
};

// This computer, when Relay has not said otherwise, is the laptop it most often is.
function MachineIcon({
	machine,
	className = "size-3.5",
}: {
	readonly machine: MachineEntry;
	readonly className?: string;
}) {
	const classes = `shrink-0 ${className}`;
	if (machine.os === "darwin" || (machine.relation === "local" && machine.os === null))
		return <LaptopIcon className={classes} aria-hidden />;
	if (machine.os === "win32") return <DesktopIcon className={classes} aria-hidden />;
	return <HardDrivesIcon className={classes} aria-hidden />;
}

/** A quiet selector above the composer: no fill until hovered or open. */
export const headerTrigger =
	"group flex h-7 min-w-0 max-w-64 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui text-ink-muted transition-[transform,background-color,color] duration-150 ease-out outline-none hover:bg-selection hover:text-ink focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] data-[state=open]:bg-selection data-[state=open]:text-ink";

const panel = "rounded-xl border-ink/10 bg-popover/95 p-0 shadow-(--cw-menu-shadow) backdrop-blur-xl";
const heading =
	"**:[[cmdk-group-heading]]:truncate **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:pt-2 **:[[cmdk-group-heading]]:pb-0.5 **:[[cmdk-group-heading]]:text-3xs **:[[cmdk-group-heading]]:text-ink-muted";
const row =
	"flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-[12px] text-ink outline-none select-none data-[disabled=true]:text-ink-muted/50 data-[selected=true]:bg-selection";

const matches = (machine: MachineEntry, needle: string) =>
	needle === "" || `${machine.name} ${machine.host ?? ""} ${machine.os ?? ""}`.toLowerCase().includes(needle);

type Section = "workspace" | "paired";

function MachineItem({
	machine,
	current,
	itemValue,
	onSelect,
	onPointerEnter,
}: {
	readonly machine: MachineEntry;
	readonly current: boolean;
	/** cmdk's key for the row; a machine listed twice needs two. */
	readonly itemValue: string;
	readonly onSelect: () => void;
	readonly onPointerEnter?: () => void;
}) {
	const ready = isReady(machine);
	const reason = useReason(machine);
	const fix = fixOf(machine);
	return (
		<CommandPrimitive.Item
			value={itemValue}
			disabled={!ready && fix === null}
			onSelect={onSelect}
			{...(onPointerEnter === undefined ? {} : { onPointerEnter })}
			title={fix?.label ?? machine.host ?? undefined}
			className={row}
		>
			<MachineIcon machine={machine} className="size-3.5 text-ink-muted" />
			<span className={`min-w-0 flex-1 truncate ${ready ? "" : "text-ink-muted"}`}>{machine.name}</span>
			{reason !== null && <span className="shrink-0 text-2xs text-ink-muted tabular-nums">{reason}</span>}
			{/* This computer's own is always about nothing; a paired machine's says how far away it is. */}
			{ready && machine.relation !== "local" && machine.rtt !== null && (
				<span className="shrink-0 text-2xs text-ink-muted tabular-nums" title="Round trip at the last check">
					{machine.rtt} ms
				</span>
			)}
			{current && <CheckIcon weight="bold" className="size-3 shrink-0 text-ink-muted" aria-hidden />}
		</CommandPrimitive.Item>
	);
}

/** A row that opens a section: its name, how many machines it holds, and a caret. */
function SectionItem({
	section,
	title,
	count,
	open,
	onSelect,
	onPointerEnter,
	itemRef,
}: {
	readonly section: Section;
	readonly title: string;
	readonly count: number;
	readonly open: boolean;
	readonly onSelect: () => void;
	readonly onPointerEnter: () => void;
	readonly itemRef: Ref<HTMLDivElement>;
}) {
	return (
		<CommandPrimitive.Item
			ref={itemRef}
			value={`section:${section}`}
			onSelect={onSelect}
			onPointerEnter={onPointerEnter}
			data-open={open ? "" : undefined}
			className={`${row} data-open:bg-selection`}
		>
			<span className="min-w-0 flex-1 truncate">{title}</span>
			<span className="shrink-0 text-2xs text-ink-muted tabular-nums">{count}</span>
			<CaretRightIcon weight="bold" className="size-2.5 shrink-0 text-ink-muted" aria-hidden />
		</CommandPrimitive.Item>
	);
}

function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
	return (
		<CommandPrimitive.Group heading={title} className={heading}>
			{children}
		</CommandPrimitive.Group>
	);
}

/**
 * Picks the machine a new session starts on: a search, this computer, the recent machines, then
 * the workspace's and the paired ones each in a submenu beside their row. A machine that can't run
 * a session is listed with the reason; choosing it opens what fixes it, when something does.
 */
export function MachinePicker({
	machines,
	value,
	onChange,
}: {
	readonly machines: Machines;
	readonly value: MachineEntry;
	readonly onChange: (machine: MachineEntry) => void;
}) {
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState("");
	const [sub, setSub] = useState<{ section: Section; top: number; height: number } | null>(null);
	const content = useRef<HTMLDivElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const subInput = useRef<HTMLInputElement>(null);
	const rows = useRef<Partial<Record<Section, HTMLDivElement | null>>>({});
	const timer = useRef<number>(undefined);

	const needle = query.trim().toLowerCase();
	const sections = [
		{
			section: "workspace" as const,
			title: `In ${machines.workspaceName ?? "Workspace"}`,
			items: machines.workspace,
		},
		{ section: "paired" as const, title: "Paired", items: machines.paired },
	].filter((each) => each.items.length > 0);
	const shown = sections.find((each) => each.section === sub?.section);

	const close = () => {
		setOpen(false);
		setQuery("");
		setSub(null);
	};
	const pick = (machine: MachineEntry) => {
		const fix = fixOf(machine);
		if (isReady(machine)) onChange(machine);
		else if (fix !== null)
			void (fix.page === undefined
				? navigate({ to: "/settings/machines" })
				: navigate({ to: "/settings/machines/$id", params: { id: fix.page } }));
		else return;
		close();
	};
	const openSub = (section: Section, focus: boolean) => {
		window.clearTimeout(timer.current);
		const at = rows.current[section];
		const box = content.current?.getBoundingClientRect();
		const count = sections.find((each) => each.section === section)?.items.length ?? 0;
		if (at === null || at === undefined || box === undefined) return;
		// Its first row lines up with the row that opened it: up by its padding and border. One that
		// would run past the window moves up, and scrolls once taller than the window itself.
		const top = at.getBoundingClientRect().top - SUB_CHROME / 2;
		const height = Math.min(count * ROW_HEIGHT, SUB_LIST, window.innerHeight - 2 * EDGE - SUB_CHROME);
		const over = Math.max(0, top + height + SUB_CHROME - (window.innerHeight - EDGE));
		setSub({ section, top: top - over - box.top, height });
		if (focus) requestAnimationFrame(() => subInput.current?.focus());
	};
	// Hovering moves the submenu only once the pointer settles, so a diagonal path keeps it.
	const hover = (section: Section | null) => {
		window.clearTimeout(timer.current);
		if (section !== null && sub === null) return openSub(section, false);
		timer.current = window.setTimeout(
			() => (section === null ? setSub(null) : openSub(section, false)),
			SWITCH_DELAY,
		);
	};
	const back = () => {
		setSub(null);
		search.current?.focus();
	};

	// While searching: every match once, under where it lives.
	const inWorkspace = new Set(machines.workspace.map((machine) => machine.id));
	const results: ReadonlyArray<readonly [string, ReadonlyArray<MachineEntry>]> = [
		["This Machine", machines.local],
		[`In ${machines.workspaceName ?? "Workspace"}`, machines.workspace],
		["Paired", machines.paired.filter((machine) => !inWorkspace.has(machine.id))],
	];

	const button =
		"flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-ink-muted transition-colors duration-150 ease-out outline-none hover:bg-selection hover:text-ink focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]";

	return (
		<Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
			<PopoverTrigger className={headerTrigger} title={value.host ?? value.name}>
				<MachineIcon machine={value} />
				<span className="truncate">{value.name}</span>
				<span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
				<CaretDownIcon
					className="size-3 shrink-0 text-ink-muted transition-transform duration-150 ease-out group-data-[state=open]:rotate-180"
					aria-hidden
				/>
			</PopoverTrigger>
			<PopoverContent
				ref={content}
				align="start"
				collisionPadding={8}
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					search.current?.focus();
				}}
				onEscapeKeyDown={(event) => {
					if (sub === null) return;
					event.preventDefault();
					back();
				}}
				className={`${panel} w-60 overflow-visible`}
			>
				<CommandPrimitive
					shouldFilter={false}
					value={active}
					onValueChange={setActive}
					onKeyDown={(event) => {
						if (event.key !== "ArrowRight" || !active.startsWith("section:")) return;
						event.preventDefault();
						openSub(active.slice("section:".length) as Section, true);
					}}
					className="flex flex-col"
				>
					<div className="flex h-8 shrink-0 items-center gap-2 border-b border-edge px-2.5 text-ink-muted">
						<MagnifyingGlassIcon className="size-3.5 shrink-0" aria-hidden />
						<CommandPrimitive.Input
							ref={search}
							value={query}
							onValueChange={(next) => {
								setQuery(next);
								setSub(null);
							}}
							placeholder="Search machines"
							className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-muted/70"
						/>
					</div>
					<CommandPrimitive.List className="max-h-80 overflow-y-auto p-1 scrollbar-thin">
						<CommandPrimitive.Empty className="px-2 py-3 text-[12px] text-ink-muted">
							No Machines Match
						</CommandPrimitive.Empty>
						{needle !== "" ? (
							results.map(([title, list]) => {
								const found = list.filter((machine) => matches(machine, needle));
								return found.length === 0 ? null : (
									<Group key={title} title={title}>
										{found.map((machine) => (
											<MachineItem
												key={`${title}:${machine.id}`}
												itemValue={`${title}:${machine.id}`}
												machine={machine}
												current={machine.id === value.id}
												onSelect={() => pick(machine)}
											/>
										))}
									</Group>
								);
							})
						) : (
							<>
								<Group title="This Machine">
									{machines.local.map((machine) => (
										<MachineItem
											key={`local:${machine.id}`}
											itemValue={`local:${machine.id}`}
											machine={machine}
											current={machine.id === value.id}
											onSelect={() => pick(machine)}
											onPointerEnter={() => hover(null)}
										/>
									))}
								</Group>
								{machines.recent.length > 0 && (
									<Group title="Recent">
										{machines.recent.map((machine) => (
											<MachineItem
												key={`recent:${machine.id}`}
												itemValue={`recent:${machine.id}`}
												machine={machine}
												current={machine.id === value.id}
												onSelect={() => pick(machine)}
												onPointerEnter={() => hover(null)}
											/>
										))}
									</Group>
								)}
								{sections.length > 0 && (
									<CommandPrimitive.Group className="mt-1 border-t border-edge pt-1">
										{sections.map((each) => (
											<SectionItem
												key={each.section}
												itemRef={(node) => {
													rows.current[each.section] = node;
												}}
												section={each.section}
												title={each.title}
												count={each.items.length}
												open={sub?.section === each.section}
												onSelect={() => openSub(each.section, true)}
												onPointerEnter={() => hover(each.section)}
											/>
										))}
									</CommandPrimitive.Group>
								)}
							</>
						)}
					</CommandPrimitive.List>
				</CommandPrimitive>
				{/* Outside cmdk's root, which would turn Enter on these into the highlighted row's. */}
				<div className="flex items-center gap-1 border-t border-edge p-1">
					<button
						type="button"
						onClick={() => {
							close();
							void navigate({ to: "/settings/machines" });
						}}
						className={`${button} flex-1`}
					>
						<PlusIcon className="size-3.5" aria-hidden />
						Pair a Machine
					</button>
					<button
						type="button"
						aria-label="Manage Machines"
						title="Manage Machines"
						onClick={() => {
							close();
							void navigate({ to: "/settings/machines" });
						}}
						className={`${button} w-7 justify-center px-0`}
					>
						<GearSixIcon className="size-3.5" aria-hidden />
					</button>
				</div>
				{sub !== null && shown !== undefined && (
					<div
						onPointerEnter={() => window.clearTimeout(timer.current)}
						style={{ top: sub.top }}
						className={`${panel} absolute left-full ml-1 w-56 overflow-hidden border`}
					>
						<CommandPrimitive
							key={sub.section}
							onKeyDown={(event) => {
								if (event.key !== "ArrowLeft") return;
								event.preventDefault();
								back();
							}}
						>
							{/* Holds focus for cmdk's arrow keys; the main search does the searching. */}
							<CommandPrimitive.Input ref={subInput} className="sr-only" aria-label={shown.title} />
							<CommandPrimitive.List
								style={{ maxHeight: sub.height + SUB_CHROME - 2 }}
								className="overflow-y-auto p-1 scrollbar-thin"
							>
								{shown.items.map((machine) => (
									<MachineItem
										key={machine.id}
										itemValue={machine.id}
										machine={machine}
										current={machine.id === value.id}
										onSelect={() => pick(machine)}
									/>
								))}
							</CommandPrimitive.List>
						</CommandPrimitive>
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}
