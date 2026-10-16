import { useAtomSet } from "@effect/atom-react";
import { Link, Outlet, useCanGoBack, useLocation, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { ChevronLeft, House, Plus, Settings } from "lucide-react";
import { useEffect, useState } from "react";

import { Desktop } from "../wm/desktop";
import {
	createWorkspace,
	lastWorkspaceAtom,
	MAX_WORKSPACES,
	useWorkspaces,
	workspaceRoute,
	workspacesKey,
} from "../wm/workspaces";
import { settingsShortcut, Switcher, workspaceShortcut } from "./switcher";

// The window has no native title bar on macOS; this bar is its drag region and
// leaves room for the inset traffic lights.
const insetTitleBar = window.desktopBridge?.platform === "darwin";

/**
 * Lives in the pathless `_shell` layout so switching workspaces (a URL change) never remounts
 * the desktop: widget order, pins, and per-workspace layout survive navigation.
 * Settings opens over the desktop, which stays mounted underneath.
 */
export function Shell() {
	const { workspaceId } = useParams({ strict: false });
	const workspaces = useWorkspaces();
	const navigate = useNavigate();
	// From the location, which changes before route params do: a match-based check lags a
	// render behind, in which the first workspace would pass for the one settings returns to.
	const inSettings = useLocation({ select: (location) => location.pathname.startsWith("/settings") });
	// An id that no longer exists (a deleted workspace) shows the first one.
	const shown = workspaces.find((workspace) => workspace.id === workspaceId) ?? workspaces[0];
	// The workspace settings returns to; the one on screen when it opened.
	const [lastId, setLastId] = useState<string>();
	if (!inSettings && shown !== undefined && shown.id !== lastId) setLastId(shown.id);
	const back = workspaces.find((workspace) => workspace.id === lastId) ?? workspaces[0];

	const router = useRouter();
	const canGoBack = useCanGoBack();
	const create = useAtomSet(createWorkspace, { mode: "promise" });
	const addWorkspace = async () => {
		const workspace = await create({
			payload: { name: `Workspace ${workspaces.length + 1}`, icon: "app-window" },
			reactivityKeys: workspacesKey,
		});
		void navigate(workspaceRoute(workspace));
	};

	// Remembered past this route, so the start page opens things where the user last was.
	const setLastWorkspace = useAtomSet(lastWorkspaceAtom);
	useEffect(() => {
		if (!inSettings && shown !== undefined) setLastWorkspace(shown.id);
	}, [inSettings, shown, setLastWorkspace]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const target = workspaceShortcut(event, workspaces);
			if (target !== undefined) {
				event.preventDefault();
				void navigate(workspaceRoute(target));
			} else if (settingsShortcut(event)) {
				event.preventDefault();
				void navigate({ to: "/settings/workspaces" });
			} else if (inSettings && event.key === "Escape" && !event.defaultPrevented && !isEditing(event.target)) {
				// Dialogs and popovers claim Escape first by preventing its default.
				void navigate(back === undefined ? { to: "/" } : workspaceRoute(back));
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [navigate, workspaces, inSettings, back]);

	return (
		<div className="flex h-full flex-col">
			<header
				className={`flex h-11 shrink-0 items-center gap-1.5 px-2 select-none [-webkit-app-region:drag] ${insetTitleBar ? "pl-20" : ""}`}
			>
				<button
					type="button"
					aria-label="Back"
					title="Back"
					disabled={!canGoBack}
					onClick={() => router.history.back()}
					className={chromeButton}
				>
					<ChevronLeft className="size-4" strokeWidth={1.75} aria-hidden />
				</button>
				<Link to="/" aria-label="Home" title="Home: the start page" className={chromeButton}>
					<House className="size-4" strokeWidth={1.75} aria-hidden />
				</Link>
				<Switcher workspaces={workspaces} active={inSettings ? undefined : shown} />
				<button
					type="button"
					aria-label="New workspace"
					title={
						workspaces.length >= MAX_WORKSPACES ? `All ${MAX_WORKSPACES} workspaces are in use` : "New workspace"
					}
					disabled={workspaces.length >= MAX_WORKSPACES}
					onClick={() => void addWorkspace()}
					className={`${chromeButton} ml-auto`}
				>
					<Plus className="size-4" strokeWidth={1.75} aria-hidden />
				</button>
				<Link
					to="/settings/workspaces"
					aria-label="Settings"
					title="Settings"
					aria-current={inSettings ? "page" : undefined}
					className={`${chromeButton} aria-[current=page]:bg-ink/8 aria-[current=page]:text-ink`}
				>
					<Settings className="size-4" strokeWidth={1.75} aria-hidden />
				</Link>
			</header>
			<div className="relative min-h-0 flex-1">
				{shown !== undefined && (
					// Hidden, not unmounted, so widgets keep their state behind settings.
					<div className={`h-full ${inSettings ? "invisible" : ""}`} inert={inSettings}>
						<Desktop workspace={shown} />
					</div>
				)}
				{inSettings && (
					<div className="absolute inset-0">
						<Outlet />
					</div>
				)}
			</div>
		</div>
	);
}

/** A square title-bar button; it opts out of the window's drag region so it can be clicked. */
const chromeButton =
	"grid size-7 shrink-0 place-items-center rounded-[10px] text-ink-muted transition-colors [-webkit-app-region:no-drag] hover:bg-ink/5 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent";

const isEditing = (target: EventTarget | null) =>
	target instanceof HTMLElement &&
	(target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
