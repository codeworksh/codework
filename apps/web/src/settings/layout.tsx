import { Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import { Layers } from "lucide-react";
import type { CSSProperties } from "react";

import {
	Sidebar,
	SidebarContent,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
} from "@/components/ui/sidebar";

const sections = [{ to: "/settings/workspaces", label: "Workspaces", icon: Layers }] as const;

/** Settings: a section list beside the open section, both on the desktop's panels. */
export function SettingsLayout() {
	const matchRoute = useMatchRoute();
	return (
		// Wider than shadcn's 16rem default, so section names never crowd the icons.
		<SidebarProvider className="h-full min-h-0 gap-2 p-2" style={{ "--sidebar-width": "20rem" } as CSSProperties}>
			<Sidebar collapsible="none" className="panel bg-transparent">
				<SidebarHeader className="px-4 pt-4">
					<h1 className="text-base font-semibold">Settings</h1>
				</SidebarHeader>
				<SidebarContent>
					<SidebarGroup>
						<SidebarGroupLabel>App</SidebarGroupLabel>
						<SidebarMenu>
							{sections.map(({ to, label, icon: Icon }) => (
								<SidebarMenuItem key={to}>
									<SidebarMenuButton asChild isActive={matchRoute({ to }) !== false}>
										<Link to={to}>
											<Icon strokeWidth={1.75} />
											{label}
										</Link>
									</SidebarMenuButton>
								</SidebarMenuItem>
							))}
						</SidebarMenu>
					</SidebarGroup>
				</SidebarContent>
			</Sidebar>
			<main className="panel min-w-0 flex-1 overflow-auto">
				<Outlet />
			</main>
		</SidebarProvider>
	);
}
