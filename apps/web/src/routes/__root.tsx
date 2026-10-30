import { createRootRoute, Outlet, useLocation } from "@tanstack/react-router";
import type { CSSProperties } from "react";

import { SidebarProvider } from "@/components/ui/sidebar";
import { SessionsSidebar } from "../landing/sidebar";
import { SettingsSidebar } from "../settings/layout";
import { Navigation } from "../shell/navigation";
import { NavigationControls } from "../shell/titlebar";
import { Palette } from "../shell/palette";
import { Splash } from "../splash";

// The sessions sidebar wraps every page but settings, which has its own; its open state carries over.
function Root() {
	const inSettings = useLocation({ select: (location) => location.pathname.startsWith("/settings") });
	return (
		<SidebarProvider
			className="app-shell h-full min-h-0 flex-col bg-desktop"
			style={{ "--sidebar-width": "15rem" } as CSSProperties}
			widthStorageKey="codework.sidebar.width"
		>
			<NavigationControls />
			<div className="mb-2 mr-2 ml-[52px] flex min-h-0 flex-1 overflow-hidden rounded-xl bg-frame">
				<Navigation />
				{inSettings ? <SettingsSidebar /> : <SessionsSidebar />}
				<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
					<Outlet />
				</div>
			</div>
			<Palette />
			<Splash />
		</SidebarProvider>
	);
}

export const Route = createRootRoute({ component: Root });
