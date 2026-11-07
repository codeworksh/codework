import { ArrowLeft, Search } from "@/components/vuesax";
import { Link, Outlet, useMatchRoute, useNavigate } from "@tanstack/react-router";

import { useRef, useState } from "react";
import { useScrollFade } from "@/hooks/use-scroll-fade";

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
	SidebarRail,
} from "@/components/ui/sidebar";
import { search } from "./sections";
import { useWorkspaceReturn } from "../wm/workspaces";

/** Settings replaces the sessions list within the same app shell and sidebar controls. */
export function SettingsSidebar() {
	const matchRoute = useMatchRoute();
	const navigate = useNavigate();
	const back = useWorkspaceReturn();
	const [query, setQuery] = useState("");
	const matches = search(query);
	const groups = [...new Set(matches.map((section) => section.group))];
	return (
		<Sidebar collapsible="offcanvas" className="shell-sidebar select-none">
			<SidebarHeader className="gap-1 px-2 pt-2 pb-2">
				<Link
					{...back}
					className="mb-2 flex h-8 items-center gap-2 rounded-md px-2.5 text-ui text-ink-muted outline-none hover:bg-selection-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-ring"
				>
					<ArrowLeft className="size-4 shrink-0" aria-hidden />
					{back.to === "/" ? "Back to app" : "Back to workspace"}
				</Link>
				<h1 className="flex h-7 items-center px-2.5 text-ui font-medium text-ink">Settings</h1>
				<div className="relative">
					<Search
						className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-muted"
						aria-hidden
					/>
					<SidebarInput
						type="search"
						placeholder="Search"
						aria-label="Search settings"
						value={query}
						className="h-7 rounded-md border-transparent bg-transparent pl-8 text-ui shadow-none focus-visible:bg-selection-subtle"
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							const first = matches[0];
							if (event.key === "Enter" && first !== undefined) void navigate({ to: first.to });
							if (event.key === "Escape" && query !== "") {
								event.preventDefault();
								setQuery("");
							}
						}}
					/>
				</div>
			</SidebarHeader>
			<SidebarContent className="px-2 pb-2">
				<nav aria-label="Settings navigation">
					{groups.map((group) => (
						<SidebarGroup key={group} className="px-0">
							<SidebarGroupLabel className="px-2.5 text-2xs text-ink-muted">{group}</SidebarGroupLabel>
							<SidebarMenu>
								{matches
									.filter((section) => section.group === group)
									.map(({ to, label, icon: Icon }) => {
										const current = matchRoute({ to }) !== false;
										return (
											<SidebarMenuItem key={to}>
												<SidebarMenuButton
													asChild
													isActive={current}
													className="h-7 rounded-md px-2.5 text-ui text-ink-muted data-[active=true]:bg-selection data-[active=true]:text-ink"
												>
													<Link to={to} aria-current={current ? "page" : undefined}>
														<Icon className="size-4" strokeWidth={1.5} aria-hidden />
														<span>{label}</span>
													</Link>
												</SidebarMenuButton>
											</SidebarMenuItem>
										);
									})}
							</SidebarMenu>
						</SidebarGroup>
					))}
					{matches.length === 0 && (
						<p className="px-2.5 py-2 text-xs text-ink-muted">No settings match “{query}”.</p>
					)}
				</nav>
			</SidebarContent>
			<SidebarRail />
		</Sidebar>
	);
}

export function SettingsLayout() {
	const viewport = useRef<HTMLElement>(null);
	useScrollFade(viewport);
	return (
		<main ref={viewport} className="scroll-fade h-full min-h-0 min-w-0 overflow-auto">
			<div>
				<Outlet />
			</div>
		</main>
	);
}
