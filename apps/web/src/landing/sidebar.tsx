import { useAtom, useAtomValue } from "@effect/atom-react";
import { PlusSignIcon, Search01Icon, Settings02Icon, SquarePenIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import type { Project } from "@codeworksh/contract";
import { type MouseEvent, memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

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
import { projectsAtom, runningAtom } from "../widgets/session/projects";
import { focusedAtom } from "../wm/chrome";
import { deskAtom } from "../wm/instances";
import { useOpenElsewhere } from "../wm/open";
import { ago } from "../widgets/time";
import { Monogram } from "@/components/monogram";
import { OpenProviderSettings } from "@/components/offline";
import { ProviderIcon } from "@/components/provider";
import { problemAtom } from "../kernel/servers";
import { Empty, EmptyAction } from "./empty";
import { useAddProject } from "../shell/palette";
import { placeAtom } from "./place";
import { PixelLoader } from "@/components/loader";

/**
 * Recent sessions across every project, newest first, beside every page. With none yet it invites
 * adding a project: the folder the start page's composer then works in.
 */
export function SessionsSidebar() {
	const result = useAtomValue(projectsAtom);
	const problem = useAtomValue(problemAtom);
	const running = useAtomValue(runningAtom);
	const working = useMemo(() => new Set(running.values()), [running]);
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
	const open = useCallback((session: Listed, event: MouseEvent) => {
		if (event.button > 1) return;
		const placement = event.shiftKey ? "workspace" : openMode(event);
		void opener.current(sessionAddress(session.id), session.project.name, placement);
	}, []);

	const needle = query.trim().toLowerCase();
	const sessions = useMemo(
		() =>
			AsyncResult.isSuccess(result)
				? result.value
						.flatMap((project) => project.sessions.map((session) => ({ ...session, project })))
						.filter(({ title, project }) => `${title} ${project.name}`.toLowerCase().includes(needle))
						.sort((a, b) => b.updated - a.updated)
				: [],
		[result, needle],
	);

	return (
		<Sidebar collapsible="offcanvas" className="shell-sidebar select-none">
			<SidebarHeader className="gap-1 px-2 pt-2 pb-2">
				<div className="relative">
					<HugeiconsIcon
						icon={Search01Icon}
						size={16}
						className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-ink-muted opacity-70"
						aria-hidden
					/>
					<SidebarInput
						type="search"
						placeholder="Search"
						aria-label="Search threads"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						className="h-8 rounded-md border-edge bg-transparent pr-2 pl-8 text-ui shadow-sm placeholder:text-ink-muted focus-visible:border-edge-focus focus-visible:bg-selection-subtle focus-visible:ring-0"
					/>
				</div>
				<button
					type="button"
					onClick={startNew}
					className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui font-medium text-ink-muted outline-none hover:bg-selection-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-ring press"
				>
					<HugeiconsIcon icon={SquarePenIcon} size={16} className="shrink-0 opacity-70" aria-hidden />
					New
				</button>
			</SidebarHeader>
			<SidebarContent className="gap-0 px-2 pb-2">
				{problem !== undefined ? (
					<OpenProviderSettings
						problem={problem}
						className="w-full font-normal text-ink-muted hover:bg-ink/5 hover:text-ink focus-visible:bg-ink/5"
					/>
				) : AsyncResult.isFailure(result) ? (
					<p className="px-2.5 py-2 text-xs text-ink-muted">Could not load sessions.</p>
				) : AsyncResult.isSuccess(result) && sessions.length === 0 ? (
					needle !== "" ? (
						<p className="px-2.5 py-2 text-xs text-ink-muted">No threads match “{query}”.</p>
					) : (
						<Empty>
							{place.kind === "none" && result.value.length === 0 ? (
								<>
									<span>No projects yet</span>
									<EmptyAction
										icon={
											<HugeiconsIcon
												icon={PlusSignIcon}
												size={12}
												strokeWidth={2}
												className="-mx-0.5 size-3"
												aria-hidden
											/>
										}
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
					<ul aria-label="Threads" className="flex flex-col gap-0.5">
						{sessions.map((session) => (
							<SessionRow
								key={session.id}
								session={session}
								current={sessionAddress(session.id) === current}
								working={working.has(session.id)}
								onOpen={open}
							/>
						))}
					</ul>
				)}
			</SidebarContent>
			<SidebarFooter className="p-2">
				<Link
					to="/settings/workspaces"
					className="flex h-8 items-center gap-2 rounded-md px-2 text-ui font-medium text-ink-muted outline-none hover:bg-selection-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-ring press"
				>
					<HugeiconsIcon icon={Settings02Icon} size={16} className="shrink-0 opacity-70" aria-hidden />
					Settings
				</Link>
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
}

type Listed = Project["sessions"][number] & { readonly project: Project };

/** Off-screen rows skip layout and paint until scrolled near; memoized so a loader or focus change repaints one row. */
const SessionRow = memo(function SessionRow({
	session,
	current,
	working,
	onOpen,
}: {
	readonly session: Listed;
	readonly current: boolean;
	readonly working: boolean;
	readonly onOpen: (session: Listed, event: MouseEvent) => void;
}) {
	return (
		<li className="[contain-intrinsic-size:auto_50px] [content-visibility:auto]">
			<button
				type="button"
				title={`${session.project.path}\n${isMac ? "⌘" : "Ctrl"}-click opens it in a new frame\n⇧-click opens it in a new workspace`}
				aria-current={current ? "true" : undefined}
				className="group/row relative flex w-full flex-col rounded-md px-2 py-1.5 text-left text-ink/80 outline-none hover:bg-selection-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-ring aria-current:bg-selection-current aria-current:text-ink"
				onClick={(event) => onOpen(session, event)}
				onAuxClick={(event) => onOpen(session, event)}
			>
				<span className="flex min-w-0 items-center gap-1.5">
					{working && (
						<span role="img" aria-label="Agent working" className="flex shrink-0 text-ink-muted">
							<PixelLoader />
						</span>
					)}
					<span className="min-w-0 flex-1 truncate text-body font-semibold leading-snug text-ink">
						{session.title}
					</span>
					<span className="ml-auto shrink-0 pl-2 text-2xs tabular-nums text-ink-muted">
						{ago(session.updated)}
					</span>
				</span>
				<span className="mt-1 flex min-w-0 items-center gap-2 text-2xs text-ink-muted">
					<span className="flex min-w-0 flex-1 items-center gap-1.5">
						<Monogram id={session.project.id} name={session.project.name} />
						<span className="min-w-0 truncate">{session.project.name}</span>
					</span>
					{session.model !== undefined && (
						<span className="flex shrink-0 items-center text-2xs text-ink-muted">
							<span className="max-w-32 truncate pr-1.5 opacity-0 transition-opacity duration-150 ease-out group-hover/row:opacity-100 group-focus-visible/row:opacity-100">
								{session.model.id}
							</span>
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
