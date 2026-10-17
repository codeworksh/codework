import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Plus, Search } from "lucide-react";
import { type MouseEvent, useState } from "react";

import { Sidebar, SidebarContent, SidebarHeader, SidebarInput, SidebarRail } from "@/components/ui/sidebar";
import { isMac, openMode } from "@codeworksh/widget/view";
import { sessionAddress } from "../widgets/session/address";
import { projectsAtom } from "../widgets/session/projects";
import { insetTitleBar } from "../shell/titlebar";
import { focusedAtom } from "../wm/chrome";
import { deskAtom } from "../wm/instances";
import { useOpenElsewhere } from "../wm/open";
import { ago } from "../widgets/time";
import { Monogram } from "@/components/monogram";
import { placeAtom, usePickFolder } from "./place";

/**
 * Recent sessions across every project, newest first, beside every page. With none yet it invites
 * adding a project: the folder the start page's composer then works in.
 */
export function SessionsSidebar() {
	const result = useAtomValue(projectsAtom);
	const [query, setQuery] = useState("");
	const openElsewhere = useOpenElsewhere();
	const place = useAtomValue(placeAtom);
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
		<Sidebar collapsible="offcanvas" className="select-none">
			<SidebarHeader className="gap-0 p-0">
				{/* The window's drag region, clear of the macOS traffic lights. */}
				<div className={`h-12 shrink-0 [-webkit-app-region:drag] ${insetTitleBar ? "pl-20" : ""}`} />
				<div className="px-2 pb-2">
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
				</div>
			</SidebarHeader>
			<SidebarContent className="px-2 pb-2">
				{AsyncResult.isFailure(result) ? (
					<p className="px-2.5 py-2 text-[12px] text-ink-muted">
						{Option.match(AsyncResult.error(result), {
							// Says how to start the CodeWork server when that is the reason.
							onSome: (error) =>
								error._tag === "Server.CodeworkUnavailable" ? error.message : "Could not load sessions.",
							onNone: () => "Could not load sessions.",
						})}
					</p>
				) : AsyncResult.isSuccess(result) && sessions.length === 0 ? (
					needle !== "" ? (
						<p className="px-2.5 py-2 text-[12px] text-ink-muted">No sessions match “{query}”.</p>
					) : (
						<div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-[12px] text-ink-muted/70">
							{place.kind === "none" && result.value.length === 0 ? (
								<>
									<span>No Projects Yet</span>
									{addProject !== undefined && (
										<button
											type="button"
											onClick={addProject}
											className="inline-flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-[11px] font-medium text-ink-muted transition-colors outline-none hover:bg-ink/5 hover:text-ink focus-visible:bg-ink/5"
										>
											<Plus className="-mx-0.5 size-3" strokeWidth={2} aria-hidden />
											Add Project
										</button>
									)}
								</>
							) : (
								<span>No Sessions Yet</span>
							)}
						</div>
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
									{session.model !== undefined && (
										<div className="mt-0.5 truncate text-[11px] text-ink-muted/60">{session.model.id}</div>
									)}
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
