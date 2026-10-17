import { useAtomValue } from "@effect/atom-react";
import { Link, Outlet, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { Search, X } from "lucide-react";
import { type CSSProperties, useState } from "react";

import {
	Sidebar,
	SidebarContent,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInput,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
} from "@/components/ui/sidebar";
import { chromeButton, insetTitleBar } from "../shell/titlebar";
import { lastWorkspaceAtom, useWorkspaces, workspaceRoute } from "../wm/workspaces";
import { search } from "./sections";

/**
 * Settings fills the window: a flat section list on the window chrome beside one pane for the
 * open section, under its own bar with the way out (also Esc).
 */
export function SettingsLayout() {
	const matchRoute = useMatchRoute();
	const navigate = useNavigate();
	const [query, setQuery] = useState("");
	const matches = search(query);
	const groups = [...new Set(matches.map((section) => section.group))];
	// Closing returns to the workspace that was on screen, like Esc does.
	const lastId = useAtomValue(lastWorkspaceAtom);
	const back = useWorkspaces().find((workspace) => workspace.id === lastId);

	return (
		// Wider than shadcn's 16rem default, so section names never crowd the icons;
		// below md the sidebar folds to an icon rail so the section keeps the room.
		<SidebarProvider
			className="h-full min-h-0 flex-col gap-0 p-2 pt-0"
			style={{ "--sidebar-width": "20rem" } as CSSProperties}
		>
			<header
				className={`flex h-12 shrink-0 items-center justify-end select-none [-webkit-app-region:drag] ${insetTitleBar ? "pl-18" : ""}`}
			>
				<button
					type="button"
					aria-label="Close settings"
					title="Close settings (Esc)"
					className={chromeButton}
					onClick={() => void navigate(back === undefined ? { to: "/" } : workspaceRoute(back))}
				>
					<X className="size-4" strokeWidth={1.75} aria-hidden />
				</button>
			</header>
			<div className="flex min-h-0 flex-1 gap-2">
				<Sidebar collapsible="none" className="bg-transparent max-md:w-14">
					<SidebarHeader className="gap-3 px-2 pt-3 max-md:hidden">
						<h1 className="px-2 text-lg font-semibold">Settings</h1>
						<div className="relative">
							<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" />
							<SidebarInput
								type="search"
								placeholder="Search"
								aria-label="Search settings"
								value={query}
								className="h-9 rounded-full border-transparent bg-ink/6 pl-9"
								onChange={(event) => setQuery(event.target.value)}
								onKeyDown={(event) => {
									const first = matches[0];
									if (event.key === "Enter" && first !== undefined) void navigate({ to: first.to });
									if (event.key === "Escape" && query !== "") {
										// Clears the query instead of leaving settings.
										event.preventDefault();
										setQuery("");
									}
								}}
							/>
						</div>
					</SidebarHeader>
					<SidebarContent>
						{groups.map((group) => (
							<SidebarGroup key={group}>
								<SidebarGroupLabel className="text-ink-muted max-md:sr-only">{group}</SidebarGroupLabel>
								<SidebarMenu>
									{matches
										.filter((section) => section.group === group)
										.map(({ to, label, icon: Icon }) => (
											<SidebarMenuItem key={to}>
												<SidebarMenuButton
													asChild
													size="lg"
													isActive={matchRoute({ to }) !== false}
													className="h-9 text-[14px] max-md:justify-center"
												>
													<Link to={to} title={label}>
														<Icon strokeWidth={1.75} />
														<span className="max-md:sr-only">{label}</span>
													</Link>
												</SidebarMenuButton>
											</SidebarMenuItem>
										))}
								</SidebarMenu>
							</SidebarGroup>
						))}
						{matches.length === 0 && <p className="px-4 py-2 text-ink-muted">No settings match “{query}”.</p>}
					</SidebarContent>
				</Sidebar>
				<main className="panel min-w-0 flex-1 overflow-auto">
					<Outlet />
				</main>
			</div>
		</SidebarProvider>
	);
}
