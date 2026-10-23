import { useAtomMount } from "@effect/atom-react";
import { createRootRoute, Outlet, useLocation } from "@tanstack/react-router";
import type { CSSProperties } from "react";

import { SidebarProvider } from "@/components/ui/sidebar";
import { SessionsSidebar } from "../landing/sidebar";
import { serversAtom } from "../settings/servers/local";
import { Navigation } from "../shell/navigation";
import { NavigationControls } from "../shell/titlebar";
import { Palette } from "../shell/palette";

// The sessions sidebar wraps every page but settings, which has its own; its open state carries over.
function Root() {
	const inSettings = useLocation({ select: (location) => location.pathname.startsWith("/settings") });
	// Checking the servers spawns a login shell and the CLI, so it runs from launch and stays held:
	// Settings › Servers and the offline sidebar open on the last status instead of loading.
	useAtomMount(serversAtom);
	return (
		<SidebarProvider
			className="app-shell h-full min-h-0 flex-col bg-desktop"
			style={{ "--sidebar-width": "15rem" } as CSSProperties}
			widthStorageKey="codework.sidebar.width"
		>
			<NavigationControls />
			<div className="flex min-h-0 flex-1 pl-[52px]">
				<Navigation />
				{!inSettings && <SessionsSidebar />}
				<div className="mb-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-edge bg-frame">
					<Outlet />
				</div>
			</div>
			<Palette />
		</SidebarProvider>
	);
}

export const Route = createRootRoute({ component: Root });
