import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Outlet, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { Desktop } from "../wm/desktop";
import { deskQueryAtom } from "../wm/instances";
import { lastWorkspaceAtom, useWorkspaces, workspaceRoute, workspacesAtom } from "../wm/workspaces";
import { settingsShortcut, workspaceShortcut } from "./switcher";
import { TitleBar } from "./titlebar";

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

	// With every workspace deleted there is nothing to show here; the start page needs none. Only once
	// the list has settled: a first load, or the refetch after creating one, must not bounce the user out.
	const listed = useAtomValue(workspacesAtom);
	const loaded = AsyncResult.isSuccess(listed) && !listed.waiting;
	// The desktop edits and saves the whole desk, so it waits for the saved one rather than start empty.
	const desk = useAtomValue(deskQueryAtom);
	const ready = AsyncResult.isSuccess(listed) && AsyncResult.isSuccess(desk);
	useEffect(() => {
		if (loaded && workspaces.length === 0 && !inSettings) void navigate({ to: "/", replace: true });
	}, [loaded, workspaces.length, inSettings, navigate]);

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
		<div className="flex h-full min-w-0 flex-col">
			{/* Settings takes the whole window, with its own bar. */}
			{!inSettings && <TitleBar active={shown} />}
			<div className="relative min-h-0 flex-1">
				{ready &&
					shown !== undefined && (
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

const isEditing = (target: EventTarget | null) =>
	target instanceof HTMLElement &&
	(target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
