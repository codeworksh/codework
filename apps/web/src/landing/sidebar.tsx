import {
	ArrowsDownUpIcon,
	CaretRightIcon,
	ChartBarIcon,
	ChatsIcon,
	FolderIcon,
	FolderOpenIcon,
	MagnifyingGlassIcon,
	NotePencilIcon,
	PlusIcon,
	SquaresFourIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { SidebarProject, SidebarSession } from "@codeworksh/contract";
import { type MouseEvent, memo, useCallback, useLayoutEffect, useRef, useState } from "react";

import { DisplayMenu } from "@/components/display";
import { marked, MenuChoice } from "@/components/menu";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarHeader,
	SidebarInput,
	SidebarRail,
} from "@/components/ui/sidebar";
import { ConnectionStatus } from "../shell/status";
import { isMac, openMode } from "@codeworksh/widget/view";
import { sessionAddress, threadRef } from "../widgets/session/address";
import { projectsAtom } from "../widgets/session/projects";
import { focusedAtom } from "../wm/chrome";
import { deskAtom } from "../wm/instances";
import { useTabs, tabTag } from "../wm/tabs";
import { useOpenElsewhere } from "../wm/open";
import { Ago } from "../widgets/time";
import { OpenMachineSettings } from "@/components/offline";
import { WorkspaceSwitcher } from "../shell/workspace";
import { ProviderIcon } from "@/components/provider";
import { problemAtom, serversAtom } from "../kernel/servers";
import { Empty, EmptyAction } from "./empty";
import { useAddProject } from "../shell/palette";
import { machineAtom, placeAtom } from "./place";
import { useRunDisplay } from "../widgets/session/display";
import { RunMark } from "../widgets/session/run";
import { PriorityIcon, StatusIcon } from "../widgets/threads/marks";
import { type Entry, GROUPS, type Group, groupLabel, groupsOf, ORDERS, useDisplay } from "./groups";

/**
 * Recent sessions across every project, newest first, beside every page. With none yet it invites
 * adding a project: the folder the start page's composer then works in.
 */
/** A sidebar action: New, Threads. Each sets its own colour: New, the primary action, is full ink. */
const NAV_ROW =
	"flex h-7 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-ui font-medium outline-none hover:bg-selection-subtle hover:text-ink active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

const collapsedKey = "codework.sidebar.collapsed";
const decodeCollapsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));

function savedCollapsed(): ReadonlySet<string> {
	try {
		return new Set(Option.getOrElse(decodeCollapsed(localStorage.getItem(collapsedKey)), () => []));
	} catch {
		// Storage can be unavailable; every project starts expanded.
		return new Set();
	}
}

export function SessionsSidebar() {
	const result = useAtomValue(projectsAtom);
	const problem = useAtomValue(problemAtom);
	const [query, setQuery] = useState("");
	const search = useRef<HTMLInputElement>(null);
	const openElsewhere = useOpenElsewhere();
	const [place, setPlace] = useAtom(placeAtom);
	const setMachine = useAtomSet(machineAtom);
	const servers = useAtomValue(serversAtom);
	const defaultId = AsyncResult.isSuccess(servers) ? servers.value.find((server) => server.isDefault)?.id : undefined;
	// The start page on a project's machine and folder; the default machine is named by no id, as everywhere.
	// A project only in sandboxes has no folder there to start in, so only its machine carries over.
	const startOn = useCallback(
		(project: Pick<SidebarProject, "path" | "name" | "onHost" | "machine">) => {
			setMachine(project.machine.id === defaultId ? undefined : project.machine.id);
			setPlace(
				project.onHost
					? { kind: "folder", path: project.path, name: project.name, machineId: project.machine.id }
					: { kind: "none" },
			);
		},
		[defaultId, setMachine, setPlace],
	);
	const addProject = useAddProject();
	const navigate = useNavigate();
	// The session in front on the tab on screen reads as current; the others it shows, as open.
	const { tabId } = useParams({ strict: false });
	const { instances, order } = useAtomValue(deskAtom);
	const focusedOn = useAtomValue(focusedAtom);
	const tab = useTabs().find((candidate) => candidate.id === tabId);
	const focusedId = tab === undefined ? undefined : focusedOn.get(tab.id);
	// A frame in front that is not a session's (Git Changes, shared by a space's sessions) leaves the
	// session last in front on the tab as current: the user is still working in it.
	// The tab's session frames, by frame id, read once: the lookups below stay linear in the desk.
	const sessionFrames = new Map<string, string>();
	if (tab !== undefined)
		for (const instance of instances) {
			const sessionId = (instance.tags & tabTag(tab)) === 0 ? undefined : threadRef(instance.address)?.sessionId;
			if (sessionId !== undefined) sessionFrames.set(instance.id, sessionId);
		}
	const current =
		(focusedId === undefined ? undefined : sessionFrames.get(focusedId)) ??
		sessionFrames.get(order.focusOrder.find((id) => sessionFrames.has(id)) ?? "");
	const shown = new Set(sessionFrames.values());
	// A new session starts on the start page, in the current session's project when one is in front.
	const startNew = () => {
		const project = AsyncResult.isSuccess(result)
			? result.value.find((candidate) => candidate.sessions.some(({ id }) => id === current))
			: undefined;
		// The folder is on the project's machine, so the start page moves to that machine too.
		if (project !== undefined) startOn(project);
		void navigate({ to: "/" });
	};
	// Primary and middle clicks open; a right click is left to the context menu. Shift, like a
	// browser's new window, asks for a tab of its own.
	// Read through a ref, so rows keep one handler and skip re-rendering when the desk changes.
	const opener = useRef(openElsewhere);
	useLayoutEffect(() => {
		opener.current = openElsewhere;
	});
	const open = useCallback((sessionId: string, projectName: string, event: MouseEvent) => {
		if (event.button > 1) return;
		const placement = event.shiftKey ? "tab" : openMode(event);
		void opener.current(sessionAddress(sessionId), projectName, placement);
	}, []);

	// Kept in this window's storage, so projects reopen as left, after a restart too.
	const [collapsed, setCollapsed] = useState(savedCollapsed);
	const toggle = useCallback((key: string) => {
		setCollapsed((previous) => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			try {
				localStorage.setItem(collapsedKey, JSON.stringify([...next]));
			} catch {
				// The state still applies until the page closes.
			}
			return next;
		});
	}, []);
	const startIn = useCallback(
		(project: Parameters<typeof startOn>[0]) => {
			startOn(project);
			void navigate({ to: "/" });
		},
		[navigate, startOn],
	);

	const [display, changeDisplay] = useDisplay();
	const needle = query.trim().toLowerCase();
	const groups = AsyncResult.isSuccess(result) ? groupsOf(result.value, display, needle) : [];

	return (
		<Sidebar collapsible="offcanvas" className="shell-sidebar select-none">
			<SidebarHeader className="gap-1 px-2 pt-2 pb-3">
				<WorkspaceSwitcher />
				<button type="button" onClick={startNew} className={`${NAV_ROW} text-ink`}>
					<NotePencilIcon size={15} className="shrink-0" aria-hidden />
					<span>New</span>
				</button>
				<div className="relative">
					<MagnifyingGlassIcon
						size={15}
						className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-muted"
						aria-hidden
					/>
					<SidebarInput
						ref={search}
						type="search"
						placeholder="Search"
						aria-label="Search threads"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape" && query !== "") {
								event.preventDefault();
								setQuery("");
							}
						}}
						className="h-7 rounded-lg border-0 bg-transparent pr-7 pl-9 text-ui font-medium shadow-none dark:bg-transparent placeholder:text-ink-muted not-placeholder-shown:bg-selection-subtle hover:bg-selection-subtle focus-visible:bg-selection-subtle focus-visible:ring-1 focus-visible:ring-edge focus-visible:ring-inset [&::-webkit-search-cancel-button]:appearance-none"
					/>
					{query !== "" && (
						<button
							type="button"
							aria-label="Clear search"
							title="Clear search (Esc)"
							onClick={() => {
								setQuery("");
								search.current?.focus();
							}}
							className="absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded-md text-ink-muted outline-none hover:bg-ink/8 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring"
						>
							<XIcon className="size-3.5" aria-hidden />
						</button>
					)}
				</div>
				<Link
					to="/threads"
					className={`${NAV_ROW} text-ink-muted aria-[current=page]:bg-selection-current aria-[current=page]:text-ink aria-[current=page]:[&>svg]:text-ink`}
				>
					<ChatsIcon size={15} className="shrink-0 text-ink-muted" aria-hidden />
					<span>Threads</span>
				</Link>
			</SidebarHeader>
			<SidebarContent className="gap-0 px-2 pb-2">
				{problem !== undefined ? (
					<OpenMachineSettings
						problem={problem}
						className="w-full font-normal text-ink-muted hover:bg-ink/5 hover:text-ink focus-visible:bg-ink/5"
					/>
				) : AsyncResult.isFailure(result) ? (
					<p className="px-2 py-2 text-xs text-ink-muted">Could Not Load Sessions</p>
				) : AsyncResult.isSuccess(result) && groups.length === 0 ? (
					needle !== "" ? (
						<p className="px-2 py-2 text-xs text-ink-muted">No Threads Match “{query}”</p>
					) : (
						<Empty>
							{place.kind === "none" && result.value.length === 0 ? (
								<>
									<span>No Projects Yet</span>
									<EmptyAction
										icon={<PlusIcon size={12} weight="bold" className="-mx-0.5 size-3" aria-hidden />}
										onClick={addProject}
									>
										Add project
									</EmptyAction>
								</>
							) : (
								<span>No Threads Yet</span>
							)}
						</Empty>
					)
				) : (
					<div aria-label="Threads" className="flex flex-col gap-1">
						<div className="flex h-6 items-center justify-between pr-1 pl-2">
							<span className="text-2xs font-medium text-ink-muted">Threads</span>
							<DisplayMenu align="start" side="right" triggerClassName="size-5 text-ink-muted">
								<MenuChoice
									label="Grouping"
									mark={<SquaresFourIcon aria-hidden />}
									value={display.group}
									current={GROUPS.find(({ value }) => value === display.group)?.label}
									options={marked(GROUPS)}
									onChange={(group) => changeDisplay({ group })}
								/>
								<MenuChoice
									label="Ordering"
									mark={<ArrowsDownUpIcon aria-hidden />}
									value={display.order}
									current={ORDERS.find(({ value }) => value === display.order)?.label}
									options={marked(ORDERS)}
									onChange={(order) => changeDisplay({ order })}
								/>
							</DisplayMenu>
						</div>
						{groups.map((group) => (
							<GroupSection
								key={group.key}
								group={group}
								expanded={needle !== "" || !collapsed.has(group.key)}
								current={current}
								shown={shown}
								onToggle={() => toggle(group.key)}
								onStartNew={group.kind === "project" ? () => startIn(group.project) : undefined}
								onOpen={open}
							/>
						))}
					</div>
				)}
			</SidebarContent>
			<SidebarFooter className="flex-row items-center gap-0.5 p-2">
				<ConnectionStatus />
				<Link
					to="/metrics"
					aria-label="Metrics"
					title="Metrics"
					className="active:scale-[0.97] ml-auto grid size-7 shrink-0 place-items-center rounded-md text-ink-muted outline-none hover:bg-selection-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-selection-current aria-[current=page]:text-ink"
				>
					<ChartBarIcon size={15} aria-hidden />
				</Link>
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
}

/** What a group's header shows: a project's folder, open while expanded, a status's ring or a priority's bars. */
function GroupMark({ group, expanded }: { readonly group: Group; readonly expanded: boolean }) {
	if (group.kind === "status") return <StatusIcon status={group.status} />;
	if (group.kind === "priority") return <PriorityIcon priority={group.priority} />;
	return expanded ? <FolderOpenIcon size={14} aria-hidden /> : <FolderIcon size={14} aria-hidden />;
}

function GroupSection({
	group,
	expanded,
	current,
	shown,
	onToggle,
	onStartNew,
	onOpen,
}: {
	readonly group: Group;
	readonly expanded: boolean;
	/** The session id in front on the tab on screen. */
	readonly current: string | undefined;
	/** Every session id the tab on screen shows. */
	readonly shown: ReadonlySet<string>;
	readonly onToggle: () => void;
	/** A project's new thread; other groups have none. */
	readonly onStartNew: (() => void) | undefined;
	readonly onOpen: (sessionId: string, projectName: string, event: MouseEvent) => void;
}) {
	const label = groupLabel(group);
	const open = expanded ? undefined : group.entries.find(({ session }) => session.id === current);
	const row = ({ session, project }: Entry) => (
		<SessionRow
			key={session.id}
			session={session}
			projectName={project.name}
			machineName={project.machine.name}
			state={session.id === current ? "current" : shown.has(session.id) ? "shown" : undefined}
			onOpen={onOpen}
		/>
	);
	return (
		<section className="flex flex-col">
			<div className="group/project relative flex h-[26px] items-center">
				<button
					type="button"
					aria-expanded={expanded}
					title={group.kind === "project" ? `${group.project.path} on ${group.project.machine.name}` : undefined}
					onClick={onToggle}
					className={`group/toggle flex h-[26px] w-full min-w-0 items-center gap-2 rounded-md pl-2 text-left text-xs text-ink-muted outline-none group-hover/project:bg-selection-subtle group-hover/project:text-ink focus-visible:ring-2 focus-visible:ring-ring ${onStartNew === undefined ? "pr-2" : "pr-7"}`}
				>
					<span className="relative flex size-[15px] shrink-0 items-center justify-center text-ink-muted">
						{/* Hover swaps the mark for the chevron by opacity alone; only the chevron's turn moves. */}
						<span className="flex transition-opacity duration-100 group-hover/project:opacity-0 group-focus-visible/toggle:opacity-0">
							<GroupMark group={group} expanded={expanded} />
						</span>
						<CaretRightIcon
							size={12}
							className={`absolute opacity-0 [transition:opacity_100ms_ease,transform_150ms_var(--ease-out)] group-hover/project:opacity-100 group-focus-visible/toggle:opacity-100 ${
								expanded ? "rotate-90" : ""
							}`}
							aria-hidden
						/>
					</span>
					<span className="min-w-0 truncate">{label}</span>
					{group.kind !== "project" && (
						<span className="text-2xs text-ink-muted tabular-nums">{group.entries.length}</span>
					)}
				</button>
				{onStartNew !== undefined && (
					<button
						type="button"
						aria-label={`New thread in ${label}`}
						title={`New thread in ${label}`}
						onClick={onStartNew}
						className="absolute right-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-muted opacity-0 outline-none transition-[opacity,transform] duration-150 ease-out group-hover/project:opacity-100 hover:bg-selection-strong hover:text-ink active:scale-95 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
					>
						<PlusIcon size={13} aria-hidden />
					</button>
				)}
			</div>
			{/* Rows show at once, as Linear's do: a group is toggled too often to wait on motion. A collapsed
			    group mounts only the open thread's row. */}
			{(expanded ? group.entries.length > 0 : open !== undefined) && (
				<ul aria-label={label} className="mt-px flex flex-col gap-px">
					{expanded ? group.entries.map(row) : open !== undefined && row(open)}
				</ul>
			)}
		</section>
	);
}

/** Off-screen rows skip layout and paint until scrolled near; memoized so a loader or focus change repaints one row. */
const SessionRow = memo(function SessionRow({
	session,
	projectName,
	machineName,
	state,
	onOpen,
}: {
	/** Kept across reads while it does not change, with the project's parts as plain values, so the row renders only for its own changes. */
	readonly session: SidebarSession;
	readonly projectName: string;
	readonly machineName: string;
	/** In front on the tab on screen, or shown there in another frame. */
	readonly state: "current" | "shown" | undefined;
	readonly onOpen: (sessionId: string, projectName: string, event: MouseEvent) => void;
}) {
	// The main thread's key is its session's id.
	const display = useRunDisplay([{ key: session.id, runState: session.runState }]);
	return (
		<li className="[contain-intrinsic-size:auto_26px] [content-visibility:auto]">
			<button
				type="button"
				title={`${session.path} on ${machineName}\n${isMac ? "⌘" : "Ctrl"}-click opens it in a new frame\n⇧-click opens it in a new tab`}
				aria-current={state === "current" ? "true" : undefined}
				data-state={state}
				// One weight in every state: a bolder current row would shift its title as focus moves.
				className="group/row relative flex h-[26px] w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-ui text-ink-muted outline-none hover:bg-selection-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-ring data-[state=current]:bg-selection-current data-[state=current]:text-ink data-[state=shown]:text-ink"
				onClick={(event) => onOpen(session.id, projectName, event)}
				onAuxClick={(event) => onOpen(session.id, projectName, event)}
			>
				{/* Its color washes in from the right edge, behind the time, so it shows through a run and takes no room. */}
				{session.color !== null && (
					<span
						aria-hidden
						className="pointer-events-none absolute inset-y-0 right-0 w-2/5 rounded-r-md"
						style={{
							backgroundImage: `linear-gradient(to left, color-mix(in srgb, ${session.color} 22%, transparent), transparent)`,
						}}
					/>
				)}
				<span className="flex size-[15px] shrink-0 items-center justify-center text-ink-muted group-data-[state]/row:text-ink">
					<RunMark display={display} />
				</span>
				<span className="min-w-0 flex-1 truncate">{session.title}</span>
				<span className="relative flex shrink-0 items-center justify-end pl-1 text-2xs tabular-nums text-ink-muted/75">
					<span
						className={
							session.model !== undefined
								? "transition-opacity duration-150 ease-out group-hover/row:opacity-0 group-focus-visible/row:opacity-0"
								: undefined
						}
					>
						<Ago time={session.updated} />
					</span>
					{session.model !== undefined && (
						<span
							title={session.model.id}
							className="absolute right-0 flex items-center text-ink-muted opacity-0 transition-opacity duration-150 ease-out group-hover/row:opacity-100 group-focus-visible/row:opacity-100"
						>
							<ProviderIcon
								id={session.model.provider}
								name={session.model.provider}
								className="size-3.5 shrink-0"
							/>
						</span>
					)}
				</span>
			</button>
		</li>
	);
});
