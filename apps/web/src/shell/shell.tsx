import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { Desktop } from "../wm/desktop";
import { Switcher, workspaceShortcut } from "./switcher";
import { defaultWorkspace, parseWorkspace } from "../wm/workspaces";

// The window has no native title bar on macOS; this bar is its drag region and
// leaves room for the inset traffic lights.
const insetTitleBar = window.desktopBridge?.platform === "darwin";

/**
 * Lives in the root route so switching workspaces (a URL change) never remounts
 * the desktop: widget order, pins, and per-workspace layout survive navigation.
 */
export function Shell() {
	const { workspaceId } = useParams({ strict: false });
	const active = parseWorkspace(workspaceId) ?? defaultWorkspace;
	const navigate = useNavigate();

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const id = workspaceShortcut(event);
			if (id === null) return;
			event.preventDefault();
			void (id === defaultWorkspace
				? navigate({ to: "/" })
				: navigate({ to: "/workspaces/$workspaceId", params: { workspaceId: String(id) } }));
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [navigate]);

	return (
		<div className="flex h-full flex-col">
			<header
				className={`flex h-11 shrink-0 items-center px-2 select-none [-webkit-app-region:drag] ${insetTitleBar ? "pl-20" : ""}`}
			>
				<Switcher active={active} />
			</header>
			<Desktop workspace={active} />
		</div>
	);
}
