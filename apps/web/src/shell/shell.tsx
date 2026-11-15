import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Outlet, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import { Desktop } from "../wm/desktop";
import { deskQueryAtom } from "../wm/instances";
import { lastTabAtom, useTabs, useTabReturn, tabRoute, tabsAtom } from "../wm/tabs";
import { settingsShortcut, tabShortcut } from "./switcher";

/**
 * Lives in the pathless `_shell` layout so switching tabs (a URL change) never remounts
 * the desktop: widget order, pins, and per-tab layout survive navigation.
 * Settings, All Threads, Projects and Metrics open over the desktop, which stays mounted underneath.
 */
export function Shell() {
	const { tabId } = useParams({ strict: false });
	const tabs = useTabs();
	const navigate = useNavigate();
	// From the location, which changes before route params do: a match-based check lags a
	// render behind, in which the first tab would pass for the one settings returns to.
	const inSettings = useLocation({ select: (location) => location.pathname.startsWith("/settings") });
	const overDesktop = useLocation({
		select: (location) =>
			location.pathname.startsWith("/settings") ||
			location.pathname === "/threads" ||
			location.pathname === "/projects" ||
			location.pathname === "/metrics",
	});
	// An id that no longer exists (a deleted tab) shows the first one.
	const shown = tabs.find((tab) => tab.id === tabId) ?? tabs[0];
	const back = useTabReturn();

	// With every tab deleted there is nothing to show here; the start page needs none. Only once
	// the list has settled: a first load, or the refetch after creating one, must not bounce the user out.
	const listed = useAtomValue(tabsAtom);
	const loaded = AsyncResult.isSuccess(listed) && !listed.waiting;
	// The desktop edits and saves the whole desk, so it waits for the saved one rather than start empty.
	const desk = useAtomValue(deskQueryAtom);
	const ready = AsyncResult.isSuccess(listed) && AsyncResult.isSuccess(desk);
	useEffect(() => {
		if (loaded && tabs.length === 0 && !overDesktop) void navigate({ to: "/", replace: true });
	}, [loaded, tabs.length, overDesktop, navigate]);

	// Remembered past this route, so the start page opens things where the user last was.
	const setLastTab = useAtomSet(lastTabAtom);
	useEffect(() => {
		if (!overDesktop && shown !== undefined) setLastTab(shown.id);
	}, [overDesktop, shown, setLastTab]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const target = tabShortcut(event, tabs);
			if (target !== undefined) {
				event.preventDefault();
				void navigate(tabRoute(target));
			} else if (settingsShortcut(event)) {
				event.preventDefault();
				void navigate({ to: "/settings/tabs" });
			} else if (inSettings && event.key === "Escape" && !event.defaultPrevented && !isEditing(event.target)) {
				// Dialogs and popovers claim Escape first by preventing its default.
				void navigate(back);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [navigate, tabs, inSettings, back]);

	return (
		<div className="flex h-full min-w-0 flex-col">
			<div className="relative min-h-0 flex-1">
				{ready &&
					shown !== undefined && (
						// Hidden, not unmounted, so widgets keep their state behind settings and All Threads.
						<div className={`h-full ${overDesktop ? "paused-animations invisible" : ""}`} inert={overDesktop}>
							<Desktop tab={shown} />
						</div>
					)}
				{overDesktop && (
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
