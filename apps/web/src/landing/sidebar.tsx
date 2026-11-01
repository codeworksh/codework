import { useAtom, useAtomValue } from "@effect/atom-react";
import { PlusSignIcon, Search01Icon, Settings02Icon, SquarePenIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { type MouseEvent, useState } from "react";

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
import { ago } from "../widgets/time";
import { Monogram } from "@/components/monogram";
import { OpenProviderSettings } from "@/components/offline";
import { ProviderIcon } from "@/components/provider";
import { problemAtom } from "../kernel/servers";
import { Empty, EmptyAction } from "./empty";
import { placeAtom, usePickFolder } from "./place";

/**
 * Recent sessions across every project, newest first, beside every page. With none yet it invites
 * adding a project: the folder the start page's composer then works in.
 */
export function SessionsSidebar() {
	const result = useAtomValue(projectsAtom);
	const problem = useAtomValue(problemAtom);
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
						aria-label="Search sessions"
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
					New session
				</button>
			</SidebarHeader>
			<SidebarContent className="gap-0 px-2 pb-2">
				<h2 className="flex h-7 shrink-0 items-center px-2 text-ui font-medium text-ink-muted">Sessions</h2>
				{problem !== undefined ? (
					<OpenProviderSettings
						problem={problem}
						className="w-full font-normal text-ink-muted hover:bg-ink/5 hover:text-ink focus-visible:bg-ink/5"
					/>
				) : AsyncResult.isFailure(result) ? (
					<p className="px-2.5 py-2 text-xs text-ink-muted">Could not load sessions.</p>
				) : AsyncResult.isSuccess(result) && sessions.length === 0 ? (
					needle !== "" ? (
						<p className="px-2.5 py-2 text-xs text-ink-muted">No sessions match “{query}”.</p>
					) : (
						<Empty>
							{place.kind === "none" && result.value.length === 0 ? (
								<>
									<span>No projects yet</span>
									{addProject !== undefined && (
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
									)}
								</>
							) : (
								<span>No sessions yet</span>
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
									className="group relative flex w-full flex-col rounded-md px-2 py-1.5 text-left text-ink/80 outline-none hover:bg-selection-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-ring aria-current:bg-selection aria-current:text-ink"
									onClick={(event) => open(session, event)}
									onAuxClick={(event) => open(session, event)}
								>
									<span className="flex min-w-0 items-center gap-1.5">
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
												<span className="max-w-0 truncate pr-0 opacity-0 transition-[max-width,opacity,padding] duration-200 ease-out group-focus-within:max-w-32 group-focus-within:pr-1.5 group-focus-within:opacity-100 group-hover:max-w-32 group-hover:pr-1.5 group-hover:opacity-100">
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
