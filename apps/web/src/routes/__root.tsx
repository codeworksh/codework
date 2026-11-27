import { createRootRoute, Outlet, useLocation, useMatches } from "@tanstack/react-router";
import type { CSSProperties } from "react";

import { SidebarProvider } from "@/components/ui/sidebar";
import { useScrollbars } from "@/hooks/use-scrollbars";
import { SessionsSidebar } from "../landing/sidebar";
import { SettingsSidebar } from "../settings/layout";
import { isSettingsPath } from "../settings/sections";
import { NavigationControls } from "../shell/titlebar";
import { AppError } from "../shell/fault";
import { Palette } from "../shell/palette";
import { Toasts } from "../shell/toasts";
import { SetupGate } from "../setup";
import { Splash } from "../splash";

// The sessions sidebar wraps every page but settings, which has its own, and full-window pages such as
// creating a workspace; its open state carries over.
function Root() {
	useScrollbars();
	const inSettings = useLocation({ select: (location) => isSettingsPath(location.pathname) });
	// From the rendered matches, not the location: the location moves first, and the outgoing page,
	// still shown while the next one loads, needs the sidebar around it.
	const fullWindow = useMatches({
		select: (matches) => matches.some((match) => match.staticData.fullWindow === true),
	});
	if (fullWindow) {
		return (
			<>
				<Outlet />
				<Toasts />
				<Splash />
			</>
		);
	}
	return (
		<SidebarProvider
			className="app-shell h-full min-h-0 flex-col bg-desktop"
			style={{ "--sidebar-width": "16.25rem" } as CSSProperties}
			widthStorageKey="codework.sidebar.width"
		>
			<NavigationControls />
			<div className="flex min-h-0 flex-1">
				{inSettings ? <SettingsSidebar /> : <SessionsSidebar />}
				<div className="mr-2 mb-2 ml-2 flex min-h-0 flex-1 overflow-hidden rounded-xl border-[0.5px] border-edge bg-frame shadow-(--cw-panel-shadow) md:ml-0">
					<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
						<Outlet />
					</div>
				</div>
			</div>
			<Palette />
			<SetupGate />
			<Toasts />
			<Splash />
		</SidebarProvider>
	);
}

// The root has nothing above it to fall back to, so its errors take the whole window.
export const Route = createRootRoute({ component: Root, errorComponent: AppError });
