import { useAtom, useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Plus, Search, SquarePen } from "lucide-react";
import { type MouseEvent, useState } from "react";

import { Sidebar, SidebarContent, SidebarHeader, SidebarInput, SidebarRail } from "@/components/ui/sidebar";
import { isMac, openMode } from "@codeworksh/widget/view";
import { sessionAddress } from "../widgets/session/address";
import { projectsAtom } from "../widgets/session/projects";
import { focusedAtom } from "../wm/chrome";
import { deskAtom } from "../wm/instances";
import { useOpenElsewhere } from "../wm/open";
import { ago } from "../widgets/time";
import { Monogram } from "@/components/monogram";
import { Empty, EmptyAction } from "./empty";
import { ServerOffline } from "./offline";
import { placeAtom, usePickFolder } from "./place";

/**
 * Recent sessions across every project, newest first, beside every page. With none yet it invites
 * adding a project: the folder the start page's composer then works in.
 */
export function SessionsSidebar() {
	const result = useAtomValue(projectsAtom);
	const [query, setQuery] = useState("");
	const openElsewhere = useOpenElsewhere();
	const [place, setPlace] = useAtom(placeAtom);
	const pickFolder = usePickFolder();
	const navigate = useNavigate();
	// The session in front on the workspace on screen reads as current.
	const { workspaceId } = useParams({ strict: false });
	const { instances } = useAtomValue(deskAtom);
	const focusedOn = useAtomValue(focusedAtom);
	const focusedId = workspaceId === undefined ? undefined : focusedOn.get(workspaceId);
	const current = instances.find((instance) => instance.id === focusedId)?.address;
	// Picking lands on the start page, where the folder is used.
	const addProject = pickFolder === undefined ? undefined : () => void pickFolder().then(() => navigate({ to: "/" }));
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
	const open = (session: { id: string; project: { name: string } }, event: MouseEvent) => {
		if (event.button > 1) return;
		const placement = event.shiftKey ? "workspace" : openMode(event);
		void openElsewhere(sessionAddress(session.id), session.project.name, placement);
	};

	const needle = query.trim().toLowerCase();
	const sessions = AsyncResult.isSuccess(result)
		? result.value
				.flatMap((project) => project.sessions.map((session) => ({ ...session, project })))
				.filter(({ title, project }) => `${title} ${project.name}`.toLowerCase().includes(needle))
				.sort((a, b) => b.updated - a.updated)
		: [];

	return (
		<Sidebar collapsible="offcanvas" className="shell-sidebar select-none">
			<SidebarHeader className="gap-0 p-0">
				<div className="px-2 pt-2 pb-2">
					{/* The icon centers on the input alone, not on the padding below it. */}
					<div className="relative">
						<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-muted" />
						<SidebarInput
							type="search"
							placeholder="Search"
							aria-label="Search sessions"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							className="h-8 rounded-[8px] border-transparent bg-transparent pl-8 text-[13px] shadow-none focus-visible:bg-ink/5"
						/>
					</div>
					<button
						type="button"
						onClick={startNew}
						className="mt-1 flex h-8 w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-[13px] text-ink transition-colors outline-none hover:bg-ink/5 focus-visible:bg-ink/5"
					>
						<SquarePen className="size-3.5 text-ink-muted" aria-hidden />
						New
					</button>
				</div>
			</SidebarHeader>
			<SidebarContent className="px-2 pt-2 pb-2">
				{AsyncResult.isFailure(result) ? (
					// The CodeWork server is the usual reason, and the sidebar can say which state it is in and fix it.
					Option.exists(AsyncResult.error(result), (error) => error._tag === "Server.CodeworkUnavailable") ? (
						<ServerOffline />
					) : (
						<p className="px-2.5 py-2 text-[12px] text-ink-muted">Could not load sessions.</p>
					)
				) : AsyncResult.isSuccess(result) && sessions.length === 0 ? (
					needle !== "" ? (
						<p className="px-2.5 py-2 text-[12px] text-ink-muted">No sessions match “{query}”.</p>
					) : (
						<Empty>
							{place.kind === "none" && result.value.length === 0 ? (
								<>
									<span>No Projects Yet</span>
									{addProject !== undefined && (
										<EmptyAction
											icon={<Plus className="-mx-0.5 size-3" strokeWidth={2} aria-hidden />}
											onClick={addProject}
										>
											Add Project
										</EmptyAction>
									)}
								</>
							) : (
								<span>No Sessions Yet</span>
							)}
						</Empty>
					)
				) : (
					<ul className="flex flex-col gap-0.5">
						{sessions.map((session) => (
							<li key={session.id}>
								<button
									type="button"
									title={`${session.project.path}\n${isMac ? "⌘" : "Ctrl"}-click opens it in a new frame\n⇧-click opens it in a new workspace`}
									aria-current={sessionAddress(session.id) === current ? "true" : undefined}
									className="block w-full rounded-[8px] px-2.5 py-2 text-left transition-colors outline-none hover:bg-ink/5 focus-visible:bg-ink/5 aria-[current=true]:bg-ink/8"
									onClick={(event) => open(session, event)}
									onAuxClick={(event) => open(session, event)}
								>
									<div className="flex h-5 min-w-0 items-center gap-1.5 text-[12px] text-ink-muted">
										<Monogram id={session.project.id} name={session.project.name} />
										<span className="min-w-0 flex-1 truncate">{session.project.name}</span>
										<span className="shrink-0 tabular-nums">{ago(session.updated)}</span>
									</div>
									<div className="mt-1 truncate text-[13px] text-ink">{session.title}</div>
								</button>
							</li>
						))}
					</ul>
				)}
			</SidebarContent>
			<SidebarRail />
		</Sidebar>
	);
}
