import { ChevronRight, EditIcon, Folder, Plus, Search, Settings, ThreadsIcon } from "@/components/vuesax";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import type { SidebarProject, SidebarSession } from "@codeworksh/contract";
import { type MouseEvent, memo, useCallback, useLayoutEffect, useRef, useState } from "react";

import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarHeader,
	SidebarInput,
	SidebarRail,
} from "@/components/ui/sidebar";
import { isMac, openMode } from "@codeworksh/widget/view";
import { sessionAddress } from "../widgets/session/address";
import { projectsAtom } from "../widgets/session/projects";
import { focusedAtom } from "../wm/chrome";
import { deskAtom } from "../wm/instances";
import { useOpenElsewhere } from "../wm/open";
import { Ago } from "../widgets/time";
import { OpenProviderSettings } from "@/components/offline";
import { ProviderIcon } from "@/components/provider";
import { problemAtom } from "../kernel/servers";
import { Empty, EmptyAction } from "./empty";
import { useAddProject } from "../shell/palette";
import { placeAtom } from "./place";
import { useRunDisplay } from "../widgets/session/display";
import { RunMark } from "../widgets/session/run";

/**
 * Recent sessions across every project, newest first, beside every page. With none yet it invites
 * adding a project: the folder the start page's composer then works in.
 */
/** A sidebar action: New, All Threads, Settings. */
const NAV_ROW =
	"flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-ui text-ink-muted outline-none hover:bg-selection-subtle hover:text-ink active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-ring";

export function SessionsSidebar() {
	const result = useAtomValue(projectsAtom);
	const problem = useAtomValue(problemAtom);
	const [query, setQuery] = useState("");
	const openElsewhere = useOpenElsewhere();
	const [place, setPlace] = useAtom(placeAtom);
	const addProject = useAddProject();
	const navigate = useNavigate();
	// The session in front on the workspace on screen reads as current.
	const { workspaceId } = useParams({ strict: false });
	const { instances } = useAtomValue(deskAtom);
	const focusedOn = useAtomValue(focusedAtom);
	const focusedId = workspaceId === undefined ? undefined : focusedOn.get(workspaceId);
	const current = instances.find((instance) => instance.id === focusedId)?.address;
	// A new session starts on the start page, in the current session's project when one is in front.
	const startNew = () => {
		const project = AsyncResult.isSuccess(result)
			? result.value.find((candidate) => candidate.sessions.some(({ id }) => sessionAddress(id) === current))
			: undefined;
		if (project !== undefined) setPlace({ kind: "folder", path: project.path });
		void navigate({ to: "/" });
	};
	// Primary and middle clicks open; a right click is left to the context menu. Shift, like a
	// browser's new window, asks for a workspace of its own.
	// Read through a ref, so rows keep one handler and skip re-rendering when the desk changes.
	const opener = useRef(openElsewhere);
	useLayoutEffect(() => {
		opener.current = openElsewhere;
	});
	const open = useCallback((sessionId: string, projectName: string, event: MouseEvent) => {
		if (event.button > 1) return;
		const placement = event.shiftKey ? "workspace" : openMode(event);
		void opener.current(sessionAddress(sessionId), projectName, placement);
	}, []);

	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
	const toggle = useCallback((key: string) => {
		setCollapsed((previous) => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);
	const startIn = useCallback(
		(path: string) => {
			setPlace({ kind: "folder", path });
			void navigate({ to: "/" });
		},
		[navigate, setPlace],
	);

	const needle = query.trim().toLowerCase();
	const groups = AsyncResult.isSuccess(result)
		? result.value.flatMap((project) => {
				const sessions =
					needle === ""
						? project.sessions
						: project.sessions.filter((session) =>
								`${session.title} ${project.name}`.toLowerCase().includes(needle),
							);
				return sessions.length === 0 ? [] : [{ project, sessions }];
			})
		: [];

	return (
		<Sidebar collapsible="offcanvas" className="shell-sidebar select-none">
			<SidebarHeader className="gap-0.5 px-2 pt-2 pb-2">
				<button type="button" onClick={startNew} className={NAV_ROW}>
					<EditIcon size={15} className="shrink-0 text-ink-muted" aria-hidden />
					<span>New</span>
				</button>
				<div className="relative">
					<Search
						size={15}
						className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-ink-muted"
						aria-hidden
					/>
					<SidebarInput
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
						className="h-7 rounded-md border-0 bg-transparent pr-2 pl-[30px] text-ui shadow-none dark:bg-transparent placeholder:text-ink-muted hover:bg-selection-subtle focus-visible:bg-selection-subtle focus-visible:ring-2 focus-visible:ring-ring"
					/>
				</div>
				<Link
					to="/threads"
					className={`${NAV_ROW} aria-[current=page]:bg-selection-current aria-[current=page]:font-medium aria-[current=page]:text-ink`}
				>
					<ThreadsIcon size={15} className="shrink-0 text-ink-muted" aria-hidden />
					<span>All Threads</span>
				</Link>
			</SidebarHeader>
			<SidebarContent className="gap-0 px-2 pb-2">
				{problem !== undefined ? (
					<OpenProviderSettings
						problem={problem}
						className="w-full font-normal text-ink-muted hover:bg-ink/5 hover:text-ink focus-visible:bg-ink/5"
					/>
				) : AsyncResult.isFailure(result) ? (
					<p className="px-2 py-2 text-xs text-ink-muted">Could not load sessions.</p>
				) : AsyncResult.isSuccess(result) && groups.length === 0 ? (
					needle !== "" ? (
						<p className="px-2 py-2 text-xs text-ink-muted">No threads match “{query}”.</p>
					) : (
						<Empty>
							{place.kind === "none" && result.value.length === 0 ? (
								<>
									<span>No projects yet</span>
									<EmptyAction
										icon={<Plus size={12} strokeWidth={2} className="-mx-0.5 size-3" aria-hidden />}
										onClick={addProject}
									>
										Add project
									</EmptyAction>
								</>
							) : (
								<span>No threads yet</span>
							)}
						</Empty>
					)
				) : (
					<div aria-label="Threads" className="flex flex-col gap-1.5 pt-1">
						{groups.map(({ project, sessions }) => {
							const key = `${project.machine.id}/${project.id}`;
							const expanded = needle !== "" || !collapsed.has(key);
							return (
								<ProjectGroup
									key={key}
									project={project}
									sessions={sessions}
									expanded={expanded}
									current={current}
									onToggle={() => toggle(key)}
									onStartNew={() => startIn(project.path)}
									onOpen={open}
								/>
							);
						})}
					</div>
				)}
			</SidebarContent>
			<SidebarFooter className="p-2">
				<Link to="/settings/workspaces" className={NAV_ROW}>
					<Settings size={15} className="shrink-0 text-ink-muted" aria-hidden />
					<span>Settings</span>
				</Link>
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
}

function ProjectGroup({
	project,
	sessions,
	expanded,
	current,
	onToggle,
	onStartNew,
	onOpen,
}: {
	readonly project: SidebarProject;
	readonly sessions: ReadonlyArray<SidebarSession>;
	readonly expanded: boolean;
	readonly current: string | undefined;
	readonly onToggle: () => void;
	readonly onStartNew: () => void;
	readonly onOpen: (sessionId: string, projectName: string, event: MouseEvent) => void;
}) {
	return (
		<section className="flex flex-col">
			<div className="group/project relative flex h-7 items-center">
				<button
					type="button"
					aria-expanded={expanded}
					title={`${project.path} on ${project.machine.name}`}
					onClick={onToggle}
					className="group/toggle flex h-7 w-full min-w-0 items-center gap-2 rounded-md pr-7 pl-2 text-left text-ui font-medium text-ink-secondary outline-none group-hover/project:bg-selection-subtle group-hover/project:text-ink focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span className="relative flex size-[15px] shrink-0 items-center justify-center text-ink-muted">
						<Folder
							size={15}
							className="transition-[opacity,transform] duration-150 ease-out group-hover/project:scale-90 group-hover/project:opacity-0 group-focus-visible/toggle:scale-90 group-focus-visible/toggle:opacity-0"
							aria-hidden
						/>
						<ChevronRight
							size={13}
							className={`absolute scale-90 opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover/project:scale-100 group-hover/project:opacity-100 group-focus-visible/toggle:scale-100 group-focus-visible/toggle:opacity-100 ${
								expanded ? "rotate-90" : ""
							}`}
							aria-hidden
						/>
					</span>
					<span className="min-w-0 truncate">{project.name}</span>
				</button>
				<button
					type="button"
					aria-label={`New thread in ${project.name}`}
					title={`New thread in ${project.name}`}
					onClick={onStartNew}
					className="absolute right-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-muted opacity-0 outline-none transition-[opacity,transform] duration-150 ease-out group-hover/project:opacity-100 hover:bg-selection-strong hover:text-ink active:scale-95 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
				>
					<Plus size={13} aria-hidden />
				</button>
			</div>
			<div
				inert={!expanded || undefined}
				className={`grid transition-[grid-template-rows,opacity] duration-180 ease-out ${
					expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
				}`}
			>
				<div className="min-h-0 overflow-hidden">
					<ul aria-label={project.name} className="mt-0.5 flex flex-col gap-0.5">
						{sessions.map((session) => (
							<SessionRow
								key={session.id}
								session={session}
								projectName={project.name}
								machineName={project.machine.name}
								current={sessionAddress(session.id) === current}
								onOpen={onOpen}
							/>
						))}
					</ul>
				</div>
			</div>
		</section>
	);
}

/** Off-screen rows skip layout and paint until scrolled near; memoized so a loader or focus change repaints one row. */
const SessionRow = memo(function SessionRow({
	session,
	projectName,
	machineName,
	current,
	onOpen,
}: {
	/** Kept across reads while it does not change, with the project's parts as plain values, so the row renders only for its own changes. */
	readonly session: SidebarSession;
	readonly projectName: string;
	readonly machineName: string;
	readonly current: boolean;
	readonly onOpen: (sessionId: string, projectName: string, event: MouseEvent) => void;
}) {
	// The main thread's key is its session's id.
	const display = useRunDisplay([{ key: session.id, runState: session.runState }]);
	return (
		<li className="[contain-intrinsic-size:auto_28px] [content-visibility:auto]">
			<button
				type="button"
				title={`${session.path} on ${machineName}\n${isMac ? "⌘" : "Ctrl"}-click opens it in a new frame\n⇧-click opens it in a new workspace`}
				aria-current={current ? "true" : undefined}
				className="group/row relative flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-ui text-ink-muted outline-none hover:bg-selection-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-ring aria-current:bg-selection-current aria-current:font-medium aria-current:text-ink"
				onClick={(event) => onOpen(session.id, projectName, event)}
				onAuxClick={(event) => onOpen(session.id, projectName, event)}
			>
				<span className="flex size-[15px] shrink-0 items-center justify-center text-ink-muted group-aria-current/row:text-ink">
					<RunMark
						display={display}
						idle={
							<span
								aria-hidden
								className="size-[5px] rounded-full bg-current opacity-40 transition-opacity duration-150 ease-out group-hover/row:opacity-75 group-aria-current/row:opacity-90"
							/>
						}
					/>
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
